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
  /** The user picked the mode / the detail themselves (popup, settings page or shortcut).
   *  A choice of their own is never adjusted to the video type. */
  modeChosen: false,
  detailChosen: false,
  /** Use the mode and detail set below for entertainment and tutorial videos
   *  (see videotype.js), for whichever of the two the user has not picked. */
  autoByType: true,
  entertainmentMode: 'gaps',
  entertainmentDetail: 'brief',
  tutorialMode: 'pause',
  tutorialDetail: 'detailed',
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
  /** Built-in voice only: rate (1 = the voice's normal speed) and pitch (1 = normal). */
  ttsRate: 1.2,
  ttsPitch: 1,
  /** Built-in voice chosen for each description language, e.g. { 'zh-CN': 'Tingting' }.
   *  '' = pick automatically. Voice names are per computer; a missing one falls back. */
  ttsVoices: Object.freeze({}),
  /** One voice for every language, from before voices were per language. Used only
   *  for a language without its own choice, and only when the voice speaks it. */
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

/** Allowed values for the choice settings, in the order the cycle shortcuts step through them. */
export const MODES = Object.freeze(['gaps', 'pause', 'manual']);
export const DETAILS = Object.freeze(['brief', 'standard', 'detailed']);
export const DENSITIES = Object.freeze(['essential', 'standard', 'full']);
export const OUTPUTS = Object.freeze(['screenreader', 'tts']);

/** Video types with their own mode and detail. Anything else uses the general settings. */
export const VIDEO_TYPES = Object.freeze(['entertainment', 'tutorial']);

/** Screen reader speeds offered in settings, slowest first. */
export const READER_SPEEDS = Object.freeze([1, 1.6, 2.4, 3.2]);

/** Slider ranges for the built-in voice. The speed shortcuts step by `step`. */
export const TTS_RATE = Object.freeze({ min: 0.6, max: 3, step: 0.1 });
export const TTS_PITCH = Object.freeze({ min: 0.5, max: 1.5, step: 0.1 });

/** Spoken by "Test voice", in the description language (not the interface language). */
export const VOICE_SAMPLES = Object.freeze({
  en: 'A woman in a red coat crosses the snowy street.',
  'zh-CN': '一位穿红色大衣的女人走过积雪的街道。',
  'zh-TW': '一位穿紅色大衣的女人走過積雪的街道。',
  es: 'Una mujer con un abrigo rojo cruza la calle nevada.',
  fr: 'Une femme en manteau rouge traverse la rue enneigée.',
  de: 'Eine Frau im roten Mantel überquert die verschneite Straße.',
  pt: 'Uma mulher de casaco vermelho atravessa a rua coberta de neve.',
  ja: '赤いコートの女性が雪の積もった通りを渡っていく。',
  ko: '빨간 코트를 입은 여자가 눈 덮인 거리를 건넌다.',
  ru: 'Женщина в красном пальто переходит заснеженную улицу.',
  ar: 'امرأة ترتدي معطفًا أحمر تعبر الشارع المغطى بالثلج.',
  hi: 'लाल कोट पहने एक महिला बर्फ़ से ढकी सड़क पार करती है।',
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
  /** Content script asks the service worker for one cached description script. */
  GET_SCRIPT: 'sv:get-script',
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
  'speed-up',
  'speed-down',
  'stop-speaking',
]);
