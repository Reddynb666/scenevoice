// Gemini API client. Request builders are pure functions so they can be tested;
// network calls take an injectable fetch.

import { ANSWER_AT, DEFAULT_API_BASE, GEMINI_LIST_TIMEOUT_MS, GEMINI_REQUEST_TIMEOUT_MS, HEDGE_WORDS, LANGUAGE_NAMES_EN, UNCERTAIN_LEAD, VIDEO_SAMPLE_FPS } from './constants.js';
import { ApiError } from './errors.js';
import { CONFIDENCES, cleanText, extractJson, formatTime, hedged, parseTime } from './script.js';
import { askHistoryText } from './ask.js';
import { countedUsage } from './usage.js';

/** The people the descriptions have labelled so far, for the model to keep calling them the same. */
export function peopleText(characters) {
  const list = (Array.isArray(characters) ? characters : [])
    .filter((c) => c && typeof c.label === 'string' && c.label.trim())
    .slice(0, 20);
  if (!list.length) return '';
  const one = (c) => `${clip(c.label, 80)}${typeof c.description === 'string' && c.description ? ` (${clip(c.description, 160)})` : ''}`;
  return `People already introduced earlier in the video (reuse these labels): ${list.map(one).join('; ')}`;
}

/** @see ApiError; Gemini's own name, kept for the code and tests that use it. */
export class GeminiError extends ApiError {}

const CUE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    start: { type: 'NUMBER' },
    gap: { type: 'NUMBER' },
    kind: { type: 'STRING', enum: ['visual', 'text'] },
    priority: { type: 'INTEGER' },
    // Text cues: the text exactly as written, transcribed before the
    // spoken versions are written, so they quote it rather than paraphrase.
    // Also what playback compares with the captions. '' for visual cues.
    onScreenText: { type: 'STRING' },
    // Decided before the spoken versions, so they can say in words what is not
    // clear. A low one is heard less often and is said to be uncertain (script.js).
    confidence: { type: 'STRING', enum: CONFIDENCES },
    brief: { type: 'STRING' },
    standard: { type: 'STRING' },
    detailed: { type: 'STRING' },
  },
  required: ['start', 'gap', 'kind', 'priority', 'onScreenText', 'confidence', 'brief', 'standard', 'detailed'],
  propertyOrdering: ['start', 'gap', 'kind', 'priority', 'onScreenText', 'confidence', 'brief', 'standard', 'detailed'],
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    // Chooses the default mode, detail and density for the video (see videotype.js). It
    // comes with the descriptions, so knowing it costs no extra request.
    videoType: { type: 'STRING', enum: ['entertainment', 'tutorial', 'other'] },
    characters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          description: { type: 'STRING' },
        },
        required: ['label'],
      },
    },
    cues: { type: 'ARRAY', items: CUE_SCHEMA },
  },
  required: ['videoType', 'characters', 'cues'],
  propertyOrdering: ['videoType', 'characters', 'cues'],
};

/** One moment described again, after the user marked its description as wrong. */
const REVISION_SCHEMA = {
  type: 'OBJECT',
  properties: { cues: { type: 'ARRAY', items: CUE_SCHEMA } },
  required: ['cues'],
};

/** An answer to a question, with the moment it is about, so SceneVoice can say it and jump there. */
const ASK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    time: { type: 'NUMBER' },
    confidence: { type: 'STRING', enum: CONFIDENCES },
    answer: { type: 'STRING' },
  },
  required: ['time', 'confidence', 'answer'],
  propertyOrdering: ['time', 'confidence', 'answer'],
};

/**
 * The description language's English name, for the prompts. Any real language
 * can be asked for (storage.js resolveLanguage), so one without a table is
 * named by the browser ("sv" → "Swedish"); the code itself is the last resort.
 */
