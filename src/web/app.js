// The web player page (site/play/index.html), wired up. Everything the page
// touches outside its own DOM is passed in (window, fetch, the IFrame API
// loader, speech, storage), so test/web-player.test.js can drive it with a fake
// YouTube player, a fake Gemini and a fake voice. player.js is the entry that
// calls init() with the real ones.
//
// Credentials: the Gemini key and the Cloud device token go to GeminiClient,
// which sends them in the x-goog-api-key header only. They are never put in a
// URL, and the key is written to localStorage only when "remember" is ticked.

import { MODES } from '../shared/constants.js';
import { ApiError } from '../shared/errors.js';
import { runAsk, runGeneration } from '../shared/generation.js';
import { progressMilestone } from '../shared/progress.js';
import { formatTime } from '../shared/script.js';
import { nextValue, stepSpeed } from '../shared/settings.js';
import { chooseLocale, interfaceLocale, localizeDocument, setLocale, t } from './i18n.js';
import { keyAction } from './keys.js';
import { parseVideoLink } from './link.js';
import { makeClient, providerOf, registerWebDevice, webErrorMessage } from './model.js';
import { WebOutput } from './output.js';
import { Playback, STATE } from './playback.js';
import { WebSpeech } from './speech.js';
import { deleteScript, loadKey, loadScript, loadSettings, loadToken, saveKey, saveScript, saveSettings, saveToken } from './store.js';
import { HOSTS, createPlayer, loadIframeApi } from './youtube.js';

/** The home page's key for the remembered interface language, shared with site/script.js. */
const LANG_KEY = 'scenevoice-lang';
/** How far the arrow keys move. */
const SEEK_SECONDS = 5;
/** Voice rates offered, as the extension's slider steps around its default. */
const VOICE_RATES = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2];
/**
 * Sections asked of the model: a short first one so the first descriptions
 * come within seconds, then two-minute ones. Safari (desktop and iPhone) drops
 * a request whose answer has not begun within about 60 seconds, which a
 * five-minute section easily exceeds; the extension, running where that limit
 * does not apply, keeps CHUNK_SECONDS.
 */
export const WEB_FIRST_CHUNK_SECONDS = 60;
export const WEB_CHUNK_SECONDS = 120;
/** After this long without the video's length, the listener is told to start the video in the player (iPhone needs a tap there). */
const DURATION_HINT_MS = 10000;
/** While a section is being made, how often the listener hears that it still is (and the visible line counts the seconds). */
const WAITING_SAY_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The words of shared/labels.js, through the page's own t(): labels.js imports
// shared/i18n.js, which the web build aliases but vitest does not.
/** 1.2 → "1.2×". */
const formatRate = (rate) => t('value_rate', Number(rate).toFixed(1));
/** The name of a screen reader speed preset, as in the settings list. */
function readerSpeedLabel(speed) {
  const labels = { 1: t('speed_normal'), 1.6: t('speed_fast'), 2.4: t('speed_very_fast'), 3.2: t('speed_fastest') };
  return labels[speed] || String(speed);
}

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(win: Window) => Promise<object>} [o.loadApi]  resolves with the YT namespace
 * @param {import('./speech.js').WebSpeech} [o.speech]
 * @param {Storage|null} [o.local]
 * @param {Storage|null} [o.session]
 * @param {string} [o.version]
 * @param {number} [o.tickMs]  0 = no timer (tests call api.tick())
 */
