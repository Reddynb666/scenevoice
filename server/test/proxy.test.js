import { describe, expect, it } from 'vitest';
import { DASHSCOPE_KEY, UPSTREAM_KEY, call, geminiAnswer, makeEnv, makeFetch, register, setPlan } from './helpers.js';

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
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(1500) }));
    const first = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(first.headers.get('x-scenevoice-used-today')).toBe('15');
    const second = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-scenevoice-used-today')).toBe('30');
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
    expect(third.headers.get('x-scenevoice-used-today')).toBe('30');
    // Nothing was forwarded for the refused call.
    expect(fetch.calls).toHaveLength(2);
    // The next UTC day starts fresh.
    const tomorrow = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token }, body: prompt, fetch, now: Date.parse('2026-11-05T00:00:01Z') });
    expect(tomorrow.status).toBe(200);
    expect(tomorrow.headers.get('x-scenevoice-used-today')).toBe('15');
    expect(tomorrow.headers.get('x-scenevoice-resets-at')).toBe('2026-11-06T00:00:00.000Z');
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

  it('requires a token and refuses bodies over 20 MB before reading them', async () => {
    const env = makeEnv();
    const anon = await call(env, { method: 'POST', path: GEN, body: prompt });
    expect(anon.status).toBe(401);
    const token = await register(env);
    const big = await call(env, { method: 'POST', path: GEN, headers: { 'x-goog-api-key': token, 'content-length': String(21 * 1024 * 1024) }, body: prompt });
    expect(big.status).toBe(413);
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

  it('forwards to DashScope with a Bearer server key, charges by usage.prompt_tokens and adds headers', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: answer }));
    const res = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: { model: 'qwen3-vl-plus', messages: [] }, fetch });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(res.headers.get('x-scenevoice-used-today')).toBe('21');
    const [up] = fetch.calls;
    expect(up.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(up.init.headers.authorization).toBe(`Bearer ${DASHSCOPE_KEY}`);
  });

  it('uses the OpenAI error shape for the allowance and for auth', async () => {
    const env = makeEnv({ FREE_SECONDS_PER_DAY: '10' });
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: answer }));
    await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: {}, fetch });
    const res = await call(env, { method: 'POST', path: QWEN, headers: { authorization: `Bearer ${token}` }, body: {}, fetch });
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
