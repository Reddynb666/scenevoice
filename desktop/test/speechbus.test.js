// The pure part of the SpeechBus: queueing, what may interrupt what, which
// channel, the rule for the screen reader's own speech (stop at once, do not
// repeat, wait 1.5 s) and what happens when the app voice cannot speak. At the
// end, the bus itself with a stand-in voice and stand-in elements.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BusCore,
  DUCK_VOLUME,
  HOLD_MS,
  SETTLE_MS,
  STALE_MS,
  SpeechBus,
  blockReason,
  clampRate,
  estimateSpeechMs,
  mayInterrupt,
  nextIndex,
  pickVoice,
  sinkFor,
  voiceState,
  volumeAt,
} from '../renderer/speechbus.js';

const types = (effects) => effects.map((e) => e.type);
const of = (effects, type) => effects.filter((e) => e.type === type);
const description = (text, extra = {}) => ({ kind: 'description', text, log: true, remember: true, ...extra });
const status = (text, extra = {}) => ({ kind: 'status', text, ...extra });
const answer = (text, extra = {}) => ({ kind: 'answer', text, ...extra });

describe('sinkFor', () => {
  it('sends descriptions and answers to the app voice or to the screen reader, by channel', () => {
    expect(sinkFor('description', 'app')).toBe('voice');
    expect(sinkFor('answer', 'app')).toBe('voice');
    expect(sinkFor('description', 'reader')).toBe('reader');
    expect(sinkFor('answer', 'reader')).toBe('reader');
  });

  it('always sends status messages to the status region', () => {
    expect(sinkFor('status', 'app')).toBe('status');
    expect(sinkFor('status', 'reader')).toBe('status');
  });
});

describe('mayInterrupt and nextIndex', () => {
  it('lets only what the user asked for cut in', () => {
    expect(mayInterrupt({ kind: 'answer' })).toBe(true);
    expect(mayInterrupt({ kind: 'status', urgent: true })).toBe(true);
    expect(mayInterrupt({ kind: 'description' })).toBe(false);
    expect(mayInterrupt({ kind: 'status' })).toBe(false);
  });

  it('orders the queue: asked for, then descriptions, then status', () => {
    expect(nextIndex([{ kind: 'status' }, { kind: 'description' }, { kind: 'answer' }])).toBe(2);
    expect(nextIndex([{ kind: 'status' }, { kind: 'description' }])).toBe(1);
    expect(nextIndex([{ kind: 'status' }, { kind: 'status' }])).toBe(0);
  });
});

