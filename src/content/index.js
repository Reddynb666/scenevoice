// Content script: follows YouTube playback and delivers descriptions at the right moments.

import { MSG, DEFAULT_SETTINGS, CHUNK_SECONDS, DENSITIES, DETAILS, MODES } from '../shared/constants.js';
import { t, errorMessage } from '../shared/i18n.js';
import { readerSpeedLabel, typeAdjustedText } from '../shared/labels.js';
import { markChoices, nextValue, stepSpeed } from '../shared/settings.js';
import { authorizeContentMessage } from '../shared/sender.js';
import { resolveLanguage, setSettings, watchSettings } from '../shared/storage.js';
import { chooseUtterance, cueAt, estimateSeconds, formatTime, passesDensity } from '../shared/script.js';
import { CueScheduler, mayInterrupt, pickOne } from '../shared/scheduler.js';
import { fitCuesToDialogue, parseTimedText, speechIntervals } from '../shared/dialogue.js';
import { dropTextHeardInCaptions } from '../shared/onscreen.js';
import { pageVideoType, resolveVideoType, typeAdjustments } from '../shared/videotype.js';
import { Announcer } from './announcer.js';
import { PageUI } from './ui.js';
import { askAboutMoment, reviseDescription, startGeneration, stopGeneration } from './generator.js';
import {
  fetchWatchPage,
  getMeta,
  getPageDuration,
  getVideo,
  isAdShowing,
  onNavigate,
  pickCaptionTrack,
  timedTextUrl,
  videoIdFromUrl,
  watchTimedTextRequests,
} from './youtube.js';

if (!window.__sceneVoiceLoaded) {
  window.__sceneVoiceLoaded = true;
  main();
}

