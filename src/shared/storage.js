// Settings live in chrome.storage.sync (follow the user across browsers);
// the API key and per-device options live in chrome.storage.local only.

import { DEFAULT_LOCAL, DEFAULT_SETTINGS } from './constants.js';

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
