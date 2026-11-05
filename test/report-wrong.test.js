// @vitest-environment jsdom
// "Description is wrong" and answers that name their moment, with the real
// content script: what the user hears at every step, that only the marked
// description is sent to be made again, and jumping to the moment of an answer.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const cue = (start, standard, extra = {}) => ({ start, gap: 8, kind: 'visual', priority: 1, brief: standard, standard, detailed: standard, ...extra });
const WOMAN = cue(1, 'A woman in red smiles.');
const SIGN = cue(30, 'Sign: OPEN', { kind: 'text', onScreenText: 'OPEN' });
const FIXED = cue(1, 'A man in a grey coat waves.', { confidence: 'high', revised: true });

let saved = { version: 2, videoId: 'reportVideo', lang: 'en', duration: 600, cues: [WOMAN, SIGN], characters: [], completedUntil: 600, complete: true, model: 'gemini-test' };
/** What the service worker answers to MSG.REVISE and MSG.ASK. */
let revise = () => ({ error: 'unknown' });
let ask = () => ({ error: 'unknown' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
let video;
const playback = { paused: true };
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const sent = (type) => fake.sent.filter((m) => m.type === type);
const shadow = () => document.querySelector('[data-scenevoice=ui]').shadowRoot;

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}

function popupAction(action) {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_ACTION, action }, sender(), resolve);
  });
}

async function playThrough(t) {
  playback.paused = false;
  video.currentTime = t - 0.8;
  await sleep(250);
  video.currentTime = t + 0.3;
  await sleep(250);
}

beforeAll(async () => {
  // jsdom has no modal dialogs: open and close them as a browser would (the close event comes later).
  const dialogProto = (globalThis.HTMLDialogElement || HTMLElement).prototype;
  dialogProto.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  dialogProto.close = function close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };

  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=reportVideo' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>Diner at night</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => playback.paused, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(video, 'duration', { value: 600, configurable: true });
  video.pause = vi.fn(() => {
    playback.paused = true;
  });
  video.play = vi.fn(async () => {
    playback.paused = false;
  });

  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: {} };
      if (msg.type === MSG.GET_SCRIPT) return { script: saved };
      if (msg.type === MSG.REVISE) return revise(msg);
      if (msg.type === MSG.ASK) return ask(msg);
      return {};
    },
  });
  fake.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
  globalThis.chrome = fake.chrome;

  const { Announcer } = await import('../src/content/announcer.js');
  const spoken = [];
  const announce = Announcer.prototype.announceToScreenReader;
  Announcer.prototype.announceToScreenReader = function record(text, urgent) {
    spoken.push(text);
    return announce.call(this, text, urgent);
  };
  said = () => spoken;
  await import('../src/content/index.js');
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'reportVideo', status: 'ready', cueCount: 2 }), { timeout: 3000 });
});

