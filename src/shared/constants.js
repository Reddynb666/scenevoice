// Shared constants for SceneVoice.

export const SCRIPT_VERSION = 2;

export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com';

/** Settings synced across the user's browsers (no secrets here). */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  /** 'gaps' = speak only in pauses, never stop the video;
   *  'pause' = pause the video when a description does not fit;
   *  'manual' = only describe when the user asks. */
  mode: 'gaps',
  /** 'brief' | 'standard' | 'detailed' */
  detail: 'standard',
  /** How many of the generated descriptions to speak: 'essential' (priority 1),
   *  'standard' (1-2) or 'full' (everything). Filters without regenerating. */
  density: 'standard',
  /** Read on-screen text (titles, captions burned into the video, signs). */
  onScreenText: true,
  /** Description language. 'auto' follows the browser UI language. */
  language: 'auto',
  /** 'screenreader' = hand text to the user's screen reader via a live region;
   *  'tts' = speak with the browser's built-in voices. */
  output: 'screenreader',
  /** Interrupt other screen reader speech (aria-live="assertive"). */
  interrupt: false,
  /** How fast the user's screen reader talks, relative to a typical default. */
  readerSpeed: 1.6,
  ttsRate: 1.2,
  ttsVoice: '',
  /** Lower the video volume while a description is spoken. */
  duck: true,
  duckLevel: 0.35,
  /** Show the current description as large text over the video. */
  showText: false,
  /** Generate automatically when a video without descriptions is opened. */
  autoGenerate: false,
  /** Speak status messages (generating, ready, errors). */
  announceStatus: true,
  /** Pause the video while the "ask a question" dialog is open. */
  pauseOnAsk: true,
});

/** Secrets and per-device data, stored in chrome.storage.local only. */
export const DEFAULT_LOCAL = Object.freeze({
  apiKey: '',
  model: '',
  apiBase: DEFAULT_API_BASE,
});

export const LANGUAGES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Português' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
]);

export const LANGUAGE_NAMES_EN = Object.freeze({
  en: 'English',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
});

/** Seconds of video per Gemini request. Shorter chunks keep output within limits. */
export const CHUNK_SECONDS = 300;

/** Maximum scripts kept in the local cache before the oldest are evicted. */
export const CACHE_LIMIT = 300;

export const MSG = Object.freeze({
  // content/popup/options -> background
  GET_STATUS: 'sv:get-status',
  DELETE_SCRIPT: 'sv:delete-script',
  SPEAK: 'sv:speak',
  STOP_SPEAKING: 'sv:stop-speaking',
  GET_VOICES: 'sv:get-voices',
  OPEN_OPTIONS: 'sv:open-options',
  CACHE_INFO: 'sv:cache-info',
  CACHE_CLEAR: 'sv:cache-clear',
  // content -> background: description generation (runs in the offscreen document)
  GEN_START: 'sv:gen-start',
  GEN_STOP: 'sv:gen-stop',
  GEN_STATUS: 'sv:gen-status',
  ASK: 'sv:ask',
  // background -> content
  COMMAND: 'sv:command',
  TTS_EVENT: 'sv:tts-event',
  GEN_EVENT: 'sv:gen-event',
  // background <-> offscreen document
  OFFSCREEN: 'sv:offscreen',
  JOB_EVENT: 'sv:job-event',
  // popup -> content
  TAB_STATE: 'sv:tab-state',
  TAB_ACTION: 'sv:tab-action',
});

export const COMMANDS = Object.freeze([
  'toggle-descriptions',
  'describe-now',
  'repeat-last',
  'ask-question',
  'cycle-detail',
  'cycle-mode',
  'cycle-density',
  'stop-speaking',
]);