describe('BusCore, app channel', () => {
  it('speaks a description at once: live regions off, film down, voice on, and logs it', () => {
    const core = new BusCore();
    const effects = core.say(description('Celia waves.', { time: 4.3 }), 0);
    expect(types(effects)).toEqual(['current', 'log', 'live', 'duck', 'speak']);
    expect(of(effects, 'live')[0]).toMatchObject({ status: 'off', reader: 'off' });
    expect(of(effects, 'duck')[0].on).toBe(true);
    expect(of(effects, 'speak')[0].item).toMatchObject({ text: 'Celia waves.', kind: 'description', time: 4.3 });
  });

  it('queues a status behind a description and writes it only after the voice has finished', () => {
    const core = new BusCore();
    const first = core.say(description('Celia waves.'), 0);
    const id = of(first, 'speak')[0].item.id;
    const whileSpeaking = core.say(status('Paused.'), 500);
    expect(whileSpeaking).toEqual([]);

    const afterVoice = core.finished(id, 3000);
    expect(types(afterVoice)).toEqual(['duck', 'live']);
    expect(of(afterVoice, 'duck')[0].on).toBe(false);
    expect(of(afterVoice, 'live')[0].status).toBe('polite');
    // A short pause between the voice and the live region.
    expect(core.wakeAt()).toBe(3000 + SETTLE_MS);

    const written = core.tick(3000 + SETTLE_MS);
    expect(types(written)).toEqual(['write']);
    expect(written[0]).toMatchObject({ region: 'status', item: { text: 'Paused.' } });
  });

  it('never lets a status cut off a description, however many arrive', () => {
    const core = new BusCore();
    core.say(description('A long description.'), 0);
    for (let i = 0; i < 4; i += 1) {
      expect(of(core.say(status(`Status ${i}`), 100 * i), 'cancel')).toEqual([]);
    }
    expect(core.current.item.kind).toBe('description');
  });

  it('does not let a later description cut off the one being spoken: it waits its turn', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    const second = core.say(description('Two.'), 1000);
    expect(types(second)).toEqual(['current', 'log']);
    const next = core.finished(of(first, 'speak')[0].item.id, 2000);
    expect(of(next, 'speak')).toEqual([]);
    const later = core.tick(2000 + SETTLE_MS);
    expect(of(later, 'speak')[0].item.text).toBe('Two.');
  });

  it('speaks a waiting description before a waiting status', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    core.say(status('Status.'), 100);
    core.say(description('Two.'), 200);
    core.finished(of(first, 'speak')[0].item.id, 1000);
    expect(of(core.tick(1000 + SETTLE_MS), 'speak')[0].item.text).toBe('Two.');
  });

  it('skips a description that waited too long, and says so for the log', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    core.say(description('Stale.'), 100);
    const effects = core.finished(of(first, 'speak')[0].item.id, 100 + STALE_MS + 1);
    expect(of(effects, 'note')[0]).toMatchObject({ what: 'skipped', item: { text: 'Stale.' } });
    expect(of(effects, 'speak')).toEqual([]);
    expect(core.queue).toEqual([]);
  });

  it('stops at once when the user makes the screen reader talk, and does not repeat', () => {
    const core = new BusCore();
    core.say(description('Celia waves.'), 0);
    const effects = core.userActed('focus', 800);
    expect(types(effects)).toEqual(['cancel', 'duck', 'live', 'note']);
    expect(of(effects, 'note')[0]).toMatchObject({ what: 'cut', cause: 'focus' });
    expect(core.current).toBeNull();
    expect(core.queue).toEqual([]);
    // Nothing comes back by itself.
    expect(core.tick(800 + HOLD_MS + 10)).toEqual([]);
    expect(core.wakeAt()).toBeNull();
  });

  it('keeps the cut description for R, which says it again as an answer', () => {
    const core = new BusCore();
    core.say(description('Celia waves.'), 0);
    core.userActed('tab', 500);
    expect(core.last.text).toBe('Celia waves.');
    const again = core.say(answer(core.last.text), 500 + HOLD_MS);
    expect(of(again, 'speak')[0].item.text).toBe('Celia waves.');
    // Saying it again does not log it a second time.
    expect(of(again, 'log')).toEqual([]);
  });

  it('holds what it has to say next for 1.5 s after the user acted', () => {
    const core = new BusCore();
    core.userActed('dialog', 1000);
    expect(core.say(status('Dialog closed.'), 1100)).toEqual([]);
    expect(core.say(description('Thom steps back.'), 1200).some((e) => e.type === 'speak')).toBe(false);
    expect(core.wakeAt()).toBe(1000 + HOLD_MS);
    expect(core.tick(1000 + HOLD_MS - 1)).toEqual([]);
    const after = core.tick(1000 + HOLD_MS);
    expect(of(after, 'speak')[0].item.text).toBe('Thom steps back.');
  });

  it('restarts the hold each time the user acts again', () => {
    const core = new BusCore();
    core.userActed('tab', 0);
    core.say(status('Status.'), 10);
    core.userActed('tab', 1000);
    expect(core.tick(HOLD_MS)).toEqual([]);
    expect(types(core.tick(1000 + HOLD_MS))).toEqual(['write']);
  });

  it('lets an answer the user asked for cut off a description at once', () => {
    const core = new BusCore();
    core.say(description('A long description.'), 0);
    const effects = core.say(answer('On screen: Celia.'), 400);
    expect(types(effects)).toEqual(['current', 'cancel', 'duck', 'live', 'note']);
    const next = core.tick(400 + SETTLE_MS);
    expect(of(next, 'speak')[0].item.text).toBe('On screen: Celia.');
  });

  it('keeps only the newest answer when several are asked for quickly', () => {
    const core = new BusCore();
    core.userActed('focus', 0);
    core.say(answer('First answer.'), 10);
    core.say(answer('Second answer.'), 20);
    expect(core.queue.map((q) => q.text)).toEqual(['Second answer.']);
  });

  it('lets the key list cut off the voice and go to the status region', () => {
    const core = new BusCore();
    core.say(description('A long description.'), 0);
    const effects = core.say(status('Key list.', { urgent: true }), 300);
    expect(types(effects)).toEqual(['cancel', 'duck', 'live', 'note']);
    const next = core.tick(300 + SETTLE_MS);
    expect(next[0]).toMatchObject({ type: 'write', region: 'status' });
  });

  it('does not let a description talk over a status the screen reader is reading', () => {
    const core = new BusCore();
    const wrote = core.say(status('Paused.'), 0);
    expect(types(wrote)).toEqual(['write']);
    const until = core.wakeAt();
    expect(until).toBeGreaterThan(0);
    expect(of(core.say(description('Celia waves.'), 100), 'speak')).toEqual([]);
    expect(of(core.tick(until), 'speak')[0].item.text).toBe('Celia waves.');
  });

  it('drops waiting descriptions on S and stops the voice, but keeps status messages', () => {
    const core = new BusCore();
    core.say(description('One.'), 0);
    core.say(description('Two.'), 10);
    core.say(status('Status.'), 20);
    const effects = core.stop(500);
    expect(types(effects)).toEqual(['cancel', 'duck', 'live', 'note']);
    expect(core.queue.map((q) => q.kind)).toEqual(['status']);
    expect(core.last.text).toBe('Two.');
  });

  it('stops a voice that never reports back, and counts that as a failure', () => {
    const core = new BusCore();
    core.say(description('Silent failure.'), 0);
    const deadline = core.wakeAt();
    expect(deadline).toBeGreaterThan(5000);
    const effects = core.tick(deadline);
    expect(types(effects).slice(0, 2)).toEqual(['cancel', 'note']);
    expect(of(effects, 'note')[0]).toMatchObject({ what: 'failed', cause: 'timeout', item: { text: 'Silent failure.' } });
    expect(core.current).toBeNull();
    expect(core.channel).toBe('reader');
    // By now it is too old to be worth reading: it stays in the log, and R repeats it.
    expect(of(effects, 'note')[1]).toMatchObject({ what: 'skipped', cause: 'stale' });
    expect(of(effects, 'write')).toEqual([]);
    expect(core.queue).toEqual([]);
    expect(core.last.text).toBe('Silent failure.');
  });

  it('ignores a finished report for something it is no longer saying', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    core.userActed('focus', 100);
    expect(core.finished(of(first, 'speak')[0].item.id, 200)).toEqual([]);
  });

  it('replaces a waiting status by a newer one with the same tag, and leaves the others', () => {
    const core = new BusCore();
    core.userActed('focus', 0);
    core.say(status('At 10 seconds.', { tag: 'position' }), 10);
    core.say(status('Speed 1.5.', { tag: 'rate' }), 20);
    core.say(status('At 20 seconds.', { tag: 'position' }), 30);
    core.say(status('Dialog closed.'), 40);
    core.say(status('At 30 seconds.', { tag: 'position' }), 50);
    expect(core.queue.map((q) => q.text)).toEqual(['Speed 1.5.', 'Dialog closed.', 'At 30 seconds.']);
    // A tag means nothing on a description: both are kept.
    core.say(description('One.', { tag: 'position' }), 60);
    core.say(description('Two.', { tag: 'position' }), 70);
    expect(core.queue.filter((q) => q.kind === 'description')).toHaveLength(2);
  });

  it('drops empty text and merges identical waiting status messages', () => {
    const core = new BusCore();
    expect(core.say(description('   '), 0)).toEqual([]);
    core.userActed('focus', 0);
    core.say(status('Paused.'), 10);
    core.say(status('Paused.'), 20);
    expect(core.queue.length).toBe(1);
  });
});

