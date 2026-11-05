// @vitest-environment jsdom
// The first video played without descriptions says once how to create them;
// after that, no video repeats it (it is remembered in the synced settings).

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
const playback = { paused: true };
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const hints = () => said().filter((s) => s.startsWith('No audio description yet'));

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

async function openAndPlay(id) {
  playback.paused = true;
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${id}` });
  document.dispatchEvent(new Event('yt-navigate-finish'));
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: id, status: 'none' }), { timeout: 3000 });
  playback.paused = false;
  await sleep(500);
}

beforeAll(async () => {
  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=firstVideoA' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>A video</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  const video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => playback.paused, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 1, writable: true, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { 'toggle-descriptions': 'Alt+Shift+D' } };
      if (msg.type === MSG.GET_SCRIPT) return { script: null };
      if (msg.type === MSG.GEN_STATUS) return { status: 'idle' };
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
});

describe('the "how to create descriptions" hint', () => {
  it('is given the first time a video without descriptions plays, and remembered', async () => {
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'firstVideoA', status: 'none' }), { timeout: 3000 });
    playback.paused = false;
    await vi.waitFor(() => expect(hints()).toEqual(['No audio description yet. Press Alt+Shift+D to create it. SceneVoice says this only once; the popup lists all its shortcuts.']));
    await vi.waitFor(() => expect(fake.areas.sync.settings?.generateHintGiven).toBe(true));
  });

  it('is not repeated on the next video', async () => {
    await openAndPlay('secondVideo');
    await openAndPlay('thirdVideoC');
    expect(hints()).toHaveLength(1);
  });
});
