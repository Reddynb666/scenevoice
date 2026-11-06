// Shared constants for SceneVoice.

export const SCRIPT_VERSION = 2;

export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com';

/** Sites SceneVoice runs on. Bilibili is experimental. */
export const PLATFORMS = Object.freeze(['youtube', 'bilibili']);

/**
 * Models that can write the descriptions (see providers.js). 'cloud' is the
 * SceneVoice Cloud relay: Gemini behind a metered proxy, with an anonymous
 * device token in place of a key, for listeners who have no key of their own.
 */
export const PROVIDERS = Object.freeze(['gemini', 'qwen', 'cloud']);

/**
 * SceneVoice Cloud relay (server/). Gemini-compatible, so GeminiClient talks to
 * it unchanged with apiKey = the device token. The owner changes this to the
 * domain they register; the manifest's host permission names the same origin.
 */
export const CLOUD_API_BASE = 'https://api.scenevoice.app';

/**
 * Qwen (通义千问) through Alibaba Cloud Model Studio (阿里云百炼 / DashScope),
 * OpenAI-compatible mode. Checked against the documentation on 2026-10-31
 * (help.aliyun.com/zh/model-studio/regions, /vision): the DashScope address
 * below still works for mainland China (Beijing) but is the legacy one, with no
 * new features from 2026-09-30; the recommended address is per workspace,
 * https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1, which
 * the user can enter under Advanced. qwen3-vl-plus takes base64 JPEG pictures in
 * image_url parts (up to 250 per request, request body up to 16 MiB on this
 * address) and JSON mode when not thinking. Not yet run with a real key.
 */
export const DEFAULT_QWEN_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_QWEN_MODEL = 'qwen3-vl-plus';

/**
 * Pictures taken from the playing video for models that are not sent a link to it.
 * One frame every intervalSeconds; one request per windowSeconds of video with at
 * most maxFrames of them, scaled down to maxWidth pixels, as JPEG at `quality`.
 * 待确认: how many images and how many pixels a request may carry (Qwen's limit
 * can be lowered per computer with the qwenMaxFrames local setting).
 */
export const FRAME_SAMPLING = Object.freeze({ intervalSeconds: 2, windowSeconds: 12, maxFrames: 6, maxWidth: 640, quality: 0.7 });
/**
 * Protected (DRM) video draws as solid black: after this many black pictures in
 * a row (about 12 seconds of playback) SceneVoice stops and says why. A fade to
 * black in a film is far shorter.
 */
export const BLANK_FRAMES_LIMIT = 6;

/**
 * The in-page command that reads every shortcut aloud. It exists only in the
 * content script's own key layer (shortcuts.js), not in the manifest.
 */
export const SAY_SHORTCUTS = 'say-shortcuts';

/**
 * Default keys for the commands Chrome gives none (it allows four suggested
 * keys, see static/manifest.json): handled by the content script itself, and
 * changed on SceneVoice's settings page rather than chrome://extensions/shortcuts,
 * which is hard to use with a screen reader. Chrome's own key for a command
 * always wins (see shortcuts.js). "Alt" is Option on a Mac. The four commands
 * the manifest suggests keys for have none here ('').
 */