describe('BusCore, while a dialog or a menu is open', () => {
  it('stops the voice when one opens and says nothing while it stays open', () => {
    const core = new BusCore();
    core.say(description('Celia waves.'), 0);
    const opened = core.setBlocked('dialog', true, 500);
    expect(types(opened)).toEqual(['cancel', 'duck', 'live', 'note']);
    expect(of(opened, 'note')[0]).toMatchObject({ what: 'cut', cause: 'dialog' });
    // Far longer than the 1.5 s hold: still nothing.
    const due = core.say(description('Thom steps back.', { time: 10.6 }), 4000);
    expect(types(due)).toEqual(['current', 'log']);
    expect(core.say(status('The sample has finished.'), 4100)).toEqual([]);
    expect(core.tick(9000)).toEqual([]);
    expect(core.wakeAt()).toBeNull();
    expect(core.current).toBeNull();
    // It is in the log and R can say it.
    expect(core.last.text).toBe('Thom steps back.');
  });

  it('waits 1.5 s after it closes, then says what is still fresh and drops what is stale', () => {
    const core = new BusCore();
    core.setBlocked('dialog', true, 0);
    core.say(description('Stale by then.'), 1000);
    // What waited too long is dropped (and noted for the log) as soon as the bus next looks at its queue.
    const later = core.say(description('Still fresh.'), 9000);
    expect(of(later, 'note')[0]).toMatchObject({ what: 'skipped', item: { text: 'Stale by then.' } });
    expect(of(later, 'speak')).toEqual([]);
    core.say(status('Dialog closed.'), 9500);
    const closed = core.setBlocked('dialog', false, 10_000);
    expect(closed).toEqual([]);
    expect(core.wakeAt()).toBe(10_000 + HOLD_MS);
    expect(core.tick(10_000 + HOLD_MS - 1)).toEqual([]);
    expect(of(core.tick(10_000 + HOLD_MS), 'speak')[0].item.text).toBe('Still fresh.');
    expect(core.queue.map((q) => q.text)).toEqual(['Dialog closed.']);
  });

  it('stays silent until the dialog and the menu are both closed', () => {
    const core = new BusCore();
    core.setBlocked('dialog', true, 0);
    core.setBlocked('menu', true, 10);
    core.say(status('Status.'), 20);
    core.setBlocked('menu', false, 100);
    expect(core.tick(100 + HOLD_MS)).toEqual([]);
    core.setBlocked('dialog', false, 3000);
    expect(types(core.tick(3000 + HOLD_MS))).toEqual(['write']);
  });

  it('ignores a close that was never opened', () => {
    const core = new BusCore();
    expect(core.setBlocked('menu', false, 0)).toEqual([]);
    expect(core.holdUntil).toBe(0);
    expect(of(core.say(description('Celia waves.'), 10), 'speak')).toHaveLength(1);
  });

  it('treats a native dialog as a block of its own, which the end of a menu or of a page dialog does not lift', () => {
    expect(blockReason('dialog')).toBe('native');
    expect(blockReason('menu')).toBe('menu');
    expect(blockReason(undefined)).toBe('menu');
    const core = new BusCore();
    core.say(description('Celia waves.'), 0);
    // The native Open dialog comes up while a description is being spoken.
    const opened = core.setBlocked(blockReason('dialog'), true, 300);
    expect(types(opened)).toEqual(['cancel', 'duck', 'live', 'note']);
    expect(of(opened, 'note')[0]).toMatchObject({ what: 'cut', cause: 'native' });
    // A key reaching the page lifts the block of a menu (see app.js): not this one.
    core.setBlocked('menu', false, 400);
    core.setBlocked('dialog', false, 400);
    const due = core.say(description('Thom steps back.'), 2500);
    expect(types(due)).toEqual(['current', 'log']);
    expect(core.tick(2500 + HOLD_MS)).toEqual([]);
    expect(core.wakeAt()).toBeNull();
    // It closes: the usual hold, then what is still fresh.
    expect(core.setBlocked('native', false, 5000)).toEqual([]);
    expect(core.tick(5000 + HOLD_MS - 1)).toEqual([]);
    expect(of(core.tick(5000 + HOLD_MS), 'speak')[0].item.text).toBe('Thom steps back.');
  });
});

