import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG, SCRIPT_VERSION } from '../src/shared/constants.js';
import { localDay } from '../src/shared/usage.js';

const ID = 'abcdefghijklmnopqrstuvwxyzabcdef';
const ORIGIN = `chrome-extension://${ID}`;
const youtube = {
  id: ID,
  origin: 'https://www.youtube.com',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  tab: { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  frameId: 0,
};
const popup = { id: ID, origin: ORIGIN, url: `${ORIGIN}/popup.html` };
const webPage = { ...youtube, origin: 'https://evil.example', url: 'https://evil.example/', tab: { id: 9, url: 'https://evil.example/' } };

const offscreenPage = { id: ID, origin: ORIGIN, url: `${ORIGIN}/offscreen.html` };

let onMessage;
const speak = vi.fn();
const accessLevels = [];
let installed = [];
/** chrome.storage.local, in memory. */
const store = {};
/** chrome.storage.sync: the synced settings. */
const synced = {};
/** Answers commands sent to the worker in the offscreen document. */
let worker = () => undefined;
const workerCalls = [];

beforeAll(async () => {
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const area = (bag) => ({
    setAccessLevel: async ({ accessLevel }) => accessLevels.push(accessLevel),
    async get(key) {
      if (key == null) return copy(bag);
      const out = {};
      for (const k of Array.isArray(key) ? key : [key]) if (k in bag) out[k] = copy(bag[k]);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) bag[k] = copy(v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete bag[k];
    },
  });
  globalThis.chrome = {
    storage: {
      local: area(store),
      sync: area(synced),
    },
    runtime: {
      id: ID,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => (onMessage = fn) },
      sendMessage: vi.fn(async (msg) => {
        if (msg?.type !== MSG.OFFSCREEN) return undefined;
        workerCalls.push(msg.data);
        return worker(msg.data);
      }),
    },
    commands: { onCommand: { addListener() {} }, getAll: async () => [] },
    tabs: { sendMessage: vi.fn(async () => {}), query: async () => [{ id: 7 }] },
    tts: { speak, stop: vi.fn(), getVoices: async () => installed },
    offscreen: { hasDocument: async () => true, createDocument: async () => {}, closeDocument: async () => {} },
  };
  await import('../src/background/index.js');
});

beforeEach(() => {
  installed = [
    { voiceName: 'Tingting', lang: 'zh-CN' },
    { voiceName: 'Samantha', lang: 'en-US' },
  ];
});

/** Deliver a message the way Chrome does and wait for the reply. */
function deliver(msg, sender) {
  return new Promise((resolve) => {
    const async = onMessage(msg, sender, resolve);
    if (!async) setTimeout(() => resolve(undefined), 20);
  });
}

describe('speaking with the built-in voice', () => {
  it('passes the chosen voice, rate and pitch from the YouTube tab to chrome.tts', async () => {
    const reply = await deliver({ type: MSG.SPEAK, text: '她走进厨房。', lang: 'zh-CN', rate: 1.6, pitch: 0.8, voice: 'Tingting', voiceMustMatch: false, id: 'u1' }, youtube);
    expect(reply).toEqual({ ok: true });
    expect(speak).toHaveBeenCalledTimes(1);
    const [text, opts] = speak.mock.calls[0];
    expect(text).toBe('她走进厨房。');
    expect(opts).toMatchObject({ lang: 'zh-CN', rate: 1.6, pitch: 0.8, voiceName: 'Tingting', enqueue: false });
  });

  it('lets Chrome pick by language when the synced voice is not on this computer', async () => {
    await deliver({ type: MSG.SPEAK, text: 'Hi', lang: 'en', voice: 'Microsoft Zira', id: 'u2' }, youtube);
    expect(speak.mock.calls[0][1]).not.toHaveProperty('voiceName');
    expect(speak.mock.calls[0][1].lang).toBe('en');
  });

  it('does not use the old single voice for a language it does not speak', async () => {
    await deliver({ type: MSG.SPEAK, text: '你好', lang: 'zh-CN', voice: 'Samantha', voiceMustMatch: true, id: 'u3' }, youtube);
    expect(speak.mock.calls[0][1]).not.toHaveProperty('voiceName');
  });

  it('plays the voice test from the popup', async () => {
    await deliver({ type: MSG.SPEAK, text: 'A woman crosses the street.', lang: 'en', rate: 1.2, pitch: 1.3, voice: '', id: 'test' }, popup);
    expect(speak.mock.calls[0][1]).toMatchObject({ rate: 1.2, pitch: 1.3 });
  });

  it('still refuses speech from a page that is not YouTube', async () => {
    const reply = await deliver({ type: MSG.SPEAK, text: 'spoofed', lang: 'en', id: 'x' }, webPage);
    expect(reply).toEqual({ error: 'forbidden' });
    expect(speak).not.toHaveBeenCalled();
  });

  it('still lists voices only for extension pages', async () => {
    expect(await deliver({ type: MSG.GET_VOICES }, youtube)).toEqual({ error: 'forbidden' });
    expect(await deliver({ type: MSG.GET_VOICES }, popup)).toEqual({
      voices: [
        { name: 'Tingting', lang: 'zh-CN' },
        { name: 'Samantha', lang: 'en-US' },
      ],
    });
  });

  it('restricts local storage before answering', () => {
    expect(accessLevels).toEqual(['TRUSTED_CONTEXTS']);
  });
});

