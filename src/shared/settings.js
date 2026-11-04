// Pure helpers for user preferences: validation, the speed and cycle shortcuts,
// and which built-in voice speaks a given description language.
// No browser APIs here, so everything is unit-testable.
//
// Settings sync between the user's browsers and can be written by content
// scripts, so a stored value is never trusted as is: anything unknown, of the
// wrong type or out of range falls back to its default.

import {
  DEFAULT_SETTINGS,
  DENSITIES,
  DETAILS,
  MODES,
  MSG,
  OUTPUTS,
  PROVIDERS,
  READER_SPEEDS,
  TTS_PITCH,
  TTS_RATE,
  VOICE_SAMPLES,
} from './constants.js';
import { cleanBudget } from './usage.js';
import { isDescriptionLanguage } from './language.js';
import { cleanPageShortcuts } from './shortcuts.js';

const MAX_VOICE_NAME = 200;

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return round(Math.min(max, Math.max(min, n)));
}

const oneOf = (list) => (value, fallback) => (list.includes(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

function voiceName(value, fallback) {
  return typeof value === 'string' && value.length <= MAX_VOICE_NAME ? value : fallback;
}

function voiceMap(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [lang, name] of Object.entries(value)) {
    if (isDescriptionLanguage(lang) && typeof name === 'string' && name.length <= MAX_VOICE_NAME) out[lang] = name;
  }
  return out;
}

/** The screen reader speed preset closest to a value. */
export function nearestReaderSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.readerSpeed;
  return READER_SPEEDS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), READER_SPEEDS[0]);
}

const CLEAN = {
  enabled: bool,
  mode: oneOf(MODES),
  detail: oneOf(DETAILS),
  modeChosen: bool,
  detailChosen: bool,
  densityChosen: bool,
  autoByType: bool,
  entertainmentMode: oneOf(MODES),
  entertainmentDetail: oneOf(DETAILS),
  entertainmentDensity: oneOf(DENSITIES),
  tutorialMode: oneOf(MODES),
  tutorialDetail: oneOf(DETAILS),
  tutorialDensity: oneOf(DENSITIES),
  density: oneOf(DENSITIES),
  onScreenText: bool,
  language: (v, d) => (v === 'auto' || isDescriptionLanguage(v) ? v : d),
  output: oneOf(OUTPUTS),
  interrupt: bool,
  readerSpeed: (v, d) => (v == null || v === '' ? d : nearestReaderSpeed(v)),
  ttsRate: (v, d) => clampNumber(v, TTS_RATE.min, TTS_RATE.max, d),
  ttsPitch: (v, d) => clampNumber(v, TTS_PITCH.min, TTS_PITCH.max, d),
  ttsVoices: (v) => voiceMap(v),
  ttsVoice: voiceName,
  duck: bool,
  duckLevel: (v, d) => clampNumber(v, 0.05, 0.9, d),
  showText: bool,
  autoGenerate: bool,
  announceStatus: bool,
  announceProgress: bool,
  generateHintGiven: bool,
  aiNoticeEveryTime: bool,
  pauseOnAsk: bool,
  youtubeProvider: oneOf(PROVIDERS),
  bilibiliProvider: oneOf(PROVIDERS),
  dailyBudgetSeconds: cleanBudget,
  shareDescriptions: bool,
  pageShortcuts: (v, d) => cleanPageShortcuts(v, d),
};

/** Settings the user can pick for themselves instead of leaving them to the video type. */
export const CHOICES = Object.freeze(['mode', 'detail', 'density']);

/**
 * Stored settings, with every known key present and valid. Unknown keys are
 * dropped (they stay in storage; see storage.js).
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) out[key] = CLEAN[key](src[key], fallback);
  // Saved before these flags existed: a mode, detail or density other than the
  // default can only have been picked by the user.
  for (const key of CHOICES) {
    const flag = `${key}Chosen`;
    if (typeof src[flag] !== 'boolean') out[flag] = key in src && out[key] !== DEFAULT_SETTINGS[key];
  }
  return out;
}

/**
 * A patch with the user's own choices marked. Mode, detail and density are only
 * ever saved when the user picks them (the video type adjusts them in the page,
 * never in storage), so saving one means the user chose it.
 */
export function markChoices(patch) {
  const out = { ...patch };
  for (const key of CHOICES) {
    if (key in out && !(`${key}Chosen` in out)) out[`${key}Chosen`] = true;
  }
  return out;
}

/** The value after `current` in `values`, wrapping round. */
export function nextValue(values, current) {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

/**
 * One press of the faster/slower shortcut.
 * Built-in voice: its rate moves by one slider step. Screen reader: the speed
 * SceneVoice assumes moves to the next preset (the screen reader itself is not changed).
 * @param {object} settings
 * @param {1|-1} direction
 * @returns {{key: 'ttsRate'|'readerSpeed', value: number, atLimit: boolean}}
 *   atLimit: the value could not move further in that direction
 */
export function stepSpeed(settings, direction) {
  const dir = direction < 0 ? -1 : 1;
  if (settings.output === 'tts') {
    const current = clampNumber(settings.ttsRate, TTS_RATE.min, TTS_RATE.max, DEFAULT_SETTINGS.ttsRate);
    const value = clampNumber(current + dir * TTS_RATE.step, TTS_RATE.min, TTS_RATE.max, current);
    return { key: 'ttsRate', value, atLimit: value === current };
  }
  const i = READER_SPEEDS.indexOf(nearestReaderSpeed(settings.readerSpeed));
  const j = Math.min(READER_SPEEDS.length - 1, Math.max(0, i + dir));
  return { key: 'readerSpeed', value: READER_SPEEDS[j], atLimit: i === j };
}

/**
 * Which built-in voice the user wants for a description language.
 * voiceMustMatch: the voice comes from the old single-voice setting, so use it
 * only if it speaks this language (see voices.js pickVoice).
 */
export function voiceFor(settings, lang) {
  const chosen = settings.ttsVoices?.[lang];
  if (typeof chosen === 'string') return { voice: chosen, voiceMustMatch: false };
  if (settings.ttsVoice) return { voice: settings.ttsVoice, voiceMustMatch: true };
  return { voice: '', voiceMustMatch: false };
}

/** Settings patch that sets the voice for one description language ('' = automatic). */
export function voicePatch(settings, lang, voice) {
  return { ttsVoices: { ...(settings.ttsVoices || {}), [lang]: voice } };
}

/** The message that plays the "Test voice" sample with the current settings. */
export function voiceTestMessage(settings, lang) {
  return {
    type: MSG.SPEAK,
    text: VOICE_SAMPLES[lang] || VOICE_SAMPLES.en,
    lang,
    rate: settings.ttsRate,
    pitch: settings.ttsPitch,
    ...voiceFor(settings, lang),
    id: 'test',
  };
}
