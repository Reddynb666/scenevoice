// Real dialogue timing from YouTube captions or Bilibili CC subtitles, used to
// correct the pauses the model estimated, so descriptions do not talk over speech.
// No browser APIs here, so everything is unit-testable.

/** Seconds a word-timed (auto-generated) caption line is assumed to run past its last word. */
const WORD_TAIL = 1;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? parseFloat(m[1]) : NaN;
}

/**
 * Parse a YouTube timedtext response (json3, srv3 XML or the older srv1 XML),
 * or a Bilibili subtitle file (BCC JSON: {"body": [{"from", "to", "content"}]}).
 * @returns {Array<{start: number, end: number, text: string}>} seconds, sorted by start
 */
export function parseTimedText(body) {
  const src = typeof body === 'string' ? body.trim() : '';
  const lines = [];
  if (!src) return lines;

  if (src.startsWith('{')) {
    let json;
    try {
      json = JSON.parse(src);
    } catch {
      return lines;
    }
    // Bilibili: times in seconds, one line per entry.
    for (const item of Array.isArray(json?.body) ? json.body : []) {
      const start = Number(item?.from);
      const end = Number(item?.to);
      const text = typeof item?.content === 'string' ? item.content.trim() : '';
      if (text && Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0) lines.push({ start, end, text });
    }
    for (const ev of Array.isArray(json?.events) ? json.events : []) {
      if (!Array.isArray(ev?.segs)) continue;
      const text = ev.segs.map((s) => s?.utf8 || '').join('').trim();
      const start = Number(ev.tStartMs) / 1000;
      const dur = Number(ev.dDurationMs) / 1000;
      if (!text || !Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
      let end = start + dur;
      // Auto-generated captions time each word and keep the line on screen long
      // after the last one; end shortly after the last word instead.
      const offsets = ev.segs.map((s) => Number(s?.tOffsetMs)).filter(Number.isFinite);
      if (offsets.length) end = Math.min(end, start + Math.max(...offsets) / 1000 + WORD_TAIL);
      lines.push({ start, end, text });
    }
  } else {
    // srv3: <p t="ms" d="ms">…</p>   srv1: <text start="s" dur="s">…</text>
    for (const m of src.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      const start = attr(m[1], 't') / 1000;
      const dur = attr(m[1], 'd') / 1000;
      const text = decodeXml(m[2]).trim();
      if (text && Number.isFinite(start) && dur > 0) lines.push({ start, end: start + dur, text });
    }
    for (const m of src.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      const start = attr(m[1], 'start');
      const dur = attr(m[1], 'dur');
      const text = decodeXml(decodeXml(m[2])).trim();
      if (text && Number.isFinite(start) && dur > 0) lines.push({ start, end: start + dur, text });
    }
  }
  return lines.sort((a, b) => a.start - b.start);
}

/** Caption text that labels a sound rather than speech: [Music], (applause), ♪♪. */
export function isNonSpeech(text) {
  const rest = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】/g, '');
  return !/[\p{L}\p{N}]/u.test(rest);
}

/**
 * Merge caption lines into the stretches of time when someone is speaking.
 * @param {Array<{start: number, end: number, text: string}>} lines
 * @param {number} join  pauses shorter than this are treated as continuous speech
 * @returns {Array<{start: number, end: number}>} sorted, non-overlapping
 */
export function speechIntervals(lines, join = 0.3) {
  const sorted = (lines || [])
    .filter((l) => l && Number.isFinite(l.start) && l.end > l.start && !isNonSpeech(l.text))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const { start, end } of sorted) {
    const prev = out[out.length - 1];
    if (prev && start - prev.end < join) prev.end = Math.max(prev.end, end);
    else out.push({ start, end });
  }
  return out;
}

/** Index of the first interval that ends after t (it may contain t or lie ahead of it). */
function firstEndingAfter(intervals, t) {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Where a cue lands and how much room it has: moved to the end of speech it starts in, if that ends within maxShift. */
function fitOne(cue, intervals, maxShift, margin) {
  let start = cue.start;
  let i = firstEndingAfter(intervals, start);
  let blocked = false;
  if (i < intervals.length && intervals[i].start <= start) {
    if (intervals[i].end - start <= maxShift) {
      start = Math.ceil(intervals[i].end * 10) / 10;
      i = firstEndingAfter(intervals, start);
      blocked = i < intervals.length && intervals[i].start <= start;
    } else {
      blocked = true;
    }
  }
  let gap = cue.gap;
  if (blocked) gap = 0;
  else if (i < intervals.length) gap = Math.min(gap, Math.max(0, intervals[i].start - start - margin));
  return { start, gap };
}

/**
 * The first pause in speech within `wait` seconds after the cue that lasts at
 * least `room` seconds, or null. The room is measured from the captions: the
 * model's estimate was for the moment the text appeared, not for this pause.
 */
function laterPause(cue, intervals, wait, room, margin) {
  for (let i = firstEndingAfter(intervals, cue.start); i < intervals.length; i += 1) {
    const end = Math.ceil(intervals[i].end * 10) / 10;
    if (end - cue.start > wait) break;
    const next = intervals[i + 1];
    // After the last caption the captions say nothing: keep to the model's estimate.
    const gap = next ? next.start - end - margin : cue.gap;
    if (gap >= room) return { start: end, gap };
  }
  return null;
}

/**
 * Correct each cue's gap with the real dialogue timing.
 * - A cue that starts while someone is speaking moves to the end of that speech
 *   if it ends within maxShift seconds; otherwise its gap becomes 0.
 * - The gap is the time until the next speech starts, minus a safety margin.
 *   It never grows beyond what the model reported: captions can miss speech
 *   (untranscribed voices, singing), the model's estimate is the upper bound.
 * - On-screen text matters more than a passing visual detail, and is still
 *   worth hearing a few seconds after it appeared: a text cue without `textRoom`
 *   seconds of room waits up to `textWait` seconds for the first pause that has it.
 * Corrected cues carry gapMeasured: true.
 */
export function fitCuesToDialogue(cues, intervals, { maxShift = 2, margin = 0.3, textWait = 8, textRoom = 1.5 } = {}) {
  if (!intervals?.length) return cues;
  return cues
    .map((cue) => {
      let fit = fitOne(cue, intervals, maxShift, margin);
      if (cue.kind === 'text' && fit.gap < textRoom) fit = laterPause(cue, intervals, textWait, textRoom, margin) || fit;
      return { ...cue, start: fit.start, gap: Math.round(fit.gap * 10) / 10, gapMeasured: true };
    })
    .sort((a, b) => a.start - b.start);
}
