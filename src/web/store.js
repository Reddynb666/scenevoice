// What the web player keeps in the browser: the listener's choices, the key
// (local storage when "remember" is on, session storage otherwise), the
// SceneVoice Cloud device token, and finished description scripts by
// videoId + language + script version, so a second visit is instant.
// Every read and write is wrapped: storage can be off (private window) or full.

import { SCRIPT_VERSION } from '../shared/constants.js';
import { normalizeSettings } from '../shared/settings.js';

export const SETTINGS_KEY = 'scenevoice-play-settings';
export const KEY_KEY = 'scenevoice-play-key';
export const TOKEN_KEY = 'scenevoice-play-device';
export const SCRIPT_PREFIX = 'scenevoice-play-script:';
/** Finished scripts kept; the oldest go when a new one does not fit. */
export const SCRIPT_LIMIT = 40;

const SOURCES = new Set(['own', 'cloud']);

/** The choices the page offers, with the extension's defaults, plus who writes the descriptions. */
export const WEB_DEFAULTS = Object.freeze({ mode: 'gaps', detail: 'standard', density: 'standard', output: 'screenreader', readerSpeed: 1.6, ttsRate: 1.2, source: 'own' });

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function readJson(storage, key) {
  const raw = safe(() => storage?.getItem(key), null);
  if (!raw) return null;
  return safe(() => JSON.parse(raw), null);
}

function writeJson(storage, key, value) {
  return safe(() => {
    storage.setItem(key, JSON.stringify(value));
    return true;
  }, false);
}

/** The listener's choices, validated like the extension's settings. */
export function loadSettings(local) {
  const raw = readJson(local, SETTINGS_KEY) || {};
  const s = normalizeSettings({ ...WEB_DEFAULTS, ...raw });
  return {
    mode: s.mode,
    detail: s.detail,
    density: s.density,
    output: s.output,
    readerSpeed: s.readerSpeed,
    ttsRate: s.ttsRate,
    source: SOURCES.has(raw.source) ? raw.source : WEB_DEFAULTS.source,
  };
}

export function saveSettings(local, settings) {
  const { mode, detail, density, output, readerSpeed, ttsRate, source } = settings;
  return writeJson(local, SETTINGS_KEY, { mode, detail, density, output, readerSpeed, ttsRate, source });
}

/** The saved Gemini key: { key, remembered }. A remembered key lives in local storage, the other in the session's. */
export function loadKey({ local, session }) {
  const kept = safe(() => local?.getItem(KEY_KEY), '') || '';
  if (kept) return { key: kept, remembered: true };
  return { key: safe(() => session?.getItem(KEY_KEY), '') || '', remembered: false };
}

/** Keep the key in one place only: forgetting it in the other, so an unchecked "remember" really forgets. */
export function saveKey({ local, session }, key, remember) {
  const value = String(key || '').trim();
  safe(() => local?.removeItem(KEY_KEY));
  safe(() => session?.removeItem(KEY_KEY));
  if (!value) return;
  safe(() => (remember ? local : session)?.setItem(KEY_KEY, value));
}

export function loadToken(local) {
  return safe(() => local?.getItem(TOKEN_KEY), '') || '';
}

export function saveToken(local, token) {
  if (!token) safe(() => local?.removeItem(TOKEN_KEY));
  else safe(() => local?.setItem(TOKEN_KEY, token));
}

export const scriptKey = (videoId, lang) => `${SCRIPT_PREFIX}${videoId}:${lang}:v${SCRIPT_VERSION}`;

/** A saved script for this video and language at this script version, or null. */
export function loadScript(local, videoId, lang) {
  const sc = readJson(local, scriptKey(videoId, lang));
  if (!sc || sc.version !== SCRIPT_VERSION || sc.videoId !== videoId || !Array.isArray(sc.cues)) return null;
  return sc;
}

function scriptKeys(local) {
  const out = [];
  const n = safe(() => local.length, 0);
  for (let i = 0; i < n; i += 1) {
    const k = safe(() => local.key(i), null);
    if (k && k.startsWith(SCRIPT_PREFIX)) out.push(k);
  }
  return out;
}

/** Drop the oldest saved scripts until `keep` or fewer remain (the one being written is not counted). */
function evict(local, keep, except) {
  const keys = scriptKeys(local).filter((k) => k !== except);
  if (keys.length <= keep) return;
  const dated = keys.map((k) => ({ k, at: Number(readJson(local, k)?.updatedAt) || 0 })).sort((a, b) => a.at - b.at);
  for (const { k } of dated.slice(0, keys.length - keep)) safe(() => local.removeItem(k));
}

/** Save a script (complete or part-way); when storage is full the oldest scripts make room. */
export function saveScript(local, script) {
  if (!local || !script?.videoId || !script?.lang) return false;
  const key = scriptKey(script.videoId, script.lang);
  evict(local, SCRIPT_LIMIT - 1, key);
  if (writeJson(local, key, script)) return true;
  evict(local, 0, key);
  return writeJson(local, key, script);
}

export function deleteScript(local, videoId, lang) {
  safe(() => local?.removeItem(scriptKey(videoId, lang)));
}
