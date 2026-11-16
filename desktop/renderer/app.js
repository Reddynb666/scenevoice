// The page of the K3 test shell: fills in the strings, wires the buttons, the
// single keys and the menu to the same actions, plays the sample or the film
// the tester opened, and hands every description and status to the SpeechBus,
// which is the only thing here that speaks or writes a live region.
//
// A test instrument: it analyses nothing. The ten descriptions of
// sample/narration.json are spoken at the same times whatever film is playing.
// A build without the sample clip (the builds for testers) plays them over the
// film the tester opened.

import { SEEK_SECONDS, helpEntries } from '../shared/actions.js';
import { LOCALES, createT, pickLanguage } from '../shared/i18n.js';
import { openModal } from './dialogs.js';
import { listenForKeys } from './keys.js';
import { listen, micFailure } from './mictest.js';
import { clock, cueAt, dueCues, durationParts, namesAt, prepareScript } from './narration.js';
import { SpeechBus, blockReason, voiceState } from './speechbus.js';
// narration.json, served by the app scheme as a module (see main/apppath.js): the
// Content-Security-Policy lets the page import scripts but fetch nothing, JSON included.
import narration from './sample/narration.json.js';

/** The bridge of main/preload.cjs; a stand-in keeps the page from failing when opened outside the app. */
const sv = window.sv || {
  lang: '',
  platform: '',
  selftest: false,
  sample: false,
  invoke: () => Promise.reject(new Error('not running in the app')),
  send() {},
  on() {},
};

const lang = Object.hasOwn(LOCALES, sv.lang) ? sv.lang : pickLanguage(navigator.language);
const t = createT(lang);
const script = prepareScript(narration, t('scriptLang'));
const RATES = [0.8, 1, 1.2, 1.5, 2];
/** Chromium fills the list of voices a moment after the page starts: how long an empty list may still mean "not yet". */
const VOICES_WAIT_MS = 3000;
/** What is said when the microphone could not be opened, by the kind of failure (mictest.js). */
const MIC_FAILURE_STRINGS = { denied: 'stMicDenied', missing: 'stMicMissing', busy: 'stMicBusy', failed: 'stMicFailed' };

const byId = (id) => document.getElementById(id);
const els = {
  title: byId('title'),
  sample: byId('btn-sample'),
  open: byId('btn-open'),
  dialog: byId('btn-dialog'),
  notify: byId('btn-notify'),
  channel: byId('btn-channel'),
  help: byId('btn-help'),
  report: byId('btn-report'),
  mic: byId('btn-mic'),
  credit: byId('credit'),
  rate: byId('rate'),
  status: byId('status'),
  player: byId('player'),
  video: byId('film'),
  noFilm: byId('no-film'),
  play: byId('btn-play'),
  current: byId('current'),
  currentText: byId('current-text'),
  log: byId('log'),
  reader: byId('reader-out'),
  helpList: byId('help-list'),
  dlgTest: byId('dlg-test'),
  dlgTestInput: byId('dlg-test-input'),
  dlgWrong: byId('dlg-wrong'),
  dlgWrongBody: byId('dlg-wrong-body'),
  wrongNot: byId('wrong-not'),
};
const video = els.video;

const state = {
  /** 'none' | 'sample' | 'film' */
  media: 'none',
  /** The film's time at the last look, for "which descriptions became due". */
  previous: 0,
  /** The name the descriptions used most recently: what "the name is wrong" is about. */
  lastName: '',
  /** The next play event is the sample starting: its own status has been said. */
  quietPlay: false,
  /** The next pause event is the sample run ending: likewise. */
  quietPause: false,
  /**
   * A build without the sample clip plays the sample's descriptions over the opened film: the
   * film time at which that run ends, or null when no such run is on.
   */
  demoEnd: null,
  /** The microphone test is running: one at a time. */
  micBusy: false,
  audioWarning: '',
  toldSameCues: false,
  toldNoVoice: false,
  /** The list of voices has arrived, or has had its time to: an empty one now means "no voice". */
  voicesSettled: false,
  /** A dialog is open: no listening action runs behind it. */
  modal: false,
};

/** For the self-test: told about every action that ran, and where it came from. */
const hooks = { onAction: null };

/** One line for the shell's own log (it ends up in the diagnostic report). Never a file name. */
function note(line) {
  sv.send('log:write', { line: String(line).slice(0, 300) });
}

