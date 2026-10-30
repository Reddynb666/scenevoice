import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';

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
/** Answers commands sent to the worker in the offscreen document. */
let worker = () => undefined;
const workerCalls = [];

beforeAll(async () => {
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  globalThis.chrome = {
    storage: {
      local: {
        setAccessLevel: async ({ accessLevel }) => accessLevels.push(accessLevel),
        async get(key) {
          if (key == null) return copy(store);
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) if (k in store) out[k] = copy(store[k]);
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) store[k] = copy(v);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        },
      },
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
