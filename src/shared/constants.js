// Shared constants for SceneVoice.

export const SCRIPT_VERSION = 2;

export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com';

/** Sites SceneVoice runs on. Bilibili is experimental. */
export const PLATFORMS = Object.freeze(['youtube', 'bilibili']);

/** Models that can write the descriptions (see providers.js). */
export const PROVIDERS = Object.freeze(['gemini', 'qwen']);

/**
 * Qwen (通义千问) through Alibaba Cloud Model Studio (阿里云百炼 / DashScope),
 * OpenAI-compatible mode. 待确认: the mainland China endpoint and the model
 * name are taken from the DashScope documentation as last known; both can be
 * changed on the settings page.
 */
export const DEFAULT_QWEN_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_QWEN_MODEL = 'qwen-vl-max';

/**
 * Pictures taken from the playing video for models that are not sent a link to it.
 * One frame every intervalSeconds; one request per windowSeconds of video with at
 * most maxFrames of them, scaled down to maxWidth pixels, as JPEG at `quality`.
 * 待确认: how many images and how many pixels a request may carry (Qwen's limit
 * can be lowered per computer with the qwenMaxFrames local setting).
 */
export const FRAME_SAMPLING = Object.freeze({ intervalSeconds: 2, windowSeconds: 12, maxFrames: 6, maxWidth: 640, quality: 0.7 });

/** Settings synced across the user's browsers (no secrets here). */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  /** 'gaps' = speak only in pauses, never stop the video;
   *  'pause' = pause the video when a description does not fit;
   *  'manual' = only describe when the user asks. */
  mode: 'gaps',
  /** 'brief' | 'standard' | 'detailed' */
  detail: 'standard',
  /** The user picked the mode / the detail / the density themselves (popup,
   *  settings page or shortcut). A choice of their own is never adjusted to the video type. */
  modeChosen: false,
  detailChosen: false,
  densityChosen: false,
  /** Use the mode, detail and density set below for entertainment and tutorial
   *  videos (see videotype.js), for whichever of them the user has not picked. */
  autoByType: true,
  entertainmentMode: 'gaps',
  entertainmentDetail: 'brief',
  /** Entertainment is for enjoying: only what is needed to follow, quiet moments left quiet. */
  entertainmentDensity: 'essential',
  tutorialMode: 'pause',
  tutorialDetail: 'detailed',
  tutorialDensity: 'standard',
  /** How many of the generated descriptions to speak: 'essential' (priority 1),
   *  'standard' (1-2) or 'full' (everything). On-screen text gets one level
   *  more (see passesDensity). Filters without regenerating. */
  density: 'standard',
  /** Read on-screen text (titles, captions burned into the video, prices, code),
   *  word for word and ahead of other descriptions. */
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
  /** Also say how far generation has got, at every quarter (needs announceStatus). */
  announceProgress: true,
  /** Pause the video while the "ask a question" dialog is open. */
  pauseOnAsk: true,
  /** The model that describes videos on each site (see providers.js). */
  youtubeProvider: 'gemini',
  bilibiliProvider: 'qwen',
});

/** Allowed values for the choice settings, in the order the cycle shortcuts step through them. */
export const MODES = Object.freeze(['gaps', 'pause', 'manual']);
export const DETAILS = Object.freeze(['brief', 'standard', 'detailed']);
export const DENSITIES = Object.freeze(['essential', 'standard', 'full']);
export const OUTPUTS = Object.freeze(['screenreader', 'tts']);

/** Video types with their own mode, detail and density. Anything else uses the general settings. */
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

/**
 * Said before a description or answer Gemini marked as uncertain, when its own
 * words do not already say so (see HEDGE_WORDS). In the description language.
 */
export const UNCERTAIN_LEAD = Object.freeze({
  en: 'Not certain. ',
  'zh-CN': '不太确定。',
  'zh-TW': '不太確定。',
  es: 'No está claro. ',
  fr: "Ce n'est pas sûr. ",
  de: 'Nicht sicher. ',
  pt: 'Não está claro. ',
  ja: 'はっきりしません。',
  ko: '확실하지 않습니다. ',
  ru: 'Возможно, неточно. ',
  ar: 'غير مؤكد. ',
  hi: 'निश्चित नहीं। ',
});