function fillStrings() {
  document.documentElement.lang = t('htmlLang');
  document.documentElement.dir = t('htmlDir');
  document.title = t('appName');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  for (const entry of helpEntries(t, sv.platform)) {
    const item = document.createElement('li');
    item.textContent = entry.line;
    els.helpList.append(item);
  }
  els.wrongNot.textContent = t('wrongNot', { name: script.leadName });
  if (!sv.sample) {
    // No clip in this build: nothing to credit, and only one way to get a film.
    els.credit.hidden = true;
    els.noFilm.textContent = t('noFilmOpen');
  }
  for (const rate of RATES) {
    const option = document.createElement('option');
    option.value = String(rate);
    option.textContent = t('rateOption', { rate });
    option.selected = rate === 1;
    els.rate.append(option);
  }
}

fillStrings();

const bus = new SpeechBus({
  statusEl: els.status,
  readerEl: els.reader,
  logEl: els.log,
  currentEl: els.currentText,
  media: () => (state.media === 'none' ? null : video),
  lang: t('speechLang'),
  uiLang: t('htmlLang'),
  // The self-test exercises the real voice without making a sound.
  volume: sv.selftest ? 0 : 1,
  clock,
  onNote: note,
  onVoiceFailed: (cause) => {
    // The bus has already handed the descriptions to the screen reader: show that, and say which
    // channel reads them now and why.
    note(`voice failed (${cause}): descriptions go to the screen reader`);
    showChannel();
    if (cause === 'no-voice') bus.status(t('stNoVoiceReader', { language: t('speechLangName') }));
    else bus.status(t('stVoiceFailed'));
  },
});
if (sv.selftest) video.muted = true;

function sendUi() {
  sv.send('ui:state', { modal: state.modal, channel: bus.channel });
}

/** The toggle always names what pressing it will do; the menu's checkbox follows. */
function showChannel() {
  els.channel.textContent = t(bus.channel === 'app' ? 'btnUseReader' : 'btnUseApp');
  sendUi();
}

/** A length of time in words: "2 小时 4 分钟", "1 分 5 秒". */
function spokenTime(seconds) {
  const { h, m, s } = durationParts(seconds);
  if (h) return t('durHours', { h, m });
  if (m) return t('durMinutes', { m, s });
  return t('durSeconds', { s });
}

function hasFilm() {
  if (state.media !== 'none') return true;
  bus.status(t(sv.sample ? 'noFilm' : 'noFilmOpen'));
  return false;
}

/** Whether this computer lacks a voice for the description language (or has no voice at all). */
function noVoice() {
  return voiceState(bus.voices(), t('speechLang'), state.voicesSettled) === 'none';
}

/**
 * With no voice for the description language the app voice would say nothing, or read with a
 * voice of another language, and report that all went well. So, once, when something is about to
 * play: the descriptions go to the screen reader, and the status says so (onVoiceFailed). The
 * button switches back.
 */
function warnNoVoice() {
  if (state.toldNoVoice || bus.channel !== 'app' || !noVoice()) return;
  state.toldNoVoice = true;
  bus.voiceUnavailable('no-voice');
}

/** The list of voices is as complete as it will get. */
function voicesSettled() {
  if (state.voicesSettled) return;
  state.voicesSettled = true;
  note(`voices settled: ${bus.voices().length}`);
  // Something is playing already: the warning that could not be given when it started is due now.
  if (state.media !== 'none') warnNoVoice();
}

function loadMedia(kind, url, { autoplay }) {
  state.media = kind;
  state.previous = 0;
  state.lastName = '';
  state.demoEnd = null;
  // A fresh log for each film or sample: what is listed there is the run that follows.
  els.log.replaceChildren();
  els.noFilm.hidden = true;
  video.hidden = false;
  els.play.textContent = t('btnPlay');
  video.src = url;
  video.load();
  if (!autoplay) return;
  state.quietPlay = true;
  video.play().catch((err) => {
    state.quietPlay = false;
    note(`media: play refused (${err && err.name})`);
  });
}

async function playSample() {
  const answer = sv.sample ? await sv.invoke('sample:open') : null;
  if (!answer || answer.missing) {
    playSampleOverFilm();
    return;
  }
  bus.status(t('stSampleStart'));
  warnNoVoice();
  loadMedia('sample', answer.url, { autoplay: true });
}

/**
 * "Hear a sample" in a build without the clip: the same ten descriptions over the film the
 * tester opened, from its start, for as long as the sample lasts. Without a film it says what
 * to do.
 */
function playSampleOverFilm() {
  if (state.media !== 'film') {
    bus.status(t('stSampleMissing'));
    return;
  }
  bus.status(t('stSampleOverFilm'));
  warnNoVoice();
  // A fresh log, as for the clip: what is listed there is this run.
  els.log.replaceChildren();
  state.demoEnd = script.duration;
  state.previous = 0;
  video.currentTime = 0;
  if (!video.paused) return;
  state.quietPlay = true;
  video.play().catch((err) => {
    state.quietPlay = false;
    note(`media: play refused (${err && err.name})`);
  });
}

