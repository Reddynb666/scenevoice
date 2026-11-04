// SceneVoice Cloud on the extension side: the 'cloud' provider (a token where
// the key goes, the relay's address fixed), the relay's own requests, what may
// go into the shared cache and what may come out of it, the worker's two cache
// commands, and the words the listener hears.

// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALES, STRINGS } from '../scripts/locales.mjs';
import { CLOUD_API_BASE, DEFAULT_LOCAL, DEFAULT_SETTINGS, PROVIDERS, SAMPLE_DESCRIPTIONS, SCRIPT_VERSION } from '../src/shared/constants.js';
import { activateLicense, adoptCloudScript, cloudScriptOk, fetchMe, registerDevice, shareableScript, validLicenseKey, validToken } from '../src/shared/cloud.js';
import { createClient } from '../src/shared/describe.js';
import { GeminiClient } from '../src/shared/gemini.js';
import { errorMessage } from '../src/shared/i18n.js';
import { effectiveProvider, inputModeFor, providerFor } from '../src/shared/providers.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { COUNTED_PROVIDERS } from '../src/shared/usage.js';
import { fakeChrome } from './fake-chrome.js';

const TOKEN = `svd_${'0123456789abcdef'.repeat(2)}`;

/** A fetch that answers every request the same way and remembers what it was asked. */
function fakeFetch(status, body) {
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }));
}

describe('the cloud provider', () => {
  it('is one of the providers, and opens YouTube videos by their link like Gemini', () => {
    expect(PROVIDERS).toEqual(['gemini', 'qwen', 'cloud']);
    expect(inputModeFor('cloud', 'youtube')).toBe('video');
    expect(inputModeFor('cloud', 'bilibili')).toBe('frames');
    expect(providerFor({ youtubeProvider: 'cloud' }, 'youtube')).toBe('cloud');
  });

  it('stands in only when the listener has no key of their own, and their own key comes first', () => {
    // Nothing of their own, a token: Cloud, on either site.
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', { gemini: false, qwen: false, cloud: true })).toBe('cloud');
    expect(effectiveProvider(DEFAULT_SETTINGS, 'bilibili', { gemini: false, qwen: false, cloud: true })).toBe('cloud');
    // The other key of their own beats the token.
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', { gemini: false, qwen: true, cloud: true })).toBe('qwen');
    // Cloud chosen but no token: a key of their own describes; with nothing at all, Cloud stays chosen (and is asked for).
    const cloud = { ...DEFAULT_SETTINGS, youtubeProvider: 'cloud', bilibiliProvider: 'cloud' };
    expect(effectiveProvider(cloud, 'youtube', { gemini: true, qwen: false, cloud: false })).toBe('gemini');
    expect(effectiveProvider(cloud, 'youtube', { gemini: false, qwen: false, cloud: false })).toBe('cloud');
    expect(effectiveProvider(cloud, 'youtube', { gemini: true, qwen: true, cloud: true })).toBe('cloud');
    // The keys of before, without a cloud entry, still work.
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', { gemini: false, qwen: false })).toBe('gemini');
  });

  it('keeps the choice and the sharing switch in the synced settings, and the token with the keys', () => {
    expect(normalizeSettings({ youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true })).toMatchObject({ youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true });
    expect(normalizeSettings({ shareDescriptions: 'yes' }).shareDescriptions).toBe(false);
    expect(DEFAULT_SETTINGS.shareDescriptions).toBe(false);
    expect(Object.keys(DEFAULT_SETTINGS).some((k) => /key|token/i.test(k))).toBe(false);
    expect(DEFAULT_LOCAL).toMatchObject({ cloudToken: '', cloudPlan: '', cloudModel: '' });
    expect(COUNTED_PROVIDERS).toEqual(['gemini', 'qwen', 'cloud']);
  });

  it('is a Gemini client pointed at the relay, whatever address the config names', () => {
    const client = createClient('cloud', { apiKey: TOKEN, apiBase: 'https://evil.example', model: 'gemini-2.5-flash' });
    expect(client).toBeInstanceOf(GeminiClient);
    expect(client.apiBase).toBe(CLOUD_API_BASE);
    expect(client.apiKey).toBe(TOKEN);
    expect(client.model).toBe('gemini-2.5-flash');
    expect(CLOUD_API_BASE).toBe('https://api.scenevoice.app');
  });
});

