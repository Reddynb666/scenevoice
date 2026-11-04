// The welcome page, opened once after installing. Three steps, nothing above
// them: hear a sample (no model, no key), choose SceneVoice Cloud or a key of
// one's own, try a video. Written to be followed with a screen reader: focus
// starts on the heading, every state is said in a live region, and the
// built-in voice and the screen reader never speak at once.

import { MSG, SAMPLE_DESCRIPTIONS } from '../shared/constants.js';
import { allowanceMinutes, registerDevice } from '../shared/cloud.js';
import { ApiError } from '../shared/errors.js';
import { bindSettings } from '../shared/form.js';
import { cloudRegisterMessage, interfaceLocale, localizeDocument, t } from '../shared/i18n.js';
import { estimateSeconds } from '../shared/script.js';
import { classifySender } from '../shared/sender.js';
import { voiceTestMessage } from '../shared/settings.js';
import { getLocal, getSettings, setLocal, setSettings } from '../shared/storage.js';

const $ = (id) => document.getElementById(id);
const chinese = () => chrome.i18n.getUILanguage().startsWith('zh');

/**
 * The sample is in the interface language (the locale the strings on this
 * page come in, "zh-CN" or "pt-BR", not the browser's locale), as a
 * description language with a sample table; English when that language has none.
 */