describe('BusCore, when the app voice cannot speak', () => {
  it('hands the description that failed, and every later one, to the screen reader', () => {
    const core = new BusCore();
    const first = core.say(description('Celia waves.', { time: 4.3 }), 0);
    const id = of(first, 'speak')[0].item.id;
    const effects = core.failed(id, 'synthesis-failed', 40);
    expect(types(effects)).toEqual(['cancel', 'note', 'duck', 'live']);
    expect(of(effects, 'note')[0]).toMatchObject({ what: 'failed', cause: 'synthesis-failed', item: { text: 'Celia waves.' } });
    expect(of(effects, 'duck')[0].on).toBe(false);
    expect(of(effects, 'live')[0]).toMatchObject({ status: 'polite', reader: 'polite' });
    expect(core.channel).toBe('reader');
    expect(core.current).toBeNull();
    // A moment for the voice to fall silent, then the same description in the reader's region.
    expect(core.wakeAt()).toBe(40 + SETTLE_MS);
    const again = core.tick(40 + SETTLE_MS);
    expect(types(again)).toEqual(['write']);
    expect(again[0]).toMatchObject({ region: 'reader', item: { id, text: 'Celia waves.' } });
    // It was logged when it came due, not a second time.
    expect(of([...effects, ...again], 'log')).toEqual([]);
    // The estimate for the screen reader runs out; the next description goes the same way.
    expect(core.tick(core.wakeAt())).toEqual([]);
    const next = core.say(description('Thom steps back.'), 9000);
    expect(of(next, 'speak')).toEqual([]);
    expect(of(next, 'write')[0]).toMatchObject({ region: 'reader', item: { text: 'Thom steps back.' } });
  });

  it('reads the failed item before a status that says what happened, and before older descriptions', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    core.say(description('Two.'), 10);
    core.failed(of(first, 'speak')[0].item.id, 'audio-busy', 20);
    core.say(status('The app voice could not read a description.'), 20);
    expect(core.tick(20 + SETTLE_MS)[0]).toMatchObject({ type: 'write', region: 'reader', item: { text: 'One.' } });
    expect(core.tick(core.wakeAt())[0]).toMatchObject({ type: 'write', region: 'reader', item: { text: 'Two.' } });
    expect(core.tick(core.wakeAt())[0]).toMatchObject({ type: 'write', region: 'status' });
  });

  it('hands an answer the user asked for to the screen reader too', () => {
    const core = new BusCore();
    const asked = core.say(answer('On screen: Celia.'), 0);
    core.failed(of(asked, 'speak')[0].item.id, 'voice-unavailable', 30);
    expect(core.tick(30 + SETTLE_MS)[0]).toMatchObject({ type: 'write', region: 'reader', item: { text: 'On screen: Celia.' } });
  });

  it('says nothing while a dialog is open, also after a failure', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    const id = of(first, 'speak')[0].item.id;
    core.setBlocked('native', true, 10);
    // Cut off by the dialog: a late report from the voice is about nothing.
    expect(core.failed(id, 'synthesis-failed', 20)).toEqual([]);
    expect(core.channel).toBe('app');
  });

  it('ignores a failure report for something it is no longer saying', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    const id = of(first, 'speak')[0].item.id;
    core.finished(id, 1000);
    expect(core.failed(id, 'synthesis-failed', 1001)).toEqual([]);
    expect(core.failed(999, 'synthesis-failed', 1001)).toEqual([]);
    expect(core.channel).toBe('app');
  });

  it('hands over at once when the computer has no voice for the language, with what was being said', () => {
    const core = new BusCore();
    const first = core.say(description('Celia waves.', { time: 4.3 }), 0);
    const id = of(first, 'speak')[0].item.id;
    const effects = core.noVoice('no-voice', 200);
    expect(types(effects)).toEqual(['cancel', 'note', 'duck', 'live']);
    expect(of(effects, 'note')[0]).toMatchObject({ what: 'failed', cause: 'no-voice', item: { id } });
    expect(core.channel).toBe('reader');
    expect(core.tick(200 + SETTLE_MS)[0]).toMatchObject({ type: 'write', region: 'reader', item: { text: 'Celia waves.' } });
  });

  it('hands over with nothing being said too, and does nothing when the screen reader reads already', () => {
    const core = new BusCore();
    const effects = core.noVoice('no-voice', 0);
    expect(types(effects)).toEqual(['live']);
    expect(effects[0]).toMatchObject({ status: 'polite', reader: 'polite' });
    expect(core.channel).toBe('reader');
    expect(core.noVoice('no-voice', 10)).toEqual([]);
    expect(of(core.say(description('Celia waves.'), 20), 'write')[0]).toMatchObject({ region: 'reader' });
    // A status that was waiting behind nothing is not lost by the change.
    const waiting = new BusCore();
    waiting.userActed('focus', 0);
    waiting.say(status('Paused.'), 10);
    expect(waiting.noVoice('no-voice', 20)).toHaveLength(1);
    expect(waiting.tick(HOLD_MS)[0]).toMatchObject({ type: 'write', region: 'status' });
  });

  it('lets the user go back to the app voice, and falls back again when it fails again', () => {
    const core = new BusCore();
    const first = core.say(description('One.'), 0);
    core.failed(of(first, 'speak')[0].item.id, 'synthesis-failed', 10);
    core.tick(10 + SETTLE_MS);
    core.tick(core.wakeAt());
    core.setChannel('app', 20_000);
    const second = core.say(description('Two.'), 20_000);
    const spoken = of(second, 'speak')[0].item;
    expect(spoken.text).toBe('Two.');
    expect(of(core.failed(spoken.id, 'synthesis-failed', 20_050), 'note')[0].what).toBe('failed');
    expect(core.channel).toBe('reader');
  });
});