/** The run of playSampleOverFilm is over: stop there, as the sample clip would. */
function endSampleOverFilm() {
  state.demoEnd = null;
  state.quietPause = true;
  video.pause();
  bus.status(t('stSampleEnded'));
}

async function openFilm() {
  const answer = await sv.invoke('film:open');
  if (!answer || answer.canceled) {
    bus.status(t('stFilmCanceled'));
    return;
  }
  if (answer.failed) {
    bus.status(t('stFilmFailed'));
    return;
  }
  state.audioWarning = answer.audioWarning || '';
  warnNoVoice();
  // The tester's own film does not start by itself.
  loadMedia('film', answer.url, { autoplay: false });
}

function togglePlay() {
  if (!hasFilm()) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  if (video.ended) video.currentTime = 0;
  video.play().catch((err) => note(`media: play refused (${err && err.name})`));
}

function seek(delta) {
  if (!hasFilm()) return;
  const end = Number.isFinite(video.duration) ? video.duration : 0;
  const to = Math.min(Math.max(0, video.currentTime + delta), end);
  video.currentTime = to;
  state.previous = to;
  // Past the end of a sample run: the tester is watching the film now, it plays on.
  if (state.demoEnd != null && to >= state.demoEnd) state.demoEnd = null;
  // Several seeks in a row: only the last position is worth saying.
  bus.status(t('stSeek', { position: spokenTime(to) }), { tag: 'position' });
}

function rememberName(cue) {
  if (cue.names.length) state.lastName = cue.names[0];
}

/** Descriptions whose time has come since the last look at the film's clock. */
function tick() {
  if (state.media === 'none' || video.paused) return;
  const time = video.currentTime;
  for (const cue of dueCues(script.cues, state.previous, time)) {
    rememberName(cue);
    bus.describe(cue.text, { time: cue.t });
  }
  state.previous = time;
  if (state.demoEnd != null && time >= state.demoEnd) endSampleOverFilm();
}

/** D: the description for this moment, at once. */
function describeNow() {
  if (!hasFilm()) return;
  const cue = cueAt(script.cues, video.currentTime);
  if (!cue) return;
  rememberName(cue);
  bus.answer(cue.text, { remember: true, time: cue.t });
}

/** W: answered from the fixed table, never by a model. */
function whoIsOnScreen() {
  if (!hasFilm()) return;
  const names = namesAt(script, video.currentTime);
  const text = names.length ? t('whoList', { names: names.join(t('listSeparator')) }) : t('whoNobody');
  bus.answer(text, { lang: t('speechLang') });
}

/** The key list, through the status region: interface text is the screen reader's to read. */
function help() {
  const lines = helpEntries(t, sv.platform).map((entry) => entry.line);
  // The credit belongs to the sample clip: a build without it has nothing to credit.
  bus.status([t('helpSpokenIntro'), ...lines, ...(sv.sample ? [t('credit')] : [])].join(' '), { urgent: true });
}

function showDialog(dialog, { focus, onClose }) {
  if (state.modal) return;
  state.modal = true;
  sendUi();
  // The screen reader reads the dialog: the shell says nothing itself until it closes.
  bus.setBlocked('dialog', true);
  openModal(dialog, {
    focus,
    onClose: (result) => {
      state.modal = false;
      sendUi();
      bus.setBlocked('dialog', false);
      onClose(result);
    },
  });
}

function openTestDialog() {
  els.dlgTestInput.value = '';
  showDialog(els.dlgTest, {
    focus: els.dlgTestInput,
    onClose: (result) => {
      const text = els.dlgTestInput.value.trim();
      if (result !== 'ok') bus.status(t('stDialogClosed'));
      else bus.status(text ? t('stDialogOk', { text }) : t('stDialogEmpty'));
    },
  });
}

/** X: three choices. The shell only notes the choice; the product rewrites the script. */
function openWrongDialog() {
  const name = state.lastName || script.leadName;
  els.dlgWrongBody.textContent = t(state.lastName ? 'wrongBody' : 'wrongBodyNone', { name });
  els.wrongNot.textContent = t('wrongNot', { name });
  showDialog(els.dlgWrong, {
    focus: els.wrongNot,
    onClose: (result) => {
      const chosen = els.dlgWrong.querySelector(`[data-result="${result}"]`);
      if (result === 'cancel' || !chosen) bus.status(t('stWrongCanceled'));
      else bus.status(t('stWrongRecorded', { choice: chosen.textContent }));
    },
  });
}

