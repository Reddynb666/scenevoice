// SceneVoice Cloud has one switch, CLOUD_OPEN in src/shared/constants.js, and
// it is off: the relay is not deployed. What "off" means, in one place: the
// switch itself, the manifest the build writes (no host permission for the
// relay), the providers and settings (no site is ever Cloud's), the relay's own
// requests (none is sent), and the words that would point a listener at Cloud.
// The same functions are checked with the switch on, so opening Cloud later is
// the one-line change the constant's comment promises. The pages (welcome,
// settings, popup), the service worker, the offscreen worker and the web player
// are tested in both states in pages.test.js, background.test.js, cloud.test.js
// and web-player.test.js.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { STRINGS } from '../scripts/locales.mjs';
import { CLOUD_HOST_PERMISSION, stampManifest } from '../scripts/manifest.mjs';
import { activateLicense, cloudRequest, fetchMe, forgetClosedCloud, registerDevice } from '../src/shared/cloud.js';
import { CLOUD_API_BASE, CLOUD_OPEN, DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { createClient } from '../src/shared/describe.js';
import { effectiveProvider, offeredProviders, providerFor } from '../src/shared/providers.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { makeClient, registerWebDevice } from '../src/web/model.js';
import { loadSettings } from '../src/web/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const TOKEN = `svd_${'0123456789abcdef'.repeat(2)}`;
const MODEL_HOSTS = ['https://generativelanguage.googleapis.com/*', 'https://dashscope.aliyuncs.com/*'];
/** The relay's host name, as the code has it: a placeholder while Cloud is closed (test/no-foreign-domain.test.js). */
const RELAY_HOSTNAME = new URL(CLOUD_API_BASE).hostname;

describe('the switch', () => {
  it('is off, on one line the test build can find', () => {
    expect(CLOUD_OPEN).toBe(false);
    // scripts/build.mjs turns exactly this line on for the end-to-end build of the open state.
    expect(read('src/shared/constants.js')).toMatch(/^export const CLOUD_OPEN = false;$/m);
    expect(read('scripts/build.mjs')).toContain("const SWITCH_LINE = 'export const CLOUD_OPEN = false;';");
  });

  it('cannot be forced on for a package, a watch build or the web player', () => {
    const build = read('scripts/build.mjs');
    expect(build).toMatch(/if \(forcedOpen && \(args\.has\('--zip'\) \|\| args\.has\('--web'\) \|\| args\.has\('--watch'\)\)\) \{[^}]*process\.exit\(1\)/);
    // The forced build never lands in dist/, which is what gets packaged and loaded by hand.
    expect(build).toContain("forcedOpen ? join(root, 'test', 'e2e', 'output', 'dist-cloud-open') : join(root, 'dist')");
  });
});

describe('the manifest the build writes', () => {
  const source = JSON.parse(read('static/manifest.json'));

  it('in the repository names the two model hosts and nothing of the relay', () => {
    expect(source.host_permissions).toEqual(MODEL_HOSTS);
    expect(JSON.stringify(source)).not.toContain(RELAY_HOSTNAME);
  });

  it('closed: the two model hosts, the version, and nothing about the relay anywhere', () => {
    const built = stampManifest(source, { version: '9.8.7', cloudOpen: false });
    expect(built.version).toBe('9.8.7');
    expect(built.host_permissions).toEqual(MODEL_HOSTS);
    expect(JSON.stringify(built)).not.toContain(RELAY_HOSTNAME);
    // Everything else is the source manifest, untouched.
    expect({ ...built, version: source.version }).toEqual(source);
    // By default it follows the constant, which is off.
    expect(stampManifest(source, { version: '9.8.7' })).toEqual(built);
  });

  it('open: the relay’s host is added, once, after the model hosts, from the address the code uses', () => {
    expect(CLOUD_HOST_PERMISSION).toBe(`${CLOUD_API_BASE}/*`);
    const built = stampManifest(source, { version: '9.8.7', cloudOpen: true });
    expect(built.host_permissions).toEqual([...MODEL_HOSTS, CLOUD_HOST_PERMISSION]);
    // Stamping what is already stamped, or closing it again, neither doubles nor leaves the host.
    expect(stampManifest(built, { version: '9.8.7', cloudOpen: true }).host_permissions).toEqual([...MODEL_HOSTS, CLOUD_HOST_PERMISSION]);
    expect(stampManifest(built, { version: '9.8.7', cloudOpen: false }).host_permissions).toEqual(MODEL_HOSTS);
    // The argument is not changed.
    expect(source.host_permissions).toEqual(MODEL_HOSTS);
  });

  it('is what the build uses, with the switch the build was given', () => {
    const build = read('scripts/build.mjs');
    expect(build).toContain("import { relayAddressProblem, stampManifest } from './manifest.mjs';");
    expect(build).toMatch(/stampManifest\(JSON\.parse\(readFileSync\(join\(dist, 'manifest\.json'\), 'utf8'\)\), \{ version: pkg\.version, cloudOpen \}\)/);
    expect(build).toContain('const cloudOpen = forcedOpen || CLOUD_OPEN;');
  });
});

describe('providers and settings', () => {
  const cloudChosen = { ...DEFAULT_SETTINGS, youtubeProvider: 'cloud', bilibiliProvider: 'cloud' };
  const everyKeys = [
    { gemini: false, qwen: false, cloud: true },
    { gemini: true, qwen: false, cloud: true },
    { gemini: false, qwen: true, cloud: true },
    { gemini: true, qwen: true, cloud: true },
    { gemini: false, qwen: false, cloud: false },
  ];

  it('closed: Cloud is not on offer, a stored choice of Cloud is the site’s default, and nothing falls back to Cloud', () => {
    expect(offeredProviders()).toEqual(['gemini', 'qwen']);
    expect(providerFor(cloudChosen, 'youtube')).toBe('gemini');
    expect(providerFor(cloudChosen, 'bilibili')).toBe('qwen');
    for (const settings of [DEFAULT_SETTINGS, cloudChosen]) {
      for (const keys of everyKeys) {
        for (const site of ['youtube', 'bilibili']) expect(effectiveProvider(settings, site, keys), JSON.stringify(keys)).not.toBe('cloud');
      }
    }
    // A token and no key: the site keeps its own model (and the listener is asked for that key).
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', { gemini: false, qwen: false, cloud: true })).toBe('gemini');
    // One key of their own still describes every site.
    expect(effectiveProvider(cloudChosen, 'youtube', { gemini: false, qwen: true, cloud: true })).toBe('qwen');
  });

  it('closed: stored settings read as the defaults for the sites, and sharing as off', () => {
    expect(normalizeSettings({ youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true })).toMatchObject({ youtubeProvider: 'gemini', bilibiliProvider: 'qwen', shareDescriptions: false });
    // A choice between the listener's own models is kept.
    expect(normalizeSettings({ youtubeProvider: 'qwen', bilibiliProvider: 'gemini' })).toMatchObject({ youtubeProvider: 'qwen', bilibiliProvider: 'gemini' });
    // The web player: a saved choice of Cloud reads as the own key.
    const local = { getItem: () => JSON.stringify({ source: 'cloud', mode: 'pause' }) };
    expect(loadSettings(local)).toMatchObject({ source: 'own', mode: 'pause' });
    expect(loadSettings(local, { cloudOpen: true })).toMatchObject({ source: 'cloud', mode: 'pause' });
  });

  it('open: the same functions give Cloud back', () => {
    expect(offeredProviders(true)).toEqual(['gemini', 'qwen', 'cloud']);
    expect(providerFor(cloudChosen, 'youtube', true)).toBe('cloud');
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', { gemini: false, qwen: false, cloud: true }, true)).toBe('cloud');
    expect(normalizeSettings({ youtubeProvider: 'cloud', shareDescriptions: true }, { cloudOpen: true })).toMatchObject({ youtubeProvider: 'cloud', shareDescriptions: true });
  });
});

describe('requests to the relay', () => {
  it('closed: none is made, by any of the relay’s own routes or by a client for it', async () => {
    const fetch = vi.fn(async () => ({ status: 200, json: async () => ({ token: TOKEN }) }));
    await expect(cloudRequest(fetch, '/v1/me', { token: TOKEN })).rejects.toMatchObject({ code: 'cloud-closed' });
    await expect(registerDevice(fetch, { version: '1.2.0', locale: 'en' })).rejects.toMatchObject({ code: 'cloud-closed' });
    await expect(fetchMe(fetch, TOKEN)).rejects.toMatchObject({ code: 'cloud-closed' });
    await expect(activateLicense(fetch, TOKEN, 'svl-ABCD-EFGH-IJKL')).rejects.toMatchObject({ code: 'cloud-closed' });
    await expect(registerWebDevice(fetch, { version: '1.2.0', locale: 'en' })).rejects.toMatchObject({ code: 'cloud-closed' });
    expect(() => createClient('cloud', { apiKey: TOKEN })).toThrow(/cloud-closed/);
    expect(() => makeClient({ source: 'cloud', token: TOKEN, fetchImpl: fetch })).toThrow(/cloud-closed/);
    expect(fetch).not.toHaveBeenCalled();
    // A key of the listener's own is untouched by the switch.
    expect(createClient('gemini', { apiKey: 'k', model: 'm' }).apiKey).toBe('k');
    expect(createClient('qwen', { apiKey: 'q', model: 'm' }).apiKey).toBe('q');
    expect(makeClient({ source: 'own', key: 'k', fetchImpl: fetch }).apiBase).toBe('https://generativelanguage.googleapis.com');
  });

  it('open: the request goes out', async () => {
    const fetch = vi.fn(async () => ({ status: 200, json: async () => ({ plan: 'free' }) }));
    expect(await cloudRequest(fetch, '/v1/me', { token: TOKEN, open: true })).toEqual({ status: 200, body: { plan: 'free' } });
    expect(fetch.mock.calls[0][0]).toBe(`${CLOUD_API_BASE}/v1/me`);
    expect(makeClient({ source: 'cloud', token: TOKEN, fetchImpl: fetch, cloudOpen: true }).apiBase).toBe(CLOUD_API_BASE);
  });
});

describe('the words used while Cloud is closed', () => {
  // What a listener can meet with the switch off: none of it offers Cloud, an allowance or Start free.
  const CLOSED_KEYS = ['welcome_intro_own', 'welcome_step2_title_own', 'welcome_own_only', 'welcome_sample_done_own', 'welcome_sample_silent', 'popup_setup_body_own', 'privacy_1_own', 'privacy_4_own', 'web_key_missing_own', 'web_privacy_leaves_own', 'web_privacy_local_own'];

  it('exist in English and Chinese and do not mention Cloud, a free allowance or the relay', () => {
    for (const key of CLOSED_KEYS) {
      for (const locale of ['en', 'zh_CN']) {
        const text = STRINGS[key]?.[locale];
        expect(text, `${key} ${locale}`).toBeTruthy();
        expect(text, `${key} ${locale}`).not.toMatch(/Cloud\b(?! Model Studio)|云端|allowance|Start free|免费开始|免费额度|relay|中转|device token|设备凭证/);
        expect(text, `${key} ${locale}`).not.toContain(RELAY_HOSTNAME);
      }
    }
  });

  it('say that Cloud is not open where a leftover token or a stray request still meets it', () => {
    expect(STRINGS.error_cloud_closed.en).toBe('SceneVoice Cloud is not open yet. Add a key of your own on the settings page.');
    expect(STRINGS.error_cloud_closed.zh_CN).toMatch(/还没有开放/);
    expect(STRINGS.opt_cloud_closed_token.en).toMatch(/not open in this version.*nothing is sent to it.*“Stop using Cloud” removes it/);
    expect(STRINGS.opt_cloud_closed_token.zh_CN).toMatch(/没有开放.*“停用云端”/);
  });
});

describe('what an update forgets while Cloud is closed', () => {
  /** A fake of the two stores, with what is saved to each. */
  function stores(local, settings) {
    const saved = { local: [], settings: [] };
    return {
      saved,
      fns: {
        getLocal: async () => local,
        setLocal: async (patch) => saved.local.push(patch),
        storedSettings: async () => settings,
        setSettings: async (patch) => saved.settings.push(patch),
      },
    };
  }

  it('removes a token an earlier version saved, and a site left set to Cloud with sharing on', async () => {
    const { fns, saved } = stores({ cloudToken: TOKEN, cloudPlan: 'free', apiKey: 'k' }, { youtubeProvider: 'cloud', bilibiliProvider: 'qwen', shareDescriptions: true });
    expect(await forgetClosedCloud(fns, { open: false })).toEqual({ token: true, settings: true });
    // The user's own key is not touched: only the two Cloud fields are emptied.
    expect(saved.local).toEqual([{ cloudToken: '', cloudPlan: '' }]);
    // Saving nothing writes the settings back as they read while closed (normalizeSettings).
    expect(saved.settings).toEqual([{}]);
    expect(normalizeSettings({ youtubeProvider: 'cloud', shareDescriptions: true }, { cloudOpen: false })).toMatchObject({ youtubeProvider: DEFAULT_SETTINGS.youtubeProvider, shareDescriptions: false });
  });

  it('writes nothing when there is nothing of Cloud', async () => {
    const { fns, saved } = stores({ apiKey: 'k', cloudToken: '', cloudPlan: '' }, { youtubeProvider: 'gemini', shareDescriptions: false });
    expect(await forgetClosedCloud(fns, { open: false })).toEqual({ token: false, settings: false });
    expect(saved).toEqual({ local: [], settings: [] });
    const empty = stores(undefined, undefined);
    expect(await forgetClosedCloud(empty.fns, { open: false })).toEqual({ token: false, settings: false });
    expect(empty.saved).toEqual({ local: [], settings: [] });
  });

  it('keeps everything once Cloud is open', async () => {
    const { fns, saved } = stores({ cloudToken: TOKEN, cloudPlan: 'plus' }, { youtubeProvider: 'cloud', shareDescriptions: true });
    expect(await forgetClosedCloud(fns, { open: true })).toEqual({ token: false, settings: false });
    expect(saved).toEqual({ local: [], settings: [] });
  });

  it('is what the service worker does on update, and only then', () => {
    const background = read('src/background/index.js');
    expect(background).toMatch(/if \(reason === 'update'\) \{[\s\S]{0,260}forgetClosedCloud\(\{ getLocal, setLocal, storedSettings, setSettings \}\)/);
  });
});