export const PAGE_SHORTCUT_DEFAULTS = Object.freeze({
  'toggle-descriptions': '',
  'describe-now': '',
  'repeat-last': '',
  'ask-question': '',
  'report-wrong': 'Alt+Shift+W',
  'cycle-detail': 'Alt+Shift+E',
  'cycle-mode': 'Alt+Shift+M',
  'cycle-density': 'Alt+Shift+N',
  'speed-up': 'Alt+Shift+Up',
  'speed-down': 'Alt+Shift+Down',
  'stop-speaking': 'Alt+Shift+X',
  [SAY_SHORTCUTS]: 'Alt+Shift+H',
});

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
  /** Say "AI-generated audio description follows" each time descriptions start on a video;
   *  false = only the first time for each video (ids kept in storage.sync, AI_NOTICE_SEEN_KEY). */
  aiNoticeEveryTime: true,
  /** The "press the shortcut to create descriptions" hint has been given (it is given once, ever). */
  generateHintGiven: false,
  /** Pause the video while the "ask a question" dialog is open. */
  pauseOnAsk: true,
  /** The model that describes videos on each site (see providers.js). */
  youtubeProvider: 'gemini',
  bilibiliProvider: 'qwen',
  /** Seconds of video described per day before new jobs are refused (DAILY_BUDGETS); 0 = no limit. */
  dailyBudgetSeconds: 0,
  /** Send finished descriptions (text only) to the SceneVoice Cloud cache, so the next
   *  listener of the same video gets them at once. Turned on when the listener picks Cloud. */
  shareDescriptions: false,
  /** Keys handled by the content script, { command: 'Alt+Shift+W' } ('' = none); see PAGE_SHORTCUT_DEFAULTS. */
  pageShortcuts: PAGE_SHORTCUT_DEFAULTS,
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
  it: 'Una donna con un cappotto rosso attraversa la strada innevata.',
  nl: 'Een vrouw in een rode jas steekt de besneeuwde straat over.',
  pl: 'Kobieta w czerwonym płaszczu przechodzi przez zaśnieżoną ulicę.',
  tr: 'Kırmızı paltolu bir kadın karla kaplı caddeden karşıya geçiyor.',
  vi: 'Một người phụ nữ mặc áo khoác đỏ băng qua con đường phủ tuyết.',
  th: 'ผู้หญิงสวมเสื้อโค้ตสีแดงเดินข้ามถนนที่ปกคลุมด้วยหิมะ',
  id: 'Seorang perempuan bermantel merah menyeberangi jalan yang tertutup salju.',
  bn: 'লাল কোট পরা এক নারী বরফে ঢাকা রাস্তা পার হচ্ছেন।',
  ur: 'سرخ کوٹ پہنے ایک عورت برف سے ڈھکی سڑک پار کر رہی ہے۔',
  fa: 'زنی با پالتوی قرمز از خیابان پوشیده از برف عبور می‌کند.',
  uk: 'Жінка в червоному пальті переходить засніжену вулицю.',
  sw: 'Mwanamke aliyevaa koti jekundu anavuka barabara iliyofunikwa na theluji.',
});

/**
 * Spoken by the welcome page's "Hear a sample", in the interface language, with
 * no model and no key: what descriptions sound like. On-screen text first, a
 * person labelled by two features, then an action, the way the prompts ask.
 */
