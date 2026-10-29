// @vitest-environment jsdom
// The YouTube tab and the video type, with the real content script: the mode
// and detail a type brings, what the user hears about it (once per video), and
// that the user's own choices always win. One content script instance follows
// several videos, as on YouTube, where moving to another video does not reload the page.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const watchPage = (category) =>
  `<html><script>var ytInitialPlayerResponse = {"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"}${category ? `,"category":${JSON.stringify(category)}` : ''}}}};</script></html>`;

const knot = {
  start: 1,
  gap: 0.5,
  kind: 'visual',
  priority: 1,
  brief: 'She ties a knot.',
  standard: 'She loops the rope around her hand.',
  detailed: 'She passes the rope end up through the small loop, around the standing line and back down through the loop, then pulls both ends tight.',
};
const drum = {
  start: 1,
  gap: 3,
  kind: 'visual',
  priority: 1,
  brief: 'A drummer counts in.',
  standard: 'A drummer in a denim jacket clicks his sticks together four times.',
  detailed: 'A drummer in a faded denim jacket raises his sticks above a small kit and clicks them together four times.',
};
const script = (videoId, cue, extra = {}) => ({ version: 2, videoId, lang: 'en', duration: 600, cues: [cue], characters: [], completedUntil: 600, complete: true, model: 'gemini-test', ...extra });

const VIDEOS = {
  // Saved before Gemini named types: the page's category decides.
  tutorialAAA: { page: watchPage('Education'), script: script('tutorialAAA', knot) },
  musicVideoB: { page: watchPage('Music'), script: script('musicVideoB', drum) },
  // The page says entertainment, but Gemini has seen a tutorial.
  geminiSaysD: { page: watchPage('Entertainment'), script: script('geminiSaysD', knot, { videoType: 'tutorial' }) },
  unknownVidC: { page: watchPage(''), script: script('unknownVidC', drum) },
  turnedOnEEE: { page: watchPage('Howto & Style'), script: script('turnedOnEEE', knot) },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
let video;
const playback = { paused: true };
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const stored = () => fake.areas.sync.settings || {};
const typeNotices = () => said().filter((s) => /^(Tutorial or explainer|Entertainment video):/.test(s));
/** What has been said since `mark` (a length of said()). */
const saidSince = (mark) => said().slice(mark);

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}