function sampleLang() {
  const ui = interfaceLocale();
  const candidates = [ui, { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', zh: 'zh-CN' }[ui] || '', ui.split('-')[0]];
  return candidates.find((code) => code && SAMPLE_DESCRIPTIONS[code]) || 'en';
}

/**
 * Between sample sentences in the live region: at least this long, and longer
 * when the sentence needs it at the chosen screen reader speed (the longest
 * line is 15 words, over six seconds at the "Default speed" setting). The
 * region is replaced each time, so a write that lands early cuts the sentence
 * before, or is dropped, depending on the screen reader.
 */
const SAMPLE_GAP_MS = 4000;
const sampleGap = (text, readerSpeed) => Math.max(SAMPLE_GAP_MS, Math.ceil((estimateSeconds(text, readerSpeed) + 0.5) * 1000));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sampleRun = 0;
/** The id of the built-in-voice sample now speaking (its TTS events carry it), or '' when none is. */
let speakingId = '';

/**
 * End whatever sample is going: the live-region loop stops at its next
 * sentence, and a built-in voice still reading is silenced. The stop is sent
 * only while that voice is ours: chrome.tts.stop() is global, and this page
 * must not cut off a description being read for a video in another tab.
 */
function stopSample() {
  sampleRun += 1;
  if (!speakingId) return;
  speakingId = '';
  $('sample').textContent = t('welcome_sample_button');
  chrome.runtime.sendMessage({ type: MSG.STOP_SPEAKING }).catch(() => {});
}

/**
 * Three descriptions, with a sentence between the first two about how they
 * fit the pauses. Through the screen reader they go into the live region one
 * by one, as they would during a video; through the built-in voice they are
 * spoken as one piece and the live region is kept quiet, and the button stops
 * the voice until it has finished. Either way the sample before is ended first,
 * so the screen reader and the built-in voice never speak at once.
 */
async function playSample() {
  if (speakingId) {
    stopSample();
    return;
  }
  stopSample();
  const run = sampleRun;
  const lines = SAMPLE_DESCRIPTIONS[sampleLang()];
  const texts = [lines[0], t('welcome_sample_between'), lines[1], lines[2], t('welcome_sample_done')];
  const settings = await getSettings();
  if (run !== sampleRun) return;
  const out = $('sampleOut');
  if (settings.output === 'tts') {
    out.setAttribute('aria-live', 'off');
    out.textContent = texts.join(' ');
    // A new id per utterance: the events of one just stopped must not end this one.
    speakingId = `welcome-sample:${run}`;
    $('sample').textContent = t('welcome_sample_stop');
    chrome.runtime.sendMessage({ ...voiceTestMessage(settings, sampleLang()), text: texts.join(' '), id: speakingId }).catch(() => {});
    return;
  }
  out.setAttribute('aria-live', 'polite');
  for (const [i, text] of texts.entries()) {
    if (run !== sampleRun) return;
    out.textContent = text;
    if (i < texts.length - 1) await wait(sampleGap(text, settings.readerSpeed));
  }
}

/**
 * The built-in voice has finished, was stopped, or could not speak at all (no
 * voice for the language, no speech engine, as on many Linux installs). The
 * live region is live again either way; a failure is said through it, on the
 * next turn, since a region switched on and written in the same tick can be
 * missed, and points at the screen-reader choice.
 */
function onSampleEvent(id, event) {
  if (!id || id !== speakingId) return;
  speakingId = '';
  $('sample').textContent = t('welcome_sample_button');
  const out = $('sampleOut');
  out.setAttribute('aria-live', 'polite');
  if (event === 'error') {
    setTimeout(() => {
      out.textContent = t('welcome_sample_voice_failed');
    }, 0);
  }
}

/** Which of the two ways is shown under the radios. Nothing is saved by the choice itself. */
function showSource() {
  const own = document.querySelector('input[name=source]:checked')?.value === 'own';
  $('cloudBox').hidden = own;
  $('ownBox').hidden = !own;
}

/**
 * Register this installation with SceneVoice Cloud: an anonymous device token
 * with the free allowance, saved like a key. Both sites then use Cloud and
 * finished descriptions are shared (said next to the button). When the relay
 * cannot be reached, say so and point at the own-key path; never pretend.
 */
async function startFree() {
  const status = $('cloudStatus');
  const button = $('startFree');
  button.disabled = true;
  status.textContent = t('opt_cloud_starting');
  try {
    const { token, plan, allowance } = await registerDevice((url, init) => fetch(url, init), { version: chrome.runtime.getManifest().version, locale: t('@@ui_locale') });
    await setLocal({ cloudToken: token, cloudPlan: plan });
    await setSettings({ youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true });
    status.textContent = t('welcome_cloud_ready', allowanceMinutes(allowance.secondsPerDay || 3600));
    button.hidden = true;
    // The button is gone: keep focus nearby, on the next step's heading.
    $('step3').tabIndex = -1;
    $('step3').focus();
  } catch (err) {
    button.disabled = false;
    const code = err instanceof ApiError ? err.code : 'unknown';
    status.textContent = `${cloudRegisterMessage(code, err?.resetAt)} ${t('welcome_cloud_failed_next')}`;
  }
}

/** Step 3: the shortcut that creates descriptions, or that none is set. */
async function renderShortcut() {
  const commands = await chrome.commands.getAll().catch(() => []);
  const key = commands.find((c) => c.name === 'toggle-descriptions')?.shortcut;
  $('shortcutText').textContent = key ? t('welcome_shortcut_set', key) : t('welcome_shortcut_unset');
}

async function init() {
  localizeDocument();
  // The heading first, not a field: a screen reader starts reading from here.
  $('title').focus();
  await bindSettings(document);

  $('sample').addEventListener('click', playSample);
  // A sample must not go on through the other output, or into the next page.
  for (const radio of document.querySelectorAll('input[name=output]')) radio.addEventListener('change', stopSample);
  window.addEventListener('pagehide', stopSample);
  // The service worker reports how the built-in voice's sample ended.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== MSG.TTS_EVENT || classifySender(sender, chrome.runtime.id) !== 'service-worker') return;
    onSampleEvent(msg.id, msg.event);
  });

  for (const radio of document.querySelectorAll('input[name=source]')) radio.addEventListener('change', showSource);
  showSource();
  // Gemini needs Google, which mainland China cannot reach: a Chinese browser starts at the Qwen key.
  $('ownKey').href = chinese() ? 'options.html#qwen' : 'options.html#gemini';
  $('tryBilibiliItem').hidden = !chinese();
  // The privacy note in the reader's language. GitHub's anchor for the heading
  // "SceneVoice Cloud（可选）" drops the full-width parentheses; if it ever misses, the
  // page opens at the top, which is still the right document.
  if (chinese()) $('privacyLink').href = 'https://github.com/reddynb666/scenevoice/blob/main/PRIVACY.zh-CN.md#scenevoice-cloud可选';

  const local = await getLocal();
  if (local.cloudToken) {
    $('startFree').hidden = true;
    $('cloudStatus').textContent = t('welcome_cloud_already');
  }
  $('startFree').addEventListener('click', startFree);

  $('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Back from Chrome's shortcuts page: say the key just set.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderShortcut();
  });
  await renderShortcut();
}

init();