describe('BusCore, reader channel', () => {
  it('writes a description to the polite region and speaks nothing', () => {
    const core = new BusCore({ channel: 'reader' });
    const effects = core.say(description('Celia waves.'), 0);
    expect(types(effects)).toEqual(['current', 'log', 'write']);
    expect(of(effects, 'write')[0].region).toBe('reader');
    expect(of(effects, 'duck')).toEqual([]);
    expect(core.live(true)).toMatchObject({ status: 'polite', reader: 'polite' });
  });

  it('holds a status until the estimated end of the description: a screen reader gives no signal', () => {
    const core = new BusCore({ channel: 'reader' });
    core.say(description('Celia waves at Thom from the bridge.'), 0);
    expect(core.say(status('Paused.'), 100)).toEqual([]);
    const until = core.wakeAt();
    expect(core.tick(until - 1)).toEqual([]);
    expect(core.tick(until)[0]).toMatchObject({ type: 'write', region: 'status' });
  });

  it('forgets the current item and holds when the user acts', () => {
    const core = new BusCore({ channel: 'reader' });
    core.say(description('Celia waves.'), 0);
    const effects = core.userActed('focus', 200);
    expect(types(effects)).toEqual(['note']);
    expect(core.current).toBeNull();
    expect(core.holdUntil).toBe(200 + HOLD_MS);
  });
});

