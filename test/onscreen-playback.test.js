// @vitest-environment jsdom
// On-screen text and quiet moments during playback, with the real content
// script: text the dialogue already says is left out, the rest is read word
// for word and is not cut off, and entertainment stays quiet unless the user
// asks for more.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const watchPage = (id, category, captions) =>
  `<html><script>var ytInitialPlayerResponse = {${
    captions ? `"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=${id}\\u0026lang=en","languageCode":"en","kind":"asr"}]}},` : ''
  }"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"},"category":${JSON.stringify(category)}}}};</script></html>`;

const cue = (start, kind, priority, brief, extra = {}) => ({ start, gap: 8, kind, priority, brief, standard: brief, detailed: brief, ...extra });

const DINER = {
  // Also said in the dialogue at 0:03: left out.
  sign: cue(1, 'text', 1, "Sign: JOE'S DINER, OPEN LATE", { onScreenText: "JOE'S DINER / OPEN LATE" }),
  // Not said: read, even with essentials only.
  board: cue(10, 'text', 2, 'Board: Today: pancakes $4.99', { onScreenText: 'Today: pancakes $4.99' }),
  wipe: cue(20, 'visual', 2, 'She wipes the counter.'),
  door: cue(30, 'visual', 1, 'A man in a wet coat walks in.'),
};
const SLIDES = {
  slide: cue(1, 'text', 1, 'Slide: Revenue up 12 percent in 2025', { onScreenText: 'Revenue up 12% in 2025' }),
  nod: cue(2.5, 'visual', 2, 'He nods.'),
  chart: cue(12, 'visual', 1, 'A bar chart fills the screen.'),
};

const script = (videoId, cues) => ({ version: 2, videoId, lang: 'en', duration: 600, cues: Object.values(cues), characters: [], completedUntil: 600, complete: true, model: 'gemini-test' });

const VIDEOS = {
  dinerVideoA: {
    page: watchPage('dinerVideoA', 'Entertainment', true),
    captions: JSON.stringify({ events: [{ tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: "Welcome to Joe's Diner. We're open late." }] }] }),
    script: script('dinerVideoA', DINER),
  },
  slideTalkBB: { page: watchPage('slideTalkBB', '', false), script: script('slideTalkBB', SLIDES) },
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

beforeAll(async () => {
  jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=dinerVideoA' });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>Joe's Diner at night</h1></ytd-watch-metadata>
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
      const v = VIDEOS[u.searchParams.get('v')];
      return { ok: true, text: async () => (u.pathname === '/api/timedtext' ? v?.captions : v?.page) || '' };
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
  Announcer.prototype.announceToScreenReader = function record(text, urgent) {
    spoken.push(text);
    return announce.call(this, text, urgent);
  };
  said = () => spoken;
  await import('../src/content/index.js');
  await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'dinerVideoA', status: 'ready', videoType: 'entertainment' }), { timeout: 3000 });
  await vi.waitFor(() => expect(captionsLoaded('dinerVideoA')).toBe(true), { timeout: 3000 });
  await sleep(100);
});

describe('on-screen text during playback', () => {
  it('leaves out text the dialogue already says, and reads the rest word for word', async () => {
    await playThrough(DINER.sign.start);
    expect(said()).not.toContain(DINER.sign.brief);
    await playThrough(DINER.board.start);
    // Helpful text (priority 2) is read even though entertainment describes only the essentials.
    await vi.waitFor(() => expect(said()).toContain(DINER.board.brief));
  });

  it('keeps entertainment quiet between the essentials, until the user asks for more', async () => {
    // Nothing still being read that the next description would have to wait for.
    command('stop-speaking');
    await playThrough(DINER.wipe.start);
    expect(said()).not.toContain(DINER.wipe.brief);
    await playThrough(DINER.door.start);
    await vi.waitFor(() => expect(said()).toContain(DINER.door.brief));

    // One step on from the essentials this video uses, and the user's own from now on.
    command('cycle-density');
    await vi.waitFor(() => expect(said().at(-1)).toBe('How much to describe: moderate.'));
    await vi.waitFor(() => expect(stored()).toMatchObject({ density: 'standard', densityChosen: true }));
    await playThrough(DINER.wipe.start);
    // The man at the door may still be being described: the wipe (less important) waits for that to end rather than cut it off.
    await vi.waitFor(() => expect(said()).toContain(DINER.wipe.brief), { timeout: 3000 });
  });

  it('reads no on-screen text when that is turned off', async () => {
    await chrome.storage.sync.set({ settings: { ...stored(), onScreenText: false } });
    await sleep(50);
    const before = said().filter((s) => s === DINER.board.brief).length;
    await playThrough(DINER.board.start);
    await sleep(200);
    expect(said().filter((s) => s === DINER.board.brief)).toHaveLength(before);
    await chrome.storage.sync.set({ settings: { ...stored(), onScreenText: true } });
    await sleep(50);
  });

  it('does not cut off on-screen text for a visual description that is no more important', async () => {
    playback.paused = true;
    video.currentTime = 0;
    jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=slideTalkBB' });
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'slideTalkBB', status: 'ready' }), { timeout: 3000 });

    await playThrough(SLIDES.slide.start);
    await vi.waitFor(() => expect(said()).toContain(SLIDES.slide.brief));
    // The nod comes due while the slide is still being read: it waits.
    video.currentTime = SLIDES.nod.start + 0.3;
    await sleep(300);
    expect(said()).not.toContain(SLIDES.nod.brief);

    // Once the slide has been read, the nod is said in the pause that follows, and descriptions carry on as usual.
    await vi.waitFor(() => expect(said()).toContain(SLIDES.nod.brief), { timeout: 3000 });
    await playThrough(SLIDES.chart.start);
    await vi.waitFor(() => expect(said()).toContain(SLIDES.chart.brief));
  });
});
