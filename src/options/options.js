import { DEFAULT_API_BASE, DEFAULT_QWEN_API_BASE, DEFAULT_QWEN_MODEL, DEFAULT_SETTINGS, LANGUAGES, MSG, RTL_LANGUAGES, USAGE_KEY } from '../shared/constants.js';
import { COUNTED_PROVIDERS, costText, formatTokens, todaysUsage } from '../shared/usage.js';
import { activateLicense, allowanceMinutes, cleanPlan, fetchMe, registerDevice, validLicenseKey } from '../shared/cloud.js';
import { ApiError } from '../shared/errors.js';
import { bindSettings } from '../shared/form.js';
import { cloudRegisterMessage, errorMessage, localizeDocument, resetTimeText, t } from '../shared/i18n.js';
import { typeChosenText } from '../shared/labels.js';
import { CHOICES, voiceFor, voicePatch, voiceTestMessage } from '../shared/settings.js';
import { getLocal, getSettings, resetSettings, resolveLanguage, setLocal, setSettings } from '../shared/storage.js';
import { groupVoices, languageMatch, pickVoice } from '../shared/voices.js';
import { GeminiClient, GeminiError, chooseModel, usableModels } from '../shared/gemini.js';
import { QwenClient } from '../shared/qwen.js';

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
  for (const l of LANGUAGES) {
    const o = option(l.code, l.name, l.code);
    if (RTL_LANGUAGES.includes(l.code)) o.dir = 'rtl'; // the name is written right to left
    select.append(o);
  }
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
  if (announce) setStatus(statusEl, models.length ? `${t('opt_key_ok', current)} ${await nextStep('gemini')}` : errorMessage('no-model'), models.length ? 'good' : 'bad');
}

/** An address the user typed for an API: https, or http on this computer. */
function validEndpoint(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch {
    return false;
  }
}

/** The manifest grants only the default addresses: another one needs the user's permission. */
async function allowEndpoint(value, defaultBase) {
  if (new URL(value).origin === new URL(defaultBase).origin) return true;
  try {
    return await chrome.permissions.request({ origins: [`${new URL(value).origin}/*`] });
  } catch {
    return false;
  }
}

// ---------- Qwen ----------

/**
 * Check the saved Qwen key, address and model with the smallest request (it
 * uses a few tokens, so only when the user asks). Says how it went.
 */
async function testQwen() {
  const statusEl = $('qwenKeyStatus');
  const local = await getLocal();
  if (!local.qwenApiKey) {
    setStatus(statusEl, t('opt_key_missing'), 'warn');
    return;
  }
  setStatus(statusEl, t('opt_key_testing'));
  try {
    await new QwenClient({ apiKey: local.qwenApiKey, apiBase: local.qwenApiBase, model: local.qwenModel }).test();
    setStatus(statusEl, `${t('opt_key_ok', local.qwenModel)} ${await nextStep('qwen')}`, 'good');
  } catch (err) {
    setStatus(statusEl, errorMessage(err instanceof ApiError ? err.code : 'unknown', 'qwen'), 'bad');
  }
}

function initQwen(local) {
  $('qwenApiKey').value = local.qwenApiKey;
  $('qwenModel').value = local.qwenModel || DEFAULT_QWEN_MODEL;
  $('qwenApiBase').value = local.qwenApiBase || DEFAULT_QWEN_API_BASE;
  if (local.qwenApiKey) setStatus($('qwenKeyStatus'), t('opt_qwen_key_saved'));

  $('toggleQwenKey').addEventListener('click', (e) => {
    const input = $('qwenApiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.textContent = show ? t('opt_key_hide') : t('opt_key_show');
  });

  $('saveQwenKey').addEventListener('click', async () => {
    const key = $('qwenApiKey').value.trim();
    if (!key) {
      setStatus($('qwenKeyStatus'), t('opt_key_missing'), 'warn');
      $('qwenApiKey').focus();
      return;
    }
    const before = await getLocal();
    await setLocal({ qwenApiKey: key, qwenModel: $('qwenModel').value.trim() || DEFAULT_QWEN_MODEL });
    await adoptProviderIfOnlyKey('qwen', before);
    await testQwen();
  });
  $('qwenApiKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('saveQwenKey').click();
  });

  $('removeQwenKey').addEventListener('click', async () => {
    await setLocal({ qwenApiKey: '' });
    $('qwenApiKey').value = '';
    setStatus($('qwenKeyStatus'), t('opt_key_removed'));
  });

  $('qwenModel').addEventListener('change', async (e) => {
    const model = e.target.value.trim() || DEFAULT_QWEN_MODEL;
    e.target.value = model;
    await setLocal({ qwenModel: model });
    setStatus($('qwenKeyStatus'), t('opt_model_saved', model), 'good');
  });

  $('saveQwenEndpoint').addEventListener('click', async () => {
    const value = $('qwenApiBase').value.trim().replace(/\/+$/, '');
    if (!validEndpoint(value)) {
      setStatus($('qwenKeyStatus'), t('opt_endpoint_invalid'), 'bad');
      return;
    }
    if (!(await allowEndpoint(value, DEFAULT_QWEN_API_BASE))) {
      setStatus($('qwenKeyStatus'), t('opt_endpoint_denied'), 'bad');
      return;
    }
    await setLocal({ qwenApiBase: value });
    await testQwen();
  });
  $('resetQwenEndpoint').addEventListener('click', async () => {
    $('qwenApiBase').value = DEFAULT_QWEN_API_BASE;
    await setLocal({ qwenApiBase: DEFAULT_QWEN_API_BASE });
    await testQwen();
  });
}