describe('BusCore, switching channel', () => {
  it('stops the voice and turns the reader region on', () => {
    const core = new BusCore();
    core.say(description('Celia waves.'), 0);
    const effects = core.setChannel('reader', 300);
    expect(types(effects)).toEqual(['cancel', 'duck', 'live', 'note', 'live']);
    expect(effects[effects.length - 1]).toMatchObject({ status: 'polite', reader: 'polite' });
    expect(core.channel).toBe('reader');
  });

  it('keeps the reader region off in the app channel', () => {
    const core = new BusCore({ channel: 'reader' });
    const effects = core.setChannel('app', 0);
    expect(effects[0]).toMatchObject({ type: 'live', status: 'polite', reader: 'off' });
    expect(core.setChannel('app', 10)).toEqual([]);
  });
});

describe('estimateSpeechMs', () => {
  it('grows with the text and shrinks with the rate', () => {
    const short = estimateSpeechMs('希莉亚挥手。');
    const long = estimateSpeechMs('希莉亚，扎马尾的年轻女人，穿蓝黑夹克，一只手是机械手。');
    expect(long).toBeGreaterThan(short);
    expect(estimateSpeechMs('希莉亚，扎马尾的年轻女人，穿蓝黑夹克。', 2)).toBeLessThan(estimateSpeechMs('希莉亚，扎马尾的年轻女人，穿蓝黑夹克。', 1));
  });

  it('counts Latin text by characters and never goes under 0.8 s', () => {
    expect(estimateSpeechMs('Hi')).toBe(800);
    expect(estimateSpeechMs('Celia raises the robot hand towards Thom.')).toBeGreaterThan(2000);
  });
});

describe('pickVoice', () => {
  const voices = [
    { name: 'Samantha', lang: 'en-US', localService: true, default: true },
    { name: 'Sinji', lang: 'zh-HK', localService: true },
    { name: 'Meijia', lang: 'zh-TW', localService: true },
    { name: 'Tingting', lang: 'zh-CN', localService: true },
    { name: 'Online', lang: 'zh-CN', localService: false },
  ];

  it('picks the voice of the exact language', () => {
    expect(pickVoice(voices, 'zh-CN').name).toBe('Tingting');
    expect(pickVoice(voices, 'en-US').name).toBe('Samantha');
    expect(pickVoice(voices, 'zh_CN').name).toBe('Tingting');
  });

  it('never picks a voice that needs the network', () => {
    expect(pickVoice([voices[4]], 'zh-CN')).toBeNull();
  });

  it('prefers Mandarin to Cantonese when the exact one is missing', () => {
    expect(pickVoice(voices.slice(0, 3), 'zh-CN').name).toBe('Meijia');
    expect(pickVoice(voices.slice(0, 2), 'zh-CN').name).toBe('Sinji');
  });

  it('returns null when no voice speaks the language', () => {
    expect(pickVoice(voices.slice(0, 1), 'zh-CN')).toBeNull();
    expect(pickVoice([], 'en-US')).toBeNull();
    expect(pickVoice(voices, '')).toBeNull();
  });
});