describe('the relay’s own requests', () => {
  it('registers a device and keeps only a token of the right shape', async () => {
    const fetch = fakeFetch(201, { token: TOKEN, plan: 'free', allowance: { secondsPerDay: 3600, usedToday: 0, resetsAt: '2026-11-05T00:00:00Z' } });
    const got = await registerDevice(fetch, { version: '1.1.0', locale: 'en' });
    expect(got).toEqual({ token: TOKEN, plan: 'free', allowance: { secondsPerDay: 3600, usedToday: 0, resetsAt: '2026-11-05T00:00:00Z' } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.scenevoice.app/v1/devices');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ client: 'extension', version: '1.1.0', locale: 'en' });
    expect(init.headers).not.toHaveProperty('x-goog-api-key');

    await expect(registerDevice(fakeFetch(200, { token: '<script>alert(1)</script>' }))).rejects.toMatchObject({ code: 'request-failed' });
    // The relay's daily limit on new devices per network is its own error, with the time it opens again; any other 429 is a rate limit.
    const limited = { error: { code: 429, message: 'Too many new SceneVoice devices from this network today. Try again tomorrow.', status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'SCENEVOICE_DEVICE_LIMIT', resetsAt: '2026-11-05T00:00:00Z' }] } };
    await expect(registerDevice(fakeFetch(429, limited))).rejects.toMatchObject({ code: 'device-limit', resetAt: '2026-11-05T00:00:00Z' });
    await expect(registerDevice(fakeFetch(429, { error: { message: 'limit', details: [{ reason: 'SCENEVOICE_DEVICE_LIMIT', resetsAt: 'soon' }] } }))).rejects.toMatchObject({ code: 'device-limit', resetAt: '' });
    await expect(registerDevice(fakeFetch(429, { error: { message: 'too many devices' } }))).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(registerDevice(vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))).rejects.toMatchObject({ code: 'network' });
    expect(validToken(TOKEN)).toBe(true);
    expect(validToken('svd_short')).toBe(false);
    expect(validToken(`AIza${'x'.repeat(35)}`)).toBe(false);
  });

  it('sends the token in a header, never in the address', async () => {
    const fetch = fakeFetch(200, { plan: 'plus', allowance: { secondsPerDay: 14400, usedToday: 120 }, cacheHits: 3 });
    expect(await fetchMe(fetch, TOKEN)).toEqual({ plan: 'plus', allowance: { secondsPerDay: 14400, usedToday: 120, resetsAt: '' }, cacheHits: 3 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.scenevoice.app/v1/me');
    expect(url).not.toContain(TOKEN);
    expect(init.headers['x-goog-api-key']).toBe(TOKEN);
    await expect(fetchMe(fakeFetch(401, { error: { message: 'unknown device' } }), TOKEN)).rejects.toMatchObject({ code: 'bad-key' });
  });

  it('activates a licence, and tells an unknown key from a full one', async () => {
    const fetch = fakeFetch(200, { plan: 'org', allowance: { secondsPerDay: 36000, usedToday: 0 } });
    expect(await activateLicense(fetch, TOKEN, ' svl-ABCD-EFGH-IJKL ')).toMatchObject({ plan: 'org' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.scenevoice.app/v1/licenses/activate');
    expect(JSON.parse(init.body)).toEqual({ licenseKey: 'svl-ABCD-EFGH-IJKL' });
    expect(init.headers['x-goog-api-key']).toBe(TOKEN);
    await expect(activateLicense(fakeFetch(404, {}), TOKEN, 'svl-ABCD-EFGH-IJKL')).rejects.toMatchObject({ code: 'not-found' });
    await expect(activateLicense(fakeFetch(409, {}), TOKEN, 'svl-ABCD-EFGH-IJKL')).rejects.toMatchObject({ code: 'license-full' });
    expect(validLicenseKey('svl-ABCD-EFGH-IJKL')).toBe(true);
    expect(validLicenseKey('svl-ABCD-EFGH')).toBe(false);
  });
});

describe('the shared description cache', () => {
  const cue = (start, standard, extra = {}) => ({ start, gap: 3, kind: 'visual', priority: 1, onScreenText: '', confidence: 'high', brief: standard, standard, detailed: standard, ...extra });
  const finished = () => ({
    version: SCRIPT_VERSION,
    videoId: 'abcdefghijk',
    lang: 'en',
    duration: 600,
    cues: [cue(1, 'A door opens.'), cue(10, 'A man in a grey coat waves.', { revised: true, spokenAt: 123 })],
    characters: [{ label: 'the man in grey', description: 'grey coat', seenAt: 5 }],
    videoType: 'other',
    model: 'gemini-2.5-flash',
    usage: { input: 90000, output: 2000, thinking: 500, requests: 1, cost: 0.03 },
    completedUntil: 600,
    complete: true,
    createdAt: 1700000000000,
    provider: 'cloud',
    feedback: [{ start: 10 }],
  });

  it('sends only the text and what it took: no marks, no times of use, no feedback', () => {
    const shared = shareableScript(finished());
    expect(Object.keys(shared).sort()).toEqual(['characters', 'complete', 'completedUntil', 'cues', 'duration', 'lang', 'model', 'usage', 'version', 'videoId', 'videoType']);
    expect(shared.cues[1]).toEqual(cue(10, 'A man in a grey coat waves.'));
    expect(shared.characters).toEqual([{ label: 'the man in grey', description: 'grey coat' }]);
    expect(shared.usage).toEqual({ input: 90000, output: 2000, thinking: 500, requests: 1 });
    expect(JSON.stringify(shared)).not.toMatch(/revised|spokenAt|seenAt|feedback|createdAt|cost/);
    // Only a complete script is offered.
    expect(shareableScript({ ...finished(), complete: false })).toBeNull();
    expect(shareableScript(null)).toBeNull();
  });

  it('takes from the cache only a complete script of this video, language and version', () => {
    const ok = { ...shareableScript(finished()), source: 'cloud' };
    const want = { videoId: 'abcdefghijk', lang: 'en', duration: 600 };
    expect(cloudScriptOk(ok, want)).toBe(true);
    expect(cloudScriptOk(ok, { ...want, duration: 603 })).toBe(true);
    expect(cloudScriptOk({ ...ok, videoId: 'zzzzzzzzzzz' }, want)).toBe(false);
    expect(cloudScriptOk({ ...ok, lang: 'fr' }, want)).toBe(false);
    expect(cloudScriptOk({ ...ok, version: SCRIPT_VERSION - 1 }, want)).toBe(false);
    expect(cloudScriptOk({ ...ok, complete: false }, want)).toBe(false);
    expect(cloudScriptOk({ ...ok, duration: 1200 }, want)).toBe(false);
    expect(cloudScriptOk({ ...ok, cues: [{ text: 'no start' }] }, want)).toBe(false);
    expect(cloudScriptOk({ ...ok, cues: 'none' }, want)).toBe(false);
    expect(cloudScriptOk(null, want)).toBe(false);
    expect(cloudScriptOk([], want)).toBe(false);
    const adopted = adoptCloudScript({ ...ok, somethingElse: 1 });
    expect(adopted).toMatchObject({ provider: 'cloud', source: 'cloud', complete: true, videoId: 'abcdefghijk' });
    expect(adopted).not.toHaveProperty('somethingElse');
    expect(adopted.createdAt).toBeGreaterThan(0);
  });
});

describe('the worker’s cache commands', () => {
  const posted = [];
  const realFetch = globalThis.fetch;
  let fetch;
  let seq = 0;

  beforeAll(async () => {
    globalThis.self = { postMessage: (m) => posted.push(m) };
    await import('../src/offscreen/worker.js');
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    posted.length = 0;
  });

  const send = async (data) => {
    const id = (seq += 1);
    await self.onmessage({ data: { id, ...data } });
    return posted.find((m) => m.id === id);
  };

  it('asks for a video’s script by id, language and version, with the token in a header', async () => {
    const script = { version: SCRIPT_VERSION, videoId: 'abcdefghijk', lang: 'en', cues: [], complete: true };
    globalThis.fetch = fetch = fakeFetch(200, script);
    const reply = await send({ cmd: 'cloud-get', config: { apiKey: TOKEN }, params: { videoId: 'abcdefghijk', lang: 'en' } });
    expect(reply).toMatchObject({ script });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://api.scenevoice.app/v1/scripts/abcdefghijk?lang=en&v=${SCRIPT_VERSION}`);
    expect(init.method).toBe('GET');
    expect(init.headers['x-goog-api-key']).toBe(TOKEN);
    expect(url).not.toContain(TOKEN);

    globalThis.fetch = fakeFetch(404, { error: { message: 'not found' } });
    expect(await send({ cmd: 'cloud-get', config: { apiKey: TOKEN }, params: { videoId: 'abcdefghijk', lang: 'en' } })).toMatchObject({ script: null });
    globalThis.fetch = vi.fn(async () => Promise.reject(new TypeError('offline')));
    expect(await send({ cmd: 'cloud-get', config: { apiKey: TOKEN }, params: { videoId: 'abcdefghijk', lang: 'en' } })).toMatchObject({ error: 'network' });
  });

  it('puts a finished script, and says when the relay would not take it', async () => {
    const script = { version: SCRIPT_VERSION, videoId: 'bili:BV1GJ411x7h7', lang: 'zh-CN', cues: [], complete: true };
    globalThis.fetch = fetch = fakeFetch(204, null);
    expect(await send({ cmd: 'cloud-put', config: { apiKey: TOKEN }, params: { videoId: 'bili:BV1GJ411x7h7', lang: 'zh-CN', script } })).toMatchObject({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.scenevoice.app/v1/scripts/bili%3ABV1GJ411x7h7?lang=zh-CN');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual(script);
    expect(init.headers['x-goog-api-key']).toBe(TOKEN);
    globalThis.fetch = fakeFetch(400, { error: { message: 'script invalid' } });
    expect(await send({ cmd: 'cloud-put', config: { apiKey: TOKEN }, params: { videoId: 'abcdefghijk', lang: 'en', script } })).toMatchObject({ error: 'request-failed', detail: 'script invalid' });
  });
});

describe('what the listener hears', () => {
  it('has Cloud’s own words where Gemini’s would name a key, in both languages', () => {
    for (const code of ['no-key', 'bad-key', 'forbidden', 'model-not-found', 'no-model', 'quota', 'server', 'request-failed', 'network', 'blocked', 'empty-response', 'truncated', 'bad-json', 'rate-limited', 'quota-daily', 'device-limit']) {
      const key = `error_cloud_${code.replace(/-/g, '_')}`;
      expect(STRINGS[key]?.en, key).toBeTruthy();
      expect(STRINGS[key]?.zh_CN, key).toBeTruthy();
      expect(STRINGS[key].en, key).not.toMatch(/Gemini/);
    }
    expect(STRINGS.error_cloud_no_key.en).toMatch(/Press Start free in settings/);
    expect(STRINGS.status_fallback_cloud.zh_CN).toBeTruthy();
    expect(STRINGS.provider_name_cloud.en).toBe('SceneVoice Cloud');
    expect(STRINGS.status_loaded_cloud.en).toBe('Descriptions for this video were already made by another SceneVoice user; loaded.');
  });

  it('names Cloud in an error, and keeps the shared words where Cloud has none of its own', () => {
    globalThis.chrome = fakeChrome({ locale: 'zh_CN' }).chrome;
    expect(errorMessage('no-key', 'cloud')).toBe('这台电脑还没有设置 SceneVoice 云端。请在设置页按“免费开始”领取免费额度，或者添加自己的密钥。');
    expect(errorMessage('no-key', 'gemini')).toBe('SceneVoice 需要 Gemini API 密钥，正在打开设置页面，请添加密钥。');
    expect(errorMessage('too-long', 'cloud')).toBe('这段视频即使拆成小段，模型也处理不了。请在设置页换一个模型再试。');
    globalThis.chrome = fakeChrome({ locale: 'en' }).chrome;
    expect(errorMessage('network', 'cloud')).toBe('Could not reach SceneVoice Cloud. Check your internet connection, or use a key of your own in settings.');
  });

  it('has three sample descriptions in each interface language: text on screen, a person by two features, an action', () => {
    // Every interface language shipped has a sample (pt_BR reads pt; the two Chinese locales their own).
    for (const locale of LOCALES) {
      const code = { zh_CN: 'zh-CN', zh_TW: 'zh-TW', pt_BR: 'pt' }[locale] || locale;
      expect(SAMPLE_DESCRIPTIONS[code], locale).toHaveLength(3);
      for (const line of SAMPLE_DESCRIPTIONS[code]) expect(line.trim().length).toBeGreaterThan(5);
    }
    expect(SAMPLE_DESCRIPTIONS.en[0]).toMatch(/^Title: /);
    expect(SAMPLE_DESCRIPTIONS['zh-CN'][0]).toMatch(/^标题：/);
  });
});
