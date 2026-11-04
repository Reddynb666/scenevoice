// The web player's strings: the same surface as shared/i18n.js (t, errorMessage,
// interfaceLocale, resetTimeText, cloudRegisterMessage, localizeDocument), read
// from the locale tables themselves instead of chrome.i18n. scripts/build.mjs
// aliases shared/i18n.js to this file in the web build, so shared modules that
// call t() (labels.js) work unchanged on the page.
//
// Two interface languages on the page: English and Simplified Chinese, chosen
// at runtime (chooseLocale). $1, $2 placeholders are substituted here.

import en from '../../scripts/locales/en.mjs';
import zhCN from '../../scripts/locales/zh_CN.mjs';

const TABLES = { en, 'zh-CN': zhCN };

/** The interface languages the page has, as BCP 47 tags. */
export const WEB_LOCALES = Object.freeze(Object.keys(TABLES));

let locale = 'en';

/**
 * Which language the page speaks: ?lang= first, then the choice remembered in
 * localStorage (the home page's "scenevoice-lang" key, so one choice carries
 * across the site), then the browser's language. Anything Chinese that is not
 * Traditional gets Simplified Chinese; everything else English.
 */
export function chooseLocale({ query = '', stored = '', language = '' } = {}) {
  const asked = String(query || stored || '').trim();
  const fromAsk = normalizeLocale(asked);
  if (fromAsk) return fromAsk;
  return normalizeLocale(language) || 'en';
}

/** A tag the page can speak, or '' when it has nothing for that language. */
function normalizeLocale(tag) {
  const s = String(tag || '').toLowerCase().replace(/_/g, '-');
  if (!s) return '';
  if (s.startsWith('zh')) return /(tw|hk|mo|hant)/.test(s) ? '' : 'zh-CN';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return '';
}

export function setLocale(tag) {
  locale = TABLES[tag] ? tag : 'en';
}

export function t(key, ...subs) {
  if (key === 'ui_lang') return locale;
  if (key === 'ui_dir') return 'ltr';
  const msg = TABLES[locale][key] ?? TABLES.en[key];
  if (typeof msg !== 'string') return key;
  return msg.replace(/\$(\d)/g, (_, n) => (subs[n - 1] == null ? '' : String(subs[n - 1])));
}

/** The message for an error code; see shared/i18n.js. */
export function errorMessage(code, provider = '') {
  const key = String(code || 'unknown').replace(/-/g, '_');
  if (provider && provider !== 'gemini') {
    const own = t(`error_${provider}_${key}`);
    if (!own.startsWith('error_')) return own;
  }
  const msg = t(`error_${key}`);
  return msg.startsWith('error_') ? t('error_unknown') : msg;
}

/** The language the interface strings are in, as a BCP 47 tag. */
export function interfaceLocale() {
  return locale;
}

export function resetTimeText(resetAt) {
  const at = Date.parse(resetAt || '');
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : t('time_midnight_utc');
}

export function cloudRegisterMessage(code, resetAt) {
  if (code === 'device-limit') return t('error_cloud_device_limit', resetTimeText(resetAt));
  if (code === 'network') return t('cloud_register_network');
  if (code === 'rate-limited') return t('cloud_register_busy');
  return errorMessage(code, 'cloud');
}

/** Fill every element carrying data-i18n / data-i18n-attr, and declare the language the text is in. */
export function localizeDocument(root = document) {
  const doc = root.ownerDocument || root;
  doc.documentElement.lang = interfaceLocale();
  doc.documentElement.dir = t('ui_dir') === 'rtl' ? 'rtl' : 'ltr';
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}
