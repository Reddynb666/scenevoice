// Settings live in chrome.storage.sync (follow the user across browsers) and
// contain no secrets, so content scripts may read and update them directly.
// The API key and per-device options live in chrome.storage.local only.
// protectLocalStorage() limits that area to the service worker and extension
// pages. Content scripts cannot read it; they ask the service worker for a
// cached description script instead.
//
// The key stays in local storage, next to the description cache. Session
// storage is trusted by default but is wiped when the browser closes, which
// would drop the key. Existing installs already have both the key (`local`)
// and cached scripts (`script:*`) here, so nothing is moved or rewritten.

import { DEFAULT_LOCAL } from './constants.js';
import { TABLE_LANGUAGES, canonicalTag, isRealLanguage } from './language.js';

export { isDescriptionLanguage } from './language.js';
import { markChoices, normalizeSettings } from './settings.js';

/**
 * Stop content scripts from reading chrome.storage.local.
 * Call on every service worker start: Chrome does not reliably keep the
 * access level across restarts. Does not read or write stored records, so an
 * existing key and cached scripts stay put.
 */
export function protectLocalStorage() {
  return chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

async function storedSettings() {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  } catch {
    return {};
  }
}

export async function getSettings() {
  return normalizeSettings(await storedSettings());
}

// Saving reads the stored settings and writes them back with the change. Two
// saves from the same page (two quick choices) run one after the other, or
// the second would write back what it read before the first had saved.
let queue = Promise.resolve();
const inTurn = (fn) => {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
};

/**
 * Save some settings. Keys this version does not know are kept as stored, so
 * a newer SceneVoice on another synced computer does not lose them. A mode or
 * detail saved here is the user's own choice (see markChoices).
 */
export function setSettings(patch) {
  return inTurn(async () => {
    const stored = await storedSettings();
    const next = normalizeSettings({ ...stored, ...markChoices(patch) });
    await chrome.storage.sync.set({ settings: { ...stored, ...next } });
    return next;
  });
}

/** Back to the defaults. Only preferences: the API key, model and cache are not touched. */
export function resetSettings() {
  return inTurn(async () => {
    await chrome.storage.sync.remove('settings');
    return normalizeSettings({});
  });
}

export async function getLocal() {
  const stored = await chrome.storage.local.get('local');
  return { ...DEFAULT_LOCAL, ...(stored.local || {}) };
}

export async function setLocal(patch) {
  const current = await getLocal();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ local: next });
  return next;
}

/** Call fn(settings) now and whenever settings change. Returns an unsubscribe function. */
export function watchSettings(fn) {
  const listener = (changes, area) => {
    if (area === 'sync' && changes.settings) fn(normalizeSettings(changes.settings.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  getSettings().then(fn);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Resolve 'auto' to a concrete description language from the browser UI
 * language. On Bilibili, a Chinese site whose videos and subtitles are in
 * Chinese, 'auto' means Chinese even in a browser set to another language.
 * Any real language is returned, not only those with their own tables: a
 * Swedish browser gets Swedish descriptions. Only a tag that names no language
 * ("und", "xx") falls back to English.
 */
export function resolveLanguage(setting, uiLanguage, platform = '') {
  if (setting && setting !== 'auto') return setting;
  const ui = canonicalTag(uiLanguage || 'en');
  if (ui.startsWith('zh')) {
    return /(tw|hk|mo|hant)/.test(ui) ? 'zh-TW' : 'zh-CN';
  }
  if (platform === 'bilibili') return 'zh-CN';
  const base = ui.split('-')[0];
  if (TABLE_LANGUAGES.has(base)) return base;
  return isRealLanguage(base) ? base : 'en';
}
