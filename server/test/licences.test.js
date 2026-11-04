import { describe, expect, it } from 'vitest';
import { parseStripeSignature, signForStripe, verifyStripeSignature } from '../src/stripe.js';
import { normaliseLicenceKey, randomLicenceKey } from '../src/util.js';
import { call, geminiAnswer, makeEnv, makeFetch, register } from './helpers.js';

const SECRET = 'whsec_test_secret_for_the_relay';
const NOW = Date.parse('2026-11-04T10:00:00Z');

const checkoutEvent = (sessionId, metadata = {}, extra = {}) => ({
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: { object: { id: sessionId, object: 'checkout.session', payment_status: 'paid', metadata, ...extra } },
});

async function postWebhook(env, event, { secret = SECRET, at = NOW / 1000, header } = {}) {
  const raw = JSON.stringify(event);
  return call(env, {
    method: 'POST',
    path: '/webhooks/stripe',
    headers: { 'stripe-signature': header ?? (await signForStripe(raw, secret, at)) },
    body: raw,
    now: NOW,
  });
}

describe('licence keys', () => {
  it('look like svl-XXXX-XXXX-XXXX in base32 and normalise case and whitespace', () => {
    for (let i = 0; i < 20; i += 1) expect(randomLicenceKey()).toMatch(/^svl-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(normaliseLicenceKey('  SVL-abcd-EFGH-2345 ')).toBe('svl-ABCD-EFGH-2345');
    expect(normaliseLicenceKey('svl-abcd-efgh')).toBe('');
    expect(normaliseLicenceKey('svl-abc1-efgh-2345')).toBe('');
    expect(normaliseLicenceKey(42)).toBe('');
  });
});

describe('POST /v1/licenses/activate', () => {
  it('moves the device to the licence plan, takes a seat, and is idempotent for the same device', async () => {
    const env = makeEnv();
    await env.LICENSES.put('svl-AAAA-BBBB-CCCC', JSON.stringify({ plan: 'org', seats: 2, used: 0, created: '2026-11-01T00:00:00.000Z' }));
    const token = await register(env);
    const res = await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': token }, body: { licenseKey: 'svl-aaaa-bbbb-cccc' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: 'org', allowance: { secondsPerDay: 21600, usedToday: 0, resetsAt: '2026-11-05T00:00:00.000Z' } });
    expect(res.headers.get('x-scenevoice-plan')).toBe('org');
    expect((await env.LICENSES.get('svl-AAAA-BBBB-CCCC', 'json')).used).toBe(1);
    const device = await env.DEVICES.get(token, 'json');
    expect(device.plan).toBe('org');
    expect(device.licence).toBe('svl-AAAA-BBBB-CCCC');
    // Activating again from the same device does not take another seat.
    await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': token }, body: { licenseKey: 'svl-AAAA-BBBB-CCCC' } });
    expect((await env.LICENSES.get('svl-AAAA-BBBB-CCCC', 'json')).used).toBe(1);
    // The plan shows on later calls.
    const me = await (await call(env, { path: '/v1/me', headers: { 'x-goog-api-key': token } })).json();
    expect(me.plan).toBe('org');
  });

  it('refuses when all seats are taken, and 404s unknown or malformed keys', async () => {
    const env = makeEnv();
    await env.LICENSES.put('svl-AAAA-BBBB-CCCC', JSON.stringify({ plan: 'plus', seats: 1, used: 0, created: '' }));
    const first = await register(env, { ip: '198.51.100.1' });
    const second = await register(env, { ip: '198.51.100.2' });
    expect((await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': first }, body: { licenseKey: 'svl-AAAA-BBBB-CCCC' } })).status).toBe(200);
    const full = await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': second }, body: { licenseKey: 'svl-AAAA-BBBB-CCCC' } });
    expect(full.status).toBe(409);
    expect((await full.json()).error.details[0].reason).toBe('SCENEVOICE_LICENCE_FULL');
    expect((await env.DEVICES.get(second, 'json')).plan).toBe('free');
    for (const licenseKey of ['svl-ZZZZ-ZZZZ-ZZZZ', 'nonsense', undefined]) {
      const res = await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': second }, body: { licenseKey } });
      expect(res.status).toBe(404);
      expect((await res.json()).error.details[0].reason).toBe('SCENEVOICE_LICENCE_NOT_FOUND');
    }
    expect((await call(env, { method: 'POST', path: '/v1/licenses/activate', body: { licenseKey: 'svl-AAAA-BBBB-CCCC' } })).status).toBe(401);
  });

  it('drops a device to free on its next request once its licence record is deleted, and follows an edited plan', async () => {
    const env = makeEnv();
    await env.LICENSES.put('svl-AAAA-BBBB-CCCC', JSON.stringify({ plan: 'org', seats: 2, used: 0, created: '' }));
    const token = await register(env);
    await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': token }, body: { licenseKey: 'svl-AAAA-BBBB-CCCC' } });
    const fetch = makeFetch(() => ({ status: 200, body: geminiAnswer(100) }));
    const pro = { method: 'POST', path: '/v1beta/models/gemini-2.5-pro:generateContent', headers: { 'x-goog-api-key': token }, body: {}, fetch };
    expect((await call(env, pro)).status).toBe(200);
    // The owner edits the record (org -> plus): the device follows.
    await env.LICENSES.put('svl-AAAA-BBBB-CCCC', JSON.stringify({ plan: 'plus', seats: 2, used: 1, created: '' }));
    expect((await (await call(env, { path: '/v1/me', headers: { 'x-goog-api-key': token } })).json()).plan).toBe('plus');
    expect((await env.DEVICES.get(token, 'json')).plan).toBe('plus');
    // The owner revokes the licence as the README says, by deleting the record.
    await env.LICENSES.delete('svl-AAAA-BBBB-CCCC');
    const me = await call(env, { path: '/v1/me', headers: { 'x-goog-api-key': token }, now: Date.parse('2026-11-04T10:01:00Z') });
    // usedToday 2: the pro call's 100 prompt and 10 output tokens, ceil(150 / 100).
    expect(await me.json()).toEqual({ plan: 'free', allowance: { secondsPerDay: 3600, usedToday: 2, resetsAt: '2026-11-05T00:00:00.000Z' }, cacheHits: 0 });
    const device = await env.DEVICES.get(token, 'json');
    expect(device).toMatchObject({ plan: 'free', licence: null, revoked: '2026-11-04T10:01:00.000Z' });
    // The free model gate applies from then on.
    const refused = await call(env, pro);
    expect(refused.status).toBe(404);
    expect((await refused.json()).error.details[0].reason).toBe('SCENEVOICE_MODEL_NOT_ALLOWED');
    expect(fetch.calls).toHaveLength(1);
  });

  it('uses ORG_SECONDS_PER_DAY for org devices when set', async () => {
    const env = makeEnv({ ORG_SECONDS_PER_DAY: '86400' });
    await env.LICENSES.put('svl-AAAA-BBBB-CCCC', JSON.stringify({ plan: 'org', seats: 5, used: 0, created: '' }));
    const token = await register(env);
    const res = await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': token }, body: { licenseKey: 'svl-AAAA-BBBB-CCCC' } });
    expect((await res.json()).allowance.secondsPerDay).toBe(86400);
  });
});

describe('Stripe signature check', () => {
  it('parses the header and accepts a fresh, correctly signed payload only', async () => {
    const raw = '{"id":"evt_1"}';
    const header = await signForStripe(raw, SECRET, NOW / 1000);
    expect(parseStripeSignature(header)).toEqual({ t: NOW / 1000, v1: [header.split('v1=')[1]] });
    expect(await verifyStripeSignature(raw, header, SECRET, NOW)).toBe(true);
    expect(await verifyStripeSignature(raw + ' ', header, SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(raw, header, 'whsec_other', NOW)).toBe(false);
    expect(await verifyStripeSignature(raw, header, SECRET, NOW + 301_000)).toBe(false);
    expect(await verifyStripeSignature(raw, header, SECRET, NOW - 301_000)).toBe(false);
    expect(await verifyStripeSignature(raw, header, '', NOW)).toBe(false);
    expect(await verifyStripeSignature(raw, 't=1,v1=', SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(raw, '', SECRET, NOW)).toBe(false);
    // Several v1 entries (secret rotation): any one may match.
    const rotated = `${header},v1=${'0'.repeat(64)}`;
    expect(await verifyStripeSignature(raw, rotated, SECRET, NOW)).toBe(true);
  });
});

describe('POST /webhooks/stripe', () => {
  it('creates a licence from a paid checkout session and answers the same key for a retry', async () => {
    const env = makeEnv({ STRIPE_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: 'admin-secret' });
    const res = await postWebhook(env, checkoutEvent('cs_test_1', { plan: 'org', seats: '25' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.licenseKey).toMatch(/^svl-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(body).toMatchObject({ received: true, plan: 'org', seats: 25 });
    expect(await env.LICENSES.get(body.licenseKey, 'json')).toEqual({ plan: 'org', seats: 25, used: 0, created: '2026-11-04T10:00:00.000Z', session: 'cs_test_1' });
    const again = await (await postWebhook(env, checkoutEvent('cs_test_1', { plan: 'org', seats: '25' }))).json();
    expect(again.licenseKey).toBe(body.licenseKey);
    expect([...env.LICENSES.map.keys()].filter((k) => k.startsWith('svl-'))).toHaveLength(1);

    // The owner's post-purchase page reads the key with the admin token.
    const admin = await call(env, { path: '/admin/licenses/cs_test_1', headers: { authorization: 'Bearer admin-secret' } });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ licenseKey: body.licenseKey, plan: 'org', seats: 25, used: 0 });
    expect((await call(env, { path: '/admin/licenses/cs_test_1', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await call(env, { path: '/admin/licenses/cs_test_1' })).status).toBe(401);
    expect((await call(env, { path: '/admin/licenses/cs_unknown', headers: { authorization: 'Bearer admin-secret' } })).status).toBe(404);

    // The key activates.
    const token = await register(env);
    const act = await call(env, { method: 'POST', path: '/v1/licenses/activate', headers: { 'x-goog-api-key': token }, body: { licenseKey: body.licenseKey } });
    expect((await act.json()).plan).toBe('org');
  });

  it('defaults to plus with one seat', async () => {
    const env = makeEnv({ STRIPE_WEBHOOK_SECRET: SECRET });
    const body = await (await postWebhook(env, checkoutEvent('cs_test_2'))).json();
    expect(body).toMatchObject({ plan: 'plus', seats: 1 });
  });

  it('refuses a bad or stale signature and does not create anything', async () => {
    const env = makeEnv({ STRIPE_WEBHOOK_SECRET: SECRET });
    expect((await postWebhook(env, checkoutEvent('cs_test_3'), { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await postWebhook(env, checkoutEvent('cs_test_3'), { at: NOW / 1000 - 3600 })).status).toBe(400);
    expect((await postWebhook(env, checkoutEvent('cs_test_3'), { header: '' })).status).toBe(400);
    expect(env.LICENSES.map.size).toBe(0);
  });

  it('acknowledges other events and unpaid sessions without creating a licence', async () => {
    const env = makeEnv({ STRIPE_WEBHOOK_SECRET: SECRET });
    const other = await postWebhook(env, { id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ received: true });
    const unpaid = await postWebhook(env, checkoutEvent('cs_test_4', {}, { payment_status: 'unpaid' }));
    expect(await unpaid.json()).toEqual({ received: true, pending: true });
    expect(env.LICENSES.map.size).toBe(0);
  });

  it('answers 501 when Stripe or the admin token is not configured', async () => {
    const env = makeEnv();
    expect((await postWebhook(env, checkoutEvent('cs_test_5'))).status).toBe(501);
    expect((await call(env, { path: '/admin/licenses/cs_test_5', headers: { authorization: 'Bearer x' } })).status).toBe(501);
  });
});
