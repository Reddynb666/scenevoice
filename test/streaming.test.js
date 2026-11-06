// Streamed answers and model health: Gemini's answer arrives as server-sent
// events and its finished cues are used at once; a model that is overloaded or
// slow just now is skipped by the next choice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_BASE } from '../src/shared/constants.js';
import { GeminiClient, GeminiError, chooseModel, mergeStreamed } from '../src/shared/gemini.js';
import { firstAnswerMs, runGeneration } from '../src/shared/generation.js';
import { ModelHealth, modelHealth } from '../src/shared/modelhealth.js';
import { streamedCues } from '../src/shared/script.js';

const enc = new TextEncoder();
const cue = (start, text = `s${start}`) => ({ start, gap: 3, kind: 'visual', priority: 1, brief: text, standard: text, detailed: text });
const piece = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

/** A fetch answering with server-sent events, one per piece, `gapMs` apart; records the requests. */
function sseFetch(pieces, { gapMs = 5, status = 200, firstDelayMs = 0 } = {}) {
  const calls = [];
  const f = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    if (status !== 200) return new Response(JSON.stringify(pieces), { status, headers: { 'content-type': 'application/json' } });
    const body = new ReadableStream({
      async start(controller) {
        const abort = () => controller.error(new DOMException('aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', abort);
        try {
          await new Promise((r) => setTimeout(r, firstDelayMs));
          for (const p of pieces) {
            if (init?.signal?.aborted) return;
            controller.enqueue(enc.encode(`data: ${JSON.stringify(p)}\r\n\r\n`));
            await new Promise((r) => setTimeout(r, gapMs));
          }
          controller.close();
        } catch {
          /* aborted */
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  f.calls = calls;
  return f;
}

describe('reading cues out of an answer still being written', () => {
  it('returns every finished cue object, ignoring the unfinished one and braces inside strings', () => {
    const text = '{"videoType":"other","characters":[{"label":"A {b}"}],"cues":[{"start":1,"standard":"a } b"},{"start":2,"standard":"q\\"x"},{"start":3,"stand';
    expect(streamedCues(text)).toEqual([{ start: 1, standard: 'a } b' }, { start: 2, standard: 'q"x' }]);
    expect(streamedCues('{"videoType":"other"')).toEqual([]);
    expect(streamedCues('{"cues":[]}')).toEqual([]);
  });
});

describe('a streamed answer', () => {
  it("goes to streamGenerateContent on Google's own address, joins the pieces and reports the text as it grows", async () => {
    const answer = JSON.stringify({ videoType: 'other', characters: [], cues: [cue(1), cue(20)] });
    const cut = [answer.slice(0, 40), answer.slice(40, 90), answer.slice(90)];
    const f = sseFetch([piece(cut[0]), piece(cut[1]), { ...piece(cut[2], { finishReason: 'STOP' }), usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120 } }]);
    const c = new GeminiClient({ apiKey: 'k', apiBase: DEFAULT_API_BASE, model: 'gemini-x', fetchImpl: f });
    const seen = [];
    const body = await c.generate({}, undefined, { onText: (t) => seen.push(t.length) });
    expect(f.calls[0].url).toBe(`${DEFAULT_API_BASE}/v1beta/models/gemini-x:streamGenerateContent?alt=sse`);
    expect(f.calls[0].url).not.toContain('k');
    expect(f.calls[0].init.headers['x-goog-api-key']).toBe('k');
    expect(seen).toEqual([cut[0].length, cut[0].length + cut[1].length, answer.length]);
    expect(body.candidates[0].content.parts[0].text).toBe(answer);
    expect(body.candidates[0].finishReason).toBe('STOP');
    expect(body.usageMetadata).toEqual({ promptTokenCount: 900, candidatesTokenCount: 120 });
  });

  it('does not stream through a relay or a custom address, and reads a plain JSON reply when one comes', async () => {
    expect(new GeminiClient({ apiKey: 'k', apiBase: 'https://api.scenevoice.app', model: 'm' }).stream).toBe(false);
    expect(new GeminiClient({ apiKey: 'k', apiBase: 'https://example.test', model: 'm' }).stream).toBe(false);
    const json = vi.fn(async () => ({ ok: true, status: 200, json: async () => [piece('{"a":'), piece('1}', { finishReason: 'STOP' })] }));
    const c = new GeminiClient({ apiKey: 'k', apiBase: DEFAULT_API_BASE, model: 'm', fetchImpl: json });
    const body = await c.generate({});
    expect(body.candidates[0].content.parts[0].text).toBe('{"a":1}');
  });

  it('turns an HTTP error before the stream into the usual error, and an overloaded model is tried once more at most', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const f = sseFetch({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }, { status: 503 });
      const c = new GeminiClient({ apiKey: 'k', apiBase: DEFAULT_API_BASE, model: 'm', fetchImpl: f });
      const p = c.generate({});
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(3000);
      await expect(p).rejects.toMatchObject({ code: 'server', status: 503 });
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads an error Google sends as plain JSON under an event-stream content type (seen live: a bad key)', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }), { status: 400, headers: { 'content-type': 'text/event-stream' } }));
    const c = new GeminiClient({ apiKey: 'k', apiBase: DEFAULT_API_BASE, model: 'm', fetchImpl: f });
    await expect(c.generate({})).rejects.toMatchObject({ code: 'bad-key', status: 400 });
  });

  it('gives up on an answer that has not begun by the first-answer deadline, and says no answer began', async () => {
    const f = sseFetch([piece('{}')], { firstDelayMs: 400 });
    const c = new GeminiClient({ apiKey: 'k', apiBase: DEFAULT_API_BASE, model: 'm', fetchImpl: f });
    await expect(c.generate({}, undefined, { firstAnswerMs: 100, retries: 0 })).rejects.toMatchObject({ code: 'timeout', noAnswer: true, clientDeadline: true });
    // Once the answer has begun, only a long silence ends it.
    const g = sseFetch([piece('{"a":'), piece('1}')], { gapMs: 50 });
    const d = new GeminiClient({ apiKey: 'k', apiBase: DEFAULT_API_BASE, model: 'm', fetchImpl: g });
    await expect(d.generate({}, undefined, { firstAnswerMs: 1000, timeoutMs: 1000 })).resolves.toMatchObject({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] });
  });

  it('stops reading at the piece with a finish reason, even when the connection stays open', async () => {
    const enc = new TextEncoder();
    const f = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(piece('{"a":1}', { finishReason: 'STOP' }))}\n\n`));
        // never closed: a proxy that keeps the connection open
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const c = new GeminiClient({ apiKey: 'k', apiBase: DEFAULT_API_BASE, model: 'm', fetchImpl: f });
    await expect(c.generate({}, undefined, { timeoutMs: 60000 })).resolves.toMatchObject({ candidates: [{ finishReason: 'STOP' }] });
  });

  it('merges pieces leaving thoughts out and keeping the last usage', () => {
    const out = mergeStreamed([
      { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: '{"x":' }] } }], usageMetadata: { promptTokenCount: 1 } },
      { candidates: [{ content: { parts: [{ text: '2}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 5 } },
    ]);
    expect(out.candidates[0].content.parts[0].text).toBe('{"x":2}');
    expect(out.usageMetadata).toEqual({ promptTokenCount: 1, candidatesTokenCount: 5 });
  });

  it('the first-answer deadline is 45 seconds, longer for long sections', () => {
    expect(firstAnswerMs({ start: 0, end: 60 })).toBe(45000);
    expect(firstAnswerMs({ start: 0, end: 300 })).toBe(90000);
  });
});

describe('model health', () => {
  it('puts a model overloaded or slow just now behind the others, and forgets after a while', () => {
    let now = 1_000_000;
    const h = new ModelHealth(() => now);
    const models = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] }));
    expect(chooseModel(models, h)).toBe('gemini-3.8-flash');
    h.noteOverloaded('gemini-3.8-flash');
    expect(chooseModel(models, h)).toBe('gemini-3.5-flash');
    expect(h.noteSection('gemini-3.5-flash', { ms: 50000, videoSeconds: 60 })).toBe(true);
    expect(chooseModel(models, h)).toBe('gemini-2.5-flash');
    // A fast section clears slowness; time clears an overload.
    expect(h.noteSection('gemini-3.5-flash', { ms: 12000, videoSeconds: 60 })).toBe(false);
    expect(chooseModel(models, h)).toBe('gemini-3.5-flash');
    now += 16 * 60 * 1000;
    expect(chooseModel(models, h)).toBe('gemini-3.8-flash');
    expect(h.speed('gemini-3.5-flash')).toBe(200);
  });
});

/** A client for runGeneration: answers per section, through onText when given; `fail(call)` may throw. */
function streamingClient({ model = 'gemini-3.8-flash', models = ['gemini-3.8-flash', 'gemini-2.5-flash'], fail = () => null, delayMs = 0 } = {}) {
  const calls = [];
  const client = {
    model,
    calls,
    listModels: vi.fn(async () => models.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] }))),
    generate: vi.fn(async (body, signal, opts = {}) => {
      const start = parseInt(body.contents[0].parts[0].videoMetadata?.startOffset || '0', 10);
      calls.push({ start, model: client.model, opts });
      const err = fail({ start, model: client.model });
      if (err) throw err;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const text = JSON.stringify({ videoType: 'other', characters: [], cues: [cue(start + 1), cue(start + 30)] });
      // Two pieces: the first finishes the first cue.
      const firstCueEnd = text.indexOf('}', text.indexOf('"cues"')) + 1;
      opts.onText?.(text.slice(0, firstCueEnd));
      opts.onText?.(text);
      return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    }),
  };
  return client;
}

describe('generation with streamed answers', () => {
  beforeEach(() => modelHealth.clear());
  afterEach(() => modelHealth.clear());

  it('hands over each section\'s cues as they arrive, before the section is saved', async () => {
    const client = streamingClient();
    const events = [];
    await runGeneration({
      client,
      videoId: 'abcdefghijk',
      duration: 570,
      meta: {},
      lang: 'en',
      script: null,
      onPartial: (sc, { from, cues }) => events.push(`partial ${from}: ${cues.map((c) => c.start).join(',')} (script ${sc.cues.length}, until ${sc.completedUntil})`),
      onChunk: (sc) => events.push(`chunk until ${sc.completedUntil}`),
    });
    expect(events).toEqual([
      'partial 0: 1 (script 1, until 0)',
      'partial 0: 1,30 (script 2, until 0)',
      'chunk until 300',
      'partial 300: 301 (script 3, until 300)',
      'partial 300: 301,330 (script 4, until 300)',
      'chunk until 570',
    ]);
    expect(client.calls[0].opts.firstAnswerMs).toBe(90000);
  });

  it('moves to another model when the first never begins to answer, without splitting the section, and skips it next time', async () => {
    const client = streamingClient({
      fail: ({ model }) => {
        if (model !== 'gemini-3.8-flash') return null;
        const err = new GeminiError('timeout', 'no answer');
        err.clientDeadline = true;
        err.noAnswer = true;
        return err;
      },
    });
    const switched = [];
    const script = await runGeneration({ client, videoId: 'abcdefghijk', duration: 570, meta: {}, lang: 'en', script: null, onModel: (m, r) => switched.push([m, r]) });
    expect(switched).toEqual([['gemini-2.5-flash', 'server']]);
    expect(client.calls.map((c) => `${c.model}@${c.start}`)).toEqual(['gemini-3.8-flash@0', 'gemini-2.5-flash@0', 'gemini-2.5-flash@300']);
    expect(script.complete).toBe(true);
    expect(modelHealth.penalty('gemini-3.8-flash')).toBe(2);
    // The next video, in the same sitting, starts on the healthy model.
    const next = streamingClient({ model: '' });
    await runGeneration({ client: next, videoId: 'bcdefghijkl', duration: 100, meta: {}, lang: 'en', script: null });
    expect(next.calls[0].model).toBe('gemini-2.5-flash');
  });

  it('leaves a model slower than the video once, for one with nothing against it', async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const client = streamingClient();
      const generate = client.generate;
      client.generate = vi.fn(async (...a) => {
        now += client.model === 'gemini-3.8-flash' ? 250000 : 20000; // 300 s of video in 250 s: slow
        return generate(...a);
      });
      const switched = [];
      await runGeneration({ client, videoId: 'abcdefghijk', duration: 900, meta: {}, lang: 'en', script: null, onModel: (m, r) => switched.push([m, r]) });
      expect(switched).toEqual([['gemini-2.5-flash', 'slow']]);
      expect(client.calls.map((c) => c.model)).toEqual(['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash']);
    } finally {
      Date.now = realNow;
    }
  });
});
