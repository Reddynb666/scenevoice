// All interface strings, one file per language in scripts/locales/ (en.mjs is
// the reference). build.mjs turns them into _locales/*/messages.json; tests
// read them through STRINGS, keyed as { key: { en, zh_CN, … } }.
//
// To add a language, add scripts/locales/<chrome locale>.mjs (for example
// pt_BR.mjs) exporting an object with the same keys as en.mjs. It is picked up
// here by its file name. The core languages must be complete; any other may be
// partial: a missing string falls back to English, and the build prints how
// much of each language is translated.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Languages that must have every string: the build fails on a missing one. */
export const CORE_LOCALES = ['en', 'zh_CN'];

/**
 * Strings spoken into the live region during playback, in front of or between
 * descriptions. Every shipped language must have them: a partial language may
 * fall back to English on a settings page, but not in the middle of a video.
 */
export const SPOKEN_KEYS = ['late_prefix', 'status_skipped_no_pause', 'status_skipped_no_pause_setting'];

const dir = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const rank = (l) => (CORE_LOCALES.includes(l) ? CORE_LOCALES.indexOf(l) : CORE_LOCALES.length);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => f.slice(0, -4))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

/** { locale: { key: text } } for every language file. */
export const TABLES = {};
// Imported by absolute file URL on purpose: a relative template literal would
// make Vite (vitest) bake the folder's file list into its module cache, so a
// locale file added later was not seen until the cache was cleared.
for (const locale of files) TABLES[locale] = (await import(pathToFileURL(join(dir, `${locale}.mjs`)).href)).default;

/** Every language shipped, core first. */
export const LOCALES = Object.keys(TABLES);

/** { key: { locale: text } }, in the order of en.mjs. */
export const STRINGS = {};
for (const key of Object.keys(TABLES.en)) STRINGS[key] = {};
for (const [locale, table] of Object.entries(TABLES)) {
  for (const [key, text] of Object.entries(table)) if (STRINGS[key]) STRINGS[key][locale] = text;
}

/** The share of strings a language has, 0 to 1. */
export function coverage(locale) {
  const keys = Object.keys(TABLES.en);
  return keys.filter((k) => TABLES[locale]?.[k]).length / keys.length;
}

/** Keys a language has that English no longer has: stale, to be removed. */
export function strayKeys(locale) {
  return Object.keys(TABLES[locale] || {}).filter((k) => !(k in TABLES.en));
}
