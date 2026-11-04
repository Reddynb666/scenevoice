// @vitest-environment jsdom
// The real content script on a Bilibili video page, with Qwen: it reads the
// data the page was delivered with and the CC subtitle file the player loads
// (calling none of Bilibili's APIs), takes pictures of the playing video and sends a
// few at a time, says a description that comes back late at the next pause,
// asks with a picture of the moment, and says clearly when the picture cannot
// be taken. The service worker and Bilibili's APIs are fakes; nothing is called.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const BV = 'BV1GJ411x7h7';
const ID = `bili:${BV}`;
const OTHER = 'BV1xx411c7mD';
const CHOP = { start: 6, gap: 4, kind: 'visual', priority: 1, brief: 'A man dices chicken.', standard: 'A man dices chicken on a board.', detailed: 'A man dices chicken on a board.' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
let video;
const playback = { paused: true };
const pixels = { tainted: false, black: false };
const listeners = [];
const fetched = [];
/** Tell the content script the player loaded these files (PerformanceObserver). */
const playerLoads = [];
const playerLoaded = (...names) => playerLoads.forEach((fn) => fn(names.map((name) => ({ name, startTime: performance.now() }))));
/** The saved script, as the service worker would keep it. */
let saved = null;
let askReply = () => ({ error: 'unknown' });
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

function popupAction(action) {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_ACTION, action }, sender(), resolve);
  });
}

/** Play on to `target` seconds, half a second of video per tick of the content script. */
async function playTo(target) {
  playback.paused = false;
  while (video.currentTime < target) {
    video.currentTime = Math.min(target, Math.round((video.currentTime + 0.5) * 10) / 10);
    await sleep(130);
  }
}

const VIEW = {
  [BV]: { title: '宫保鸡丁的做法', owner: { name: '厨师小王' }, desc: '家常菜教程', tname: '美食制作', cid: 111, pages: [{ cid: 111, page: 1, part: '宫保鸡丁', duration: 120 }] },
  [OTHER]: { title: '跨域视频', owner: { name: 'someone' }, desc: '', tname: '日常', cid: 222, pages: [{ cid: 222, page: 1, part: '', duration: 120 }] },
};
/** Subtitles: speech only from 30 s, so the first minute has room for descriptions. */
const SUBTITLE = { body: [{ from: 30, to: 34, content: '先把鸡肉切丁' }, { from: 35, to: 38, content: '然后腌一下' }] };

function fakeFetch(url) {
  fetched.push(url);
  const u = new URL(url);
  const json = (data) => ({ ok: true, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.pathname === '/bfs/subtitle/human.json') return json(SUBTITLE);
  return { ok: false, json: async () => null, text: async () => '' };
}

/** The service worker's side of a stretch of frames: describe, save, reply. */
function onFrames(msg) {
  const cues = msg.window.start < CHOP.start ? [CHOP] : [];
  saved = {
    version: 2,
    videoId: msg.videoId,
    lang: msg.lang,
    duration: 120,
    cues: [...(saved?.cues || []), ...cues],
    characters: [],
    covered: [[0, msg.window.end]],
    completedUntil: msg.window.end,
    complete: false,
    mode: 'frames',
    model: 'qwen-vl-max',
  };
  return { status: 'ok', cues, cueCount: saved.cues.length, completedUntil: msg.window.end, complete: false };
}

beforeAll(async () => {
  jsdom.reconfigure({ url: `https://www.bilibili.com/video/${BV}/?spm_id_from=333.1007` });
  document.title = '宫保鸡丁的做法_哔哩哔哩_bilibili';
  document.body.innerHTML = `
    <script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { bvid: BV, ...VIEW[BV] } })};(function(){var s;}());</script>
    <h1 class="video-title">宫保鸡丁的做法</h1>
    <div class="bpx-player-container"><div class="bpx-player-video-wrap"><video></video></div><div class="bpx-player-control-bottom-right"></div></div>`;
  video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => playback.paused, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(video, 'duration', { value: 120, configurable: true });
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
  video.pause = vi.fn(() => {
    playback.paused = true;
  });
  video.play = vi.fn(async () => {
    playback.paused = false;
  });
  // jsdom has no canvas: draw nothing and hand back a tiny JPEG, or refuse as a tainted canvas does.
  // A protected (DRM) video draws solid black; anything else, some grey.
  HTMLCanvasElement.prototype.getContext = function context() {
    return {
      drawImage() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(pixels.black ? 0 : 128) }),
    };
  };
  HTMLCanvasElement.prototype.toDataURL = () => {
    if (pixels.tainted) throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
    return 'data:image/jpeg;base64,/9j/AAAA';
  };

  vi.stubGlobal('fetch', vi.fn(async (url) => fakeFetch(url)));
  // The page's resource timing: the test says which files the player loaded.
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      constructor(fn) {
        playerLoads.push((entries) => fn({ getEntries: () => entries }));
      }
      observe() {}
    },
  );
  fake = fakeChrome({
    reply: (msg) => {
      // The Gemini key is missing and the Qwen key is set: Bilibili uses Qwen by default.
      if (msg.type === MSG.GET_STATUS) return { hasKey: false, keys: { gemini: false, qwen: true }, shortcuts: {} };
      if (msg.type === MSG.GET_SCRIPT) return { script: msg.videoId === ID ? saved : null };
      if (msg.type === MSG.GEN_FRAMES) return onFrames(msg);
      if (msg.type === MSG.ASK) return askReply(msg);
      if (msg.type === MSG.DELETE_SCRIPT) {
        saved = null;
        return { ok: true };
      }
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
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: ID, status: 'none' }), { timeout: 3000 });
});

