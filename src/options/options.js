import { DEFAULT_API_BASE, LANGUAGES, MSG } from '../shared/constants.js';
import { bindSettings } from '../shared/form.js';
import { errorMessage, localizeDocument, t } from '../shared/i18n.js';
import { getLocal, getSettings, resolveLanguage, setLocal } from '../shared/storage.js';
import { GeminiClient, GeminiError, chooseModel, usableModels } from '../shared/gemini.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function option(value, label, lang) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (lang) o.lang = lang;
  return o;
}

function fillLanguages() {
  const select = $('language');
  select.append(option('auto', t('lang_auto')));
  for (const l of LANGUAGES) select.append(option(l.code, l.name, l.code));
}

async function fillVoices() {
  const select = $('voice');
  select.append(option('', t('set_voice_auto')));
  const res = await send({ type: MSG.GET_VOICES });
  const voices = (res?.voices || []).filter((v) => v.name).sort((a, b) => (a.lang || '').localeCompare(b.lang || '') || a.name.localeCompare(b.name));
  for (const v of voices) select.append(option(v.name, v.lang ? `${v.name} (${v.lang})` : v.name));
}

function setStatus(el, text, kind) {
  el.className = kind ? `status-${kind}` : '';
  el.textContent = text;
}

async function loadModels({ announce }) {
  const statusEl = $('keyStatus');
  const local = await getLocal();
  const select = $('model');
  if (!local.apiKey) {
    select.replaceChildren(option('', t('opt_model_none')));
    select.disabled = true;
    if (announce) setStatus(statusEl, t('opt_key_missing'), 'warn');
    return;
  }
  if (announce) setStatus(statusEl, t('opt_key_testing'));
  let res;
  try {
    const all = await new GeminiClient(local).listModels();
    res = { models: usableModels(all), recommended: chooseModel(all) };
  } catch (err) {
    setStatus(statusEl, errorMessage(err instanceof GeminiError ? err.code : 'unknown'), 'bad');
    select.replaceChildren(option(local.model || '', local.model || t('opt_model_none')));
    select.disabled = !local.model;
    return;
  }
  const models = res.models || [];
  select.replaceChildren();
  for (const m of models) {
    select.append(option(m.id, m.id === res.recommended ? `${m.id} — ${t('opt_model_recommended')}` : m.id));
  }
  let current = local.model;
  if (!current || !models.some((m) => m.id === current)) {
    current = res.recommended || models[0]?.id || '';
    await setLocal({ model: current });
  }
  select.value = current;
  select.disabled = !models.length;
  if (announce) setStatus(statusEl, models.length ? t('opt_key_ok', current) : errorMessage('no-model'), models.length ? 'good' : 'bad');
}

function updateVisibility(settings, live) {
  const shown = live || settings;
  $('srOptions').hidden = settings.output !== 'screenreader';
  $('ttsOptions').hidden = settings.output !== 'tts';
  $('rateOut').textContent = `${Number(shown.ttsRate).toFixed(1)}×`;
  $('duckOut').textContent = `${Math.round(shown.duckLevel * 100)}%`;
}

function onSaveError() {
  setStatus($('keyStatus'), t('opt_settings_save_failed'), 'bad');
}

async function renderShortcuts() {
  const body = $('shortcuts');
  body.replaceChildren();
  const commands = await chrome.commands.getAll();
  for (const c of commands) {
    if (!c.name || c.name.startsWith('_')) continue;
    const tr = document.createElement('tr');
    const action = document.createElement('td');
    action.textContent = c.description || c.name;
    const key = document.createElement('td');
    if (c.shortcut) {
      const k = document.createElement('kbd');
      k.textContent = c.shortcut;
      key.append(k);
    } else {
      key.textContent = t('opt_keys_unset');
      key.className = 'muted';
    }
    tr.append(action, key);
    body.append(tr);
  }
}

async function renderCache() {
  const info = await send({ type: MSG.CACHE_INFO });
  const kb = Math.max(1, Math.round((info?.bytes || 0) / 1024));
  $('cacheInfo').textContent = t('opt_cache_info', String(info?.count || 0), String(kb));
}

async function init() {
  localizeDocument();
  fillLanguages();
  await fillVoices();
  await bindSettings(document, updateVisibility, onSaveError);
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const local = await getLocal();
  $('apiKey').value = local.apiKey;
  $('apiBase').value = local.apiBase || DEFAULT_API_BASE;
  await loadModels({ announce: Boolean(local.apiKey) });

  $('toggleKey').addEventListener('click', (e) => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.textContent = show ? t('opt_key_hide') : t('opt_key_show');
  });

  $('saveKey').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    if (!key) {
      setStatus($('keyStatus'), t('opt_key_missing'), 'warn');
      $('apiKey').focus();
      return;
    }
    await setLocal({ apiKey: key, model: '' });
    await loadModels({ announce: true });
  });
  $('apiKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('saveKey').click();
  });

  $('removeKey').addEventListener('click', async () => {
    await setLocal({ apiKey: '', model: '' });
    $('apiKey').value = '';
    await loadModels({ announce: false });
    setStatus($('keyStatus'), t('opt_key_removed'));
  });

  $('model').addEventListener('change', async (e) => {
    await setLocal({ model: e.target.value });
    setStatus($('keyStatus'), t('opt_model_saved', e.target.value), 'good');
  });

  $('saveEndpoint').addEventListener('click', async () => {
    const value = $('apiBase').value.trim().replace(/\/+$/, '');
    let ok = false;
    try {
      const u = new URL(value);
      ok = u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
    } catch {
      ok = false;
    }
    if (!ok) {
      setStatus($('keyStatus'), t('opt_endpoint_invalid'), 'bad');
      return;
    }
    if (value !== DEFAULT_API_BASE) {
      // The manifest only grants the official endpoint; a relay needs the user's permission.
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [`${new URL(value).origin}/*`] });
      } catch {
        granted = false;
      }
      if (!granted) {
        setStatus($('keyStatus'), t('opt_endpoint_denied'), 'bad');
        return;
      }
    }
    await setLocal({ apiBase: value, model: '' });
    await loadModels({ announce: true });
  });
  $('resetEndpoint').addEventListener('click', async () => {
    $('apiBase').value = DEFAULT_API_BASE;
    await setLocal({ apiBase: DEFAULT_API_BASE, model: '' });
    await loadModels({ announce: true });
  });

  $('testVoice').addEventListener('click', async () => {
    const s = await getSettings();
    const lang = resolveLanguage(s.language, chrome.i18n.getUILanguage());
    send({ type: MSG.SPEAK, text: t('set_test_voice_sample'), lang, rate: s.ttsRate, voice: s.ttsVoice, id: 'test' });
  });

  await renderShortcuts();
  $('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  await renderCache();
  $('clearCache').addEventListener('click', async () => {
    if (!window.confirm(t('opt_cache_confirm'))) return;
    await send({ type: MSG.CACHE_CLEAR });
    await renderCache();
  });

  if (!local.apiKey) $('apiKey').focus();
}

init();
