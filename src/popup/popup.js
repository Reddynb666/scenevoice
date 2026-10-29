import { LANGUAGES, MSG } from '../shared/constants.js';
import { formatTime } from '../shared/script.js';
import { bindSettings } from '../shared/form.js';
import { errorMessage, localizeDocument, t } from '../shared/i18n.js';
import { typeAdjustedText } from '../shared/labels.js';
import { voiceTestMessage } from '../shared/settings.js';
import { getSettings, resolveLanguage } from '../shared/storage.js';
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
    select.append(o);
  }
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
  box.hidden = !generating;
  $('stop').hidden = !generating;
  if (!generating) return;
  const percent = Math.max(2, Math.min(100, state.percent || 0));
  $('progress').value = percent;
  const section = state.total > 1 ? t('progress_section', String(Math.min(state.done + 1, state.total)), String(state.total)) : t('progress_working');
  const eta = state.eta == null ? '' : state.eta < 60 ? t('popup_eta_soon') : t('popup_eta_minutes', String(Math.ceil(state.eta / 60)));
  $('progressText').textContent = `${section} · ${percent}%${eta ? ` · ${eta}` : ''}`;
}

let current = null;

function render(state) {
  current = state;
  const title = $('videoTitle');
  const statusEl = $('videoStatus');
  const gen = $('generate');
  const actions = [gen, $('describe'), $('ask')];
  let text;
  let cls = '';
  renderProgress(state);
  $('transcript').hidden = !(state?.cueCount > 0);

  if (!state || state.unreachable) {
    const onYouTube = /youtube(-nocookie)?\.com/.test(state?.url || '');
    text = onYouTube ? t('popup_reload_tab') : t('popup_open_video');
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
      case 'generating':
        text = state.total > 1
          ? t('status_progress_percent', String(state.percent || 0), String(Math.min(state.done + 1, state.total)), String(state.total))
          : t('status_progress_percent_single', String(state.percent || 0));
        gen.hidden = true;
        break;
      case 'ready':
        text = state.cueCount ? t('popup_ready_detail', String(state.cueCount), formatTime(state.firstCue || 0)) : t('status_ready_empty');
        cls = 'status-good';
        break;
      case 'partial':
        text = t('popup_partial', String(Math.max(1, Math.round(state.completedUntil / 60))));
        cls = 'status-warn';
        gen.textContent = t('popup_continue');
        break;
      case 'error':
        text = errorMessage(state.errorCode);
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
  renderType();
}

let savedSettings = null;

/**
 * Show mode and detail as they apply to the video in this tab: when its type
 * changed them, those values are selected, and a note says so. Choosing
 * another value makes it the user's own, for every video.
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
  if (['ask-question', 'describe-now', 'repeat-last'].includes(action)) {
    tabRequest({ type: MSG.TAB_ACTION, action });
    window.close();
    return;
  }
  render(await tabRequest({ type: MSG.TAB_ACTION, action }));
}

/** Speed is the built-in voice's rate, or the speed SceneVoice assumes for the screen reader. */
function onSettings(settings) {
  $('ttsSpeed').hidden = settings.output !== 'tts';
  $('readerSpeed').hidden = settings.output !== 'screenreader';
  savedSettings = settings;
  renderType();
}

function onSaveError() {
  $('settingsStatus').textContent = t('opt_settings_save_failed');
}

/** Name the keys for the quick settings, or say where to set them (Chrome gives them none by default). */
function renderQuickKeys(sc) {
  const items = [
    ['cycle-detail', t('quick_detail')],
    ['cycle-mode', t('quick_mode')],
    ['speed-up', t('quick_faster')],
    ['speed-down', t('quick_slower')],
  ]
    .filter(([name]) => sc[name])
    .map(([name, label]) => `${sc[name]} ${label}`);
  $('quickKeys').textContent = items.length ? t('popup_quick_keys', items.join(' · ')) : t('popup_quick_keys_none');
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
  $('keyBanner').hidden = Boolean(status?.hasKey);
  const sc = status?.shortcuts || {};
  if (sc['toggle-descriptions'] || sc['describe-now']) {
    $('shortcutHint').textContent = t('popup_shortcut_hint', sc['toggle-descriptions'] || '—', sc['describe-now'] || '—');
  }
  renderQuickKeys(sc);
  $('testVoice').addEventListener('click', testVoice);

  $('setupKey').addEventListener('click', () => chrome.runtime.openOptionsPage());
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
  refresh();
}

init();
