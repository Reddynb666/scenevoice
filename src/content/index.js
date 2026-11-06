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

import { MSG, DEFAULT_SETTINGS, AI_NOTICE_SEEN_KEY, AI_NOTICE_SEEN_MAX, BLANK_FRAMES_LIMIT, CHUNK_SECONDS, DENSITIES, DETAILS, FRAME_SAMPLING, MODES, SAY_SHORTCUTS } from '../shared/constants.js';
import { COMMAND_SHORT_KEYS, SPOKEN_GROUPS, displayShortcut, effectiveShortcuts, matchShortcut, pageBindings } from '../shared/shortcuts.js';
import { coverageSeconds, coveredRanges, describedUpTo, isCovered, pickEvenly } from '../shared/coverage.js';
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
import { effectiveProvider, inputModeFor, providerFor } from '../shared/providers.js';
import { progressMilestone } from '../shared/progress.js';
import { ASK_HISTORY_MAX } from '../shared/ask.js';
import { budgetLabelKey, estimateCost, localDay } from '../shared/usage.js';
import { Announcer } from './announcer.js';
import { PageUI } from './ui.js';
import { FrameSampler, canvasLooksBlank, captureFrame } from './frames.js';
import { askAboutMoment, describeFrames, generationStatus, reviseDescription, startGeneration, stopGeneration } from './generator.js';
import { platformFor } from './platforms.js';

if (!window.__sceneVoiceLoaded) {
  window.__sceneVoiceLoaded = true;
  main();
}

/**
 * How long after its moment a description that came back late may still be said
 * (on-screen text stays on screen, a passing action does not), how long it may
 * wait for a pause, and after how long it is led by "Earlier:" so the listener
 * does not take it for what is on screen now.
 */
const LATE_LIMIT = { visual: 15, text: 25 };
const LATE_WAIT = 10;
const LATE_PREFIX_AFTER = 6;
/** How long a cue that came due during another description may wait for the next pause before it is dropped. */
const DEFER_WAIT = 5;
/** A jump of more than this many seconds is the user seeking, not playback (the scheduler uses the same bound). */
const SEEK_JUMP = 2.5;
/**
 * In pause mode with screen-reader output, the video is held this much longer
 * than the estimated reading time: the screen reader gives no "finished" signal,
 * the estimate is only an estimate, and the video resuming over the last words
 * of a description is exactly what pause mode is for avoiding.
 */
const SCREENREADER_RESUME_HOLD_MS = 1500;
/** In "keep playing" mode, say once per video how to hear the skipped descriptions after more than this many were skipped. */
const SKIPPED_NOTICE_AFTER = 3;
/** Errors after which taking frames carries on (the stretch is skipped); any other stops it. */
/** Pressing the shortcut again within this time after it reported progress stops generation and turns descriptions off. */
const PRESS_AGAIN_MS = 3000;
/**
 * Errors after which pressing the shortcut again may well work: said with how to
 * carry on. Not among them: the day's quota, the day's limit set here, and the
 * Cloud allowance, which come back tomorrow, not on the next press.
 */
