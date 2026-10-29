import { describe, expect, it, vi } from 'vitest';
import {
  GeminiClient,
  GeminiError,
  buildAskRequest,
  buildScriptRequest,
  chooseModel,
  scriptInstructions,
  outputLimit,
  parseScriptResponse,
  responseText,
  tuningFor,
  usableModels,
} from '../src/shared/gemini.js';

const m = (name, methods = ['generateContent']) => ({ name: `models/${name}`, supportedGenerationMethods: methods });

describe('chooseModel', () => {
  it('prefers the newest stable flash model', () => {
    const models = [m('gemini-2.5-pro'), m('gemini-2.5-flash'), m('gemini-3.5-flash'), m('gemini-3.5-flash-lite'), m('gemini-4-flash-preview'), m('gemini-3.5-flash-image'), m('text-embedding-004', ['embedContent'])];
    expect(chooseModel(models)).toBe('gemini-3.5-flash');
  });
  it('falls back to a preview or pro model', () => {
    expect(chooseModel([m('gemini-3-flash-preview'), m('gemini-2.5-pro')])).toBe('gemini-3-flash-preview');
    expect(chooseModel([m('gemini-2.5-pro')])).toBe('gemini-2.5-pro');
    expect(chooseModel([])).toBe('');
  });
  it('prefers the plain alias over a dated snapshot', () => {
    expect(chooseModel([m('gemini-2.5-flash-001'), m('gemini-2.5-flash')])).toBe('gemini-2.5-flash');
  });
  it('offers the same models it would choose from', () => {
    const models = [m('gemini-2.5-flash'), m('gemini-2.5-computer-use-preview'), m('gemini-2.5-flash-image'), m('gemini-2.0-flash')];
    expect(usableModels(models).map((x) => x.id)).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
  });
});

describe('model tuning', () => {
  it('caps output for old models', () => {
    expect(outputLimit('gemini-2.0-flash')).toBe(8192);
    expect(outputLimit('gemini-2.5-flash')).toBe(32768);
    expect(outputLimit('gemini-3.5-flash')).toBe(32768);
  });
  it('sets thinking per family and leaves Gemini 3 at its default temperature', () => {
    expect(tuningFor('gemini-3.5-flash', 0.4)).toEqual({ thinkingConfig: { thinkingLevel: 'low' } });
    expect(tuningFor('gemini-2.5-flash', 0.4)).toEqual({ thinkingConfig: { thinkingBudget: 1024 }, temperature: 0.4 });
    expect(tuningFor('gemini-2.5-pro', 0.4)).toEqual({ temperature: 0.4 });
    expect(tuningFor('gemini-2.0-flash', 0.4)).toEqual({ temperature: 0.4 });
  });
});

