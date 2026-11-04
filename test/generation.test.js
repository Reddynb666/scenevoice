import { describe, expect, it, vi } from 'vitest';
import { GeminiError } from '../src/shared/gemini.js';
import { modelFamily, runAsk, runGeneration, runRevision } from '../src/shared/generation.js';

const cue = (start) => ({ start, gap: 3, kind: 'visual', priority: 1, brief: `b${start}`, standard: `s${start}`, detailed: `d${start}` });
/** Every fake answer reports the same counts, so totals can be checked: one answer costs `one`. */
const ok = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 10 } });
const one = { input: 1000, output: 100, thinking: 10, requests: 1 };
const m = (name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });

/** Which request this is: a question, a moment described again, or a section of the video. */
function requestKind(body) {
  const props = body.generationConfig.responseSchema?.properties || {};
  if (props.answer) return 'ask';
  return props.videoType ? 'script' : 'revise';
}

/**
 * A fake Gemini that answers per section; `fail` decides which calls throw.
 * `answer` is the JSON answer to a question; `revision` the cues for a moment described again.
 */
function fakeClient({ model = 'gemini-2.5-flash', models = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-2.0-flash'], fail = () => null, videoType, answer, revision } = {}) {
  const calls = [];
  return {
    model,
    calls,
    listModels: vi.fn(async () => models.map(m)),
    generate: vi.fn(async (body) => {
      const video = body.contents[0].parts[0];
      const start = parseInt(video.videoMetadata?.startOffset || '0', 10);
      const kind = requestKind(body);
      const call = { start, ask: kind === 'ask', kind, body };
      calls.push(call);
      const err = fail(call, calls.length);
      if (err) throw err;
      if (kind === 'ask') return ok(answer === undefined ? 'A chef holds up a dumpling.' : JSON.stringify(answer));
      if (kind === 'revise') return ok(JSON.stringify({ cues: revision || [] }));
      return ok(JSON.stringify({ videoType, characters: [], cues: [cue(start + 1), cue(start + 100)] }));
    }),
  };
}

const params = { videoId: 'abcdefghijk', duration: 570, meta: { title: 'T' }, lang: 'en' };

describe('runGeneration', () => {
  it('describes a video in sections and reports progress over the whole video', async () => {
    const client = fakeClient();
    const seen = [];
    const script = await runGeneration({ client, ...params, script: null, onChunk: (sc, info) => seen.push({ ...info, complete: sc.complete, until: sc.completedUntil, total_usage: sc.usage }) });
    expect(client.calls.map((c) => c.start)).toEqual([0, 300]);
    // Each section reports its own cost and length; the script carries the running total.
    expect(seen).toEqual([
      { done: 1, total: 2, complete: false, until: 300, usage: one, seconds: 300, total_usage: one },
      { done: 2, total: 2, complete: true, until: 570, usage: one, seconds: 270, total_usage: { input: 2000, output: 200, thinking: 20, requests: 2 } },
    ]);
    expect(script.cues.map((c) => c.start)).toEqual([1, 100, 301, 400]);
    expect(script.model).toBe('gemini-2.5-flash');
    expect(script.usage).toEqual({ input: 2000, output: 200, thinking: 20, requests: 2 });
  });

  it('adds to the usage a resumed script already has, and counts both halves of a split section', async () => {
    const saved = { version: 2, videoId: params.videoId, lang: 'en', duration: 570, cues: [cue(1)], characters: [], completedUntil: 300, complete: false, usage: { input: 5000, output: 500, thinking: 0, requests: 1 } };
    const resumed = await runGeneration({ client: fakeClient(), ...params, script: saved });
    expect(resumed.usage).toEqual({ input: 6000, output: 600, thinking: 10, requests: 2 });
    // Old scripts have no usage: the first section's is the total.
    const { usage, ...old } = saved;
    expect((await runGeneration({ client: fakeClient(), ...params, script: old })).usage).toEqual(one);

    let calls = 0;
    const client = fakeClient({ fail: () => (calls++ === 0 ? new GeminiError('truncated') : null) });
    const split = await runGeneration({ client, ...params, duration: 200, script: null });
    expect(client.calls.length).toBe(3);
    expect(split.usage).toEqual({ input: 2000, output: 200, thinking: 20, requests: 2 });
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
    const script = await runGeneration({ client, ...params, script: saved, onChunk: (_sc, { done, total }) => seen.push({ done, total }) });
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

  it("moves to another model family once when the day's quota is used up, never to a snapshot of the same one", async () => {
    // The next best model is a dated snapshot of the same family, which shares the used-up quota: it is skipped.
    const client = fakeClient({
      model: 'gemini-3.5-flash',
      models: ['gemini-3.5-flash', 'gemini-3.5-flash-001', 'gemini-3.5-flash-preview-09-25', 'gemini-2.5-flash'],
      fail: () => (modelFamily(client.model) === 'gemini-3.5-flash' ? new GeminiError('quota-daily', 'requests per day', 429) : null),
    });
    const switched = [];
    const script = await runGeneration({ client, ...params, script: null, onModel: (...a) => switched.push(a) });
    expect(switched).toEqual([['gemini-2.5-flash', 'quota-daily']]);
    expect(script.complete).toBe(true);
    expect(client.calls.length).toBe(3);

    // A second family out of quota too: that is where it stops, with the quota error, not a third try.
    const twice = fakeClient({ model: 'gemini-3.5-flash', models: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'], fail: () => new GeminiError('quota-daily', 'requests per day', 429) });
    await expect(runGeneration({ client: twice, ...params, script: null })).rejects.toMatchObject({ code: 'quota-daily' });
    expect(twice.calls.length).toBe(2);
    expect(twice.model).toBe('gemini-2.5-flash');
  });

  it('never switches or retries for a used-up SceneVoice Cloud allowance', async () => {
    const client = fakeClient({ fail: () => new GeminiError('allowance', 'used up', 429) });
    await expect(runGeneration({ client, ...params, script: null })).rejects.toMatchObject({ code: 'allowance' });
    expect(client.calls.length).toBe(1);
    expect(client.listModels).not.toHaveBeenCalled();
  });

  it('knows which model ids share a quota', () => {
    expect(modelFamily('gemini-2.5-flash-001')).toBe('gemini-2.5-flash');
    expect(modelFamily('gemini-2.5-flash-preview-05-20')).toBe('gemini-2.5-flash');
    expect(modelFamily('gemini-2.0-flash-exp')).toBe('gemini-2.0-flash');
    expect(modelFamily('gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite');
    expect(modelFamily('gemini-3.8-flash')).toBe('gemini-3.8-flash');
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

describe('runGeneration and confidence', () => {
  it('says a description is uncertain, and makes it less important, when Gemini is not sure', async () => {
    const client = fakeClient();
    client.generate.mockResolvedValueOnce(
      ok(JSON.stringify({ videoType: 'other', characters: [], cues: [{ ...cue(5), confidence: 'low', brief: '一个男人拿着手机。', standard: '一个男人把手机贴在耳边。', detailed: '看不清，一个男人把手机贴在耳边。' }] })),
    );
    const script = await runGeneration({ client, ...params, duration: 200, lang: 'zh-CN', script: null });
    // Words that already say so are left as they are.
    expect(script.cues[0]).toMatchObject({ confidence: 'low', priority: 2, brief: '不太确定。一个男人拿着手机。', detailed: '看不清，一个男人把手机贴在耳边。' });
  });
});

describe('runAsk', () => {
  it('reads the structured answer: led by the moment it is about, which is kept for jumping there', async () => {
    const client = fakeClient({ answer: { time: 27, confidence: 'high', answer: 'A chef holds up a dumpling.' } });
    expect(await runAsk(client, { ...params, time: 30, question: 'Who?' })).toEqual({ text: 'At 0:27: A chef holds up a dumpling.', time: 27, confidence: 'high', usage: one });
    expect(client.calls[0].ask).toBe(true);
  });

  it('answers in Chinese with "在 m:ss 处", and says when it is not sure', async () => {
    const client = fakeClient({ answer: { time: 95, confidence: 'low', answer: '一位厨师举着一个饺子。' } });
    const res = await runAsk(client, { ...params, lang: 'zh-CN', time: 100, question: '她拿着什么？' });
    expect(res).toEqual({ text: '在 1:35 处：不太确定。一位厨师举着一个饺子。', time: 95, confidence: 'low', usage: one });
  });

  it('still answers, about the moment asked, when the answer comes as plain text', async () => {
    const client = fakeClient();
    expect(await runAsk(client, { ...params, time: 30.6, question: 'Who?' })).toEqual({ text: 'At 0:30: A chef holds up a dumpling.', time: 30, confidence: '', usage: one });
  });
});

describe('runRevision', () => {
  const old = { start: 61.5, gap: 2.5, kind: 'visual', priority: 1, brief: 'A woman smiles.', standard: 'A woman in red smiles at the camera.', detailed: 'x' };
  const revised = (extra = {}) => ({ start: 60, gap: 9, kind: 'visual', priority: 1, onScreenText: '', confidence: 'high', brief: 'A man waves.', standard: 'A man in a grey coat waves.', detailed: 'A man in a grey coat waves from the doorway.', ...extra });

  it('looks again at a short clip around the moment, telling Gemini what was reported', async () => {
    const client = fakeClient({ revision: [revised()] });
    const { cue: cueOut, usage } = await runRevision(client, { ...params, cue: old, characters: [{ label: 'the man in grey' }] });
    const { body } = client.calls[0];
    expect(client.calls[0].kind).toBe('revise');
    expect(body.contents[0].parts[0].videoMetadata).toEqual({ startOffset: '53s', endOffset: '74s' });
    expect(body.contents[0].parts[1].text).toContain('"A woman in red smiles at the camera."');
    expect(body.contents[0].parts[1].text).toContain('the man in grey');
    // Same time and pause as before: only the words were wrong.
    const { onScreenText, ...words } = revised();
    expect(cueOut).toEqual({ ...words, start: 61.5, gap: 2.5, revised: true });
    expect(usage).toEqual(one);
  });

  it('returns null when, looking again, there is nothing to describe', async () => {
    expect(await runRevision(fakeClient({ revision: [] }), { ...params, cue: old })).toEqual({ cue: null, usage: one });
  });

  it('keeps a description Gemini repeats, but says it is not certain', async () => {
    const client = fakeClient({ revision: [revised({ brief: old.brief, standard: old.standard, detailed: old.detailed })] });
    const { cue: cueOut } = await runRevision(client, { ...params, cue: old });
    expect(cueOut).toMatchObject({ confidence: 'low', priority: 2, standard: 'Not certain. A woman in red smiles at the camera.' });
  });

  it('reports a failure', async () => {
    const client = fakeClient({ fail: () => new GeminiError('quota', 'later', 429) });
    await expect(runRevision(client, { ...params, cue: old })).rejects.toMatchObject({ code: 'quota' });
  });
});
