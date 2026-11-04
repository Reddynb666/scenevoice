// The worker in the offscreen document: requests that are not jobs wait their
// turn, two at a time per provider, and every answer carries what it cost.
// The model calls are faked; the worker's own queue and replies are real.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Model calls waiting to be answered by the test, in the order they were made. */
const calls = [];
const hold = (provider) => (p, client, params) => new Promise((resolve, reject) => calls.push({ provider: provider || p, params, resolve, reject }));

vi.mock('../src/shared/describe.js', () => ({
  createClient: (provider, config) => ({ provider, model: config?.model || `${provider}-model` }),
  describeFrames: vi.fn(hold()),
  askFrames: vi.fn(hold()),
  reviseFrames: vi.fn(hold()),
}));
vi.mock('../src/shared/generation.js', () => ({
  runGeneration: vi.fn(() => new Promise(() => {})),
  runAsk: vi.fn((client, params) => new Promise((resolve, reject) => calls.push({ provider: 'gemini', params, resolve, reject }))),
  runRevision: vi.fn((client, params) => new Promise((resolve, reject) => calls.push({ provider: 'gemini', params, resolve, reject }))),
}));

const posted = [];
let seq = 0;

beforeAll(async () => {
  globalThis.self = { postMessage: (m) => posted.push(m) };
  await import('../src/offscreen/worker.js');
});

beforeEach(() => {
  calls.length = 0;
  posted.length = 0;
});

const usage = { input: 3300, output: 240, thinking: 0, requests: 1 };
const send = (data) => {
  const id = (seq += 1);
  self.onmessage({ data: { id, ...data } });
  return id;
};
const reply = (id) => posted.find((m) => m.id === id);
const settle = () => new Promise((r) => setTimeout(r, 0));
const frames = (provider, start) => ({ cmd: 'frames', provider, config: { apiKey: 'k', model: `${provider}-model` }, params: { window: { start, end: start + 12 }, frames: [] } });