describe('a description marked as wrong', () => {
  const VIDEO = 'abcdefghijk';
  const KEY = `script:${VIDEO}:en`;
  const FEEDBACK = `feedback:${VIDEO}:en`;
  const cue = (start, standard, extra = {}) => ({ start, gap: 3, kind: 'visual', priority: 1, brief: standard, standard, detailed: standard, ...extra });
  const saved = () => ({ version: 2, videoId: VIDEO, lang: 'en', duration: 300, cues: [cue(1, 'A door opens.'), cue(10, 'A woman smiles.'), cue(20, 'A dog runs.')], characters: [{ label: 'the man in grey' }], completedUntil: 300, complete: true });
  const fixed = cue(10, 'A man in a grey coat waves.', { gap: 3, confidence: 'high', revised: true });
  const mark = (standard, extra = {}) => ({ type: MSG.REVISE, videoId: VIDEO, lang: 'en', cue: { start: 10, kind: 'visual', standard }, meta: { title: 'Diner' }, duration: 300, ...extra });
  const told = () => chrome.tabs.sendMessage.mock.calls.filter(([, m]) => m.type === MSG.GEN_EVENT && m.event === 'revised');

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    store.local = { apiKey: 'test-key', model: 'gemini-2.5-flash' };
    store[KEY] = saved();
    workerCalls.length = 0;
    chrome.tabs.sendMessage.mockClear();
  });

  it('describes only that moment again, saves the correction and the mark on this computer, and tells the tabs', async () => {
    worker = (data) => (data.cmd === 'revise' ? { cue: fixed } : undefined);
    const reply = await deliver(mark('A woman smiles.'), youtube);
    expect(reply).toEqual({ status: 'revised', cue: fixed });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]).toMatchObject({ cmd: 'revise', config: { apiKey: 'test-key' }, params: { videoId: VIDEO, lang: 'en', duration: 300, meta: { title: 'Diner' }, characters: [{ label: 'the man in grey' }] } });
    expect(workerCalls[0].params.cue).toEqual(saved().cues[1]);

    expect(store[KEY].cues.map((c) => c.standard)).toEqual(['A door opens.', 'A man in a grey coat waves.', 'A dog runs.']);
    expect(store[FEEDBACK]).toEqual([{ at: expect.any(Number), start: 10, kind: 'visual', standard: 'A woman smiles.', status: 'revised', replacement: fixed }]);
    expect(told()).toEqual([[7, { type: MSG.GEN_EVENT, event: 'revised', videoId: VIDEO, lang: 'en' }]]);
  });

  it('keeps the correction when a job still running saves its own copy afterwards', async () => {
    worker = () => ({ cue: fixed });
    await deliver(mark('A woman smiles.'), youtube);
    // The job began before the mark: its copy still has the old description.
    const fromJob = { ...saved(), cues: [...saved().cues, cue(250, 'Steam rises.')], complete: false };
    await deliver({ type: MSG.JOB_EVENT, event: 'chunk', key: `${VIDEO}:en`, videoId: VIDEO, lang: 'en', script: fromJob, done: 1, total: 2 }, offscreenPage);
    expect(store[KEY].cues.map((c) => c.standard)).toEqual(['A door opens.', 'A man in a grey coat waves.', 'A dog runs.', 'Steam rises.']);
    const event = chrome.tabs.sendMessage.mock.calls.find(([, m]) => m.event === 'chunk')[1];
    expect(event).toMatchObject({ type: MSG.GEN_EVENT, cueCount: 4 });
    expect(event).not.toHaveProperty('script');
  });

  it('removes the description when, looking again, there is nothing to describe', async () => {
    worker = () => ({ cue: null });
    expect(await deliver(mark('A woman smiles.'), youtube)).toEqual({ status: 'removed' });
    expect(store[KEY].cues.map((c) => c.standard)).toEqual(['A door opens.', 'A dog runs.']);
    expect(store[FEEDBACK][0]).toMatchObject({ standard: 'A woman smiles.', status: 'removed', replacement: null });
  });

  it('says what went wrong, keeps the mark, and leaves the description as it was', async () => {
    worker = () => ({ error: 'quota', detail: 'later' });
    expect(await deliver(mark('A woman smiles.'), youtube)).toEqual({ error: 'quota', detail: 'later' });
    expect(store[KEY]).toEqual(saved());
    expect(store[FEEDBACK]).toEqual([{ at: expect.any(Number), start: 10, kind: 'visual', standard: 'A woman smiles.', status: 'failed', error: 'quota' }]);
    expect(told()).toEqual([]);
  });

  it('asks nothing for a description that is not saved, or without a key', async () => {
    expect(await deliver(mark('A man smiles.'), youtube)).toEqual({ error: 'cue-not-found' });
    expect(await deliver(mark('A woman smiles.', { videoId: 'zzzzzzzzzzz' }), youtube)).toEqual({ error: 'no-script' });
    store.local = { apiKey: '' };
    expect(await deliver(mark('A woman smiles.'), youtube)).toEqual({ error: 'no-key' });
    expect(workerCalls).toEqual([]);
    expect(store[FEEDBACK]).toBeUndefined();
  });

  it('accepts a mark only from a YouTube tab', async () => {
    expect(await deliver(mark('A woman smiles.'), webPage)).toEqual({ error: 'forbidden' });
    expect(await deliver(mark('A woman smiles.'), popup)).toEqual({ error: 'forbidden' });
    expect(workerCalls).toEqual([]);
    expect(store[KEY]).toEqual(saved());
  });

  it('forgets the marks with the descriptions', async () => {
    worker = () => ({ cue: fixed });
    await deliver(mark('A woman smiles.'), youtube);
    expect(store[FEEDBACK]).toHaveLength(1);
    await deliver({ type: MSG.DELETE_SCRIPT, videoId: VIDEO, lang: 'en' }, youtube);
    expect(store[KEY]).toBeUndefined();
    expect(store[FEEDBACK]).toBeUndefined();

    store[KEY] = saved();
    await deliver(mark('A woman smiles.'), youtube);
    await deliver({ type: MSG.CACHE_CLEAR }, popup);
    expect(Object.keys(store).filter((k) => k.startsWith('script:') || k.startsWith('feedback:'))).toEqual([]);
    expect(store.local.apiKey).toBe('test-key');
  });
});

