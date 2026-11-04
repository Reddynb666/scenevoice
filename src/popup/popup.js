import { LANGUAGES, MSG, RTL_LANGUAGES, SAY_SHORTCUTS } from '../shared/constants.js';
import { BINDABLE_COMMANDS, COMMAND_LABEL_KEYS, displayShortcut, effectiveShortcuts } from '../shared/shortcuts.js';
import { formatTime } from '../shared/script.js';
import { bindSettings } from '../shared/form.js';
import { errorMessage, interfaceLocale, localizeDocument, t } from '../shared/i18n.js';
import { generationProgressLabels, liveProgressLabels, typeAdjustedText } from '../shared/labels.js';
import { nativeName } from '../shared/language.js';
import { voiceTestMessage } from '../shared/settings.js';
import { platformOfUrl } from '../shared/platforms.js';
import { getSettings, resolveLanguage } from '../shared/storage.js';
import { budgetLabelKey, costText } from '../shared/usage.js';
import { typeAdjustments } from '../shared/videotype.js';

const $ = (id) => document.getElementById(id);

function fillLanguages(select) {
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = t('lang_auto');
  select.append(auto);
  for (const l of LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.name;
    o.lang = l.code;
    if (RTL_LANGUAGES.includes(l.code)) o.dir = 'rtl';
    select.append(o);
  }
}

/** The interface language, as a tag: the locale SceneVoice's strings are shown in ("en", "zh-CN"), which is English for a browser language without strings of its own. */
const interfaceLanguage = () => interfaceLocale();

/**
 * Under the language choice, which language the descriptions come in when it
 * is not the interface language: a Swedish browser gets an English interface
 * (no Swedish strings yet) and Swedish descriptions, and a Chinese interface
 * gets Chinese descriptions on Bilibili whatever the browser language. Hidden
 * when they are the same, so there is nothing extra to read then.
 */
function renderLanguageNote() {
  if (!savedSettings) return;
  const note = $('languageNote');
  const ui = interfaceLanguage();
  const lang = current?.supported && current.lang ? current.lang : resolveLanguage(savedSettings.language, chrome.i18n.getUILanguage());
  const same = lang === ui || lang === ui.split('-')[0];
  note.hidden = same;
  note.textContent = same ? '' : t('popup_language_note', nativeName(ui), nativeName(lang));
  if (same) $('language').removeAttribute('aria-describedby');
  else $('language').setAttribute('aria-describedby', 'languageNote');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function tabRequest(msg) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return { unreachable: true, url: tab.url || '' };
  }
}

let lastStatusText = '';
let pollTimer = null;

function renderProgress(state) {
  const box = $('progressBox');
  const generating = state?.status === 'generating';
  const live = state?.status === 'live';
  box.hidden = !generating && !live;
  // Describing as the video plays can be stopped too.
  $('stop').hidden = !generating && !live;
  if (box.hidden) return;
  // The same numbers and words as the box on the player.
  const percent = Math.max(0, Math.min(100, Math.round(state.percent || 0)));
  const words = live
    ? liveProgressLabels({ percent, upTo: state.describedUpTo > 0 ? formatTime(state.describedUpTo) : '' })
    : generationProgressLabels({ done: state.done, total: state.total, percent, eta: state.eta });
  $('progress').value = Math.max(2, percent);
  $('progressText').textContent = [words.label, words.percent, words.detail].filter(Boolean).join(' · ');
}

let current = null;
/** From the service worker: which keys exist ({ gemini, qwen }), or only whether the Gemini key does. */
let keyStatus = null;

/** Where the banner's button goes: the welcome page when nothing at all is set up, else the settings page. */
let setupTarget = 'options';

/**
 * Ask for a key when the model this tab's site uses has none. Away from a
 * video any key will do, and the key asked for is the one this listener's
 * language suggests (Gemini cannot be reached from mainland China). With no
 * key and no SceneVoice Cloud token at all, the welcome page is the place to
 * start: a sample, then Cloud or a key.
 */
function renderKeyBanner() {
  const onVideo = Boolean(current?.supported && current.provider);
  const keys = keyStatus?.keys;
  const any = keys ? Boolean(keys.gemini || keys.qwen || keys.cloud) : Boolean(keyStatus?.hasKey);
  const has = keys ? (onVideo ? keys[current.provider] : any) : keyStatus?.hasKey;
  $('keyBanner').hidden = Boolean(has);
  setupTarget = any ? 'options' : 'welcome';
  if (!any) {
    $('setupBody').textContent = t('popup_setup_body_welcome');
    $('setupKey').textContent = t('popup_setup_welcome');
    return;
  }
  const wantsQwen = onVideo ? current.provider === 'qwen' : chrome.i18n.getUILanguage().startsWith('zh');
  $('setupBody').textContent = wantsQwen ? t('popup_setup_body_qwen') : t('popup_setup_body');
  $('setupKey').textContent = t('popup_setup_button');
}