export const SAMPLE_DESCRIPTIONS = Object.freeze({
  en: ['Title: How to repot a plant.', 'A woman with grey hair and a green apron lifts a fern out of its pot.', 'She shakes the soil from the roots over a newspaper.'],
  'zh-CN': ['标题：怎样给植物换盆。', '一位灰白头发、系绿色围裙的女人把一盆蕨类从花盆里提出来。', '她在报纸上方抖掉根上的土。'],
  'zh-TW': ['標題：怎樣幫植物換盆。', '一位灰白頭髮、繫綠色圍裙的女人把一盆蕨類從花盆裡提出來。', '她在報紙上方抖掉根上的土。'],
  es: ['Título: Cómo trasplantar una planta.', 'Una mujer de pelo gris y delantal verde saca un helecho de su maceta.', 'Sacude la tierra de las raíces sobre un periódico.'],
  fr: ['Titre : Comment rempoter une plante.', 'Une femme aux cheveux gris et au tablier vert sort une fougère de son pot.', 'Elle secoue la terre des racines au-dessus d’un journal.'],
  de: ['Titel: Wie man eine Pflanze umtopft.', 'Eine Frau mit grauen Haaren und grüner Schürze hebt einen Farn aus seinem Topf.', 'Sie schüttelt die Erde über einer Zeitung von den Wurzeln.'],
  pt: ['Título: Como replantar uma planta.', 'Uma mulher de cabelo grisalho e avental verde tira uma samambaia do vaso.', 'Ela sacode a terra das raízes sobre um jornal.'],
  ja: ['タイトル：植物の植え替え方。', '白髪で緑のエプロンをした女性が、鉢からシダを持ち上げる。', '彼女は新聞紙の上で根の土を振り落とす。'],
  ko: ['제목: 화분 분갈이하는 법.', '흰머리에 초록 앞치마를 두른 여자가 화분에서 고사리를 들어 올린다.', '그녀는 신문지 위에서 뿌리의 흙을 털어 낸다.'],
  ru: ['Заголовок: Как пересадить растение.', 'Седая женщина в зелёном фартуке вынимает папоротник из горшка.', 'Она стряхивает землю с корней над газетой.'],
  ar: ['العنوان: كيف تنقل نبتة إلى أصيص جديد.', 'امرأة شعرها رمادي وترتدي مئزرًا أخضر ترفع سرخسًا من أصيصه.', 'تنفض التراب عن الجذور فوق صحيفة.'],
  hi: ['शीर्षक: पौधे को नए गमले में कैसे लगाएँ।', 'सफ़ेद बालों वाली, हरा एप्रन पहने एक महिला गमले से फ़र्न बाहर निकालती है।', 'वह अख़बार के ऊपर जड़ों से मिट्टी झाड़ती है।'],
  id: ['Judul: Cara memindahkan tanaman ke pot baru.', 'Seorang perempuan berambut abu-abu dengan celemek hijau mengangkat pakis dari potnya.', 'Ia mengibaskan tanah dari akarnya di atas koran.'],
  vi: ['Tiêu đề: Cách thay chậu cho cây.', 'Một người phụ nữ tóc bạc, đeo tạp dề xanh lá nhấc cây dương xỉ ra khỏi chậu.', 'Bà giũ đất khỏi rễ cây trên một tờ báo.'],
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
  it: 'Non è certo. ',
  nl: 'Niet zeker. ',
  pl: 'Nie jest to pewne. ',
  tr: 'Kesin değil. ',
  vi: 'Không chắc chắn. ',
  // Thai separates clauses with a space, not a full stop.
  th: 'ไม่แน่ใจ ',
  id: 'Tidak pasti. ',
  bn: 'নিশ্চিত নয়। ',
  ur: 'یقینی نہیں۔ ',
  fa: 'قطعی نیست. ',
  uk: 'Можливо, неточно. ',
  sw: 'Si hakika. ',
});

/**
 * Words that already say a description is not certain, per description
 * language, in lower case. The first three of each list are also shown to the
 * model as examples of how to hedge in that language (gemini.js hedgeExamples),
 * so they are the plainest ones.
 */
