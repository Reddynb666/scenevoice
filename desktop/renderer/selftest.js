// The page half of the self-test (`npm run selftest`). It runs inside the real
// window, on the real page: where the focus starts, what screen readers are
// given (through the accessibility tree the main process reads for us), the
// key map and the menu reaching every action, real key presses in the dialog,
// the SpeechBus rules on the real live regions (with a stand-in voice, so
// nothing is heard), silence under a native dialog, the fallback when the
// voice fails, the microphone opening for its test and for nothing else (with
// Chromium's stand-in device: no real microphone), the sample playing and
// seeking through the media scheme, or, in a build without the clip, "Hear a
// sample" over the opened film, the Content-Security-Policy, reflow at 200%,
// emulated forced colours and axe-core (WCAG 2.2 AA tags). With
// SCENEVOICE_SELFTEST_FILM it also seeks far into that film. The results go to
// the main process, which adds its own and prints them.
//
// Loaded only when the app runs with --selftest. It cannot run a screen reader.

import { ACTIONS } from '../shared/actions.js';
import { actionForKey } from './keys.js';
import { HOLD_MS, SpeechBus } from './speechbus.js';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until test() is truthy; false when it never is. */
async function until(test, timeout = 5000) {
  const end = performance.now() + timeout;
  for (;;) {
    let value = false;
    try {
      value = test();
    } catch {
      value = false;
    }
    if (value) return value;
    if (performance.now() > end) return false;
    await wait(40);
  }
}

const oneLine = (value, max) => String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);

/**
 * A voice that records what it was asked to say and ends when told to.
 * `fails`: it reports an error for everything, the way a broken speech engine does.
 */
function standInVoice({ fails = false } = {}) {
  const spoken = [];
  let cancels = 0;
  let current = null;
  class Utterance {
    constructor(text) {
      this.text = text;
      this.onend = null;
      this.onerror = null;
    }
  }
  const synth = {
    speak(utterance) {
      spoken.push(utterance.text);
      if (fails) {
        setTimeout(() => utterance.onerror && utterance.onerror({ error: 'synthesis-failed' }), 20);
        return;
      }
      current = utterance;
    },
    cancel() {
      cancels += 1;
      const utterance = current;
      current = null;
      if (utterance && utterance.onerror) utterance.onerror({ error: 'interrupted' });
    },
    getVoices: () => [],
  };
  return {
    synth,
    Utterance,
    spoken,
    cancels: () => cancels,
    finish() {
      const utterance = current;
      current = null;
      if (utterance && utterance.onend) utterance.onend();
    },
  };
}

function loadAxe() {
  if (window.axe) return Promise.resolve(true);
  return new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = '/selftest/axe.min.js';
    tag.onload = () => resolve(Boolean(window.axe));
    tag.onerror = () => resolve(false);
    document.head.append(tag);
  });
}

/**
 * @param {object} shell  what app.js exports: the bridge, the strings, the elements, the bus
 */
