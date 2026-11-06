// Pure helpers for description scripts: parsing model output, merging chunks,
// estimating speech time and choosing which text to speak.
// No browser APIs here, so everything is unit-testable.

import { HEDGE_WORDS, SCRIPT_VERSION, UNCERTAIN_LEAD, VIDEO_TYPES } from './constants.js';

/** Highest priority number spoken for each density setting. */
export const DENSITY_MAX_PRIORITY = Object.freeze({ essential: 1, standard: 2, full: 3 });

/**
 * Whether a cue is spoken at this density. On-screen text is what listeners
 * least want to miss (a picture can often be followed from the sound, text
 * never), so it gets one level more: "essential" still reads helpful text.
 */
export function passesDensity(cue, density) {
  const max = DENSITY_MAX_PRIORITY[density] || 3;
  return cue.priority <= (cue.kind === 'text' ? max + 1 : max);
}

export const DETAIL_ORDER = Object.freeze({
  brief: ['brief'],
  standard: ['standard', 'brief'],
  detailed: ['detailed', 'standard', 'brief'],
});

/** Hard limits in characters: on-screen text, quoted word for word, may run long. */
const MAX_LEN = { brief: 160, standard: 360, detailed: 800 };
/**
 * Limits for a visual description, about 1.5 times what the model is asked for
 * (gemini.js: brief 8 words / 15 CJK characters, standard 22 / 40, detailed
 * 50 / 90), so a description that runs long is cut at a sentence end rather than
 * read in full over the video. CJK text counts characters, other text characters
 * of about 6.5 per word.
 */
const VISUAL_LEN = {
  cjk: { brief: 25, standard: 60, detailed: 135 },
  other: { brief: 80, standard: 215, detailed: 490 },
};
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;

/** The length limit for one version of a description. */
function maxLength(text, version, kind) {
  if (kind === 'text') return MAX_LEN[version];
  const s = String(text || '');
  const cjk = (s.match(CJK_CHAR) || []).length;
  return cjk > s.length / 3 ? VISUAL_LEN.cjk[version] : VISUAL_LEN.other[version];
}
/** A transcription of on-screen text: a slide or a code block, but not a page of it. */
const MAX_SCREEN_TEXT = 600;

/**
 * Parse a timestamp the model may return as seconds, "m:ss", "h:mm:ss",
 * "75s" or "1m15s". Returns NaN when it cannot be parsed.
 */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const s = value.trim().toLowerCase();
  if (!s) return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  if (/^\d+(\.\d+)?s$/.test(s)) return parseFloat(s);
  const hms = s.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return (+(hms[1] || 0)) * 3600 + (+(hms[2] || 0)) * 60 + (+(hms[3] || 0));
  }
  const parts = s.split(':');
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }
  return NaN;
}

/**
 * Remove markdown, wrapping quotes and stray whitespace from model text.
 * keepSymbols: the text quotes the screen, where "__init__", "#1" or "-5 °C"
 * mean something; only bold markers and backticks are removed.
 */
export function cleanText(text, maxLen = 700, { keepSymbols = false } = {}) {
  if (typeof text !== 'string') return '';
  let t = keepSymbols
    ? text.replace(/\*\*|`+/g, '')
    : text.replace(/\*\*|__|`+/g, '').replace(/^[#>\-*\s]+/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('? '));
    // A whole first sentence or two beats a sentence broken off: keep them if they say a fair part of it.
    t = stop > maxLen * 0.35 ? cut.slice(0, stop + 1) : `${cut.slice(0, maxLen - 1).trimEnd()}…`;
  }
  return t;
}

/**
 * On-screen text as transcribed: exactly as written, quotes and symbols
 * included. Line breaks become " / " so lists, menus and addresses keep their shape.
 */
export function cleanScreenText(text, maxLen = MAX_SCREEN_TEXT) {
  if (typeof text !== 'string') return '';
  const t = text
    .split(/\s*\n\s*/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ');
  return t.length > maxLen ? `${t.slice(0, maxLen).trimEnd()}…` : t;
}

/** How sure Gemini is of a description. Scripts saved before it said have none. */
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);

/** Whether a text already says it is not certain ("appears to", "可能", "看不清"…), in the description language. */
export function isHedged(text, lang) {
  const s = String(text || '').toLowerCase();
  return (HEDGE_WORDS[lang] || HEDGE_WORDS.en).some((w) => s.includes(w));
}

/** The text, led by "Not certain." in the description language unless it already says so. */
export function hedged(text, lang) {
  if (!text || isHedged(text, lang)) return text;
  return `${UNCERTAIN_LEAD[lang] || UNCERTAIN_LEAD.en}${text}`;
}

/**
 * A description Gemini is not sure of is said to be uncertain in every length,
 * and counts one step less important: it is heard less often and never wins
 * over a description that is sure.
 */
export function applyConfidence(cue, lang) {
  if (cue.confidence !== 'low') return cue;
  return {
    ...cue,
    priority: Math.min(3, cue.priority + 1),
    brief: hedged(cue.brief, lang),
    standard: hedged(cue.standard, lang),
    detailed: hedged(cue.detailed, lang),
  };
}

/** Extract a JSON object from model text that may be wrapped in a code fence. */
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  if (typeof text !== 'string') throw new Error('empty-response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('bad-json');
  }
}