async function openVideo(id, title = 'A video') {
  playback.paused = true;
  video.currentTime = 0;
  document.querySelector('ytd-watch-metadata h1').textContent = title;
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${id}` });
  document.dispatchEvent(new Event('yt-navigate-finish'));
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: id, status: 'ready' }), { timeout: 3000 });
}

/** Play from the start through the cue at 0:01. */
async function playThroughFirstCue() {
  playback.paused = false;
  video.currentTime = 0.3;
  await sleep(300);
  video.currentTime = 1.2;
}

beforeAll(async () => {
  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=tutorialAAA' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>Tie a bowline</h1></ytd-watch-metadata>
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
      const id = new URL(url).searchParams.get('v');
      return { ok: true, text: async () => VIDEOS[id]?.page || '' };
    }),
  );
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { 'toggle-descriptions': 'Alt+Shift+D', 'describe-now': 'Alt+Shift+S' } };
      if (msg.type === MSG.GET_SCRIPT) return { script: VIDEOS[msg.videoId]?.script || null };
      return {};
    },
  });
  fake.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
  globalThis.chrome = fake.chrome;

  // Everything handed to the screen reader, in order. Recorded by hand: Vitest
  // clears mock calls before each test, and the first video is announced before the first.
  const { Announcer } = await import('../src/content/announcer.js');
  const spoken = [];
  const announce = Announcer.prototype.announceToScreenReader;
  Announcer.prototype.announceToScreenReader = function record(text, urgent) {
    spoken.push(text);
    return announce.call(this, text, urgent);
  };
  said = () => spoken;
  await import('../src/content/index.js');
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'tutorialAAA', status: 'ready' }), { timeout: 3000 });
});

describe('video type on the YouTube page', () => {
  it('switches a tutorial to pause and detailed, says so once, and how to change it back', async () => {
    await vi.waitFor(() => expect(typeNotices()).toHaveLength(1), { timeout: 3000 });
    expect(typeNotices()[0]).toBe(
      'Tutorial or explainer: SceneVoice will pause when needed, with detailed descriptions. To change it back, choose again in the SceneVoice popup, or turn off “Adjust descriptions to the video type” in settings.',
    );
    expect((await tabState()).videoType).toBe('tutorial');
    // The settings themselves are not changed: other tabs and videos are not affected.
    expect(stored()).toEqual({});

    await playThroughFirstCue();
    await vi.waitFor(() => expect(said()).toContain(knot.detailed), { timeout: 3000 });
    expect(video.pause).toHaveBeenCalled();
    expect(typeNotices()).toHaveLength(1);
  });

  it('keeps entertainment flowing with brief descriptions of the essentials, without repeating how to undo', async () => {
    const before = typeNotices().length;
    const mark = said().length;
    video.pause.mockClear();
    await openVideo('musicVideoB', 'Live at the Roundhouse');
    await vi.waitFor(() => expect(typeNotices()).toHaveLength(before + 1), { timeout: 3000 });
    expect(typeNotices().at(-1)).toBe('Entertainment video: SceneVoice switches to brief descriptions. It describes only the essentials.');

    await playThroughFirstCue();
    await vi.waitFor(() => expect(saidSince(mark)).toContain(drum.brief), { timeout: 3000 });
    expect(saidSince(mark)).not.toContain(drum.standard);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("steps a shortcut on from the value in use, and makes the result the user's own", async () => {
    command('cycle-detail');
    // From the brief descriptions in use for this video, not the saved "standard".
    await vi.waitFor(() => expect(said().at(-1)).toBe('Detail: standard.'));
    await vi.waitFor(() => expect(stored()).toMatchObject({ detail: 'standard', detailChosen: true, modeChosen: false }));
  });

  it("takes Gemini's type over the page's, and leaves the user's own detail alone", async () => {
    const before = typeNotices().length;
    const mark = said().length;
    video.pause.mockClear();
    await openVideo('geminiSaysD', 'Behind the scenes');
    await vi.waitFor(() => expect(typeNotices()).toHaveLength(before + 1), { timeout: 3000 });
    expect(typeNotices().at(-1)).toBe('Tutorial or explainer: SceneVoice will pause when needed.');
    expect((await tabState()).videoType).toBe('tutorial');

    await playThroughFirstCue();
    await vi.waitFor(() => expect(saidSince(mark)).toContain(knot.standard), { timeout: 3000 });
    expect(saidSince(mark)).not.toContain(knot.detailed);
    expect(video.pause).toHaveBeenCalled();
    // The page's own type arriving later does not repeat the message.
    await sleep(200);
    expect(typeNotices()).toHaveLength(before + 1);
  });

  it('says nothing for a video of unknown type', async () => {
    const before = typeNotices().length;
    await openVideo('unknownVidC', 'Sunday afternoon');
    await sleep(300);
    expect((await tabState()).videoType).toBe('');
    expect(typeNotices()).toHaveLength(before);
  });

  it('waits until descriptions are turned on before saying what the type changed', async () => {
    await chrome.storage.sync.set({ settings: { ...stored(), enabled: false } });
    await sleep(50);
    const before = typeNotices().length;
    await openVideo('turnedOnEEE', 'Fold a fitted sheet');
    await sleep(300);
    expect(typeNotices()).toHaveLength(before);

    command('toggle-descriptions');
    await vi.waitFor(() => expect(typeNotices()).toHaveLength(before + 1));
    // The detail is the user's own since the shortcut above: only the mode follows the type.
    expect(typeNotices().at(-1)).toBe('Tutorial or explainer: SceneVoice will pause when needed.');
    expect(said()).toContain('Descriptions on.');
  });

  it('uses the saved mode and detail once adjusting is turned off', async () => {
    await openVideo('tutorialAAA', 'Tie a bowline');
    await chrome.storage.sync.set({ settings: { ...stored(), autoByType: false } });
    await sleep(50);
    command('cycle-mode');
    // From the saved "keep playing", not the tutorial's "pause".
    await vi.waitFor(() => expect(said().at(-1)).toBe('Mode: pause the video when a description does not fit a pause.'));
    await vi.waitFor(() => expect(stored()).toMatchObject({ mode: 'pause', modeChosen: true, autoByType: false }));
  });
});
