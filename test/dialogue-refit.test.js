// @vitest-environment jsdom
// Cues fitted to the real dialogue, with the real content script on a fake
// YouTube page with captions: the speed shortcuts fit them again for the new
// reading speed, and a description held back during another one takes the
// pause it is said in, not the little room it had at its own moment.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fitCuesToDialogue } from '../src/shared/dialogue.js';
import { chooseUtterance } from '../src/shared/script.js';
import { fakeChrome } from './fake-chrome.js';

const watchPage = (id) =>
  `<html><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=${id}\\u0026lang=en","languageCode":"en","kind":"asr"}]}},"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"},"category":""}}};</script></html>`;

const speech = (...ranges) => JSON.stringify({ events: ranges.map(([from, to]) => ({ tStartMs: from * 1000, dDurationMs: (to - from) * 1000, segs: [{ utf8: 'They keep talking about the weather.' }] })) });

const cue = (start, gap, priority, brief) => ({ start, gap, kind: 'visual', priority, brief, standard: brief, detailed: brief });
const script = (videoId, cues) => ({ version: 2, videoId, lang: 'en', duration: 600, cues, characters: [], completedUntil: 600, complete: true, model: 'gemini-test' });

/** Five words: 1.37 s at the default reading speed (1.6), 0.99 s one step faster (2.4). The pause at 14 has 1.2 s. */
const LETTER = cue(11, 30, 1, 'She hands him the letter.');
/** Six words, 1.6 s: what the user asks to hear again while the next cue comes due. */
const DOOR = cue(2, 30, 1, 'A red door swings slowly open.');
/** Nine words, 2.3 s, more than the 1.2 s pause at 14 but well within the model's 6 s. */
const COAT = cue(13.8, 6, 2, 'A woman in a yellow coat crosses the road.');

const VIDEOS = {
  // Speech 10-14 and 15.5-20: the letter lands in speech, and the pause at 14 is too short for it at the default speed.
  speedRefitA: { captions: speech([10, 14], [15.5, 20]), script: script('speedRefitA', [LETTER]) },
  // Speech 10-14, 15.5-18 and 30-35: the coat comes due at 14 and must wait for the pause at 18.
  heldRefitBB: { captions: speech([10, 14], [15.5, 18], [30, 35]), script: script('heldRefitBB', [DOOR, COAT]) },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
let video;
const playback = { paused: true };
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const stored = () => fake.areas.sync.settings || {};

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}

/** Play through the moment t: arrive just before it (a seek, which says nothing), then move past it. */
async function playThrough(t) {
  playback.paused = false;
  video.currentTime = t - 0.8;
  await sleep(250);
  video.currentTime = t + 0.3;
  await sleep(250);
}

const captionsLoaded = (id) => fetch.mock.calls.some(([url]) => String(url).includes(`/api/timedtext?v=${id}`));

async function openVideo(id) {
  playback.paused = true;
  video.currentTime = 0;
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${id}` });
  document.dispatchEvent(new Event('yt-navigate-finish'));
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: id, status: 'ready' }), { timeout: 3000 });
  await vi.waitFor(() => expect(captionsLoaded(id)).toBe(true), { timeout: 3000 });
  await sleep(150);
}

beforeAll(async () => {
  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=speedRefitA' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>A video</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => playback.paused, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
  video.pause = vi.fn(() => {
    playback.paused = true;
  });
  video.play = vi.fn(async () => {
    playback.paused = false;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = new URL(url);
      const id = u.searchParams.get('v');
      return { ok: true, text: async () => (u.pathname === '/api/timedtext' ? VIDEOS[id]?.captions : watchPage(id)) || '' };
    }),
  );
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: {} };
      if (msg.type === MSG.GET_SCRIPT) return { script: VIDEOS[msg.videoId]?.script || null };
      return {};
    },
  });
  fake.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
  globalThis.chrome = fake.chrome;

  const { Announcer } = await import('../src/content/announcer.js');
  const spoken = [];
  const announce = Announcer.prototype.announceToScreenReader;
  Announcer.prototype.announceToScreenReader = function record(text, urgent, opts) {
    spoken.push(text);
    return announce.call(this, text, urgent, opts);
  };
  said = () => spoken;
  await import('../src/content/index.js');
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'speedRefitA', status: 'ready' }), { timeout: 3000 });
  await vi.waitFor(() => expect(captionsLoaded('speedRefitA')).toBe(true), { timeout: 3000 });
  await sleep(150);
});

describe('the speed shortcut', () => {
  it('fits the cues to the dialogue again for the new reading speed', { timeout: 10000 }, async () => {
    // At the default speed the letter fits no pause within reach: it lands in speech and is skipped.
    await playThrough(LETTER.start);
    await sleep(200);
    expect(said()).not.toContain(LETTER.brief);

    command('speed-up');
    await vi.waitFor(() => expect(stored()).toMatchObject({ readerSpeed: 2.4 }));
    await sleep(100);
    // Read faster, it fits the 1.2 s pause at 14: it has moved there and is said.
    await playThrough(14);
    await vi.waitFor(() => expect(said()).toContain(LETTER.brief), { timeout: 3000 });

    command('speed-down');
    await vi.waitFor(() => expect(stored()).toMatchObject({ readerSpeed: 1.6 }));
  });
});

describe('a description held back during another one', () => {
  it('takes the pause it is said in rather than the room it had at its own moment', { timeout: 15000 }, async () => {
    await openVideo('heldRefitBB');
    await playThrough(DOOR.start);
    await vi.waitFor(() => expect(said()).toContain(DOOR.brief));
    await sleep(1800); // the door has been read

    // "Repeat" the door just before the coat comes due: what the user asked for is not cut off, so the coat waits.
    video.currentTime = 13.5;
    await sleep(200);
    command('repeat-last');
    await sleep(250);
    video.currentTime = 14.3;
    await sleep(1800);
    expect(said()).not.toContain(COAT.brief);

    // Speech ends at 18: the pause before 30 has room for the coat, though the pause at 14 had not.
    video.currentTime = 18.1;
    await vi.waitFor(() => expect(said()).toContain(COAT.brief), { timeout: 3000 });
  });

  it('is fitted again from the model estimate, which stays the upper bound', () => {
    const intervals = [
      { start: 10, end: 14 },
      { start: 15.5, end: 18 },
      { start: 30, end: 35 },
    ];
    const [fitted] = fitCuesToDialogue([COAT], intervals, { rate: 1.6 });
    expect(fitted).toMatchObject({ start: 14, gap: 1.2, gapMeasured: true });
    // sayHeld's construction: the held cue at the current time, with the model's own gap.
    const refit = (at) => fitCuesToDialogue([{ ...fitted, start: at, gap: COAT.gap, gapMeasured: false }], intervals, { rate: 1.6 })[0];
    expect(refit(18.1)).toMatchObject({ start: 18.1, gap: 6, gapMeasured: true });
    expect(chooseUtterance(refit(18.1), { mode: 'gaps', detail: 'standard', rate: 1.6, onScreenText: true })).toEqual({ text: COAT.brief, needsPause: false });
    // The measured room still caps it when the pause is shorter than the estimate.
    expect(refit(27.5)).toMatchObject({ start: 27.5, gap: 2.2 });
    // Fitted again with the stale measured gap, it would never fit: the bug this guards against.
    expect(fitCuesToDialogue([{ ...fitted, start: 18.1 }], intervals, { rate: 1.6 })[0].gap).toBe(1.2);
  });
});
