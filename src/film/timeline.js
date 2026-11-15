// Where a description has room: the stretches of a film in which someone speaks
// (from subtitle lines; later from voice detection or a transcript), the pauses
// between them as slots, and how much can be said in a slot at the listener's
// speaking rate. A description that runs past its slot talks over the dialogue,
// so every number here errs on the short side.

import { speechIntervals } from '../shared/dialogue.js';
import { DEFAULT_RATE, isCjk } from './types.js';

/**
 * A stretch of time, in seconds.
 * @typedef {{start: number, end: number}} Interval
 * @typedef {import('./types.js').Slot} Slot
 */

/** Times are kept to the millisecond, the precision of a subtitle file: 5.3 + 0.1 is stored as 5.4. */
const toMs = (seconds) => Math.round(seconds * 1000) / 1000;

const list = (value) => (Array.isArray(value) ? value : []);

/** A number of seconds that is zero or more, or the fallback when it is not that. */
const nonNegative = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

/**
 * Two lists of intervals as one: sorted, with nothing overlapping. Either list
 * may be unsorted and overlap itself, so one list (with [] for the other) is
 * put in order this way too. Intervals that overlap or touch become one, and so
 * do those with a pause shorter than `join` between them, as in speechIntervals.
 * Entries without a length (end <= start, or not numbers) are left out.
 * @param {Interval[]} a
 * @param {Interval[]} [b]
 * @param {number} [join]  seconds; pauses shorter than this are closed
 * @returns {Interval[]} new objects; the arguments are left as they were
 */
export function unionIntervals(a, b, join = 0) {
  const reach = nonNegative(join, 0);
  const sorted = [...list(a), ...list(b)]
    .filter((i) => i && Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((x, y) => x.start - y.start);
  const out = [];
  for (const { start, end } of sorted) {
    const prev = out[out.length - 1];
    if (prev && (start <= prev.end || start - prev.end < reach)) prev.end = Math.max(prev.end, end);
    else out.push({ start, end });
  }
  return out;
}

/**
 * Subtitle lines as the stretches of time in which someone speaks. Lines that
 * only label a sound ("[Music]", "♪♪") are not speech: a description may be
 * spoken over them.
 * @param {Array<{start: number, end: number, text: string}>} lines  as the parsers of subs.js return them
 * @param {{join?: number}} [options]  join: pauses shorter than this many seconds count as continuous speech
 * @returns {Interval[]} sorted, non-overlapping
 */
export function speechFromLines(lines, { join = 0.3 } = {}) {
  return speechIntervals(list(lines), nonNegative(join, 0.3));
}

/** The rate with every field in place: a missing or impossible field takes the default. */
function paceOf(rate) {
  const given = rate && typeof rate === 'object' ? rate : {};
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    cjkPerSec: positive(given.cjkPerSec, DEFAULT_RATE.cjkPerSec),
    wordsPerSec: positive(given.wordsPerSec, DEFAULT_RATE.wordsPerSec),
    lead: nonNegative(given.lead, DEFAULT_RATE.lead),
  };
}

/**
 * How much can be said in `room` seconds: characters for Chinese, Japanese and
 * Korean, words for other languages. The inverse of estimateSeconds
 * (shared/script.js), which is what later decides whether a text fits: a text of
 * exactly `detailed` characters or words is one it accepts for this room, and
 * one more is not.
 * @param {number} room  seconds
 * @param {string} lang  the description language ('zh-CN', 'en', …)
 * @param {{rate?: {cjkPerSec?: number, wordsPerSec?: number, lead?: number}, speed?: number}} [options]
 *   rate: what a voice says per second at speed 1 (DEFAULT_RATE); speed: the listener's
 *   speaking rate, 1 = normal, the `rate` argument of estimateSeconds
 * @returns {{units: 'chars'|'words', brief: number, standard: number, detailed: number}}
 *   detailed is the full count, standard two thirds of it, brief one third; whole numbers, never below 0
 *   and never above Number.MAX_SAFE_INTEGER
 */
