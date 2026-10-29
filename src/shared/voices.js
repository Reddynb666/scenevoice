// Built-in (chrome.tts) voices: which ones speak the description language,
// the order they are offered in, and the options passed to chrome.tts.speak.
// No browser APIs here, so everything is unit-testable.

/** Chinese voices report zh, cmn (Mandarin) or yue (Cantonese). */
const BASE_ALIASES = { cmn: 'zh', yue: 'zh' };
const HANT = new Set(['tw', 'hk', 'mo', 'hant']);

function parseLang(tag) {
  const parts = String(tag || '').toLowerCase().replace(/_/g, '-').split('-').filter(Boolean);
  const base = BASE_ALIASES[parts[0]] || parts[0] || '';
  const rest = parts.slice(1);
  // Simplified and Traditional Chinese are written differently: keep them apart.
  const variant = base === 'zh' ? (rest.some((p) => HANT.has(p)) || parts[0] === 'yue' ? 'hant' : 'hans') : rest.find((p) => p.length === 2) || '';
  return { base, variant, tag: parts.join('-') };
}

/**
 * How well a voice's language suits the description language.
 * 3 same tag · 2 same language and region or script · 1 same language · 0 another language.
 * A voice that does not report a language gets 0.
 */
export function languageMatch(voiceLang, lang) {
  const v = parseLang(voiceLang);
  const d = parseLang(lang);
  if (!v.base || !d.base || v.base !== d.base) return 0;
  if (v.tag === d.tag) return 3;
  if (!d.variant || v.variant === d.variant) return 2;
  return 1;
}

const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * Split voices into those for the description language (best match first)
 * and all others (by language, then name).
 * @param {{name: string, lang?: string}[]} voices
 */
export function groupVoices(voices, lang) {
  const matching = [];
  const other = [];
  const seen = new Set();
  for (const v of voices || []) {
    if (!v?.name || seen.has(v.name)) continue;
    seen.add(v.name);
    const score = languageMatch(v.lang, lang);
    (score ? matching : other).push({ ...v, score });
  }
  matching.sort((a, b) => b.score - a.score || byName(a, b));
  // Voices that do not say their language go last.
  other.sort((a, b) => Number(!a.lang) - Number(!b.lang) || (a.lang || '').localeCompare(b.lang || '') || byName(a, b));
  return { matching, other };
}

/**
 * The voice name to request from chrome.tts, or '' to let Chrome choose by language.
 * A voice that is not installed here (settings sync between computers) is
 * dropped, as is one that must match the language and does not.
 * @param {{voiceName?: string, name?: string, lang?: string}[]} installed  chrome.tts.getVoices()
 */
export function pickVoice(installed, voice, lang, mustMatch = false) {
  if (!voice || typeof voice !== 'string') return '';
  const found = (installed || []).find((v) => (v.voiceName ?? v.name) === voice);
  if (!found) return '';
  if (mustMatch && found.lang && !languageMatch(found.lang, lang)) return '';
  return voice;
}

const clamp = (value, min, max, fallback) => {
  const n = value == null || value === '' ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Options for chrome.tts.speak from a speak message. Rate and pitch are
 * clamped to what chrome.tts accepts, whoever sent them.
 */
export function speechOptions({ lang, rate, pitch, voice, voiceMustMatch, enqueue } = {}, installed = []) {
  const opts = {
    rate: clamp(rate, 0.5, 4, 1),
    pitch: clamp(pitch, 0, 2, 1),
    enqueue: Boolean(enqueue),
  };
  if (typeof lang === 'string' && lang) opts.lang = lang;
  const name = pickVoice(installed, voice, lang, Boolean(voiceMustMatch));
  if (name) opts.voiceName = name;
  return opts;
}
