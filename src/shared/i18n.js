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

export function errorMessage(code) {
  const msg = t(`error_${String(code || 'unknown').replace(/-/g, '_')}`);
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