describe('descriptions from frames (Bilibili, Qwen)', () => {
  const BILI = 'bili:BV1GJ411x7h7';
  const KEY = `script:${BILI}:zh-CN`;
  const bilibili = {
    id: ID,
    origin: 'https://www.bilibili.com',
    url: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
    tab: { id: 12, url: 'https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333' },
    frameId: 0,
  };
  const frame = (time, data = '/9j/AAAA') => ({ time, data });
  const chop = { start: 6, gap: 4, kind: 'visual', priority: 1, brief: 'A man dices chicken.', standard: 'A man dices chicken on a board.', detailed: 'A man dices chicken on a board.' };
  const stretch = (start, end, extra = {}) => ({
    type: MSG.GEN_FRAMES,
    videoId: BILI,
    lang: 'zh-CN',
    duration: 30,
    meta: { title: '宫保鸡丁的做法', channel: '厨师小王', description: '家常菜' },
    window: { start, end },
    frames: [frame(start + 0.2), frame(start + 2.2), frame(start + 4.2)],
    ...extra,
  });

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    store.local = { apiKey: '', qwenApiKey: 'qwen-secret-key', qwenModel: 'qwen-vl-max' };
    workerCalls.length = 0;
    worker = (data) => (data.cmd === 'frames' ? { chunk: { cues: data.params.window.start < 6 ? [chop] : [], characters: [{ label: 'the man in the apron' }], videoType: 'tutorial' }, model: 'qwen-vl-max' } : undefined);
  });

  it('has Qwen describe a stretch with the key from this computer, and saves it as described', async () => {
    const reply = await deliver(stretch(0, 12, { frames: [frame(0.2), frame(2.2), { time: 4, data: 'data:image/jpeg;base64,AAAA' }, { time: NaN, data: 'AAAA' }, frame(6.2)] }), bilibili);
    expect(reply).toEqual({ status: 'ok', cues: [chop], cueCount: 1, completedUntil: 12, complete: false });

    expect(workerCalls).toHaveLength(1);
    const call = workerCalls[0];
    expect(call).toMatchObject({ cmd: 'frames', provider: 'qwen', config: { apiKey: 'qwen-secret-key', model: 'qwen-vl-max' } });
    expect(call.params).toMatchObject({ lang: 'zh-CN', duration: 30, window: { start: 0, end: 12 }, meta: { title: '宫保鸡丁的做法', channel: '厨师小王' } });
    // Only well-formed pictures go on: no data: prefix, a real time.
    expect(call.params.frames).toEqual([frame(0.2), frame(2.2), frame(6.2)]);

    expect(store[KEY]).toMatchObject({ videoId: BILI, mode: 'frames', provider: 'qwen', model: 'qwen-vl-max', covered: [[0, 12]], completedUntil: 12, complete: false, videoType: 'tutorial' });
    expect(store[KEY].cues).toEqual([chop]);

    // The next stretch: the people seen so far and the latest descriptions go with it.
    const next = await deliver(stretch(12, 24), bilibili);
    expect(next).toMatchObject({ status: 'ok', cueCount: 1, completedUntil: 24 });
    expect(workerCalls[1].params.characters).toEqual([{ label: 'the man in the apron' }]);
    expect(workerCalls[1].params.recent).toEqual([{ start: 6, text: chop.standard }]);
    expect(store[KEY].covered).toEqual([[0, 24]]);

    // The last stretch completes the video.
    expect(await deliver(stretch(24, 30), bilibili)).toMatchObject({ status: 'done', complete: true, completedUntil: 30 });
  });

  it('keeps the key out of every reply to the page', async () => {
    const status = await deliver({ type: MSG.GET_STATUS }, bilibili);
    expect(status).toMatchObject({ hasKey: false, keys: { gemini: false, qwen: true } });
    expect(JSON.stringify(status)).not.toContain('qwen-secret-key');
    expect(JSON.stringify(await deliver(stretch(0, 12), bilibili))).not.toContain('qwen-secret-key');
  });

  it('asks for a key when there is none at all, and sends nothing', async () => {
    store.local = { apiKey: '', qwenApiKey: '' };
    expect(await deliver(stretch(0, 12), bilibili)).toEqual({ error: 'no-key' });
    expect(workerCalls).toEqual([]);
  });

  it('describes with Gemini when only the Gemini key is set, rather than ask for a Qwen key', async () => {
    store.local = { apiKey: 'gemini-key' };
    const reply = await deliver(stretch(0, 12), bilibili);
    expect(reply.status).toBe('ok');
    expect(workerCalls[0].provider).toBe('gemini');
    expect(workerCalls[0].config.apiKey).toBe('gemini-key');
    const status = await deliver({ type: MSG.GET_STATUS }, bilibili);
    expect(status.providers).toEqual({ youtube: 'gemini', bilibili: 'gemini' });
    // With a Qwen key only, Qwen describes YouTube too.
    store.local = { qwenApiKey: 'qwen-secret-key' };
    expect((await deliver({ type: MSG.GET_STATUS }, youtube)).providers).toEqual({ youtube: 'qwen', bilibili: 'qwen' });
  });

  it('refuses frames that are not pictures, a page that is not a Bilibili video, and another site’s video id', async () => {
    expect(await deliver(stretch(0, 12, { frames: [{ time: 1, data: '<script>' }] }), bilibili)).toEqual({ error: 'frames-missing' });
    expect(await deliver(stretch(0, 12), webPage)).toEqual({ error: 'forbidden' });
    const home = { ...bilibili, url: 'https://www.bilibili.com/', tab: { id: 12, url: 'https://www.bilibili.com/' } };
    expect(await deliver(stretch(0, 12), home)).toEqual({ error: 'forbidden' });
    const embedded = { ...bilibili, frameId: 3, tab: { id: 13, url: 'https://example.com/' } };
    expect(await deliver(stretch(0, 12), embedded)).toEqual({ error: 'forbidden' });
    expect(await deliver(stretch(0, 12, { videoId: 'abcdefghijk' }), bilibili)).toEqual({ error: 'unknown' });
    expect(workerCalls).toEqual([]);
  });

  it('leaves YouTube with Gemini as it was: no frames there, and no video jobs on Bilibili', async () => {
    store.local = { apiKey: 'gemini-key', qwenApiKey: 'qwen-secret-key' };
    expect(await deliver(stretch(0, 12, { videoId: 'abcdefghijk' }), youtube)).toEqual({ error: 'provider-unsupported' });
    expect(await deliver({ type: MSG.GEN_START, videoId: BILI, duration: 30, meta: {}, lang: 'zh-CN' }, bilibili)).toEqual({ error: 'provider-unsupported' });
    expect(workerCalls).toEqual([]);
  });

  it('answers a question on Bilibili from pictures of the moment, through Qwen', async () => {
    worker = (data) => (data.cmd === 'ask' ? { text: '在 0:12 处：一盘鸡丁。', time: 12 } : undefined);
    const params = { videoId: BILI, meta: { title: 'T' }, time: 12, duration: 30, question: '盘子里是什么？', nearbyText: '', lang: 'zh-CN' };
    expect(await deliver({ type: MSG.ASK, params }, bilibili)).toEqual({ error: 'frames-missing' });
    expect(await deliver({ type: MSG.ASK, params: { ...params, frames: [frame(11.5), frame(12)] } }, bilibili)).toEqual({ text: '在 0:12 处：一盘鸡丁。', time: 12 });
    expect(workerCalls.at(-1)).toMatchObject({ cmd: 'ask', mode: 'frames', provider: 'qwen', params: { question: '盘子里是什么？', frames: [frame(11.5), frame(12)] } });
  });

  it('describes a marked moment again from its pictures', async () => {
    store[KEY] = { version: 2, videoId: BILI, lang: 'zh-CN', duration: 30, cues: [chop], characters: [], covered: [[0, 12]], completedUntil: 12, complete: false, mode: 'frames' };
    const fixed = { ...chop, standard: 'A man slices chicken breast.', revised: true };
    worker = (data) => (data.cmd === 'revise' ? { cue: fixed } : undefined);
    const mark = { type: MSG.REVISE, videoId: BILI, lang: 'zh-CN', cue: { start: 6, kind: 'visual', standard: chop.standard }, meta: { title: 'T' }, duration: 30 };
    expect(await deliver(mark, bilibili)).toEqual({ error: 'frames-missing' });
    expect(await deliver({ ...mark, frames: [frame(5), frame(7)] }, bilibili)).toEqual({ status: 'revised', cue: fixed });
    expect(workerCalls.at(-1)).toMatchObject({ cmd: 'revise', mode: 'frames', provider: 'qwen', params: { frames: [frame(5), frame(7)], cue: chop } });
    expect(store[KEY].cues).toEqual([fixed]);
  });
});

