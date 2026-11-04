// Which language codes SceneVoice can write descriptions in. No browser APIs:
// settings.js (normalisation) and storage.js (resolving 'auto') both use this.

import { LANGUAGES } from './constants.js';

/** Languages with their own tables (test sentence, hedging words, "At 2:15:"). */
export const TABLE_LANGUAGES = new Set(LANGUAGES.map((l) => l.code));

/**
 * Language subtags that name no language a model could write in: undetermined,
 * no linguistic content, multiple, uncoded, and the artificial-language group.
 * Private-use tags (qaa–qtz) are caught by the Intl check below.
 */
const NO_LANGUAGE = new Set(['und', 'zxx', 'mul', 'mis', 'art']);

/** A tag the browser might give, as lower-case BCP 47: "zh_TW" → "zh-tw", "iw" → "he", "in" → "id". */
export function canonicalTag(tag) {
  const dashed = String(tag || '').replace(/_/g, '-');
  try {
    return (Intl.getCanonicalLocales(dashed)[0] || dashed).toLowerCase();
  } catch {
    return dashed.toLowerCase();
  }
}

/**
 * Whether a base language code names a real language, so that a model can be
 * asked to write in it. Two or three letters, not one of the non-language
 * tags, and one this browser can name in English (Intl.DisplayNames knows
 * every ISO 639 language; "xx" or a private-use tag gets no name).
 */
export function isRealLanguage(base) {
  if (!/^[a-z]{2,3}$/.test(base) || NO_LANGUAGE.has(base)) return false;
  if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') return true;
  try {
    return Boolean(new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(base));
  } catch {
    return false;
  }
}

/**
 * A language's name in itself, for the popup's note and the transcript's intro:
 * from the list ("zh-CN" → "简体中文", "pt-BR" → by its base "pt"), else as the
 * browser names the base language ("sv-SE" → "svenska": the region is not part
 * of which language the descriptions come in), and the code itself when it has
 * no name (a private-use tag, or a runtime without Intl.DisplayNames).
 */
export function nativeName(code) {
  const tag = String(code || '');
  const base = tag.split('-')[0];
  const listed = LANGUAGES.find((l) => l.code === tag) || LANGUAGES.find((l) => l.code === base);
  if (listed) return listed.name;
  if (!base || typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') return tag;
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(base) || tag;
  } catch {
    return tag;
  }
}

/**
 * Whether descriptions can be written in this language: one with its own
 * tables, or any real language (the model writes it; SceneVoice then falls
 * back to the English tables for the "Not certain." lead and the like). The
 * service worker uses this to check the language a tab asks for.
 */
export function isDescriptionLanguage(code) {
  if (typeof code !== 'string' || !code) return false;
  return TABLE_LANGUAGES.has(code) || isRealLanguage(code);
}
