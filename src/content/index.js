// Content script: follows playback on YouTube or Bilibili (see platforms.js)
// and delivers descriptions at the right moments.
//
// How the model sees the video depends on the provider chosen for the site
// (shared/providers.js). Gemini on YouTube opens the video by its link and
// describes it ahead of playback: generation runs as a job in the extension.
// Otherwise this page takes pictures from the playing video every few seconds
// and sends a few at a time to be described ("frames" mode, `live` below):
// descriptions then come a few seconds after the picture, and are saved for
// the next viewing like any others.

import { MSG, DEFAULT_SETTINGS, CHUNK_SECONDS, DENSITIES, DETAILS, FRAME_SAMPLING, MODES } from '../shared/constants.js';
import { coverageSeconds, coveredRanges, isCovered, pickEvenly } from '../shared/coverage.js';
import { t, errorMessage } from '../shared/i18n.js';
import { readerSpeedLabel, typeAdjustedText } from '../shared/labels.js';
import { markChoices, nextValue, stepSpeed } from '../shared/settings.js';
import { authorizeContentMessage } from '../shared/sender.js';
import { resolveLanguage, setSettings, watchSettings } from '../shared/storage.js';
import { chooseUtterance, cueAt, estimateSeconds, formatTime, passesDensity } from '../shared/script.js';
import { CueScheduler, mayInterrupt, pickOne } from '../shared/scheduler.js';
import { fitCuesToDialogue, parseTimedText, speechIntervals } from '../shared/dialogue.js';
import { dropTextHeardInCaptions } from '../shared/onscreen.js';
import { resolveVideoType, typeAdjustments } from '../shared/videotype.js';
import { inputModeFor, providerFor } from '../shared/providers.js';
import { Announcer } from './announcer.js';
import { PageUI } from './ui.js';
import { FrameSampler, captureFrame } from './frames.js';
import { askAboutMoment, describeFrames, reviseDescription, startGeneration, stopGeneration } from './generator.js';
import { platformFor } from './platforms.js';

if (!window.__sceneVoiceLoaded) {
  window.__sceneVoiceLoaded = true;
  main();
}

/** How long after its moment a description that came back late may still be said, and how long it may wait for a pause. */
const LATE_LIMIT = 25;
const LATE_WAIT = 10;
/** Errors after which taking frames carries on (the stretch is skipped); any other stops it. */
const PASSING_FRAME_ERRORS = new Set(['quota', 'server', 'network', 'request-failed', 'bad-json', 'truncated', 'empty-response', 'blocked', 'too-long', 'unknown', 'frames-missing', 'offscreen-unavailable']);

