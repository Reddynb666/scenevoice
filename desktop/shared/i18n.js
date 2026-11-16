// Interface strings of the desktop shell. Every user-facing string lives in
// desktop/locales/<lang>.mjs (never in scripts/locales, which is the
// extension's); en.mjs is the reference and zh_CN.mjs must have the same keys
// and placeholders (test/locales.test.js). Used by the main process and by
// the page.

import en from '../locales/en.mjs';
import zhCN from '../locales/zh_CN.mjs';

export const LOCALES = Object.freeze({ en, zh_CN: zhCN });

/** The interface language for an operating system locale: Chinese for zh*, English otherwise. */
export function pickLanguage(osLocale) {
  return /^zh\b/i.test(String(osLocale || '').replace(/_/g, '-')) ? 'zh_CN' : 'en';
}

/** The names in curly brackets a string expects, sorted. */
export function placeholders(template) {
  return [...new Set(String(template).match(/\{\w+\}/g) || [])].sort();
}

/**
 * @param {string} lang  a key of LOCALES; anything else gives English
 * @returns {(key: string, vars?: Record<string, string|number>) => string}
 */
export function createT(lang) {
  const table = LOCALES[lang] || en;
  return function t(key, vars) {
    const template = table[key] ?? en[key];
    if (template == null) return key;
    return String(template).replace(/\{(\w+)\}/g, (whole, name) => (vars && vars[name] != null ? String(vars[name]) : whole));
  };
}
