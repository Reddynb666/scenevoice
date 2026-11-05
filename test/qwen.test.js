// Qwen (通义千问) through Model Studio's OpenAI-compatible API, and descriptions
// from frames with Qwen or Gemini. Every request goes to a fake fetch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_QWEN_API_BASE } from '../src/shared/constants.js';
import { askFrames, createClient, describeFrames, reviseFrames } from '../src/shared/describe.js';
import { ApiError } from '../src/shared/errors.js';
import { framesScriptPrompt } from '../src/shared/frames.js';
import { GeminiError } from '../src/shared/gemini.js';
import { QwenClient, buildQwenRequest, classifyQwenHttp, qwenResponseText, qwenUsageOf } from '../src/shared/qwen.js';

const frames = [
  { time: 12.2, data: '/9j/AAA1' },
  { time: 14.2, data: '/9j/AAA2' },
];
const usage = { prompt_tokens: 3300, completion_tokens: 240, total_tokens: 3540 };
const chat = (content, finish = 'stop') => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage });
/** What every answer above cost, as SceneVoice counts it. */
const counted = { input: 3300, output: 240, thinking: 0, requests: 1 };

/** A fetch that answers with `answers` in turn ({status, body}) and records each request. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  });
  fn.calls = calls;
  return fn;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Qwen requests', () => {
  const prompt = framesScriptPrompt({ meta: { title: '宫保鸡丁的做法', channel: '厨师小王' }, window: { start: 12, end: 24 }, duration: 120, lang: 'zh-CN', frames, recent: [{ start: 6, text: '一个男人在切鸡肉。' }] });

  it('sends the instructions and the answer format as the system message, then each frame with its time, as base64 data URLs', () => {
    const body = buildQwenRequest({ ...prompt, model: 'qwen-vl-max' });
    expect(body.model).toBe('qwen-vl-max');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/professional audio describer/);
    expect(body.messages[0].content).toMatch(/Still frames taken from the video/);
    expect(body.messages[0].content).toMatch(/Answer with one JSON object and nothing else.*"videoType".*"cues"/s);
    const content = body.messages[1].content;
    expect(content.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'image_url', 'text']);
    expect(content[0].text).toBe('Frame at 0:12 (12.2 s):');
    expect(content[1].image_url.url).toBe('data:image/jpeg;base64,/9j/AAA1');
    expect(content[4].text).toMatch(/between 0:12 and 0:24 \(12s to 24s\)/);
    expect(content[4].text).toMatch(/Already described just before .*0:06 一个男人在切鸡肉。/);
    expect(content[4].text).toMatch(/Write in Simplified Chinese\./);
    expect(body).not.toHaveProperty('response_format');
    expect(buildQwenRequest({ ...prompt, model: 'm', jsonMode: true }).response_format).toEqual({ type: 'json_object' });
  });

  it('asks for the establishing description at the very start only', () => {
    expect(framesScriptPrompt({ window: { start: 0, end: 12 }, lang: 'en', frames }).text).toMatch(/very start of the video/);
    expect(prompt.text).not.toMatch(/very start of the video/);
  });

  it('reads the reply, and says clearly when it was filtered, cut off or empty', () => {
    expect(qwenResponseText(chat('{"cues": []}'))).toEqual({ text: '{"cues": []}', finishReason: 'stop' });
    expect(qwenResponseText(chat([{ type: 'text', text: '{"a":' }, { text: '1}' }])).text).toBe('{"a":1}');
    expect(qwenResponseText(chat('{"cues": [', 'length')).finishReason).toBe('MAX_TOKENS');
    expect(() => qwenResponseText(chat('', 'content_filter'))).toThrow(expect.objectContaining({ code: 'blocked' }));
    expect(() => qwenResponseText(chat('', 'length'))).toThrow(expect.objectContaining({ code: 'truncated' }));
    expect(() => qwenResponseText({ choices: [] })).toThrow(expect.objectContaining({ code: 'empty-response' }));
  });

  it('turns HTTP errors into the codes SceneVoice explains', () => {
    const code = (status, error) => classifyQwenHttp(status, { error }).code;
    expect(code(401, { message: 'Incorrect API key provided.', code: 'invalid_api_key' })).toBe('bad-key');
    expect(code(400, { message: 'Invalid API-key provided.', code: 'InvalidApiKey' })).toBe('bad-key');
    expect(code(404, { message: 'The model `qwen-x` does not exist', code: 'model_not_found' })).toBe('model-not-found');
    // This minute's limit is retried; the day's quota and the Cloud allowance are not.
    expect(code(429, { message: 'Requests rate limit exceeded' })).toBe('rate-limited');
    expect(code(429, { message: 'Free tier daily quota exhausted', code: 'limit_requests' })).toBe('quota-daily');
    expect(classifyQwenHttp(429, { error: { message: 'allowance used up', code: 'allowance', resetAt: '2026-11-05T00:00:00Z' } })).toMatchObject({ code: 'allowance', resetAt: '2026-11-05T00:00:00Z' });
    expect(code(400, { message: 'Access denied, please make sure your account is in good standing.', code: 'Arrearage' })).toBe('quota');
    expect(code(400, { message: 'Input data may contain inappropriate content.', code: 'data_inspection_failed' })).toBe('blocked');
    expect(code(403, { message: 'Model access denied.' })).toBe('forbidden');
    expect(code(503, { message: 'busy' })).toBe('server');
    expect(code(400, { message: 'something else' })).toBe('request-failed');
    expect(classifyQwenHttp(500, null)).toBeInstanceOf(ApiError);
  });

  it('reads what an answer cost from the usage block', () => {
    expect(qwenUsageOf(chat('x'))).toEqual(counted);
    // DashScope counts reasoning inside completion_tokens; usage.js adds thinking to output, so it is taken out here.
    expect(qwenUsageOf({ usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } } })).toEqual({ input: 10, output: 10, thinking: 20, requests: 1 });
    expect(qwenUsageOf({ usage: { prompt_tokens: 10, completion_tokens: 30 } })).toEqual({ input: 10, output: 30, thinking: 0, requests: 1 });
    // A malformed breakdown larger than the whole never makes the output negative.
    expect(qwenUsageOf({ usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 45 } } })).toEqual({ input: 10, output: 0, thinking: 45, requests: 1 });
    expect(qwenUsageOf({ choices: [] })).toEqual({ input: 0, output: 0, thinking: 0, requests: 1 });
  });
});

describe('QwenClient', () => {
  it('posts to the compatible-mode chat completions address with the key as a bearer token', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: chat('OK') });
    const client = new QwenClient({ apiKey: 'sk-test', fetchImpl });
    await client.test();
    const [call] = fetchImpl.calls;
    expect(call.url).toBe(`${DEFAULT_QWEN_API_BASE}/chat/completions`);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test' });
    expect(call.body).toEqual({ model: 'qwen3-vl-plus', messages: [{ role: 'user', content: 'Reply with: OK' }], max_tokens: 5 });
    // The key is only ever in the header.
    expect(call.url).not.toContain('sk-test');
    expect(call.init.body).not.toContain('sk-test');
  });

  it('uses the address and model from the settings', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: chat('OK') });
    await new QwenClient({ apiKey: 'k', apiBase: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/', model: 'qwen-vl-plus', fetchImpl }).test();
    expect(fetchImpl.calls[0].url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(fetchImpl.calls[0].body.model).toBe('qwen-vl-plus');
  });

  it('needs a key, and reports a refused one', async () => {
    await expect(new QwenClient({ apiKey: '' }).test()).rejects.toMatchObject({ code: 'no-key' });
    const fetchImpl = fakeFetch({ status: 401, body: { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } } });
    await expect(new QwenClient({ apiKey: 'bad', fetchImpl }).test()).rejects.toMatchObject({ code: 'bad-key', status: 401 });
  });

  it('retries an overloaded server, then succeeds', async () => {
    vi.useFakeTimers();
    const fetchImpl = fakeFetch({ status: 503, body: { error: { message: 'busy' } } }, { status: 200, body: chat('fine') });
    const pending = new QwenClient({ apiKey: 'k', fetchImpl }).chat({ model: 'qwen-vl-max', messages: [] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(qwenResponseText(await pending).text).toBe('fine');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries this minute's rate limit after 5 s, but not a used-up daily quota or allowance", async () => {
    vi.useFakeTimers();
    const limited = fakeFetch({ status: 429, body: { error: { message: 'Requests rate limit exceeded' } } }, { status: 200, body: chat('fine') });
    const pending = new QwenClient({ apiKey: 'k', fetchImpl: limited }).chat({ model: 'm', messages: [] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(qwenResponseText(await pending).text).toBe('fine');
    expect(limited).toHaveBeenCalledTimes(2);
    for (const body of [{ error: { message: 'daily quota exhausted' } }, { error: { message: 'x', code: 'allowance' } }]) {
      const fetchImpl = fakeFetch({ status: 429, body }, { status: 200, body: chat('fine') });
      await expect(new QwenClient({ apiKey: 'k', fetchImpl }).chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(ApiError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('drops response_format when the model refuses it', async () => {
    const fetchImpl = fakeFetch({ status: 400, body: { error: { message: "'response_format' is not supported by this model" } } }, { status: 200, body: chat('{}') });
    await new QwenClient({ apiKey: 'k', fetchImpl }).chat({ model: 'm', messages: [], response_format: { type: 'json_object' } }, undefined, { retries: 0 });
    expect(fetchImpl.calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(fetchImpl.calls[1].body).not.toHaveProperty('response_format');
  });

  it('says when the network fails', async () => {
    const fetchImpl = fakeFetch(new TypeError('Failed to fetch'));
    await expect(new QwenClient({ apiKey: 'k', fetchImpl }).chat({ model: 'm', messages: [] }, undefined, { retries: 0 })).rejects.toMatchObject({ code: 'network' });
  });
});

describe('descriptions from frames', () => {
  const params = { meta: { title: 'T' }, window: { start: 12, end: 24 }, duration: 120, lang: 'zh-CN', frames, characters: [], recent: [] };
  const cue = (start, standard, extra = {}) => ({ start, gap: 3, kind: 'visual', priority: 1, onScreenText: '', confidence: 'high', brief: standard, standard, detailed: standard, ...extra });

  it('with Qwen: reads JSON in a code fence, keeps the stretch, and says what is uncertain', async () => {
    const answer = {
      videoType: 'tutorial',
      characters: [{ label: '系围裙的男人', description: '短发' }],
      cues: [cue(12.2, '一个男人把鸡肉切成丁。'), cue(14.2, '锅里有红色的东西。', { confidence: 'low', priority: 2 }), cue(80, '不在这一段。'), cue(13, '屏幕上写着：宫保鸡丁', { kind: 'text', onScreenText: '宫保鸡丁' })],
    };
    const fetchImpl = fakeFetch({ status: 200, body: chat(`好的：\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``) });
    const client = createClient('qwen', { apiKey: 'k', model: 'qwen-vl-max' }, fetchImpl);
    const chunk = await describeFrames('qwen', client, params);
    expect(chunk.videoType).toBe('tutorial');
    expect(chunk.characters).toEqual([{ label: '系围裙的男人', description: '短发' }]);
    expect(chunk.cues.map((c) => [c.start, c.kind, c.standard])).toEqual([
      [12.2, 'visual', '一个男人把鸡肉切成丁。'],
      [13, 'text', '屏幕上写着：宫保鸡丁'],
      [14.2, 'visual', '不太确定。锅里有红色的东西。'],
    ]);
    expect(chunk.cues[2].priority).toBe(3);
    // What the stretch cost comes with it, from the reply's own counts.
    expect(chunk.usage).toEqual(counted);
    const sentBody = fetchImpl.calls[0].body;
    expect(sentBody.messages[1].content.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });

  it('with Qwen: an unreadable or cut-off answer is an error the page can explain', async () => {
    const client = (body) => createClient('qwen', { apiKey: 'k' }, fakeFetch({ status: 200, body }));
    // The reply was billed all the same: the error carries its cost, so the service worker can count it.
    await expect(describeFrames('qwen', client(chat('sorry, I cannot')), params)).rejects.toMatchObject({ code: 'bad-json', usage: counted });
    await expect(describeFrames('qwen', client(chat('{"cues": [{"start": 12', 'length')), params)).rejects.toMatchObject({ code: 'truncated', usage: counted });
  });

  it('with Gemini (Bilibili): frames go as inline JPEGs, with the response schema', async () => {
    const answer = { videoType: 'other', characters: [], cues: [cue(12.2, 'A man dices chicken.')] };
    const fetchImpl = fakeFetch({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] } });
    const client = createClient('gemini', { apiKey: 'g', apiBase: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash' }, fetchImpl);
    const chunk = await describeFrames('gemini', client, { ...params, lang: 'en' });
    expect(chunk.cues.map((c) => c.standard)).toEqual(['A man dices chicken.']);
    expect(chunk.usage).toEqual({ input: 0, output: 0, thinking: 0, requests: 1 });
    const { url, body } = fetchImpl.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    const parts = body.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'Frame at 0:12 (12.2 s):' });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: '/9j/AAA1' } });
    expect(parts.some((p) => p.fileData)).toBe(false);
    expect(body.generationConfig.responseSchema.properties.cues).toBeTruthy();
  });

  it('answers a question about the moment, naming it', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: chat('{"time": 14.2, "confidence": "high", "answer": "盘子里是切好的鸡丁。"}') });
    const client = createClient('qwen', { apiKey: 'k' }, fetchImpl);
    const res = await askFrames('qwen', client, { meta: { title: 'T' }, time: 15, duration: 120, question: '盘子里是什么？', nearbyText: '', lang: 'zh-CN', frames });
    expect(res).toEqual({ text: '在 0:14 处：盘子里是切好的鸡丁。', time: 14, confidence: 'high', usage: counted });
    expect(fetchImpl.calls[0].body.messages[0].content).toMatch(/"time": number, "confidence"/);
  });

  it('describes a marked moment again, at its old time', async () => {
    const old = cue(13, '一个女人在切菜。');
    const fetchImpl = fakeFetch({ status: 200, body: chat(JSON.stringify({ cues: [cue(12.2, '一个男人在切鸡肉。')] })) });
    const { cue: fixed, usage: cost } = await reviseFrames('qwen', createClient('qwen', { apiKey: 'k' }, fetchImpl), { meta: {}, duration: 120, lang: 'zh-CN', cue: old, characters: [], frames });
    expect(fixed).toMatchObject({ start: 13, standard: '一个男人在切鸡肉。', revised: true });
    expect(cost).toEqual(counted);
    expect(fetchImpl.calls[0].body.messages[1].content.at(-1).text).toMatch(/A viewer reported that this description, at 0:13 .* is wrong/);
  });

  it('knows only its two providers', () => {
    expect(() => createClient('other', {})).toThrow(ApiError);
    expect(new GeminiError('quota')).toBeInstanceOf(ApiError);
  });
});
