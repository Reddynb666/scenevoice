// @vitest-environment jsdom
// Pause mode with the built-in voice in a hidden tab (screen off, another
// window in front), with the real content script on a fake YouTube page: the
// video SceneVoice paused for a description is still being listened to, so the
// description is spoken; a video the user paused stays silent.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const watchPage = (category) =>
  `<html><script>var ytInitialPlayerResponse = {"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"},"category":${JSON.stringify(category)}}}};</script></html>`;

/** Too long for its pause: pause mode holds the video for it. */
const NOD = { start: 1, gap: 0.5, kind: 'visual', priority: 1, brief: 'She nods.', standard: 'She nods.', detailed: 'She nods.' };
const SCRIPT = { version: 2, videoId: 'hiddenPause', lang: 'en', duration: 600, cues: [NOD], characters: [], completedUntil: 600, complete: true, model: 'gemini-test' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let video;
const playback = { paused: true };
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const spoken = () => fake.sent.filter((m) => m.type === MSG.SPEAK);

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}

/** The background reports that an utterance has ended, as chrome.tts would. */
function ttsEnded(id) {
  for (const fn of listeners) fn({ type: MSG.TTS_EVENT, id, event: 'end' }, sender(), () => {});
}

beforeAll(async () => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=hiddenPause' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>A lesson</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => playback.paused, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(video, 'volume', { value: 1, writable: true, configurable: true });
  video.pause = vi.fn(() => {
    playback.paused = true;
  });
  video.play = vi.fn(async () => {
    playback.paused = false;
  });

  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => watchPage('Education') })));
  fake = fakeChrome({
    sync: { settings: { output: 'tts' } },
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: {} };
      if (msg.type === MSG.GET_SCRIPT) return { script: msg.videoId === SCRIPT.videoId ? SCRIPT : null };
      return {};
    },
  });
  fake.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
  globalThis.chrome = fake.chrome;
  await import('../src/content/index.js');
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'hiddenPause', status: 'ready', videoType: 'tutorial' }), { timeout: 3000 });
});

describe('pause mode by voice in a hidden tab', () => {
  it('speaks a description the video was paused for, then plays on', async () => {
    expect(document.visibilityState).toBe('hidden');
    playback.paused = false;
    video.currentTime = 0.3;
    await sleep(250);
    video.currentTime = 1.3;
    await vi.waitFor(() => expect(spoken()).toHaveLength(1), { timeout: 3000 });
    expect(spoken()[0]).toMatchObject({ text: NOD.brief, lang: 'en' });
    // The video was held for the description, not left to run over it.
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(playback.paused).toBe(true);
    expect(video.play).not.toHaveBeenCalled();
    ttsEnded(spoken()[0].id);
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledTimes(1));
    expect(playback.paused).toBe(false);
  });

  it('stays silent for a video the user paused, so it does not talk over the tab being watched', async () => {
    playback.paused = true; // the user's own pause
    const before = spoken().length;
    command('repeat-last');
    await sleep(400);
    expect(spoken()).toHaveLength(before);
  });
});
