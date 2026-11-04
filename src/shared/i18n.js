// Thin wrapper over chrome.i18n with a safe fallback.

export function t(key, ...subs) {
  try {
    const msg = chrome.i18n.getMessage(key, subs.map(String));
    if (msg) return msg;
  } catch {
    /* not in an extension context (tests) */
  }
  return key;
}

/**
 * The message for an error code. A provider other than Gemini may have its own
 * words for it (error_qwen_bad_key): the Gemini messages name Gemini.
 */
export function errorMessage(code, provider = '') {
  const key = String(code || 'unknown').replace(/-/g, '_');
  if (provider && provider !== 'gemini') {
    const own = t(`error_${provider}_${key}`);
    if (!own.startsWith('error_')) return own;
  }
  const msg = t(`error_${key}`);
  return msg.startsWith('error_') ? t('error_unknown') : msg;
}

/**
 * The language the interface strings are in, as a BCP 47 tag ("en", "zh-CN"):
 * the _locales folder they were loaded from (build.mjs writes ui_lang into
 * each), not @@ui_locale, which is the browser's locale. The two differ for
 * every browser language without a folder of its own: the strings are then
 * English, and a page declaring Italian or Hebrew would have a screen reader
 * read English with an Italian voice, or lay it out right to left.
 */
export function interfaceLocale() {
  const lang = t('ui_lang');
  return lang === 'ui_lang' ? 'en' : lang;
}

/** When a Cloud allowance or limit opens again, as a clock time on this computer, or "midnight UTC" when the relay did not say. */
export function resetTimeText(resetAt) {
  const at = Date.parse(resetAt || '');
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : t('time_midnight_utc');
}

/**
 * Why Start free could not get a device token, from the error's code. The
 * generation-time Cloud messages do not fit here: nothing has been described
 * yet, so there is nothing "saved so far", and the listener is on the page that
 * holds the other way, so "in settings" points nowhere. The network's daily
 * limit on new devices is not a wait-a-minute error: it says when it opens again.
 */
export function cloudRegisterMessage(code, resetAt) {
  if (code === 'device-limit') return t('error_cloud_device_limit', resetTimeText(resetAt));
  if (code === 'network') return t('cloud_register_network');
  if (code === 'rate-limited') return t('cloud_register_busy');
  return errorMessage(code, 'cloud');
}

/** Fill every element carrying data-i18n / data-i18n-attr with localized text, and declare the language the text is in. */
export function localizeDocument(root = document) {
  document.documentElement.lang = interfaceLocale();
  document.documentElement.dir = t('ui_dir') === 'rtl' ? 'rtl' : 'ltr';
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