describe('what a page may ask for', () => {
  const bilibili = {
    id: ID,
    origin: 'https://www.bilibili.com',
    url: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
    tab: { id: 21, url: 'https://www.bilibili.com/video/BV1GJ411x7h7/' },
    frameId: 0,
  };

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    store.local = { apiKey: 'gemini-key', qwenApiKey: 'qwen-secret-key' };
    workerCalls.length = 0;
    worker = (data) => (data.cmd === 'start' ? { started: true, done: 0, total: 1, chunkStartedAt: 1, chunkMs: [] } : { status: 'idle' });
  });

  it('starts jobs only for videos of its own site, of a length a video can have', async () => {
    const start = (extra) => deliver({ type: MSG.GEN_START, videoId: 'abcdefghijk', duration: 600, meta: {}, lang: 'en', ...extra }, youtube);
    expect(await start({ videoId: 'bili:BV1GJ411x7h7' })).toEqual({ error: 'unknown' });
    expect(await start({ videoId: 'not a video id' })).toEqual({ error: 'unknown' });
    expect(await start({ lang: 'xx' })).toEqual({ error: 'unknown' });
    expect(await start({ duration: 13 * 3600 })).toEqual({ error: 'unknown' });
    expect(await start({ duration: Number.NaN })).toEqual({ error: 'unknown' });
    expect(workerCalls).toEqual([]);
    expect((await start({})).status).toBe('generating');
  });

  it('shows and deletes saved descriptions of its own site only', async () => {
    store['script:abcdefghijk:en'] = { version: SCRIPT_VERSION, videoId: 'abcdefghijk', lang: 'en', cues: [], complete: true };
    expect((await deliver({ type: MSG.GET_SCRIPT, videoId: 'abcdefghijk', lang: 'en' }, bilibili)).script).toBeNull();
    expect(await deliver({ type: MSG.DELETE_SCRIPT, videoId: 'abcdefghijk', lang: 'en' }, bilibili)).toEqual({ error: 'unknown' });
    expect(store['script:abcdefghijk:en']).toBeTruthy();
    expect((await deliver({ type: MSG.GET_SCRIPT, videoId: 'abcdefghijk', lang: 'en' }, youtube)).script).toBeTruthy();
    expect(await deliver({ type: MSG.GEN_STATUS, videoId: 'abcdefghijk', lang: 'en' }, bilibili)).toEqual({ status: 'idle' });
    expect(await deliver({ type: MSG.GEN_STOP, videoId: 'abcdefghijk', lang: 'en' }, bilibili)).toEqual({ stopped: false });
  });

  it('opens the settings page at the key field the site needs', async () => {
    const created = [];
    chrome.tabs.create = vi.fn(async (opts) => created.push(opts.url));
    chrome.runtime.getURL = (path) => `${ORIGIN}/${path}`;
    chrome.runtime.openOptionsPage = vi.fn(async () => {});
    expect(await deliver({ type: MSG.OPEN_OPTIONS, provider: 'qwen' }, bilibili)).toEqual({ ok: true });
    expect(created).toEqual([`${ORIGIN}/options.html#qwen`]);
    await deliver({ type: MSG.OPEN_OPTIONS }, youtube);
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    // Nothing but a provider name steers it.
    await deliver({ type: MSG.OPEN_OPTIONS, provider: 'javascript:alert(1)' }, youtube);
    expect(created).toHaveLength(1);
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(2);
  });

  it('turns away a page that sends frames faster than a video plays', async () => {
    worker = () => ({ chunk: { cues: [], characters: [] }, model: 'qwen3-vl-plus' });
    const tab = { ...bilibili, tab: { id: 99, url: bilibili.url } };
    const stretch = (n) => ({ type: MSG.GEN_FRAMES, videoId: 'bili:BV1GJ411x7h7', lang: 'zh-CN', duration: 3000, meta: {}, window: { start: n * 12, end: n * 12 + 12 }, frames: [{ time: n * 12 + 1, data: '/9j/AAAA' }] });
    const replies = [];
    for (let n = 0; n < 31; n += 1) replies.push(await deliver(stretch(n), tab));
    expect(replies.slice(0, 30).every((r) => r.status === 'ok')).toBe(true);
    expect(replies[30]).toEqual({ error: 'busy' });
  });
});

