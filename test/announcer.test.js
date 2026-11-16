// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from './fake-chrome.js';

let Announcer;
let settings;

beforeEach(async () => {
  vi.useFakeTimers();
  globalThis.chrome = fakeChrome().chrome;
  document.body.innerHTML = '';
  settings = { output: 'screenreader', readerSpeed: 1.6, interrupt: false, announceStatus: true, ttsRate: 1.2, ttsPitch: 1 };
  vi.resetModules();
  ({ Announcer } = await import('../src/content/announcer.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

const regionTexts = () => [...document.querySelectorAll('[data-scenevoice="live"]')].map((el) => el.textContent).filter(Boolean);

describe('live region writes', () => {
  it('delivers two status messages sent in the same moment, one after the other', () => {
    const a = new Announcer(() => settings);
    a.status('Descriptions loaded.');
    a.status('Tutorial: pausing for detailed descriptions.');
    vi.advanceTimersByTime(40);
    expect(regionTexts()).toEqual(['Descriptions loaded.']);
    vi.advanceTimersByTime(100);
    expect(regionTexts()).toEqual(['Tutorial: pausing for detailed descriptions.']);
  });

  it('puts urgent text in an assertive region and the rest in a polite one', () => {
    const a = new Announcer(() => settings);
    a.say('A woman enters.', { urgent: true });
    vi.advanceTimersByTime(40);
    const [el] = [...document.querySelectorAll('[data-scenevoice="live"]')].filter((r) => r.textContent);
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });

  it('forgets what was waiting when stopped', () => {
    const a = new Announcer(() => settings);
    a.status('First.');
    a.status('Second.');
    a.stop();
    vi.advanceTimersByTime(500);
    expect(regionTexts()).toEqual([]);
  });
});

describe('the language of each write', () => {
  const filled = () => [...document.querySelectorAll('[data-scenevoice="live"]')].find((el) => el.textContent);

  it('is the description language for a description and the interface language for status and feedback', () => {
    const a = new Announcer(() => settings);
    a.lang = 'it';
    a.say('Una donna entra.');
    vi.advanceTimersByTime(40);
    expect(filled().getAttribute('lang')).toBe('it');
    expect(filled().textContent).toBe('Una donna entra.');
    a.status('Creating descriptions…');
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('en');
    // Direct writes (feedback, errors) are interface text unless said otherwise.
    a.announceToScreenReader('Descriptions off.', false);
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('en');
    a.announceToScreenReader('Risposta.', false, { lang: 'it' });
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('it');
  });

  it('splits "Earlier:" from the description it leads, each in its own language, as one announcement', () => {
    const a = new Announcer(() => settings);
    a.lang = 'it';
    a.say('Earlier: Una donna entra.', { lead: 'Earlier: ' });
    vi.advanceTimersByTime(40);
    const region = filled();
    expect(region.hasAttribute('lang')).toBe(false);
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect([...region.children].map((el) => [el.getAttribute('lang'), el.textContent])).toEqual([
      ['en', 'Earlier: '],
      ['it', 'Una donna entra.'],
    ]);
    expect(region.textContent).toBe('Earlier: Una donna entra.');
    // Same language on both sides: one plain write.
    a.lang = 'en';
    a.say('Earlier: A woman enters.', { lead: 'Earlier: ' });
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('en');
    expect(filled().children).toHaveLength(0);
  });

  it('gives the built-in voice the interface language for status text and the description language for descriptions', () => {
    const fake = fakeChrome();
    globalThis.chrome = fake.chrome;
    settings = { ...settings, output: 'tts', ttsVoices: { it: 'Alice', en: 'Daniel' } };
    const a = new Announcer(() => settings);
    a.lang = 'it';
    a.status('Creating descriptions…');
    a.say('Una donna entra.');
    const spoken = fake.sent.filter((m) => m.type === 'sv:speak');
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toMatchObject({ text: 'Creating descriptions…', lang: 'en', voice: 'Daniel' });
    expect(spoken[1]).toMatchObject({ text: 'Una donna entra.', lang: 'it', voice: 'Alice' });
  });
});

describe('built-in voice in a hidden tab', () => {
  const hide = () => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  let sent;
  const spoken = () => sent.filter((m) => m.type === 'sv:speak');

  beforeEach(() => {
    const fake = fakeChrome();
    globalThis.chrome = fake.chrome;
    sent = fake.sent;
    settings = { ...settings, output: 'tts' };
  });

  it('waits silently when its video is paused or muted, so it does not talk over the tab being watched', () => {
    hide();
    const a = new Announcer(() => settings, { isAudible: () => false });
    const done = vi.fn();
    a.say('A woman enters.').then(done);
    expect(spoken()).toHaveLength(0);
    expect(a.speaking).toBe(false);
    // The wait stands in for the speech, so the scheduler is not thrown off.
    return vi.advanceTimersByTimeAsync(5000).then(() => expect(done).toHaveBeenCalled());
  });

  it('speaks when its video is playing with sound, hidden or not', () => {
    hide();
    const a = new Announcer(() => settings, { isAudible: () => true });
    a.say('A woman enters.');
    expect(spoken()).toHaveLength(1);
    expect(spoken()[0]).toMatchObject({ text: 'A woman enters.', rate: 1.2 });
  });

  it('speaks in a visible tab whatever the video is doing', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const a = new Announcer(() => settings, { isAudible: () => false });
    a.say('A woman enters.');
    expect(spoken()).toHaveLength(1);
  });
});

describe('built-in voice with a screen reader running: never both at once', () => {
  let fake;
  const regions = () => [...document.querySelectorAll('[data-scenevoice="live"]')];
  const lives = () => regions().map((r) => r.getAttribute('aria-live'));
  const LIVE = ['polite', 'polite', 'assertive', 'assertive'];
  const MUTED = ['off', 'off', 'off', 'off'];
  const spoken = () => fake.sent.filter((m) => m.type === 'sv:speak');
  const stops = () => fake.sent.filter((m) => m.type === 'sv:stop-speaking');
  /** How the service worker reports the end of an utterance. */
  const ended = (id, event = 'end', extra = {}) => fake.deliver({ type: 'sv:tts-event', id, event, ...extra });
  /** Let the reply to a message (a resolved promise) be handled, under fake timers. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    fake = fakeChrome({ reply: () => ({ ok: true }) });
    globalThis.chrome = fake.chrome;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    settings = { ...settings, output: 'tts' };
  });

  it('starts with every region live, as a screen reader output needs', () => {
    const a = new Announcer(() => settings);
    expect(lives()).toEqual(LIVE);
    expect(a.muted).toBe(false);
  });

  it('writes what the voice says into a region that is not live, and makes the regions live again when the voice has finished', async () => {
    const a = new Announcer(() => settings);
    a.lang = 'zh-CN';
    const done = vi.fn();
    a.say('她走进厨房。').then(done);
    // At once, with no delay: the text is there for a braille display and for reading back, and nothing announces it.
    expect(lives()).toEqual(MUTED);
    expect(regions()[0].textContent).toBe('她走进厨房。');
    expect(regions()[0].getAttribute('lang')).toBe('zh-CN');
    expect(spoken()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(lives()).toEqual(MUTED);
    expect(done).not.toHaveBeenCalled();
    ended(spoken()[0].id);
    await settle();
    expect(done).toHaveBeenCalled();
    expect(lives()).toEqual(LIVE);
    // The last description is still on the page after the voice has finished.
    expect(regions()[0].textContent).toBe('她走进厨房。');
  });

  it('says a status message once, by voice, with the region muted: not through the screen reader as well', async () => {
    const a = new Announcer(() => settings);
    a.status('Descriptions ready: 12 in total.');
    expect(spoken()).toHaveLength(1);
    expect(spoken()[0]).toMatchObject({ text: 'Descriptions ready: 12 in total.', lang: 'en' });
    expect(lives()).toEqual(MUTED);
    // In the status region, in the interface language, without the write delay a live announcement uses.
    expect(regions()[1].textContent).toBe('Descriptions ready: 12 in total.');
    expect(regions()[1].getAttribute('lang')).toBe('en');
    // Nothing is queued for the screen reader behind it.
    await vi.advanceTimersByTimeAsync(300);
    expect(regionTexts()).toEqual(['Descriptions ready: 12 in total.']);
    expect(lives()).toEqual(MUTED);
    ended(spoken()[0].id);
    expect(lives()).toEqual(LIVE);
  });

  it('keeps the last description readable while a status message waits its turn behind it, and stays muted until both are over', async () => {
    const a = new Announcer(() => settings);
    a.say('A woman enters.');
    a.status('50% done.');
    const [description, status] = spoken();
    expect(status).toMatchObject({ text: '50% done.', enqueue: true });
    expect(regions()[0].textContent).toBe('A woman enters.');
    expect(regions()[1].textContent).toBe('50% done.');
    ended(description.id);
    await settle();
    // The description is over, the status is being spoken now: still not live.
    expect(a.speaking).toBe(false);
    expect(lives()).toEqual(MUTED);
    ended(status.id);
    expect(lives()).toEqual(LIVE);
  });

  it('answers a key press by voice at once, in the status region, leaving the description text in place', async () => {
    const a = new Announcer(() => settings);
    a.lang = 'it';
    a.say('Una donna entra.');
    const first = spoken()[0];
    a.say('Descriptions off.', { lang: a.uiLang, aside: true });
    const second = spoken()[1];
    expect(second).toMatchObject({ text: 'Descriptions off.', lang: 'en' });
    expect(second.enqueue).toBeUndefined();
    expect(regions()[0].textContent).toBe('Una donna entra.');
    expect(regions()[1].textContent).toBe('Descriptions off.');
    // The first utterance was cut off by the second; its event must not unmute while the second is speaking.
    ended(first.id, 'interrupted');
    expect(lives()).toEqual(MUTED);
    ended(second.id);
    expect(lives()).toEqual(LIVE);
  });

  it.each(['interrupted', 'cancelled'])('makes the regions live again when the utterance was %s', async (event) => {
    const a = new Announcer(() => settings);
    const done = vi.fn();
    a.say('A woman enters.').then(done);
    ended(spoken()[0].id, event);
    await settle();
    expect(lives()).toEqual(LIVE);
    expect(done).toHaveBeenCalled();
    expect(a.voiced.size).toBe(0);
  });

  it('makes the regions live again when no event ever comes: the wait for the voice times out', async () => {
    const a = new Announcer(() => settings);
    const done = vi.fn();
    a.say('A woman enters.').then(done);
    a.status('Second.');
    expect(lives()).toEqual(MUTED);
    // The description's own time-out (twice its estimate, and three seconds), then the queued status one's (thirty seconds more).
    await vi.advanceTimersByTimeAsync(10000);
    expect(done).toHaveBeenCalled();
    expect(lives()).toEqual(MUTED);
    await vi.advanceTimersByTimeAsync(40000);
    expect(lives()).toEqual(LIVE);
    expect(a.voiced.size).toBe(0);
  });

  it('makes the regions live again when the service worker cannot be reached, so nothing was spoken', async () => {
    fake = fakeChrome({ reply: () => null });
    globalThis.chrome = fake.chrome;
    const a = new Announcer(() => settings);
    const done = vi.fn();
    a.say('A woman enters.').then(done);
    expect(lives()).toEqual(MUTED);
    await settle();
    expect(lives()).toEqual(LIVE);
    expect(done).toHaveBeenCalled();
  });

  it('ignores an event for an utterance that is not its own, or from a sender that is not the service worker', async () => {
    const a = new Announcer(() => settings);
    a.say('A woman enters.');
    ended('test');
    ended('welcome-sample:1', 'error');
    expect(lives()).toEqual(MUTED);
    fake.deliver({ type: 'sv:tts-event', id: spoken()[0].id, event: 'error' }, { id: 'other-extension', origin: 'https://evil.example', url: 'https://evil.example/' });
    expect(lives()).toEqual(MUTED);
    expect(a.speaking).toBe(true);
    expect(a.voiceFailureSaid).toBe(false);
  });

  it('stop silences the voice it started, empties the regions and leaves them live', async () => {
    const a = new Announcer(() => settings);
    a.say('A woman enters.');
    ended(spoken()[0].id);
    await settle();
    // Only a queued status is being spoken now: it is still this page's voice, and stop stops it.
    a.say('Next one.');
    a.status('50% done.');
    ended(spoken()[1].id);
    await settle();
    expect(a.speaking).toBe(false);
    a.stop();
    expect(stops()).toHaveLength(1);
    expect(regionTexts()).toEqual([]);
    expect(lives()).toEqual(LIVE);
    // With nothing of its own being spoken, stop sends no global stop (a description in another tab is not cut off).
    a.stop();
    expect(stops()).toHaveLength(1);
  });

  it('hands a screen-reader message the live regions even while the voice was speaking (the extension was reloaded: the voice is gone)', async () => {
    const a = new Announcer(() => settings);
    a.say('A woman enters.');
    expect(lives()).toEqual(MUTED);
    a.announceToScreenReader('SceneVoice was updated or restarted. Reload this page to continue.', false);
    expect(lives()).toEqual(LIVE);
    await vi.advanceTimersByTimeAsync(100);
    expect(regionTexts()).toContain('SceneVoice was updated or restarted. Reload this page to continue.');
  });

  it('with the screen reader as output nothing is ever muted', async () => {
    settings = { ...settings, output: 'screenreader' };
    const a = new Announcer(() => settings);
    a.say('A woman enters.');
    a.status('Ready.');
    await vi.advanceTimersByTimeAsync(300);
    expect(lives()).toEqual(LIVE);
    expect(spoken()).toHaveLength(0);
  });
});

describe('when the built-in voice cannot read the descriptions', () => {
  let fake;
  const regions = () => [...document.querySelectorAll('[data-scenevoice="live"]')];
  const lives = () => regions().map((r) => r.getAttribute('aria-live'));
  const spoken = () => fake.sent.filter((m) => m.type === 'sv:speak');
  const ended = (id, event = 'end', extra = {}) => fake.deliver({ type: 'sv:tts-event', id, event, ...extra });
  const NOTICE = 'The built-in voice cannot read these descriptions properly on this computer: it has no voice for their language, or speech is not working. Add a voice in your system’s speech settings, or choose “My screen reader” in the SceneVoice popup.';
  /** Everything written to a live region while it was live, in order. */
  let heard;

  beforeEach(() => {
    fake = fakeChrome({ reply: () => ({ ok: true }) });
    globalThis.chrome = fake.chrome;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    settings = { ...settings, output: 'tts' };
    heard = [];
  });

  /**
   * Advance the clock in small steps, noting what a screen reader would be given:
   * text that appears in a region while that region is live. Text already there
   * when a region becomes live again is not announced, and is not counted.
   */
  async function listen(ms) {
    const before = new Map(regions().map((r) => [r, r.textContent]));
    for (let t = 0; t < ms; t += 10) {
      await vi.advanceTimersByTimeAsync(10);
      for (const r of regions()) {
        const text = r.textContent;
        if (text && text !== before.get(r) && r.getAttribute('aria-live') !== 'off') heard.push(text);
        before.set(r, text);
      }
    }
  }

  it('after an error, says why once, hands the text to the screen reader, and gives the description the time a screen reader needs', async () => {
    const shown = vi.fn();
    const a = new Announcer(() => settings, { onVoiceFailed: shown });
    a.lang = 'zh-CN';
    const done = vi.fn();
    a.say('她走进厨房，系上一条白色的围裙。').then(done);
    ended(spoken()[0].id, 'error');
    // Live again at once, and nothing lost: the reason, then the description itself, in its own language.
    expect(lives()).toEqual(['polite', 'polite', 'assertive', 'assertive']);
    await listen(400);
    expect(heard).toEqual([NOTICE, '她走进厨房，系上一条白色的围裙。']);
    expect(regions().find((r) => r.textContent.startsWith('她')).getAttribute('lang')).toBe('zh-CN');
    // The page is told too, so it can show the reason to a listener who has no screen reader.
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith(NOTICE);
    // The description was not spoken in an instant: it stays "being read" for the screen reader's reading time.
    expect(done).not.toHaveBeenCalled();
    expect(a.speaking).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(done).toHaveBeenCalled();

    // The next failure: the text again, the reason not again.
    heard = [];
    a.say('她切开一个洋葱。');
    ended(spoken()[1].id, 'error');
    await listen(300);
    expect(heard).toEqual(['她切开一个洋葱。']);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('with no voice for the language, says so once after the utterance, in the interface language, and does not repeat what the voice was given', async () => {
    const shown = vi.fn();
    const a = new Announcer(() => settings, { onVoiceFailed: shown });
    a.lang = 'zh-CN';
    a.say('她走进厨房。');
    // Chrome read it with whatever voice it has; for Chinese text and an English voice that is silence.
    ended(spoken()[0].id, 'end', { noVoice: true });
    await listen(300);
    expect(heard).toEqual([NOTICE]);
    expect(regions().find((r) => r.textContent === NOTICE).getAttribute('lang')).toBe('en');
    expect(shown).toHaveBeenCalledTimes(1);
    expect(a.speaking).toBe(false);
    // Said once: later descriptions do not bring it back.
    heard = [];
    a.say('她切开一个洋葱。');
    ended(spoken()[1].id, 'end', { noVoice: true });
    await listen(300);
    expect(heard).toEqual([]);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('says it in Chinese for a Chinese interface', async () => {
    fake = fakeChrome({ locale: 'zh_CN', reply: () => ({ ok: true }) });
    globalThis.chrome = fake.chrome;
    const a = new Announcer(() => settings);
    a.status('口述已就绪。');
    ended(spoken()[0].id, 'error');
    await listen(400);
    expect(heard).toEqual(['内置语音在这台电脑上读不好这些口述：没有这种语言的语音，或者语音功能出了问题。请在系统的语音设置里添加语音，或者在 SceneVoice 弹出面板里改选“我的读屏软件”。', '口述已就绪。']);
  });
});