describe('describer instructions', () => {
  const text = scriptInstructions('zh-CN');
  it('follow published audio description practice', () => {
    for (const rule of ['change of place or time', 'first time they appear', 'Who is speaking', 'on-screen text', 'Never describe what can be heard', 'Present tense', 'do not interpret', 'Do not censor']) {
      expect(text).toContain(rule);
    }
  });
  it('leave quiet moments quiet instead of filling every pause', () => {
    expect(text).toMatch(/never describe just to fill a pause/);
    expect(text).toMatch(/There is no quota/);
    expect(text).toMatch(/Music, scenery and other atmospheric passages: let them play/);
    expect(text).toMatch(/empty "cues" list: that is a correct answer/);
    // The old targets asked for a description every 10 to 20 seconds whatever the picture.
    expect(text).not.toMatch(/every 10 to 20 seconds|15 to 40 descriptions|never leave more than 30 seconds|when there is room/);
    // Fast pictures may still be described closely.
    expect(text).toMatch(/as close as 2 seconds apart/);
  });
  it('put on-screen text first, as its own cue, transcribed word for word', () => {
    expect(text.indexOf('Meaningful on-screen text')).toBeLessThan(text.indexOf('Every change of place or time'));
    for (const kind of ['prices', 'phone numbers', 'email and web addresses', 'code', 'menu items', 'chart and graph labels with their numbers']) {
      expect(text).toContain(kind);
    }
    expect(text).toMatch(/"onScreenText" is a transcription: copy the text exactly as written/);
    expect(text).toMatch(/Never translate, summarise, correct or reword it/);
    expect(text).toMatch(/Skip text the viewer already hears/);
    // Translated with the original quoted when it is in another language than the descriptions.
    expect(text).toMatch(/If the text is not in Simplified Chinese, quote the original and add a short translation/);
  });
  it('ask for the transcription in its own field, before the spoken versions', () => {
    const cue = buildScriptRequest({ videoId: 'abcdefghijk', meta: {}, chunk: { start: 0, end: 60 }, duration: 60, characters: [], lang: 'en' }).generationConfig.responseSchema.properties.cues.items;
    expect(cue.properties.onScreenText).toEqual({ type: 'STRING' });
    expect(cue.properties.kind.enum).toEqual(['visual', 'text']);
    expect(cue.required).toContain('onScreenText');
    expect(cue.propertyOrdering.indexOf('onScreenText')).toBeLessThan(cue.propertyOrdering.indexOf('brief'));
  });
  it('ask for the video type in the same answer, so it costs no extra request', () => {
    expect(text).toMatch(/"tutorial": made to teach or explain/);
    expect(text).toMatch(/"entertainment": watched for enjoyment/);
    const schema = buildScriptRequest({ videoId: 'abcdefghijk', meta: {}, chunk: { start: 0, end: 60 }, duration: 60, characters: [], lang: 'en' }).generationConfig.responseSchema;
    expect(schema.properties.videoType).toEqual({ type: 'STRING', enum: ['entertainment', 'tutorial', 'other'] });
    expect(schema.required).toContain('videoType');
    expect(schema.propertyOrdering[0]).toBe('videoType');
  });
});

describe('request builders', () => {
  it('sends the whole video for a single chunk', () => {
    const req = buildScriptRequest({ videoId: 'abcdefghijk', meta: { title: 'T' }, chunk: { start: 0, end: 120 }, duration: 120, characters: [], lang: 'zh-CN' });
    const video = req.contents[0].parts[0];
    expect(video.fileData.fileUri).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    expect(video.videoMetadata).toBeUndefined();
    expect(req.systemInstruction.parts[0].text).toContain('Simplified Chinese');
    expect(req.generationConfig.responseMimeType).toBe('application/json');
  });
  it('clips later chunks and passes known characters', () => {
    const req = buildScriptRequest({ videoId: 'abcdefghijk', meta: {}, chunk: { start: 480, end: 960 }, duration: 2000, characters: [{ label: 'Ann', description: 'red hat' }], lang: 'en' });
    expect(req.contents[0].parts[0].videoMetadata).toEqual({ startOffset: '480s', endOffset: '960s' });
    expect(req.contents[0].parts[1].text).toContain('Ann (red hat)');
  });
  it('builds a short clip around the asked moment', () => {
    const req = buildAskRequest({ videoId: 'abcdefghijk', meta: {}, time: 100, duration: 300, question: 'Who?', nearbyText: '', lang: 'en' });
    expect(req.contents[0].parts[0].videoMetadata).toEqual({ startOffset: '80s', endOffset: '104s' });
    expect(req.systemInstruction.parts[0].text).toContain('Quote any text on screen that bears on the question exactly as written.');
    const early = buildAskRequest({ videoId: 'abcdefghijk', meta: {}, time: 1, duration: 3, question: 'Who?', lang: 'en' });
    expect(early.contents[0].parts[0].videoMetadata).toEqual({ startOffset: '0s', endOffset: '3s' });
  });
});

