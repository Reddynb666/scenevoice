// @vitest-environment jsdom
// Descriptions and the pauses they go in, with the real content script on a
// fake YouTube page: pause mode holds the video a little longer for a screen
// reader, a seek stops a description in flight, nothing scheduled cuts off what
// the user asked for, and a listener who loses several descriptions for want of
// a pause hears, once, how to keep them.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const watchPage = (category) =>
  `<html><script>var ytInitialPlayerResponse = {"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"}${category ? `,"category":${JSON.stringify(category)}` : ''}}}};</script></html>`;

const cue = (start, gap, brief, extra = {}) => ({ start, gap, kind: 'visual', priority: 1, brief, standard: brief, detailed: brief, ...extra });

/** About 0.7 s at the default screen reader speed. */
const NOD = cue(1, 0.5, 'She nods.');
/** About 5 s at the default screen reader speed. */
const LONG = cue(10, 30, 'A tall man in a grey raincoat opens the heavy front door, shakes off his umbrella and steps into the dim hallway.');
const DOG = cue(20, 30, 'A dog runs across the beach.');
/** Five cues with no pause to speak of. */
const TIGHT = [30, 32, 34, 36, 38].map((t) => cue(t, 0.2, `At ${t} seconds a crowd of people pours out of the station and across the square.`));

const script = (videoId, cues) => ({ version: 2, videoId, lang: 'en', duration: 600, cues, characters: [], completedUntil: 600, complete: true, model: 'gemini-test' });

const VIDEOS = {
  // A tutorial: pause mode, detailed.
  pauseHoldAA: { page: watchPage('Education'), script: script('pauseHoldAA', [NOD]) },
  // No type: the default "keep playing" mode.
  seekStopBBB: { page: watchPage(''), script: script('seekStopBBB', [LONG, DOG, ...TIGHT]) },
};

const SKIPPED_NOTICE = '4 descriptions were skipped because there was no pause. Press Alt+Shift+M for pause mode.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
let video;
const playback = { paused: true };
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const regionTexts = () => [...document.querySelectorAll('[data-scenevoice="live"]')].map((el) => el.textContent).filter(Boolean);

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}

/** A <video> that reports what the test says, as the player's own would. */
function makeVideo() {
  const v = document.createElement('video');
  v.className = 'html5-main-video';
  Object.defineProperty(v, 'paused', { get: () => playback.paused, configurable: true });
  Object.defineProperty(v, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(v, 'volume', { value: 1, writable: true, configurable: true });
  v.pause = vi.fn(() => {
    playback.paused = true;
  });
  v.play = vi.fn(async () => {
    playback.paused = false;
  });
  return v;
}

async function openVideo(id) {
  playback.paused = true;
  video.currentTime = 0;
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${id}` });
  document.dispatchEvent(new Event('yt-navigate-finish'));
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: id, status: 'ready' }), { timeout: 3000 });
}

/** Play through the moment t: arrive just before it (a seek, which says nothing), then move past it. */
async function playThrough(t) {
  playback.paused = false;
  video.currentTime = t - 0.8;
  await sleep(250);
  video.currentTime = t + 0.3;
  await sleep(250);
}

function seekTo(t, target = video) {
  target.currentTime = t;
  target.dispatchEvent(new Event('seeked'));
}

beforeAll(async () => {
  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=pauseHoldAA' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>A video</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><div class="ytp-right-controls"></div></div>`;
  video = makeVideo();
  document.getElementById('movie_player').prepend(video);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const id = new URL(url).searchParams.get('v');
      return { ok: true, text: async () => VIDEOS[id]?.page || '' };
    }),
  );
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { 'cycle-mode': 'Alt+Shift+M' } };
      if (msg.type === MSG.GET_SCRIPT) return { script: VIDEOS[msg.videoId]?.script || null };
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
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'pauseHoldAA', status: 'ready', videoType: 'tutorial' }), { timeout: 3000 });
});