describe('voiceState', () => {
  const chinese = [{ name: 'Tingting', lang: 'zh-CN', localService: true }];
  const english = [{ name: 'Samantha', lang: 'en-US', localService: true }];

  it('says "loading" for an empty list only until the list has had its time to arrive', () => {
    expect(voiceState([], 'zh-CN', false)).toBe('loading');
    expect(voiceState(null, 'zh-CN', false)).toBe('loading');
    expect(voiceState([], 'zh-CN', true)).toBe('none');
    expect(voiceState(null, 'zh-CN', true)).toBe('none');
  });

  it('says "none" as soon as there are voices but none for the language', () => {
    expect(voiceState(english, 'zh-CN', false)).toBe('none');
    expect(voiceState(english, 'zh-CN', true)).toBe('none');
    // A voice that needs the network does not count.
    expect(voiceState([{ lang: 'zh-CN', localService: false }], 'zh-CN', true)).toBe('none');
  });

  it('says "ok" when a voice for the language is installed', () => {
    expect(voiceState(chinese, 'zh-CN', false)).toBe('ok');
    expect(voiceState([...english, ...chinese], 'zh-CN', true)).toBe('ok');
  });
});

describe('volume and rate', () => {
  it('ramps the film volume and stays between 0 and 1', () => {
    expect(volumeAt(1, DUCK_VOLUME, 0)).toBe(1);
    expect(volumeAt(1, DUCK_VOLUME, 1)).toBeCloseTo(0.35);
    expect(volumeAt(1, DUCK_VOLUME, 0.5)).toBeCloseTo(0.675);
    expect(volumeAt(1, DUCK_VOLUME, 7)).toBeCloseTo(0.35);
    expect(volumeAt(0.35, 1, -1)).toBeCloseTo(0.35);
  });

  it('keeps the voice rate in the range Chromium can speak', () => {
    expect(clampRate(1)).toBe(1);
    expect(clampRate(5)).toBe(2);
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate('fast')).toBe(1);
  });
});

/** The least of an element the bus needs: attributes, text and children. */
function element() {
  const node = {
    attributes: {},
    textContent: '',
    className: '',
    children: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    get firstElementChild() {
      return this.children[0];
    },
    remove() {},
  };
  node.ownerDocument = { createElement: () => element() };
  return node;
}

/** A voice that records what it was asked to say; the test decides how each utterance ends. */
function standInVoice({ throws = false } = {}) {
  const voice = { spoken: [], cancels: 0, current: null };
  voice.Utterance = class {
    constructor(text) {
      this.text = text;
      this.onend = null;
      this.onerror = null;
    }
  };
  voice.synth = {
    speak(utterance) {
      if (throws) throw new Error('no engine');
      voice.spoken.push(utterance.text);
      voice.current = utterance;
    },
    cancel() {
      voice.cancels += 1;
    },
    getVoices: () => [],
  };
  return voice;
}