describe('a Bilibili video page', () => {
  it('is recognised, uses Qwen with frames, describes in Chinese, and reads the page through Bilibili', async () => {
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ title: '宫保鸡丁的做法', videoType: 'tutorial' }));
    expect(await tabState()).toMatchObject({ supported: true, platform: 'bilibili', provider: 'qwen', inputMode: 'frames', lang: 'zh-CN' });
    // Title, uploader and section come from the page's own data: no Bilibili API is called.
    expect(fetched.some((u) => u.includes('api.bilibili.com'))).toBe(false);
    // The viewer turns CC subtitles on: the file the player loads gives the dialogue timing; another host is ignored.
    playerLoaded('https://evil.example/bfs/subtitle/x.json', 'https://i0.hdslb.com/bfs/subtitle/human.json');
    await vi.waitFor(() => expect(fetched).toContain('https://i0.hdslb.com/bfs/subtitle/human.json'));
    expect(fetched.some((u) => u.includes('evil.example'))).toBe(false);
    expect(fetched.every((u) => !u.includes('api.bilibili.com'))).toBe(true);
    // The SceneVoice button sits in Bilibili's control bar, with a name.
    const button = document.querySelector('.bpx-player-control-bottom-right .scenevoice-button');
    expect(button.getAttribute('aria-label')).toBe('SceneVoice audio description');
  });

  it('describes as the video plays: a stretch of frames is sent, and its description is said at the next pause', { timeout: 15000 }, async () => {
    const state = await popupAction('generate');
    expect(state.status).toBe('live');
    expect(said().some((s) => s.startsWith('AI-generated audio description follows. SceneVoice is describing as you watch') && s.includes('to Qwen'))).toBe(true);

    await playTo(13);
    await vi.waitFor(() => expect(sent(MSG.GEN_FRAMES)).toHaveLength(1));
    const msg = sent(MSG.GEN_FRAMES)[0];
    expect(msg).toMatchObject({ videoId: ID, lang: 'zh-CN', duration: 120, meta: { title: '宫保鸡丁的做法', channel: '厨师小王' } });
    expect(msg.window.start).toBeLessThan(1);
    expect(msg.window.end).toBeGreaterThanOrEqual(12);
    expect(msg.frames.length).toBeGreaterThanOrEqual(4);
    expect(msg.frames.length).toBeLessThanOrEqual(6);
    for (const f of msg.frames) expect(f).toEqual({ time: expect.any(Number), data: '/9j/AAAA' });

    // Its moment (0:06) has passed by more than 6 s: it is said now, in the pause before the speech at 0:30, led by "Earlier:".
    await vi.waitFor(() => expect(said()).toContain(`Earlier: ${CHOP.standard}`));
    expect(await tabState()).toMatchObject({ status: 'live', cueCount: 1 });

    // The box on the player, and the popup's state, say how far the part being watched is described.
    const state2 = await tabState();
    expect(state2.describedUpTo).toBeGreaterThanOrEqual(12);
    const box = document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.progress');
    await vi.waitFor(() => expect(box.hidden).toBe(false));
    expect(box.querySelector('.label').textContent).toBe('Describing as you watch');
    await vi.waitFor(() => expect(box.querySelector('.eta').textContent).toMatch(/^Described up to 0:1\d$/));
  });

  it('answers "describe now" from a picture of the moment', async () => {
    askReply = (msg) => ({ text: `At 1:00: A plate of diced chicken. (${msg.params.frames.length} frames)`, time: 60 });
    video.currentTime = 60;
    await sleep(300);
    command('describe-now');
    await vi.waitFor(() => expect(sent(MSG.ASK)).toHaveLength(1));
    const { params } = sent(MSG.ASK)[0];
    expect(params.frames.length).toBeGreaterThanOrEqual(1);
    expect(params.frames.every((f) => f.data === '/9j/AAAA' && Math.abs(f.time - 60) <= 8)).toBe(true);
    await vi.waitFor(() => expect(said().some((s) => s.startsWith('At 1:00: A plate of diced chicken.'))).toBe(true));
    // Pictures of the last 20 seconds, as many as a request takes.
    expect(params.frames.length).toBeLessThanOrEqual(6);

    // A second question carries the first, so a follow-up is understood.
    command('describe-now');
    await vi.waitFor(() => expect(sent(MSG.ASK)).toHaveLength(2));
    const history = sent(MSG.ASK)[1].params.history;
    expect(history).toHaveLength(1);
    expect(history[0].answer).toMatch(/^At 1:00: A plate of diced chicken\./);
    expect(typeof history[0].question).toBe('string');
  });

  it('treats another part (分P) as another video', async () => {
    const before = await tabState();
    jsdom.reconfigure({ url: `https://www.bilibili.com/video/${BV}/?p=2` });
    await vi.waitFor(async () => expect((await tabState()).videoId).toBe(`${ID}:p2`), { timeout: 3000 });
    expect((await tabState()).status).not.toBe('live');
    jsdom.reconfigure({ url: `https://www.bilibili.com/video/${BV}/?spm_id_from=333.1007` });
    await vi.waitFor(async () => expect((await tabState()).videoId).toBe(before.videoId), { timeout: 3000 });
  });

  it('turns off with the shortcut, and stops sending pictures', async () => {
    command('toggle-descriptions');
    await vi.waitFor(() => expect(said()).toContain('Descriptions off. No more pictures are sent. Descriptions made so far are saved.'));
    expect(fake.areas.sync.settings.enabled).toBe(false);
    expect((await tabState()).status).toBe('partial');
    expect(document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.progress').hidden).toBe(true);
    const before = sent(MSG.GEN_FRAMES).length;
    // Past the end of a stretch: nothing is sent while descriptions are off.
    await playTo(74);
    expect(sent(MSG.GEN_FRAMES)).toHaveLength(before);
  }, 15000);

  it('says clearly that no descriptions can be made when the picture is protected (cross-origin)', async () => {
    pixels.tainted = true;
    playback.paused = true;
    video.currentTime = 0;
    jsdom.reconfigure({ url: `https://www.bilibili.com/video/${OTHER}/` });
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: `bili:${OTHER}` }), { timeout: 3000 });
    const before = sent(MSG.GEN_FRAMES).length;
    await popupAction('generate');
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ status: 'error', errorCode: 'frames-tainted' }));
    expect(said().at(-1)).toMatch(/^SceneVoice cannot take pictures from this video: .*cross-origin protection/);
    await playTo(14);
    expect(sent(MSG.GEN_FRAMES)).toHaveLength(before);
  }, 15000);

  it('stops and says why when a protected (DRM) video gives only black pictures', async () => {
    pixels.tainted = false;
    pixels.black = true;
    // An earlier test switched descriptions off; pictures are taken only while they are on.
    await chrome.storage.sync.set({ settings: { ...fake.areas.sync.settings, enabled: true } });
    await sleep(50);
    playback.paused = true;
    video.currentTime = 0;
    const DRM = 'BV1Qy411c7Dr';
    jsdom.reconfigure({ url: `https://www.bilibili.com/video/${DRM}/` });
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: `bili:${DRM}` }), { timeout: 3000 });
    await popupAction('generate');
    await vi.waitFor(async () => expect((await tabState()).status).toBe('live'));
    await playTo(16);
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ errorCode: 'frames-protected' }));
    expect(said().at(-1)).toMatch(/^This video is protected \(DRM/);
    expect((await tabState()).status).not.toBe('live');
    pixels.black = false;
  }, 20000);
});