// ---------- SceneVoice Cloud ----------

const cloudFetch = (url, init) => fetch(url, init);

/** The plan read from the relay, kept for a minute: this page re-renders on every change and must not keep asking. */
let meCache = { token: '', at: 0, data: null };
const ME_CACHE_MS = 60000;

async function cloudMe(token) {
  if (meCache.token === token && meCache.data && Date.now() - meCache.at < ME_CACHE_MS) return meCache.data;
  const data = await fetchMe(cloudFetch, token);
  meCache = { token, at: Date.now(), data };
  return data;
}

const planName = (plan) => t(`plan_${cleanPlan(plan)}`);

/**
 * The Cloud block as it stands: not set up, or the plan with today's use.
 * Written to a plain paragraph, not the live region: opening the settings page
 * is not news. Changes made here are said through #cloudStatus.
 */
async function renderCloud() {
  const local = await getLocal();
  const has = Boolean(local.cloudToken);
  $('cloudStart').hidden = has;
  $('cloudStop').hidden = !has;
  if (!has) {
    $('cloudInfo').textContent = t('opt_cloud_none');
    return;
  }
  try {
    const me = await cloudMe(local.cloudToken);
    if (me.plan !== local.cloudPlan) await setLocal({ cloudPlan: me.plan });
    $('cloudInfo').textContent = t('opt_cloud_status', planName(me.plan), allowanceMinutes(me.allowance.usedToday), allowanceMinutes(me.allowance.secondsPerDay), resetTimeText(me.allowance.resetsAt));
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    if (code === 'bad-key') {
      // The relay no longer knows this token (revoked, or the relay was reset):
      // it is gone, and Start free gets a new one. The sites keep pointing at
      // Cloud and sharing stays as it was, unlike Stop using Cloud, so nothing
      // else has to be set again.
      await setLocal({ cloudToken: '', cloudPlan: '' });
      meCache = { token: '', at: 0, data: null };
      $('cloudStart').hidden = false;
      $('cloudStop').hidden = true;
      $('cloudInfo').textContent = t('opt_cloud_token_lost');
      return;
    }
    $('cloudInfo').textContent = t('opt_cloud_status_offline', planName(local.cloudPlan));
  }
}

/** Register this installation: a device token and the free allowance, no account. Resolves to what the relay gave. */
async function registerCloud() {
  const got = await registerDevice(cloudFetch, { version: chrome.runtime.getManifest().version, locale: t('@@ui_locale') });
  await setLocal({ cloudToken: got.token, cloudPlan: got.plan });
  meCache = { token: got.token, at: Date.now(), data: { plan: got.plan, allowance: got.allowance, cacheHits: 0 } };
  return got;
}

/**
 * Start free: register, share finished descriptions (the hint beside the switch
 * says what that means), and have Cloud describe both sites when the listener
 * has no key of their own (a key already saved keeps its sites).
 */
