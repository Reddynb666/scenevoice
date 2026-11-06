// @vitest-environment jsdom
// While a section's answer streams in, the service worker relays its cues so
// far ('partial' events) and the video page plays them at once; the saved
// section replaces them when it is done. The real content script; the
// service worker is a fake.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const ID = 'streamVid01'; // eleven characters, like a real YouTube id
let fake;
let said;
let video;
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}
function genEvent(ev) {
  for (const fn of listeners) fn({ type: MSG.GEN_EVENT, videoId: ID, lang: 'en', ...ev }, sender(), () => {});
}
function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}
const cue = (start, text) => ({ start, gap: 4, kind: 'visual', priority: 1, onScreenText: '', confidence: 'high', brief: text, standard: text, detailed: text });

beforeAll(async () => {
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${ID}` });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>A cooking video</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => true, configurable: true });
  Object.defineProperty(video, 'duration', { get: () => 600, configurable: true });
  Object.defineProperty(video, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { 'toggle-descriptions': 'Alt+Shift+D', 'describe-now': 'Alt+Shift+S' } };
      if (msg.type === MSG.GET_SCRIPT) return { script: null };
      if (msg.type === MSG.GEN_STATUS) return { status: 'generating', done: 0, total: 2, chunkStartedAt: Date.now(), chunkMs: [] };
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

describe('cues that arrive while the section is being written', () => {
  it('are playable at once, and later pieces of the same section replace the earlier ones', async () => {
    await vi.waitFor(async () => expect((await tabState()).status).toBe('generating'), { timeout: 3000 });
    genEvent({ event: 'partial', from: 0, cues: [cue(1, 'A chef ties her apron.')] });
    await vi.waitFor(async () => expect((await tabState()).cueCount).toBe(1));
    expect((await tabState()).status).toBe('generating');
    video.currentTime = 1.5;
    command('describe-now');
    await vi.waitFor(() => expect(said().join(' ')).toMatch(/A chef ties her apron\./));
    // The next piece of the same section carries every cue so far: no duplicates.
    genEvent({ event: 'partial', from: 0, cues: [cue(1, 'A chef ties her apron.'), cue(40, 'She rolls out the dough.')] });
    await vi.waitFor(async () => expect((await tabState()).cueCount).toBe(2));
  });

  it('ignores pieces that are not cues, and pieces for another video', async () => {
    genEvent({ event: 'partial', from: 0, cues: [{ start: 'soon', standard: 5 }, null] });
    for (const fn of listeners) fn({ type: MSG.GEN_EVENT, videoId: 'otherVid001', lang: 'en', event: 'partial', from: 0, cues: [cue(2, 'Elsewhere.')] }, sender(), () => {});
    await new Promise((r) => setTimeout(r, 100));
    expect((await tabState()).cueCount).toBe(2);
  });
});