function render(state) {
  current = state;
  if (keyStatus) renderKeyBanner();
  const title = $('videoTitle');
  const statusEl = $('videoStatus');
  const gen = $('generate');
  const actions = [gen, $('describe'), $('ask')];
  let text;
  let cls = '';
  renderProgress(state);
  $('transcript').hidden = !(state?.cueCount > 0);
  $('report').hidden = !(state?.cueCount > 0);
  $('reportHint').hidden = $('report').hidden;

  if (!state || state.unreachable) {
    const onVideoSite = Boolean(platformOfUrl(state?.url || ''));
    text = onVideoSite ? t('popup_reload_tab') : t('popup_open_video');
    title.textContent = '';
    actions.forEach((b) => (b.disabled = true));
  } else if (!state.supported) {
    text = t('popup_open_video');
    title.textContent = '';
    actions.forEach((b) => (b.disabled = true));
  } else {
    title.textContent = state.title || '';
    actions.forEach((b) => (b.disabled = false));
    gen.hidden = false;
    gen.textContent = state.cueCount ? t('popup_regenerate') : t('popup_generate');
    switch (state.status) {
      // While work is going on, the status (a live region) says so once; the
      // numbers that change every second are in the progress box, which a
      // screen reader does not read out by itself.
      case 'live':
        text = t('popup_live_state');
        gen.hidden = true;
        break;
      case 'generating':
        text = t('popup_generating_state');
        gen.hidden = true;
        break;
      // Once a video is described, its cost at list price goes with the status: one
      // sentence in the same live region, written once, not a figure that changes.
      case 'ready':
        text = withCost(state.cueCount ? t('popup_ready_detail', String(state.cueCount), formatTime(state.firstCue || 0)) : t('status_ready_empty'), state.cost);
        cls = 'status-good';
        break;
      case 'partial':
        text = withCost(t('popup_partial', String(Math.max(1, Math.round(state.completedUntil / 60)))), state.cost);
        cls = 'status-warn';
        gen.textContent = t('popup_continue');
        break;
      case 'error':
        text = errorText(state.errorCode, state.provider);
        cls = 'status-bad';
        break;
      case 'loading':
        text = t('popup_loading');
        break;
      default:
        text = t('popup_none');
    }
  }
  statusEl.className = cls;
  if (text !== lastStatusText) {
    statusEl.textContent = text;
    lastStatusText = text;
  }
  clearTimeout(pollTimer);
  if (state?.status === 'generating' || state?.status === 'loading') pollTimer = setTimeout(refresh, 1000);
  else if (state?.status === 'live') pollTimer = setTimeout(refresh, 3000);
  renderType();
  renderLanguageNote();
}

let savedSettings = null;

/** A status sentence followed by what the video cost, when known (no space after a Chinese full stop). */
function withCost(text, cost) {
  if (!cost) return text;
  return `${text}${/[。！？]$/.test(text) ? '' : ' '}${t('popup_cost', costText(cost, t))}`;
}

/** An error in words. The day's limit names the limit set; the Cloud allowance its reset time (unknown here: the usual one). */
function errorText(code, provider) {
  if (code === 'budget') return t('error_budget', t(budgetLabelKey(savedSettings?.dailyBudgetSeconds)));
  if (code === 'allowance') return t('error_allowance', t('time_midnight_utc'));
  return errorMessage(code, provider);
}

/**
 * Show mode, detail and density as they apply to the video in this tab: when
 * its type changed them, those values are selected, and a note says so.
 * Choosing another value makes it the user's own, for every video.
 */
function renderType() {
  const type = current?.supported ? current.videoType : '';
  const changes = savedSettings ? typeAdjustments(savedSettings, type) : {};
  for (const [key, value] of Object.entries(changes)) {
    const radio = document.querySelector(`input[name="${key}"][value="${value}"]`);
    if (radio) radio.checked = true;
  }
  const text = typeAdjustedText(type, changes);
  const note = $('typeNote');
  // Cleared when hidden: the fieldsets point at it with aria-describedby.
  note.textContent = text ? `${text} ${t('popup_type_hint')}` : '';
  note.hidden = !text;
}

async function refresh() {
  render(await tabRequest({ type: MSG.TAB_STATE }));
}

