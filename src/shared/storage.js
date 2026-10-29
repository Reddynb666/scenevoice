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

import { DEFAULT_LOCAL, DEFAULT_SETTINGS } from './constants.js';

/**
 * Stop content scripts from reading chrome.storage.local.
 * Call on every service worker start: Chrome does not reliably keep the
 * access level across restarts. Does not read or write stored records, so an
 * existing key and cached scripts stay put.
 */
export function protectLocalStorage() {
  return chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
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
    if (area === 'sync' && changes.settings) fn({ ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  getSettings().then(fn);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Resolve 'auto' to a concrete description language from the browser UI language. */
export function resolveLanguage(setting, uiLanguage) {
  if (setting && setting !== 'auto') return setting;
  const ui = (uiLanguage || 'en').toLowerCase();
  if (ui.startsWith('zh')) {
    return /(tw|hk|mo|hant)/.test(ui) ? 'zh-TW' : 'zh-CN';
  }
  const base = ui.split(/[-_]/)[0];
  const known = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'ru', 'ar', 'hi'];
  return known.includes(base) ? base : 'en';
}
