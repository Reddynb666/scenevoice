// @vitest-environment jsdom
// The web player (site/play, src/web): the page loaded from its real HTML and
// driven through init() with a fake YouTube player, a fake Gemini, a fake voice
// and in-memory storage. Link parsing, the AI notice, gaps and pause mode, the
// screen reader and the voice never both speaking, status never replacing a
// description, the keys, where the key travels, the Bilibili refusal, the
// language choice, and axe on the page in both languages.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_API_BASE, DEFAULT_API_BASE, SCRIPT_VERSION } from '../src/shared/constants.js';
import { TABLES } from '../scripts/locales.mjs';
import { init } from '../src/web/app.js';
import { chooseLocale, localizeDocument, setLocale, t } from '../src/web/i18n.js';
import { keyAction } from '../src/web/keys.js';
import { parseVideoLink } from '../src/web/link.js';
import { WebSpeech, chunkText } from '../src/web/speech.js';
import { scriptKey } from '../src/web/store.js';
import { loadPage } from '../site/check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'site/play/index.html'), 'utf8');
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const KEY = 'AIzaFakeKeyForTests0000000000000000000';
const VIDEO = 'dQw4w9WgXcQ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Storage in memory. */
function memoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

/** A YT namespace whose Player is ready on the next tick and can be driven by the test. */
function fakeYouTube({ duration = 60, durationAfterPlay = false } = {}) {
  const players = [];
  function Player(el, opts) {
    const p = this;
    p.opts = opts;
    p.time = 0;
    p.state = 5;
    p.rate = 1;
    p.calls = [];
    const iframe = el.ownerDocument.createElement('iframe');
    iframe.setAttribute('src', `${opts.host}/embed/${opts.videoId}`);
    el.replaceWith(iframe);
    p.iframe = iframe;
    p.getIframe = () => iframe;
    p.getCurrentTime = () => p.time;
    p.getPlayerState = () => p.state;
    p.getPlaybackRate = () => p.rate;
    // The real player knows the length only once the video has started (0 before that).
    p.getDuration = () => (durationAfterPlay && !p.calls.includes('play') ? 0 : duration);
    p.getVideoData = () => ({ title: 'A test video', author: 'Tester' });
    p.playVideo = () => {
      p.calls.push('play');
      p.state = 1;
    };
    p.pauseVideo = () => {
      p.calls.push('pause');
      p.state = 2;
    };
    p.seekTo = (s) => {
      p.calls.push(`seek:${s}`);
      p.time = s;
    };
    p.loadVideoById = ({ videoId, startSeconds }) => {
      p.calls.push(`load:${videoId}:${startSeconds}`);
      p.time = startSeconds || 0;
    };
    p.destroy = () => {};
    players.push(p);
    setTimeout(() => opts.events.onReady({ target: p }), 0);
  }
  return { YT: { Player }, players };
}

const CUES = [
  { start: 0.5, gap: 6, kind: 'visual', priority: 1, onScreenText: '', confidence: 'high', brief: 'A dog.', standard: 'A dog runs on a beach.', detailed: 'A small brown dog runs along an empty beach at dawn.' },
  { start: 10, gap: 0.6, kind: 'visual', priority: 2, onScreenText: '', confidence: 'high', brief: 'A woman in a red coat waves from the pier for a long moment.', standard: 'A woman in a red coat on the pier waves slowly towards the boat as it leaves.', detailed: 'A woman in a long red coat stands at the end of the pier and waves slowly towards the boat as it leaves the harbour.' },
  { start: 30, gap: 5, kind: 'text', priority: 1, onScreenText: 'Chapter 2', confidence: 'high', brief: 'Title: Chapter 2.', standard: 'Title: Chapter 2.', detailed: 'Title: Chapter 2.' },
];