describe('pause mode with a screen reader', () => {
  it('holds the video 1.5 s longer than the estimated reading time before playing on', { timeout: 10000 }, async () => {
    playback.paused = false;
    video.currentTime = 0.3;
    await sleep(300);
    video.currentTime = 1.2;
    await vi.waitFor(() => expect(said()).toContain(NOD.brief), { timeout: 3000 });
    const spokenAt = Date.now();
    expect(video.pause).toHaveBeenCalled();
    // "She nods." takes about 0.7 s: after 1 s the estimate is over, but the hold is not.
    await sleep(1000);
    expect(video.play).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), { timeout: 3000 });
    expect(Date.now() - spokenAt).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - spokenAt).toBeLessThan(3500);
  });
});

describe('seeking', () => {
  it('stops a description in flight when the user jumps elsewhere, and leaves small corrections alone', async () => {
    await openVideo('seekStopBBB');
    expect((await tabState()).videoType).toBe('');
    await playThrough(LONG.start);
    await vi.waitFor(() => expect(said()).toContain(LONG.brief));
    await vi.waitFor(() => expect(regionTexts()).toContain(LONG.brief));
    expect(video.volume).toBeCloseTo(0.35, 2); // ducked while the description is read

    // A nudge of less than 2.5 s: the description carries on.
    seekTo(LONG.start + 1.5);
    await sleep(100);
    expect(regionTexts()).toContain(LONG.brief);
    expect(video.volume).toBeCloseTo(0.35, 2);

    // A real jump: the description stops and the volume comes back.
    seekTo(60);
    await vi.waitFor(() => expect(regionTexts()).toEqual([]));
    await vi.waitFor(() => expect(video.volume).toBe(1));
  });

  it('ignores events from a video element the player no longer uses', async () => {
    await playThrough(LONG.start);
    await vi.waitFor(() => expect(regionTexts()).toContain(LONG.brief));
    const old = video;
    video = makeVideo();
    video.currentTime = old.currentTime;
    old.remove();
    document.getElementById('movie_player').prepend(video);
    await sleep(300); // the content script picks up the new element
    seekTo(90, old);
    await sleep(200);
    expect(regionTexts()).toContain(LONG.brief);
    command('stop-speaking');
    await vi.waitFor(() => expect(regionTexts()).toEqual([]));
  });
});

describe('what the user asked for', () => {
  it('is not cut off by a scheduled description, which waits for it to end', { timeout: 15000 }, async () => {
    playback.paused = false;
    video.currentTime = DOG.start - 0.8;
    await sleep(250);
    command('repeat-last'); // the long description, about 5 s
    await vi.waitFor(() => expect(said().filter((s) => s === LONG.brief).length).toBeGreaterThanOrEqual(2));
    video.currentTime = DOG.start + 0.3;
    await sleep(600);
    expect(said()).not.toContain(DOG.brief);
    // Once the repeat has been read, the dog is described in the pause that is still open.
    await vi.waitFor(() => expect(said()).toContain(DOG.brief), { timeout: 8000 });
  });
});

describe('descriptions skipped for want of a pause', () => {
  it('are counted, and after more than three the listener hears once how to keep them', { timeout: 15000 }, async () => {
    command('stop-speaking');
    for (const c of TIGHT.slice(0, 3)) await playThrough(c.start);
    expect(said().some((s) => s.startsWith('3 descriptions were skipped'))).toBe(false);
    expect(said()).not.toContain(SKIPPED_NOTICE);
    await playThrough(TIGHT[3].start);
    await vi.waitFor(() => expect(said()).toContain(SKIPPED_NOTICE));
    await playThrough(TIGHT[4].start);
    await sleep(200);
    expect(said().filter((s) => s.includes('were skipped because there was no pause'))).toHaveLength(1);
    // None of them was read over the dialogue.
    for (const c of TIGHT) expect(said()).not.toContain(c.brief);
  });
});
