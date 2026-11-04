import { describe, expect, it } from 'vitest';
import { handle } from '../src/worker.js';
import { BASE, DASHSCOPE_KEY, UPSTREAM_KEY, call, geminiAnswer, makeEnv, makeFetch, register, setPlan } from './helpers.js';

const GEN = '/v1beta/models/gemini-2.5-flash:generateContent';
const QWEN = '/compatible-mode/v1/chat/completions';
const prompt = { contents: [{ parts: [{ text: 'describe' }] }] };

describe('Gemini proxy: generateContent', () => {
  it('forwards to Gemini with the server key in the header, charges ceil(tokens/100) and adds headers', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(1234) }));
    const res = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(geminiAnswer(1234));
    expect(res.headers.get('x-scenevoice-plan')).toBe('free');
    expect(res.headers.get('x-scenevoice-used-today')).toBe('13');
    expect(res.headers.get('x-scenevoice-seconds-per-day')).toBe('3600');
    expect(res.headers.get('x-scenevoice-resets-at')).toBe('2026-11-05T00:00:00.000Z');
    // What the upstream saw: the server's key in the header, never in the address; the body unchanged.
    expect(fetch.calls).toHaveLength(1);
    const [up] = fetch.calls;
    expect(up.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(up.init.headers['x-goog-api-key']).toBe(UPSTREAM_KEY);
    expect(up.url).not.toContain(UPSTREAM_KEY);
    expect(new TextDecoder().decode(up.init.body)).toBe(JSON.stringify(prompt));
    expect(up.init.signal).toBeInstanceOf(AbortSignal);
    // The usage record expires on its own.
    expect(await env.USAGE.get(`${token}:2026-11-04`)).toBe('13');
  });

  it('adds up charges over a day and refuses with the documented 429 once the allowance is used up', async () => {
    const env = makeEnv({ FREE_SECONDS_PER_DAY: '20' });
    const token = await register(env);
    // 1500 prompt tokens and the fixture's 10 output tokens at weight 5: ceil(1550 / 100).
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(1500) }));
    const first = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(first.headers.get('x-scenevoice-used-today')).toBe('16');
    const second = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-scenevoice-used-today')).toBe('32');
    const third = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'SceneVoice allowance for today is used up',
        details: [{ reason: 'SCENEVOICE_ALLOWANCE', resetsAt: '2026-11-05T00:00:00.000Z', plan: 'free' }],
      },
    });
    expect(third.headers.get('x-scenevoice-used-today')).toBe('32');
    // Nothing was forwarded for the refused call.
    expect(fetch.calls).toHaveLength(2);
    // The next UTC day starts fresh.
    const tomorrow = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch, now: Date.parse('2026-11-05T00:00:01Z') });
    expect(tomorrow.status).toBe(200);
    expect(tomorrow.headers.get('x-scenevoice-used-today')).toBe('16');
    expect(tomorrow.headers.get('x-scenevoice-resets-at')).toBe('2026-11-06T00:00:00.000Z');
  });

  it('charges output and thinking tokens at OUTPUT_TOKEN_WEIGHT, so a long answer to a short prompt is not free', async () => {
    const env = makeEnv();
    const token = await register(env);
    const long = { candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 65000, totalTokenCount: 65020 } };
    const res = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch: makeFetch(() => ({ status: 200, body: long })) });
    expect(res.status).toBe(200);
    // ceil((20 + 5 * 65000) / 100)
    expect(res.headers.get('x-scenevoice-used-today')).toBe('3251');
    // Thinking tokens are output too; a custom weight applies to both.
    const weighted = makeEnv({ OUTPUT_TOKEN_WEIGHT: '8' });
    const token2 = await register(weighted);
    const thinking = { candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 450 } };
    const res2 = await call(weighted, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token2 }, body: prompt, fetch: makeFetch(() => ({ status: 200, body: thinking })) });
    // ceil((100 + 8 * 500) / 100)
    expect(res2.headers.get('x-scenevoice-used-today')).toBe('41');
    // An answer with a prompt count but no output count is charged for the prompt alone.
    const inputOnly = { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 250 } };
    const res3 = await call(weighted, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token2 }, body: prompt, fetch: makeFetch(() => ({ status: 200, body: inputOnly })) });
    expect(res3.headers.get('x-scenevoice-used-today')).toBe('44');
  });

  it('refuses more than REQUESTS_PER_MINUTE calls from one token in a minute with a retryable 429, forwarding nothing', async () => {
    const env = makeEnv({ REQUESTS_PER_MINUTE: '2' });
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(100) }));
    const at = Date.parse('2026-11-04T10:00:05Z');
    expect((await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch, now: at })).status).toBe(200);
    expect((await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch, now: at + 1000 })).status).toBe(200);
    const third = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch, now: at + 2000 });
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error.details[0].reason).toBe('SCENEVOICE_RATE_LIMIT');
    expect(body.error.details[1]).toEqual({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '60s' });
    expect(third.headers.get('retry-after')).toBe('60');
    expect(fetch.calls).toHaveLength(2);
    expect(env.USAGE.ttls.get(`rpm:${token}:${Math.floor(at / 60000)}`)).toBe(120);
    // The next minute is open again; another token is not affected.
    expect((await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch, now: at + 60_000 })).status).toBe(200);
    const other = await register(env, { ip: '198.51.100.9' });
    expect((await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': other }, body: prompt, fetch, now: at + 2000 })).status).toBe(200);
    // The same limit in OpenAI shape on the Qwen route.
    const qwenEnv = makeEnv({ REQUESTS_PER_MINUTE: '1' });
    const qtoken = await register(qwenEnv);
    const qbody = { model: 'qwen3-vl-plus', messages: [] };
    const qfetch = makeFetch(() => ({ status: 200, body: { usage: { prompt_tokens: 100, completion_tokens: 0 } } }));
    expect((await call(qwenEnv, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${qtoken}` }, body: qbody, fetch: qfetch })).status).toBe(200);
    const limited = await call(qwenEnv, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${qtoken}` }, body: qbody, fetch: qfetch });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.type).toBe('scenevoice_rate_limit');
    expect(qfetch.calls).toHaveLength(1);
  });

  it('passes upstream errors through unchanged and charges nothing for them', async () => {
    const env = makeEnv();
    const token = await register(env);
    const upstreamError = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
    const fetch = makeFetch(() => ({ status: 429, body: upstreamError }));
    const res = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(upstreamError);
    expect(res.headers.get('x-scenevoice-used-today')).toBe('0');
    const bad = makeFetch(() => ({ status: 400, body: { error: { code: 400, message: 'Invalid JSON payload', status: 'INVALID_ARGUMENT' } } }));
    const res400 = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch: bad });
    expect(res400.status).toBe(400);
    expect((await res400.json()).error.message).toBe('Invalid JSON payload');
    expect(await env.USAGE.get(`${token}:2026-11-04`)).toBeNull();
  });

  it('answers 502 or 504 in Gemini shape when the upstream is unreachable or times out, charging nothing', async () => {
    const env = makeEnv();
    const token = await register(env);
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch: down });
    expect(res.status).toBe(502);
    expect((await res.json()).error.status).toBe('UNAVAILABLE');
    const slow = async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    };
    const res2 = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch: slow });
    expect(res2.status).toBe(504);
    expect((await res2.json()).error.status).toBe('DEADLINE_EXCEEDED');
    expect(await env.USAGE.get(`${token}:2026-11-04`)).toBeNull();
  });

  it('charges a flat amount when a successful answer carries no token count', async () => {
    const env = makeEnv({ UNMETERED_RESPONSE_SECONDS: '90' });
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: 'data: {"not":"json"}\n\n', headers: { 'content-type': 'text/event-stream' } }));
    const res = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-scenevoice-used-today')).toBe('90');
  });

  it('refuses a free device a model outside FREE_MODELS with a 404, without forwarding', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(100) }));
    const res = await call(env, { method: 'POST', path: '/v1beta/models/gemini-2.5-pro:generateContent', headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(res.status).toBe(404);
    expect((await res.json()).error.details[0].reason).toBe('SCENEVOICE_MODEL_NOT_ALLOWED');
    expect(fetch.calls).toHaveLength(0);
    // A plus device may use it.
    await setPlan(env, token, 'plus');
    const ok = await call(env, { method: 'POST', path: '/v1beta/models/gemini-2.5-pro:generateContent', headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-scenevoice-plan')).toBe('plus');
    expect(ok.headers.get('x-scenevoice-seconds-per-day')).toBe('21600');
  });

  it('keeps picture, speech and audio variants of the flash family off the free plan, whatever FREE_MODELS says', async () => {
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(100) }));
    const refused = ['gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-2.0-flash-exp-image-generation', 'gemini-2.5-flash-native-audio-preview-09-2025', 'gemini-2.5-flash-live-001', 'gemini-2.5-flash-8b'];
    const allowed = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite-preview', 'gemini-2.5-flash-preview-05-20', 'gemini-2.0-flash-001', 'gemini-3.8-flash'];
    for (const envOverrides of [{}, { FREE_MODELS: '^gemini-' }]) {
      const env = makeEnv(envOverrides);
      const token = await register(env);
      for (const model of refused) {
        // gemini-2.5-flash-8b is only outside the default pattern, not a picture model.
        if (model === 'gemini-2.5-flash-8b' && envOverrides.FREE_MODELS) continue;
        const res = await call(env, { method: 'POST', path: `/v1beta/models/${model}:generateContent`, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
        expect(res.status, model).toBe(404);
        expect((await res.json()).error.details[0].reason).toBe('SCENEVOICE_MODEL_NOT_ALLOWED');
      }
      expect(fetch.calls).toHaveLength(0);
      for (const model of allowed) {
        const res = await call(env, { method: 'POST', path: `/v1beta/models/${model}:generateContent`, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
        expect(res.status, model).toBe(200);
      }
      fetch.calls.length = 0;
    }
  });

  it('requires a token and refuses bodies over 20 MB by declared length', async () => {
    const env = makeEnv();
    const anon = await call(env, { method: 'POST', path: GEN, body: prompt });
    expect(anon.status).toBe(401);
    const token = await register(env);
    const big = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token, 'content-length': String(21 * 1024 * 1024) }, body: prompt });
    expect(big.status).toBe(413);
  });

  it('drops a chunked body without Content-Length as soon as it passes 20 MB, before reading it all or forwarding', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(1) }));
    const CHUNKS = 40;
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > CHUNKS) controller.close();
        else controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(`${BASE}${GEN}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': token, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
      body: stream,
      duplex: 'half',
    });
    expect(request.headers.get('content-length')).toBeNull();
    const res = await handle(request, env, undefined, { fetch, now: () => Date.parse('2026-11-04T10:00:00Z'), log: () => {} });
    expect(res.status).toBe(413);
    expect((await res.json()).error.status).toBe('INVALID_ARGUMENT');
    expect(fetch.calls).toHaveLength(0);
    // 21 chunks cross the limit; the rest of the 40 were never pulled.
    expect(pulled).toBeGreaterThanOrEqual(21);
    expect(pulled).toBeLessThan(CHUNKS);
    expect(cancelled).toBe(true);
    // Nothing was charged.
    expect(await (await call(env, { path: '/v1/me', headers: { 'x-goog-api-key': token } })).json()).toMatchObject({ allowance: { usedToday: 0 } });
  });

  it('accepts a chunked body under the limit and forwards it whole', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(100) }));
    const text = JSON.stringify(prompt);
    const stream = new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    const request = new Request(`${BASE}${GEN}`, { method: 'POST', headers: { 'x-goog-api-key': token, 'content-type': 'application/json' }, body: stream, duplex: 'half' });
    const res = await handle(request, env, undefined, { fetch, now: () => Date.parse('2026-11-04T10:00:00Z'), log: () => {} });
    expect(res.status).toBe(200);
    expect(fetch.calls).toHaveLength(1);
    expect(new TextDecoder().decode(fetch.calls[0].init.body)).toBe(text);
  });

  it('answers 501 when the relay has no Gemini key', async () => {
    const env = makeEnv({ GEMINI_API_KEY: '' });
    const token = await register(env);
    const res = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt });
    expect(res.status).toBe(501);
  });
});

describe('Qwen proxy: chat/completions', () => {
  const answer = { choices: [{ message: { role: 'assistant', content: '{"cues":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2050, completion_tokens: 5 } };

  const request = { model: 'qwen3-vl-plus', messages: [] };

  it('forwards to DashScope with a Bearer server key, charges prompt and completion tokens and adds headers', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: answer }));
    const res = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: request, fetch });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    // ceil((2050 + 5 * 5) / 100)
    expect(res.headers.get('x-scenevoice-used-today')).toBe('21');
    const [up] = fetch.calls;
    expect(up.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(up.init.headers.authorization).toBe(`Bearer ${DASHSCOPE_KEY}`);
    // The body reaches DashScope byte for byte, parsed or not.
    expect(new TextDecoder().decode(up.init.body)).toBe(JSON.stringify(request));
    const chatty = { usage: { prompt_tokens: 10, completion_tokens: 8000 } };
    const res2 = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: request, fetch: makeFetch(() => ({ status: 200, body: chatty })) });
    expect(res2.headers.get('x-scenevoice-used-today')).toBe(String(21 + Math.ceil((10 + 5 * 8000) / 100)));
  });

  it('refuses a free device a model outside QWEN_FREE_MODELS, read from the body, without forwarding', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: answer }));
    const res = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: { model: 'qwen3-max', messages: [] }, fetch });
    expect(res.status).toBe(404);
    expect((await res.json()).error.type).toBe('scenevoice_model_not_allowed');
    // A nested "model" does not stand in for the top-level one, and a body without one is refused.
    const nested = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: { messages: [{ model: 'qwen3-vl-plus' }] }, fetch });
    expect(nested.status).toBe(400);
    expect((await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: '[1,2]', fetch })).status).toBe(400);
    expect((await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: 'not json', fetch })).status).toBe(400);
    expect(fetch.calls).toHaveLength(0);
    expect(await env.USAGE.get(`${token}:2026-11-04`)).toBeNull();
    // qwen3-vl-flash is within the default; a custom pattern applies; a plus device may use anything.
    expect((await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: { model: 'qwen3-vl-flash', messages: [] }, fetch })).status).toBe(200);
    const strict = makeEnv({ QWEN_FREE_MODELS: '^qwen3-vl-plus$' });
    const token2 = await register(strict);
    expect((await call(strict, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token2}` }, body: { model: 'qwen3-vl-flash', messages: [] }, fetch })).status).toBe(404);
    await setPlan(env, token, 'plus');
    const ok = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: { model: 'qwen3-max', messages: [] }, fetch });
    expect(ok.status).toBe(200);
    expect(new TextDecoder().decode(fetch.calls.at(-1).init.body)).toContain('qwen3-max');
  });

  it('uses the OpenAI error shape for the allowance and for auth', async () => {
    const env = makeEnv({ FREE_SECONDS_PER_DAY: '10' });
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: answer }));
    await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: request, fetch });
    const res = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: request, fetch });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { message: 'SceneVoice allowance for today is used up', type: 'scenevoice_allowance', code: 'allowance', resetsAt: '2026-11-05T00:00:00.000Z' },
    });
    const anon = await call(env, { method: 'POST', path: QWEN, body: {} });
    expect(anon.status).toBe(401);
    const body = await anon.json();
    expect(body.error.type).toBe('scenevoice_device_unknown');
    expect(body.error.code).toBe('401');
  });

  it('answers 501 in OpenAI shape when no DashScope key is set', async () => {
    const env = makeEnv({ DASHSCOPE_API_KEY: '' });
    const token = await register(env);
    const res = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: {} });
    expect(res.status).toBe(501);
    expect((await res.json()).error.type).toBe('scenevoice_not_configured');
  });
});