/** A Gemini (or relay) that answers the model list, a script and a question, recording every request. */
function fakeGemini({ cues = CUES, fail = null } = {}) {
  const requests = [];
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (fail) throw new TypeError('Failed to fetch');
    if (/\/v1\/devices$/.test(url)) return reply(201, { token: 'svd_0123456789abcdef0123456789abcdef', plan: 'free', allowance: { secondsPerDay: 3600, usedToday: 0 } });
    if (/\/v1beta\/models(\?|$)/.test(url)) return reply(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    if (/:generateContent$/.test(url)) {
      const body = JSON.parse(init.body);
      const ask = body.generationConfig?.responseSchema?.properties?.answer;
      const text = ask ? JSON.stringify({ time: 12, confidence: 'high', answer: 'A man in a blue shirt is speaking.' }) : JSON.stringify({ videoType: 'other', characters: [], cues });
      return reply(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    }
    return reply(404, {});
  };
  return { fetchImpl, requests };
}

/** A speechSynthesis that starts each utterance after 5 ms and ends it 25 ms later. */
function fakeSynth() {
  const spoken = [];
  const synth = {
    spoken,
    speaking: false,
    paused: false,
    cancelled: 0,
    getVoices: () => [{ name: 'Samantha', lang: 'en-US', localService: true }, { name: 'Tingting', lang: 'zh-CN', localService: true }],
    addEventListener() {},
    cancel() {
      this.cancelled += 1;
      this.speaking = false;
    },
    speak(u) {
      spoken.push(u.text);
      setTimeout(() => {
        this.speaking = true;
        u.onstart?.();
        setTimeout(() => {
          this.speaking = false;
          u.onend?.();
        }, 25);
      }, 5);
    },
  };
  function Utterance(text) {
    this.text = text;
  }
  return { synth, Utterance };
}

let app = null;

/** The page from its HTML, with init() run against fakes. */
function openPlayer({ url = '/play/', language = 'en-US', local = memoryStorage(), session = memoryStorage(), gemini = fakeGemini(), yt = fakeYouTube(), speech = null, tickMs = 0 } = {}) {
  app?.destroy();
  window.history.replaceState(null, '', url);
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/g, '');
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  const api = init({ win: window, fetchImpl: gemini.fetchImpl, loadApi: async () => yt.YT, speech: speech || new WebSpeech({ synth: null, Utterance: null }), local, session, version: 'test', tickMs });
  app = { ...api, local, session, gemini, yt };
  return app;
}

const $ = (id) => document.getElementById(id);
const status = () => $('status').textContent;
const description = () => $('description').textContent;

/** Press Play with a link and a key, and wait until the fake Gemini has answered. */
async function play(link = `https://www.youtube.com/watch?v=${VIDEO}`, { key = KEY, remember = false, source = 'own' } = {}) {
  if (source === 'cloud') {
    $('source-cloud').checked = true;
    $('source-cloud').dispatchEvent(new Event('change', { bubbles: true }));
  }
  $('key').value = key;
  $('remember').checked = remember;
  $('link').value = link;
  $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(app.state.script?.complete).toBe(true), { timeout: 3000 });
  return app.yt.players[0];
}

function press(target, key, mods = {}) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
}

afterEach(() => {
  app?.destroy();
  app = null;
});