async function sendNotification() {
  const answer = await sv.invoke('notify:show', { title: t('notifTitle'), body: t('notifBody') });
  if (!answer || !answer.supported) bus.status(t('stNotifyUnsupported'));
  else bus.status(t(answer.shown ? 'stNotifySent' : 'stNotifyUnconfirmed'));
}

/** The toggle between the app voice and the screen reader. */
function toggleChannel() {
  const next = bus.channel === 'app' ? 'reader' : 'app';
  if (!bus.setChannel(next)) {
    bus.status(t('stNoVoiceEngine'));
    return;
  }
  showChannel();
  bus.status(t(next === 'app' ? 'stChannelApp' : 'stChannelReader'));
  // The user's own choice stands, but not without saying what to expect of it.
  if (next === 'app' && noVoice()) bus.status(t('stNoVoice', { language: t('speechLangName') }));
}

/**
 * "Test the microphone": ask the system for it, listen for three seconds, say in words whether
 * there was sound, and let go of it. What Windows and the security software say to that is what
 * K3 records. See mictest.js: nothing is recorded.
 */
async function testMicrophone() {
  if (state.micBusy) return;
  state.micBusy = true;
  try {
    // The main process lets exactly one request for the microphone through after this.
    await sv.invoke('mic:arm');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const reason = String((err && err.name) || 'Error').slice(0, 40);
      note(`microphone: not opened (${reason})`);
      bus.status(t(MIC_FAILURE_STRINGS[micFailure(reason)], { reason }));
      return;
    }
    note('microphone: opened');
    bus.status(t('stMicListening'));
    const { heard } = await listen(stream);
    note(`microphone: ${heard ? 'sound' : 'no sound'}; released`);
    bus.status(t(heard ? 'stMicHeard' : 'stMicSilent'));
  } finally {
    state.micBusy = false;
  }
}

/** Say how saving the diagnostic report went. */
function reportSaved(answer) {
  if (answer && answer.saved) bus.status(t('stReportSaved'));
  else if (answer && answer.reason) bus.status(t('stReportFailed', { reason: answer.reason }));
  else bus.status(t('stReportCanceled'));
}

/** The button at the end of the page. The menu item is handled by the main process alone. */
async function saveReport() {
  reportSaved(await sv.invoke('report:save'));
}

/**
 * Run a listening action or a menu command.
 * @param {string} action  an id of shared/actions.js, or 'sample' | 'open' | 'channel' | 'report'
 * @param {'key'|'menu'|'button'|'selftest'} source
 */
function run(action, source) {
  note(`action ${action} via ${source}`);
  if (hooks.onAction) hooks.onAction(action, source);
  if (state.modal) return;
  const fail = (err) => note(`action ${action} failed (${err && err.message})`);
  switch (action) {
    case 'toggle':
      togglePlay();
      break;
    case 'back':
      seek(-SEEK_SECONDS);
      break;
    case 'forward':
      seek(SEEK_SECONDS);
      break;
    case 'describe':
      describeNow();
      break;
    case 'repeat':
      if (!bus.repeat()) bus.status(t('stNothingToRepeat'));
      break;
    case 'stop':
      bus.stop();
      // The shell cannot silence a screen reader: say how the user can.
      if (bus.channel === 'reader') bus.status(t('stStopReader'));
      break;
    case 'who':
      whoIsOnScreen();
      break;
    case 'wrong':
      openWrongDialog();
      break;
    case 'help':
      help();
      break;
    case 'sample':
      playSample().catch(fail);
      break;
    case 'open':
      openFilm().catch(fail);
      break;
    case 'channel':
      toggleChannel();
      break;
    case 'report':
      saveReport().catch(fail);
      break;
    default:
      break;
  }
}