const RESUMABLE_ERRORS = new Set(['quota', 'rate-limited', 'server', 'network', 'timeout', 'request-failed', 'bad-json', 'truncated', 'empty-response', 'too-long', 'unknown', 'offscreen-unavailable']);
/** Errors after which taking frames carries on (the stretch is skipped); any other stops it. */
const PASSING_FRAME_ERRORS = new Set(['quota', 'rate-limited', 'server', 'network', 'timeout', 'request-failed', 'bad-json', 'truncated', 'empty-response', 'blocked', 'too-long', 'unknown', 'frames-missing', 'offscreen-unavailable', 'busy']);
/** After these, frames wait a minute rather than 15 seconds before the next try. */
const SLOW_RETRY_ERRORS = new Set(['quota', 'rate-limited']);

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
  /** When the shortcut last reported progress: pressed again within PRESS_AGAIN_MS, it stops and turns off. */
  let progressPressAt = 0;
  /** The latest questions about the current video and their answers, sent with the next question. */
  let askHistory = { videoId: null, items: [] };
  /** The video for which "AI-generated audio description follows" has been said in this tab. */
  let aiNoticeFor = null;
  /** Solid black pictures in a row while describing from frames (a protected video draws black). */
  let blankFrames = 0;
  /** Whether the "first minutes are ready" message has been given for this job. */
  let announcedPartial = false;
  /** The last quarter of progress said for this job, and when a generation message was last said. */
  let progressSaid = { milestone: 0, at: 0 };
  /** Bumped to cancel a generate() that is still waiting for the player. */
  let beginSeq = 0;
  /** Stretches of speech in the current video, from its captions; null when unknown. */
  let dialogue = null;
  /** The reading speed and playback rate the cues were last fitted to the dialogue with (fitOptions), or null. A change in either fits them again. */
  let fittedWith = null;
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
  /** `${videoId}:${type}` for every video whose type change has been said in this tab: once each, even after going back to it. */
  const typeAnnounced = new Set();
  /** How to undo an adjustment is said once per tab, with the first one. */
  let typeUndoHintGiven = false;
  /** {text, kind, cue}: cue is the saved description it came from, null for an answer to a question. */
  let lastSpoken = null;
  /** Start time of the cue already said because playback had moved past it. */
  let caughtUpStart = null;
  /** Video id while a description marked as wrong is being made again. */
  let revisingFor = null;
  /** The cue being spoken during playback ({kind, priority}; priority 0 = what the user asked for), or null. */
  let speakingCue = null;
  let speechToken = 0;
  /** { cue, at }: a cue that came due while another was being said, waiting for the next pause (at = video time). */
  let deferred = null;
  /** Descriptions skipped for want of a pause in this video, and the video for which that has been said. */
  let skipped = 0;
  let skippedSaidFor = null;
  /** The video's position at the last tick, to tell a seek from playback; NaN until known. */
  let lastPosition = NaN;
  /** Token of the utterance that paused the video, or 0 when the video is not paused by us. */
  let pausedByUs = 0;
  let duckState = null;
  let hintedFor = null;
  let tickCount = 0;
  let shortcuts = {};
  /** Which keys are saved ({ gemini, qwen }), from the service worker; null until asked. */
  let keys = null;
  /** The video for which "only the other key is set, so that model describes" has been said. */
  let fallbackSaidFor = null;
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
  const announcer = new Announcer(() => settings, {
    // Whether this tab's video is playing with sound: a hidden tab then still describes (see Announcer.speakTts).
    // A video paused by SceneVoice itself (pause mode) is still being listened to; one the user or the site paused is not.
    isAudible: () => {
      const v = getVideo();
      return Boolean(v && (!v.paused || pausedByUs) && !v.muted && v.volume > 0);
    },
  });
  const ui = new PageUI({ onToggle: () => toggle(), platform });

  /** The model that describes videos on this site (the one whose key is set), and whether it is sent frames. */
  const provider = () => effectiveProvider(settings, platform.id, keys);
  /** Whether that is not the chosen model, because only the other key is set. */
  const providerFellBack = () => provider() !== providerFor(settings, platform.id);
  const framesMode = () => inputModeFor(provider(), platform.id) === 'frames';
  /** The day (localDay) the daily limit was reached: nothing more starts by itself until tomorrow; the shortcut still asks and is told. */
  let budgetDay = '';
  const budgetHit = () => budgetDay === localDay();
  /** When the Cloud allowance comes back, as a clock time, or "midnight UTC" when the relay did not say. */
  const resetTimeText = (resetAt) => {
    const at = Date.parse(resetAt || '');
    return Number.isFinite(at) ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : t('time_midnight_utc');
  };
  /** An error in words, in the terms of the provider in use. `extra` is the reply or event it came in, for the details some need. */
  const errorText = (code, extra = {}) => {
    if (code === 'budget') return t('error_budget', t(budgetLabelKey(settings.dailyBudgetSeconds)));
    if (code === 'allowance') return t('error_allowance', resetTimeText(extra?.resetAt));
    return errorMessage(code, provider());
  };

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
  /** The key a command answers to, as the listener should hear it ("Option" on a Mac): Chrome's own, or the page's (shortcuts.js); '' for none. */
  const shortcut = (name) => displayShortcut(currentKeys().effective[name]);

  /** Direct feedback to a user action (in the interface language): always delivered, cutting off any description in flight. */
  const feedback = (text) => {
    if (settings.output === 'tts') {
      announcer.announceToScreenReader(text, false);
      return announcer.say(text, { lang: announcer.uiLang });
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
    if (res?.keys) keys = res.keys;
    ui.setButtonState(settings.enabled, shortcut('toggle-descriptions'));
    return undefined;
  }

  // ---------- keys handled by the page ----------
  // Chrome keeps a key for only four commands (see shared/shortcuts.js): the
  // others are matched here, on the window in the capture phase, so the key
  // never reaches the player. A command that has a Chrome key is not matched
  // here as well, or it would fire twice. Keys are matched by physical key
  // (e.code), so Option+Shift on a Mac works although it types another character.
  let keyCache = { chrome: null, page: null, bindings: {}, effective: {} };
  /** The page's bindings and every command's effective key, rebuilt only when Chrome's keys or the setting change. */
  const currentKeys = () => {
    if (keyCache.chrome !== shortcuts || keyCache.page !== settings.pageShortcuts) {
      keyCache = {
        chrome: shortcuts,
        page: settings.pageShortcuts,
        bindings: pageBindings(shortcuts, settings.pageShortcuts),
        effective: effectiveShortcuts(shortcuts, settings.pageShortcuts),
      };
    }
    return keyCache;
  };
  const currentBindings = () => currentKeys().bindings;

  /** Whether the key was typed into something: a field, a list box, an editor, or the ask dialog (which handles its own keys). */
  function isTyping(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (ui.dialog && node === ui.dialog) return true;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('contenteditable') === '') return true;
      const role = node.getAttribute('role');
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    }
    return false;
  }

  function onKeyDown(e) {
    if (dead || e.isComposing || (!e.altKey && !e.ctrlKey && !e.metaKey)) return;
    const command = matchShortcut(e, currentBindings());
    if (!command || isTyping(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (command === SAY_SHORTCUTS) sayShortcuts();
    else runCommand(command);
  }
  window.addEventListener('keydown', onKeyDown, true);

  /**
   * Every command and its key, in a few short sentences: what you do to the
   * video, then the settings, then any command without a key. Said as status,
   * so it never cuts off a description, but said even with status messages off.
   */
  function sayShortcuts() {
    if (isFrame && !shouldHandle()) return;
    const keys = currentKeys().effective;
    const sep = t('keys_said_sep');
    const unset = [];
    const sentences = [];
    SPOKEN_GROUPS.forEach((group, i) => {
      const items = [];
      for (const command of group) {
        const key = displayShortcut(keys[command]);
        if (key) items.push(`${key} ${t(COMMAND_SHORT_KEYS[command])}`);
        else unset.push(t(COMMAND_SHORT_KEYS[command]));
      }
      if (items.length) sentences.push(t(i === 0 ? 'keys_said_actions' : 'keys_said_settings', items.join(sep)));
    });
    if (unset.length) sentences.push(t('keys_said_unset', unset.join(sep)));
    announcer.status(sentences.join(' '), { always: true });
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
    if (res?.keys) keys = res.keys;
    return Boolean(res?.keys ? res.keys[provider()] : res?.hasKey);
  }

  /** Open the settings page at the key field this site needs. */
  const openSettingsForKey = () => send({ type: MSG.OPEN_OPTIONS, provider: provider() });

  /**
   * Start describing without being asked only in a page the viewer is using:
   * never in an embedded player that has not been played, or a page full of
   * hidden players could have this key describe them all.
   */
  const canAutoStart = () => (!isFrame || shouldHandle()) && !budgetHit();

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
    // The pauses a cue waits for are measured against the reading speed: fit them again when it
    // changes. Compared with what the last fit used, not with the previous settings: a shortcut
    // (change()) writes the new speed into the local settings before the storage event arrives.
    if (script && dialogue && fittedWith && fittedWith.rate !== readerRate()) scheduleCues();
    lang = resolveLanguage(s.language, chrome.i18n.getUILanguage(), platform.id);
    announcer.lang = lang;
    ui.lang = lang;
    ui.setButtonState(s.enabled, shortcut('toggle-descriptions'));
    if (!s.showText) ui.hideText();
    if (wasEnabled && !s.enabled) {
      stopSpeaking();
      // Off means no more requests: a description job for this video stops too (what is done stays saved).
      stopGenerationWhenOff();
    }
    // Turned off, or another model chosen for this site: stop taking pictures.
    if (live && (!s.enabled || !framesMode())) stopLive();
    if (!started) {
      // Settings are known: now follow the page.
      started = true;
      refreshShortcuts();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !dead) refreshShortcuts();
      });
      // Generation stopped because the connection dropped: carry on once it is back.
      window.addEventListener('online', () => {
        if (dead || !videoId || errorCode !== 'network' || !settings.enabled || framesMode() || budgetHit()) return;
        announcer.status(t('status_back_online'));
        generate({ quiet: true });
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
    progressSaid = { milestone: 0, at: 0 };
    progressPressAt = 0;
    ui.hideProgress();
    lastSpoken = null;
    caughtUpStart = null;
    pendingLate = null;
    deferred = null;
    skipped = 0;
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
    lastPosition = NaN;
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
    pageType = platform.videoType({ category: page.category, categoryId: page.categoryId, title: getMeta().title });
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
      // Say that the saved descriptions are there, so opening the video is not met with silence.
      // An unfinished one is said with "carrying on" when generation resumes (begin()).
      if (cached.complete) announcer.status(await withAiNotice(loadedText(cached)));
      announceType();
      // A previous run stopped part-way (tab closed, quota): carry on where it left off.
      // From frames, only while descriptions are on: pictures are taken as the video plays.
      if (!cached.complete && (!framesMode() || settings.enabled) && canAutoStart()) generate({ quiet: true });
      return undefined;
    }
    status = 'none';
    // Back on a video whose job is still on its first section (nothing saved yet): follow it,
    // so the shortcut reports progress instead of the "no descriptions yet" hint.
    if (!framesMode()) {
      const job = await generationStatus(send, { videoId: id, lang: l }).catch(() => null);
      if (dead || id !== videoId || l !== lang) return undefined;
      if (job?.status === 'generating') {
        status = 'generating';
        following = true;
        errorCode = '';
        progressSaid = { milestone: 0, at: Date.now() };
        applyProgress(job);
        return undefined;
      }
    }
    if (settings.autoGenerate && settings.enabled && canAutoStart() && (await hasKey()) && id === videoId && l === lang) {
      generate();
      return undefined;
    }
    const v = getVideo();
    if (v && !v.paused) maybeHint();
    return undefined;
  }

  /**
   * text, led by "AI-generated audio description follows" the first time
   * descriptions start on this video in this tab (the AI content labelling rules
   * in China, ACB's TTS guidelines). With aiNoticeEveryTime off, only the first
   * time ever for each video.
   */
  async function withAiNotice(text) {
    const id = videoId;
    if (!id || aiNoticeFor === id) return text;
    aiNoticeFor = id;
    if (!settings.aiNoticeEveryTime) {
      const seen = await chrome.storage.sync.get(AI_NOTICE_SEEN_KEY).then((r) => r?.[AI_NOTICE_SEEN_KEY]).catch(() => null);
      const list = Array.isArray(seen) ? seen.filter((v) => typeof v === 'string') : [];
      if (list.includes(id)) return text;
      chrome.storage.sync.set({ [AI_NOTICE_SEEN_KEY]: [...list, id].slice(-AI_NOTICE_SEEN_MAX) }).catch(() => {});
    }
    return `${t('ai_notice')} ${text}`;
  }

  /** Minutes of video a saved script covers, at least 1. */
  function savedMinutes(sc) {
    return String(Math.max(1, Math.round((sc.completedUntil || 0) / 60)));
  }

  /** What is said when a video opens with all its descriptions saved. */
  function loadedText(sc) {
    const n = sc.cues.length;
    if (!n) return t('status_loaded_empty');
    if (!settings.enabled) {
      const key = shortcut('toggle-descriptions');
      return key ? t('status_loaded_off', String(n), key) : t('status_loaded_off_button', String(n));
    }
    return t('status_loaded', String(n));
  }

  /** Descriptions were turned off (shortcut, popup or settings): stop this video's description job, if any. */
  async function stopGenerationWhenOff() {
    if (status !== 'generating' && startingFor !== videoId) return;
    beginSeq += 1;
    startingFor = null;
    await stopGeneration(send, { videoId, lang });
    stopJob();
  }

  /** Tell the user, the first time they play a video without descriptions, how to create them. */
  function maybeHint() {
    if (!videoId || hintedFor === videoId || settings.generateHintGiven || status !== 'none' || !settings.enabled || isAdShowing()) return;
    hintedFor = videoId;
    // Once, ever: after that the user knows the key, and hearing it on every video is noise.
    setSettings({ generateHintGiven: true }).catch(() => {});
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
    if (typeAnnounced.has(key)) return;
    typeAnnounced.add(key);
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
    const v = getVideo();
    fittedWith = null;
    if (dialogue) {
      const { cues: kept, dropped } = dropTextHeardInCaptions(cues, captionLines);
      if (dropped.length) console.info(`[SceneVoice] ${dropped.length} on-screen texts left out: already in the captions`, dropped.map((c) => `${formatTime(c.start)} ${c.onScreenText || c.standard}`));
      fittedWith = fitOptions(v);
      cues = fitCuesToDialogue(kept, dialogue, fittedWith);
    }
    scheduler.setCues(cues);
    scheduler.reset(v && !isAdShowing() ? v.currentTime : null);
  }

  /** How fast the pauses pass for this listener: their reading speed, and the video's playback rate. */
  function fitOptions(video) {
    return { rate: readerRate(), playbackRate: video?.playbackRate || 1 };
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
    if (status === 'live') {
      const upTo = liveUpTo();
      ui.showLiveProgress({ percent: livePercent(), upTo: upTo > 0 ? formatTime(upTo) : '' });
      return;
    }
    if (status !== 'generating') return;
    ui.showProgress({ done: progress.done, total: progress.total, fraction: progressFraction(), eta: etaSeconds() });
  }

  /** At each quarter, say how far generation has got (the percent and time left), unless it was just said. */
  function sayProgress() {
    if ((status !== 'generating' && status !== 'live') || !settings.announceProgress) return;
    // Describing as it plays: the share of the video described, and how far the part being watched is.
    const fraction = status === 'live' ? livePercent() / 100 : progressFraction();
    const milestone = progressMilestone({ fraction, said: progressSaid.milestone, saidAt: progressSaid.at, now: Date.now() });
    if (milestone == null) return;
    progressSaid = { milestone, at: Date.now() };
    announcer.status(progressText());
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
      openSettingsForKey();
      return undefined;
    }
    // Only the other model's key is set: say once per video which model describes.
    if (providerFellBack() && fallbackSaidFor !== id && !quiet) {
      fallbackSaidFor = id;
      announcer.status(t(`status_fallback_${provider()}`));
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
    progressSaid = { milestone: 0, at: Date.now() };
    if (!quiet) feedback(await withAiNotice(t('status_generating')));
    else announcer.status(await withAiNotice(script?.cues?.length ? t('status_resuming_loaded', savedMinutes(script), String(script.cues.length)) : t('status_resuming')));

    const res = await startGeneration(send, { videoId: id, duration: v.duration, meta: getMeta(), lang: l, force });
    if (id !== videoId || l !== lang || seq !== beginSeq) return undefined;
    if (!res || res.error) return onGenerationError(res?.error || 'unknown', res?.detail, res);
    if (res.status === 'ready') {
      const sc = await fetchScript(id, l);
      if (dead || id !== videoId || l !== lang) return undefined;
      // fromCloud: another SceneVoice user had this video described already; the shared cache gave it to us.
      if (sc) onGenerationDone(sc, { fromCloud: Boolean(res.fromCloud) });
      else onGenerationError('unknown', 'no script after ready');
      return undefined;
    }
    following = true;
    applyProgress(res);
    return undefined;
  }

  /**
   * A section finished while the video was already playing past its cues.
   * The scheduler only fires cues it sees playback cross, so without this the
   * opening stays silent for as long as the first request took. Say the cue
   * for the moment on screen now, once.
   */
  function catchUpLink() {
    if (framesMode() || !settings.enabled || setting('mode') === 'manual') return;
    const video = getVideo();
    if (!video || video.seeking || isAdShowing()) return;
    const now = video.currentTime;
    const cue = cueAt(scheduler.cues, now);
    if (!cue || now - cue.start <= SEEK_JUMP) return;
    const start = (cue.source || cue).start;
    if (caughtUpStart === start) return;
    caughtUpStart = start;
    const prefix = now - start > LATE_PREFIX_AFTER ? t('late_prefix') : '';
    deliver(cue, { manual: true, prefix });
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
      catchUpLink();
    }
    const { done, total } = progress;
    if (done >= 1 && done < total) {
      if (!announcedPartial) {
        announcedPartial = true;
        const minutes = String(Math.max(1, Math.round((sc?.completedUntil || done * CHUNK_SECONDS) / 60)));
        const count = sc?.cues?.length || 0;
        progressSaid.at = Date.now();
        announcer.status(count ? t('status_partial_ready', minutes, String(count)) : t('status_partial_empty', minutes));
      } else {
        sayProgress();
      }
    }
    announceType();
  }

  /**
   * The section being written, while its answer streams in: its cues so far
   * join the saved ones in memory, so the first descriptions play before the
   * section is finished. The next 'chunk' event loads the saved script instead.
   */
  function onGenerationPartial(ev) {
    if (dead || !(following || status === 'generating') || !Array.isArray(ev.cues)) return;
    const from = Number(ev.from) || 0;
    const fresh = ev.cues.filter((c) => c && Number.isFinite(c.start) && typeof c.standard === 'string' && c.start >= from);
    if (!fresh.length) return;
    const kept = (script?.cues || []).filter((c) => c.start < from);
    setScript({ ...(script || { videoId, lang, characters: [], completedUntil: 0 }), cues: [...kept, ...fresh].sort((a, b) => a.start - b.start), complete: false });
    status = 'generating';
  }

  function onGenerationDone(sc, { fromCloud = false } = {}) {
    following = false;
    announcedPartial = false;
    ui.hideProgress();
    setScript(sc);
    catchUpLink();
    status = 'ready';
    const n = sc.cues.length;
    console.info(`[SceneVoice] done: ${n} descriptions, model ${sc.model}`, sc.cues.slice(0, 5));
    const ready = n ? t('status_ready', String(n), shortcut('describe-now') || t('status_the_describe_button')) : t('status_ready_empty');
    // Said where "creating descriptions" would have been: nothing was created, and it took no time.
    announcer.status(fromCloud ? `${t('status_loaded_cloud')} ${ready}` : ready);
    announceType();
  }

  /** `extra`: the reply or event the error came in (a Cloud allowance error says when it resets). */
  function onGenerationError(code, detail, extra = {}) {
    following = false;
    announcedPartial = false;
    ui.hideProgress();
    status = script ? 'partial' : 'error';
    errorCode = code;
    if (code === 'extension-reloaded' || !chrome.runtime?.id) return die();
    console.warn('[SceneVoice] generation failed', code, detail || '');
    // The day's limit: said now, and nothing more starts by itself today (see canAutoStart). A press of the shortcut is always answered.
    if (code === 'budget') budgetDay = localDay();
    feedback(errorWithNextStep(code, extra));
    if (code === 'no-key' || code === 'bad-key') openSettingsForKey();
    return undefined;
  }

  /**
   * The error, and what happens next: what is saved and how to carry on from it
   * (the shortcut resumes where it stopped), and that a lost connection is
   * resumed by itself once the computer is back online.
   */
  function errorWithNextStep(code, extra = {}) {
    const parts = [errorText(code, extra)];
    if (RESUMABLE_ERRORS.has(code)) {
      if (code === 'network' && !framesMode()) parts.push(t('error_network_auto_resume'));
      const key = shortcut('toggle-descriptions');
      if (script?.cues?.length && script.completedUntil > 0 && !script.complete) {
        parts.push(key ? t('error_saved_resume', savedMinutes(script), key) : t('error_saved_resume_button', savedMinutes(script)));
      } else if (key) parts.push(t('error_try_again_key', key));
    }
    return parts.join(' ');
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
          progressSaid = { milestone: 0, at: Date.now() };
          announcer.status(t('status_generating'));
        }
        following = true;
        applyProgress(ev);
        break;
      case 'chunk':
        await onGenerationChunk(ev);
        break;
      case 'partial':
        onGenerationPartial(ev);
        break;
      case 'done': {
        const sc = await fetchScript(ev.videoId, ev.lang);
        if (dead || ev.videoId !== videoId || ev.lang !== lang) return;
        if (sc) onGenerationDone(sc);
        break;
      }
      case 'error':
        if (following || status === 'generating') onGenerationError(ev.code, ev.detail, ev);
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
    if (status === 'live') return liveProgressText();
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

  /** How far the part being watched is described, in seconds of the video. */
  function liveUpTo() {
    return describedUpTo(coveredRanges(script), getVideo()?.currentTime ?? 0);
  }

  function liveProgressText() {
    const upTo = liveUpTo();
    const count = String(script?.cues?.length || 0);
    return upTo > 0 ? t('status_live_progress', formatTime(upTo), count) : t('status_live_progress_none');
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
    blankFrames = 0;
    liveSeq += 1;
    framesInFlight = false;
    queuedWindow = null;
    framesPausedUntil = 0;
    status = 'live';
    errorCode = '';
    const v = getVideo();
    sampler.reset(v ? v.currentTime : null);
    console.info(`[SceneVoice] describing from frames with ${provider()}`);
    // Quarters already described (a video watched before) are not said again.
    progressSaid = { milestone: Math.floor(livePercent() / 25) * 0.25, at: Date.now() };
    renderProgress();
    if (quiet) announcer.status(await withAiNotice(t('status_live_resuming')));
    else feedback(await withAiNotice(t('status_live_start', t(`provider_name_${provider()}`))));
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
    ui.hideProgress();
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
      blankFrames = canvasLooksBlank(frameCanvas) ? blankFrames + 1 : 0;
      if (blankFrames >= BLANK_FRAMES_LIMIT) {
        blankFrames = 0;
        onLiveError('frames-protected');
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
    if (!res || res.error) return onLiveError(res?.error || 'unknown', res?.detail, res);
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
  function onLiveError(code, detail, extra = {}) {
    console.warn('[SceneVoice] describing frames failed', code, detail || '');
    if (PASSING_FRAME_ERRORS.has(code)) {
      framesPausedUntil = Date.now() + (SLOW_RETRY_ERRORS.has(code) ? 60000 : 15000);
      if (!framesErrorsSaid.has(code)) {
        framesErrorsSaid.add(code);
        announcer.status(t('live_skipped', errorText(code)));
      }
      return undefined;
    }
    stopLive();
    return onGenerationError(code, detail, extra);
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
      .filter((c) => c.start <= now && now - c.start <= (LATE_LIMIT[c.kind] || LATE_LIMIT.visual))
      .filter((c) => (settings.onScreenText || c.kind !== 'text') && passesDensity(c, setting('density')));
    if (dialogue) due = dropTextHeardInCaptions(due, captionLines).cues;
    const cue = pickOne(due);
    if (cue && (!pendingLate || pickOne([pendingLate.cue, cue]) === cue)) pendingLate = { cue, at: now };
  }

  /**
   * Say a description that is waiting for a pause (one held back during another
   * description, then one that came back late), once nothing else is being said.
   * The held one goes first: it was due at its moment; the late one is extra.
   */
  function tryHeld(video) {
    if (speakingCue) return;
    const now = video.currentTime;
    if (deferred) {
      const { cue, at } = deferred;
      if (now < at - 1) {
        deferred = null; // seeked away
      } else if (now - at > DEFER_WAIT) {
        deferred = null;
        console.info(`[SceneVoice] ${formatTime(cue.start)} dropped: no pause came within ${DEFER_WAIT} s`);
        noteSkipped();
      } else {
        // The pause the model estimated began at the cue's own moment; part of it has passed.
        const left = cue.gapMeasured ? cue : { ...cue, gap: Math.max(0, cue.gap - (now - cue.start)) };
        if (sayHeld(left, video)) deferred = null;
        return;
      }
    }
    const late = pendingLate;
    if (!late) return;
    if (now < late.at - 1 || now - late.at > LATE_WAIT) {
      if (now - late.at > LATE_WAIT) noteSkipped();
      pendingLate = null; // seeked away, or no pause came
      return;
    }
    const prefix = now - late.cue.start > LATE_PREFIX_AFTER ? t('late_prefix') : '';
    if (!sayHeld(late.cue, video, { prefix })) return;
    pendingLate = null;
    console.info(`[SceneVoice] ${formatTime(late.cue.start)} said late, at ${formatTime(now)}`);
  }

  /**
   * Say a waiting cue now if it fits the pause we are in (or the mode allows
   * pausing): its moment becomes now, and the captions, when known, say how much
   * room there is from here. Returns whether it was said.
   */
  function sayHeld(held, video, { prefix = '' } = {}) {
    const now = video.currentTime;
    const source = held.source || held;
    let cue = { ...held, start: now, source };
    if (dialogue) {
      // A cue fitted earlier carries the room it had at its own moment (often little: that is why it
      // waited), not the model's estimate. Fit it again from the estimate, so the room is the lesser
      // of that and the pause we are in now, rather than capped at what it had then.
      const base = held.gapMeasured ? { ...cue, gap: source.gap ?? held.gap, gapMeasured: false } : cue;
      cue = { ...fitCuesToDialogue([base], dialogue, fitOptions(video))[0], source };
    }
    if (cue.start > now + 0.15) return false; // speech ends in a moment: wait for it
    if (!utteranceFor(cue, video)) return false;
    deliver(cue, { prefix });
    return true;
  }

  /** Keep a cue that came due during another description for the next pause: the more important of it and one already waiting. */
  function hold(cue, now) {
    if (deferred) {
      if (pickOne([deferred.cue, cue]) !== cue) return;
      noteSkipped();
    }
    console.info(`[SceneVoice] ${formatTime(cue.start)} waits: a description at least as important is being said`);
    deferred = { cue, at: now };
  }

  /**
   * A description found no pause and was skipped. In "keep playing" mode that is
   * by design, but a listener who loses more than a few should hear, once per
   * video, that pause mode would keep them.
   */
  function noteSkipped() {
    if (setting('mode') !== 'gaps') return;
    skipped += 1;
    if (skipped <= SKIPPED_NOTICE_AFTER || skippedSaidFor === videoId) return;
    skippedSaidFor = videoId;
    const key = shortcut('cycle-mode');
    announcer.status(key ? t('status_skipped_no_pause', String(skipped), key) : t('status_skipped_no_pause_setting', String(skipped)));
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

  /**
   * @param {object} [o.cue]  the cue being spoken during playback, so a cue no more important does not cut it off.
   *   Without one the text is what the user asked for (describe now, repeat, an answer): nothing scheduled cuts it off.
   * @param {string} [o.lead]  words in the interface language the text begins with ("Earlier: "); the rest is in the description language.
   */
  async function speakText(text, { pause = false, kind = 'visual', urgent = false, cue = null, lead = '' } = {}) {
    const video = getVideo();
    const token = (speechToken += 1);
    speakingCue = cue ? { kind: cue.kind, priority: cue.priority } : { kind: 'manual', priority: 0 };
    // If an earlier utterance paused the video, this one inherits the duty to resume it.
    if (pausedByUs) pausedByUs = token;
    if (settings.showText) ui.showText(text, kind, estimateSeconds(text, readerRate()));
    if (pause && video && !video.paused) {
      pausedByUs = token;
      video.pause();
    } else if (!pausedByUs) {
      duck(video);
    }
    await announcer.say(text, { urgent, lead });
    if (token !== speechToken) return; // a newer utterance took over
    speakingCue = null;
    unduck();
    if (pausedByUs !== token) return;
    if (pause && settings.output !== 'tts') {
      // The screen reader's end is only estimated: hold the video a little longer (see SCREENREADER_RESUME_HOLD_MS).
      await new Promise((r) => setTimeout(r, SCREENREADER_RESUME_HOLD_MS));
      if (token !== speechToken) return;
    }
    resumeIfPausedByUs(video);
  }

  /** What to say for a cue now, or null when it does not fit and the mode says skip. */
  function utteranceFor(cue, video, manual = false) {
    return chooseUtterance(cue, {
      mode: manual ? 'manual' : setting('mode'),
      detail: setting('detail'),
      rate: readerRate(),
      onScreenText: manual ? true : settings.onScreenText,
      playbackRate: video?.playbackRate || 1,
    });
  }

  /** @param {string} [o.prefix]  said before the description ("Earlier:" for one well after its moment) */
  function deliver(cue, { manual = false, prefix = '' } = {}) {
    const video = getVideo();
    const u = utteranceFor(cue, video, manual);
    if (!u) {
      console.info(`[SceneVoice] ${formatTime(cue.start)} skipped: does not fit (gap ${cue.gap}s${cue.gapMeasured ? ' from captions' : ''})`);
      noteSkipped();
      return;
    }
    const text = prefix ? `${prefix}${u.text}` : u.text;
    console.info(`[SceneVoice] ${formatTime(cue.start)} ${cue.kind}${u.needsPause ? ' (pause)' : ''}: ${text}`);
    lastSpoken = { text, kind: cue.kind, cue: cue.source || cue };
    speakText(text, { pause: u.needsPause, kind: cue.kind, urgent: manual, cue: manual ? null : cue, lead: prefix });
  }

  function stopSpeaking() {
    speechToken += 1;
    speakingCue = null;
    deferred = null;
    announcer.stop();
    unduck();
    ui.hideText();
    resumeIfPausedByUs();
  }

  /**
   * The user moved to another moment (a jump of more than SEEK_JUMP seconds):
   * the description of the old one stops, and so does anything waiting for a
   * pause there. Small corrections and the player's own adjustments pass.
   */
  function onSeeked(video) {
    const from = lastPosition;
    const now = video.currentTime;
    lastPosition = now;
    scheduler.reset(now);
    if (!Number.isFinite(from) || Math.abs(now - from) <= SEEK_JUMP) return;
    pendingLate = null;
    deferred = null;
    if (!announcer.speaking) return;
    console.info(`[SceneVoice] seek from ${formatTime(from)} to ${formatTime(now)}: speech stopped`);
    // Ends the utterance like a finished one: the video is unducked and, if we paused it, resumed.
    announcer.stop();
  }

  // ---------- playback loop ----------

  function watchVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    // The player swaps <video> elements (ads, the miniplayer, a reload): an old one's events say nothing about the video being watched.
    const current = () => !dead && getVideo() === video;
    video.addEventListener('play', () => {
      if (!current()) return;
      // The user resumed during a pause we made: leave the video playing.
      pausedByUs = 0;
      maybeHint();
    });
    video.addEventListener('seeked', () => {
      if (current()) onSeeked(video);
    });
    video.addEventListener('ended', () => {
      if (current()) finishLive(video);
    });
    // At 2x a pause passes twice as fast: a cue placed for 1x may no longer fit the pause chosen
    // for it while a longer one within reach would. Compared with what the last fit used, like
    // the reading speed: a player that re-sets the same rate (an ad, a reload) changes nothing.
    video.addEventListener('ratechange', () => {
      if (current() && script && dialogue && fittedWith && fittedWith.playbackRate !== (video.playbackRate || 1)) scheduleCues();
    });
  }

  function tick() {
    if (!videoId || dead) return;
    tickCount += 1;
    if (tickCount % 16 === 0) ui.mount();
    if (tickCount % 8 === 0) {
      renderProgress();
      sayProgress();
    }
    const video = getVideo();
    if (!video) return;
    watchVideo(video);
    // Not while seeking: the position is already the new one, and the seek must be seen as a jump from the old.
    if (!video.seeking) lastPosition = video.currentTime;
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
      tryHeld(video);
      return;
    }
    if (!mayInterrupt(speakingCue, cue)) {
      // Never cut off a description at least as important: wait for the next pause instead (see tryHeld).
      hold(cue, video.currentTime);
      return;
    }
    deliver(cue);
  }

  // ---------- user actions ----------

  async function toggle() {
    if (!videoId) return;
    if (status === 'generating' || startingFor === videoId) {
      // Pressed again at once: stop and turn descriptions off. Otherwise: how far it has got.
      if (Date.now() - progressPressAt < PRESS_AGAIN_MS) {
        progressPressAt = 0;
        const minutes = script?.completedUntil > 0 ? savedMinutes(script) : '';
        await setSettings({ enabled: false }).catch(() => {});
        feedback(`${t('status_off')} ${minutes ? t('status_stopped_partial', minutes) : t('status_stopped')}`);
        return;
      }
      progressPressAt = Date.now();
      const key = shortcut('toggle-descriptions');
      feedback(key ? `${progressText()} ${t('status_press_again_to_stop', key)}` : progressText());
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
    // Stopped part-way by an error: the shortcut carries on from where it stopped.
    if (settings.enabled && !script.complete && RESUMABLE_ERRORS.has(errorCode)) {
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
    // A model that is sent pictures gets those of the last 20 seconds (Gemini gets a clip of them).
    let frames;
    if (framesMode()) {
      const shot = momentFrames(video.currentTime, { before: 20, after: 0, max: FRAME_SAMPLING.maxFrames });
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
      // Earlier questions about this video, so that a follow-up question is understood.
      history: askHistory.videoId === videoId ? askHistory.items : [],
      // The labels the descriptions use for people, so the answer calls them the same.
      characters: script?.characters || [],
      lang,
      ...(frames ? { frames } : {}),
    });
    if (res?.error === 'extension-reloaded') {
      die();
      return { text: errorText('extension-reloaded'), time: null };
    }
    if (!res || res.error || !res.text) {
      // The message says the settings page is opening: make it true.
      if (res?.error === 'no-key' || res?.error === 'bad-key') openSettingsForKey();
      return { text: errorText(res?.error || 'unknown'), time: null };
    }
    if (askHistory.videoId !== videoId) askHistory = { videoId, items: [] };
    askHistory.items = [...askHistory.items, { question, answer: res.text }].slice(-ASK_HISTORY_MAX);
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
      if (dead) return;
      feedback(errorText('no-key'));
      openSettingsForKey();
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
        // By voice it goes through speakText, so a scheduled description does not cut it off.
        if (settings.output === 'tts') speakText(answer.text, { urgent: true });
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
      if (res?.error === 'no-key' || res?.error === 'bad-key') openSettingsForKey();
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
      describedUpTo: status === 'live' ? liveUpTo() : null,
      cueCount: script?.cues?.length || 0,
      firstCue: script?.cues?.length ? script.cues[0].start : null,
      completedUntil: script?.completedUntil || 0,
      complete: Boolean(script?.complete),
      model: script?.model || '',
      // What this video's descriptions cost at list price ({ amount, currency }), or null when unknown or not charged.
      cost: script?.usage && script.provider !== 'cloud' ? estimateCost(script.model, script.usage) : null,
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