async function act(action) {
  // Speech happens on the page. Screen readers only read live regions in the
  // foreground window, so close the popup first for anything that speaks there.
  if (['ask-question', 'describe-now', 'repeat-last', 'report-wrong'].includes(action)) {
    tabRequest({ type: MSG.TAB_ACTION, action });
    window.close();
    return;
  }
  const focused = document.activeElement;
  render(await tabRequest({ type: MSG.TAB_ACTION, action }));
  // The button pressed may have given way to its counterpart (Create → Stop, Stop → Create):
  // keep keyboard focus on that one rather than let it fall to the page.
  if (focused && focused !== document.body && focused.hidden) {
    const next = [$('stop'), $('generate'), $('videoStatus')].find((el) => el && !el.hidden);
    if (next === $('videoStatus')) next.tabIndex = -1;
    next?.focus();
  }
}

/** Speed is the built-in voice's rate, or the speed SceneVoice assumes for the screen reader. */
function onSettings(settings) {
  $('ttsSpeed').hidden = settings.output !== 'tts';
  $('readerSpeed').hidden = settings.output !== 'screenreader';
  savedSettings = settings;
  renderType();
  renderLanguageNote();
}

function onSaveError() {
  $('settingsStatus').textContent = t('opt_settings_save_failed');
}

/** Name the keys for the quick settings, or say where to set them (Chrome gives them none by default). */
function renderQuickKeys(sc) {
  const items = [
    ['cycle-detail', t('quick_detail')],
    ['cycle-density', t('quick_density')],
    ['cycle-mode', t('quick_mode')],
    ['speed-up', t('quick_faster')],
    ['speed-down', t('quick_slower')],
  ]
    .filter(([name]) => sc[name])
    .map(([name, label]) => `${sc[name]} ${label}`);
  $('quickKeys').textContent = items.length ? t('popup_quick_keys', items.join(' · ')) : t('popup_quick_keys_none');
}

/** Every SceneVoice shortcut, Chrome's and the page's alike, as a list: what it does, then its key or "not set". */
function renderAllKeys(sc) {
  const list = $('keyList');
  list.replaceChildren();
  for (const command of BINDABLE_COMMANDS) {
    const li = document.createElement('li');
    li.textContent = `${t(COMMAND_LABEL_KEYS[command])}: ${sc[command] || t('opt_keys_unset')}`;
    list.append(li);
  }
  $('keysHint').textContent = sc[SAY_SHORTCUTS] ? t('popup_keys_hint', sc[SAY_SHORTCUTS]) : t('popup_keys_hint_change');
}

async function testVoice() {
  const settings = await getSettings();
  chrome.runtime.sendMessage(voiceTestMessage(settings, resolveLanguage(settings.language, chrome.i18n.getUILanguage())));
}

async function init() {
  localizeDocument();
  fillLanguages($('language'));
  await bindSettings(document, onSettings, onSaveError);
  // The next change replaces an earlier "could not save" (it says so again if it fails too).
  document.addEventListener('change', () => {
    $('settingsStatus').textContent = '';
  });

  const status = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
  keyStatus = status || {};
  renderKeyBanner();
  // Chrome's keys from the service worker, the page's from the settings, each as the listener should hear it.
  const keys = effectiveShortcuts(status?.shortcuts || {}, savedSettings?.pageShortcuts);
  const sc = Object.fromEntries(Object.entries(keys).map(([command, key]) => [command, displayShortcut(key)]));
  if (sc['toggle-descriptions'] || sc['describe-now']) {
    $('shortcutHint').textContent = t('popup_shortcut_hint', sc['toggle-descriptions'] || '—', sc['describe-now'] || '—');
  }
  renderQuickKeys(sc);
  renderAllKeys(sc);
  // The keys are changed on SceneVoice's own settings page (Chrome's shortcuts page is linked from there).
  $('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#keys') }));
  $('testVoice').addEventListener('click', testVoice);

  $('setupKey').addEventListener('click', () => {
    if (setupTarget === 'welcome') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    else chrome.runtime.openOptionsPage();
  });
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('generate').addEventListener('click', async () => {
    const state = await tabRequest({ type: MSG.TAB_STATE });
    if (state?.status === 'partial' || !state?.cueCount) act('generate');
    else act('regenerate');
  });
  $('stop').addEventListener('click', () => act('stop'));
  $('transcript').addEventListener('click', () => {
    if (!current?.videoId) return;
    const q = new URLSearchParams({ v: current.videoId, lang: current.lang, title: current.title || '' });
    chrome.tabs.create({ url: chrome.runtime.getURL(`transcript.html?${q}`) });
  });
  $('describe').addEventListener('click', () => act('describe-now'));
  $('ask').addEventListener('click', () => act('ask-question'));
  $('report').addEventListener('click', () => act('report-wrong'));
  refresh();
}

init();