/**
 * Validate and normalise one chunk of model output.
 * @param {object} raw  parsed JSON from the model
 * @param {{duration?: number, chunkStart?: number, chunkEnd?: number, lang?: string}} ctx
 *   lang: the description language, for saying a low-confidence description is uncertain
 * @returns {{cues: Array, characters: Array, videoType: string}}
 *   videoType: 'entertainment' | 'tutorial', or '' when the model gave neither
 */
export function normalizeChunk(raw, ctx = {}) {
  const duration = Number.isFinite(ctx.duration) && ctx.duration > 0 ? ctx.duration : Infinity;
  const chunkStart = ctx.chunkStart || 0;
  const chunkEnd = Number.isFinite(ctx.chunkEnd) ? ctx.chunkEnd : duration;
  const list = Array.isArray(raw?.cues) ? raw.cues : Array.isArray(raw) ? raw : [];

  let cues = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const start = parseTime(item.start ?? item.time ?? item.timestamp);
    if (!Number.isFinite(start) || start < 0) continue;
    const kind = item.kind === 'text' ? 'text' : 'visual';
    const opts = { keepSymbols: kind === 'text' };
    // Only text cues carry a transcription; a visual cue's would be a stray.
    const onScreenText = kind === 'text' ? cleanScreenText(item.onScreenText) : '';
    const sized = (text, version) => cleanText(text, maxLength(text, version, kind), opts);
    let brief = sized(item.brief, 'brief');
    let standard = sized(item.standard ?? item.text, 'standard');
    let detailed = sized(item.detailed, 'detailed');
    if (!standard) standard = detailed || brief || cleanText(onScreenText, MAX_LEN.standard, opts);
    if (!brief) brief = standard;
    if (!detailed) detailed = standard;
    if (!standard) continue;
    let gap = parseTime(item.gap ?? item.silence ?? item.maxSeconds);
    if (!Number.isFinite(gap) || gap < 0) gap = 2;
    gap = Math.min(gap, 60);
    let priority = parseInt(item.priority, 10);
    if (![1, 2, 3].includes(priority)) priority = 2;
    const cue = { start, gap, kind, priority, brief, standard, detailed };
    if (onScreenText) cue.onScreenText = onScreenText;
    if (CONFIDENCES.includes(item.confidence)) cue.confidence = item.confidence;
    cues.push(applyConfidence(cue, ctx.lang));
  }

  // Timestamps are occasionally returned in milliseconds.
  if (cues.length && Number.isFinite(duration)) {
    const maxStart = Math.max(...cues.map((c) => c.start));
    if (maxStart > duration * 20 && maxStart / 1000 <= duration + 5) {
      cues = cues.map((c) => ({ ...c, start: c.start / 1000, gap: c.gap > 60 ? c.gap / 1000 : c.gap }));
    }
  }

  // Timestamps for a later chunk are sometimes relative to the clip.
  if (chunkStart > 0 && cues.length) {
    const maxStart = Math.max(...cues.map((c) => c.start));
    const clipLen = chunkEnd - chunkStart;
    if (maxStart < chunkStart - 5 && maxStart <= clipLen + 5) {
      cues = cues.map((c) => ({ ...c, start: c.start + chunkStart }));
    }
  }

  cues = cues
    .filter((c) => c.start <= duration + 1 && c.start >= chunkStart - 2 && c.start <= chunkEnd + 2)
    .map((c) => ({ ...c, start: Math.round(Math.min(c.start, duration) * 10) / 10 }))
    .sort((a, b) => a.start - b.start);

  cues = dedupeCues(cues);

  const characters = [];
  const seen = new Set();
  for (const ch of Array.isArray(raw?.characters) ? raw.characters : []) {
    const label = cleanText(ch?.label ?? ch?.name, 80);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    characters.push({ label, description: cleanText(ch?.description, 200) });
  }
  const videoType = VIDEO_TYPES.includes(raw?.videoType) ? raw.videoType : '';
  return { cues, characters, videoType };
}