async function startCloud() {
  const statusEl = $('cloudStatus');
  setStatus(statusEl, t('opt_cloud_starting'));
  try {
    const before = await getLocal();
    const { allowance } = await registerCloud();
    const patch = { shareDescriptions: true };
    if (!before.apiKey && !before.qwenApiKey) Object.assign(patch, { youtubeProvider: 'cloud', bilibiliProvider: 'cloud' });
    await setSettings(patch).catch(onSaveError);
    await renderCloud();
    setStatus(statusEl, t('opt_cloud_started', allowanceMinutes(allowance.secondsPerDay || 3600)), 'good');
    // The Start button is gone: keep focus on the control that took its place.
    $('cloudStop').focus();
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    setStatus(statusEl, `${cloudRegisterMessage(code, err?.resetAt)} ${t('opt_cloud_use_own')}`, 'bad');
  }
}

/** Stop using Cloud: the token goes; a site that was Cloud's goes back to its default model; sharing is off. */
async function stopCloud() {
  const settings = await getSettings();
  await setLocal({ cloudToken: '', cloudPlan: '' });
  meCache = { token: '', at: 0, data: null };
  const patch = { shareDescriptions: false };
  for (const key of ['youtubeProvider', 'bilibiliProvider']) if (settings[key] === 'cloud') patch[key] = DEFAULT_SETTINGS[key];
  await setSettings(patch).catch(onSaveError);
  await renderCloud();
  setStatus($('cloudStatus'), t('opt_cloud_stopped'));
  $('cloudStart').focus();
}

/** Activate a Plus or organisation licence on this computer's token (registering one first if there is none). */
async function activateCloudLicense() {
  const statusEl = $('licenseStatus');
  const key = $('licenseKey').value.trim();
  if (!key) {
    setStatus(statusEl, t('opt_license_missing'), 'warn');
    $('licenseKey').focus();
    return;
  }
  if (!validLicenseKey(key)) {
    setStatus(statusEl, t('opt_license_invalid'), 'bad');
    $('licenseKey').focus();
    return;
  }
  setStatus(statusEl, t('opt_key_testing'));
  try {
    let { cloudToken: token } = await getLocal();
    if (!token) token = (await registerCloud()).token;
    const { plan, allowance } = await activateLicense(cloudFetch, token, key);
    await setLocal({ cloudPlan: plan });
    meCache = { token, at: Date.now(), data: { plan, allowance, cacheHits: 0 } };
    $('licenseKey').value = '';
    await renderCloud();
    setStatus(statusEl, t('opt_license_ok', planName(plan), allowanceMinutes(allowance.secondsPerDay)), 'good');
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    if (code === 'not-found') setStatus(statusEl, t('opt_license_not_found'), 'bad');
    else if (code === 'license-full') setStatus(statusEl, t('opt_license_full'), 'bad');
    else setStatus(statusEl, t('opt_license_failed', errorMessage(code, 'cloud')), 'bad');
  }
}

function initCloud() {
  $('cloudStart').addEventListener('click', startCloud);
  $('cloudStop').addEventListener('click', stopCloud);
  $('activateLicense').addEventListener('click', activateCloudLicense);
  $('licenseKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('activateLicense').click();
  });
  return renderCloud();
}

/**
 * The video type settings: a type's mode, detail and density can be changed
 * only while adjusting is on; those the user picked are named, with a way back.
 */
function renderTypeSettings(settings) {
  for (const id of ['typeEntertainment', 'typeTutorial']) $(id).disabled = !settings.autoByType;
  const text = settings.autoByType ? typeChosenText(settings) : '';
  if ($('typeChosen').textContent !== text) $('typeChosen').textContent = text;
  $('typeChosenBox').hidden = !text;
}