describe('web player: links', () => {
  it('reads every YouTube link form and a bare id, with the start time', () => {
    const id = { videoId: VIDEO, start: 0 };
    expect(parseVideoLink(`https://www.youtube.com/watch?v=${VIDEO}`)).toEqual(id);
    expect(parseVideoLink(`youtube.com/watch?feature=share&v=${VIDEO}`)).toEqual(id);
    expect(parseVideoLink(`https://m.youtube.com/watch?v=${VIDEO}&t=90`)).toEqual({ videoId: VIDEO, start: 90 });
    expect(parseVideoLink(`https://music.youtube.com/watch?v=${VIDEO}`)).toEqual(id);
    expect(parseVideoLink(`https://youtu.be/${VIDEO}?t=1m30s`)).toEqual({ videoId: VIDEO, start: 90 });
    expect(parseVideoLink(`https://youtu.be/${VIDEO}?si=abc`)).toEqual(id);
    expect(parseVideoLink(`https://www.youtube.com/shorts/${VIDEO}`)).toEqual(id);
    expect(parseVideoLink(`https://www.youtube.com/live/${VIDEO}?feature=share`)).toEqual(id);
    expect(parseVideoLink(`https://www.youtube.com/embed/${VIDEO}?start=1h2m3s`)).toEqual({ videoId: VIDEO, start: 3723 });
    expect(parseVideoLink(`https://www.youtube-nocookie.com/embed/${VIDEO}`)).toEqual(id);
    expect(parseVideoLink(`https://www.youtube.com/v/${VIDEO}`)).toEqual(id);
    expect(parseVideoLink(`https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3D${VIDEO}`)).toEqual(id);
    expect(parseVideoLink(`  ${VIDEO}  `)).toEqual(id);
  });

  it('recognises Bilibili and rejects the rest', () => {
    expect(parseVideoLink('https://www.bilibili.com/video/BV1xx411c7mD')).toEqual({ bilibili: true });
    expect(parseVideoLink('https://b23.tv/abc')).toEqual({ bilibili: true });
    expect(parseVideoLink('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseVideoLink('https://www.youtube.com/channel/UC123')).toBeNull();
    expect(parseVideoLink('https://www.youtube.com/watch?v=tooshort')).toBeNull();
    expect(parseVideoLink('')).toBeNull();
    expect(parseVideoLink('not a link')).toBeNull();
  });

  it('refuses a Bilibili link in plain words and points to the extension, without loading anything', async () => {
    openPlayer();
    $('key').value = KEY;
    $('link').value = 'https://www.bilibili.com/video/BV1xx411c7mD';
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await sleep(50);
    expect(status()).toBe(TABLES.en.web_link_bilibili);
    expect(status()).toMatch(/cannot read Bilibili video yet/);
    expect(app.yt.players).toEqual([]);
    expect(app.gemini.requests).toEqual([]);
  });

  it('asks for a link, then for a key, before anything is sent', async () => {
    openPlayer();
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_link_missing));
    $('link').value = VIDEO;
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_key_missing));
    expect(document.activeElement).toBe($('key'));
    expect(app.gemini.requests).toEqual([]);
  });
});

describe('web player: the key and the token', () => {
  it('sends the key in the x-goog-api-key header only, never in a URL, and keeps it in session storage unless remembered', async () => {
    openPlayer();
    await play();
    expect(app.gemini.requests.length).toBeGreaterThanOrEqual(2);
    for (const r of app.gemini.requests) {
      expect(r.url.startsWith(DEFAULT_API_BASE)).toBe(true);
      expect(r.url).not.toContain(KEY);
      expect(r.headers['x-goog-api-key']).toBe(KEY);
      expect(JSON.stringify(r.body || {})).not.toContain(KEY);
    }
    expect(JSON.stringify(app.local.dump())).not.toContain(KEY);
    expect(app.session.getItem('scenevoice-play-key')).toBe(KEY);
    // The finished script is cached by video, language and script version.
    const cached = JSON.parse(app.local.getItem(scriptKey(VIDEO, 'en')));
    expect(cached.complete).toBe(true);
    expect(cached.version).toBe(SCRIPT_VERSION);
    expect(cached.cues).toHaveLength(3);
    await vi.waitFor(() => expect(status()).toBe(t('web_status_ready', '3')));
  });

  it('remembers the key in local storage only when asked, and moves it back out when unticked', async () => {
    openPlayer();
    await play(VIDEO, { remember: true });
    expect(app.local.getItem('scenevoice-play-key')).toBe(KEY);
    expect(app.session.getItem('scenevoice-play-key')).toBeNull();
    $('remember').checked = false;
    $('remember').dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.local.getItem('scenevoice-play-key')).toBeNull();
    expect(app.session.getItem('scenevoice-play-key')).toBe(KEY);
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_key_forgotten));
  });

  it('a second visit plays from the cache without asking the model, and "Describe again" clears it', async () => {
    const local = memoryStorage();
    openPlayer({ local });
    await play();
    const before = app.gemini.requests.length;
    openPlayer({ local, gemini: fakeGemini() });
    $('key').value = KEY;
    $('link').value = VIDEO;
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(status()).toBe(t('web_status_cached', '3')));
    expect(app.gemini.requests).toEqual([]);
    expect(app.state.script.complete).toBe(true);
    $('describe-again').click();
    await vi.waitFor(() => expect(app.gemini.requests.some((r) => /generateContent/.test(r.url))).toBe(true));
    await vi.waitFor(() => expect(app.state.script?.complete).toBe(true));
    expect(before).toBeGreaterThan(0);
  });

  it('SceneVoice Cloud: a device token from POST /v1/devices (client "web"), kept in local storage and sent in the same header to the relay', async () => {
    openPlayer();
    await play(VIDEO, { key: '', source: 'cloud' });
    const [register, ...rest] = app.gemini.requests;
    expect(register.url).toBe(`${CLOUD_API_BASE}/v1/devices`);
    expect(register.init.method).toBe('POST');
    expect(register.body.client).toBe('web');
    expect(register.headers['x-goog-api-key']).toBeUndefined();
    expect(app.local.getItem('scenevoice-play-device')).toBe('svd_0123456789abcdef0123456789abcdef');
    expect(rest.length).toBeGreaterThan(0);
    for (const r of rest) {
      expect(r.url.startsWith(CLOUD_API_BASE)).toBe(true);
      expect(r.headers['x-goog-api-key']).toBe('svd_0123456789abcdef0123456789abcdef');
      expect(r.url).not.toContain('svd_');
    }
  });

  it('says in one sentence when the relay cannot be reached and points to the own-key choice', async () => {
    openPlayer({ gemini: fakeGemini({ fail: true }) });
    $('source-cloud').checked = true;
    $('source-cloud').dispatchEvent(new Event('change', { bubbles: true }));
    $('link').value = VIDEO;
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_cloud_unreachable), { timeout: 20000 });
    expect(status()).toMatch(/My Gemini key/);
  }, 25000);

  it('preselects the own key and hides the key field only when Cloud is chosen', () => {
    openPlayer();
    expect($('source-own').checked).toBe(true);
    expect($('key-block').hidden).toBe(false);
    $('source-cloud').checked = true;
    $('source-cloud').dispatchEvent(new Event('change', { bubbles: true }));
    expect($('key-block').hidden).toBe(true);
    expect(JSON.parse(app.local.getItem('scenevoice-play-settings')).source).toBe('cloud');
  });
});