describe('a description marked as wrong', () => {
  it('says it is marked and which one, sends only that description, and reads the corrected one', async () => {
    await playThrough(WOMAN.start);
    await vi.waitFor(() => expect(said()).toContain(WOMAN.standard));

    revise = () => {
      saved = { ...saved, cues: [FIXED, SIGN] };
      return { status: 'revised', cue: FIXED };
    };
    command('report-wrong');
    await vi.waitFor(() => expect(said()).toContain('Updated. The description at 0:01 is now: A man in a grey coat waves.'));
    const marked = said().indexOf('Marked the description at 0:01 as wrong. Describing that moment again. It said: A woman in red smiles.');
    expect(marked).toBeGreaterThan(-1);
    expect(marked).toBeLessThan(said().indexOf('Updated. The description at 0:01 is now: A man in a grey coat waves.'));

    const [msg] = sent(MSG.REVISE);
    expect(msg).toMatchObject({ videoId: 'reportVideo', lang: 'en', cue: { start: 1, kind: 'visual', standard: WOMAN.standard }, duration: 600, meta: { title: 'Diner at night' } });
    // Only what identifies the description: not how playback moved it.
    expect(Object.keys(msg.cue)).toEqual(['start', 'kind', 'standard']);

    // The corrected description is the one repeated, and the one played from now on.
    command('repeat-last');
    await vi.waitFor(() => expect(said().at(-1)).toBe(FIXED.standard));
    command('stop-speaking');
    const before = said().filter((s) => s === WOMAN.standard).length;
    await playThrough(FIXED.start);
    await vi.waitFor(() => expect(said().at(-1)).toBe(FIXED.standard));
    expect(said().filter((s) => s === WOMAN.standard)).toHaveLength(before);
  });

  it('says it is still working if pressed again meanwhile, and what went wrong if it fails', async () => {
    let finish;
    revise = () => new Promise((resolve) => (finish = resolve));
    command('report-wrong');
    await vi.waitFor(() => expect(sent(MSG.REVISE)).toHaveLength(2));
    command('report-wrong');
    await vi.waitFor(() => expect(said().at(-1)).toBe('Still describing the marked moment again. One moment, please.'));
    expect(sent(MSG.REVISE)).toHaveLength(2);

    finish({ error: 'quota' });
    await vi.waitFor(() => expect(said().at(-1)).toBe('That moment could not be described again. Your Gemini quota is used up for now. Try again in a few minutes (a daily limit resets the next day), or pick another model on the settings page: each has its own quota.'));
  });

  it('says so when, looking again, there was nothing to describe, and works from the popup', async () => {
    revise = () => {
      saved = { ...saved, cues: [SIGN] };
      return { status: 'removed' };
    };
    // The popup asks the tab; the tab does the rest and speaks.
    popupAction('report-wrong');
    await vi.waitFor(() => expect(said().at(-1)).toBe('Looked again: nothing at 0:01 needs describing, so that description was removed.'));
    await vi.waitFor(async () => expect((await tabState()).cueCount).toBe(1));
  });

  it('has nothing to mark for an answer to a question, or far from any description', async () => {
    const count = sent(MSG.REVISE).length;
    playback.paused = true;
    video.currentTime = 200;
    ask = () => ({ text: 'At 3:18: A chef holds up a dumpling.', time: 198, confidence: 'high' });
    command('describe-now');
    await vi.waitFor(() => expect(said().at(-1)).toBe('At 3:18: A chef holds up a dumpling.'));
    command('report-wrong');
    await vi.waitFor(() => expect(said().at(-1)).toBe('There is no saved description here to mark. Answers to questions are not saved; just ask again.'));
    expect(sent(MSG.REVISE)).toHaveLength(count);
  });
});

describe('answers that name their moment', () => {
  it('offers to go to the moment an answer is about, and goes there', async () => {
    playback.paused = false;
    video.currentTime = 50;
    video.play.mockClear();
    ask = () => ({ text: 'At 0:42: She holds a red key.', time: 42, confidence: 'high' });
    command('ask-question');
    await vi.waitFor(() => expect(shadow().querySelector('dialog[open]')).not.toBeNull());
    const dialog = shadow().querySelector('dialog');
    const jump = dialog.querySelector('[data-act=jump]');
    expect(jump.hidden).toBe(true);
    // Paused while asking.
    expect(playback.paused).toBe(true);

    dialog.querySelector('textarea').value = 'What is she holding?';
    dialog.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(dialog.querySelector('.answer').textContent).toBe('At 0:42: She holds a red key.'));
    expect(sent(MSG.ASK).at(-1).params).toMatchObject({ question: 'What is she holding?', time: 50 });
    expect(jump.hidden).toBe(false);
    expect(jump.textContent).toBe('Go to 0:42');
    // Reached with one Tab from the question field.
    expect(dialog.querySelector('.row button:not([hidden])')).toBe(jump);

    jump.click();
    await vi.waitFor(() => expect(said().at(-1)).toBe('Jumped to 0:42.'));
    expect(video.currentTime).toBe(42);
    expect(video.play).toHaveBeenCalled();
    expect(shadow().querySelector('dialog')).toBeNull();
  });

  it('offers no jump for an error, and closing does not move the video', async () => {
    playback.paused = false;
    video.currentTime = 60;
    ask = () => ({ error: 'network' });
    command('ask-question');
    await vi.waitFor(() => expect(shadow().querySelector('dialog[open]')).not.toBeNull());
    const dialog = shadow().querySelector('dialog');
    dialog.querySelector('textarea').value = 'Who?';
    dialog.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(dialog.querySelector('.answer').textContent).toMatch(/Could not reach the Gemini API/));
    expect(dialog.querySelector('[data-act=jump]').hidden).toBe(true);
    dialog.querySelector('[data-act=close]').click();
    await vi.waitFor(() => expect(shadow().querySelector('dialog')).toBeNull());
    expect(video.currentTime).toBe(60);
  });
});