describe('the upstream keys never leave the relay', () => {
  it('do not appear in any response body or header, even when the upstream echoes them', async () => {
    const env = makeEnv();
    const token = await register(env);
    // An upstream that leaks would be the upstream's fault; here it only proves the relay adds nothing.
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(100) }));
    const requests = [
      { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch },
      { method: 'GET', path: '/v1beta/models', headers: { 'x-goog-api-key': token }, fetch: makeFetch(() => ({ status: 200, body: { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] } })) },
      { method: 'GET', path: '/v1/me', headers: { 'x-goog-api-key': token } },
      { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch: async () => { throw new Error(`boom ${UPSTREAM_KEY}`); } },
      { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: {}, fetch: makeFetch(() => ({ status: 500, body: { error: { message: 'upstream broke' } } })) },
      { method: 'GET', path: '/' },
    ];
    for (const req of requests) {
      const res = await call(env, req);
      const text = await res.text();
      expect(text).not.toContain(UPSTREAM_KEY);
      expect(text).not.toContain(DASHSCOPE_KEY);
      for (const [, v] of res.headers) {
        expect(v).not.toContain(UPSTREAM_KEY);
        expect(v).not.toContain(DASHSCOPE_KEY);
      }
    }
  });

  it('never writes the keys into storage', async () => {
    const env = makeEnv();
    const token = await register(env);
    await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch: makeFetch(() => ({ status: 200, body: geminiAnswer(100) })) });
    for (const kv of [env.DEVICES, env.USAGE, env.SCRIPTS, env.LICENSES]) {
      for (const [k, v] of kv.map) {
        expect(k + v).not.toContain(UPSTREAM_KEY);
        expect(k + v).not.toContain(DASHSCOPE_KEY);
      }
    }
  });

  it('logs only the route template, status, token prefix and seconds', async () => {
    const env = makeEnv();
    const token = await register(env);
    const lines = [];
    const { handle } = await import('../src/worker.js');
    const request = new Request(`https://api.scenevoice.test${GEN}`, { method: 'POST', headers: { 'x-goog-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify({ contents: 'SECRET-PROMPT' }) });
    await handle(request, env, undefined, { fetch: makeFetch(() => ({ status: 200, body: geminiAnswer(250) })), log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toEqual({ route: 'POST /v1beta/models/:model:generateContent', status: 200, token: token.slice(0, 8), seconds: 3 });
    expect(lines[0]).not.toContain('SECRET-PROMPT');
    expect(lines[0]).not.toContain('gemini-2.5-flash');
    expect(lines[0]).not.toContain(token);
  });
});