describe('web player: playback', () => {
  it('the first description is led by the AI notice; later ones are not', async () => {
    openPlayer();
    const player = await play();
    await vi.waitFor(() => expect(status()).toBe(t('web_status_ready', '3')));
    expect(player.state).toBe(1);
    app.settings.readerSpeed = 3.2;
    app.settings.detail = 'brief';
    player.time = 0.2;
    app.tick();
    player.time = 0.6;
    app.tick();
    await vi.waitFor(() => expect(description()).toBe(`${TABLES.en.ai_notice} A dog.`));
    expect($('description').getAttribute('lang')).toBe('en');
    await sleep(700); // the first description has been read
    player.time = 29.8;
    app.tick(); // a seek: nothing stale fires
    player.time = 30.1;
    app.tick();
    await vi.waitFor(() => expect(description()).toBe('Title: Chapter 2.'));
  });

  it('gaps mode skips a description that does not fit the pause; pause mode pauses the video for it and resumes after', async () => {
    openPlayer();
    const player = await play();
    app.settings.readerSpeed = 3.2;
    player.time = 9.8;
    app.tick();
    player.time = 10.1;
    app.tick();
    await sleep(120);
    expect(description()).toBe(''); // skipped: no version fits 0.1 s of room
    expect(player.calls).not.toContain('pause');

    $('mode').value = 'pause';
    $('mode').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.announce_mode_pause));
    player.time = 9.8;
    app.tick();
    player.time = 10.1;
    app.tick();
    await vi.waitFor(() => expect(description()).toMatch(/A woman in a red coat on the pier/));
    expect(player.calls).toContain('pause');
    expect(player.state).toBe(2);
    await vi.waitFor(() => expect(player.state).toBe(1), { timeout: 5000 });
    expect(player.calls.at(-1)).toBe('play');
  }, 10000);

  it('a status message never replaces a description being read: it waits until the description is done', async () => {
    openPlayer();
    await play();
    app.settings.readerSpeed = 1;
    app.playback.sayManual('A long description of the scene that takes a while to read out loud.');
    await sleep(60);
    expect(description()).toMatch(/A long description/);
    app.output.status('Progress.');
    await sleep(200);
    expect(status()).not.toBe('Progress.');
    expect(description()).toMatch(/A long description/);
    await vi.waitFor(() => expect(status()).toBe('Progress.'), { timeout: 6000 });
    expect(description()).toMatch(/A long description/);
  }, 8000);

  it('with the built-in voice, the live regions are off while it speaks, and the screen reader never gets the same text', async () => {
    const { synth, Utterance } = fakeSynth();
    const speech = new WebSpeech({ synth, Utterance, userAgent: 'Android' });
    openPlayer({ speech });
    await play();
    $('output').value = 'tts';
    $('output').dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.settings.output).toBe('tts');
    const live = () => [$('description').getAttribute('aria-live'), $('status').getAttribute('aria-live')];
    const done = app.playback.sayManual('A dog runs on a beach.');
    expect(live()).toEqual(['off', 'off']);
    expect(synth.spoken.at(-1)).toBe('A dog runs on a beach.');
    app.output.status('Working.');
    await sleep(10);
    expect(live()).toEqual(['off', 'off']); // the status waits, and is not announced by the screen reader
    await done;
    await vi.waitFor(() => expect(synth.spoken.at(-1)).toBe('Working.'));
    expect(live()).toEqual(['off', 'off']); // the voice is saying the status now
    await vi.waitFor(() => expect(live()).toEqual(['polite', 'polite']));
    // Never both: whenever the voice spoke, the regions were off at that moment.
    expect(synth.spoken).toEqual(expect.arrayContaining(['A dog runs on a beach.', 'Working.']));
  });

  it('a voice that never starts falls back to the screen reader and says so', async () => {
    const synth = { spoken: [], getVoices: () => [], addEventListener() {}, cancel() {}, speak(u) { this.spoken.push(u.text); } };
    const speech = new WebSpeech({ synth, Utterance: function (text) { this.text = text; }, userAgent: 'Android' });
    openPlayer({ speech });
    await play();
    $('output').value = 'tts';
    $('output').dispatchEvent(new Event('change', { bubbles: true }));
    app.playback.sayManual('Hello.');
    await vi.waitFor(() => expect(app.settings.output).toBe('screenreader'), { timeout: 6000 });
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_voice_unavailable));
    expect($('description').getAttribute('aria-live')).toBe('polite');
    // The description the voice could not say is not lost: the screen reader gets it.
    await vi.waitFor(() => expect(description()).toBe('Hello.'));
  }, 8000);

  it('Stop keeps a status message that was waiting behind the description', async () => {
    openPlayer();
    await play();
    app.settings.readerSpeed = 1;
    app.playback.sayManual('A long description of the scene that takes a while to read out loud.');
    await sleep(60);
    app.output.status('Descriptions ready: 3.');
    await sleep(100);
    expect(status()).not.toBe('Descriptions ready: 3.');
    app.actions['stop-speaking']();
    await vi.waitFor(() => expect(status()).toMatch(/Descriptions ready: 3\./));
  });

  it('turning descriptions off stops the generation under way; on again carries on from what is saved', async () => {
    openPlayer();
    await play();
    const before = app.gemini.requests.length;
    app.actions.toggle();
    expect(app.state.enabled).toBe(false);
    expect(app.state.generating).toBeNull();
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.status_off));
    app.actions.toggle();
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.status_on));
    // The script was complete: nothing more is asked of the model.
    expect(app.gemini.requests.length).toBe(before);
  });

  it('presses play before asking the player for the length, which the embedded player knows only once the video runs', async () => {
    openPlayer({ yt: fakeYouTube({ durationAfterPlay: true }) });
    const player = await play();
    expect(player.calls[0]).toBe('play');
    expect(app.state.duration).toBe(60);
    expect(app.state.script?.complete).toBe(true);
  });

  it('says the description for the moment already on screen when the first section arrives late', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const gemini = fakeGemini();
    const inner = gemini.fetchImpl;
    gemini.fetchImpl = async (url, init) => {
      if (String(url).includes(':generateContent')) await gate;
      return inner(url, init);
    };
    openPlayer({ gemini, yt: fakeYouTube({ duration: 120 }) });
    $('key').value = KEY;
    $('link').value = `https://www.youtube.com/watch?v=${VIDEO}`;
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(app.yt.players[0]).toBeTruthy());
    const player = app.yt.players[0];
    player.time = 20;
    player.state = 1;
    release();
    await vi.waitFor(() => expect(description()).toMatch(/Earlier: .*red coat/));
    expect(description()).toMatch(/AI-generated audio description follows/);
  });

  it('keeps the reason descriptions failed: D says it again later, and it stays in view under the player', async () => {
    openPlayer({ gemini: fakeGemini({ fail: true }) });
    $('key').value = KEY;
    $('link').value = `https://www.youtube.com/watch?v=${VIDEO}`;
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_error_network), { timeout: 3000 });
    expect($('progress').textContent).toBe(TABLES.en.web_error_network);
    app.actions['play-pause']();
    await vi.waitFor(() => expect(status()).toMatch(/^Paused\.|^Playing\./));
    app.actions['describe-now']();
    await vi.waitFor(() => expect(status()).toBe(`${TABLES.en.web_status_no_descriptions} ${TABLES.en.web_error_network}`));
  });

  it('a second link waits for the player to report the new video before reading its length', async () => {
    openPlayer();
    const player = await play();
    expect(app.state.duration).toBe(60);
    // The player keeps the old video's data for a moment after loadVideoById, as the real one does.
    let loaded = VIDEO;
    player.getVideoData = () => ({ title: 'Next', author: 'Tester', video_id: loaded });
    player.getDuration = () => (loaded === VIDEO ? 60 : 120);
    setTimeout(() => {
      loaded = 'abcdefghijk';
    }, 400);
    $('link').value = 'https://youtu.be/abcdefghijk';
    $('link-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(app.state.duration).toBe(120), { timeout: 3000 });
    expect(player.calls).toContain('load:abcdefghijk:0');
  });

  it('splits long text for the voice at sentence ends into pieces under 180 characters', () => {
    const long = Array.from({ length: 6 }, (_, i) => `Sentence number ${i + 1} is here and it is reasonably long so that it fills the line.`).join(' ');
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(180);
    expect(chunks.join(' ')).toBe(long);
    expect(chunkText('short')).toEqual(['short']);
    expect(chunkText('')).toEqual([]);
  });
});