/** Words that already say a description is not certain, per description language, in lower case. */
export const HEDGE_WORDS = Object.freeze({
  en: ['appears to', 'appear to', 'seems', 'seem to', 'looks like', 'possibly', 'perhaps', 'maybe', 'probably', 'likely', 'might', 'may be', 'unclear', 'not clear', 'hard to', 'difficult to', 'cannot see', "can't see", 'cannot tell', "can't tell", 'not certain', 'uncertain', 'blurry', 'indistinct'],
  'zh-CN': ['可能', '似乎', '好像', '看起来', '看上去', '看不清', '不清楚', '不太清', '难以辨认', '也许', '大概', '或许', '疑似', '像是', '不确定', '不太确定'],
  'zh-TW': ['可能', '似乎', '好像', '看起來', '看上去', '看不清', '不清楚', '不太清', '難以辨認', '也許', '大概', '或許', '疑似', '像是', '不確定', '不太確定'],
  es: ['parece', 'posiblemente', 'quizá', 'tal vez', 'probablemente', 'no se ve', 'no está claro', 'no es seguro'],
  fr: ['semble', 'peut-être', 'probablement', 'on dirait', 'difficile', 'pas sûr', 'pas certain', 'flou'],
  de: ['scheint', 'möglicherweise', 'vielleicht', 'wahrscheinlich', 'undeutlich', 'unklar', 'nicht sicher'],
  pt: ['parece', 'possivelmente', 'talvez', 'provavelmente', 'não está claro', 'não é possível ver'],
  ja: ['おそらく', 'らしい', 'ようだ', 'ようです', 'ような', 'かもしれ', 'はっきりし', '見えにく', 'と思われ'],
  ko: ['아마', '것 같', '보이는', '불분명', '확실하지', '잘 보이지'],
  ru: ['возможно', 'похоже', 'кажется', 'вероятно', 'неясно', 'неточно', 'видимо', 'плохо видно'],
  ar: ['ربما', 'يبدو', 'غير واضح', 'غير مؤكد'],
  hi: ['शायद', 'लगता', 'संभवतः', 'स्पष्ट नहीं', 'निश्चित नहीं'],
});

/** How an answer to a question names the moment it is about ($1 is m:ss), in the description language. */
export const ANSWER_AT = Object.freeze({
  en: 'At $1: ',
  'zh-CN': '在 $1 处：',
  'zh-TW': '在 $1 處：',
  es: 'En el minuto $1: ',
  fr: 'À $1 : ',
  de: 'Bei $1: ',
  pt: 'No minuto $1: ',
  ja: '$1 の時点：',
  ko: '$1 지점: ',
  ru: 'На $1: ',
  ar: 'عند $1: ',
  hi: '$1 पर: ',
});

/** Secrets and per-device data, stored in chrome.storage.local only. */
export const DEFAULT_LOCAL = Object.freeze({
  apiKey: '',
  model: '',
  apiBase: DEFAULT_API_BASE,
  /** Qwen: kept here like the Gemini key, so content scripts cannot read it. */
  qwenApiKey: '',
  qwenModel: DEFAULT_QWEN_MODEL,
  qwenApiBase: DEFAULT_QWEN_API_BASE,
  /** 待确认: whether vision models accept response_format json_object. Off: the reply is parsed leniently. */
  qwenJsonMode: false,
  /** 待确认: images per request the account's model accepts. */
  qwenMaxFrames: FRAME_SAMPLING.maxFrames,
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
/** Progress is said at these fractions of the work, and never twice within PROGRESS_GAP_MS. */
export const PROGRESS_MILESTONES = Object.freeze([0.25, 0.5, 0.75]);
export const PROGRESS_GAP_MS = 20000;

/** Maximum scripts kept in the local cache before the oldest are evicted. */
export const CACHE_LIMIT = 300;

/** Descriptions marked as wrong that are remembered per video and language (the newest are kept). */
export const FEEDBACK_LIMIT = 50;

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
  /** A description the user marked as wrong: describe that moment again and replace it in the cache. */
  REVISE: 'sv:revise',
  /** Frames taken from the playing video, to be described and added to the cache. */
  GEN_FRAMES: 'sv:gen-frames',
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
  'report-wrong',
  'cycle-detail',
  'cycle-mode',
  'cycle-density',
  'speed-up',
  'speed-down',
  'stop-speaking',
]);
