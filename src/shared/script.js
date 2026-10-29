// Pure helpers for description scripts: parsing model output, merging chunks,
// estimating speech time and choosing which text to speak.
// No browser APIs here, so everything is unit-testable.

import { SCRIPT_VERSION } from './constants.js';

/** Highest priority number spoken for each density setting. */
export const DENSITY_MAX_PRIORITY = Object.freeze({ essential: 1, standard: 2, full: 3 });

export function passesDensity(cue, density) {
  return cue.priority <= (DENSITY_MAX_PRIORITY[density] || 3);
}

export const DETAIL_ORDER = Object.freeze({
  brief: ['brief'],
  standard: ['standard', 'brief'],
  detailed: ['detailed', 'standard', 'brief'],
});

const MAX_LEN = { brief: 160, standard: 360, detailed: 800 };

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

/** Remove markdown, wrapping quotes and stray whitespace from model text. */
export function cleanText(text, maxLen = 700) {
  if (typeof text !== 'string') return '';
  let t = text
    .replace(/\*\*|__|`+/g, '')
    .replace(/^[#>\-*\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('? '));
    t = stop > maxLen * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd() + '…';
  }
  return t;
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
 * @param {{duration?: number, chunkStart?: number, chunkEnd?: number}} ctx
 * @returns {{cues: Array, characters: Array}}
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
    let brief = cleanText(item.brief, MAX_LEN.brief);
    let standard = cleanText(item.standard ?? item.text, MAX_LEN.standard);
    let detailed = cleanText(item.detailed, MAX_LEN.detailed);
    if (!standard) standard = detailed || brief;
    if (!brief) brief = standard;
    if (!detailed) detailed = standard;
    if (!standard) continue;
    let gap = parseTime(item.gap ?? item.silence ?? item.maxSeconds);
    if (!Number.isFinite(gap) || gap < 0) gap = 2;
    gap = Math.min(gap, 60);
    let priority = parseInt(item.priority, 10);
    if (![1, 2, 3].includes(priority)) priority = 2;
    cues.push({ start, gap, kind, priority, brief, standard, detailed });
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
  return { cues, characters };
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

/** Merge a new chunk into an existing script. */
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
    completedUntil: Math.max(script.completedUntil || 0, untilSeconds || 0),
    updatedAt: Date.now(),
  };
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

/**
 * Decide what to say for a cue.
 * @returns {{text: string, needsPause: boolean} | null} null = skip this cue
 */
export function chooseUtterance(cue, { mode, detail, rate, onScreenText, playbackRate = 1 }) {
  if (!cue) return null;
  if (cue.kind === 'text' && !onScreenText) return null;
  const order = DETAIL_ORDER[detail] || DETAIL_ORDER.standard;
  // The gap is measured in video seconds; at 2x it passes twice as fast.
  const room = cue.gap / Math.max(0.25, playbackRate || 1) + 0.5;

  if (mode === 'gaps') {
    for (const key of order) {
      const text = cue[key];
      if (text && estimateSeconds(text, rate) <= room) return { text, needsPause: false };
    }
    // Nothing fits. Say the shortest version of important cues anyway; drop the rest.
    if (cue.priority <= 2) return { text: cue.brief || cue.standard, needsPause: false };
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