describe('requests wait their turn', () => {
  it('runs at most two per provider at once, the rest in order, each provider in its own lane', async () => {
    const ids = [0, 12, 24, 36, 48].map((start) => send(frames('qwen', start)));
    const gemini = send(frames('gemini', 0));
    const ask = send({ cmd: 'ask', mode: 'frames', provider: 'gemini', config: {}, params: { question: 'What?' } });
    await settle();
    // Two Qwen stretches and two Gemini requests are out; three Qwen stretches wait.
    expect(calls.map((c) => [c.provider, c.params.window?.start ?? c.params.question])).toEqual([
      ['qwen', 0],
      ['qwen', 12],
      ['gemini', 0],
      ['gemini', 'What?'],
    ]);
    send({ cmd: 'status' });
    await settle();
    expect(posted.at(-1)).toMatchObject({ jobs: [], inFlight: 4, waiting: 3 });

    // The first answer frees a slot: the next stretch in line goes out, and the answer is passed on with its cost.
    calls[0].resolve({ cues: [{ start: 1 }], characters: [], videoType: '', usage });
    await settle();
    expect(calls.map((c) => c.params.window?.start ?? c.params.question).slice(4)).toEqual([24]);
    expect(reply(ids[0])).toEqual({ id: ids[0], chunk: { cues: [{ start: 1 }], characters: [], videoType: '' }, model: 'qwen-model', usage });
    expect(reply(ids[2])).toBeUndefined();

    // A failure frees its slot too, and is reported as the error it was.
    const err = Object.assign(new Error('rate-limited'), { code: 'rate-limited' });
    const { ApiError } = await import('../src/shared/errors.js');
    calls[1].reject(new ApiError('rate-limited', 'slow down', 429));
    calls[2].reject(err);
    await settle();
    expect(reply(ids[1])).toEqual({ id: ids[1], error: 'rate-limited', detail: 'slow down' });
    expect(reply(gemini)).toEqual({ id: gemini, error: 'unknown', detail: 'rate-limited' });
    expect(calls.map((c) => c.params.window?.start ?? c.params.question).slice(5)).toEqual([36]);

    // Let the rest through, then the document may close: nothing in flight, nothing waiting.
    for (const c of calls) c.resolve({ cues: [], characters: [], videoType: '', usage });
    await settle();
    for (const c of calls) c.resolve({ cues: [], characters: [], videoType: '', usage });
    await settle();
    send({ cmd: 'status' });
    await settle();
    expect(posted.at(-1)).toMatchObject({ inFlight: 0, waiting: 0 });
    expect(reply(ask)).toMatchObject({ id: ask, model: 'gemini-model', usage });
  });

  it('answers a question and a correction about a video link with the model and the cost', async () => {
    const ask = send({ cmd: 'ask', config: { apiKey: 'k', model: 'gemini-2.5-flash' }, params: { question: 'Who?' } });
    const revise = send({ cmd: 'revise', config: { apiKey: 'k', model: 'gemini-2.5-flash' }, params: { cue: { start: 1 } } });
    await settle();
    expect(calls).toHaveLength(2);
    calls[0].resolve({ text: 'At 0:01: a dog.', time: 1, confidence: 'high', usage });
    calls[1].resolve({ cue: null, usage });
    await settle();
    expect(reply(ask)).toEqual({ id: ask, text: 'At 0:01: a dog.', time: 1, confidence: 'high', usage, model: 'gemini-2.5-flash' });
    expect(reply(revise)).toEqual({ id: revise, cue: null, usage, model: 'gemini-2.5-flash' });
  });

  it('passes on when a used-up allowance resets', async () => {
    const { ApiError } = await import('../src/shared/errors.js');
    const id = send(frames('qwen', 0));
    await settle();
    const err = new ApiError('allowance', 'used up', 429);
    err.resetAt = '2026-11-05T00:00:00Z';
    calls[0].reject(err);
    await settle();
    expect(reply(id)).toEqual({ id, error: 'allowance', detail: 'used up', resetAt: '2026-11-05T00:00:00Z' });
  });

  it('passes on what a failed request cost when its reply was billed anyway', async () => {
    const { ApiError } = await import('../src/shared/errors.js');
    const id = send(frames('qwen', 0));
    await settle();
    const err = new ApiError('truncated');
    err.usage = usage;
    calls[0].reject(err);
    await settle();
    expect(reply(id)).toEqual({ id, error: 'truncated', detail: 'truncated', usage });

    // A job too: what it was billed before failing goes on the error event, with the model that answered.
    const { runGeneration } = await import('../src/shared/generation.js');
    const failed = new ApiError('bad-json');
    failed.usage = usage;
    runGeneration.mockRejectedValueOnce(failed);
    send({ cmd: 'start', key: 'v:en', provider: 'gemini', config: { apiKey: 'k', model: 'gemini-2.5-flash' }, params: { videoId: 'v', lang: 'en', duration: 60 } });
    await settle();
    expect(posted.find((m) => m.event === 'error')).toMatchObject({ key: 'v:en', code: 'bad-json', provider: 'gemini', usage, model: 'gemini-2.5-flash' });
  });
});

describe('starting a job past the daily limit', () => {
  const job = (videoId, extra = {}) => ({ cmd: 'start', key: `${videoId}:en`, provider: 'gemini', config: { apiKey: 'k', model: 'gemini-2.5-flash' }, params: { videoId, lang: 'en', duration: 600 }, ...extra });

  it('refuses a new job, and a restart, but tells a tab about the job already running', async () => {
    expect(reply(send(job('limit1')))).toMatchObject({ started: true, done: 0, total: 2 });
    // The same video again once the limit is reached: the tab follows the running job, no refusal.
    expect(reply(send(job('limit1', { newJobsAllowed: false })))).toMatchObject({ already: true, done: 0, total: 2, provider: 'gemini' });
    // Another video, or starting this one over: a new job, refused; the running one is untouched.
    expect(reply(send(job('limit2', { newJobsAllowed: false })))).toEqual({ id: seq, error: 'budget' });
    expect(reply(send(job('limit1', { force: true, newJobsAllowed: false })))).toEqual({ id: seq, error: 'budget' });
    expect(reply(send({ cmd: 'status', key: 'limit1:en' }))).toMatchObject({ status: 'generating' });
    expect(reply(send({ cmd: 'status', key: 'limit2:en' }))).toEqual({ id: seq, status: 'idle' });
    expect(posted.filter((m) => m.event === 'started').map((m) => m.key)).toEqual(['limit1:en']);
    // Only an explicit "no" refuses: an older service worker that does not say is allowed through.
    expect(reply(send(job('limit3')))).toMatchObject({ started: true });
    send({ cmd: 'abort', key: 'limit1:en' });
    send({ cmd: 'abort', key: 'limit3:en' });
  });
});