describe('usage counted on this computer, and the daily limit', () => {
  const BILI = 'bili:BV1GJ411x7h7';
  const bilibili = { id: ID, origin: 'https://www.bilibili.com', url: `https://www.bilibili.com/video/BV1GJ411x7h7/`, tab: { id: 31, url: `https://www.bilibili.com/video/BV1GJ411x7h7/` }, frameId: 0 };
  const chop = { start: 6, gap: 4, kind: 'visual', priority: 1, brief: 'A man dices chicken.', standard: 'A man dices chicken.', detailed: 'A man dices chicken.' };
  const stretch = (start, end) => ({ type: MSG.GEN_FRAMES, videoId: BILI, lang: 'zh-CN', duration: 60, meta: {}, window: { start, end }, frames: [{ time: start + 1, data: '/9j/AAAA' }] });
  const qwenUsage = { input: 3300, output: 240, thinking: 0, requests: 1 };
  const geminiUsage = { input: 90000, output: 2000, thinking: 500, requests: 1 };
  const today = () => store.usage;

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    for (const k of Object.keys(synced)) delete synced[k];
    store.local = { apiKey: 'gemini-key', qwenApiKey: 'qwen-secret-key', qwenModel: 'qwen3-vl-plus', model: 'gemini-2.5-flash' };
    workerCalls.length = 0;
    worker = (data) => {
      if (data.cmd === 'frames') return { chunk: { cues: [chop], characters: [], videoType: '' }, model: 'qwen3-vl-plus', usage: qwenUsage };
      if (data.cmd === 'ask') return { text: 'At 0:12: a plate.', time: 12, confidence: 'high', usage: geminiUsage, model: 'gemini-2.5-flash' };
      if (data.cmd === 'revise') return { cue: null, usage: geminiUsage, model: 'gemini-2.5-flash' };
      // The worker refuses a new job past the limit, as the real one does (worker.test.js).
      if (data.cmd === 'start') return data.newJobsAllowed === false ? { error: 'budget' } : { started: true, done: 0, total: 1, chunkStartedAt: 1, chunkMs: [] };
      return { status: 'idle' };
    };
  });

  it('adds every stretch, section, question and correction to today’s counter, per provider, with its length when known', async () => {
    expect(await deliver(stretch(0, 12), bilibili)).toMatchObject({ status: 'ok' });
    expect(today()).toMatchObject({ gemini: { requests: 0 }, qwen: { input: 3300, output: 240, requests: 1, seconds: 12 } });
    expect(today().qwen.cost).toBeCloseTo(0.0057, 6);
    expect(store[`script:${BILI}:zh-CN`].usage).toEqual(qwenUsage);

    // A section of a YouTube video, from the job's event: Gemini's row, the section's own length.
    const script = { version: 2, videoId: 'abcdefghijk', lang: 'en', duration: 570, cues: [], characters: [], completedUntil: 300, complete: false, model: 'gemini-2.5-flash', usage: geminiUsage };
    await deliver({ type: MSG.JOB_EVENT, event: 'chunk', key: 'abcdefghijk:en', videoId: 'abcdefghijk', lang: 'en', script, model: 'gemini-2.5-flash', usage: geminiUsage, seconds: 300, done: 1, total: 2 }, offscreenPage);
    expect(today().gemini).toMatchObject({ input: 90000, output: 2500, requests: 1, seconds: 300 });
    expect(today().gemini.cost).toBeCloseTo(0.03325, 6);
    // The tabs hear about the section, not about the tokens.
    const event = chrome.tabs.sendMessage.mock.calls.at(-1)[1];
    expect(event).toMatchObject({ event: 'chunk', cueCount: 0 });
    expect(event).not.toHaveProperty('usage');

    // A question and a correction: counted at their clip length (askClip(12, 60) is 0..16, revisionClip(6, 60) is 0..18),
    // not at the tokens a video link costs, and the counts kept out of the tab's reply.
    const answer = await deliver({ type: MSG.ASK, params: { videoId: 'abcdefghijk', meta: {}, time: 12, duration: 60, question: 'What?', nearbyText: '', lang: 'en' } }, youtube);
    expect(answer).toEqual({ text: 'At 0:12: a plate.', time: 12, confidence: 'high' });
    expect(today().gemini).toMatchObject({ requests: 2, seconds: 300 + 16 });
    store['script:abcdefghijk:en'] = { ...script, cues: [chop], complete: true };
    const fixed = await deliver({ type: MSG.REVISE, videoId: 'abcdefghijk', lang: 'en', cue: { start: 6, kind: 'visual', standard: chop.standard }, meta: {}, duration: 60 }, youtube);
    expect(fixed).toEqual({ status: 'removed' });
    expect(today().gemini).toMatchObject({ requests: 3, seconds: 300 + 16 + 18 });
    // A question from pictures (Qwen on Bilibili) is counted on that model's row, at the stretch the pictures span.
    const pictures = [12.4, 16, 20, 24.6].map((time) => ({ time, data: '/9j/AAAA' }));
    expect((await deliver({ type: MSG.ASK, params: { videoId: BILI, meta: {}, time: 25, duration: 60, question: 'What?', nearbyText: '', lang: 'zh-CN', frames: pictures } }, bilibili)).text).toBe('At 0:12: a plate.');
    expect(today().qwen).toMatchObject({ requests: 2, seconds: 12 + 13 });

    // A job that failed after a billed reply it could not read: counted too, on the row of the model that answered.
    await deliver({ type: MSG.JOB_EVENT, event: 'error', key: 'abcdefghijk:en', videoId: 'abcdefghijk', lang: 'en', provider: 'gemini', code: 'truncated', detail: '', usage: geminiUsage, model: 'gemini-2.5-flash' }, offscreenPage);
    expect(today().gemini).toMatchObject({ requests: 4, input: 4 * 90000 });
    expect(chrome.tabs.sendMessage.mock.calls.at(-1)[1]).not.toHaveProperty('usage');
    // A stretch whose reply was billed but unreadable: the cost comes back with the error and is counted.
    worker = () => ({ error: 'truncated', detail: '', usage: qwenUsage });
    expect(await deliver(stretch(12, 24), bilibili)).toMatchObject({ error: 'truncated' });
    expect(today().qwen).toMatchObject({ requests: 3, input: 3300 + 90000 + 3300 });
  });

  it('refuses new jobs and stretches once the daily limit is reached, and still answers questions', async () => {
    const usual = worker;
    synced.settings = { dailyBudgetSeconds: 1800 };
    store.usage = { day: localDay(), gemini: { input: 1, output: 1, requests: 2, seconds: 1500, cost: 0 }, qwen: { input: 1, output: 1, requests: 1, seconds: 288, cost: 0 }, cloud: { input: 0, output: 0, requests: 0, seconds: 0, cost: 0 } };
    // 1788 seconds so far: one more stretch is allowed and takes it over the limit.
    expect(await deliver(stretch(0, 12), bilibili)).toMatchObject({ status: 'ok' });
    expect(await deliver(stretch(12, 24), bilibili)).toEqual({ error: 'budget' });
    const startVideo = (extra = {}) => deliver({ type: MSG.GEN_START, videoId: 'abcdefghijk', duration: 600, meta: {}, lang: 'en', ...extra }, youtube);
    expect(await startVideo()).toEqual({ error: 'budget' });
    // The worker is asked, told that no new job may start: only it knows whether this video's job is still running.
    expect(workerCalls.filter((c) => c.cmd === 'start').map((c) => c.newJobsAllowed)).toEqual([false]);
    // No offscreen document, no running job: refused without opening one.
    workerCalls.length = 0;
    chrome.offscreen.hasDocument = async () => false;
    expect(await startVideo()).toEqual({ error: 'budget' });
    expect(workerCalls).toEqual([]);
    chrome.offscreen.hasDocument = async () => true;
    // A job for this video still running past the limit: the tab follows it instead of hearing the limit stopped it.
    const running = { already: true, done: 6, total: 12, chunkStartedAt: 1, chunkMs: [300], provider: 'gemini' };
    worker = (data) => (data.cmd === 'start' ? (data.newJobsAllowed === false && !data.force ? running : { error: 'budget' }) : { status: 'idle' });
    expect(await startVideo()).toEqual({ status: 'generating', already: true, done: 6, total: 12, chunkStartedAt: 1, chunkMs: [300] });
    // Starting over would be a new job: refused.
    expect(await startVideo({ force: true })).toEqual({ error: 'budget' });
    worker = usual;
    expect((await deliver({ type: MSG.ASK, params: { videoId: 'abcdefghijk', meta: {}, time: 12, duration: 60, question: 'What?', nearbyText: '', lang: 'en' } }, youtube)).text).toBe('At 0:12: a plate.');
    // No limit, or a higher one: on it goes.
    synced.settings = { dailyBudgetSeconds: 3600 };
    expect((await deliver({ type: MSG.GEN_START, videoId: 'abcdefghijk', duration: 600, meta: {}, lang: 'en' }, youtube)).status).toBe('generating');
    synced.settings = {};
    expect(await deliver(stretch(24, 36), bilibili)).toMatchObject({ status: 'ok' });
  });

  it('starts the counter again on a new day', async () => {
    synced.settings = { dailyBudgetSeconds: 1800 };
    store.usage = { day: '2020-01-01', gemini: { input: 1, output: 1, requests: 2, seconds: 99999, cost: 0 } };
    expect(await deliver(stretch(0, 12), bilibili)).toMatchObject({ status: 'ok' });
    expect(today()).toMatchObject({ gemini: { seconds: 0 }, qwen: { seconds: 12, requests: 1 } });
    expect(today().day).not.toBe('2020-01-01');
  });

  it('passes on when a used-up allowance resets, and keeps the key out of it', async () => {
    worker = () => ({ error: 'allowance', detail: 'used up', resetAt: '2026-11-05T00:00:00Z' });
    expect(await deliver(stretch(0, 12), bilibili)).toEqual({ error: 'allowance', detail: 'used up', resetAt: '2026-11-05T00:00:00Z' });
    expect(today()).toBeUndefined();
  });
});

