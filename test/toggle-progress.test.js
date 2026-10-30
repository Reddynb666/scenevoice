// @vitest-environment jsdom
// Pressing the SceneVoice shortcut while descriptions are being created says how
// far it has got (percent, section, time left) and never starts the job again.
// That holds for a job this tab started and for one already running when the
// user comes back to the video (nothing saved yet): then the "no descriptions
// yet" hint is not given either. The real content script; the service worker is a fake.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const RUNNING = 'runningJobA';
const FRESH = 'freshVideoB';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
let video;
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const sent = (type) => fake.sent.filter((m) => m.type === type);

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}

async function openVideo(id) {
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${id}` });
  document.dispatchEvent(new Event('yt-navigate-finish'));
  await vi.waitFor(async () => expect((await tabState()).videoId).toBe(id), { timeout: 3000 });
}

beforeAll(async () => {
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${RUNNING}` });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>A long talk</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => true, configurable: true });
  Object.defineProperty(video, 'duration', { get: () => 900, configurable: true });
  Object.defineProperty(video, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });

  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
  const startedAt = Date.now() - 20000;
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { 'toggle-descriptions': 'Alt+Shift+D' } };
      if (msg.type === MSG.GET_SCRIPT) return { script: null };
      if (msg.type === MSG.GEN_STATUS) {
        return msg.videoId === RUNNING ? { status: 'generating', done: 0, total: 3, chunkStartedAt: startedAt, chunkMs: [] } : { status: 'idle' };
      }
      if (msg.type === MSG.GEN_START) return { status: 'generating', done: 0, total: 3, chunkStartedAt: Date.now(), chunkMs: [] };
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

describe('the shortcut during generation', () => {
  it('follows a job already running when the user comes back, without the "no descriptions yet" hint', async () => {
    await vi.waitFor(async () => expect((await tabState()).status).toBe('generating'), { timeout: 3000 });
    await sleep(300);
    expect(said().some((s) => /No audio description yet/.test(s))).toBe(false);
    command('toggle-descriptions');
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/^Creating descriptions: \d+% done, working on section 1 of 3\./), { timeout: 3000 });
    expect(sent(MSG.GEN_START)).toHaveLength(0);
    expect((await tabState()).status).toBe('generating');
  });

  it('reports progress for a job this tab started, and does not start it again', async () => {
    await openVideo(FRESH);
    command('toggle-descriptions');
    await vi.waitFor(() => expect(sent(MSG.GEN_START)).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(async () => expect((await tabState()).status).toBe('generating'), { timeout: 3000 });
    for (let i = 0; i < 2; i += 1) {
      const mark = said().length;
      command('toggle-descriptions');
      await vi.waitFor(() => expect(said().slice(mark).join(' ')).toMatch(/\d+% done/), { timeout: 3000 });
    }
    expect(sent(MSG.GEN_START)).toHaveLength(1);
    expect((await tabState()).enabled ?? true).toBe(true);
  });
});
