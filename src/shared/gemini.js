// Gemini API client. Request builders are pure functions so they can be tested;
// network calls take an injectable fetch.

import { LANGUAGE_NAMES_EN } from './constants.js';
import { extractJson, formatTime } from './script.js';

export class GeminiError extends Error {
  /** @param {string} code  stable code mapped to a localized message */
  constructor(code, detail = '', status = 0) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
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
    cues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'NUMBER' },
          gap: { type: 'NUMBER' },
          kind: { type: 'STRING', enum: ['visual', 'text'] },
          priority: { type: 'INTEGER' },
          brief: { type: 'STRING' },
          standard: { type: 'STRING' },
          detailed: { type: 'STRING' },
        },
        required: ['start', 'gap', 'kind', 'priority', 'brief', 'standard', 'detailed'],
        propertyOrdering: ['start', 'gap', 'kind', 'priority', 'brief', 'standard', 'detailed'],
      },
    },
  },
  required: ['characters', 'cues'],
  propertyOrdering: ['characters', 'cues'],
};

export function languageName(code) {
  return LANGUAGE_NAMES_EN[code] || code;
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
 * dialogue, and never interpret.
 */
export function scriptInstructions(lang) {
  const language = languageName(lang);
  return [
    'You are a professional audio describer writing audio description (AD) for blind and low-vision viewers.',
    `Write every description in ${language}.`,
    '',
    'Always describe (these come first when time is short):',
    '- Every change of place or time: start that description with where we are now (and when, if it changed).',
    '- Every person the first time they appear: a short visual sketch (apparent age, build, hair, clothing) and what they are doing. On later appearances, just the label.',
    '- Who is speaking or being spoken to, whenever that is not obvious from the audio alone (for example in a group, a video call, or when someone speaks off screen).',
    '- Actions and their results: what someone does, picks up, hands over, points at, and what happens next. Follow the action step by step in demonstrations, tutorials, cooking, sport and gameplay.',
    '- Expressions and gestures that carry meaning (a nod, a smile, a shaking head, a look away).',
    '- Important objects, products, charts, diagrams and what they show.',
    '- Any meaningful on-screen text (see below).',
    '',
    'Also describe, when there is room: setting details, clothing, lighting and weather, camera moves that matter (a close-up on an object, a drone shot of a landscape), montages (summarise), and the mood the picture creates.',
    '',
    'Rules:',
    '- Describe only what can be seen. Never describe what can be heard (dialogue, music, sound effects) and never repeat what a speaker is saying.',
    '- Present tense, active voice, plain and specific words. Describe; do not interpret ("she frowns", not "she is angry"; "he is looking at the floor", not "he is embarrassed").',
    '- Do not give away what happens later, and do not add facts you cannot see.',
    '- If you are not sure what something is, say "appears to" rather than guessing. Never invent names, numbers or text.',
    '- Do not censor: describe what is shown.',
    '',
    'People:',
    '- Use a name only if it is established by the title, the description, on-screen text or dialogue. Otherwise use a short, consistent visual label (for example "the woman in the red coat") and keep using it.',
    '- Keep labels consistent with the provided character list. Add new people to "characters" with a one-line description.',
    '',
    'On-screen text (kind "text"):',
    '- Read meaningful text that appears on screen: titles, captions or subtitles burned into the picture, signs, labels, slides, chat or phone screens, product names, scores, prices.',
    `- Quote it as written. If it is not in ${language}, give the original followed by a short translation.`,
    '- Skip channel watermarks, subscribe buttons, platform interface and text that only repeats what is being said.',
    '',
    'How much:',
    '- Aim for a description every 10 to 20 seconds while the picture is changing, and never leave more than 30 seconds undescribed unless the picture is static and has already been described. A five-minute section of a typical video has 15 to 40 descriptions; a fast demonstration or an action scene can have more, a static talking head fewer.',
    '- Descriptions may be as close as 2 seconds apart when the picture changes quickly.',
    '- Each description says one thing. Do not pad: the viewer hears the video first and the description second.',
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
    '',
    'Priority:',
    '- 1 = needed to follow what happens: scene changes, who is present, the main action and its result, on-screen text that matters, who is speaking.',
    '- 2 = helpful: secondary actions, expressions and gestures, objects, appearance details on first sight.',
    '- 3 = atmosphere: decor, lighting, scenery, minor background activity.',
    '',
    'Output JSON only, matching the schema. If truly nothing visual happens in this section, return an empty "cues" list.',
  ].join('\n');
}

export function scriptPrompt({ meta = {}, chunk, duration, characters = [], lang }) {
  const lines = [
    `Video title: ${clip(meta.title, 200) || 'unknown'}`,
    meta.channel ? `Channel: ${clip(meta.channel, 100)}` : '',
    meta.description ? `Video description (from the uploader): ${clip(meta.description, 1500)}` : '',
    Number.isFinite(duration) ? `Full video length: ${formatTime(duration)} (${Math.round(duration)} seconds).` : '',
    `Describe only the section from ${formatTime(chunk.start)} to ${formatTime(chunk.end)} (${chunk.start}s to ${chunk.end}s). Timestamps must be seconds from the start of the full video.`,
    characters.length
      ? `People already introduced earlier in the video (reuse these labels): ${characters.map((c) => `${c.label}${c.description ? ` (${c.description})` : ''}`).join('; ')}`
      : '',
    `Write in ${languageName(lang)}.`,
  ];
  return lines.filter(Boolean).join('\n');
}


/** Older models cap output at 8k tokens; newer ones allow far more (thinking counts against it). */
export function outputLimit(model = '') {
  return /^gemini-(1\.|2\.0)/.test(model) ? 8192 : 32768;
}

export function buildScriptRequest({ videoId, meta, chunk, duration, characters, lang, model }) {
  const isWhole = chunk.start <= 0 && Number.isFinite(duration) && chunk.end >= duration - 1;
  const videoPart = { fileData: { fileUri: youtubeUrl(videoId) } };
  if (!isWhole) {
    videoPart.videoMetadata = { startOffset: `${chunk.start}s`, endOffset: `${chunk.end}s` };
  }
  return {
    systemInstruction: { parts: [{ text: scriptInstructions(lang) }] },
    contents: [
      {
        role: 'user',
        parts: [videoPart, { text: scriptPrompt({ meta, chunk, duration, characters, lang }) }],
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

export function buildAskRequest({ videoId, meta, time, duration, question, nearbyText, lang, model }) {
  const start = Math.max(0, Math.floor(time - 20));
  const end = Math.min(Number.isFinite(duration) ? Math.ceil(duration) : Math.ceil(time + 5), Math.ceil(time + 4));
  return {
    systemInstruction: {
      parts: [
        {
          text: [
            'You help a blind or low-vision person understand a video they are watching.',
            `Answer in ${languageName(lang)}, in at most 3 short sentences, plain text without markdown.`,
            'Answer about what is visible at the moment they asked, using the clip and context provided.',
            'If you cannot tell, say so honestly. Never invent details.',
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
            videoMetadata: { startOffset: `${start}s`, endOffset: `${Math.max(end, start + 2)}s` },
          },
          {
            text: [
              `Video title: ${clip(meta?.title, 200) || 'unknown'}`,
              `The viewer paused at ${formatTime(time)} (${Math.round(time)} seconds). The clip covers ${start}s to ${end}s of the video.`,
              nearbyText ? `Recent audio descriptions: ${clip(nearbyText, 800)}` : '',
              `Question: ${clip(question, 500)}`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      },
    ],
    generationConfig: { ...tuningFor(model, 0.3), maxOutputTokens: 2048 },
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

/** Pick a good default model from the list the key can use. */
export function chooseModel(models) {
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
  usable.sort((a, b) => score(b) - score(a));
  return usable[0] || '';
}

export function usableModels(models) {
  const ids = new Set(textModelIds(models));
  return (models || [])
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => ids.has(m.id));
}

function classifyHttp(status, body) {
  const msg = body?.error?.message || '';
  const reason = JSON.stringify(body?.error?.details || '');
  if (status === 400 && /api key|API_KEY_INVALID/i.test(msg + reason)) return new GeminiError('bad-key', msg, status);
  if (status === 401 || status === 403) {
    if (/api key|permission|PERMISSION_DENIED|API_KEY/i.test(msg + reason)) return new GeminiError('bad-key', msg, status);
    return new GeminiError('forbidden', msg, status);
  }
  if (status === 404) return new GeminiError('model-not-found', msg, status);
  if (/location is not supported|not available in your (country|region)/i.test(msg)) return new GeminiError('forbidden', msg, status);
  if (status === 429) return new GeminiError('quota', msg, status);
  if (status === 400 && /(video|youtube|file|uri|private|unavailable|not supported)/i.test(msg)) {
    return new GeminiError('video-unsupported', msg, status);
  }
  if (status === 400 && /(token|too long|exceeds)/i.test(msg)) return new GeminiError('too-long', msg, status);
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

export class GeminiClient {
  constructor({ apiKey, apiBase, model, fetchImpl }) {
    this.apiKey = apiKey;
    this.apiBase = (apiBase || '').replace(/\/+$/, '');
    this.model = model;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  async listModels(signal) {
    const all = [];
    let pageToken = '';
    for (let i = 0; i < 5; i += 1) {
      const url = `${this.apiBase}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await this.request(url, { method: 'GET' }, signal);
      all.push(...(res.models || []));
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return all;
  }

  /**
   * generateContent with retries. Overloaded servers (503), rate limits (429) and
   * network failures are retried with exponential backoff: 2, 4, 8 s for server
   * and network errors, 6, 12, 24 s for rate limits.
   */
  async generate(body, signal, { retries = 3 } = {}) {
    if (!this.model) throw new GeminiError('no-model');
    const url = `${this.apiBase}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    let attempt = 0;
    let payload = body;
    for (;;) {
      try {
        return await this.request(url, { method: 'POST', body: JSON.stringify(payload) }, signal);
      } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        // A model that does not accept thinking settings rejects the whole request: drop them and retry.
        if (err.code === 'request-failed' && err.status === 400 && payload.generationConfig?.thinkingConfig && /thinking|unknown name|invalid json payload/i.test(err.detail)) {
          const { thinkingConfig, ...rest } = payload.generationConfig;
          payload = { ...payload, generationConfig: rest };
          continue;
        }
        const retryable = ['server', 'quota', 'network'].includes(err.code);
        if (!retryable || attempt >= retries) throw err;
        attempt += 1;
        await sleep((err.code === 'quota' ? 6000 : 2000) * 2 ** (attempt - 1), signal);
      }
    }
  }

  async request(url, init, signal) {
    if (!this.apiKey) throw new GeminiError('no-key');
    let res;
    try {
      res = await this.fetch(url, {
        ...init,
        signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      });
    } catch (err) {
      if (signal?.aborted) throw new GeminiError('aborted');
      throw new GeminiError('network', String(err?.message || err));
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
