import { describe, expect, it } from 'vitest';
import { UPSTREAM_KEY, call, makeEnv, makeFetch, register, setPlan } from './helpers.js';

const MODELS = {
  models: [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite-preview', displayName: 'Gemini 3.5 Flash-Lite Preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-05-20', displayName: 'Gemini 2.5 Flash Preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-image', displayName: 'Gemini 2.5 Flash Image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-native-audio-preview-09-2025', displayName: 'Gemini 2.5 Flash Native Audio', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-pro-preview', displayName: 'Gemini 3.8 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
  ],
  nextPageToken: 'page2',
};

const names = (body) => body.models.map((m) => m.name);

describe('GET /v1beta/models', () => {
  it('forwards pageSize and pageToken with the server key, and filters the list for free devices', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: MODELS }));
    const res = await call(env, { path: '/v1beta/models?pageSize=1000&pageToken=abc', headers: { 'x-goog-api-key': token }, fetch });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(names(body)).toEqual(['models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemini-3.5-flash-lite-preview', 'models/gemini-3.8-flash', 'models/gemini-2.5-flash-preview-05-20']);
    expect(body.nextPageToken).toBe('page2');
    expect(res.headers.get('x-scenevoice-plan')).toBe('free');
    const [up] = fetch.calls;
    expect(up.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=abc');
    expect(up.init.headers['x-goog-api-key']).toBe(UPSTREAM_KEY);
  });

  it('gives plus and org devices the whole list', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: MODELS }));
    for (const plan of ['plus', 'org']) {
      await setPlan(env, token, plan);
      const res = await call(env, { path: '/v1beta/models', headers: { 'x-goog-api-key': token }, fetch });
      expect(names(await res.json())).toEqual(names(MODELS));
      expect(res.headers.get('x-scenevoice-plan')).toBe(plan);
    }
  });

  it('honours a custom FREE_MODELS pattern and falls back to the default when it is not a valid regex', async () => {
    const env = makeEnv({ FREE_MODELS: '^gemini-2\\.5-flash-lite$' });
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 200, body: MODELS }));
    expect(names(await (await call(env, { path: '/v1beta/models', headers: { 'x-goog-api-key': token }, fetch })).json())).toEqual(['models/gemini-2.5-flash-lite']);
    const broken = makeEnv({ FREE_MODELS: '(' });
    const token2 = await register(broken);
    expect(names(await (await call(broken, { path: '/v1beta/models', headers: { 'x-goog-api-key': token2 }, fetch })).json())).toHaveLength(5);
    // Even a pattern that admits everything leaves the picture, speech and audio models out for free devices.
    const loose = makeEnv({ FREE_MODELS: '^gemini-' });
    const token3 = await register(loose);
    const listed = names(await (await call(loose, { path: '/v1beta/models', headers: { 'x-goog-api-key': token3 }, fetch })).json());
    expect(listed).toContain('models/gemini-2.5-pro');
    expect(listed.filter((n) => /image|tts|audio/.test(n))).toEqual([]);
  });

  it('passes an upstream error through unchanged', async () => {
    const env = makeEnv();
    const token = await register(env);
    const fetch = makeFetch(() => ({ status: 403, body: { error: { code: 403, message: 'PERMISSION_DENIED', status: 'PERMISSION_DENIED' } } }));
    const res = await call(env, { path: '/v1beta/models', headers: { 'x-goog-api-key': token }, fetch });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('PERMISSION_DENIED');
  });

  it('requires a token', async () => {
    const env = makeEnv();
    expect((await call(env, { path: '/v1beta/models' })).status).toBe(401);
  });
});
