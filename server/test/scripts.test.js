import { describe, expect, it } from 'vitest';
import { validateScript } from '../src/worker.js';
import { call, makeEnv, register } from './helpers.js';

const VIDEO = 'dQw4w9WgXcQ';
const cue = (start, standard, extra = {}) => ({ start, gap: 2, kind: 'visual', priority: 2, brief: standard, standard, detailed: standard, ...extra });

/** A complete script as the extension saves it in chrome.storage.local. */
const script = (extra = {}) => ({
  version: 2,
  videoId: VIDEO,
  lang: 'en',
  duration: 212,
  cues: [cue(1.5, 'A man in a trench coat dances in an alley.'), cue(12, 'He spins towards the camera.', { confidence: 'low', onScreenText: '' })],
  characters: [{ label: 'the singer', description: 'a man in a trench coat' }],
  videoType: 'entertainment',
  completedUntil: 212,
  complete: true,
  model: 'gemini-2.5-flash',
  createdAt: 1762250000000,
  updatedAt: 1762250300000,
  ...extra,
});

/** A device that has had something described through the relay today: what a real share always follows. */
const earn = (env, token, seconds = 30, day = '2026-11-04') => env.USAGE.put(`${token}:${day}`, String(seconds));

describe('PUT then GET /v1/scripts/{videoId}', () => {
  it('stores a complete, valid script and serves it back with source: cloud', async () => {
    const env = makeEnv();
    const token = await register(env);
    await earn(env, token);
    const put = await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, headers: { 'x-goog-api-key': token }, body: script() });
    expect(put.status).toBe(204);
    expect(put.headers.get('x-scenevoice-stored')).toBe('1');
    expect(env.SCRIPTS.ttls.get(`${VIDEO}:en:2`)).toBe(180 * 86400);

    const get = await call(env, { path: `/v1/scripts/${VIDEO}?lang=en&v=2` });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body).toEqual({ ...script(), source: 'cloud' });
    // Not shared: the same video in another language or another script version.
    expect((await call(env, { path: `/v1/scripts/${VIDEO}?lang=zh-CN&v=2` })).status).toBe(404);
    expect((await call(env, { path: `/v1/scripts/${VIDEO}?lang=en&v=1` })).status).toBe(404);
  });

  it('counts a hit for the device that presents a token, and GET works without one', async () => {
    const env = makeEnv();
    const token = await register(env);
    const reader = await register(env, { ip: '198.51.100.2' });
    await earn(env, token);
    await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, headers: { 'x-goog-api-key': token }, body: script() });
    await call(env, { path: `/v1/scripts/${VIDEO}?lang=en&v=2`, headers: { 'x-goog-api-key': reader } });
    await call(env, { path: `/v1/scripts/${VIDEO}?lang=en&v=2`, headers: { 'x-goog-api-key': reader } });
    await call(env, { path: `/v1/scripts/${VIDEO}?lang=en&v=2` });
    const me = await (await call(env, { path: '/v1/me', headers: { 'x-goog-api-key': reader } })).json();
    expect(me.cacheHits).toBe(2);
    expect(me.allowance.usedToday).toBe(0);
  });

  it('requires a token for PUT and never charges for it', async () => {
    const env = makeEnv();
    const anon = await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, body: script() });
    expect(anon.status).toBe(401);
    const token = await register(env);
    await earn(env, token, 30);
    await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, headers: { 'x-goog-api-key': token }, body: script() });
    expect(await env.USAGE.get(`${token}:2026-11-04`)).toBe('30');
  });

  it('accepts a PUT only from a device that was charged seconds today or yesterday', async () => {
    const env = makeEnv();
    const token = await register(env);
    const put = () => call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, headers: { 'x-goog-api-key': token }, body: script() });
    const fresh = await put();
    expect(fresh.status).toBe(403);
    expect((await fresh.json()).error.details[0].reason).toBe('SCENEVOICE_SCRIPT_UNEARNED');
    expect(env.SCRIPTS.map.size).toBe(0);
    // A job that crossed midnight was charged yesterday.
    await earn(env, token, 5, '2026-11-03');
    expect((await put()).status).toBe(204);
    expect(env.SCRIPTS.map.size).toBe(1);
  });

  it('keeps the first script stored for a key: a later PUT by anyone changes nothing', async () => {
    const env = makeEnv();
    const first = await register(env, { ip: '198.51.100.1' });
    const second = await register(env, { ip: '198.51.100.2' });
    await earn(env, first);
    await earn(env, second);
    const original = script();
    expect((await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, headers: { 'x-goog-api-key': first }, body: original })).status).toBe(204);
    const poison = script({ cues: [cue(0, 'Call 555-0100 to claim your prize.')] });
    const again = await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, headers: { 'x-goog-api-key': second }, body: poison });
    expect(again.status).toBe(204);
    expect(again.headers.get('x-scenevoice-stored')).toBe('0');
    const same = await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=en`, headers: { 'x-goog-api-key': first }, body: poison });
    expect(same.headers.get('x-scenevoice-stored')).toBe('0');
    expect(await (await call(env, { path: `/v1/scripts/${VIDEO}?lang=en&v=2` })).json()).toEqual({ ...original, source: 'cloud' });
    // Another version or language of the same video is a different key and may still be filled.
    expect((await call(env, { method: 'PUT', path: `/v1/scripts/${VIDEO}?lang=fr`, headers: { 'x-goog-api-key': second }, body: script({ lang: 'fr' }) })).headers.get('x-scenevoice-stored')).toBe('1');
    // Nothing about either uploader is stored with the scripts.
    for (const [, v] of env.SCRIPTS.map) {
      expect(v).not.toContain(first.slice(0, 8));
      expect(v).not.toContain(second.slice(0, 8));
    }
  });

  it('limits one device to SCRIPT_PUTS_PER_DAY uploads a day', async () => {
    const env = makeEnv({ SCRIPT_PUTS_PER_DAY: '2' });
    const token = await register(env);
    await earn(env, token);
    const put = (videoId, now) => call(env, { method: 'PUT', path: `/v1/scripts/${videoId}?lang=en`, headers: { 'x-goog-api-key': token }, body: script({ videoId }), now });
    expect((await put('video000001')).status).toBe(204);
    expect((await put('video000002')).status).toBe(204);
    const third = await put('video000003');
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error.details[0]).toEqual({ reason: 'SCENEVOICE_SHARE_LIMIT', resetsAt: '2026-11-05T00:00:00.000Z' });
    expect(env.SCRIPTS.map.has('video000003:en:2')).toBe(false);
    expect(env.USAGE.ttls.get(`puts:${token}:2026-11-04`)).toBe(2 * 86400);
    // Tomorrow counts again (yesterday's charged seconds still qualify).
    expect((await put('video000003', Date.parse('2026-11-05T01:00:00Z'))).status).toBe(204);
  });

  it('rejects incomplete, mismatched, oversized or picture-carrying scripts', async () => {
    const env = makeEnv();
    const token = await register(env);
    await earn(env, token);
    const put = (body, path = `/v1/scripts/${VIDEO}?lang=en`, headers = {}) =>
      call(env, { method: 'PUT', path, headers: { 'x-goog-api-key': token, ...headers }, body });
    const expect400 = async (res, reason) => {
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.status).toBe('INVALID_ARGUMENT');
      if (reason) expect(body.error.message).toContain(reason);
    };
    await expect400(await put(script({ complete: false })), 'complete');
    await expect400(await put(script({ version: 'two' })), 'version');
    await expect400(await put(script({ cues: 'none' })), 'cues');
    await expect400(await put(script({ videoId: 'other' })), 'videoId');
    await expect400(await put(script({ lang: 'fr' })), 'lang');
    await expect400(await put(script({ cues: [cue(-1, 'x')] })), 'start');
    await expect400(await put(script({ cues: [{ start: 1 }] })), 'standard');
    await expect400(await put(script({ cues: [cue(1, 'data:image/jpeg;base64,' + 'A'.repeat(5000))] })), 'at most');
    await expect400(await put('not json'));
    await expect400(await put(script(), `/v1/scripts/${VIDEO}`), 'lang');
    await expect400(await put(script(), '/v1/scripts/..%2F..?lang=en'), 'video id');
    const big = await put(script(), undefined, { 'content-length': String(600 * 1024) });
    expect(big.status).toBe(413);
    const bigBody = await put(script({ cues: Array.from({ length: 400 }, (_, i) => cue(i, 'x'.repeat(1900))) }));
    expect(bigBody.status).toBe(413);
    expect([...env.SCRIPTS.map.keys()]).toEqual([]);
  });

  it('drops unknown fields so only text in the documented shape is kept', () => {
    const raw = script({ frames: ['data:image/jpeg;base64,...'], question: 'who is this?', cues: [cue(1, 'A dog.', { picture: 'x', priority: 9 })] });
    const { script: clean, error } = validateScript(raw, VIDEO, 'en');
    expect(error).toBeUndefined();
    expect(clean.frames).toBeUndefined();
    expect(clean.question).toBeUndefined();
    expect(clean.cues[0]).toEqual({ start: 1, gap: 2, kind: 'visual', brief: 'A dog.', standard: 'A dog.', detailed: 'A dog.' });
    expect(clean.source).toBe('cloud');
    expect(clean.complete).toBe(true);
  });

  it('validates the address on GET', async () => {
    const env = makeEnv();
    expect((await call(env, { path: `/v1/scripts/${VIDEO}?lang=en` })).status).toBe(400);
    expect((await call(env, { path: `/v1/scripts/${VIDEO}?v=2` })).status).toBe(400);
    expect((await call(env, { path: `/v1/scripts/${VIDEO}?lang=en&v=2` })).status).toBe(404);
    expect((await call(env, { method: 'DELETE', path: `/v1/scripts/${VIDEO}?lang=en&v=2` })).status).toBe(405);
  });
});