describe('web player: keys', () => {
  it('maps plain keys only inside the application region and never in a field; Alt+Shift letters anywhere', () => {
    const region = { tagName: 'DIV' };
    const field = { tagName: 'INPUT' };
    const button = { tagName: 'BUTTON' };
    expect(keyAction({ key: ' ' }, { inApplication: true, target: region })).toBe('play-pause');
    expect(keyAction({ key: 'd' }, { inApplication: true, target: region })).toBe('describe-now');
    expect(keyAction({ key: 'R' }, { inApplication: true, target: region })).toBe('repeat-last');
    expect(keyAction({ key: 'a' }, { inApplication: true, target: region })).toBe('ask');
    expect(keyAction({ key: 's' }, { inApplication: true, target: region })).toBe('stop-speaking');
    expect(keyAction({ key: 'm' }, { inApplication: true, target: region })).toBe('cycle-mode');
    expect(keyAction({ key: '?', shiftKey: true }, { inApplication: true, target: region })).toBe('help');
    expect(keyAction({ key: 'ArrowLeft' }, { inApplication: true, target: region })).toBe('back');
    expect(keyAction({ key: 'ArrowRight' }, { inApplication: true, target: region })).toBe('forward');
    expect(keyAction({ key: 'ArrowUp' }, { inApplication: true, target: region })).toBe('speed-up');
    expect(keyAction({ key: 'ArrowDown' }, { inApplication: true, target: region })).toBe('speed-down');
    // Space on a button presses the button; D still describes.
    expect(keyAction({ key: ' ' }, { inApplication: true, target: button })).toBe('');
    expect(keyAction({ key: 'd' }, { inApplication: true, target: button })).toBe('describe-now');
    // Fields keep their keys, inside or outside the region.
    expect(keyAction({ key: 'd' }, { inApplication: true, target: field })).toBe('');
    expect(keyAction({ key: ' ' }, { inApplication: true, target: field })).toBe('');
    expect(keyAction({ key: 'd' }, { inApplication: false, target: region })).toBe('');
    expect(keyAction({ key: 'd', ctrlKey: true }, { inApplication: true, target: region })).toBe('');
    // The extension's letters, anywhere, even in a field.
    expect(keyAction({ key: 'D', altKey: true, shiftKey: true }, { inApplication: false, target: field })).toBe('toggle');
    expect(keyAction({ key: 's', altKey: true, shiftKey: true }, { inApplication: false, target: null })).toBe('describe-now');
    expect(keyAction({ key: 'l', altKey: true, shiftKey: true }, { inApplication: false, target: null })).toBe('repeat-last');
    expect(keyAction({ key: 'q', altKey: true, shiftKey: true }, { inApplication: false, target: null })).toBe('ask');
    expect(keyAction({ key: 'x', altKey: true, shiftKey: true }, { inApplication: false, target: null })).toBe('');
    // A Mac: Option+Shift+D types "Î"; the physical key still counts.
    expect(keyAction({ key: 'Î', code: 'KeyD', altKey: true, shiftKey: true }, { inApplication: false, target: null })).toBe('toggle');
    expect(keyAction({ key: 'Ó', code: 'KeyS', altKey: true, shiftKey: true }, { inApplication: false, target: null })).toBe('describe-now');
  });

  it('on the page: every key press is announced, typing in the fields is left alone, and focus lands on the player after Play', async () => {
    openPlayer();
    const player = await play();
    expect(document.activeElement).toBe($('player-region'));
    expect(player.iframe.getAttribute('tabindex')).toBe('-1');
    expect(player.iframe.getAttribute('title')).toBe('YouTube video');
    const region = $('player-region');
    region.focus();
    press(region, ' ');
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_status_paused));
    expect(player.state).toBe(2);
    press(region, ' ');
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_status_playing));
    player.time = 20;
    press(region, 'ArrowLeft');
    await vi.waitFor(() => expect(status()).toBe(t('web_status_seek_back', '0:15')));
    press(region, 'ArrowRight');
    await vi.waitFor(() => expect(status()).toBe(t('web_status_seek_forward', '0:20')));
    press(region, 'm');
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.announce_mode_pause));
    expect($('mode').value).toBe('pause');
    press(region, 'ArrowUp');
    await vi.waitFor(() => expect(status()).toBe(t('announce_reader_speed', TABLES.en.speed_very_fast)));
    press(region, '?', { shiftKey: true });
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_keys_list));
    press(region, 'r');
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.status_nothing_to_repeat));
    press(region, 'a');
    expect(document.activeElement).toBe($('question'));
    // Typing in the question field: no action, the event is not swallowed.
    const typed = press($('question'), 'd');
    expect(typed.defaultPrevented).toBe(false);
    await sleep(80);
    expect(status()).toBe(TABLES.en.status_nothing_to_repeat);
    const inLink = press($('link'), ' ');
    expect(inLink.defaultPrevented).toBe(false);
    // Alt+Shift+L anywhere, even from the link field.
    press($('link'), 'L', { altKey: true, shiftKey: true });
    await sleep(80);
    expect(status()).toBe(TABLES.en.status_nothing_to_repeat);
    press($('link'), 'D', { altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.status_off));
    press(document.body, 'd', { altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.status_on));
  });

  it('D describes the current moment, S stops speaking, and a question is answered about the moment', async () => {
    openPlayer();
    const player = await play();
    const region = $('player-region');
    player.time = 12;
    press(region, 'd');
    await vi.waitFor(() => expect(description()).toMatch(/A woman in a red coat/));
    press(region, 's');
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.status_stopped));
    expect(description()).toBe('');
    $('question').value = 'Who is speaking?';
    $('ask-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(description()).toBe('At 0:12: A man in a blue shirt is speaking.'));
    const askRequest = app.gemini.requests.at(-1);
    expect(askRequest.headers['x-goog-api-key']).toBe(KEY);
    expect(JSON.stringify(askRequest.body)).toContain('Who is speaking?');
    expect(app.state.history).toHaveLength(1);
    expect(document.activeElement).toBe(region);
  });
});