export function init({ win, fetchImpl, loadApi = loadIframeApi, speech, local, session, version = '', tickMs = 250, durationHintMs = DURATION_HINT_MS, waitingSayMs = WAITING_SAY_MS } = {}) {
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const nav = win.navigator || {};
  local = local === undefined ? safeStorage(() => win.localStorage) : local;
  session = session === undefined ? safeStorage(() => win.sessionStorage) : session;
  fetchImpl = fetchImpl || ((...a) => win.fetch(...a));
  speech = speech || new WebSpeech({ synth: win.speechSynthesis, Utterance: win.SpeechSynthesisUtterance, userAgent: nav.userAgent || '' });

  const el = {
    langSwitch: $('lang-switch'),
    linkForm: $('link-form'),
    link: $('link'),
    play: $('play'),
    sourceOwn: $('source-own'),
    sourceCloud: $('source-cloud'),
    keyBlock: $('key-block'),
    key: $('key'),
    remember: $('remember'),
    region: $('player-region'),
    host: $('player-host'),
    frame: $('player-frame'),
    playPause: $('play-pause'),
    back: $('back'),
    forward: $('forward'),
    describeNow: $('describe-now'),
    repeat: $('repeat'),
    stopSpeaking: $('stop-speaking'),
    helpKeys: $('help-keys'),
    status: $('status'),
    description: $('description'),
    progress: $('progress'),
    askForm: $('ask-form'),
    question: $('question'),
    describeAgain: $('describe-again'),
    mode: $('mode'),
    detail: $('detail'),
    density: $('density'),
    output: $('output'),
    readerSpeed: $('reader-speed'),
    voiceRate: $('voice-rate'),
    readerSpeedBlock: $('reader-speed-block'),
    voiceRateBlock: $('voice-rate-block'),
  };

  // ---------- language ----------
  const url = new URL(win.location.href);
  setLocale(chooseLocale({ query: url.searchParams.get('lang'), stored: read(local, LANG_KEY), language: nav.language }));

  function localize() {
    localizeDocument(doc);
    const other = interfaceLocale() === 'en' ? 'zh-CN' : 'en';
    el.langSwitch.href = `?lang=${other}`;
    el.langSwitch.setAttribute('hreflang', other);
    el.langSwitch.setAttribute('lang', other);
    el.langSwitch.dataset.langSwitch = other;
    el.langSwitch.textContent = other === 'en' ? 'English' : '简体中文';
    el.voiceRate.replaceChildren(
      ...VOICE_RATES.map((r) => {
        const o = doc.createElement('option');
        o.value = String(r);
        o.textContent = formatRate(r);
        return o;
      }),
    );
    el.voiceRate.value = String(nearest(VOICE_RATES, settings.ttsRate));
    const iframe = el.frame.querySelector('iframe');
    if (iframe) iframe.setAttribute('title', t('web_video_title'));
  }

  el.langSwitch.addEventListener('click', (e) => {
    e.preventDefault();
    setLocale(el.langSwitch.dataset.langSwitch);
    write(local, LANG_KEY, interfaceLocale());
    localize();
    try {
      const u = new URL(win.location.href);
      u.searchParams.set('lang', interfaceLocale());
      win.history.replaceState(null, '', u);
    } catch {
      /* file: pages */
    }
    output.status(t('web_language_now'));
  });

  // ---------- settings ----------
  const settings = loadSettings(local);
  const state = {
    videoId: '',
    start: 0,
    duration: 0,
    script: null,
    player: null,
    generating: null, // AbortController
    models: { own: '', cloud: '' },
    history: [],
    progressSaid: { milestone: 0, at: 0 },
    enabled: true,
    asking: false,
    /** The last failure, in words: said again when a description is asked for and there is none, so it is not lost behind later status. */
    lastError: '',
  };

  function nearest(list, value) {
    return list.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), list[0]);
  }

  function showSettings() {
    el.mode.value = settings.mode;
    el.detail.value = settings.detail;
    el.density.value = settings.density;
    el.output.value = settings.output;
    el.readerSpeed.value = String(settings.readerSpeed);
    el.voiceRate.value = String(nearest(VOICE_RATES, settings.ttsRate));
    const voice = settings.output === 'tts';
    el.readerSpeedBlock.hidden = voice;
    el.voiceRateBlock.hidden = !voice;
    (settings.source === 'cloud' ? el.sourceCloud : el.sourceOwn).checked = true;
    el.keyBlock.hidden = settings.source === 'cloud';
  }

  function setSetting(key, value, { announce = '' } = {}) {
    settings[key] = value;
    saveSettings(local, settings);
    showSettings();
    if (announce) output.status(announce);
  }

  el.mode.addEventListener('change', () => setSetting('mode', el.mode.value, { announce: t(`announce_mode_${el.mode.value}`) }));
  el.detail.addEventListener('change', () => setSetting('detail', el.detail.value, { announce: t(`announce_detail_${el.detail.value}`) }));
  el.density.addEventListener('change', () => setSetting('density', el.density.value, { announce: t(`announce_density_${el.density.value}`) }));
  el.output.addEventListener('change', () => {
    if (el.output.value === 'tts' && !speech.available) {
      el.output.value = 'screenreader';
      output.status(t('web_voice_unavailable'));
      return;
    }
    playback.stopSpeaking({ keepPause: true });
    speech.unlock();
    setSetting('output', el.output.value);
  });
  el.readerSpeed.addEventListener('change', () => setSetting('readerSpeed', Number(el.readerSpeed.value)));
  el.voiceRate.addEventListener('change', () => setSetting('ttsRate', Number(el.voiceRate.value)));
  for (const radio of [el.sourceOwn, el.sourceCloud]) {
    radio.addEventListener('change', () => {
      if (radio.checked) setSetting('source', radio.value);
    });
  }

  // ---------- the key ----------
  const saved = loadKey({ local, session });
  el.key.value = saved.key;
  el.remember.checked = saved.remembered;
  const storeKey = () => saveKey({ local, session }, el.key.value, el.remember.checked);
  el.key.addEventListener('change', storeKey);
  el.remember.addEventListener('change', () => {
    storeKey();
    if (!el.remember.checked) output.status(t('web_key_forgotten'));
  });

  // ---------- output and playback ----------
  const output = new WebOutput({
    description: el.description,
    status: el.status,
    getSettings: () => settings,
    speech,
    uiLang: () => interfaceLocale(),
    lang: () => interfaceLocale(),
    onVoiceFailed: () => {
      settings.output = 'screenreader';
      saveSettings(local, settings);
      showSettings();
      output.status(t('web_voice_unavailable'));
    },
  });
  const playback = new Playback({
    player: () => state.player,
    output,
    getSettings: () => settings,
    aiNotice: () => t('ai_notice'),
    onSkipped: (n) => output.status(t('web_skipped_no_pause', String(n))),
    latePrefix: () => t('late_prefix'),
  });
  const timer = tickMs > 0 ? setInterval(() => playback.tick(), tickMs) : null;

  // ---------- starting a video ----------
  async function start(text) {
    const parsed = parseVideoLink(text);
    if (!String(text || '').trim()) {
      output.status(t('web_link_missing'));
      el.link.focus();
      return;
    }
    if (!parsed) {
      output.status(t('web_link_invalid'));
      el.link.focus();
      return;
    }
    if (parsed.bilibili) {
      output.status(t('web_link_bilibili'));
      return;
    }
    if (settings.source !== 'cloud' && !el.key.value.trim()) {
      output.status(t('web_key_missing'));
      el.key.focus();
      return;
    }
    speech.unlock();
    storeKey();
    stopGeneration();
    playback.stopSpeaking({ keepPause: true });
    state.videoId = parsed.videoId;
    state.start = parsed.start;
    state.script = null;
    state.history = [];
    state.duration = 0;
    state.lastError = '';
    playback.setVideo();
    el.progress.textContent = '';
    output.status(t('web_status_loading_player'));
    try {
      await ensurePlayer(parsed.videoId, parsed.start);
    } catch (err) {
      output.status(err?.message === 'video' ? t('web_status_video_error') : t('web_status_player_failed'));
      return;
    }
    if (state.videoId !== parsed.videoId) return;
    el.region.focus();
    // Play first: the embedded player knows a video's length only once it has
    // started (getDuration() is 0 before that), and the listener did press Play.
    const lang = interfaceLocale();
    const cached = loadScript(local, parsed.videoId, lang);
    if (cached) {
      state.script = cached;
      playback.setScript(cached);
    }
    state.player.playVideo?.();
    const duration = await waitForDuration(parsed.videoId);
    if (state.videoId !== parsed.videoId || !duration) return;
    state.duration = duration;
    if (cached?.complete) {
      output.status(t('web_status_cached', String(cached.cues.length)));
      return;
    }
    await generate(cached);
  }

  async function ensurePlayer(videoId, start) {
    if (state.player) {
      state.player.loadVideoById?.({ videoId, startSeconds: start || 0 });
      return state.player;
    }
    const YT = await loadApi(win);
    const origin = win.location.origin && win.location.origin !== 'null' ? win.location.origin : undefined;
    const events = {
      onStateChange: (e) => {
        if (e?.data === STATE.ENDED) output.status(t('web_status_ended'));
      },
      onError: () => {
        stopGeneration();
        output.status(t('web_status_video_error'));
      },
    };
    let player = null;
    let lastError = null;
    for (const host of HOSTS) {
      // createPlayer replaces the host element with the iframe: a fresh one for each try.
      const target = doc.createElement('div');
      target.id = 'player-host';
      el.frame.replaceChildren(target);
      try {
        player = await createPlayer(YT, target, { videoId, start, origin, host, title: t('web_video_title'), events });
        break;
      } catch (err) {
        lastError = err;
        try {
          player?.destroy?.();
        } catch {
          /* nothing to destroy */
        }
        if (err?.message === 'video') break;
      }
    }
    if (!player) throw lastError || new Error('timeout');
    state.player = player;
    return player;
  }

  /**
   * The video's length, once the player reports this video (after loadVideoById
   * it keeps the previous one's for a moment; before the video has started it
   * says 0). Waits as long as this video is the current one: on an iPhone the
   * page's Play may not start the embedded player, so after a while the
   * listener is told to start it there, and generation begins once it runs.
   */
  async function waitForDuration(videoId) {
    const hintAt = Date.now() + durationHintMs;
    let hinted = false;
    while (state.videoId === videoId) {
      const loaded = state.player?.getVideoData?.()?.video_id;
      const d = loaded && loaded !== videoId ? 0 : Number(state.player?.getDuration?.());
      if (Number.isFinite(d) && d > 0) return d;
      if (!hinted && Date.now() >= hintAt) {
        hinted = true;
        output.status(t('web_status_press_play'));
      }
      await sleep(250);
    }
    return 0;
  }

  // ---------- descriptions ----------
  async function client() {
    const source = settings.source;
    if (source === 'cloud') {
      let token = loadToken(local);
      if (!token) {
        token = (await registerWebDevice(fetchImpl, { version, locale: interfaceLocale() })).token;
        saveToken(local, token);
      }
      return makeClient({ source, token, model: state.models.cloud, fetchImpl });
    }
    return makeClient({ source, key: el.key.value.trim(), model: state.models.own, fetchImpl });
  }

  /** An error from the model or the relay, said in plain words with the next step. */
  function sayError(err, { resumable = false } = {}) {
    const source = settings.source;
    const provider = providerOf(source);
    if (source === 'cloud' && err instanceof ApiError && err.code === 'bad-key') saveToken(local, '');
    if (source === 'cloud' && err instanceof ApiError && (err.code === 'network' || err.code === 'request-failed' || err.code === 'rate-limited' || err.code === 'device-limit') && !state.script) {
      rememberError(t('web_cloud_unreachable'));
      return;
    }
    let text = webErrorMessage(err, provider);
    if (resumable && state.script?.completedUntil) text = `${text} ${t('web_error_resume', String(Math.max(1, Math.round(state.script.completedUntil / 60))))}`;
    rememberError(text);
  }

  /** Say a failure now, keep it for later, and leave it in view under the player for a sighted helper. */
  function rememberError(text) {
    state.lastError = text;
    el.progress.textContent = text;
    output.status(text);
  }

  function stopGeneration() {
    state.generating?.abort();
    state.generating = null;
  }

  async function generate(resumeFrom = null) {
    const videoId = state.videoId;
    const lang = interfaceLocale();
    const source = settings.source;
    let c;
    try {
      c = await client();
    } catch (err) {
      sayError(err);
      return;
    }
    if (state.videoId !== videoId) return;
    const controller = new AbortController();
    state.generating = controller;
    state.lastError = '';
    state.progressSaid = { milestone: 0, at: Date.now() };
    output.status(resumeFrom ? t('web_status_resuming', String(Math.max(1, Math.round((resumeFrom.completedUntil || 0) / 60)))) : t('web_status_generating'));
    const mine = () => state.generating === controller && state.videoId === videoId;
    let firstSaid = Boolean(resumeFrom);
    // A slow section is not silence: the visible line counts the seconds, and
    // every WAITING_SAY_MS the listener hears that the section is still being made.
    let sectionStartedAt = Date.now();
    let sectionLabel = resumeFrom ? '' : t('progress_working');
    const waitTimer = setInterval(() => {
      if (!mine()) return;
      const seconds = Math.round((Date.now() - sectionStartedAt) / 1000);
      el.progress.textContent = t('web_status_waiting', sectionLabel || t('progress_working'), String(seconds));
      if (seconds > 0 && (seconds * 1000) % waitingSayMs < 1000) output.status(t('web_status_still_working', String(seconds)));
    }, 1000);
    try {
      const meta = videoMeta();
      await runGeneration({
        client: c,
        videoId,
        duration: state.duration,
        meta,
        lang,
        script: resumeFrom,
        signal: controller.signal,
        chunkSeconds: WEB_CHUNK_SECONDS,
        firstChunkSeconds: WEB_FIRST_CHUNK_SECONDS,
        onModel: (model, reason) => {
          // The model was overloaded, gone, or out of quota: another one carries on. Said, so the wait is explained.
          if (!mine()) return;
          sectionStartedAt = Date.now();
          output.status(t(reason === 'server' ? 'web_status_model_busy' : 'web_status_model_switched', model));
        },
        onChunk: (sc, { done, total }) => {
          if (!mine()) return;
          state.models[source] = c.model || '';
          state.script = sc;
          saveScript(local, sc);
          playback.setScript(sc);
          const percent = Math.round((100 * done) / Math.max(1, total));
          sectionStartedAt = Date.now();
          sectionLabel = total > 1 ? t('progress_section', String(Math.min(done + 1, total)), String(total)) : t('progress_working');
          el.progress.textContent = sc.complete ? '' : `${sectionLabel} ${percent}%`;
          if (sc.complete) return;
          if (!firstSaid) {
            firstSaid = true;
            state.progressSaid = { milestone: 0, at: Date.now() };
            output.status(t('web_status_first_ready', String(Math.max(1, Math.round((sc.completedUntil || 0) / 60)))));
            return;
          }
          const milestone = progressMilestone({ fraction: done / Math.max(1, total), said: state.progressSaid.milestone, saidAt: state.progressSaid.at, now: Date.now() });
          if (milestone) {
            state.progressSaid = { milestone, at: Date.now() };
            output.status(t('status_progress_percent_single', String(percent)));
          }
        },
      });
      clearInterval(waitTimer);
      if (!mine()) return;
      state.models[source] = c.model || '';
      state.generating = null;
      el.progress.textContent = '';
      const n = state.script?.cues?.length || 0;
      output.status(n ? t('web_status_ready', String(n)) : t('status_ready_empty'));
    } catch (err) {
      clearInterval(waitTimer);
      if (!mine()) return;
      state.generating = null;
      el.progress.textContent = '';
      if (err instanceof ApiError && err.code === 'aborted') return;
      sayError(err, { resumable: true });
    }
  }

  function videoMeta() {
    try {
      const data = state.player?.getVideoData?.() || {};
      return { title: data.title || '', channel: data.author || '' };
    } catch {
      return {};
    }
  }

  // ---------- actions ----------
  const playing = () => state.player?.getPlayerState?.() === STATE.PLAYING;
  const noVideo = () => {
    if (state.player && state.videoId) return false;
    output.status(t('web_status_no_video'));
    return true;
  };

  const actions = {
    'play-pause': () => {
      if (noVideo()) return;
      playback.userTookOver();
      if (playing()) {
        state.player.pauseVideo();
        output.status(t('web_status_paused'));
      } else {
        state.player.playVideo();
        output.status(t('web_status_playing'));
      }
    },
    back: () => seekBy(-SEEK_SECONDS),
    forward: () => seekBy(SEEK_SECONDS),
    'describe-now': () => {
      if (noVideo()) return;
      if (!state.script) {
        // No descriptions, and the reason may have been talked over since: say it again.
        output.status(state.generating ? t('web_status_not_yet') : state.lastError ? `${t('web_status_no_descriptions')} ${state.lastError}` : t('web_status_no_descriptions'));
        return;
      }
      if (!playback.describeNow()) output.status(t('web_status_nothing_here'));
    },
    'repeat-last': () => {
      if (!playback.repeatLast()) output.status(t('status_nothing_to_repeat'));
    },
    ask: () => {
      el.question.focus();
    },
    'stop-speaking': () => {
      playback.stopSpeaking();
      output.status(t('status_stopped'));
    },
    'cycle-mode': () => {
      const next = nextValue(MODES, settings.mode);
      setSetting('mode', next, { announce: t(`announce_mode_${next}`) });
    },
    'speed-up': () => changeSpeed(1),
    'speed-down': () => changeSpeed(-1),
    help: () => output.status(t('web_keys_list')),
    toggle: () => {
      state.enabled = !state.enabled;
      playback.enabled = state.enabled;
      if (!state.enabled) {
        // Off means no more requests: a generation under way stops here (what is saved is kept).
        stopGeneration();
        playback.stopSpeaking();
        el.progress.textContent = '';
      }
      output.status(state.enabled ? t('status_on') : t('status_off'));
      if (state.enabled && state.videoId && state.duration && !state.script?.complete && !state.generating) generate(state.script);
    },
  };

  function seekBy(delta) {
    if (noVideo()) return;
    const now = Number(state.player.getCurrentTime?.()) || 0;
    const to = Math.max(0, Math.min(state.duration || Infinity, now + delta));
    state.player.seekTo(to, true);
    output.status(t(delta < 0 ? 'web_status_seek_back' : 'web_status_seek_forward', formatTime(to)));
  }

  function changeSpeed(direction) {
    const { key, value, atLimit } = stepSpeed(settings, direction);
    settings[key] = value;
    saveSettings(local, settings);
    showSettings();
    const said = key === 'ttsRate' ? t('announce_rate', formatRate(value)) : t('announce_reader_speed', readerSpeedLabel(value));
    output.status(atLimit ? `${said} ${t(direction > 0 ? 'announce_fastest' : 'announce_slowest')}` : said);
  }

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q) {
      output.status(t('web_ask_empty'));
      el.question.focus();
      return;
    }
    if (noVideo() || state.asking) return;
    state.asking = true;
    const videoId = state.videoId;
    const time = Number(state.player.getCurrentTime?.()) || 0;
    const wasPlaying = playing();
    if (wasPlaying) {
      playback.userTookOver();
      state.player.pauseVideo();
    }
    output.status(t('ask_thinking'));
    try {
      const c = await client();
      const nearby = (state.script?.cues || []).filter((cue) => cue.start <= time + 0.5 && time - cue.start <= 60).slice(-4);
      const res = await runAsk(c, {
        videoId,
        meta: videoMeta(),
        time,
        duration: state.duration,
        question: q,
        nearbyText: nearby.map((cue) => `${formatTime(cue.start)} ${cue.standard}`).join(' | '),
        history: state.history,
        characters: state.script?.characters || [],
        lang: interfaceLocale(),
      });
      if (state.videoId !== videoId) return;
      state.models[settings.source] = c.model || '';
      state.history = [...state.history, { question: q, answer: res.text }].slice(-3);
      el.question.value = '';
      el.region.focus();
      await playback.sayManual(res.text);
    } catch (err) {
      if (state.videoId === videoId) sayError(err);
    } finally {
      state.asking = false;
      if (wasPlaying && state.videoId === videoId && !playing()) state.player.playVideo?.();
    }
  }

  function describeAgain() {
    if (noVideo()) return;
    stopGeneration();
    playback.stopSpeaking({ keepPause: true });
    deleteScript(local, state.videoId, interfaceLocale());
    state.script = null;
    playback.setScript(null);
    playback.setVideo();
    generate(null);
  }

  // ---------- wiring ----------
  el.linkForm.addEventListener('submit', (e) => {
    e.preventDefault();
    start(el.link.value);
  });
  el.askForm.addEventListener('submit', (e) => {
    e.preventDefault();
    ask(el.question.value);
  });
  el.playPause.addEventListener('click', actions['play-pause']);
  el.back.addEventListener('click', actions.back);
  el.forward.addEventListener('click', actions.forward);
  el.describeNow.addEventListener('click', actions['describe-now']);
  el.repeat.addEventListener('click', actions['repeat-last']);
  el.stopSpeaking.addEventListener('click', actions['stop-speaking']);
  el.helpKeys.addEventListener('click', actions.help);
  el.describeAgain.addEventListener('click', describeAgain);

  doc.addEventListener('keydown', (e) => {
    const target = e.target instanceof win.Element ? e.target : null;
    const action = keyAction(e, { inApplication: Boolean(target && el.region.contains(target)), target });
    if (!action || !actions[action]) return;
    e.preventDefault();
    actions[action]();
  });

  win.addEventListener('pagehide', () => {
    stopGeneration();
    speech.cancel();
  });

  // The page can be opened with a video already in the address (play/?v=…): filled in, not started.
  const given = url.searchParams.get('v') || url.searchParams.get('link');
  if (given) el.link.value = given;

  localize();
  showSettings();

  return {
    state,
    settings,
    output,
    playback,
    speech,
    actions,
    start,
    ask,
    tick: () => playback.tick(),
    destroy: () => {
      if (timer) clearInterval(timer);
      stopGeneration();
      speech.cancel();
    },
  };
}

function safeStorage(get) {
  try {
    return get() || null;
  } catch {
    return null;
  }
}

function read(storage, key) {
  try {
    return storage?.getItem(key) || '';
  } catch {
    return '';
  }
}

function write(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage off */
  }
}