// The film.
video.addEventListener('loadedmetadata', () => {
  note('media: metadata loaded');
  if (state.media !== 'film') return;
  bus.status(t('stFilmOpened', { duration: spokenTime(video.duration) }));
  if (state.audioWarning) bus.status(t('stFilmAudio', { codec: state.audioWarning }));
  if (!state.toldSameCues) {
    state.toldSameCues = true;
    bus.status(t(sv.sample ? 'stFilmSameCues' : 'stFilmDemoHint'));
  }
});
video.addEventListener('play', () => {
  state.previous = video.currentTime;
  els.play.textContent = t('btnPause');
  note('media: play');
  if (state.quietPlay) state.quietPlay = false;
  else bus.status(t('stPlaying'), { tag: 'transport' });
});
video.addEventListener('pause', () => {
  els.play.textContent = t('btnPlay');
  note('media: pause');
  if (state.quietPause) state.quietPause = false;
  else if (!video.ended) bus.status(t('stPaused'), { tag: 'transport' });
});
video.addEventListener('ended', () => {
  note('media: ended');
  // A film shorter than the sample run ends the run.
  const sampleRun = state.media === 'sample' || state.demoEnd != null;
  state.demoEnd = null;
  bus.status(t(sampleRun ? 'stSampleEnded' : 'stFilmEnded'));
});
video.addEventListener('seeking', () => {
  state.previous = video.currentTime;
});
video.addEventListener('error', () => {
  const code = video.error ? video.error.code : 0;
  note(`media: error ${code}`);
  // Not something the shell can play: back to "no film", so that the keys say so instead of
  // answering as if a film were open.
  state.media = 'none';
  state.demoEnd = null;
  video.hidden = true;
  els.noFilm.hidden = false;
  els.play.textContent = t('btnPlay');
  bus.status(t('stFilmError', { code }));
});
video.addEventListener('timeupdate', tick);
setInterval(tick, 100);

// The buttons of the page.
els.sample.addEventListener('click', () => run('sample', 'button'));
els.open.addEventListener('click', () => run('open', 'button'));
els.dialog.addEventListener('click', () => {
  note('button: open the test dialog');
  openTestDialog();
});
els.notify.addEventListener('click', () => {
  note('button: send a notification');
  sendNotification().catch((err) => note(`notification failed (${err && err.message})`));
});
els.channel.addEventListener('click', () => run('channel', 'button'));
els.help.addEventListener('click', () => run('help', 'button'));
els.report.addEventListener('click', () => run('report', 'button'));
els.mic.addEventListener('click', () => {
  note('button: test the microphone');
  testMicrophone().catch((err) => {
    note(`microphone: test failed (${err && err.message})`);
    bus.status(t('stMicFailed', { reason: String((err && err.name) || 'Error').slice(0, 40) }));
  });
});
els.player.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (button) run(button.dataset.action, 'button');
});
els.rate.addEventListener('change', () => {
  const rate = Number(els.rate.value) || 1;
  bus.setRate(rate);
  note(`rate ${rate}`);
  bus.status(t('stRate', { rate }), { tag: 'rate' });
});

// The single keys, and the native menu.
listenForKeys(document, (action) => run(action, 'key'));
sv.on('menu:action', (payload) => run(payload.action, 'menu'));
sv.on('report:result', reportSaved);

// What makes the screen reader talk: the app voice gives way at once (see speechbus.js).
document.addEventListener('focusin', () => bus.userActed('focus'));
window.addEventListener('focus', () => bus.userActed('window'));
// A native menu or a native dialog (Open, Save) is open: the screen reader is reading it.
sv.on('reader:busy', (payload) => bus.setBlocked(blockReason(payload.cause), payload.open === true));
// A key or a click that reaches the page shows that no menu is open any more, even if its
// closing was never reported: the shell must not stay silent for good. (A native dialog lets
// neither through, and the main process reports its closing however it ends.)
document.addEventListener('pointerdown', () => bus.setBlocked('menu', false), true);
let altAlone = false;
document.addEventListener(
  'keydown',
  (event) => {
    bus.setBlocked('menu', false);
    if (event.key !== 'Alt') altAlone = false;
    else if (!event.repeat) altAlone = true;
    if (event.key === 'Tab') bus.userActed('tab');
    if (event.key === 'F10') bus.userActed('menu');
  },
  true,
);
document.addEventListener(
  'keyup',
  (event) => {
    // Alt pressed and released alone moves the focus to the menu bar on Windows.
    if (event.key === 'Alt' && altAlone) bus.userActed('menu');
    altAlone = false;
  },
  true,
);

// On start the focus is on the heading and nothing plays.
els.title.focus();
sendUi();
// Asking for the voices here also makes Chromium start loading them.
note(`page ready; language ${lang}; voices ${bus.voices().length}`);
if (bus.synth && typeof bus.synth.addEventListener === 'function') bus.synth.addEventListener('voiceschanged', voicesSettled, { once: true });
setTimeout(voicesSettled, VOICES_WAIT_MS);

/** What the self-test works with. */
export const shell = { sv, t, lang, els, video, state, bus, script, run, hooks };

if (sv.selftest) {
  import('./selftest.js')
    .then((module) => module.runSelftest(shell))
    .catch((err) => {
      sv.send('selftest:done', {
        checks: [{ name: 'self-test script', ok: false, detail: String(err && err.message).slice(0, 300) }],
        axe: { ran: false, violations: 0, incomplete: 0, passes: 0, detail: '' },
        info: '',
      });
    });
}