describe('web player: language', () => {
  it('chooses the language from ?lang=, then the remembered choice, then the browser', () => {
    expect(chooseLocale({ query: 'zh-CN' })).toBe('zh-CN');
    expect(chooseLocale({ query: 'en', stored: 'zh-CN' })).toBe('en');
    expect(chooseLocale({ stored: 'zh-CN', language: 'en-US' })).toBe('zh-CN');
    expect(chooseLocale({ language: 'zh-Hans-CN' })).toBe('zh-CN');
    expect(chooseLocale({ language: 'zh-TW' })).toBe('en');
    expect(chooseLocale({ language: 'fr-FR' })).toBe('en');
    expect(chooseLocale({})).toBe('en');
  });

  it('sets <html lang>, the title and the texts, and the switch link flips and remembers the language', async () => {
    openPlayer({ url: '/play/?lang=zh-CN' });
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.title).toBe(TABLES.zh_CN.web_title);
    expect($('play').textContent).toBe(TABLES.zh_CN.web_play);
    expect($('player-region').getAttribute('aria-label')).toBe(TABLES.zh_CN.web_player_label);
    expect($('key-guide').getAttribute('href')).toBe(TABLES.zh_CN.web_key_guide_url);
    expect($('lang-switch').textContent).toBe('English');
    $('lang-switch').click();
    expect(document.documentElement.lang).toBe('en');
    expect($('play').textContent).toBe(TABLES.en.web_play);
    expect(app.local.getItem('scenevoice-lang')).toBe('en');
    await vi.waitFor(() => expect(status()).toBe(TABLES.en.web_language_now));

    openPlayer({ url: '/play/', language: 'zh-CN' });
    expect(document.documentElement.lang).toBe('zh-CN');
    const local = memoryStorage();
    local.setItem('scenevoice-lang', 'zh-CN');
    openPlayer({ url: '/play/', language: 'en-US', local });
    expect(document.documentElement.lang).toBe('zh-CN');
    openPlayer({ url: '/play/?v=' + VIDEO, language: 'en-US' });
    expect(document.documentElement.lang).toBe('en');
    expect($('link').value).toBe(VIDEO);
  });

  it('every data-i18n key on the page exists in English and Chinese, and t() substitutes placeholders', () => {
    const keys = [...html.matchAll(/data-i18n="([a-z0-9_]+)"/g)].map((m) => m[1]).concat([...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((p) => p.split(':')[1].trim())));
    expect(keys.length).toBeGreaterThan(40);
    for (const k of keys) {
      expect(TABLES.en[k], `en ${k}`).toBeTruthy();
      expect(TABLES.zh_CN[k], `zh_CN ${k}`).toBeTruthy();
    }
    setLocale('zh-CN');
    expect(t('web_status_ready', '7')).toBe(TABLES.zh_CN.web_status_ready.replace('$1', '7'));
    expect(t('no_such_key')).toBe('no_such_key');
    setLocale('en');
  });
});

describe('web player: axe', () => {
  for (const [lang, scheme] of [['en', 'light'], ['en', 'dark'], ['zh-CN', 'light'], ['zh-CN', 'dark']]) {
    it(`passes WCAG 2.2 AA and best practice in ${lang}, ${scheme}`, async () => {
      const dom = loadPage('play/index.html');
      const { window: w } = dom;
      w.matchMedia = (q) => ({ matches: /dark/.test(q) ? scheme === 'dark' : scheme === 'light', media: q, addEventListener() {}, removeEventListener() {} });
      setLocale(lang);
      localizeDocument(w.document);
      setLocale('en');
      expect(w.document.documentElement.lang).toBe(lang);
      w.eval(axeSource);
      const { violations } = await w.axe.run(w.document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout; site/check.mjs checks the tokens for both schemes
        resultTypes: ['violations'],
      });
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    }, 30000);
  }
});