export async function runSelftest(shell) {
  const { sv, t, els, video, bus, state, script, run, hooks } = shell;
  const checks = [];
  const info = [];
  const check = (name, ok, detail = '') => checks.push({ name: oneLine(name, 60), ok: Boolean(ok), detail: oneLine(detail, 380) });
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      check(name, false, `threw: ${err && err.message}`);
    }
  };
  const seen = [];
  hooks.onAction = (action, source) => seen.push(`${source}:${action}`);
  const press = (keyCode, modifiers = [], char) => sv.invoke('selftest:input', char ? { keyCode, modifiers, char } : { keyCode, modifiers });
  const axeResult = { ran: false, violations: 0, incomplete: 0, passes: 0, detail: '' };
  /** A picture for a developer to look at; does nothing unless SCENEVOICE_SELFTEST_SHOTS is set. */
  const shot = (name) => sv.invoke('selftest:shot', { name }).catch(() => false);

  await step('focus starts on the heading', async () => {
    await until(() => document.activeElement === els.title, 3000);
    const heading = els.title;
    check(
      'focus starts on the heading',
      document.activeElement === heading && heading.tagName === 'H1' && heading.tabIndex === -1 && heading.textContent === t('heading'),
      `focused: ${document.activeElement && document.activeElement.tagName}`,
    );
    check('nothing plays at start', video.paused && !video.currentSrc && !speechSynthesis.speaking && !speechSynthesis.pending);
    await shot('start-light');
    await shot('start-dark');
    check(
      'page language follows the interface language',
      document.documentElement.lang === t('htmlLang') && document.documentElement.dir === t('htmlDir') && document.title === t('appName'),
      `${document.documentElement.lang} ${document.documentElement.dir}`,
    );
  });

  await step('every button has an accessible name', async () => {
    const buttons = [...document.querySelectorAll('button')];
    const unnamed = buttons.filter((b) => !(b.textContent.trim() || (b.getAttribute('aria-label') || '').trim()));
    check('every button has an accessible name', buttons.length >= 15 && unnamed.length === 0, `${buttons.length} buttons, ${unnamed.length} without a name`);
    const expected = ['btnSample', 'btnOpen', 'btnDialog', 'btnNotify', 'btnUseReader', 'btnHelp'].map((key) => t(key));
    const first = [...document.querySelectorAll('#actions button')].map((b) => b.textContent);
    check('the six buttons come in the agreed order', JSON.stringify(first) === JSON.stringify(expected), first.join(' | '));

    const ax = await sv.invoke('selftest:ax');
    check('the accessibility tree names every button', ax.buttons >= 15 && ax.unnamedButtons === 0, `${ax.buttons} buttons in the tree, ${ax.unnamedButtons} without a name`);
    check(
      'status, log and player have their roles',
      els.status.getAttribute('role') === 'status' &&
        els.log.getAttribute('role') === 'log' &&
        els.player.getAttribute('role') === 'application' &&
        ax.status === 1 &&
        ax.log === 1 &&
        ax.application === 1 &&
        ax.applicationName === t('playerLabel'),
      `tree: status ${ax.status}, log ${ax.log}, application ${ax.application} "${ax.applicationName}"`,
    );
    check(
      'the accessibility tree has the focus on the h1',
      ax.focusedRole === 'heading' && ax.focusedName === t('heading') && Number(ax.focusedLevel) === 1,
      `${ax.focusedRole} level ${ax.focusedLevel} "${ax.focusedName}"`,
    );
    check(
      'the current description line takes the focus',
      els.current.tabIndex === 0 && els.current.contains(els.currentText) && els.log.getAttribute('aria-live') === 'off',
    );
  });

  await step('the key map names every action', async () => {
    const wrong = ACTIONS.filter((a) => actionForKey({ code: a.code, key: a.key, shiftKey: Boolean(a.shift) }) !== a.id).map((a) => a.id);
    const ignored = [
      actionForKey({ code: 'KeyD', key: 'd' }, 'typing'),
      actionForKey({ code: 'KeyD', key: 'd' }, 'modal'),
      actionForKey({ code: 'KeyD', key: 'Process', isComposing: true }),
      actionForKey({ code: 'KeyD', key: 'd', ctrlKey: true }),
      actionForKey({ code: 'KeyD', key: 'd', altKey: true }),
      actionForKey({ code: 'Space', key: ' ' }, 'button'),
    ].every((value) => value === null);
    // With a Chinese input method the key arrives as "Process": the physical key still decides.
    const inputMethod = actionForKey({ code: 'KeyD', key: 'Process' }) === 'describe';
    check('the key map names every action', wrong.length === 0 && ignored && inputMethod, wrong.length ? `wrong: ${wrong.join(', ')}` : `${ACTIONS.length} keys`);
  });

  await step('single keys dispatch every action', async () => {
    seen.length = 0;
    for (const a of ACTIONS) {
      els.player.dispatchEvent(new KeyboardEvent('keydown', { code: a.code, key: a.key, shiftKey: Boolean(a.shift), bubbles: true, cancelable: true }));
      if (els.dlgWrong.open) {
        els.dlgWrong.close();
        await until(() => !state.modal, 1500);
      }
    }
    const missing = ACTIONS.filter((a) => !seen.includes(`key:${a.id}`)).map((a) => a.id);
    check('single keys dispatch every action', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : seen.join(' '));

    seen.length = 0;
    els.rate.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true, cancelable: true }));
    els.sample.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    els.player.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', ctrlKey: true, bubbles: true, cancelable: true }));
    els.player.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'Process', isComposing: true, bubbles: true, cancelable: true }));
    check('keys are left alone in fields, on buttons, with modifiers', seen.length === 0, seen.join(' '));
  });

  await step('real key presses reach the key map', async () => {
    els.player.focus();
    seen.length = 0;
    await press('W');
    await press('/', ['shift']);
    await press('Space');
    await press('Left');
    const all = await until(() => ['key:who', 'key:help', 'key:toggle', 'key:back'].every((k) => seen.includes(k)), 3000);
    check('real key presses reach the key map', all, seen.join(' '));
  });

  await step('an accelerator pressed on a button does not press the button', async () => {
    // The keys of the menu accelerators, with either platform's modifiers, as real key presses
    // with the focus on a button: whatever the menu makes of them (nothing here on macOS, where
    // a synthetic key press does not reach the menu), the page itself must neither press the
    // focused button nor take the key for a single key.
    els.sample.focus();
    seen.length = 0;
    for (const a of ACTIONS) {
      const key = a.accelerator.split('+').pop();
      for (const modifiers of [['control', 'alt'], ['meta', 'alt']]) await press(key, modifiers);
      await wait(60);
      if (els.dlgWrong.open) {
        els.dlgWrong.close();
        await until(() => !state.modal, 1500);
      }
    }
    await wait(300);
    const stray = seen.filter((entry) => entry.startsWith('button:') || entry.startsWith('key:'));
    check('an accelerator pressed on a button does not press the button', stray.length === 0 && state.media === 'none' && document.activeElement === els.sample, `page actions: ${stray.join(' ') || 'none'}; by way of the menu: ${seen.filter((entry) => entry.startsWith('menu:')).join(' ') || 'none'}`);
    // Whatever the menu did with them here, later checks start from silence.
    video.pause();
    bus.stop();
  });

  await step('menu items dispatch every action', async () => {
    seen.length = 0;
    const bad = [];
    let offWhileModal = false;
    for (const a of ACTIONS) {
      const item = await sv.invoke('selftest:menu', { id: `action:${a.id}` });
      if (!item.found || !item.enabled || item.accelerator !== a.accelerator) bad.push(a.id);
      await until(() => seen.includes(`menu:${a.id}`), 1500);
      if (a.id === 'wrong') {
        await until(() => els.dlgWrong.open, 1500);
        await wait(200);
        const other = await sv.invoke('selftest:menu', { id: 'action:describe' });
        offWhileModal = other.found && !other.enabled;
        els.dlgWrong.close();
        await until(() => !state.modal, 1500);
        await wait(200);
      }
    }
    const missing = ACTIONS.filter((a) => !seen.includes(`menu:${a.id}`)).map((a) => a.id);
    check('menu items dispatch every action', missing.length === 0 && bad.length === 0, missing.length || bad.length ? `missing: ${missing.join(', ')}; wrong item: ${bad.join(', ')}` : `${ACTIONS.length} items`);
    check('listening menu items are off while a dialog is open', offWhileModal);
  });

  await step('the dialog keeps the focus inside', async () => {
    els.dialog.focus();
    els.dialog.click();
    await until(() => els.dlgTest.open, 1500);
    const startsInField = document.activeElement === els.dlgTestInput;
    const ax = await sv.invoke('selftest:ax');
    check('the dialog is exposed with its title', ax.dialog === 1 && ax.dialogName === t('dlgTitle'), `dialogs ${ax.dialog} "${ax.dialogName}"`);

    seen.length = 0;
    await press('D', [], 'd');
    await until(() => els.dlgTestInput.value === 'd', 1000);
    check('typing in the dialog triggers no action', els.dlgTestInput.value === 'd' && seen.length === 0, `field "${els.dlgTestInput.value}", actions ${seen.length}`);

    const trail = [];
    const where = () => {
      const el = document.activeElement;
      return els.dlgTest.contains(el) ? el.id || el.dataset.result || el.tagName : 'OUTSIDE';
    };
    for (let i = 0; i < 5; i += 1) {
      await press('Tab');
      await wait(70);
      trail.push(where());
    }
    for (let i = 0; i < 4; i += 1) {
      await press('Tab', ['shift']);
      await wait(70);
      trail.push(where());
    }
    check('the dialog keeps the focus inside', startsInField && !trail.includes('OUTSIDE') && new Set(trail).size === 3, trail.join(' '));

    await press('Escape');
    const closed = await until(() => !els.dlgTest.open, 2000);
    await wait(100);
    check('Escape closes the dialog and the focus returns', closed && document.activeElement === els.dialog, `open ${els.dlgTest.open}, focus on ${document.activeElement && document.activeElement.id}`);
  });

  await step('a native dialog silences the app voice', async () => {
    // The main process stands a "dialog" in for 900 ms and tells the page as it does for the real
    // Open and Save dialogs, which nobody could answer here.
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    const logged = els.log.children.length;
    const closed = sv.invoke('selftest:dialog', { ms: 900 });
    const blocked = Boolean(await until(() => bus.core.blocks.has('native'), 800));
    // A key that reaches the page lifts the block of a menu, never this one.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    const kept = bus.core.blocks.has('native');
    bus.describe('self-test description under a native dialog');
    await wait(300);
    const silent = bus.core.current === null && !speechSynthesis.speaking && !speechSynthesis.pending && els.log.children.length === logged + 1;
    await closed;
    const released = Boolean(await until(() => !bus.blocked, 800));
    const held = bus.core.current === null && bus.core.holdUntil > performance.now() + HOLD_MS - 900;
    // Nothing of this is to be spoken once the hold is over.
    bus.stop();
    check('a native dialog silences the app voice', blocked && kept && silent && released && held, `blocked ${blocked}, kept under a key ${kept}, silent ${silent}, released ${released}, hold running ${held}`);
  });

  await step('a failing voice hands over to the screen reader', async () => {
    await until(() => !bus.core.current, 8000);
    const voice = standInVoice({ fails: true });
    const told = [];
    const test = new SpeechBus({
      statusEl: els.status,
      readerEl: els.reader,
      logEl: document.createElement('div'),
      currentEl: document.createElement('span'),
      synth: voice.synth,
      Utterance: voice.Utterance,
      lang: t('speechLang'),
      uiLang: t('htmlLang'),
      onVoiceFailed: (cause) => {
        told.push(`${cause} ${test.channel}`);
        test.status('self-test voice failed');
      },
    });
    test.describe('self-test description the voice cannot say');
    const tried = voice.spoken.length === 1;
    const read = Boolean(await until(() => els.reader.textContent === 'self-test description the voice cannot say', 1500));
    const live = els.reader.getAttribute('aria-live') === 'polite';
    const said = Boolean(await until(() => els.status.textContent === 'self-test voice failed', 6000));
    test.describe('self-test description after the failure');
    const next = Boolean(await until(() => els.reader.textContent === 'self-test description after the failure', 6000));
    check(
      'a failing voice hands over to the screen reader',
      tried && read && live && said && next && voice.spoken.length === 1 && told.join() === 'synthesis-failed reader',
      `tried ${tried}, read by the reader region ${read}, region live ${live}, page told "${told.join()}", status ${said}, next one ${next}, voice asked ${voice.spoken.length} time(s)`,
    );
    await until(() => !test.core.current, 5000);
    clearTimeout(test.wakeTimer);
    els.reader.textContent = '';
    els.status.textContent = '';
    bus.run([bus.core.live(true)]);
  });

  await step('a status waits behind a description', async () => {
    // Let the page's own bus fall silent first: the two would share the status region.
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    const voice = standInVoice();
    const test = new SpeechBus({
      statusEl: els.status,
      readerEl: els.reader,
      logEl: document.createElement('div'),
      currentEl: document.createElement('span'),
      synth: voice.synth,
      Utterance: voice.Utterance,
      lang: t('speechLang'),
      uiLang: t('htmlLang'),
    });

    test.describe('self-test description one');
    const speaking = voice.spoken.length === 1;
    const liveOff = els.status.getAttribute('aria-live') === 'off' && els.reader.getAttribute('aria-live') === 'off';
    test.status('self-test status');
    await wait(250);
    const held = els.status.textContent !== 'self-test status';
    voice.finish();
    const written = await until(() => els.status.textContent === 'self-test status', 1500);
    const liveOn = els.status.getAttribute('aria-live') === 'polite';
    check('a status waits behind a description', speaking && liveOff && held && written && liveOn, `speaking ${speaking}, live off ${liveOff}, held ${held}, written ${written}, live on ${liveOn}`);
    await until(() => !test.core.current, 5000);

    test.describe('self-test description two');
    const spokenBefore = voice.spoken.length;
    const started = performance.now();
    test.userActed('focus');
    const cut = voice.cancels() === 1 && test.core.current === null;
    test.status('self-test after the hold');
    await wait(HOLD_MS - 500);
    const silent = els.status.textContent !== 'self-test after the hold' && voice.spoken.length === spokenBefore;
    const later = await until(() => els.status.textContent === 'self-test after the hold', 2000);
    const elapsed = Math.round(performance.now() - started);
    check('the app voice gives way and waits 1.5 s', cut && silent && later && elapsed >= HOLD_MS - 20, `cut ${cut}, silent ${silent}, said after ${elapsed} ms`);
    await until(() => !test.core.current, 5000);

    const logged = test.logEl.children.length === 2;
    const repeated = test.repeat();
    await until(() => voice.spoken.length === spokenBefore + 1, 1500);
    check('R repeats the description that was cut off', repeated && logged && voice.spoken[voice.spoken.length - 1] === 'self-test description two', `said ${voice.spoken.length} times, logged ${test.logEl.children.length}`);
    voice.finish();
    await wait(200);

    const before = voice.spoken.length;
    test.setBlocked('dialog', true);
    test.describe('self-test description behind a dialog');
    await wait(HOLD_MS + 400);
    const quiet = voice.spoken.length === before && test.logEl.children.length === 3;
    const closedAt = performance.now();
    test.setBlocked('dialog', false);
    const resumed = await until(() => voice.spoken.length === before + 1, 3000);
    const waited = Math.round(performance.now() - closedAt);
    check('nothing is said while a dialog is open', quiet && resumed && waited >= HOLD_MS - 20, `quiet ${quiet}, said ${waited} ms after it closed`);
    voice.finish();
    await wait(200);

    const spokenByVoice = voice.spoken.length;
    test.setChannel('reader');
    test.describe('self-test reader description');
    const inRegion = await until(() => els.reader.textContent === 'self-test reader description', 1500);
    check('the reader channel writes a polite live region', inRegion && els.reader.getAttribute('aria-live') === 'polite' && voice.spoken.length === spokenByVoice, `region "${els.reader.textContent}"`);

    clearTimeout(test.wakeTimer);
    els.reader.textContent = '';
    els.status.textContent = '';
    bus.run([bus.core.live(true)]);
  });

  await step('the menu saves the report without the page', async () => {
    // The main process does the saving (in the self-test it declines, with the reason "selftest")
    // and tells the page how it went.
    const item = await sv.invoke('selftest:menu', { id: 'cmd:report' });
    const expected = t('stReportFailed', { reason: 'selftest' });
    const told = await until(() => els.status.textContent === expected, 5000);
    check('the menu saves the report without the page', item.found && item.enabled && told, `item found ${item.found}, enabled ${item.enabled}, page told ${Boolean(told)}`);
  });

  await step('the microphone opens for its test only', async () => {
    // Chromium's stand-in device answers here (main/index.js): no real microphone is opened.
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    const ask = async (constraints) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        for (const track of stream.getTracks()) track.stop();
        return 'opened';
      } catch (err) {
        return String(err && err.name);
      }
    };
    const unasked = await ask({ audio: true });
    await sv.invoke('mic:arm');
    const camera = await ask({ video: true });
    const both = await ask({ audio: true, video: true });
    // The button itself: the tracks it gets are watched, to see that it lets go of them.
    const tracks = [];
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      tracks.push(...stream.getTracks());
      return stream;
    };
    els.mic.click();
    const verdicts = [t('stMicHeard'), t('stMicSilent')];
    const said = Boolean(await until(() => verdicts.includes(els.status.textContent), 40_000));
    // The tracks end with the listening, a moment before the verdict is written.
    await wait(100);
    delete navigator.mediaDevices.getUserMedia;
    const released = tracks.length === 1 && tracks[0].kind === 'audio' && tracks.every((track) => track.readyState === 'ended');
    const again = await ask({ audio: true });
    const refused = [unasked, camera, both, again].every((answer) => answer === 'NotAllowedError');
    check(
      'the microphone opens for its test only',
      refused && said && released && !state.micBusy,
      `unasked ${unasked}, camera ${camera}, sound with camera ${both}, a second request ${again}; the button said "${els.status.textContent}", tracks ${tracks.map((track) => `${track.kind} ${track.readyState}`).join(', ') || 'none'}`,
    );
  });

  let voices = [];
  await step('the system voice speaks and reports its end', async () => {
    await until(() => speechSynthesis.getVoices().length > 0, 2500);
    voices = speechSynthesis.getVoices();
    info.push(`system voices ${voices.length}, one for ${t('speechLang')}: ${bus.hasVoiceFor(t('speechLang'))}`);
    if (!voices.length) {
      info.push('no system voice here: the real app voice was not exercised');
      return;
    }
    const outcome = await new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(t('btnHelp'));
      utterance.lang = t('speechLang');
      utterance.volume = 0;
      utterance.rate = 2;
      utterance.onend = () => resolve('end');
      utterance.onerror = (event) => resolve(`error ${event.error}`);
      speechSynthesis.speak(utterance);
      setTimeout(() => resolve('no event within 10 s'), 10_000);
    });
    check('the system voice speaks and reports its end', outcome === 'end', outcome);
  });

  await step('the sample loads and plays', async () => {
    // A build without the clip: "Hear a sample" is tried over the opened film, further down.
    if (!sv.sample) return;
    const logged = els.log.children.length;
    run('sample', 'selftest');
    await until(() => state.media === 'sample', 8000);
    // Each run starts a fresh log: what is listed is the run that follows.
    const fresh = logged > 0 && els.log.children.length === 0;
    const loaded = await until(() => state.media === 'sample' && video.readyState >= 1, 8000);
    const playing = await until(() => !video.paused && video.currentTime > 0.2, 8000);
    check('the sample loads and plays', loaded && playing && fresh && Math.abs(video.duration - script.duration) < 1, `duration ${video.duration}, at ${video.currentTime}, log emptied ${fresh}`);

    const seeked = new Promise((resolve) => {
      video.addEventListener('seeked', () => resolve(true), { once: true });
    });
    video.currentTime = 33.2;
    const didSeek = await Promise.race([seeked, wait(6000).then(() => false)]);
    check('the film seeks through the media scheme', didSeek && Math.abs(video.currentTime - 33.2) < 1.5 && video.currentSrc.startsWith('svmedia://'), `at ${video.currentTime.toFixed(2)} of ${video.duration}`);

    const cue = script.cues.find((c) => c.t > 33.2 && c.t < 36);
    const due = await until(() => [...els.log.querySelectorAll('.entry')].some((entry) => entry.textContent.includes(cue.text)), 6000);
    check('a description comes at its time and is logged', due && els.currentText.textContent === cue.text, `log entries ${els.log.children.length}, current "${els.currentText.textContent}"`);
    if (voices.length) {
      const down = await until(() => video.volume < 0.6, 4000);
      const up = await until(() => video.volume > 0.95, 15_000);
      check('the film is turned down under the app voice', down && up, `down ${down}, back up ${up}`);
    }
    await shot('playing');
    video.pause();
  });

  await step('timing of the ten descriptions', async () => {
    // Only with `--selftest --timing`: plays the whole sample with the real voice (silent) and
    // reports, as information, when each description started and how long the voice took.
    if (!sv.selftestTiming || !sv.sample) return;
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    const notes = [];
    const original = bus.onNote;
    bus.onNote = (line) => {
      notes.push({ at: video.currentTime, line });
      original(line);
    };
    run('sample', 'selftest');
    await until(() => state.media === 'sample' && !video.paused, 8000);
    await until(() => video.ended, 60_000);
    await until(() => !bus.core.current && !bus.core.queue.some((q) => q.kind !== 'status'), 20_000);
    bus.onNote = original;
    const started = notes.filter((n) => /description #\d+ to the app voice/.test(n.line));
    const skipped = notes.filter((n) => /description #\d+ skipped/.test(n.line));
    const took = notes.map((n) => /voice finished #\d+ \((\w+)\) after (\d+) ms/.exec(n.line)).filter(Boolean);
    const lags = started.map((n, i) => (n.at - script.cues[i].t).toFixed(1));
    info.push(
      `timing: ${started.length} of ${script.cues.length} descriptions spoken by the app voice, ${skipped.length} skipped; ` +
        `started ${lags.join(' ')} s after their times; the voice took ${took.map((m) => m[2]).join(' ')} ms`,
    );
  });

  await step('without the clip, "Hear a sample" says what to do', async () => {
    if (sv.sample) return;
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    run('sample', 'selftest');
    const told = Boolean(await until(() => els.status.textContent === t('stSampleMissing'), 8000));
    const page = els.credit.hidden && els.noFilm.textContent === t('noFilmOpen') && !els.noFilm.hidden;
    check('without the clip, "Hear a sample" says what to do', told && page && state.media === 'none' && video.paused, `told ${told}, page without the clip ${page}, media ${state.media}`);
  });

  await step('opening a film says the sample script is used', async () => {
    run('open', 'selftest');
    const loaded = await until(() => state.media === 'film' && video.readyState >= 1, 8000);
    if (!loaded && !sv.sample) {
      // Nothing to open: the build has no clip and the self-test was given no film.
      info.push('no sample clip in this build and no SCENEVOICE_SELFTEST_FILM: nothing was played');
      return;
    }
    const hint = t(sv.sample ? 'stFilmSameCues' : 'stFilmDemoHint');
    const told = await until(() => els.status.textContent === hint, 25_000);
    check('opening a film says the sample script is used', loaded && told && video.paused, `loaded ${loaded}, told ${told}, paused ${video.paused}`);
  });

  await step('"Hear a sample" plays the opened film from its start', async () => {
    // The builds for testers: no clip, the ten descriptions over the tester's own film.
    if (sv.sample || state.media !== 'film') return;
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    video.currentTime = Math.min(20, video.duration / 2);
    bus.describe('self-test description of an earlier run');
    bus.stop();
    await wait(300);
    const logged = els.log.children.length;
    run('sample', 'selftest');
    // Each run starts a fresh log: what is listed is the run that follows.
    const fresh = logged > 0 && els.log.children.length === 0;
    const restarted = Boolean(await until(() => !video.paused && video.currentTime > 0.2 && video.currentTime < 4, 8000));
    const armed = state.demoEnd === script.duration;
    const first = script.cues[0];
    const due = Boolean(await until(() => [...els.log.querySelectorAll('.entry')].some((entry) => entry.textContent.includes(first.text)), (first.t + 6) * 1000));
    // The end of the run, without waiting for all of it: from one second before.
    video.currentTime = Math.min(script.duration, video.duration) - 1;
    const stopped = Boolean(await until(() => (video.paused || video.ended) && state.demoEnd === null, 8000));
    const told = Boolean(await until(() => els.status.textContent === t('stSampleEnded'), 25_000));
    check(
      '"Hear a sample" plays the opened film from its start',
      fresh && restarted && armed && due && stopped && told,
      `log emptied ${fresh}, restarted ${restarted}, run ends at ${script.duration} s ${armed}, first description logged ${due}, stopped at the end ${stopped}, said so ${told}`,
    );
  });

  await step('a long film seeks far in', async () => {
    // Only when SCENEVOICE_SELFTEST_FILM names a film: the sample is 40 seconds long.
    if (state.media !== 'film' || !(video.duration > script.duration * 3)) return;
    const target = Math.floor(video.duration * 0.9);
    const seeked = new Promise((resolve) => {
      video.addEventListener('seeked', () => resolve(true), { once: true });
    });
    const started = performance.now();
    video.currentTime = target;
    const didSeek = await Promise.race([seeked, wait(30_000).then(() => false)]);
    const took = Math.round(performance.now() - started);
    await video.play().catch(() => {});
    const plays = Boolean(await until(() => video.currentTime > target + 0.5, 10_000));
    video.pause();
    check('a long film seeks far in', didSeek && plays, `film of ${Math.round(video.duration)} s, seek to ${target} s took ${took} ms, plays there: ${plays}`);
    info.push(`long film: ${Math.round(video.duration)} s, picture ${video.videoWidth}x${video.videoHeight}, seek to ${target} s took ${took} ms`);
  });

  await step('the page cannot connect anywhere', async () => {
    const violations = [];
    const onViolation = (event) => violations.push(event.effectiveDirective || event.violatedDirective);
    document.addEventListener('securitypolicyviolation', onViolation);
    let fetchBlocked = false;
    try {
      await fetch('https://scenevoice.invalid/selftest');
    } catch {
      fetchBlocked = true;
    }
    const inline = document.createElement('script');
    inline.textContent = 'window.__svInline = 1;';
    document.head.append(inline);
    inline.remove();
    await wait(150);
    document.removeEventListener('securitypolicyviolation', onViolation);
    check(
      'the page cannot connect anywhere',
      fetchBlocked && violations.some((v) => v.startsWith('connect-src')),
      violations.join(' '),
    );
    check('inline script does not run', window.__svInline !== 1 && violations.some((v) => v.startsWith('script-src')), violations.join(' '));
  });

  await step('no sideways scrolling at 200% zoom', async () => {
    await sv.invoke('selftest:zoom', { factor: 2 });
    await wait(500);
    const root = document.documentElement;
    const fits = root.scrollWidth <= root.clientWidth + 1;
    const detail = `viewport ${root.clientWidth} px, content ${root.scrollWidth} px`;
    await shot('zoom200');
    await sv.invoke('selftest:zoom', { factor: 1 });
    await wait(300);
    check('no sideways scrolling at 200% zoom', fits, detail);
  });

  await step('forced colours keep borders and the focus ring', async () => {
    // Chromium's emulation of forced colours, not Windows high contrast itself.
    await sv.invoke('selftest:emulate', { forcedColors: true });
    await wait(250);
    const active = matchMedia('(forced-colors: active)').matches;
    els.sample.focus();
    // Read now: the style object is live and the ring goes when the emulation ends.
    const focused = getComputedStyle(els.sample);
    const outline = `${focused.outlineWidth} ${focused.outlineStyle}`;
    const ring = focused.outlineStyle !== 'none' && parseFloat(focused.outlineWidth) >= 3;
    const borders = [els.sample, els.rate, els.player, els.current].every((el) => {
      const style = getComputedStyle(el);
      return style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) >= 2;
    });
    await shot('forced-colors');
    await sv.invoke('selftest:emulate', { forcedColors: false });
    await wait(150);
    check('forced colours keep borders and the focus ring', active && ring && borders, `emulated ${active}, focus ring ${outline}, borders ${borders}`);
  });

  await step('axe-core', async () => {
    if (!(await loadAxe())) {
      info.push('axe-core is not installed: accessibility rules were not run');
      return;
    }
    const options = { runOnly: { type: 'tag', values: AXE_TAGS }, resultTypes: ['violations', 'incomplete', 'passes'] };
    const page = await window.axe.run(document, options);
    els.dialog.focus();
    els.dialog.click();
    await until(() => els.dlgTest.open, 1500);
    const dialog = await window.axe.run(document, options);
    await shot('dialog');
    els.dlgTest.close();
    await until(() => !state.modal, 1500);
    const list = (results) => results.map((r) => `${r.id} (${r.nodes.length})`).join(', ');
    axeResult.ran = true;
    axeResult.violations = page.violations.length + dialog.violations.length;
    axeResult.incomplete = page.incomplete.length + dialog.incomplete.length;
    axeResult.passes = page.passes.length + dialog.passes.length;
    axeResult.detail = oneLine(
      `axe-core ${window.axe.version}, tags ${AXE_TAGS.join(' ')}; page: violations [${list(page.violations)}], needs review [${list(page.incomplete)}]; with the dialog open: violations [${list(dialog.violations)}], needs review [${list(dialog.incomplete)}]`,
      1900,
    );
  });

  await step('with no voice for the language the screen reader takes over', async () => {
    // As on a computer that has no Chinese voice: the list of voices is emptied for this check.
    if (state.media === 'none') return;
    video.pause();
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    const wasApp = bus.channel === 'app';
    bus.voices = () => [];
    state.voicesSettled = true;
    state.toldNoVoice = false;
    run('sample', 'selftest');
    const handed = Boolean(await until(() => bus.channel === 'reader', 3000));
    const button = els.channel.textContent === t('btnUseApp');
    const told = Boolean(await until(() => els.status.textContent === t('stNoVoiceReader', { language: t('speechLangName') }), 25_000));
    const first = script.cues[0];
    const read = Boolean(await until(() => els.reader.textContent === first.text, (first.t + 8) * 1000)) && els.reader.getAttribute('aria-live') === 'polite';
    video.pause();
    bus.stop();
    // Once only: a second start says nothing about it again.
    const once = state.toldNoVoice === true;
    delete bus.voices;
    els.channel.click();
    const back = bus.channel === 'app' && els.channel.textContent === t('btnUseReader');
    check('with no voice for the language the screen reader takes over', wasApp && handed && button && told && read && once && back, `handed over ${handed}, button renamed ${button}, status said so ${told}, first description in the reader region ${read}, switched back ${back}`);
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
  });

  await step('a file that cannot be played leaves no film open', async () => {
    // Last, because it closes the film: the player reports an error the way it does for a file
    // it cannot decode.
    if (state.media === 'none') return;
    video.pause();
    bus.core.queue.length = 0;
    await until(() => !bus.core.current, 8000);
    video.dispatchEvent(new Event('error'));
    const closed = state.media === 'none' && video.hidden && !els.noFilm.hidden && els.play.textContent === t('btnPlay');
    const told = Boolean(await until(() => els.status.textContent === t('stFilmError', { code: 0 }), 8000));
    seen.length = 0;
    run('toggle', 'selftest');
    const refused = Boolean(await until(() => els.status.textContent === t(sv.sample ? 'noFilm' : 'noFilmOpen'), 12_000)) && video.paused;
    check('a file that cannot be played leaves no film open', closed && told && refused, `closed ${closed}, told ${told}, play then says there is no film ${refused}`);
  });

  hooks.onAction = null;
  sv.send('selftest:done', { checks, axe: axeResult, info: oneLine(info.join('; '), 1900) });
}
