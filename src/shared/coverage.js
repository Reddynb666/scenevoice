// Scripts made from frames (see providers.js, 'frames'): the parts of the video
// already described, and how a newly described stretch joins the saved script.
// A script made from the video link covers 0..completedUntil; one made from
// frames covers whatever the viewer has watched, so it keeps a list of ranges.
// No browser APIs here, so everything is unit-testable.

import { SCRIPT_VERSION } from './constants.js';
import { mergeScript } from './script.js';
import { addUsage } from './usage.js';

const round1 = (n) => Math.round(n * 10) / 10;

/** Ranges [start, end] in seconds, with [start, end] added. */
export function addRange(ranges, start, end) {
  return joinRanges([...(ranges || []), [start, end]]);
}

/** Valid ranges, sorted, with overlapping or touching ones (within a second) joined. */
export function joinRanges(ranges) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
    .map(([a, b]) => [round1(Math.max(0, a)), round1(b)])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of list) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1] + 1) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The parts of the video a saved script describes (a script may have been carried on from the link too). */
export function coveredRanges(script) {
  const own = Array.isArray(script?.covered) ? script.covered : [];
  return joinRanges(script?.completedUntil > 0 ? [...own, [0, script.completedUntil]] : own);
}

/** Whether a moment lies in a part already described (the last half second counts as not yet). */
export function isCovered(ranges, t) {
  return (ranges || []).some(([a, b]) => t >= a - 0.5 && t < b - 0.5);
}

/** How far the video is described without a gap from the start. */
export function contiguousFromStart(ranges) {
  const first = (ranges || [])[0];
  return first && first[0] <= 1 ? first[1] : 0;
}

/**
 * How far the part being watched is described: the end of the described stretch
 * the viewer is in or has most recently passed the start of (descriptions from
 * pictures trail playback by a stretch). 0 when nothing before t is described.
 */
export function describedUpTo(ranges, t) {
  let upTo = 0;
  for (const [a, b] of ranges || []) {
    if (a <= t + 1) upTo = b;
  }
  return upTo;
}

/** Seconds of the video described. */
export function coverageSeconds(ranges) {
  return round1((ranges || []).reduce((sum, [a, b]) => sum + (b - a), 0));
}

/** Up to n items spread evenly over a list, the first and last included. */
export function pickEvenly(list, n) {
  if (!Array.isArray(list) || n <= 0) return [];
  if (list.length <= n) return [...list];
  if (n === 1) return [list[list.length - 1]];
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return out;
}

/** An empty script for descriptions made from frames. */
export function newFramesScript({ videoId, lang, duration, platform, provider }) {
  return {
    version: SCRIPT_VERSION,
    videoId,
    lang,
    duration,
    cues: [],
    characters: [],
    covered: [],
    completedUntil: 0,
    complete: false,
    mode: 'frames',
    platform,
    provider,
    model: '',
    createdAt: Date.now(),
  };
}

/**
 * A described stretch [start, end] added to a saved script: its cues and
 * people merged in, the stretch counted as covered, its tokens added to the
 * script's total, and the script complete once the whole video is.
 */
export function mergeFramesChunk(script, chunk, { start, end, duration, model, provider, usage }) {
  const length = Number.isFinite(duration) && duration > 0 ? duration : script.duration;
  const merged = mergeScript(script, chunk, 0);
  const covered = addRange(coveredRanges(script), start, end);
  const until = contiguousFromStart(covered);
  return {
    ...merged,
    duration: length,
    covered,
    completedUntil: until,
    complete: Number.isFinite(length) && until >= length - 1.5,
    mode: 'frames',
    model: model || merged.model || '',
    provider: provider || merged.provider || '',
    usage: addUsage(script.usage, usage || chunk.usage),
  };
}

/** The descriptions just before a stretch, so the model does not say them again. */
export function recentCues(script, start, { seconds = 30, max = 5 } = {}) {
  return (script?.cues || [])
    .filter((c) => c.start < start && c.start >= start - seconds)
    .slice(-max)
    .map((c) => ({ start: c.start, text: c.standard }));
}
