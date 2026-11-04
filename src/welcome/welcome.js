// The welcome page, opened once after installing. Three steps, nothing above
// them: hear a sample (no model, no key), choose SceneVoice Cloud or a key of
// one's own, try a video. Written to be followed with a screen reader: focus
// starts on the heading, every state is said in a live region, and the
// built-in voice and the screen reader never speak at once.

import { MSG, SAMPLE_DESCRIPTIONS } from '../shared/constants.js';
import { allowanceMinutes, registerDevice } from '../shared/cloud.js';
import { ApiError } from '../shared/errors.js';
import { bindSettings } from '../shared/form.js';
import { errorMessage, localizeDocument, t } from '../shared/i18n.js';
import { voiceTestMessage } from '../shared/settings.js';
import { getLocal, getSettings, setLocal, setSettings } from '../shared/storage.js';

const $ = (id) => document.getElementById(id);
const chinese = () => chrome.i18n.getUILanguage().startsWith('zh');

/**
 * The sample is in the interface language (the locale the strings come in,
 * "zh_CN" or "pt_BR"), as a description language with a sample table; English
 * when that language has none.
 */
function sampleLang() {
  const ui = t('@@ui_locale').replace('_', '-');
  const candidates = [ui, { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', zh: 'zh-CN' }[ui] || '', ui.split('-')[0]];
  return candidates.find((code) => code && SAMPLE_DESCRIPTIONS[code]) || 'en';
}

/** Between sample sentences in the live region: long enough for a screen reader to finish the one before. */
const SAMPLE_GAP_MS = 4000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sampleRun = 0;

/**
 * Three descriptions, with a sentence between the first two about how they
 * fit the pauses. Through the screen reader they go into the live region one
 * by one, as they would during a video; through the built-in voice they are
 * spoken as one piece and the live region is kept quiet.
 */
async function playSample() {
  const run = (sampleRun += 1);
  const lines = SAMPLE_DESCRIPTIONS[sampleLang()];
  const texts = [lines[0], t('welcome_sample_between'), lines[1], lines[2], t('welcome_sample_done')];
  const settings = await getSettings();
  const out = $('sampleOut');
  if (settings.output === 'tts') {
    out.setAttribute('aria-live', 'off');
    out.textContent = texts.join(' ');
    chrome.runtime.sendMessage({ ...voiceTestMessage(settings, sampleLang()), text: texts.join(' '), id: 'welcome-sample' }).catch(() => {});
    return;
  }
  out.setAttribute('aria-live', 'polite');
  for (const [i, text] of texts.entries()) {
    if (run !== sampleRun) return;
    out.textContent = text;
    if (i < texts.length - 1) await wait(SAMPLE_GAP_MS);
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
    status.textContent = `${errorMessage(code, 'cloud')} ${t('welcome_cloud_failed_next')}`;
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

  for (const radio of document.querySelectorAll('input[name=source]')) radio.addEventListener('change', showSource);
  showSource();
  // Gemini needs Google, which mainland China cannot reach: a Chinese browser starts at the Qwen key.
  $('ownKey').href = chinese() ? 'options.html#qwen' : 'options.html#gemini';
  $('tryBilibiliItem').hidden = !chinese();

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
