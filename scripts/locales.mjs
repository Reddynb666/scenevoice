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
import { fileURLToPath } from 'node:url';

/** Languages that must have every string: the build fails on a missing one. */
export const CORE_LOCALES = ['en', 'zh_CN'];

const dir = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const rank = (l) => (CORE_LOCALES.includes(l) ? CORE_LOCALES.indexOf(l) : CORE_LOCALES.length);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => f.slice(0, -4))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

/** { locale: { key: text } } for every language file. */
export const TABLES = {};
for (const locale of files) TABLES[locale] = (await import(`./locales/${locale}.mjs`)).default;

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