export const HEDGE_WORDS = Object.freeze({
  en: ['appears to', 'possibly', 'hard to see', 'appear to', 'seems', 'seem to', 'looks like', 'perhaps', 'maybe', 'probably', 'likely', 'might', 'may be', 'unclear', 'not clear', 'hard to', 'difficult to', 'cannot see', "can't see", 'cannot tell', "can't tell", 'not certain', 'uncertain', 'blurry', 'indistinct'],
  'zh-CN': ['可能', '看起来', '看不清', '似乎', '好像', '看上去', '不清楚', '不太清', '难以辨认', '也许', '大概', '或许', '疑似', '像是', '不确定', '不太确定'],
  'zh-TW': ['可能', '看起來', '看不清', '似乎', '好像', '看上去', '不清楚', '不太清', '難以辨認', '也許', '大概', '或許', '疑似', '像是', '不確定', '不太確定'],
  es: ['parece', 'posiblemente', 'quizá', 'tal vez', 'probablemente', 'no se ve', 'no está claro', 'no es seguro'],
  fr: ['semble', 'peut-être', 'probablement', 'on dirait', 'difficile', 'pas sûr', 'pas certain', 'flou'],
  de: ['scheint', 'möglicherweise', 'vielleicht', 'wahrscheinlich', 'undeutlich', 'unklar', 'nicht sicher'],
  pt: ['parece', 'possivelmente', 'talvez', 'provavelmente', 'não está claro', 'não é possível ver'],
  ja: ['おそらく', 'らしい', 'ようだ', 'ようです', 'ような', 'かもしれ', 'はっきりし', '見えにく', 'と思われ'],
  ko: ['아마', '것 같', '보이는', '불분명', '확실하지', '잘 보이지'],
  ru: ['возможно', 'похоже', 'кажется', 'вероятно', 'неясно', 'неточно', 'видимо', 'плохо видно'],
  ar: ['ربما', 'يبدو', 'غير واضح', 'غير مؤكد', 'قد يكون', 'على ما يبدو', 'من الصعب رؤية'],
  hi: ['शायद', 'लगता', 'संभवतः', 'स्पष्ट नहीं', 'निश्चित नहीं', 'हो सकता है', 'साफ़ नहीं', 'धुंधला'],
  it: ['sembra', 'forse', 'non si vede bene', 'sembrano', 'pare', 'probabilmente', 'possibilmente', 'potrebbe', 'non è chiaro', 'non è certo', 'difficile da', 'sfocato'],
  nl: ['lijkt', 'misschien', 'moeilijk te zien', 'lijken', 'blijkbaar', 'mogelijk', 'waarschijnlijk', 'vermoedelijk', 'onduidelijk', 'niet duidelijk', 'niet zeker', 'wazig'],
  pl: ['wydaje się', 'być może', 'trudno dostrzec', 'wygląda na', 'chyba', 'może', 'prawdopodobnie', 'możliwe', 'niewyraźn', 'niejasn', 'nie jest to pewne', 'nie widać'],
  tr: ['gibi görünüyor', 'belki', 'net değil', 'gibi', 'muhtemelen', 'olabilir', 'galiba', 'sanki', 'kesin değil', 'belirsiz', 'zor görülüyor', 'bulanık'],
  vi: ['có vẻ', 'có lẽ', 'khó thấy rõ', 'dường như', 'hình như', 'có thể', 'không rõ', 'không chắc', 'khó thấy', 'khó nhìn', 'mờ'],
  th: ['ดูเหมือน', 'อาจจะ', 'มองไม่ชัด', 'น่าจะ', 'คงจะ', 'ไม่ชัด', 'ไม่ชัดเจน', 'ไม่แน่ใจ', 'เบลอ'],
  id: ['tampaknya', 'mungkin', 'sulit dilihat', 'sepertinya', 'kelihatannya', 'kemungkinan', 'tidak jelas', 'kurang jelas', 'tidak pasti', 'tidak terlihat jelas', 'buram'],
  bn: ['সম্ভবত', 'মনে হচ্ছে', 'স্পষ্ট নয়', 'মনে হয়', 'হয়তো', 'হতে পারে', 'অস্পষ্ট', 'নিশ্চিত নয়', 'দেখা যাচ্ছে না', 'ঝাপসা'],
  ur: ['لگتا ہے', 'شاید', 'واضح نہیں', 'لگتی ہے', 'غالباً', 'ممکنہ طور پر', 'ہو سکتا ہے', 'یقینی نہیں', 'صاف نظر نہیں', 'دھندلا'],
  fa: ['به نظر می‌رسد', 'شاید', 'واضح نیست', 'به نظر', 'احتمالاً', 'ظاهراً', 'مشخص نیست', 'معلوم نیست', 'قطعی نیست', 'به سختی دیده'],
  uk: ['схоже', 'можливо', 'погано видно', 'здається', 'ймовірно', 'мабуть', 'неясно', 'неточно', 'нечітко', 'не видно', 'важко розгледіти'],
  sw: ['inaonekana', 'labda', 'haionekani vizuri', 'yaonekana', 'huenda', 'pengine', 'yawezekana', 'si wazi', 'si hakika', 'haijulikani', 'vigumu kuona'],
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
  it: 'A $1: ',
  nl: 'Op $1: ',
  pl: 'W $1: ',
  tr: '$1 anında: ',
  vi: 'Tại $1: ',
  th: 'ที่ $1: ',
  id: 'Pada $1: ',
  bn: '$1-এ: ',
  ur: '$1 پر: ',
  fa: 'در $1: ',
  uk: 'На $1: ',
  sw: 'Kwenye $1: ',
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
  /** response_format json_object: documented for qwen3-vl-plus and qwen-vl-max in non-thinking mode only,
   *  and the request must mention JSON. Off: the prompt asks for JSON and the reply is read leniently. */
  qwenJsonMode: false,
  /** Pictures per request: the documented limit is 250 base64 images; 6 keeps requests small and cheap. */
  qwenMaxFrames: FRAME_SAMPLING.maxFrames,
  /** SceneVoice Cloud: the anonymous device token (the only credential, kept like a key),
   *  the plan it was last seen on ('free' | 'plus' | 'org'), and the model chosen through the relay ('' = automatic). */
  cloudToken: '',
  cloudPlan: '',
  cloudModel: '',
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
  { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'th', name: 'ไทย' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'ur', name: 'اردو' },
  { code: 'fa', name: 'فارسی' },
  { code: 'uk', name: 'Українська' },
  { code: 'sw', name: 'Kiswahili' },
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
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  bn: 'Bengali',
  ur: 'Urdu',
  fa: 'Persian',
  uk: 'Ukrainian',
  sw: 'Swahili',
});