describe('responses', () => {
  it('reads JSON output and skips thought parts', () => {
    const body = { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"cues":[]}' }] }, finishReason: 'STOP' }] };
    expect(parseScriptResponse(body)).toEqual({ cues: [] });
  });
  it('reports truncation and blocks clearly', () => {
    const cut = { candidates: [{ content: { parts: [{ text: '{"cues":[{"start":1' }] }, finishReason: 'MAX_TOKENS' }] };
    expect(() => parseScriptResponse(cut)).toThrow(/truncated/);
    const onlyThoughts = { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] }, finishReason: 'MAX_TOKENS' }] };
    expect(() => parseScriptResponse(onlyThoughts)).toThrow(/truncated/);
    expect(() => responseText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/blocked/);
    expect(() => responseText({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] })).toThrow(/blocked/);
  });
});

function fakeFetch(responses) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  });
  fn.calls = calls;
  return fn;
}

describe('GeminiClient', () => {
  it('sends the key in a header, never in the URL', async () => {
    const f = fakeFetch([{ status: 200, body: { candidates: [] } }]);
    const c = new GeminiClient({ apiKey: 'SECRET', apiBase: 'https://example.test/', model: 'gemini-x', fetchImpl: f });
    await c.generate({});
    expect(f.calls[0].url).toBe('https://example.test/v1beta/models/gemini-x:generateContent');
    expect(f.calls[0].url).not.toContain('SECRET');
    expect(f.calls[0].init.headers['x-goog-api-key']).toBe('SECRET');
  });

  it('maps HTTP errors to stable codes', async () => {
    const cases = [
      [{ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } }, 'bad-key'],
      [{ status: 404, body: { error: { message: 'models/x is not found' } } }, 'model-not-found'],
      [{ status: 400, body: { error: { message: 'Video is private or unavailable' } } }, 'video-unsupported'],
      [{ status: 403, body: { error: { message: 'User location is not supported for the API use.' } } }, 'forbidden'],
    ];
    for (const [resp, code] of cases) {
      const c = new GeminiClient({ apiKey: 'k', apiBase: 'https://x', model: 'm', fetchImpl: fakeFetch([resp]) });
      await expect(c.generate({}, undefined, { retries: 0 })).rejects.toMatchObject({ code });
    }
  });

  it('retries server errors, then succeeds', async () => {
    vi.useFakeTimers();
    const f = fakeFetch([{ status: 503, body: {} }, { status: 200, body: { ok: 1 } }]);
    const c = new GeminiClient({ apiKey: 'k', apiBase: 'https://x', model: 'm', fetchImpl: f });
    const p = c.generate({});
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('drops thinking settings a model rejects, then succeeds', async () => {
    const f = fakeFetch([
      { status: 400, body: { error: { message: 'Invalid JSON payload received. Unknown name "thinking_config" at generation_config' } } },
      { status: 200, body: { ok: 1 } },
    ]);
    const c = new GeminiClient({ apiKey: 'k', apiBase: 'https://x', model: 'gemini-9-flash', fetchImpl: f });
    await expect(c.generate({ generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, temperature: 1 } })).resolves.toEqual({ ok: 1 });
    expect(JSON.parse(f.calls[1].init.body).generationConfig).toEqual({ temperature: 1 });
  });

  it('requires a key', async () => {
    const c = new GeminiClient({ apiKey: '', apiBase: 'https://x', model: 'm', fetchImpl: fakeFetch([]) });
    await expect(c.generate({})).rejects.toBeInstanceOf(GeminiError);
  });

  it('pages through the model list', async () => {
    const f = fakeFetch([
      { status: 200, body: { models: [m('a')], nextPageToken: 'p2' } },
      { status: 200, body: { models: [m('b')] } },
    ]);
    const c = new GeminiClient({ apiKey: 'k', apiBase: 'https://x', model: '', fetchImpl: f });
    expect((await c.listModels()).map((x) => x.name)).toEqual(['models/a', 'models/b']);
    expect(f.calls[1].url).toContain('pageToken=p2');
  });
});
