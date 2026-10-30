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

/** Fill every element carrying data-i18n / data-i18n-attr with localized text. */
export function localizeDocument(root = document) {
  document.documentElement.lang = t('@@ui_locale').replace('_', '-');
  document.documentElement.dir = t('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
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
