import { describe, expect, it } from 'vitest';
import { call, makeEnv, register } from './helpers.js';

describe('POST /v1/devices', () => {
  it('creates an anonymous free device with a token in the documented shape', async () => {
    const env = makeEnv();
    const res = await call(env, { method: 'POST', path: '/v1/devices', body: { client: 'extension', version: '1.1.0', locale: 'en' } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^svd_[0-9a-f]{32}$/);
    expect(body.plan).toBe('free');
    expect(body.allowance).toEqual({ secondsPerDay: 3600, usedToday: 0, resetsAt: '2026-11-05T00:00:00.000Z' });
    expect(res.headers.get('x-scenevoice-plan')).toBe('free');
    expect(res.headers.get('x-scenevoice-seconds-per-day')).toBe('3600');
    // The record holds a plan and dates, nothing about the client.
    const stored = await env.DEVICES.get(body.token, 'json');
    expect(stored).toEqual({ plan: 'free', created: '2026-11-04T10:00:00.000Z', licence: null });
  });

  it('honours FREE_SECONDS_PER_DAY', async () => {
    const env = makeEnv({ FREE_SECONDS_PER_DAY: '600' });
    const res = await call(env, { method: 'POST', path: '/v1/devices', body: {} });
    expect((await res.json()).allowance.secondsPerDay).toBe(600);
  });

  it('limits registrations per network address per day, without storing the address', async () => {
    const env = makeEnv({ DEVICES_PER_IP_PER_DAY: '2' });
    await register(env, { ip: '198.51.100.9' });
    await register(env, { ip: '198.51.100.9' });
    const third = await call(env, { method: 'POST', path: '/v1/devices', body: {}, ip: '198.51.100.9' });
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
    expect(body.error.details[0].reason).toBe('SCENEVOICE_DEVICE_LIMIT');
    // Another address is unaffected.
    expect((await call(env, { method: 'POST', path: '/v1/devices', body: {}, ip: '198.51.100.10' })).status).toBe(201);
    // No key in any namespace contains the address itself, and the counters expire within a day.
    for (const kv of [env.DEVICES, env.USAGE, env.SCRIPTS, env.LICENSES]) {
      for (const key of kv.map.keys()) expect(key).not.toContain('198.51.100.9');
    }
    const ipKeys = [...env.USAGE.map.keys()].filter((k) => k.startsWith('ip:'));
    expect(ipKeys.length).toBeGreaterThan(0);
    for (const k of ipKeys) expect(env.USAGE.ttls.get(k)).toBe(86400);
  });

  it('rejects non-string fields and non-object bodies', async () => {
    const env = makeEnv();
    expect((await call(env, { method: 'POST', path: '/v1/devices', body: { client: 42 } })).status).toBe(400);
    expect((await call(env, { method: 'POST', path: '/v1/devices', body: '[1,2]' })).status).toBe(400);
    expect((await call(env, { method: 'POST', path: '/v1/devices', body: 'not json' })).status).toBe(400);
  });

  it('only accepts POST', async () => {
    const env = makeEnv();
    expect((await call(env, { method: 'GET', path: '/v1/devices' })).status).toBe(405);
  });
});

describe('GET /v1/me', () => {
  it('returns the plan, allowance and cache hits for a known token', async () => {
    const env = makeEnv();
    const token = await register(env);
    const res = await call(env, { path: '/v1/me', headers: { 'x-goog-api-key': token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: 'free', allowance: { secondsPerDay: 3600, usedToday: 0, resetsAt: '2026-11-05T00:00:00.000Z' }, cacheHits: 0 });
  });

  it('accepts the token as a Bearer header too', async () => {
    const env = makeEnv();
    const token = await register(env);
    const res = await call(env, { path: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it('answers 401 in Gemini shape for a missing, malformed or unknown token', async () => {
    const env = makeEnv();
    for (const headers of [{}, { 'x-goog-api-key': 'nonsense' }, { 'x-goog-api-key': `svd_${'0'.repeat(32)}` }]) {
      const res = await call(env, { path: '/v1/me', headers });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.status).toBe('UNAUTHENTICATED');
      expect(body.error.details[0].reason).toBe('SCENEVOICE_DEVICE_UNKNOWN');
    }
  });
});

describe('plain pages and CORS', () => {
  it('serves / and /healthz as text', async () => {
    const env = makeEnv();
    const root = await call(env, { path: '/' });
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/plain');
    expect(await root.text()).toContain('github.com/reddynb666/scenevoice');
    const health = await call(env, { path: '/healthz' });
    expect(await health.text()).toBe('ok\n');
  });

  it('answers 404 in Gemini shape for unknown routes', async () => {
    const env = makeEnv();
    const res = await call(env, { path: '/v1/nothing' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.status).toBe('NOT_FOUND');
  });

  it('accepts requests with no Origin or an extension origin, and the listed site', async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: 'https://scenevoice.app, https://www.scenevoice.app/' });
    for (const origin of [undefined, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'moz-extension://1234', 'https://scenevoice.app', 'https://www.scenevoice.app']) {
      const res = await call(env, { path: '/healthz', headers: origin ? { origin } : {} });
      expect(res.status, origin).toBe(200);
      if (origin) expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    for (const origin of ['https://evil.example', 'null']) {
      const res = await call(env, { path: '/healthz', headers: { origin } });
      expect(res.status, origin).toBe(403);
      expect((await res.json()).error.details[0].reason).toBe('SCENEVOICE_ORIGIN');
    }
  });

  it('refuses the opaque origin "null" before it can register a device or count against the network', async () => {
    // A sandboxed iframe can send a simple (no-preflight) text/plain POST with Origin: null.
    const env = makeEnv();
    const res = await call(env, { method: 'POST', path: '/v1/devices', headers: { origin: 'null', 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(env.DEVICES.map.size).toBe(0);
    expect([...env.USAGE.map.keys()].filter((k) => k.startsWith('ip:'))).toHaveLength(0);
  });

  it('answers preflight with the headers the two clients send', async () => {
    const env = makeEnv();
    const res = await call(env, { method: 'OPTIONS', path: '/v1beta/models', headers: { origin: 'chrome-extension://abc' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-goog-api-key');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(res.headers.get('access-control-expose-headers')).toContain('x-scenevoice-used-today');
  });
});