export function languageName(code) {
  if (LANGUAGE_NAMES_EN[code]) return LANGUAGE_NAMES_EN[code];
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * How to hedge, as examples for the model: in English, and in the description
 * language when that is another one. Taken from the words SceneVoice itself
 * recognises as hedging (HEDGE_WORDS), so a model that uses them is not told
 * "Not certain." a second time. A language without a table gets English only.
 */
export function hedgeExamples(lang) {
  const quoted = (words) => words.slice(0, 3).map((w) => `"${w}"`).join(', ');
  const en = quoted(HEDGE_WORDS.en);
  const own = lang && lang !== 'en' && HEDGE_WORDS[lang];
  return own ? `${en} (in ${languageName(lang)} ${quoted(own)})` : en;
}

/**
 * The "I cannot see it" example for the question prompts: in English, and in
 * the description language when it has its own "Not certain." lead (with the
 * full stop that language writes, without the space that follows it).
 */
export function cannotTellExample(lang) {
  const en = 'for example "I can\'t tell from the picture"';
  const own = lang && lang !== 'en' && UNCERTAIN_LEAD[lang];
  return own ? `${en}, or in ${languageName(lang)} "${own.trim()}"` : en;
}

export function youtubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function clip(text, n) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * System instructions. They follow published audio description practice
 * (ACB Audio Description Project guidelines, Netflix AD Style Guide, DCMP
 * Description Key, and the Chinese T/CSMPTE 13-2021 standard): describe what
 * is seen, set the scene, introduce people, read on-screen text, never talk over
 * dialogue, and never interpret. Blind viewers say what they mind most is
 * missing text on screen, and descriptions that fill every silence: text comes
 * first, word for word, and quiet moments stay quiet. What worries them most
 * is a description that is wrong without any way to tell: so only what is
 * seen, no guessed feelings, judgements or identities, uncertainty said out
 * loud, and a confidence for every description.
 */
export function scriptInstructions(lang) {
  const language = languageName(lang);
  return [
    'You are a professional audio describer writing audio description (AD) for blind and low-vision viewers.',
    `Write every description in ${language}.`,
    '',
    'Always describe (these come first when time is short):',
    '- Meaningful on-screen text, each as its own "text" cue (see below). It comes before everything else: a viewer can often follow the picture from the sound, but never text they cannot see.',
    '- Every change of place or time: start that description with where we are now (and when, if it changed).',
    '- Every person the first time they appear: a short visual sketch (apparent age, build, hair, clothing) and what they are doing. On later appearances, just the label.',
    '- Who is speaking or being spoken to, whenever that is not obvious from the audio alone (for example in a group, a video call, or when someone speaks off screen).',
    '- Actions and their results: what someone does, picks up, hands over, points at, and what happens next. Follow the action step by step in demonstrations, tutorials, cooking, sport and gameplay.',
    '- Expressions and gestures that carry meaning (a nod, a smile, a shaking head, a look away): the expression itself, not the feeling you suppose behind it.',
    '- Important objects, products, charts, diagrams and what they show.',
    '',
    'Also describe, as priority 2 or 3 and only when it adds something the viewer would want to know (never just because there is a pause): setting details, clothing, lighting and weather, camera moves that matter (a close-up on an object, a drone shot of a landscape), montages (summarise), and the light and colour that set the mood (the light and colour, not the feeling).',
    '',
    'Rules:',
    '- Describe only what can be seen. Never describe what can be heard (dialogue, music, sound effects) and never repeat what a speaker is saying.',
    '- Present tense, active voice, plain and specific words. Describe; do not interpret ("she frowns", not "she is angry"; "he is looking at the floor", not "he is embarrassed").',
    '- Do not give away what happens later, and do not add facts you cannot see.',
    '- If you are not sure what something is, say "appears to" rather than guessing. Never invent names, numbers or text.',
    '- Do not censor: describe what is shown.',
    '',
    'Objective, and honest about what is not clear:',
    '- Do not guess what people feel, think, want or intend, and do not explain why something happens. Describe the face, the body and the action, and let the viewer draw the conclusion.',
    '- Do not judge or praise: no "beautiful", "delicious", "amazing", "ugly", "funny", "elegant". Say what makes it so ("a three-layer cake with white icing", not "a delicious cake").',
    '- Do not guess who someone is. A name, job, title, relationship (wife, boss, doctor), nationality, religion or health comes only from on-screen text (a lower third, a name tag, a sign) or from the dialogue saying it clearly. Never identify anyone from their face or voice, however famous they look.',
    `- When something is small, far away, blurred, dark, partly hidden or too quick to see, say so instead of filling in the detail: ${hedgeExamples(lang)}. Leave out what you cannot see at all. A vague description that is true is better than a precise one that is wrong.`,
    '- "confidence" says how sure you are that everything in the description is right: "high" when it is clearly visible, "medium" when a detail is inferred from what is visible, "low" when the picture is unclear or you are guessing what something is. With "low", the description itself must say in words that it is not certain.',
    '',
    'Examples (wrong → right):',
    '- "He is furious." → "He slams his fist on the table."',
    '- "她很伤心，想起了往事。" → "她低下头，用手背擦了擦眼睛。"',
    '- "A beautiful, peaceful beach." → "A wide, empty beach with small waves."',
    '- "一盘美味的红烧肉。" → "一盘红烧肉，酱汁油亮。"',
    '- "Taylor Swift walks on stage." (no name on screen or in the dialogue) → "A woman in a silver sequinned dress walks on stage."',
    '- "他的妻子走进厨房。"（字幕和对白都没说明两人的关系）→ "一位短发女人走进厨房。"',
    '- "He hands her a 100-dollar bill." (too small to read) → "He hands her what appears to be a banknote."',
    '- "屏幕上写着“周五截止”。"（字太小，读不出来）→ "屏幕上有一行小字，看不清。"',
    '',
    'People:',
    '- Use a name only after on-screen text or the dialogue has tied it to that person. The title or the uploader\'s description may say who is in the video, but not which person on screen is who. Until then use a short, consistent visual label (for example "the woman in the red coat") and keep using it.',
    '- Keep labels consistent with the provided character list. Add new people to "characters" with a one-line description of how they look, not of who you think they are.',
    '- Make a label tell people apart: two visible features, such as clothing colour and role or hair (for example "the woman host in red", "the man with glasses"; in Chinese "穿红衣服的女主持人", "戴眼镜的男人"). Never a bare "a man", "a woman", "一个男人", "一位女士".',
    '- When someone already in the character list appears again, call them by that same label every time (or "he" / "she" when it cannot be confused). Never introduce them again as a new, unnamed person: not "A man walks in." but "The man with glasses walks back in."; not "一个男人走进来。" but "戴眼镜的男人又走了进来。"',
    '',
    'On-screen text (kind "text"):',
    '- Give meaningful text its own "text" cue; never fold it into a visual description. That includes titles and title cards, names and roles in lower thirds, chapter cards, subtitles burned into the picture, slides, chart and graph labels with their numbers, prices, scores, dates, phone numbers, email and web addresses, social media handles, code, menu items and buttons in a screen recording, signs, labels, chat and phone screens.',
    '- "onScreenText" is a transcription: copy the text exactly as written, character for character, in its original language and script, with its numbers, symbols, capitalisation and punctuation. Never translate, summarise, correct or reword it. Separate lines or list items with " / ". Text that appears together (one slide, one menu, one lower third) is one cue. For visual cues, "onScreenText" is "".',
    '- Text you cannot read in full: transcribe only what you can read, put "…" where words are missing, set "confidence" to "low", and say in the spoken versions that part of it cannot be read. Never complete a word, a name or a number by guessing.',
    `- The three spoken versions quote "onScreenText" word for word after a one- or two-word label saying what it is (for example "Title: …", "Price: …", "Code: …", "Menu: …"). For long text, the brief version quotes only the key words and the standard version the most important lines, in reading order, but neither rewords what it quotes. If the text is not in ${language}, quote the original and add a short translation in the standard and detailed versions.`,
    '- Skip text the viewer already hears: subtitles of dialogue in the language being spoken, or words a speaker reads aloud. Do read subtitles that translate speech in another language. Skip channel watermarks, subscribe buttons and platform interface, and do not read the same text again while it stays on screen.',
    '- Set "start" when the text appears, or at the first pause in speech while it is still on screen.',
    '',
    'When to describe, and when to stay silent:',
    '- Describe only when something visually important appears, happens or changes. Silence is part of the experience: never describe just to fill a pause, and do not describe again what is still the same.',
    '- There is no quota. A talking head, a slide already read, or a long take may need nothing for a minute or more; a fast demonstration or an action scene may need a description every few seconds (as close as 2 seconds apart).',
    '- Music, scenery and other atmospheric passages: let them play. Describe only a key change in the picture (a new place, a new person, a cut to something different), in a few words, with priority 3 unless it matters to the story or the subject.',
    '- Each description says one thing. Do not pad: the viewer hears the video first and the description second.',
    '- No filler: never start with "We see", "The video shows", "In this scene", "The camera shows" or "画面中可以看到", "镜头里", "视频中"; say what is there ("A dog runs across the beach.", "一只狗跑过沙滩。"). Do not repeat what the title or the dialogue already says.',
    '',
    'Timing:',
    '- "start" is the moment in seconds from the beginning of the full video when the description should begin. Place it as close as possible to the action, preferably in a pause in speech.',
    '- "gap" is how many seconds of silence, music or sound effects follow "start" before anyone speaks again. Use 0.5 if speech continues immediately. Be honest: the viewer\'s screen reader uses it to decide how much it can say without covering dialogue.',
    '- At the very start of the video (0 to 2 seconds), give an establishing description with priority 1: the setting, who is present, and what kind of video this is.',
    '',
    'Three lengths for every description (write all three):',
    '- "brief": the essential fact in at most 8 words (or 15 characters in Chinese, Japanese or Korean).',
    '- "standard": one sentence, at most 22 words (40 characters in CJK).',
    '- "detailed": one or two sentences, at most 50 words (90 characters in CJK), adding setting, appearance or detail.',
    '- In text cues, only the quoted on-screen text may go beyond these limits.',
    '',
    'Priority:',
    '- 1 = needed to follow what happens: scene changes, who is present, the main action and its result, who is speaking, and on-screen text that carries information (titles, names, numbers, prices, contact details, code, instructions).',
    '- 2 = helpful: secondary actions, expressions and gestures, objects, appearance details on first sight, minor on-screen text such as a sign in the background.',
    '- 3 = atmosphere: decor, lighting, scenery, minor background activity, the picture during music. Anything the viewer would not miss.',
    '',
    'Video type ("videoType"), for the whole video, judged from the title, the uploader\'s description and the picture:',
    '- "tutorial": made to teach or explain, so what is on screen must not be missed: lessons and lectures, how-to and product demonstrations, cooking and craft tutorials, science explainers, news or analysis built on charts, maps or slides.',
    '- "entertainment": watched for enjoyment: films, series, animation, music videos and performances, vlogs, gameplay, comedy, sport.',
    '- "other": neither, or you cannot tell.',
    '',
    'Output JSON only, matching the schema. If nothing important is visible in this section, return an empty "cues" list: that is a correct answer, not a failure.',
  ].join('\n');
}

/** How many of the previous section's last descriptions the next section is told about. */
export const PREVIOUS_CUES = 4;

/**
 * The request text for one section.
 * @param {Array<{start: number, text: string}>} [previous]  the last descriptions
 *   of the section before, so this one does not describe the same thing again,
 *   and does not open with an establishing description as if the video began here.
 */
export function scriptPrompt({ meta = {}, chunk, duration, characters = [], previous = [], lang }) {
  const recent = (Array.isArray(previous) ? previous : []).slice(-PREVIOUS_CUES);
  const lines = [
    `Video title: ${clip(meta.title, 200) || 'unknown'}`,
    meta.channel ? `Channel: ${clip(meta.channel, 100)}` : '',
    meta.description ? `Video description (from the uploader): ${clip(meta.description, 1500)}` : '',
    Number.isFinite(duration) ? `Full video length: ${formatTime(duration)} (${Math.round(duration)} seconds).` : '',
    `Describe only the section from ${formatTime(chunk.start)} to ${formatTime(chunk.end)} (${chunk.start}s to ${chunk.end}s). Timestamps must be seconds from the start of the full video.`,
    chunk.start > 0
      ? 'This section is not the start of the video: the viewer has been watching since the beginning, so give no establishing description. Carry on from what was already described, and describe only what appears, happens or changes in this section.'
      : '',
    recent.length
      ? `Already described just before this section; do not describe it again unless it changed: ${recent.map((r) => `${formatTime(r.start)} ${clip(r.text, 160)}`).join(' | ')}`
      : '',
    characters.length
      ? peopleText(characters)
      : '',
    `Write in ${languageName(lang)}.`,
  ];
  return lines.filter(Boolean).join('\n');
}


/** Older models cap output at 8k tokens; newer ones allow far more (thinking counts against it). */
export function outputLimit(model = '') {
  return /^gemini-(1\.|2\.0)/.test(model) ? 8192 : 32768;
}

/**
 * The YouTube video part for one section. A section that is the whole video
 * carries no clip offsets. Every section asks for VIDEO_SAMPLE_FPS rather than
 * Gemini's default of one frame a second: five minutes at that default is the
 * request the API's own video docs say can come back as a deadline error.
 */
export function videoPartFor(videoId, { start, end, duration, fps = VIDEO_SAMPLE_FPS } = {}) {
  const part = { fileData: { fileUri: youtubeUrl(videoId) } };
  const whole = start <= 0 && Number.isFinite(duration) && end >= duration - 1;
  const meta = {};
  if (!whole) {
    meta.startOffset = `${start}s`;
    meta.endOffset = `${end}s`;
  }
  if (fps) meta.fps = fps;
  if (Object.keys(meta).length) part.videoMetadata = meta;
  return part;
}

export function buildScriptRequest({ videoId, meta, chunk, duration, characters, previous, lang, model }) {
  const videoPart = videoPartFor(videoId, { start: chunk.start, end: chunk.end, duration });
  return {
    systemInstruction: { parts: [{ text: scriptInstructions(lang) }] },
    contents: [
      {
        role: 'user',
        parts: [videoPart, { text: scriptPrompt({ meta, chunk, duration, characters, previous, lang }) }],
      },
    ],
    generationConfig: {
      ...tuningFor(model, 0.4),
      maxOutputTokens: outputLimit(model),
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
}

/**
 * Model-family specific generation settings. Gemini 3 is tuned for its default
 * temperature; Gemini 2.5 Flash spends thinking tokens from the output budget,
 * so keep that modest.
 */
export function tuningFor(model = '', temperature) {
  const cfg = {};
  if (/^gemini-3/.test(model)) cfg.thinkingConfig = { thinkingLevel: 'low' };
  else if (/^gemini-2\.5-flash/.test(model)) cfg.thinkingConfig = { thinkingBudget: 1024 };
  if (!/^gemini-3/.test(model) && Number.isFinite(temperature)) cfg.temperature = temperature;
  return cfg;
}

/** The part of the video a question is asked about: the 20 seconds before the moment and a few after. */
export function askClip(time, duration) {
  const start = Math.max(0, Math.floor(time - 20));
  const end = Math.min(Number.isFinite(duration) ? Math.ceil(duration) : Math.ceil(time + 5), Math.ceil(time + 4));
  return { start, end: Math.max(end, start + 2) };
}

export function buildAskRequest({ videoId, meta, time, duration, question, nearbyText, history, characters, lang, model }) {
  const { start, end } = askClip(time, duration);
  return {
    systemInstruction: {
      parts: [
        {
          text: [
            'You help a blind or low-vision person understand a video they are watching.',
            `Answer in ${languageName(lang)}, in at most 3 short sentences, plain text without markdown.`,
            'Base the answer on what can be seen in the clip, at or just before the moment they asked. Describe what is visible: do not guess what people feel or intend, do not judge, and name a person only if on-screen text or the dialogue gives the name.',
            'Quote any text on screen that bears on the question exactly as written.',
            `If the clip does not show the answer, or you cannot see it clearly, say so plainly (${cannotTellExample(lang)}) and set "confidence" to "low". Never invent details.`,
            '"time": the moment your answer is about, in seconds from the start of the full video (not from the start of the clip). SceneVoice says that moment before your answer, so do not put a time in "answer".',
            '"confidence": "high" when the answer is clearly visible, "medium" when part of it is inferred, "low" when you are not sure.',
            'The recent audio descriptions were written by an AI and can be wrong: check them against the picture, and do not repeat them as fact.',
          ].join('\n'),
        },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            fileData: { fileUri: youtubeUrl(videoId) },
            videoMetadata: { startOffset: `${start}s`, endOffset: `${end}s` },
          },
          {
            text: [
              `Video title: ${clip(meta?.title, 200) || 'unknown'}`,
              `The viewer paused at ${formatTime(time)} (${Math.round(time)} seconds). The clip covers ${formatTime(start)} to ${formatTime(end)} (${start}s to ${end}s) of the full video.`,
              nearbyText ? `Recent audio descriptions (may be wrong): ${clip(nearbyText, 800)}` : '',
              peopleText(characters),
              askHistoryText(history),
              `Question: ${clip(question, 500)}`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      },
    ],
    generationConfig: {
      ...tuningFor(model, 0.2),
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: ASK_SCHEMA,
    },
  };
}

/**
 * The moment an answer is about, in seconds of the full video. A time the model
 * gave from the start of the clip is moved to the video; one outside the clip
 * is not trusted, and the moment the viewer asked at is used instead.
 */
export function answerTime(value, { time, duration }) {
  const asked = Math.max(0, Math.floor(time));
  const { start, end } = askClip(time, duration);
  let t = parseTime(value);
  if (!Number.isFinite(t) || t < 0) return asked;
  if (start > 0 && t < start - 2 && t <= end - start + 2) t += start;
  if (t < start - 2 || t > end + 2) return asked;
  return Math.max(0, Math.round(t));
}

const LEADING_TIME = /^[^\d\n]{0,15}?(\d{1,2}:\d{2}(?::\d{2})?)\s*[^\s\d,:，：、。.]{0,3}\s*[,:，：、]\s*/;

/**
 * Read the answer to a question. Resolves to
 * { text, time, confidence }: text starts with the moment it is about ("At 2:15: …",
 * "在 2:15 处：…") and says it is not certain when Gemini is not; time is that
 * moment in seconds, for jumping there. A relay that ignores the schema and
 * answers in plain text still gives an answer, about the moment asked.
 */
export function parseAskResponse(body, ctx) {
  return parseAnswer(responseText(body).text, ctx);
}

/** The answer to a question from the model's text, whichever model wrote it (see parseAskResponse). */
export function parseAnswer(raw, { time, duration, lang }) {
  let json = null;
  try {
    json = extractJson(raw);
  } catch {
    json = null;
  }
  const given = json && typeof json === 'object' ? json.answer : raw;
  let answer = cleanText(typeof given === 'string' ? given : '', 700);
  if (!answer) throw new GeminiError('empty-response');
  const t = answerTime(json?.time, { time, duration });
  const confidence = CONFIDENCES.includes(json?.confidence) ? json.confidence : '';
  // Asked not to, the model may still begin with the moment: say it only once.
  const lead = LEADING_TIME.exec(answer);
  if (lead && [formatTime(t), formatTime(t - askClip(time, duration).start)].includes(lead[1])) answer = answer.slice(lead[0].length);
  if (confidence === 'low') answer = hedged(answer, lang);
  const at = (ANSWER_AT[lang] || ANSWER_AT.en).replace('$1', formatTime(t));
  return { text: `${at}${answer}`, time: t, confidence };
}

/** The part of the video looked at again for a description marked as wrong. */
export function revisionClip(start, duration) {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const from = Math.max(0, Math.floor(start - 8));
  const to = Math.min(Math.ceil(end), Math.ceil(start + 12));
  return { start: from, end: Math.max(to, from + 4) };
}

function revisionPrompt({ meta = {}, duration, cue, clip: span, characters = [], lang }) {
  return [
    `Video title: ${clip(meta.title, 200) || 'unknown'}`,
    meta.channel ? `Channel: ${clip(meta.channel, 100)}` : '',
    Number.isFinite(duration) ? `Full video length: ${formatTime(duration)} (${Math.round(duration)} seconds).` : '',
    `A viewer reported that this description, at ${formatTime(cue.start)} (${cue.start} seconds), is wrong:`,
    `"${clip(cue.standard, 600)}"`,
    cue.kind === 'text' && cue.onScreenText ? `It was given as on-screen text reading: "${clip(cue.onScreenText, 600)}"` : '',
    `Look again, closely, at the clip from ${formatTime(span.start)} to ${formatTime(span.end)} (${span.start}s to ${span.end}s of the full video), and write a corrected description of that moment: one cue, with "start" at ${cue.start}.`,
    '- Check every detail against the picture: people, actions, objects, colours, numbers and text. Leave out anything you cannot clearly see.',
    '- Do not repeat the reported description, and do not just reword it. Keep only what you can confirm in the picture.',
    `- If you are still not sure, say so in the description (${hedgeExamples(lang)}) and set "confidence" to "low".`,
    '- If, looking again, nothing at that moment is worth describing, return an empty "cues" list.',
    characters.length
      ? `People already introduced earlier in the video (reuse these labels): ${characters.map((c) => `${c.label}${c.description ? ` (${c.description})` : ''}`).join('; ')}`
      : '',
    `Write in ${languageName(lang)}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Describe one moment again: a short clip around a description the user marked as wrong. */
export function buildRevisionRequest({ videoId, meta, duration, cue, characters, lang, model }) {
  const span = revisionClip(cue.start, duration);
  return {
    systemInstruction: { parts: [{ text: scriptInstructions(lang) }] },
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: youtubeUrl(videoId) }, videoMetadata: { startOffset: `${span.start}s`, endOffset: `${span.end}s` } },
          { text: revisionPrompt({ meta, duration, cue, clip: span, characters, lang }) },
        ],
      },
    ],
    generationConfig: {
      ...tuningFor(model, 0.2),
      maxOutputTokens: Math.min(outputLimit(model), 8192),
      responseMimeType: 'application/json',
      responseSchema: REVISION_SCHEMA,
    },
  };
}

const FRAME_SCHEMAS = { script: RESPONSE_SCHEMA, ask: ASK_SCHEMA, revise: REVISION_SCHEMA };

/**
 * A request built from still frames instead of a video link: for videos Gemini
 * cannot open by URL (Bilibili). `prompt` comes from frames.js; each frame is a
 * label and a JPEG image, in time order.
 * @param {{kind: 'script'|'ask'|'revise', system: string, frames: Array<{label: string, data: string}>, text: string, maxTokens: number, temperature: number, model: string}} prompt
 */
export function buildFramesRequest({ kind, system, frames, text, maxTokens, temperature, model }) {
  const parts = [];
  for (const f of frames) parts.push({ text: f.label }, { inlineData: { mimeType: 'image/jpeg', data: f.data } });
  parts.push({ text });
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      ...tuningFor(model, temperature),
      maxOutputTokens: Math.min(outputLimit(model), maxTokens),
      responseMimeType: 'application/json',
      responseSchema: FRAME_SCHEMAS[kind],
    },
  };
}

/** Models that cannot describe video, or are not general text models. */
const UNSUITABLE = /(image|tts|audio|live|embedding|robotics|computer-use|native|deep-research|nano)/;

function textModelIds(models) {
  return (models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((n) => /^gemini-\d/.test(n) && !UNSUITABLE.test(n));
}

/**
 * Pick a good default model from the list the key can use. With `health`
 * (modelhealth.js), a model that was overloaded or slow just now goes to the
 * back: the newest model is often the busiest, and a listener waiting a minute
 * and a half for a 503 hears nothing at all.
 */
export function chooseModel(models, health = null) {
  const usable = textModelIds(models);
  const score = (n) => {
    const v = parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const flash = /flash/.test(n) ? 1 : 0;
    const lite = /lite/.test(n) ? 1 : 0;
    const preview = /(preview|exp)/.test(n) ? 1 : 0;
    const dated = /-\d{2,}/.test(n.replace(/^gemini-\d+(\.\d+)?/, '')) ? 1 : 0;
    // Prefer flash (fast, cheap, good video understanding), then stable over preview,
    // then newer versions, then the plain alias over dated snapshots.
    return flash * 1000 - lite * 500 - preview * 100 + v * 10 - dated;
  };
  const penalty = (n) => health?.penalty(n) || 0;
  usable.sort((a, b) => penalty(a) - penalty(b) || score(b) - score(a));
  return usable[0] || '';
}

export function usableModels(models) {
  const ids = new Set(textModelIds(models));
  return (models || [])
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => ids.has(m.id));
}

/** A 429 about the day's quota rather than this minute's: the free tier's per-day limits, and YouTube hours per day. */
const DAILY_QUOTA = /per.?day|daily|youtube.{0,40}hours?/i;

/** The wait the server asks for, from a google.rpc.RetryInfo detail ("12s", or { seconds, nanos }), in ms; undefined when none. */
export function retryDelayMs(details) {
  for (const d of Array.isArray(details) ? details : []) {
    if (!/RetryInfo$/.test(String(d?.['@type'] || '')) || d.retryDelay == null) continue;
    const delay = d.retryDelay;
    const seconds = typeof delay === 'string' ? parseFloat(delay) : Number(delay.seconds || 0) + Number(delay.nanos || 0) / 1e9;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  return undefined;
}

/** When the SceneVoice Cloud allowance comes back, from the error detail that refused the request (ISO time), or ''. */
function allowanceReset(details) {
  for (const d of Array.isArray(details) ? details : []) {
    const at = d?.resetsAt || d?.metadata?.resetsAt || d?.resetAt || d?.metadata?.resetAt;
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return at;
  }
  return '';
}

/**
 * The error for a failed HTTP reply, as a stable code. 429 is split: the
 * minute's rate limit ('rate-limited', retried, honouring RetryInfo) and the
 * day's quota ('quota-daily', not retried: another model may still have some).
 * The SceneVoice Cloud relay refuses a used-up free allowance with
 * reason SCENEVOICE_ALLOWANCE ('allowance': neither retried nor switched).
 */
function classifyHttp(status, body) {
  const msg = body?.error?.message || '';
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const reason = JSON.stringify(details);
  if (details.some((d) => d?.reason === 'SCENEVOICE_ALLOWANCE')) {
    const err = new GeminiError('allowance', msg, status);
    err.resetAt = allowanceReset(details);
    return err;
  }
  // Checked first: it can come as a 400 or a 403, and is not about the key.
  if (/location is not supported|not available in your (country|region)/i.test(msg)) return new GeminiError('region', msg, status);
  if (status === 400 && /api key|API_KEY_INVALID/i.test(msg + reason)) return new GeminiError('bad-key', msg, status);
  if (status === 401 || status === 403) {
    // SCENEVOICE_DEVICE_UNKNOWN: the relay no longer knows this device token (Start free issues a new one).
    if (/api key|permission|PERMISSION_DENIED|API_KEY|SCENEVOICE_DEVICE_UNKNOWN/i.test(msg + reason)) return new GeminiError('bad-key', msg, status);
    return new GeminiError('forbidden', msg, status);
  }
  if (status === 404) return new GeminiError('model-not-found', msg, status);
  if (status === 429) {
    if (DAILY_QUOTA.test(`${msg} ${reason}`)) return new GeminiError('quota-daily', msg, status);
    const err = new GeminiError('rate-limited', msg, status);
    err.retryAfterMs = retryDelayMs(details);
    return err;
  }
  if (status === 400 && /(video|youtube|file|uri|private|unavailable|not supported)/i.test(msg)) {
    return new GeminiError('video-unsupported', msg, status);
  }
  if (status === 400 && /(token|too long|exceeds)/i.test(msg)) return new GeminiError('too-long', msg, status);
  // 504 DEADLINE_EXCEEDED and 408 are a section that did not finish, not a
  // broken key and not a generic outage. generation.js splits that section.
  if (status === 504 || status === 408 || (status >= 500 && /deadline|timed out|\btimeout\b/i.test(msg))) return new GeminiError('timeout', msg, status);
  if (status >= 500) return new GeminiError('server', msg, status);
  return new GeminiError('request-failed', msg || `HTTP ${status}`, status);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new GeminiError('aborted'));
    });
  });

/** Longest wait a RetryInfo is followed for: anything longer is as good as a failure to the listener. */
const MAX_RETRY_WAIT_MS = 90000;

/** How long to wait before attempt n (1-based) after a retryable error. */
export function retryWait(err, attempt) {
  if (err.code === 'rate-limited') {
    if (Number.isFinite(err.retryAfterMs)) return Math.min(MAX_RETRY_WAIT_MS, Math.max(1000, err.retryAfterMs));
    return 6000 * 2 ** (attempt - 1);
  }
  return 2000 * 2 ** (attempt - 1);
}

export class GeminiClient {
  /**
   * @param {object} o
   * @param {boolean} [o.stream]  ask for the answer as it is written (streamGenerateContent, server-sent
   *   events). On by default for Google's own address; off for a relay or a custom address, which may not
   *   pass a stream through (the SceneVoice Cloud relay meters whole answers).
   */
  constructor({ apiKey, apiBase, model, fetchImpl, stream }) {
    this.apiKey = apiKey;
    this.apiBase = (apiBase || '').replace(/\/+$/, '');
    this.model = model;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.stream = typeof stream === 'boolean' ? stream : this.apiBase === DEFAULT_API_BASE;
  }

  async listModels(signal) {
    const all = [];
    let pageToken = '';
    for (let i = 0; i < 5; i += 1) {
      const url = `${this.apiBase}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await this.request(url, { method: 'GET' }, signal, { timeoutMs: GEMINI_LIST_TIMEOUT_MS });
      all.push(...(res.models || []));
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return all;
  }

  /**
   * generateContent with retries. Overloaded servers (503), the minute's rate
   * limit (429) and network failures are retried with exponential backoff:
   * 2, 4, 8 s for server and network errors, 6, 12, 24 s for rate limits, or
   * the wait the server itself asks for (RetryInfo) when it gives one. A used-up
   * daily quota, or a used-up Cloud allowance, is not retried: it will not
   * come back within the minute. A deadline the server already reported (504)
   * is tried once more; a call that hits SceneVoice's own deadline is not sent
   * again unchanged (generation.js splits that section instead).
   */
  async generate(body, signal, { retries = 3, timeoutMs = GEMINI_REQUEST_TIMEOUT_MS, firstAnswerMs = 0, onText } = {}) {
    if (!this.model) throw new GeminiError('no-model');
    const model = encodeURIComponent(this.model);
    const url = this.stream
      ? `${this.apiBase}/v1beta/models/${model}:streamGenerateContent?alt=sse`
      : `${this.apiBase}/v1beta/models/${model}:generateContent`;
    let attempt = 0;
    let payload = body;
    for (;;) {
      try {
        const init = { method: 'POST', body: JSON.stringify(payload) };
        if (this.stream) return await this.requestStream(url, init, signal, { timeoutMs, firstAnswerMs, onText });
        return await this.request(url, init, signal, { timeoutMs });
      } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        // A model that does not accept thinking settings rejects the whole request: drop them and retry.
        if (err.code === 'request-failed' && err.status === 400 && payload.generationConfig?.thinkingConfig && /thinking|unknown name|invalid json payload/i.test(err.detail)) {
          const { thinkingConfig, ...rest } = payload.generationConfig;
          payload = { ...payload, generationConfig: rest };
          continue;
        }
        // Our own deadline means this payload is too slow to finish as it is.
        const retryable = ['server', 'rate-limited', 'network'].includes(err.code) || (err.code === 'timeout' && !err.clientDeadline);
        // A server deadline, or a model that says it is overloaded (503, which Google
        // can take over a minute to answer), is tried once more at most: generation.js
        // then moves to another model, instead of waiting through three more such answers.
        const limit = err.code === 'timeout' || (err.code === 'server' && err.status === 503) ? Math.min(1, retries) : retries;
        if (!retryable || attempt >= limit) throw err;
        attempt += 1;
        await sleep(retryWait(err, attempt), signal);
      }
    }
  }

  /**
   * A streamed generateContent: server-sent events, each a piece of the
   * answer. Resolves to one response shaped like generateContent's (the text
   * of every piece joined, the last finishReason and usageMetadata), so the
   * parsers do not care how it came. `onText(textSoFar)` is called as pieces
   * arrive. `timeoutMs` is the longest silence allowed once the answer has
   * begun; `firstAnswerMs` (when set) the longest wait for its first piece, after
   * which the error says no answer began (`noAnswer`: an overloaded model, not
   * a section too long). A reply that is not a stream (a test, a proxy) is read
   * as plain JSON.
   */
  async requestStream(url, init, signal, { timeoutMs = 0, firstAnswerMs = 0, onText } = {}) {
    if (!this.apiKey) throw new GeminiError('no-key');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    let began = false;
    let timer = null;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = ms > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, ms)
        : null;
    };
    arm(firstAnswerMs > 0 ? firstAnswerMs : timeoutMs);
    const deadline = (err) => {
      const timeout = new GeminiError('timeout', String(err?.message || err || 'timeout'));
      timeout.clientDeadline = true;
      if (!began) timeout.noAnswer = true;
      return timeout;
    };
    try {
      let res;
      try {
        res = await this.fetch(url, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey } });
      } catch (err) {
        if (signal?.aborted) throw new GeminiError('aborted');
        if (timedOut || err?.name === 'TimeoutError') throw deadline(err);
        throw new GeminiError('network', String(err?.message || err));
      }
      const type = String(res.headers?.get?.('content-type') || '');
      const reader = /event-stream/i.test(type) && res.ok ? res.body?.getReader?.() : null;
      if (!reader) {
        // Not a stream: an error body, or a whole answer (or an array of pieces) at once.
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (!res.ok) throw classifyHttp(res.status, Array.isArray(body) ? body[0] : body);
        const merged = mergeStreamed(Array.isArray(body) ? body : [body || {}]);
        onText?.(streamedText(merged));
        return merged;
      }
      const decoder = new TextDecoder();
      const pieces = [];
      let buffer = '';
      let text = '';
      // The piece with a finish reason is the last: stop there even if the connection stays open.
      let finished = false;
      while (!finished) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal?.aborted) throw new GeminiError('aborted');
          if (timedOut) throw deadline(err);
          throw new GeminiError('network', String(err?.message || err));
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop();
        for (const event of events) {
          const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let piece;
          try {
            piece = JSON.parse(data);
          } catch {
            continue;
          }
          if (piece?.error) throw classifyHttp(Number(piece.error.code) || 500, piece);
          began = true;
          arm(timeoutMs);
          pieces.push(piece);
          const more = streamedText(mergeStreamed([piece]));
          if (more) {
            text += more;
            onText?.(text);
          }
          if (piece?.candidates?.[0]?.finishReason) finished = true;
        }
      }
      if (finished) reader.cancel().catch(() => {});
      return mergeStreamed(pieces);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async request(url, init, signal, { timeoutMs = 0 } = {}) {
    if (!this.apiKey) throw new GeminiError('no-key');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
    let res;
    try {
      res = await this.fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      });
    } catch (err) {
      if (signal?.aborted) throw new GeminiError('aborted');
      if (timedOut || err?.name === 'TimeoutError') {
        const timeout = new GeminiError('timeout', String(err?.message || err));
        timeout.clientDeadline = true;
        throw timeout;
      }
      throw new GeminiError('network', String(err?.message || err));
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw classifyHttp(res.status, body);
    return body || {};
  }
}

