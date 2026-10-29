import { describe, expect, it, vi } from 'vitest';
import { GeminiError } from '../src/shared/gemini.js';
import { runAsk, runGeneration } from '../src/shared/generation.js';

const cue = (start) => ({ start, gap: 3, kind: 'visual', priority: 1, brief: `b${start}`, standard: `s${start}`, detailed: `d${start}` });
const ok = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const m = (name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });

/** A fake Gemini that answers per section; `fail` decides which calls throw. */
function fakeClient({ model = 'gemini-2.5-flash', models = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-2.0-flash'], fail = () => null, videoType } = {}) {
  const calls = [];
  return {
    model,
    calls,
    listModels: vi.fn(async () => models.map(m)),
    generate: vi.fn(async (body) => {
      const video = body.contents[0].parts[0];
      const start = parseInt(video.videoMetadata?.startOffset || '0', 10);
      const call = { start, ask: !body.generationConfig.responseMimeType };
      calls.push(call);
      const err = fail(call, calls.length);
      if (err) throw err;
      if (call.ask) return ok('A chef holds up a dumpling.');
      return ok(JSON.stringify({ videoType, characters: [], cues: [cue(start + 1), cue(start + 100)] }));
    }),
  };
}

const params = { videoId: 'abcdefghijk', duration: 570, meta: { title: 'T' }, lang: 'en' };

describe('runGeneration', () => {
  it('describes a video in sections and reports progress over the whole video', async () => {
    const client = fakeClient();
    const seen = [];
    const script = await runGeneration({ client, ...params, script: null, onChunk: (sc, info) => seen.push({ ...info, complete: sc.complete, until: sc.completedUntil }) });
    expect(client.calls.map((c) => c.start)).toEqual([0, 300]);
    expect(seen).toEqual([
      { done: 1, total: 2, complete: false, until: 300 },
      { done: 2, total: 2, complete: true, until: 570 },
    ]);
    expect(script.cues.map((c) => c.start)).toEqual([1, 100, 301, 400]);
    expect(script.model).toBe('gemini-2.5-flash');
  });

  it("saves Gemini's video type with the descriptions, from the first section", async () => {
    const seen = [];
    const script = await runGeneration({ client: fakeClient({ videoType: 'tutorial' }), ...params, script: null, onChunk: (sc) => seen.push(sc.videoType) });
    expect(seen).toEqual(['tutorial', 'tutorial']);
    expect(script.videoType).toBe('tutorial');
    expect((await runGeneration({ client: fakeClient({ videoType: 'other' }), ...params, script: null })).videoType).toBe('');
  });

  it('keeps the video type when a section is split in two', async () => {
    let calls = 0;
    const client = fakeClient({
      videoType: 'entertainment',
      fail: () => (calls++ === 0 ? new GeminiError('truncated') : null),
    });
    const script = await runGeneration({ client, ...params, duration: 200, script: null });
    expect(client.calls.length).toBe(3);
    expect(script.videoType).toBe('entertainment');
  });

  it('resumes from the saved section and counts sections from the start of the video', async () => {
    const client = fakeClient();
    const saved = { version: 2, videoId: params.videoId, lang: 'en', duration: 570, cues: [cue(1)], characters: [], completedUntil: 300, complete: false };
    const seen = [];
    const script = await runGeneration({ client, ...params, script: saved, onChunk: (_sc, info) => seen.push(info) });
    expect(client.calls.map((c) => c.start)).toEqual([300]);
    expect(seen).toEqual([{ done: 2, total: 2 }]);
    expect(script.complete).toBe(true);
    expect(script.cues.length).toBe(3);
  });

  it('returns a complete script untouched', async () => {
    const client = fakeClient();
    const saved = { complete: true, cues: [cue(1)], completedUntil: 570 };
    expect(await runGeneration({ client, ...params, script: saved })).toBe(saved);
    expect(client.generate).not.toHaveBeenCalled();
  });

  it('moves to another model when the chosen one stays overloaded', async () => {
    const client = fakeClient({ model: 'gemini-3.8-flash', models: ['gemini-3.8-flash', 'gemini-2.5-flash'], fail: () => (client.model === 'gemini-3.8-flash' ? new GeminiError('server', 'high demand', 503) : null) });
    const switched = [];
    const script = await runGeneration({ client, ...params, script: null, onModel: (...a) => switched.push(a) });
    expect(switched).toEqual([['gemini-2.5-flash', 'server']]);
    expect(client.model).toBe('gemini-2.5-flash');
    expect(script.complete).toBe(true);
    expect(script.model).toBe('gemini-2.5-flash');
    expect(client.calls.length).toBe(3); // one failed, then two sections
  });

  it('replaces a model the key can no longer use', async () => {
    const client = fakeClient({ model: 'gemini-old', models: ['gemini-2.5-flash'], fail: () => (client.model === 'gemini-old' ? new GeminiError('model-not-found', 'gone', 404) : null) });
    const switched = [];
    await runGeneration({ client, ...params, script: null, onModel: (...a) => switched.push(a) });
    expect(switched).toEqual([['gemini-2.5-flash', 'model-not-found']]);
  });

  it('gives up when every model is overloaded', async () => {
    const client = fakeClient({ models: ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-2.0-flash'], fail: () => new GeminiError('server', 'high demand', 503) });
    await expect(runGeneration({ client, ...params, script: null })).rejects.toMatchObject({ code: 'server' });
    expect(client.calls.length).toBe(3); // the chosen model plus two alternatives
  });

  it('does not switch models for errors another model would share', async () => {
    const client = fakeClient({ fail: () => new GeminiError('video-unsupported', 'private') });
    await expect(runGeneration({ client, ...params, script: null })).rejects.toMatchObject({ code: 'video-unsupported' });
    expect(client.calls.length).toBe(1);
  });

  it('splits a section whose output was cut off', async () => {
    const client = fakeClient({ fail: (call) => (call.start === 0 && client.calls.length === 1 ? new GeminiError('truncated') : null) });
    const script = await runGeneration({ client, ...params, script: null });
    expect(client.calls.map((c) => c.start)).toEqual([0, 0, 150, 300]);
    expect(script.cues.map((c) => c.start)).toEqual([1, 100, 151, 250, 301, 400]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const client = fakeClient({ fail: () => (controller.abort(), null) });
    await expect(runGeneration({ client, ...params, script: null, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('picks a model when the client has none', async () => {
    const client = fakeClient({ model: '' });
    await runGeneration({ client, ...params, script: null });
    expect(client.model).toBe('gemini-3.5-flash');
  });
});

describe('runAsk', () => {
  it('returns the trimmed answer', async () => {
    const client = fakeClient();
    expect(await runAsk(client, { ...params, time: 30, question: 'Who?' })).toBe('A chef holds up a dumpling.');
    expect(client.calls[0].ask).toBe(true);
  });
});
