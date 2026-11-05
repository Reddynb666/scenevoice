// @vitest-environment jsdom
// Opening a video that was described before is not met with silence: the user
// hears that the saved descriptions are loaded and how many there are, how to
// turn them on when they are off, and, for a run that stopped part-way, how much
// was loaded in the same sentence that says the rest is being created.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const cue = (start) => ({ start, gap: 3, kind: 'visual', priority: 1, brief: 'A cat.', standard: 'A cat sits.', detailed: 'A grey cat sits on a mat.' });
const script = (videoId, extra) => ({ version: 2, videoId, lang: 'en', duration: 900, cues: [cue(1), cue(20), cue(40)], characters: [], completedUntil: 900, complete: true, model: 'gemini-test', ...extra });

const SCRIPTS = {
  completeAAA: script('completeAAA'),
  partialBBBB: script('partialBBBB', { complete: false, completedUntil: 300 }),
  emptyCCCCCC: script('emptyCCCCCC', { cues: [] }),
};

let fake;
let said;
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const sent = (type) => fake.sent.filter((m) => m.type === type);

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

async function openVideo(id) {
  const mark = said().length;
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${id}` });
  document.dispatchEvent(new Event('yt-navigate-finish'));
  await vi.waitFor(async () => expect((await tabState()).videoId).toBe(id), { timeout: 3000 });
  return mark;
}

beforeAll(async () => {
  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=completeAAA' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>Cats</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  const video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => true, configurable: true });
  Object.defineProperty(video, 'duration', { get: () => 900, configurable: true });
  Object.defineProperty(video, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });

  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { 'toggle-descriptions': 'Alt+Shift+D' } };
      if (msg.type === MSG.GET_SCRIPT) return { script: SCRIPTS[msg.videoId] || null };
      if (msg.type === MSG.GEN_START) return { status: 'generating', done: 1, total: 3, chunkStartedAt: Date.now(), chunkMs: [30000] };
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

describe('a video described before', () => {
  it('says the saved descriptions are loaded, with the count', async () => {
    await vi.waitFor(() => expect(said()).toContain('AI-generated audio description follows. Descriptions already saved for this video, loaded: 3 in total.'), { timeout: 3000 });
    expect((await tabState()).status).toBe('ready');
    expect(sent(MSG.GEN_START)).toHaveLength(0);
  });

  it('says that nothing needed describing when the saved run found nothing', async () => {
    const mark = await openVideo('emptyCCCCCC');
    await vi.waitFor(() => expect(said().slice(mark)).toContain('AI-generated audio description follows. This video was described before: it has nothing visual that needs describing.'), { timeout: 3000 });
  });

  it('says how much was loaded, once, when it carries on with the rest', async () => {
    const mark = await openVideo('partialBBBB');
    await vi.waitFor(() => expect(said().slice(mark)).toContain('AI-generated audio description follows. Saved descriptions loaded for the first 5 minutes (3). Creating the rest.'), { timeout: 3000 });
    expect(said().slice(mark).some((s) => s.startsWith('Continuing descriptions'))).toBe(false);
    expect(sent(MSG.GEN_START)).toHaveLength(1);
  });

  it('says how to turn them on when descriptions are off', async () => {
    await chrome.storage.sync.set({ settings: { enabled: false } });
    await new Promise((r) => setTimeout(r, 50));
    const mark = await openVideo('completeAAA');
    await vi.waitFor(
      () => expect(said().slice(mark)).toContain('AI-generated audio description follows. Descriptions already saved for this video (3). They are off; press Alt+Shift+D to turn them on.'),
      { timeout: 3000 },
    );
  });

  it('with the notice set to once per video, says it only the first time each video opens', async () => {
    await chrome.storage.sync.set({ settings: { enabled: true, aiNoticeEveryTime: false } });
    await new Promise((r) => setTimeout(r, 50));
    let mark = await openVideo('emptyCCCCCC');
    await vi.waitFor(() => expect(said().slice(mark)).toContain('AI-generated audio description follows. This video was described before: it has nothing visual that needs describing.'), { timeout: 3000 });
    expect(fake.areas.sync.aiNoticeSeen).toContain('emptyCCCCCC');
    mark = await openVideo('completeAAA');
    await vi.waitFor(() => expect(said().slice(mark).some((x) => x.includes('loaded: 3 in total'))).toBe(true), { timeout: 3000 });
    mark = await openVideo('emptyCCCCCC');
    await vi.waitFor(() => expect(said().slice(mark)).toContain('This video was described before: it has nothing visual that needs describing.'), { timeout: 3000 });
    expect(said().slice(mark).some((x) => x.startsWith('AI-generated'))).toBe(false);
  });
});