describe('SpeechBus with a stand-in voice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function build(options = {}) {
    const voice = standInVoice(options);
    const els = { statusEl: element(), readerEl: element(), logEl: element(), currentEl: element() };
    const notes = [];
    const failures = [];
    const bus = new SpeechBus({
      ...els,
      synth: voice.synth,
      Utterance: voice.Utterance,
      now: () => Date.now(),
      onNote: (line) => notes.push(line),
      onVoiceFailed: (cause) => {
        failures.push({ cause, channel: bus.channel });
        // What the page does: it says what happened, through the bus.
        bus.status('The app voice could not read a description.');
      },
    });
    return { bus, voice, notes, failures, ...els };
  }

  it('tells the page once when no voice can read the language, whether or not something is being said', () => {
    const idle = build();
    expect(idle.bus.voiceUnavailable('no-voice')).toBe(true);
    expect(idle.failures).toEqual([{ cause: 'no-voice', channel: 'reader' }]);
    expect(idle.bus.voiceUnavailable('no-voice')).toBe(false);
    expect(idle.failures).toHaveLength(1);
    idle.bus.describe('Celia waves.');
    vi.advanceTimersByTime(8000);
    expect(idle.voice.spoken).toEqual([]);
    expect(idle.readerEl.textContent).toBe('Celia waves.');

    const busy = build();
    busy.bus.describe('Thom steps back.');
    expect(busy.voice.spoken).toEqual(['Thom steps back.']);
    expect(busy.bus.voiceUnavailable('no-voice')).toBe(true);
    expect(busy.voice.cancels).toBe(1);
    expect(busy.failures).toEqual([{ cause: 'no-voice', channel: 'reader' }]);
    vi.advanceTimersByTime(SETTLE_MS + 100);
    // The description the voice was in the middle of is read by the screen reader.
    expect(busy.readerEl.textContent).toBe('Thom steps back.');
  });

  it('speaks a description and treats its end as the end', () => {
    const { bus, voice, failures, readerEl } = build();
    bus.describe('Celia waves.');
    expect(voice.spoken).toEqual(['Celia waves.']);
    voice.current.onend();
    vi.advanceTimersByTime(1000);
    expect(failures).toEqual([]);
    expect(bus.channel).toBe('app');
    expect(readerEl.textContent).toBe('');
  });

  it('falls back to the screen reader on a voice error, tells the page once, and loses nothing', () => {
    const { bus, voice, notes, failures, readerEl, statusEl, logEl } = build();
    bus.describe('Celia waves.');
    voice.current.onerror({ error: 'synthesis-failed' });
    // The page was told after the bus had switched.
    expect(failures).toEqual([{ cause: 'synthesis-failed', channel: 'reader' }]);
    expect(bus.channel).toBe('reader');
    expect(readerEl.attributes['aria-live']).toBe('polite');
    expect(notes.some((line) => /description #1 failed \(synthesis-failed\)/.test(line))).toBe(true);
    // The description that failed is read by the screen reader, then the status that explains it.
    vi.advanceTimersByTime(SETTLE_MS + 100);
    expect(readerEl.textContent).toBe('Celia waves.');
    expect(statusEl.textContent).toBe('');
    vi.advanceTimersByTime(10_000);
    expect(statusEl.textContent).toBe('The app voice could not read a description.');
    // Later descriptions never go to the voice again by themselves.
    bus.describe('Thom steps back.');
    vi.advanceTimersByTime(200);
    expect(voice.spoken).toEqual(['Celia waves.']);
    expect(readerEl.textContent).toBe('Thom steps back.');
    expect(logEl.children).toHaveLength(2);
    expect(failures).toHaveLength(1);
  });

  it('does not take an utterance that was stopped for one that failed', () => {
    const { bus, voice, failures } = build();
    bus.describe('Celia waves.');
    voice.current.onerror({ error: 'interrupted' });
    bus.describe('Thom steps back.');
    vi.advanceTimersByTime(SETTLE_MS + 10);
    voice.current.onerror({ error: 'canceled' });
    vi.advanceTimersByTime(1000);
    expect(failures).toEqual([]);
    expect(bus.channel).toBe('app');
    expect(voice.spoken).toEqual(['Celia waves.', 'Thom steps back.']);
  });

  it('falls back when the voice throws', () => {
    const { bus, failures, readerEl } = build({ throws: true });
    bus.describe('Celia waves.');
    vi.advanceTimersByTime(SETTLE_MS + 100);
    expect(failures).toHaveLength(1);
    expect(failures[0].cause).toMatch(/^exception/);
    expect(bus.channel).toBe('reader');
    expect(readerEl.textContent).toBe('Celia waves.');
  });

  it('falls back when the voice never reports back, without reading the stale description late', () => {
    const { bus, voice, failures, readerEl, statusEl } = build();
    bus.describe('Celia waves.');
    vi.advanceTimersByTime(4000);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(failures).toEqual([{ cause: 'timeout', channel: 'reader' }]);
    expect(voice.cancels).toBe(1);
    expect(readerEl.textContent).toBe('');
    expect(statusEl.textContent).toBe('The app voice could not read a description.');
    // R still has it.
    expect(bus.repeat()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(readerEl.textContent).toBe('Celia waves.');
  });

  it('ignores a late error from an utterance it has already stopped', () => {
    const { bus, voice, failures } = build();
    bus.describe('Celia waves.');
    const stopped = voice.current;
    bus.userActed('focus');
    stopped.onerror({ error: 'synthesis-failed' });
    expect(failures).toEqual([]);
    expect(bus.channel).toBe('app');
  });
});