describe('SceneVoice Cloud: the token where the key goes, and the shared cache', () => {
  const VIDEO = 'abcdefghijk';
  const KEY = `script:${VIDEO}:en`;
  const TOKEN = `svd_${'0123456789abcdef'.repeat(2)}`;
  const CLOUD = 'https://api.scenevoice.app';
  const cue = (start, standard, extra = {}) => ({ start, gap: 3, kind: 'visual', priority: 1, onScreenText: '', confidence: 'high', brief: standard, standard, detailed: standard, ...extra });
  const shared = (extra = {}) => ({ version: SCRIPT_VERSION, videoId: VIDEO, lang: 'en', duration: 600, cues: [cue(1, 'A door opens.')], characters: [], videoType: 'other', model: 'gemini-2.5-flash', completedUntil: 600, complete: true, source: 'cloud', ...extra });
  const start = (extra = {}) => deliver({ type: MSG.GEN_START, videoId: VIDEO, duration: 600, meta: { title: 'Diner' }, lang: 'en', ...extra }, youtube);
  const calls = (cmd) => workerCalls.filter((c) => c.cmd === cmd);

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    for (const k of Object.keys(synced)) delete synced[k];
    store.local = { cloudToken: TOKEN, cloudPlan: 'free' };
    workerCalls.length = 0;
    chrome.tabs.sendMessage.mockClear();
    worker = (data) => {
      if (data.cmd === 'cloud-get') return { script: null };
      if (data.cmd === 'cloud-put') return { ok: true };
      if (data.cmd === 'start') return { started: true, done: 0, total: 2, chunkStartedAt: 1, chunkMs: [], provider: data.provider };
      return { status: 'idle' };
    };
  });

  it('tells the pages only that a token exists, and that Cloud describes both sites', async () => {
    const status = await deliver({ type: MSG.GET_STATUS }, youtube);
    expect(status).toMatchObject({ hasKey: false, keys: { gemini: false, qwen: false, cloud: true }, providers: { youtube: 'cloud', bilibili: 'cloud' } });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(await deliver({ type: MSG.GET_STATUS }, popup))).not.toContain(TOKEN);
  });

  it('asks the shared cache first, then starts the video job through the relay with the token in place of the key', async () => {
    expect(await start()).toMatchObject({ status: 'generating', total: 2 });
    expect(workerCalls.map((c) => c.cmd)).toEqual(['cloud-get', 'start']);
    expect(workerCalls[0]).toMatchObject({ config: { apiKey: TOKEN, apiBase: CLOUD }, params: { videoId: VIDEO, lang: 'en' } });
    expect(workerCalls[1]).toMatchObject({ provider: 'cloud', config: { apiKey: TOKEN, apiBase: CLOUD, model: '' }, params: { videoId: VIDEO, duration: 600, lang: 'en' } });
    // A model picked through the relay is kept with the token.
    store.local = { cloudToken: TOKEN, cloudModel: 'gemini-2.5-flash-lite' };
    await start();
    expect(calls('start').at(-1).config).toEqual({ apiKey: TOKEN, apiBase: CLOUD, model: 'gemini-2.5-flash-lite' });
  });

  it('loads what another SceneVoice user had described instead of starting a job, and keeps only a script that checks out', async () => {
    worker = (data) => (data.cmd === 'cloud-get' ? { script: shared({ revised: true }) } : { status: 'idle' });
    expect(await start()).toEqual({ status: 'ready', fromCloud: true });
    expect(calls('start')).toEqual([]);
    expect(store[KEY]).toMatchObject({ videoId: VIDEO, lang: 'en', provider: 'cloud', source: 'cloud', complete: true, cues: [cue(1, 'A door opens.')] });
    expect(store[KEY]).not.toHaveProperty('revised');
    // Saved, so the tab reads it like any script of its own.
    expect((await deliver({ type: MSG.GET_SCRIPT, videoId: VIDEO, lang: 'en' }, youtube)).script.cues).toHaveLength(1);

    // Another video's script, an older version, an unfinished one, or one for a different length: ignored, and the job starts.
    for (const wrong of [shared({ videoId: 'zzzzzzzzzzz' }), shared({ version: SCRIPT_VERSION - 1 }), shared({ complete: false }), shared({ duration: 1200 }), { cues: 'x' }]) {
      delete store[KEY];
      workerCalls.length = 0;
      worker = (data) => (data.cmd === 'cloud-get' ? { script: wrong } : data.cmd === 'start' ? { started: true, done: 0, total: 2, chunkStartedAt: 1, chunkMs: [] } : { status: 'idle' });
      expect((await start()).status).toBe('generating');
      expect(store[KEY]).toBeUndefined();
      expect(workerCalls.map((c) => c.cmd)).toEqual(['cloud-get', 'start']);
    }
    // A relay that cannot be reached is not an error: the job starts as it would without the cache.
    workerCalls.length = 0;
    worker = (data) => (data.cmd === 'cloud-get' ? { error: 'network' } : data.cmd === 'start' ? { started: true, done: 0, total: 2, chunkStartedAt: 1, chunkMs: [] } : { status: 'idle' });
    expect((await start()).status).toBe('generating');
  });

  it('closes the offscreen document a minute after a cache hit, as after any other request', async () => {
    vi.useFakeTimers();
    const closeDocument = vi.fn(async () => {});
    const usual = chrome.offscreen.closeDocument;
    chrome.offscreen.closeDocument = closeDocument;
    try {
      // The document is opened for the lookup only: no job starts, so nothing else would close it.
      worker = (data) => (data.cmd === 'cloud-get' ? { script: shared() } : { jobs: [], inFlight: 0, waiting: 0 });
      expect(await start()).toEqual({ status: 'ready', fromCloud: true });
      expect(closeDocument).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60000);
      expect(closeDocument).toHaveBeenCalledTimes(1);
    } finally {
      chrome.offscreen.closeDocument = usual;
      vi.useRealTimers();
    }
  });

  it('keeps a model the relay switched to out of the Gemini key’s own setting', async () => {
    store.local = { apiKey: 'k', model: 'gemini-2.5-pro', cloudToken: TOKEN };
    const switched = (provider, reason = 'model-not-found') => deliver({ type: MSG.JOB_EVENT, event: 'model', key: `${VIDEO}:en`, videoId: VIDEO, lang: 'en', provider, model: 'gemini-2.5-flash-lite', reason }, offscreenPage);
    // A Cloud job's model is the relay's choice: nothing of it is written down here.
    await switched('cloud');
    expect(store.local).toEqual({ apiKey: 'k', model: 'gemini-2.5-pro', cloudToken: TOKEN });
    // The tabs still hear about the switch.
    expect(chrome.tabs.sendMessage.mock.calls.at(-1)[1]).toMatchObject({ event: 'model', model: 'gemini-2.5-flash-lite', reason: 'model-not-found' });
    // The listener's own Gemini key: a model it cannot use any more is replaced for good, an overloaded one only skipped.
    await switched('gemini', 'server');
    expect(store.local.model).toBe('gemini-2.5-pro');
    await switched('gemini');
    expect(store.local.model).toBe('gemini-2.5-flash-lite');
  });

  it('leaves the cache alone when the listener regenerates, and with a key of their own', async () => {
    await start({ force: true });
    expect(workerCalls.map((c) => c.cmd)).toEqual(['start']);
    workerCalls.length = 0;
    store.local = { apiKey: 'gemini-key' };
    await start();
    expect(workerCalls.map((c) => c.cmd)).toEqual(['start']);
    expect(workerCalls[0]).toMatchObject({ provider: 'gemini', config: { apiKey: 'gemini-key' } });
    expect(JSON.stringify(workerCalls)).not.toContain(CLOUD);
  });

  it('shares a finished script, stripped of anything about this computer, only while sharing is on and only from Cloud jobs', async () => {
    synced.settings = { shareDescriptions: true };
    const usage = { input: 60000, output: 1500, thinking: 0, requests: 1 };
    const finished = { ...shared(), cues: [cue(1, 'A door opens.', { revised: true }), cue(20, 'A dog runs.')], usage, createdAt: 5 };
    delete finished.source;
    const done = (provider) => deliver({ type: MSG.JOB_EVENT, event: 'done', key: `${VIDEO}:en`, videoId: VIDEO, lang: 'en', provider, script: finished, model: 'gemini-2.5-flash', usage, seconds: 300, done: 2, total: 2 }, offscreenPage);
    // While the job ran, the listener marked the dog as wrong and had the door described again (PRIVACY.md: neither wrong description is shared).
    store[`feedback:${VIDEO}:en`] = [
      { at: 1, start: 20, kind: 'visual', standard: 'A dog runs.', status: 'removed', replacement: null },
      { at: 2, start: 1, kind: 'visual', standard: 'A door opens.', status: 'revised', replacement: cue(1, 'A door closes.', { revised: true }) },
    ];

    await done('cloud');
    await vi.waitFor(() => expect(calls('cloud-put')).toHaveLength(1));
    const put = calls('cloud-put')[0];
    expect(put).toMatchObject({ config: { apiKey: TOKEN, apiBase: CLOUD }, params: { videoId: VIDEO, lang: 'en' } });
    expect(Object.keys(put.params.script).sort()).toEqual(['characters', 'complete', 'completedUntil', 'cues', 'duration', 'lang', 'model', 'usage', 'version', 'videoId', 'videoType']);
    // The corrected script goes out: the removed cue gone, the correction in place of the wrong one, without the local mark.
    expect(put.params.script.cues).toEqual([cue(1, 'A door closes.')]);
    expect(JSON.stringify(put.params.script)).not.toMatch(/revised|createdAt|provider|updatedAt|A door opens|A dog runs/);
    // Saved here as Cloud's, and counted on Cloud's row, not Gemini's.
    expect(store[KEY]).toMatchObject({ provider: 'cloud', complete: true });
    expect(store.usage.cloud).toMatchObject({ requests: 1, seconds: 300, input: 60000, cost: 0 });
    expect(store.usage.gemini.requests).toBe(0);
    // The tabs hear "done", not the token.
    const event = chrome.tabs.sendMessage.mock.calls.find(([, m]) => m.event === 'done')[1];
    expect(JSON.stringify(event)).not.toContain(TOKEN);

    // Sharing off: nothing is sent.
    workerCalls.length = 0;
    synced.settings = { shareDescriptions: false };
    await done('cloud');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls('cloud-put')).toEqual([]);

    // A Gemini job with the listener's own key: never shared, whatever the switch says.
    synced.settings = { shareDescriptions: true };
    await done('gemini');
    await done(undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls('cloud-put')).toEqual([]);
    expect(store[KEY].provider).toBe('gemini');
    expect(store.usage.gemini.requests).toBe(2);
  });

  it('opens the settings page at the Cloud block when Cloud is what is missing', async () => {
    const created = [];
    chrome.tabs.create = vi.fn(async (opts) => created.push(opts.url));
    chrome.runtime.getURL = (path) => `${ORIGIN}/${path}`;
    expect(await deliver({ type: MSG.OPEN_OPTIONS, provider: 'cloud' }, youtube)).toEqual({ ok: true });
    expect(created).toEqual([`${ORIGIN}/options.html#cloud`]);
    // With no token, Cloud chosen and no key: the tab is told so in Cloud's words (no-key with provider cloud).
    store.local = {};
    synced.settings = { youtubeProvider: 'cloud' };
    expect(await start()).toEqual({ error: 'no-key' });
    expect((await deliver({ type: MSG.GET_STATUS }, youtube)).providers.youtube).toBe('cloud');
  });
});