export function budgetFor(room, lang, { rate = DEFAULT_RATE, speed = 1 } = {}) {
  const pace = paceOf(rate);
  const units = isCjk(lang) ? 'chars' : 'words';
  // estimateSeconds does not go below a speed of 0.3; neither does its inverse.
  const factor = Number.isFinite(speed) ? Math.max(0.3, speed || 1) : 1;
  const perSec = (units === 'chars' ? pace.cjkPerSec : pace.wordsPerSec) * factor;
  const fits = (n) => n / perSec + pace.lead <= room;
  let detailed = 0;
  if (Number.isFinite(room) && room > pace.lead) {
    // No count is larger than the largest whole number that is exact: past it (an absurd room,
    // rate or speed; the product may even be Infinity) one less is the same number again, and
    // the correction below would never end.
    detailed = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor((room - pace.lead) * perSec)));
    // The product can land a hair to either side of a whole number. The count
    // returned is the largest one the forward formula itself accepts, so the
    // budget and the check that follows it never disagree by one.
    if (detailed < Number.MAX_SAFE_INTEGER && fits(detailed + 1)) detailed += 1;
    while (detailed > 0 && !fits(detailed)) detailed -= 1;
  }
  return { units, brief: Math.floor(detailed / 3), standard: Math.floor((detailed * 2) / 3), detailed };
}

/** 1 -> 'g_0001'. */
const slotId = (number) => `g_${String(number).padStart(4, '0')}`;

/**
 * The pauses in the dialogue a description may be spoken in, from 0 to
 * `duration`. A slot starts `lead` seconds after speech ends (the last word
 * rings out) and ends `tail` seconds before it resumes (the description is done
 * before the next line). The film's opening before the first line and its close
 * after the last are slots too: nothing was said before the one and nothing
 * follows the other, so they reach to 0 and to `duration`.
 * @param {Interval[]} speech  when someone speaks; may be unsorted and overlapping
 * @param {number} duration  the length of the film in seconds
 * @param {{minGap?: number, lead?: number, tail?: number, lang?: string, rate?: object, speed?: number, src?: 'subs'|'vad'|'asr'}} [options]
 *   minGap: slots with less room than this are left out; lang, rate, speed: for each slot's
 *   budget (see budgetFor); src: where the speech intervals came from
 * @returns {Slot[]} in time order, ids 'g_0001', 'g_0002', …
 */
export function buildSlots(speech, duration, { minGap = 1, lead = 0.1, tail = 0.3, lang, rate, speed, src = 'subs' } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const after = nonNegative(lead, 0.1);
  const before = nonNegative(tail, 0.3);
  const least = nonNegative(minGap, 1);
  const spoken = unionIntervals(speech, [])
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(duration, i.end) }))
    .filter((i) => i.end > i.start);

  const pauses = [];
  let from = 0;
  for (const { start, end } of spoken) {
    pauses.push({ start: from, end: start - before });
    from = end + after;
  }
  pauses.push({ start: from, end: duration });

  return pauses
    .map((p) => ({ start: toMs(p.start), end: toMs(p.end) }))
    .map((p) => ({ ...p, room: toMs(p.end - p.start) }))
    .filter((p) => p.room > 0 && p.room >= least)
    .map((p, index) => ({
      id: slotId(index + 1),
      start: p.start,
      end: p.end,
      room: p.room,
      budget: budgetFor(p.room, lang, { rate, speed }),
      src,
    }));
}

/**
 * The slot that holds time `t`, its first and last moment included (slots never
 * touch: there is speech between them), or null when `t` falls on speech.
 * @param {Slot[]} slots
 * @param {number} t  seconds
 * @returns {Slot|null}
 */
export function slotAt(slots, t) {
  if (!Number.isFinite(t)) return null;
  return list(slots).find((s) => s && s.start <= t && t <= s.end) || null;
}

/**
 * The slots of a window of the film: those that start at `start` or later and
 * before `end`. A slot belongs to the window it starts in, however far it runs
 * on, so windows laid end to end share the slots out with none left over and
 * none given twice.
 * @param {Slot[]} slots
 * @param {number} start  seconds
 * @param {number} end  seconds
 * @returns {Slot[]} in the order given
 */
export function slotsBetween(slots, start, end) {
  return list(slots).filter((s) => s && s.start >= start && s.start < end);
}