/** Collapse cues of the same kind that start within 1 second of each other. */
export function dedupeCues(sorted) {
  const out = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === c.kind && c.start - prev.start < 1) {
      if (c.priority < prev.priority) out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Merge a new chunk into an existing script. The first section that names a video type decides it. */
export function mergeScript(script, chunk, untilSeconds) {
  const cues = dedupeCues([...(script.cues || []), ...chunk.cues].sort((a, b) => a.start - b.start));
  const characters = [...(script.characters || [])];
  const seen = new Set(characters.map((c) => c.label.toLowerCase()));
  for (const ch of chunk.characters) {
    if (!seen.has(ch.label.toLowerCase())) {
      seen.add(ch.label.toLowerCase());
      characters.push(ch);
    }
  }
  return {
    ...script,
    version: SCRIPT_VERSION,
    cues,
    characters,
    videoType: script.videoType || chunk.videoType || '',
    completedUntil: Math.max(script.completedUntil || 0, untilSeconds || 0),
    updatedAt: Date.now(),
  };
}

/**
 * The cue objects already complete in a script answer that is still being
 * written ({"videoType": …, "characters": […], "cues": [{…}, {…}, {… ): every
 * object of the "cues" array whose closing brace has arrived, parsed. The
 * unfinished one at the end, and anything that does not parse, is left out.
 */
export function streamedCues(text) {
  const s = String(text || '');
  const key = s.search(/"cues"\s*:\s*\[/);
  if (key < 0) return [];
  const out = [];
  let i = s.indexOf('[', key) + 1;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const cue = JSON.parse(s.slice(start, i + 1));
          if (cue && typeof cue === 'object') out.push(cue);
        } catch {
          /* not a whole object after all */
        }
        start = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return out;
}

/** Split a video into request chunks. The last short remainder joins the previous chunk. */
export function planChunks(duration, chunkSeconds, from = 0) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('bad-duration');
  const chunks = [];
  let start = Math.max(0, from);
  while (start < duration - 0.5) {
    let end = Math.min(duration, start + chunkSeconds);
    if (duration - end < 60) end = duration;
    chunks.push({ start: Math.floor(start), end: Math.ceil(end) });
    start = end;
  }
  return chunks;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;

/**
 * Rough seconds needed to speak a text.
 * @param {string} text
 * @param {number} rate  1 = a typical default speaking rate
 */
export function estimateSeconds(text, rate = 1) {
  if (!text) return 0;
  const r = Math.max(0.3, rate || 1);
  const cjk = (text.match(CJK) || []).length;
  const rest = text.replace(CJK, ' ');
  const words = rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return cjk / (4.5 * r) + words / (2.8 * r) + 0.25;
}

/** Seconds kept back from a pause the model estimated (see chooseUtterance). */
export const ESTIMATE_MARGIN = 0.5;

/**
 * Decide what to say for a cue.
 * @returns {{text: string, needsPause: boolean} | null} null = skip this cue
 */
export function chooseUtterance(cue, { mode, detail, rate, onScreenText, playbackRate = 1 }) {
  if (!cue) return null;
  if (cue.kind === 'text' && !onScreenText) return null;
  const order = DETAIL_ORDER[detail] || DETAIL_ORDER.standard;
  // The gap is in video seconds; at 2x it passes twice as fast. A gap measured
  // from captions is taken as it is. The model's own estimate runs optimistic
  // (it places the pause by ear and rounds up), so half a second is kept back:
  // a description that runs over the estimate covers the next line of dialogue.
  // A gap of 0 (frames mode: the model could not tell whether anyone speaks)
  // leaves no room at all: skipped here, or paused for in 'pause' mode.
  const room = Math.max(0, cue.gap / Math.max(0.25, playbackRate || 1) - (cue.gapMeasured ? 0 : ESTIMATE_MARGIN));

  if (mode === 'gaps') {
    for (const key of order) {
      const text = cue[key];
      if (text && estimateSeconds(text, rate) <= room) return { text, needsPause: false };
    }
    // Nothing fits: skip it rather than talk over dialogue, however important.
    return null;
  }

  const text = order.map((k) => cue[k]).find(Boolean);
  if (!text) return null;
  if (mode === 'pause') return { text, needsPause: estimateSeconds(text, rate) > room };
  return { text, needsPause: false };
}

/** The cue that describes what is on screen at time t (for "describe now"). */
export function cueAt(cues, t) {
  let found = null;
  for (const c of cues) {
    if (c.start <= t + 0.5) found = c;
    else break;
  }
  return found;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