/** Description languages written right to left: their names and text get dir="rtl" / dir="auto". */
export const RTL_LANGUAGES = Object.freeze(['ar', 'fa', 'he', 'ur']);

/** Seconds of video per Gemini request. Shorter chunks keep output within limits. */
export const CHUNK_SECONDS = 300;
/**
 * How long one generateContent call may run before SceneVoice calls it timed out.
 * A five-minute section normally returns in 30–90 seconds. This is longer than
 * that, and shorter than waiting in silence until a proxy or the server's own
 * deadline (often many minutes) drops the connection as a generic network error.
 * A section that hits it is described again in two shorter pieces.
 */
export const GEMINI_REQUEST_TIMEOUT_MS = 180000;
/** The model list is a small GET. Past this the listener hears a timeout instead of nothing. */
export const GEMINI_LIST_TIMEOUT_MS = 30000;
/**
 * Frames per second sampled from a YouTube section. Gemini's default is 1,
 * which is what its docs warn is heavy for a clip of about five minutes.
 * Audio description uses the same two-second interval as the picture path.
 */
export const VIDEO_SAMPLE_FPS = 0.5;
/** Progress is said at these fractions of the work, and never twice within PROGRESS_GAP_MS. */
export const PROGRESS_MILESTONES = Object.freeze([0.25, 0.5, 0.75]);
export const PROGRESS_GAP_MS = 20000;
/** storage.sync key: videos whose AI notice has been said, when it is said only once per video (newest last). */
export const AI_NOTICE_SEEN_KEY = 'aiNoticeSeen';
export const AI_NOTICE_SEEN_MAX = 300;

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

/** Choices for the daily limit: none, 30 minutes, 1, 2 and 4 hours of video described per day. */
export const DAILY_BUDGETS = Object.freeze([0, 1800, 3600, 7200, 14400]);

/** chrome.storage.local key of the rolling daily usage counter (see usage.js). */
export const USAGE_KEY = 'usage';

/**
 * List prices per million tokens, for the estimate shown to the listener.
 * Checked on 2026-11-04 against ai.google.dev/gemini-api/docs/pricing and the
 * Model Studio price list. A model id matches the row with the longest prefix,
 * so dated snapshots and previews price like their family; a model with no row
 * shows tokens only. Thinking tokens are billed as output. These are paid-tier
 * prices: a free-tier Gemini key is not charged at all.
 */
export const MODEL_PRICES = Object.freeze([
  // Doubles on 2027-01-01 (announced with the 3.8 launch).
  { prefix: 'gemini-3.8-flash', currency: 'USD', input: 0.75, output: 3.75, after: { on: '2027-01-01', input: 1.5, output: 7.5 } },
  { prefix: 'gemini-3.5-flash-lite', currency: 'USD', input: 0.3, output: 2.5 },
  { prefix: 'gemini-3.1-flash-lite', currency: 'USD', input: 0.25, output: 1.5 },
  { prefix: 'gemini-2.5-flash-lite', currency: 'USD', input: 0.1, output: 0.4 },
  // Deprecated: from 2026-12-01 its requests go to 3.5 Flash-Lite, at the same price.
  { prefix: 'gemini-2.5-flash', currency: 'USD', input: 0.3, output: 2.5 },
  { prefix: 'qwen3-vl-plus', currency: 'CNY', input: 1, output: 10 },
]);