/**
 * Pieces of a streamed answer as one generateContent response: the text of
 * every piece joined (thoughts left out), the last finish reason, the last
 * usage (Gemini sends running totals) and any prompt feedback.
 */
export function mergeStreamed(pieces) {
  let text = '';
  let finishReason = '';
  let usageMetadata;
  let promptFeedback;
  let any = false;
  for (const p of pieces || []) {
    if (p?.promptFeedback) promptFeedback = p.promptFeedback;
    if (p?.usageMetadata) usageMetadata = p.usageMetadata;
    const cand = p?.candidates?.[0];
    if (!cand) continue;
    any = true;
    for (const part of cand.content?.parts || []) if (typeof part.text === 'string' && !part.thought) text += part.text;
    if (cand.finishReason) finishReason = cand.finishReason;
  }
  const out = {};
  if (any) out.candidates = [{ content: { role: 'model', parts: text ? [{ text }] : [] }, ...(finishReason ? { finishReason } : {}) }];
  if (usageMetadata) out.usageMetadata = usageMetadata;
  if (promptFeedback) out.promptFeedback = promptFeedback;
  return out;
}

const streamedText = (body) => (body?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');

/** What one reply cost, from its usageMetadata (zeros when the server sent none): see usage.js. */
export function usageOf(body) {
  const u = body?.usageMetadata || {};
  return countedUsage({ input: u.promptTokenCount, output: u.candidatesTokenCount, thinking: u.thoughtsTokenCount });
}

/** Text of the first candidate, with a clear error for blocked or empty output. */
export function responseText(body) {
  const block = body?.promptFeedback?.blockReason;
  if (block) throw new GeminiError('blocked', block);
  const cand = body?.candidates?.[0];
  if (!cand) throw new GeminiError('empty-response');
  const text = (cand.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!text) {
    if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') throw new GeminiError('blocked', cand.finishReason);
    if (cand.finishReason === 'MAX_TOKENS') throw new GeminiError('truncated');
    throw new GeminiError('empty-response', cand.finishReason || '');
  }
  return { text, finishReason: cand.finishReason || '' };
}

export function parseScriptResponse(body) {
  const { text, finishReason } = responseText(body);
  try {
    return extractJson(text);
  } catch {
    if (finishReason === 'MAX_TOKENS') throw new GeminiError('truncated');
    throw new GeminiError('bad-json');
  }
}