function main() {
  const platform = platformFor(location.href);
  const { getMeta, getPageDuration, getVideo, isAdShowing } = platform;
  let settings = { ...DEFAULT_SETTINGS };
  let lang = 'en';
  let videoId = null;
  let script = null;
  /** 'none' | 'loading' | 'generating' | 'ready' | 'partial' | 'error' */
  let status = 'none';
  /** done/total sections; chunkStartedAt and chunkMs let the UI estimate progress inside a section. */
  let progress = { done: 0, total: 0, chunkStartedAt: 0, chunkMs: [] };
  let errorCode = '';
  /** True while this tab follows the generation job for the current video (the job itself runs in the extension). */
  let following = false;
  /** Video id for which generate() is still waiting on the player. */
  let startingFor = null;
  /** Whether the "first minutes are ready" message has been given for this job. */
  let announcedPartial = false;
  /** Bumped to cancel a generate() that is still waiting for the player. */
  let beginSeq = 0;
  /** Stretches of speech in the current video, from its captions; null when unknown. */
  let dialogue = null;
  /** The caption lines themselves, to leave out on-screen text the viewer hears anyway. */
  let captionLines = [];
  /** Caption URLs already tried for the current video. */
  let captionUrlsTried = new Set();
  /** The video type the watch page suggests, '' until known. A type in the script (Gemini's) comes first. */
  let pageType = '';
  /** 'entertainment' | 'tutorial' | '' for the current video. */
  let videoType = '';
  /** Mode, detail and density used for this video instead of the settings, because of its type. */
  let adjusted = {};
  /** `${videoId}:${type}` once the user has heard what the type changed. */
  let typeAnnouncedFor = '';
  /** How to undo an adjustment is said once per tab, with the first one. */
  let typeUndoHintGiven = false;
  /** {text, kind, cue}: cue is the saved description it came from, null for an answer to a question. */
  let lastSpoken = null;
  /** Video id while a description marked as wrong is being made again. */
  let revisingFor = null;
  /** The cue being spoken during playback ({kind, priority}), or null. */
  let speakingCue = null;
  let speechToken = 0;
  /** Token of the utterance that paused the video, or 0 when the video is not paused by us. */
  let pausedByUs = 0;
  let duckState = null;
  let hintedFor = null;
  let tickCount = 0;
  let shortcuts = {};
  let started = false;
  let dead = false;
  const timers = [];
  const watchedVideos = new WeakSet();
  const isFrame = window.top !== window;

  // Frames mode only (see the top of this file).
  /** This tab is taking pictures of the current video and having them described. */
  let live = false;
  /** Bumped whenever taking pictures stops, so a reply for an earlier run is ignored. */
  let liveSeq = 0;
  let framesInFlight = false;
  /** A stretch that came due while another was being described. */
  let queuedWindow = null;
  /** Date.now() before which no frames are sent, after a passing error. */
  let framesPausedUntil = 0;
  /** Passing errors already announced for this video. */
  let framesErrorsSaid = new Set();
  /** { cue, at }: a description that came back after its moment, waiting for a pause. */
  let pendingLate = null;
  let frameCanvas = null;
  const sampler = new FrameSampler(FRAME_SAMPLING);

  const scheduler = new CueScheduler([]);
  const announcer = new Announcer(() => settings);
  const ui = new PageUI({ onToggle: () => toggle(), platform });

  /** The model that describes videos on this site, and whether it is sent frames. */
  const provider = () => providerFor(settings, platform.id);
  const framesMode = () => inputModeFor(provider(), platform.id) === 'frames';
  /** An error in words, in the terms of the provider in use. */
  const errorText = (code) => errorMessage(code, provider());

  /** Message the service worker; never throws, even after the extension was reloaded. */
  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch((err) => ({ error: 'extension-reloaded', detail: String(err) }));
    } catch (err) {
      return Promise.resolve({ error: 'extension-reloaded', detail: String(err) });
    }
  };

  const readerRate = () => (settings.output === 'tts' ? settings.ttsRate : settings.readerSpeed);
  /** A setting as it applies to this video: mode, detail and density may follow the video type. */
  const setting = (key) => (key in adjusted ? adjusted[key] : settings[key]);
  const shortcut = (name) => shortcuts[name] || '';

  /** Direct feedback to a user action: always delivered, cutting off any description in flight. */
  const feedback = (text) => {
    if (settings.output === 'tts') {
      announcer.announceToScreenReader(text, false);
      return announcer.say(text);
    }
    return announcer.say(text, { status: true, urgent: false });
  };

  /** Called once the extension has been updated or disabled under us. */
  function die() {
    if (dead) return;
    dead = true;
    timers.forEach(clearInterval);
    announcer.announceToScreenReader(errorText('extension-reloaded'), false);
  }

  async function refreshShortcuts() {
    const res = await send({ type: MSG.GET_STATUS });
    if (res?.error === 'extension-reloaded') return die();
    shortcuts = res?.shortcuts || {};
    ui.setButtonState(settings.enabled, shortcut('toggle-descriptions'));
    return undefined;
  }

  /**
   * Whether an API key is saved for the provider this site uses. The keys stay
   * in the service worker: this page only hears yes or no.
   * chrome.storage.local is not readable from here.
   */
  async function hasKey() {
    const res = await send({ type: MSG.GET_STATUS });
    if (res?.error === 'extension-reloaded') {
      die();
      return false;
    }
    return Boolean(res?.keys ? res.keys[provider()] : res?.hasKey);
  }

  /**
   * One cached description script. The cache lives in chrome.storage.local,
   * which content scripts cannot read, so the service worker looks it up.
   */
  async function fetchScript(id, l) {
    const res = await send({ type: MSG.GET_SCRIPT, videoId: id, lang: l });
    if (res?.error === 'extension-reloaded') {
      die();
      return null;
    }
    if (!res || res.error) return null;
    return res.script ?? null;
  }

  // ---------- settings ----------

  // Preferences live in chrome.storage.sync and include no secrets, so this
  // page reads them directly. Shortcuts come from the service worker.
  watchSettings((s) => {
    const prevLang = lang;
    const wasEnabled = settings.enabled;
    settings = s;
    updateType();
    lang = resolveLanguage(s.language, chrome.i18n.getUILanguage(), platform.id);
    announcer.lang = lang;
    ui.setButtonState(s.enabled, shortcut('toggle-descriptions'));
    if (!s.showText) ui.hideText();
    if (wasEnabled && !s.enabled) stopSpeaking();
    // Turned off, or another model chosen for this site: stop taking pictures.
    if (live && (!s.enabled || !framesMode())) stopLive();
    if (!started) {
      // Settings are known: now follow the page.
      started = true;
      refreshShortcuts();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !dead) refreshShortcuts();
      });
      platform.onNavigate(onPage);
      platform.watchCaptionRequests((id, url) => {
        if (id === videoId && !dialogue && !dead) loadDialogue(id, [url]);
      });
      onPage();
      timers.push(setInterval(tick, 120));
      return;
    }
    if (videoId && prevLang !== lang) {
      // Descriptions are per language: drop the old ones and look for the new.
      stopLive();
      stopJob();
      stopSpeaking();
      resetVideoState();
      loadScript();
    }
  });

  // ---------- page lifecycle ----------

  function resetVideoState() {
    script = null;
    status = 'none';
    errorCode = '';
    following = false;
    announcedPartial = false;
    progress = { done: 0, total: 0, chunkStartedAt: 0, chunkMs: [] };
    ui.hideProgress();
    lastSpoken = null;
    pendingLate = null;
    scheduler.setCues([]);
    ui.hideText();
    updateType();
  }

  function onPage() {
    const id = platform.videoIdFromUrl(location.href);
    if (id === videoId) return;
    stopLive();
    stopJob();
    stopSpeaking();
    videoId = id;
    dialogue = null;
    captionLines = [];
    captionUrlsTried = new Set();
    pageType = '';
    sampler.clear();
    framesErrorsSaid = new Set();
    resetVideoState();
    if (!id) return;
    ui.mount();
    loadScript();
    loadWatchPage(id);
  }

  /**
   * Read what the site says about the video, once: its category gives the
   * video type before any description exists, and its captions (YouTube) or CC
   * subtitles (Bilibili) give the dialogue timing.
   */
  async function loadWatchPage(id) {
    let page = { category: '', captionUrls: [] };
    try {
      page = await platform.loadPageInfo(id);
    } catch (err) {
      console.info('[SceneVoice] could not read the watch page', String(err));
    }
    if (dead || id !== videoId) return;
    pageType = platform.videoType({ category: page.category, title: getMeta().title });
    updateType();
    announceType();
    if (page.captionUrls?.length) loadDialogue(id, page.captionUrls);
  }

  /**
   * Learn when people speak from the video's captions, so descriptions fit the
   * real pauses rather than the model's estimate, and what they say, so text on
   * screen that is also spoken is not read twice. Without captions the model's
   * estimate is used as before.
   */
  async function loadDialogue(id, urls) {
    try {
      for (const url of urls) {
        if (dead || id !== videoId || dialogue || captionUrlsTried.has(url)) return;
        captionUrlsTried.add(url);
        const res = await fetch(url, { credentials: 'same-origin' });
        const lines = res.ok ? parseTimedText(await res.text()) : [];
        const intervals = speechIntervals(lines);
        if (dead || id !== videoId || dialogue) return;
        if (intervals.length) {
          dialogue = intervals;
          captionLines = lines;
          console.info(`[SceneVoice] dialogue timing from captions: ${intervals.length} stretches of speech`);
          if (script) scheduleCues();
          return;
        }
      }
    } catch (err) {
      console.info('[SceneVoice] no caption timing', String(err));
    }
  }

  async function loadScript() {
    const id = videoId;
    const l = lang;
    status = 'loading';
    const cached = await fetchScript(id, l);
    if (dead || id !== videoId || l !== lang) return undefined;
    if (cached) {
      setScript(cached);
      console.info(`[SceneVoice] ${cached.cues.length} saved descriptions for ${id} (${l})${cached.complete ? '' : ', incomplete'}`);
      announceType();
      // A previous run stopped part-way (tab closed, quota): carry on where it left off.
      // From frames, only while descriptions are on: pictures are taken as the video plays.
      if (!cached.complete && (!framesMode() || settings.enabled)) generate({ quiet: true });
      return undefined;
    }
    status = 'none';
    if (settings.autoGenerate && settings.enabled && (await hasKey()) && id === videoId && l === lang) {
      generate();
      return undefined;
    }
    const v = getVideo();
    if (v && !v.paused) maybeHint();
    return undefined;
  }

  /** Tell the user once per video that descriptions can be created. */
  function maybeHint() {
    if (!videoId || hintedFor === videoId || status !== 'none' || !settings.enabled || isAdShowing()) return;
    hintedFor = videoId;
    const key = shortcut('toggle-descriptions');
    announcer.status(key ? t('status_hint_generate', key) : t('status_hint_generate_button'));
  }

  function setScript(sc) {
    script = sc;
    updateType();
    scheduleCues();
    status = sc.complete ? 'ready' : 'partial';
  }

  // ---------- video type ----------

  /** Work out the video type and what it changes. Run whenever the settings, the script or the page type change. */
  function updateType() {
    const type = videoId ? resolveVideoType({ scriptType: script?.videoType, pageType }) : '';
    if (type !== videoType) console.info(`[SceneVoice] video type: ${type || 'unknown'}${type && type === script?.videoType ? ' (from Gemini)' : ''}`);
    videoType = type;
    adjusted = typeAdjustments(settings, type);
  }

  /**
   * Say once per video what its type changed, as soon as there are
   * descriptions to play. The first time in a tab, also say how to undo it.
   * @param {boolean} enabled  descriptions are on (just turned on: the settings may not have caught up yet)
   */
  function announceType(enabled = settings.enabled) {
    if (!videoId || !script || !enabled || !Object.keys(adjusted).length) return;
    const key = `${videoId}:${videoType}`;
    if (typeAnnouncedFor === key) return;
    typeAnnouncedFor = key;
    const text = typeAdjustedText(videoType, adjusted);
    announcer.status(typeUndoHintGiven ? text : `${text} ${t('type_switched_undo')}`);
    typeUndoHintGiven = true;
  }

  /**
   * Hand the script's cues to the scheduler. When the captions are known,
   * on-screen text they already say is left out, and the rest is moved and
   * trimmed to the real dialogue.
   */
  function scheduleCues() {
    // Playback may move a cue; `source` is the saved one, which "Description is wrong" points at.
    let cues = (script?.cues || []).map((c) => ({ ...c, source: c }));
    if (dialogue) {
      const { cues: kept, dropped } = dropTextHeardInCaptions(cues, captionLines);
      if (dropped.length) console.info(`[SceneVoice] ${dropped.length} on-screen texts left out: already in the captions`, dropped.map((c) => `${formatTime(c.start)} ${c.onScreenText || c.standard}`));
      cues = fitCuesToDialogue(kept, dialogue);
    }
    scheduler.setCues(cues);
    const v = getVideo();
    scheduler.reset(v && !isAdShowing() ? v.currentTime : null);
  }

  /**
   * Stop following the job (leaving the page, changing language). The job itself
   * carries on in the extension and its result is saved, so the descriptions are
   * ready when the user comes back. An explicit Stop goes through stopGeneration().
   */
  function stopJob() {
    following = false;
    if (status === 'generating') status = script ? 'partial' : 'none';
    ui.hideProgress();
  }

  function applyProgress({ done, total, chunkStartedAt, chunkMs }) {
    progress = {
      done: Number(done) || 0,
      total: Number(total) || progress.total || 1,
      chunkStartedAt: Number(chunkStartedAt) || Date.now(),
      chunkMs: Array.isArray(chunkMs) ? chunkMs : [],
    };
    renderProgress();
  }

  /** Expected time for one section: measured so far, or a typical value. */
  function expectedChunkMs() {
    const ms = progress.chunkMs;
    if (!ms.length) return 45000;
    return ms.reduce((a, b) => a + b, 0) / ms.length;
  }

  /**
   * Estimated completion, 0..1. Finished sections count fully; the current one
   * advances with time up to 95%, since the model gives no feedback until it answers.
   */
  function progressFraction() {
    const { done, total, chunkStartedAt } = progress;
    if (!total) return 0;
    const within = chunkStartedAt ? Math.min(0.95, (Date.now() - chunkStartedAt) / expectedChunkMs()) : 0;
    return Math.min(1, (done + within) / total);
  }

  function etaSeconds() {
    const { done, total, chunkStartedAt } = progress;
    if (!total) return null;
    const remainingInCurrent = chunkStartedAt ? Math.max(0, expectedChunkMs() - (Date.now() - chunkStartedAt)) : expectedChunkMs();
    return Math.round((remainingInCurrent + Math.max(0, total - done - 1) * expectedChunkMs()) / 1000);
  }

  function renderProgress() {
    if (status !== 'generating') return;
    ui.showProgress({ done: progress.done, total: progress.total, fraction: progressFraction(), eta: etaSeconds() });
  }

  // ---------- generation ----------

  /**
   * Wait until the player shows the real video (not an ad) and knows its length.
   * Resolves to the video element, or null if nothing usable turned up.
   */
  async function waitForVideo(id, maxMs = 240000) {
    const startedAt = Date.now();
    for (;;) {
      if (id !== videoId) return null;
      const v = getVideo();
      if (v && !isAdShowing() && Number.isFinite(v.duration) && v.duration > 0) {
        // During a pre-roll the same <video> element reports the ad's length;
        // the page's own metadata is the arbiter when both are available.
        const declared = getPageDuration();
        if (!Number.isFinite(declared) || Math.abs(declared - v.duration) < 3) return v;
      } else if (v && v.duration === Infinity && !isAdShowing()) {
        return v;
      }
      if (Date.now() - startedAt > maxMs) return null;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function generate({ force = false, quiet = false } = {}) {
    if (!videoId) return;
    if (status === 'generating' || status === 'live' || startingFor === videoId) {
      feedback(progressText());
      return;
    }
    const id = videoId;
    const seq = (beginSeq += 1);
    startingFor = id;
    try {
      await begin({ id, force, quiet, seq });
    } finally {
      if (startingFor === id) startingFor = null;
    }
  }

  async function begin({ id, force, quiet, seq }) {
    const l = lang;
    if (!(await hasKey())) {
      if (dead) return undefined;
      status = 'error';
      errorCode = 'no-key';
      feedback(errorText('no-key'));
      send({ type: MSG.OPEN_OPTIONS });
      return undefined;
    }
    if (isAdShowing() && !quiet) feedback(t('status_waiting_for_ad'));
    const v = await waitForVideo(id);
    if (id !== videoId || l !== lang || seq !== beginSeq) return undefined;
    if (!v) {
      status = 'error';
      errorCode = 'bad-duration';
      feedback(errorText(errorCode));
      return undefined;
    }
    if (v.duration === Infinity) {
      status = 'error';
      errorCode = 'live';
      feedback(errorText(errorCode));
      return undefined;
    }
    if (framesMode()) return startLive({ force, quiet });

    status = 'generating';
    errorCode = '';
    announcedPartial = false;
    progress = { done: 0, total: Math.max(1, Math.ceil(v.duration / CHUNK_SECONDS)), chunkStartedAt: Date.now(), chunkMs: [] };
    renderProgress();
    if (!quiet) feedback(t('status_generating'));
    else announcer.status(t('status_resuming'));

    const res = await startGeneration(send, { videoId: id, duration: v.duration, meta: getMeta(), lang: l, force });
    if (id !== videoId || l !== lang || seq !== beginSeq) return undefined;
    if (!res || res.error) return onGenerationError(res?.error || 'unknown', res?.detail);
    if (res.status === 'ready') {
      const sc = await fetchScript(id, l);
      if (dead || id !== videoId || l !== lang) return undefined;
      if (sc) onGenerationDone(sc);
      else onGenerationError('unknown', 'no script after ready');
      return undefined;
    }
    following = true;
    applyProgress(res);
    return undefined;
  }

  /** A section finished (in this tab's job or another tab's). */
  async function onGenerationChunk(ev) {
    following = true;
    applyProgress(ev);
    const sc = await fetchScript(ev.videoId, ev.lang);
    if (dead || ev.videoId !== videoId || ev.lang !== lang) return;
    if (sc?.cues?.length) {
      setScript(sc);
      status = 'generating';
    }
    const { done, total } = progress;
    if (done >= 1 && done < total) {
      if (!announcedPartial) {
        announcedPartial = true;
        const minutes = String(Math.max(1, Math.round((sc?.completedUntil || done * CHUNK_SECONDS) / 60)));
        const count = sc?.cues?.length || 0;
        announcer.status(count ? t('status_partial_ready', minutes, String(count)) : t('status_partial_empty', minutes));
      } else {
        announcer.status(t('status_progress', String(done), String(total)));
      }
    }
    announceType();
  }

  function onGenerationDone(sc) {
    following = false;
    announcedPartial = false;
    ui.hideProgress();
    setScript(sc);
    status = 'ready';
    const n = sc.cues.length;
    console.info(`[SceneVoice] done: ${n} descriptions, model ${sc.model}`, sc.cues.slice(0, 5));
    announcer.status(n ? t('status_ready', String(n), shortcut('describe-now') || t('status_the_describe_button')) : t('status_ready_empty'));
    announceType();
  }

  function onGenerationError(code, detail) {
    following = false;
    announcedPartial = false;
    ui.hideProgress();
    status = script ? 'partial' : 'error';
    errorCode = code;
    if (code === 'extension-reloaded' || !chrome.runtime?.id) return die();
    console.warn('[SceneVoice] generation failed', code, detail || '');
    feedback(errorText(code));
    if (code === 'no-key' || code === 'bad-key') send({ type: MSG.OPEN_OPTIONS });
    return undefined;
  }

  /** Progress messages from the extension about the video shown here. */
  async function onGenerationEvent(ev) {
    if (!videoId || ev.videoId !== videoId || ev.lang !== lang) return;
    switch (ev.event) {
      case 'started':
        // Another tab, or the popup, started the job for this video: follow it.
        if (status !== 'generating') {
          status = 'generating';
          errorCode = '';
          announcedPartial = false;
          announcer.status(t('status_generating'));
        }
        following = true;
        applyProgress(ev);
        break;
      case 'chunk':
        await onGenerationChunk(ev);
        break;
      case 'done': {
        const sc = await fetchScript(ev.videoId, ev.lang);
        if (dead || ev.videoId !== videoId || ev.lang !== lang) return;
        if (sc) onGenerationDone(sc);
        break;
      }
      case 'error':
        if (following || status === 'generating') onGenerationError(ev.code, ev.detail);
        break;
      case 'stopped':
        if (following || status === 'generating') {
          following = false;
          announcedPartial = false;
          stopJob();
        }
        break;
      case 'model':
        console.info(`[SceneVoice] now using ${ev.model} (${ev.reason})`);
        break;
      case 'revised':
        // A description marked as wrong was replaced (here or in another tab).
        await reloadScript();
        break;
      default:
        break;
    }
  }

  /** Load the saved script again, keeping the generation status. */
  async function reloadScript() {
    const id = videoId;
    const l = lang;
    const sc = await fetchScript(id, l);
    if (dead || !sc || id !== videoId || l !== lang) return;
    const generating = status === 'generating';
    setScript(sc);
    if (generating) status = 'generating';
    else if (live && !sc.complete) status = 'live';
  }

  /** Spoken when the user asks while generation is running: percent, section and time left. */
  function progressText() {
    if (status === 'live') return t('status_live_progress', String(script?.cues?.length || 0), String(liveMinutes()));
    if (!progress.total) return t('status_generating');
    const percent = String(Math.round(progressFraction() * 100));
    const eta = etaSeconds();
    const left = eta == null ? '' : eta < 60 ? t('progress_eta_soon') : t('progress_eta_minutes', String(Math.ceil(eta / 60)));
    const head = progress.total > 1
      ? t('status_progress_percent', percent, String(Math.min(progress.done + 1, progress.total)), String(progress.total))
      : t('status_progress_percent_single', percent);
    return left ? `${head} ${left}.` : head;
  }

  // ---------- describing from frames ----------

  /** Minutes of the video described so far, at least 1 once anything is. */
  function liveMinutes() {
    const seconds = coverageSeconds(coveredRanges(script));
    return seconds ? Math.max(1, Math.round(seconds / 60)) : 0;
  }

  function livePercent() {
    const duration = getVideo()?.duration || script?.duration;
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.min(100, Math.round((coverageSeconds(coveredRanges(script)) / duration) * 100));
  }

  /**
   * Describe the video as it plays: from now on, pictures are taken every few
   * seconds in the parts not described yet, and sent a few at a time.
   */
  async function startLive({ force = false, quiet = false } = {}) {
    const id = videoId;
    const l = lang;
    if (force) {
      // "Create again": start from nothing.
      await send({ type: MSG.DELETE_SCRIPT, videoId: id, lang: l });
      if (dead || id !== videoId || l !== lang) return;
      script = null;
      scheduler.setCues([]);
    }
    // Find out now, not minutes later, if pictures cannot be taken from this player.
    try {
      sampler.add(captureFrame(getVideo(), frameOptions()));
    } catch (err) {
      if (err?.code !== 'frames-not-ready') return onGenerationError(err?.code || 'frames-failed');
    }
    live = true;
    liveSeq += 1;
    framesInFlight = false;
    queuedWindow = null;
    framesPausedUntil = 0;
    status = 'live';
    errorCode = '';
    const v = getVideo();
    sampler.reset(v ? v.currentTime : null);
    console.info(`[SceneVoice] describing from frames with ${provider()}`);
    if (quiet) announcer.status(t('status_live_resuming'));
    else feedback(t('status_live_start', t(`provider_name_${provider()}`)));
    return undefined;
  }

  /** Stop taking pictures. What has been described stays saved. */
  function stopLive() {
    if (!live) return;
    live = false;
    liveSeq += 1;
    queuedWindow = null;
    pendingLate = null;
    if (status === 'live') status = script ? (script.complete ? 'ready' : 'partial') : 'none';
  }

  function frameOptions() {
    if (!frameCanvas) frameCanvas = document.createElement('canvas');
    return { maxWidth: FRAME_SAMPLING.maxWidth, quality: FRAME_SAMPLING.quality, canvas: frameCanvas };
  }

  /** One playback tick while describing from frames: take a picture when one is due, send a stretch when it is full. */
  function liveTick(video) {
    if (!live || !settings.enabled || video.paused || video.seeking) return;
    const now = video.currentTime;
    if (isCovered(coveredRanges(script), now)) {
      sampler.reset(now);
      return;
    }
    if (sampler.advance(now)) {
      try {
        sampler.add(captureFrame(video, frameOptions()));
      } catch (err) {
        if (err?.code !== 'frames-not-ready') onLiveError(err?.code || 'frames-failed', err?.detail);
        return;
      }
    }
    if (framesInFlight || Date.now() < framesPausedUntil) return;
    const stretch = sampler.takeWindow(now);
    if (stretch) sendStretch(stretch);
  }

  /** The video ended: describe the last stretch, however short. */
  function finishLive(video) {
    if (!live) return;
    const stretch = sampler.takeWindow(video.currentTime, { force: true, end: video.duration });
    if (!stretch) return;
    if (framesInFlight) queuedWindow = stretch;
    else sendStretch(stretch);
  }

  async function sendStretch(stretch) {
    const id = videoId;
    const l = lang;
    const seq = liveSeq;
    framesInFlight = true;
    let res;
    try {
      res = await describeFrames(send, {
        videoId: id,
        lang: l,
        duration: getVideo()?.duration,
        meta: getMeta(),
        window: { start: stretch.start, end: stretch.end },
        frames: stretch.frames,
      });
    } finally {
      if (seq === liveSeq) framesInFlight = false;
    }
    if (res?.error === 'extension-reloaded') return die();
    if (dead || id !== videoId || l !== lang || seq !== liveSeq) return undefined;
    if (!res || res.error) return onLiveError(res?.error || 'unknown', res?.detail);
    console.info(`[SceneVoice] ${stretch.frames.length} frames ${formatTime(stretch.start)}–${formatTime(stretch.end)}: ${res.cues?.length || 0} descriptions`);
    const sc = await fetchScript(id, l);
    if (dead || id !== videoId || l !== lang || seq !== liveSeq) return undefined;
    if (sc) {
      setScript(sc);
      status = 'live';
      announceType();
    }
    deliverLate(res.cues || []);
    if (sc?.complete) {
      live = false;
      liveSeq += 1;
      onGenerationDone(sc);
      return undefined;
    }
    if (queuedWindow) {
      const next = queuedWindow;
      queuedWindow = null;
      sendStretch(next);
    }
    return undefined;
  }

  /**
   * A stretch could not be described. A passing problem (quota, network, an
   * unreadable answer) skips it, says so once, and waits a little; anything
   * else (no key, a player that cannot be captured) stops and says why.
   */
  function onLiveError(code, detail) {
    console.warn('[SceneVoice] describing frames failed', code, detail || '');
    if (PASSING_FRAME_ERRORS.has(code)) {
      framesPausedUntil = Date.now() + (code === 'quota' ? 60000 : 15000);
      if (!framesErrorsSaid.has(code)) {
        framesErrorsSaid.add(code);
        announcer.status(t('live_skipped', errorText(code)));
      }
      return undefined;
    }
    stopLive();
    return onGenerationError(code, detail);
  }

  /**
   * Descriptions made from frames arrive a few seconds after their moment. The
   * most important one still recent enough is said at the next pause that
   * fits it (see tryLate); the rest are saved and heard on the next viewing.
   */
  function deliverLate(cues) {
    const video = getVideo();
    if (!video || video.paused || !settings.enabled || setting('mode') === 'manual') return;
    const now = video.currentTime;
    let due = cues
      .filter((c) => c.start <= now && now - c.start <= LATE_LIMIT)
      .filter((c) => (settings.onScreenText || c.kind !== 'text') && passesDensity(c, setting('density')));
    if (dialogue) due = dropTextHeardInCaptions(due, captionLines).cues;
    const cue = pickOne(due);
    if (cue && (!pendingLate || pickOne([pendingLate.cue, cue]) === cue)) pendingLate = { cue, at: now };
  }

  /** Say a late description once no other description is being said and it fits the pause (or the mode allows pausing). */
  function tryLate(video) {
    const late = pendingLate;
    if (!late || speakingCue) return;
    const now = video.currentTime;
    if (now < late.at - 1 || now - late.at > LATE_WAIT) {
      pendingLate = null; // seeked away, or no pause came
      return;
    }
    let cue = { ...late.cue, start: now, source: late.cue };
    if (dialogue) cue = { ...fitCuesToDialogue([cue], dialogue)[0], source: late.cue };
    if (cue.start > now + 0.15) return; // speech ends in a moment: wait for it
    const fits = chooseUtterance(cue, { mode: setting('mode'), detail: setting('detail'), rate: readerRate(), onScreenText: settings.onScreenText, playbackRate: video.playbackRate || 1 });
    if (!fits) return;
    pendingLate = null;
    console.info(`[SceneVoice] ${formatTime(late.cue.start)} said late, at ${formatTime(now)}`);
    deliver(cue);
  }

  /**
   * Pictures of one moment, for a question or a description marked as wrong:
   * those taken around it, and the picture on screen now if it is that moment.
   * Resolves to { frames } or { error }.
   */
  function momentFrames(at, { before = 8, after = 2, max = 4 } = {}) {
    const video = getVideo();
    const frames = sampler.around(at, before, after);
    if (video && Math.abs(video.currentTime - at) <= Math.max(after, 1) + 1) {
      try {
        const frame = captureFrame(video, frameOptions());
        sampler.add(frame);
        frames.push(frame);
      } catch (err) {
        if (err?.code === 'frames-tainted' || err?.code === 'frames-unsupported' || !frames.length) return { error: err?.code || 'frames-failed' };
      }
    }
    if (!frames.length) return { error: 'frames-unavailable' };
    const unique = [...new Map(frames.map((f) => [f.time, f])).values()].sort((a, b) => a.time - b.time);
    return { frames: pickEvenly(unique, max) };
  }

  // ---------- speaking ----------

  function duck(video) {
    if (!settings.duck || !video || duckState) return;
    const orig = video.volume;
    const ducked = Math.round(orig * settings.duckLevel * 100) / 100;
    duckState = { video, orig, ducked };
    video.volume = ducked;
  }

  function unduck() {
    if (!duckState) return;
    const { video, orig, ducked } = duckState;
    duckState = null;
    // Respect a volume change the user made meanwhile.
    if (Math.abs(video.volume - ducked) < 0.02) video.volume = orig;
  }

  function resumeIfPausedByUs(video) {
    if (!pausedByUs) return;
    pausedByUs = 0;
    const v = video || getVideo();
    if (v && v.paused && !v.ended) v.play().catch(() => {});
  }

  /** @param {object} [o.cue]  the cue being spoken during playback, so a less important one does not cut it off */
  async function speakText(text, { pause = false, kind = 'visual', urgent = false, cue = null } = {}) {
    const video = getVideo();
    const token = (speechToken += 1);
    speakingCue = cue && { kind: cue.kind, priority: cue.priority };
    // If an earlier utterance paused the video, this one inherits the duty to resume it.
    if (pausedByUs) pausedByUs = token;
    if (settings.showText) ui.showText(text, kind, estimateSeconds(text, readerRate()));
    if (pause && video && !video.paused) {
      pausedByUs = token;
      video.pause();
    } else if (!pausedByUs) {
      duck(video);
    }
    await announcer.say(text, { urgent });
    if (token !== speechToken) return; // a newer utterance took over
    speakingCue = null;
    unduck();
    if (pausedByUs === token) resumeIfPausedByUs(video);
  }

  function deliver(cue, { manual = false } = {}) {
    const video = getVideo();
    const u = chooseUtterance(cue, {
      mode: manual ? 'manual' : setting('mode'),
      detail: setting('detail'),
      rate: readerRate(),
      onScreenText: manual ? true : settings.onScreenText,
      playbackRate: video?.playbackRate || 1,
    });
    if (!u) {
      console.info(`[SceneVoice] ${formatTime(cue.start)} skipped: does not fit (gap ${cue.gap}s${cue.gapMeasured ? ' from captions' : ''})`);
      return;
    }
    console.info(`[SceneVoice] ${formatTime(cue.start)} ${cue.kind}${u.needsPause ? ' (pause)' : ''}: ${u.text}`);
    lastSpoken = { text: u.text, kind: cue.kind, cue: cue.source || cue };
    speakText(u.text, { pause: u.needsPause, kind: cue.kind, urgent: manual, cue: manual ? null : cue });
  }

  function stopSpeaking() {
    speechToken += 1;
    speakingCue = null;
    announcer.stop();
    unduck();
    ui.hideText();
    resumeIfPausedByUs();
  }

  // ---------- playback loop ----------

  function watchVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    video.addEventListener('play', () => {
      // The user resumed during a pause we made: leave the video playing.
      pausedByUs = 0;
      maybeHint();
    });
    video.addEventListener('seeked', () => scheduler.reset(video.currentTime));
    video.addEventListener('ended', () => finishLive(video));
  }

  function tick() {
    if (!videoId || dead) return;
    tickCount += 1;
    if (tickCount % 16 === 0) ui.mount();
    if (tickCount % 8 === 0) renderProgress();
    const video = getVideo();
    if (!video) return;
    watchVideo(video);
    if (!video.paused) maybeHint();
    if (isAdShowing()) {
      scheduler.reset(null);
      return;
    }
    liveTick(video);
    if (!settings.enabled || !script || setting('mode') === 'manual') {
      scheduler.reset(video.currentTime);
      return;
    }
    if (video.paused || video.seeking) return;
    const fired = scheduler
      .tick(video.currentTime)
      .filter((c) => (settings.onScreenText || c.kind !== 'text') && passesDensity(c, setting('density')));
    const cue = pickOne(fired);
    if (!cue) {
      tryLate(video);
      return;
    }
    if (!mayInterrupt(speakingCue, cue)) {
      console.info(`[SceneVoice] ${formatTime(cue.start)} skipped: on-screen text is being read`);
      return;
    }
    deliver(cue);
  }

  // ---------- user actions ----------

  async function toggle() {
    if (!videoId) return;
    if (status === 'generating' || startingFor === videoId) {
      feedback(progressText());
      return;
    }
    // Describing from frames lasts as long as the video: the shortcut turns it off, like any descriptions.
    if (status === 'live') {
      stopLive();
      stopSpeaking();
      await setSettings({ enabled: false }).catch(() => {});
      feedback(`${t('status_off')} ${t('status_live_stopped')}`);
      return;
    }
    if (!script) {
      if (!settings.enabled) await setSettings({ enabled: true }).catch(() => {});
      generate();
      return;
    }
    const enabled = !settings.enabled;
    await setSettings({ enabled }).catch(() => {});
    if (!enabled) stopSpeaking();
    feedback(enabled ? t('status_on') : t('status_off'));
    // Descriptions were off when the video opened: say now what its type changed.
    if (enabled) announceType(true);
    // Back on, with parts not yet described: carry on taking pictures.
    if (enabled && framesMode() && !script.complete) generate({ quiet: true });
  }

  function nearbyText(time) {
    if (!script) return '';
    return script.cues
      .filter((c) => c.start <= time + 0.5 && c.start >= time - 40)
      .map((c) => c.standard)
      .join(' ');
  }

  /**
   * Ask Gemini about the current moment. Resolves to { text, time }: the answer,
   * led by the moment it is about, and that moment in seconds (null for an error message).
   */
  async function askAI(question) {
    const video = getVideo();
    if (!video) return { text: errorText('no-video'), time: null };
    if (isAdShowing()) return { text: t('status_ad_playing'), time: null };
    // A model that is sent pictures gets those of the last few seconds.
    let frames;
    if (framesMode()) {
      const shot = momentFrames(video.currentTime, { before: 8, after: 0 });
      if (shot.error) return { text: errorText(shot.error), time: null };
      frames = shot.frames;
    }
    const res = await askAboutMoment(send, {
      videoId,
      meta: getMeta(),
      time: video.currentTime,
      duration: video.duration,
      question,
      nearbyText: nearbyText(video.currentTime),
      lang,
      ...(frames ? { frames } : {}),
    });
    if (res?.error === 'extension-reloaded') {
      die();
      return { text: errorText('extension-reloaded'), time: null };
    }
    if (!res || res.error || !res.text) return { text: errorText(res?.error || 'unknown'), time: null };
    return { text: res.text, time: Number.isFinite(res.time) ? res.time : null };
  }

  async function describeNow() {
    const video = getVideo();
    if (!videoId || !video) return;
    if (isAdShowing()) {
      feedback(t('status_ad_playing'));
      return;
    }
    const cue = script ? cueAt(script.cues, video.currentTime) : null;
    if (cue && video.currentTime - cue.start < 20) {
      deliver(cue, { manual: true });
      return;
    }
    // No prepared description for this moment: ask the model directly.
    if (!(await hasKey())) {
      if (!dead) feedback(errorText('no-key'));
      return;
    }
    const id = videoId;
    feedback(t('status_looking'));
    const { text } = await askAI(t('ask_default_question'));
    if (id !== videoId) return;
    lastSpoken = { text, kind: 'visual', cue: null };
    speakText(text, { urgent: true });
  }

  function repeatLast() {
    if (!lastSpoken) {
      feedback(t('status_nothing_to_repeat'));
      return;
    }
    speakText(lastSpoken.text, { kind: lastSpoken.kind, urgent: true });
  }

  function openAsk() {
    const video = getVideo();
    if (!videoId || !video) return;
    if (isAdShowing()) {
      feedback(t('status_ad_playing'));
      return;
    }
    stopSpeaking();
    const wasPlaying = !video.paused;
    if (settings.pauseOnAsk && wasPlaying) video.pause();
    ui.openAsk({
      onSubmit: async (q) => {
        const answer = await askAI(q);
        // Screen reader users hear the answer from the dialog itself (a live region inside it).
        if (settings.output === 'tts') announcer.say(answer.text);
        return answer;
      },
      onClose: ({ jumpTo } = {}) => {
        announcer.stop();
        // "Go to 2:15" under the answer: play on from the moment it is about.
        if (Number.isFinite(jumpTo) && getVideo() === video) {
          video.currentTime = jumpTo;
          feedback(t('ask_jumped', formatTime(jumpTo)));
        }
        if (settings.pauseOnAsk && wasPlaying && video.paused) video.play().catch(() => {});
      },
    });
  }

  // ---------- descriptions marked as wrong ----------

  /**
   * The description "Description is wrong" is about: the last one spoken, or
   * else the one for the moment on screen. Answers to questions are not saved,
   * so there is nothing to correct for them.
   */
  function reportTarget() {
    if (lastSpoken) return lastSpoken.cue;
    const video = getVideo();
    if (!script || !video || isAdShowing()) return null;
    const cue = cueAt(script.cues, video.currentTime);
    return cue && video.currentTime - cue.start < 20 ? cue : null;
  }

  /**
   * Mark a description as wrong and describe that moment again, without
   * creating the rest again. Every step is said: marked (and which one), then
   * updated with the new words, removed, or what went wrong. The mark is kept
   * on this computer only.
   */
  async function reportWrong() {
    if (!videoId) return undefined;
    if (revisingFor === videoId) {
      feedback(t('report_busy'));
      return undefined;
    }
    const cue = reportTarget();
    if (!cue) {
      feedback(t('report_nothing'));
      return undefined;
    }
    const id = videoId;
    const l = lang;
    const at = formatTime(cue.start);
    // A model that is sent pictures needs those of that moment, still at hand.
    let frames;
    if (framesMode()) {
      const shot = momentFrames(cue.start, { before: 3, after: 6, max: 6 });
      if (shot.error) {
        feedback(t('report_failed', errorText(shot.error)));
        return undefined;
      }
      frames = shot.frames;
    }
    stopSpeaking();
    feedback(t('report_marked', at, cue.brief || cue.standard));
    revisingFor = id;
    let res;
    try {
      res = await reviseDescription(send, {
        videoId: id,
        lang: l,
        cue: { start: cue.start, kind: cue.kind, standard: cue.standard },
        meta: getMeta(),
        duration: getVideo()?.duration,
        ...(frames ? { frames } : {}),
      });
    } finally {
      if (revisingFor === id) revisingFor = null;
    }
    if (res?.error === 'extension-reloaded') return die();
    if (dead || id !== videoId || l !== lang) return undefined;
    if (!res || res.error) {
      feedback(t('report_failed', errorText(res?.error || 'unknown')));
      if (res?.error === 'no-key' || res?.error === 'bad-key') send({ type: MSG.OPEN_OPTIONS });
      return undefined;
    }
    await reloadScript();
    if (res.status === 'removed' || !res.cue) {
      lastSpoken = null;
      feedback(t('report_removed', at));
      return undefined;
    }
    const text = res.cue[setting('detail')] || res.cue.standard;
    lastSpoken = { text, kind: res.cue.kind, cue: res.cue };
    feedback(t('report_updated', at, text));
    return undefined;
  }

  /**
   * Save a setting changed by a shortcut, then say the new value (or that it
   * was not saved). The local copy changes at once, so a quick second press
   * steps on from the new value and the announcement already uses it (a new
   * speaking rate, for example). A mode, detail or density chosen here is the
   * user's own, so the video type no longer changes it.
   */
  async function change(patch, announcement) {
    const marked = markChoices(patch);
    const before = Object.fromEntries(Object.keys(marked).map((k) => [k, settings[k]]));
    settings = { ...settings, ...marked };
    updateType();
    try {
      await setSettings(marked);
    } catch {
      settings = { ...settings, ...before };
      updateType();
      feedback(t('opt_settings_save_failed'));
      return;
    }
    feedback(announcement);
  }

  /** Step to the next value, from the one in use for this video (which may come from its type). */
  async function cycle(key, values, prefix) {
    const next = nextValue(values, setting(key));
    await change({ [key]: next }, t(`${prefix}${next}`));
  }

  /** Faster or slower: the built-in voice's rate, or the screen reader speed SceneVoice plans for. */
  async function changeSpeed(direction) {
    const { key, value, atLimit } = stepSpeed(settings, direction);
    const said = key === 'ttsRate' ? t('announce_rate', value.toFixed(1)) : t('announce_reader_speed', readerSpeedLabel(value));
    if (atLimit) {
      feedback(`${said} ${t(direction > 0 ? 'announce_fastest' : 'announce_slowest')}`);
      return;
    }
    await change({ [key]: value }, said);
  }

  /** In an embedded player, only act if this player has been used. */
  function shouldHandle() {
    if (!videoId || dead) return false;
    if (!isFrame) return true;
    const v = getVideo();
    return Boolean(v && v.played && v.played.length > 0);
  }

  async function runCommand(command) {
    if (!shouldHandle()) return undefined;
    switch (command) {
      case 'toggle-descriptions':
        return toggle();
      case 'describe-now':
        return describeNow();
      case 'repeat-last':
        return repeatLast();
      case 'ask-question':
        return openAsk();
      case 'report-wrong':
        return reportWrong();
      case 'cycle-detail':
        return cycle('detail', DETAILS, 'announce_detail_');
      case 'cycle-mode':
        return cycle('mode', MODES, 'announce_mode_');
      case 'cycle-density':
        return cycle('density', DENSITIES, 'announce_density_');
      case 'speed-up':
        return changeSpeed(1);
      case 'speed-down':
        return changeSpeed(-1);
      case 'stop-speaking':
        return stopSpeaking();
      default:
        return undefined;
    }
  }

  function tabState() {
    return {
      supported: Boolean(videoId),
      videoId,
      title: videoId ? getMeta().title : '',
      platform: platform.id,
      provider: provider(),
      inputMode: framesMode() ? 'frames' : 'video',
      status,
      errorCode,
      done: progress.done,
      total: progress.total,
      percent: status === 'generating' ? Math.round(progressFraction() * 100) : status === 'live' ? livePercent() : null,
      eta: status === 'generating' ? etaSeconds() : null,
      cueCount: script?.cues?.length || 0,
      firstCue: script?.cues?.length ? script.cues[0].start : null,
      completedUntil: script?.completedUntil || 0,
      complete: Boolean(script?.complete),
      model: script?.model || '',
      lang,
      videoType,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = msg?.type;
    if (type !== MSG.COMMAND && type !== MSG.GEN_EVENT && type !== MSG.TAB_STATE && type !== MSG.TAB_ACTION) return false;
    let allowed = false;
    try {
      allowed = authorizeContentMessage(type, sender, chrome.runtime?.id);
    } catch {
      allowed = false;
    }
    if (!allowed) return false;
    if (type === MSG.COMMAND) {
      runCommand(msg.command);
      return false;
    }
    if (type === MSG.GEN_EVENT) {
      onGenerationEvent(msg);
      return false;
    }
    if (type === MSG.TAB_STATE) {
      if (isFrame && !shouldHandle()) return false;
      sendResponse(tabState());
      return false;
    }
    if (type === MSG.TAB_ACTION) {
      if (isFrame && !shouldHandle()) return false;
      (async () => {
        // Generation can wait minutes for an ad to end: kick it off and answer with the current state.
        if (msg.action === 'generate') {
          generate();
          await new Promise((r) => setTimeout(r, 300));
        } else if (msg.action === 'regenerate') {
          beginSeq += 1;
          startingFor = null;
          stopLive();
          await stopGeneration(send, { videoId, lang });
          stopJob();
          stopSpeaking();
          generate({ force: true });
          await new Promise((r) => setTimeout(r, 300));
        } else if (msg.action === 'delete') {
          beginSeq += 1;
          startingFor = null;
          stopLive();
          stopJob();
          stopSpeaking();
          await send({ type: MSG.DELETE_SCRIPT, videoId, lang });
          resetVideoState();
        } else if (msg.action === 'stop') {
          if (status === 'live') {
            stopLive();
            feedback(t('status_live_stopped'));
          } else if (status === 'generating' || startingFor === videoId) {
            beginSeq += 1;
            startingFor = null;
            await stopGeneration(send, { videoId, lang });
            stopJob();
            feedback(script ? t('status_stopped_partial', String(Math.max(1, Math.round((script.completedUntil || 0) / 60)))) : t('status_stopped'));
          }
        } else await runCommand(msg.action);
        sendResponse(tabState());
      })();
      return true;
    }
    return false;
  });
}