function main() {
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

  const scheduler = new CueScheduler([]);
  const announcer = new Announcer(() => settings);
  const ui = new PageUI({ onToggle: () => toggle() });

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
    announcer.announceToScreenReader(errorMessage('extension-reloaded'), false);
  }

  async function refreshShortcuts() {
    const res = await send({ type: MSG.GET_STATUS });
    if (res?.error === 'extension-reloaded') return die();
    shortcuts = res?.shortcuts || {};
    ui.setButtonState(settings.enabled, shortcut('toggle-descriptions'));
    return undefined;
  }

  /**
   * Whether an API key is saved. The key stays in the service worker: this page
   * only hears yes or no. chrome.storage.local is not readable from here.
   */
  async function hasKey() {
    const res = await send({ type: MSG.GET_STATUS });
    if (res?.error === 'extension-reloaded') {
      die();
      return false;
    }
    return Boolean(res?.hasKey);
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
    lang = resolveLanguage(s.language, chrome.i18n.getUILanguage());
    announcer.lang = lang;
    ui.setButtonState(s.enabled, shortcut('toggle-descriptions'));
    if (!s.showText) ui.hideText();
    if (wasEnabled && !s.enabled) stopSpeaking();
    if (!started) {
      // Settings are known: now follow the page.
      started = true;
      refreshShortcuts();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !dead) refreshShortcuts();
      });
      onNavigate(onPage);
      watchTimedTextRequests((id, url) => {
        if (id === videoId && !dialogue && !dead) loadDialogue(id, [url]);
      });
      onPage();
      timers.push(setInterval(tick, 120));
      return;
    }
    if (videoId && prevLang !== lang) {
      // Descriptions are per language: drop the old ones and look for the new.
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
    scheduler.setCues([]);
    ui.hideText();
    updateType();
  }

  function onPage() {
    const id = videoIdFromUrl(location.href);
    if (id === videoId) return;
    stopJob();
    stopSpeaking();
    videoId = id;
    dialogue = null;
    captionLines = [];
    captionUrlsTried = new Set();
    pageType = '';
    resetVideoState();
    if (!id) return;
    ui.mount();
    loadScript();
    loadWatchPage(id);
  }

  /**
   * Read the video's watch page once: its category gives the video type before
   * any description exists, and its caption tracks give the dialogue timing.
   */
  async function loadWatchPage(id) {
    let page = { tracks: [], category: '' };
    try {
      page = await fetchWatchPage(id);
    } catch (err) {
      console.info('[SceneVoice] could not read the watch page', String(err));
    }
    if (dead || id !== videoId) return;
    pageType = pageVideoType({ category: page.category, title: getMeta().title });
    updateType();
    announceType();
    const track = pickCaptionTrack(page.tracks);
    const url = track && timedTextUrl(track.baseUrl);
    if (url) loadDialogue(id, [url]);
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
      if (!cached.complete) generate({ quiet: true });
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
    if (status === 'generating' || startingFor === videoId) {
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
      feedback(errorMessage('no-key'));
      send({ type: MSG.OPEN_OPTIONS });
      return undefined;
    }
    if (isAdShowing() && !quiet) feedback(t('status_waiting_for_ad'));
    const v = await waitForVideo(id);
    if (id !== videoId || l !== lang || seq !== beginSeq) return undefined;
    if (!v) {
      status = 'error';
      errorCode = 'bad-duration';
      feedback(errorMessage(errorCode));
      return undefined;
    }
    if (v.duration === Infinity) {
      status = 'error';
      errorCode = 'live';
      feedback(errorMessage(errorCode));
      return undefined;
    }

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
    feedback(errorMessage(code));
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
  }

  /** Spoken when the user asks while generation is running: percent, section and time left. */
  function progressText() {
    if (!progress.total) return t('status_generating');
    const percent = String(Math.round(progressFraction() * 100));
    const eta = etaSeconds();
    const left = eta == null ? '' : eta < 60 ? t('progress_eta_soon') : t('progress_eta_minutes', String(Math.ceil(eta / 60)));
    const head = progress.total > 1
      ? t('status_progress_percent', percent, String(Math.min(progress.done + 1, progress.total)), String(progress.total))
      : t('status_progress_percent_single', percent);
    return left ? `${head} ${left}.` : head;
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
    if (!settings.enabled || !script || setting('mode') === 'manual') {
      scheduler.reset(video.currentTime);
      return;
    }
    if (video.paused || video.seeking) return;
    const fired = scheduler
      .tick(video.currentTime)
      .filter((c) => (settings.onScreenText || c.kind !== 'text') && passesDensity(c, setting('density')));
    const cue = pickOne(fired);
    if (!cue) return;
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
    if (!video) return { text: errorMessage('no-video'), time: null };
    if (isAdShowing()) return { text: t('status_ad_playing'), time: null };
    const res = await askAboutMoment(send, {
      videoId,
      meta: getMeta(),
      time: video.currentTime,
      duration: video.duration,
      question,
      nearbyText: nearbyText(video.currentTime),
      lang,
    });
    if (res?.error === 'extension-reloaded') {
      die();
      return { text: errorMessage('extension-reloaded'), time: null };
    }
    if (!res || res.error || !res.text) return { text: errorMessage(res?.error || 'unknown'), time: null };
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
      if (!dead) feedback(errorMessage('no-key'));
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
      });
    } finally {
      if (revisingFor === id) revisingFor = null;
    }
    if (res?.error === 'extension-reloaded') return die();
    if (dead || id !== videoId || l !== lang) return undefined;
    if (!res || res.error) {
      feedback(t('report_failed', errorMessage(res?.error || 'unknown')));
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
      status,
      errorCode,
      done: progress.done,
      total: progress.total,
      percent: status === 'generating' ? Math.round(progressFraction() * 100) : null,
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
          await stopGeneration(send, { videoId, lang });
          stopJob();
          stopSpeaking();
          generate({ force: true });
          await new Promise((r) => setTimeout(r, 300));
        } else if (msg.action === 'delete') {
          beginSeq += 1;
          startingFor = null;
          stopJob();
          stopSpeaking();
          await send({ type: MSG.DELETE_SCRIPT, videoId, lang });
          resetVideoState();
        } else if (msg.action === 'stop') {
          if (status === 'generating' || startingFor === videoId) {
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