async function letTypeDecide() {
  try {
    await setSettings(Object.fromEntries(CHOICES.map((key) => [`${key}Chosen`, false])));
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

/** The currency a provider's daily cost is counted in (usage.js recordUsage). */
const CURRENCY = { gemini: 'USD', qwen: 'CNY' };

/**
 * Today's usage, one line per model that was used: requests, tokens, minutes
 * of video and, where the model has a price, the estimate. From this
 * computer's counter (usage.js), which the service worker keeps.
 */
async function renderUsage() {
  const { [USAGE_KEY]: stored } = await chrome.storage.local.get(USAGE_KEY);
  const daily = todaysUsage(stored);
  const list = $('usageList');
  list.replaceChildren();
  for (const provider of COUNTED_PROVIDERS) {
    const row = daily[provider];
    if (!row.requests) continue;
    const li = document.createElement('li');
    const name = t(`provider_${provider}`);
    const minutes = String(row.seconds > 0 ? Math.max(1, Math.round(row.seconds / 60)) : 0);
    const tokens = formatTokens(row.input + row.output);
    const cost = row.cost > 0 && CURRENCY[provider] ? costText({ amount: row.cost, currency: CURRENCY[provider] }, t) : '';
    li.textContent = cost ? t('opt_usage_row_cost', name, String(row.requests), tokens, minutes, cost) : t('opt_usage_row', name, String(row.requests), tokens, minutes);
    list.append(li);
  }
  if (!list.children.length) {
    const li = document.createElement('li');
    li.textContent = t('opt_usage_none');
    list.append(li);
  }
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
    const before = await getLocal();
    await setLocal({ apiKey: key, model: '' });
    await adoptProviderIfOnlyKey('gemini', before);
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
    if (!validEndpoint(value)) {
      setStatus($('keyStatus'), t('opt_endpoint_invalid'), 'bad');
      return;
    }
    // The manifest only grants the official endpoint; a relay needs the user's permission.
    if (!(await allowEndpoint(value, DEFAULT_API_BASE))) {
      setStatus($('keyStatus'), t('opt_endpoint_denied'), 'bad');
      return;
    }
    await setLocal({ apiBase: value, model: '' });
    await loadModels({ announce: true });
  });
  $('resetEndpoint').addEventListener('click', async () => {
    $('apiBase').value = DEFAULT_API_BASE;
    await setLocal({ apiBase: DEFAULT_API_BASE, model: '' });
    await loadModels({ announce: true });
  });

  initQwen(local);
  await initCloud();

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
  await renderUsage();
  // The counter moves while this page is open (a video being described in another tab): keep up with it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[USAGE_KEY]) renderUsage();
  });

  // Sent here for a particular key (options.html#qwen) or for SceneVoice Cloud
  // (#cloud): start on that control, the Cloud button as rendered (a token the
  // relay no longer knew is gone by now, and Start free is the one shown).
  // Otherwise, with nothing set up yet, start where a key goes: in Chinese, at
  // the Qwen key, since Gemini needs Google, which mainland China cannot reach.
  const wanted = { '#gemini': 'apiKey', '#qwen': 'qwenApiKey', '#cloud': $('cloudStart').hidden ? 'cloudStop' : 'cloudStart' }[location.hash];
  if (wanted) $(wanted).focus();
  else if (!local.apiKey && !local.qwenApiKey && !local.cloudToken) $(chrome.i18n.getUILanguage().startsWith('zh') ? 'qwenApiKey' : 'apiKey').focus();
}

/** A sentence for the next key status, when saving a key changed which model a site uses. */
let providerNote = '';

/**
 * The first key saved describes every site, until the other key is added: a
 * listener with one key is never told to get the other (the service worker
 * falls back the same way; this keeps the settings page truthful). When the
 * second key arrives, a site that had the first key's model only for want of
 * the other goes back to its usual one, and the key status says so.
 */
async function adoptProviderIfOnlyKey(provider, local) {
  const other = provider === 'gemini' ? local.qwenApiKey : local.apiKey;
  if (!other) {
    await setSettings({ youtubeProvider: provider, bilibiliProvider: provider }).catch(onSaveError);
    return;
  }
  const first = provider === 'gemini' ? 'qwen' : 'gemini';
  const settings = await getSettings();
  const patch = {};
  for (const key of ['youtubeProvider', 'bilibiliProvider']) {
    if (settings[key] === first && DEFAULT_SETTINGS[key] !== first) patch[key] = DEFAULT_SETTINGS[key];
  }
  if (!Object.keys(patch).length) return;
  await setSettings(patch).catch(onSaveError);
  providerNote = t('opt_providers_default');
}

/** What to do now that a key works: the site that key's model usually describes, and the shortcut. */
async function nextStep(provider) {
  const site = provider === 'qwen' ? 'bilibili' : 'youtube';
  const commands = await chrome.commands.getAll().catch(() => []);
  const key = commands.find((c) => c.name === 'toggle-descriptions')?.shortcut;
  const next = key ? t(`opt_next_${site}`, key) : t(`opt_next_${site}_button`);
  const note = providerNote;
  providerNote = '';
  return note ? `${note} ${next}` : next;
}

init();
