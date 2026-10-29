import { DEFAULT_API_BASE, LANGUAGES, MSG } from '../shared/constants.js';
import { bindSettings } from '../shared/form.js';
import { errorMessage, localizeDocument, t } from '../shared/i18n.js';
import { voiceFor, voicePatch, voiceTestMessage } from '../shared/settings.js';
import { getLocal, getSettings, resetSettings, resolveLanguage, setLocal, setSettings } from '../shared/storage.js';
import { groupVoices, languageMatch, pickVoice } from '../shared/voices.js';
import { GeminiClient, GeminiError, chooseModel, usableModels } from '../shared/gemini.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const uiLanguage = () => chrome.i18n.getUILanguage();

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

/** A language tag in the interface language: "zh-CN" → "Simplified Chinese" / "简体中文". */
function languageName(tag) {
  const display = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[tag] || tag;
  try {
    return new Intl.DisplayNames([uiLanguage()], { type: 'language' }).of(display) || tag;
  } catch {
    return LANGUAGES.find((l) => l.code === tag)?.name || tag;
  }
}

// ---------- built-in voices ----------

/** Voices on this computer, from the service worker: [{ name, lang }]. */
let voices = [];
/** Description language the voice list was last built for. */
let voicesFor = null;

async function loadVoices() {
  const res = await send({ type: MSG.GET_VOICES });
  voices = (res?.voices || []).filter((v) => v.name);
}

function voiceOption(v) {
  return option(v.name, v.lang ? t('voice_option', v.name, languageName(v.lang)) : v.name, v.lang);
}

/**
 * The voice list for the current description language: its voices first,
 * then the rest. Rebuilt only when the language changes, so a screen reader
 * does not lose its place in the list after each choice.
 */
function renderVoices(settings) {
  const lang = resolveLanguage(settings.language, uiLanguage());
  const name = languageName(lang);
  const select = $('voice');
  const { voice, voiceMustMatch } = voiceFor(settings, lang);
  const installed = voices.find((v) => v.name === voice);
  const { matching, other } = groupVoices(voices, lang);

  if (voicesFor !== lang) {
    voicesFor = lang;
    $('voiceLabel').textContent = t('set_voice_for', name);
    select.replaceChildren(option('', t('set_voice_auto')));
    for (const [label, list] of [[t('set_voice_group_matching', name), matching], [t('set_voice_group_other'), other]]) {
      if (!list.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      group.append(...list.map(voiceOption));
      select.append(group);
    }
  }

  // A voice chosen on another computer that this one does not have.
  select.querySelector('option[data-missing]')?.remove();
  if (voice && !voiceMustMatch && !installed) {
    const o = option(voice, t('set_voice_unavailable', voice));
    o.dataset.missing = 'true';
    select.append(o);
  }
  // The old single voice counts only where it would be used: in its own language.
  select.value = voiceMustMatch ? pickVoice(voices, voice, lang, true) : voice;

  let note = '';
  if (!matching.length) note = t('set_voice_none', name);
  else if (voice && !voiceMustMatch && !installed) note = t('set_voice_unavailable_note');
  else if (installed?.lang && !voiceMustMatch && !languageMatch(installed.lang, lang)) note = t('set_voice_mismatch', languageName(installed.lang), name);
  if ($('voiceNote').textContent !== note) $('voiceNote').textContent = note;
}

async function onVoiceChange(e) {
  const settings = await getSettings();
  const lang = resolveLanguage(settings.language, uiLanguage());
  try {
    await setSettings(voicePatch(settings, lang, e.target.value));
  } catch {
    onSaveError();
  }
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

/**
 * The video type settings: a type's mode and detail can be changed only while
 * adjusting is on; a mode or detail the user picked is named, with a way back.
 */
function renderTypeSettings(settings) {
  for (const id of ['typeEntertainment', 'typeTutorial']) $(id).disabled = !settings.autoByType;
  const { modeChosen, detailChosen } = settings;
  const key = modeChosen && detailChosen ? 'type_chosen_both' : modeChosen ? 'type_chosen_mode' : detailChosen ? 'type_chosen_detail' : '';
  const text = settings.autoByType && key ? t(key) : '';
  if ($('typeChosen').textContent !== text) $('typeChosen').textContent = text;
  $('typeChosenBox').hidden = !text;
}

async function letTypeDecide() {
  try {
    await setSettings({ modeChosen: false, detailChosen: false });
  } catch {
    onSaveError();
    return;
  }
  // The button is gone now: keep focus nearby, on the switch it belongs to.
  $('autoByType').focus();
  setToast(t('type_again_done'), 'good');
}

function onSettings(settings, live) {
  $('srOptions').hidden = settings.output !== 'screenreader';
  $('ttsOptions').hidden = settings.output !== 'tts';
  if (live) return; // a slider is moving, nothing else changed
  renderVoices(settings);
  renderTypeSettings(settings);
}

/** Messages about settings, kept in view at the bottom of the window and read by screen readers. */
function setToast(text, kind) {
  $('settingsStatus').className = kind ? `toast status-${kind}` : 'toast';
  $('settingsStatus').textContent = text;
}

function onSaveError() {
  setToast(t('opt_settings_save_failed'), 'bad');
}

async function restoreDefaults() {
  if (!window.confirm(t('opt_reset_confirm'))) return;
  try {
    await resetSettings();
  } catch {
    setToast(t('opt_reset_failed'), 'bad');
    return;
  }
  // The form follows on its own, through storage.onChanged.
  setToast(t('opt_reset_done'), 'good');
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
  await loadVoices();
  await bindSettings(document, onSettings, onSaveError);
  $('voice').addEventListener('change', onVoiceChange);
  // The next change replaces the last settings message (a failed save says so again).
  document.addEventListener('change', () => setToast(''));
  if (!voices.length) {
    // Some systems load their voices only after the first request.
    setTimeout(async () => {
      await loadVoices();
      if (!voices.length) return;
      voicesFor = null;
      renderVoices(await getSettings());
    }, 1500);
  }
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
    send(voiceTestMessage(s, resolveLanguage(s.language, uiLanguage())));
  });
  $('resetSettings').addEventListener('click', restoreDefaults);
  $('typeAgain').addEventListener('click', letTypeDecide);

  await renderShortcuts();
  $('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Back from Chrome's shortcuts page: show the keys just set.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderShortcuts();
  });

  await renderCache();
  $('clearCache').addEventListener('click', async () => {
    if (!window.confirm(t('opt_cache_confirm'))) return;
    await send({ type: MSG.CACHE_CLEAR });
    await renderCache();
  });

  if (!local.apiKey) $('apiKey').focus();
}

init();
