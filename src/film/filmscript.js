// The script of a film: its pauses (slots), its cues and its scene starts.
// A cue's text carries character tokens ({P3}), never names: the name gate fills
// them when the script is rendered. This module cleans what a model answers for
// one section, merges it into the script, applies a person's edits, and hands
// rendered cues to the extension's player in the shape it already plays.
// Pure: no clock, no randomness, no browser. See README.md in this folder.

import { SCRIPT_VERSION } from '../shared/constants.js';
import { CONFIDENCES, cleanScreenText, cleanText, parseTime } from '../shared/script.js';
import { isCharacterId, isCjk, tokenFor, tokenPattern, tokensIn } from './types.js';

/** FilmScript.v: the format this module reads and writes. */
const FILM_SCRIPT_VERSION = 3;
const KINDS = Object.freeze(['visual', 'text', 'intro', 'extended']);
const STATUSES = Object.freeze(['ai', 'edited', 'reviewed', 'blind-ok', 'locked', 'needs-check']);
const VERSIONS = Object.freeze(['brief', 'standard', 'detailed']);
const SLOT_SOURCES = Object.freeze(['subs', 'vad', 'asr']);
const BUDGET_UNITS = Object.freeze(['chars', 'words']);

/**
 * Hard limits in characters for what a model wrote. They are not the budget of a
 * pause (the slot carries that, and the name gate and the player check the fit
 * when the text is spoken): they stop an answer that ran away from being read
 * over the film. CJK text counts characters, other text about 6.5 per word.
 */
const VISUAL_LIMITS = Object.freeze({
  cjk: Object.freeze({ brief: 30, standard: 70, detailed: 140 }),
  other: Object.freeze({ brief: 90, standard: 230, detailed: 500 }),
});
/** On-screen text is quoted word for word, so a 'text' cue may run longer, in any language. */
const SCREEN_LIMITS = Object.freeze({ brief: 160, standard: 360, detailed: 800 });
/** A cut keeps whole sentences when they hold more than this share of the limit. */
const SENTENCE_SHARE = 0.35;
/** A cue that names no slot may start this far (seconds) from the start of the slot it means. */
const SNAP_SECONDS = 1;
/** An outfit is a few words ("a red dress"), not a sentence. */
const OUTFIT_LIMIT = 80;
/** What an outfit must not hold: a brace of any width, or a character id in the open ("P2's coat", not "MP3"). */
const OUTFIT_RESIDUE = /[{}｛｝﹛﹜︷︸]|(?<![A-Za-z0-9_])[PpＰｐ][0-9０-９]+(?![A-Za-z0-9_])/;
/** buildSlots rounds a slot's room to the millisecond, so it may differ from end - start by that much. */
const ROOM_SLACK = 0.001;

const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
/**
 * The end of a sentence: the stop and any closing quote or bracket after it.
 * A Latin stop counts only before a space, so "3.5" is not two sentences.
 */
const SENTENCE_END = /[。！？][”’」』）"']*|[.!?][”’)"']*(?=\s)/g;
/** What should not be left hanging before an ellipsis. */
const TRAILING = /[\s,，、;；:：]+$/;
/**
 * A token as a model or a person may type it: full-width braces (a Chinese
 * input method), a lower-case or full-width p, spaces inside, leading zeros.
 */
const LOOSE_TOKEN = /[{｛]\s*[pPｐＰ]\s*([0-9０-９]{1,6})\s*[}｝]/g;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const tenth = (seconds) => Math.round(seconds * 10) / 10;
const cueId = (number) => `q_${String(number).padStart(6, '0')}`;
/** A value of the model, short enough to quote in a problem. */
const said = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 40) : 'none');

/** Every way of writing a token becomes {P3}. (verify.js has the public one; this keeps the module on its own.) */
function canonicalTokens(text) {
  return text.replace(LOOSE_TOKEN, (_, digits) => {
    const ascii = digits.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    return `{P${Number(ascii)}}`;
  });
}

/**
 * Whether a text is counted in CJK characters. The text itself decides (a model
 * may answer in another language than asked, and it is the text that is spoken);
 * the description language decides only when the text has no letters at all.
 */
function writtenInCjk(text, lang) {
  const plain = text.replace(tokenPattern(), '');
  const cjk = (plain.match(CJK_CHAR) || []).length;
  if (cjk > plain.length / 3) return true;
  return !/\p{L}/u.test(plain) && isCjk(lang);
}

function hardLimit(text, version, kind, lang) {
  if (kind === 'text') return SCREEN_LIMITS[version];
  return (writtenInCjk(text, lang) ? VISUAL_LIMITS.cjk : VISUAL_LIMITS.other)[version];
}

/**
 * Cut a text at a limit: after the last whole sentence when the sentences kept
 * say a fair part of it, otherwise mid-sentence with an ellipsis. A token is
 * never split: half of "{P12}" would be read out as braces and digits.
 */
function cutAt(text, limit) {
  if (text.length <= limit) return text;
  let end = 0;
  // One character past the limit, so a stop that ends exactly there sees the space after it.
  for (const m of text.slice(0, limit + 1).matchAll(SENTENCE_END)) {
    const stop = m.index + m[0].length;
    if (stop <= limit) end = stop;
  }
  if (end > limit * SENTENCE_SHARE) return text.slice(0, end);
  end = limit - 1; // one character is kept for the ellipsis
  for (const m of text.matchAll(tokenPattern())) {
    if (m.index >= end) break;
    if (m.index + m[0].length > end) end = m.index;
  }
  // Nor is a character outside the basic plane cut in half.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).replace(TRAILING, '')}…`;
}

/** Scene starts: real times only, to a tenth of a second, each once, in order. */
function sceneTimes(list) {
  const times = (Array.isArray(list) ? list : []).filter((x) => finite(x) && x >= 0).map(tenth);
  return [...new Set(times)].sort((a, b) => a - b);
}

/**
 * The people of a cue, from the tokens in its texts, in order of first mention.
 * What was known about a person (tracks, demoted) is kept.
 */
function peopleIn(texts, known = []) {
  const kept = new Map(known.map((p) => [p.char, p]));
  return tokensIn(texts.join(' ')).filter(isCharacterId).map((char) => kept.get(char) || { char });
}

/** A stored list of people without the junk: valid ids, each once. */
function cleanPeople(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const char = typeof entry === 'string' ? entry : entry?.char;
    if (!isCharacterId(char) || out.some((p) => p.char === char)) continue;
    const person = { char };
    if (Array.isArray(entry?.tracks)) person.tracks = entry.tracks.filter((x) => typeof x === 'string' && x);
    if (entry?.demoted === true) person.demoted = true;
    out.push(person);
  }
  return out;
}

function priorityOf(value, fallback) {
  const n = parseInt(value, 10);
  return n === 1 || n === 2 || n === 3 ? n : fallback;
}

/** A cue's fields in one order, optional ones only when they say something. */
function layOut(c) {
  const cue = {
    id: c.id,
    slot: c.slot,
    start: c.start,
    end: c.end,
    kind: c.kind,
    priority: c.priority,
    brief: c.brief,
    standard: c.standard,
    detailed: c.detailed,
    people: c.people,
  };
  // Only a text cue carries a transcription; a visual cue's would be a stray.
  if (c.kind === 'text' && c.onScreenText) cue.onScreenText = c.onScreenText;
  if (c.confidence) cue.confidence = c.confidence;
  if (finite(c.scene)) cue.scene = c.scene;
  cue.status = c.status;
  cue.by = c.by;
  if (c.clip) cue.clip = c.clip;
  return cue;
}

/**
 * An empty script for a film.
 * @param {{filmId?: string, lang?: string, duration?: number}} [film]  duration in seconds, 0 when not known yet
 * @returns {import('./types.js').FilmScript}
 */
export function createFilmScript({ filmId, lang, duration } = {}) {
  return {
    v: FILM_SCRIPT_VERSION,
    filmId: typeof filmId === 'string' ? filmId : '',
    lang: typeof lang === 'string' ? lang : '',
    duration: finite(duration) && duration > 0 ? duration : 0,
    slots: [],
    cues: [],
    scenes: [],
  };
}

/**
 * A slot read from storage or a package. It is a pause of this film: it ends
 * with the film at the latest (a duration of 0 is not known yet and cuts
 * nothing), and its room is never more than its length. The player takes the
 * room as measured and keeps no margin back, so a room a file made up would be
 * a description spoken over the dialogue.
 */
function storedSlot(raw, lang, duration) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || !finite(raw.start) || !finite(raw.end) || raw.start < 0) return null;
  const end = duration > 0 ? Math.min(raw.end, duration) : raw.end;
  if (end <= raw.start) return null;
  const length = end - raw.start;
  const budget = isObject(raw.budget) ? raw.budget : {};
  const count = (value) => (finite(value) && value > 0 ? Math.floor(value) : 0);
  return {
    id,
    start: raw.start,
    end,
    room: finite(raw.room) && raw.room >= 0 && raw.room <= length + ROOM_SLACK ? raw.room : length,
    budget: {
      units: BUDGET_UNITS.includes(budget.units) ? budget.units : isCjk(lang) ? 'chars' : 'words',
      brief: count(budget.brief),
      standard: count(budget.standard),
      detailed: count(budget.detailed),
    },
    src: SLOT_SOURCES.includes(raw.src) ? raw.src : 'subs',
  };
}

function storedClip(raw) {
  if (!isObject(raw) || typeof raw.file !== 'string' || !raw.file || typeof raw.textHash !== 'string') return null;
  return {
    file: raw.file,
    dur: finite(raw.dur) && raw.dur >= 0 ? raw.dur : 0,
    voice: typeof raw.voice === 'string' ? raw.voice : '',
    textHash: raw.textHash,
    version: VERSIONS.includes(raw.version) ? raw.version : 'standard',
  };
}

/** A cue read from storage or a package. Its texts are kept as written: a person's wording is never cut. */
function storedCue(raw) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || !finite(raw.start) || raw.start < 0) return null;
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const standard = text(raw.standard) || text(raw.detailed) || text(raw.brief);
  if (!standard) return null;
  const brief = text(raw.brief) || standard;
  const detailed = text(raw.detailed) || standard;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'visual';
  return layOut({
    id,
    slot: typeof raw.slot === 'string' && raw.slot ? raw.slot : null,
    start: raw.start,
    end: finite(raw.end) && raw.end >= raw.start ? raw.end : raw.start,
    kind,
    priority: priorityOf(raw.priority, 2),
    brief,
    standard,
    detailed,
    people: peopleIn([standard, brief, detailed], cleanPeople(raw.people)),
    onScreenText: text(raw.onScreenText),
    confidence: CONFIDENCES.includes(raw.confidence) ? raw.confidence : '',
    scene: raw.scene,
    status: STATUSES.includes(raw.status) ? raw.status : 'ai',
    by: raw.by === 'human' ? 'human' : 'ai',
    clip: storedClip(raw.clip),
  });
}

/** The entries a cleaner accepts, the first of each id only. */
function cleanList(list, clean) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const item = clean(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * A script read from storage or from a package, cleaned: unknown fields are
 * dropped, slots and cues that cannot be used (no id, no time, no text) are left
 * out, and what is left is sorted by time. The timing is made consistent, since
 * the player trusts it: a slot ends with the film at the latest and has no more
 * room than its length; a cue takes the times of its slot, as normalizeSection
 * gives them; a cue that names a slot the script does not have keeps its start
 * and loses the slot (no room is measured for it: the player skips it or
 * pauses the film for it, and never speaks it over the dialogue).
 * @param {unknown} raw
 * @returns {import('./types.js').FilmScript}
 * @throws {Error} 'bad-film-script' when raw is not an object or is not version 3
 */
export function validateFilmScript(raw) {
  if (!isObject(raw) || raw.v !== FILM_SCRIPT_VERSION) throw new Error('bad-film-script');
  const base = createFilmScript(raw);
  const slots = cleanList(raw.slots, (slot) => storedSlot(slot, base.lang, base.duration));
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const cues = cleanList(raw.cues, storedCue)
    .map((cue) => {
      if (cue.slot === null) return cue;
      const slot = byId.get(cue.slot);
      if (!slot) return { ...cue, slot: null, end: cue.start };
      return cue.start === slot.start && cue.end === slot.end ? cue : { ...cue, start: slot.start, end: slot.end };
    })
    // The starts may have moved.
    .sort((a, b) => a.start - b.start);
  return { ...base, slots, cues, scenes: sceneTimes(raw.scenes) };
}

/** The window of a section; with none given, the whole film. */
function sectionSpan(value) {
  const start = finite(value?.start) ? value.start : 0;
  const end = finite(value?.end) && value.end > start ? value.end : Infinity;
  return { start, end };
}

/**
 * The slot a cue of the model belongs to: the one it names; failing that the
 * one its start lies in; failing that the nearest one that starts within a
 * second of it (a model reads times off frames, and is often a little early).
 */
function bindSlot(item, slots) {
  const name = typeof item.slot === 'string' ? item.slot.trim().toLowerCase() : '';
  const named = name && slots.find((s) => s.id.toLowerCase() === name);
  if (named) return named;
  const start = parseTime(item.start);
  if (!Number.isFinite(start)) return null;
  const holding = slots.find((s) => s.start <= start && start <= s.end);
  if (holding) return holding;
  let nearest = null;
  for (const s of slots) {
    const away = Math.abs(s.start - start);
    if (away <= SNAP_SECONDS && (!nearest || away < Math.abs(nearest.start - start))) nearest = s;
  }
  return nearest;
}

/** The three texts of a model's cue: cleaned, tokens normalised, cut at the hard limits. null when it says nothing. */
function sectionTexts(item, kind, lang) {
  const sized = (value, version) => {
    // On-screen text is quoted, where "__init__" or "#1" mean something.
    const text = canonicalTokens(cleanText(value, Infinity, { keepSymbols: kind === 'text' }));
    return cutAt(text, hardLimit(text, version, kind, lang));
  };
  const onScreenText = kind === 'text' ? cleanScreenText(item.onScreenText) : '';
  const brief = sized(item.brief, 'brief');
  const detailed = sized(item.detailed, 'detailed');
  // The standard version is the one every cue must have. A model that left it
  // out but wrote another still said something worth keeping.
  const standard = sized(item.standard, 'standard') || sized(item.detailed, 'standard') || brief || sized(onScreenText, 'standard');
  if (!standard) return null;
  return { brief: brief || standard, standard, detailed: detailed || standard, onScreenText };
}

/** 'P3' from "P3", "p3", "{P3}" or "｛P3｝". */
const bareId = (value) => String(value).trim().replace(/^[{｛]\s*|\s*[}｝]$/g, '').toUpperCase();

function sectionAppearances(list, legendIds, span, problems) {
  const legend = new Set(Array.isArray(legendIds) ? legendIds : []);
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item, index) => {
    const where = `appearances[${index}]`;
    if (!isObject(item)) {
      problems.push({ type: 'malformed', detail: where });
      return;
    }
    const char = typeof item.char === 'string' ? bareId(item.char) : '';
    if (!isCharacterId(char) || !legend.has(char)) {
      problems.push({ type: 'unknown-character', detail: `${where}: ${said(item.char)}` });
      return;
    }
    const outfit = cleanText(item.outfit, OUTFIT_LIMIT);
    if (!outfit) {
      problems.push({ type: 'empty', detail: where });
      return;
    }
    // The name gate says an outfit word for word. One with a token or an id in it is not stored:
    // it would not be said, and it must not close the outfit the character has on record.
    if (OUTFIT_RESIDUE.test(outfit)) {
      problems.push({ type: 'malformed', detail: `${where}: outfit` });
      return;
    }
    // No time given: the outfit was seen in this section, so it holds from its start.
    const told = parseTime(item.from);
    const from = Number.isFinite(told) ? told : span.start;
    if (from < span.start || from > span.end) {
      problems.push({ type: 'outside-window', detail: `${where}: ${said(item.from)}` });
      return;
    }
    out.push({ char, outfit, from: tenth(from), src: 'model' });
  });
  return out.sort((a, b) => a.from - b.from);
}

function sectionScenes(list, span, problems) {
  const times = [];
  (Array.isArray(list) ? list : []).forEach((value, index) => {
    const t = parseTime(value);
    if (!Number.isFinite(t)) problems.push({ type: 'malformed', detail: `sceneStarts[${index}]` });
    else if (t < span.start || t > span.end) problems.push({ type: 'outside-window', detail: `sceneStarts[${index}]: ${said(value)}` });
    else times.push(t);
  });
  return sceneTimes(times);
}

/**
 * Validate and normalise a model's answer for one section of a film.
 *
 * Each cue is bound to a slot (see bindSlot) and takes the slot's times; a model
 * does not decide when a description is spoken, the pauses in the dialogue do.
 * Tokens are normalised and `people` is derived from them (what the model lists
 * as people is ignored). A slot holds one cue: the more important wins, the
 * first of two equals. Ids are given in time order, from nextNumber on.
 *
 * @param {object} raw  the model's JSON: { cues, sceneStarts, appearances }
 * @param {object} options
 * @param {import('./types.js').Slot[]} options.slots  the film's slots
 * @param {{start: number, end: number}} options.window  the section, in seconds
 * @param {string[]} options.legendIds  the characters marked in this section's frames
 * @param {string} options.lang  the description language
 * @param {number} options.nextNumber  the number of the first id to give (see nextCueNumber)
 * @returns {{cues: import('./types.js').FilmCue[], sceneStarts: number[],
 *   appearances: Array<{char: string, outfit: string, from: number, src: 'model'}>,
 *   problems: Array<{type: string, detail: string}>}}
 *   problems says what was left out and why. Types: 'malformed' (not the shape asked for; an outfit
 *   that holds a brace or a character id),
 *   'empty' (a cue with no text, an appearance with no outfit), 'no-slot', 'outside-window'
 *   (a time that is not in [window.start, window.end]: the start of a cue's slot, a scene
 *   start, the `from` of an appearance), 'duplicate-slot'
 *   (the cue that lost a slot to a more important one), 'unknown-character' (an appearance
 *   of someone not in the legend). detail says where, for a log; it is not interface text.
 */
export function normalizeSection(raw, { slots, window: section, legendIds, lang, nextNumber } = {}) {
  const usable = (Array.isArray(slots) ? slots : []).filter((s) => isObject(s) && typeof s.id === 'string' && finite(s.start) && finite(s.end));
  const span = sectionSpan(section);
  const problems = [];
  const source = isObject(raw) ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(source.cues) ? source.cues : [];
  if (!isObject(raw) && !Array.isArray(raw)) problems.push({ type: 'malformed', detail: 'section' });

  const winners = new Map();
  list.forEach((item, index) => {
    const where = `cues[${index}]`;
    if (!isObject(item)) {
      problems.push({ type: 'malformed', detail: where });
      return;
    }
    const kind = KINDS.includes(item.kind) ? item.kind : 'visual';
    const texts = sectionTexts(item, kind, lang);
    if (!texts) {
      problems.push({ type: 'empty', detail: where });
      return;
    }
    const slot = bindSlot(item, usable);
    if (!slot) {
      problems.push({ type: 'no-slot', detail: `${where}: slot ${said(item.slot)}, start ${said(item.start)}` });
      return;
    }
    // A cue is spoken from the start of its slot, so that is its time: it must
    // lie in the section the model was shown, as a scene start must. (A slot
    // that began before the section belongs to the one before.)
    if (slot.start < span.start || slot.start > span.end) {
      problems.push({ type: 'outside-window', detail: `${where}: slot ${slot.id}` });
      return;
    }
    const cue = {
      slot: slot.id,
      start: slot.start,
      end: slot.end,
      kind,
      priority: priorityOf(item.priority, 2),
      brief: texts.brief,
      standard: texts.standard,
      detailed: texts.detailed,
      people: peopleIn([texts.standard, texts.brief, texts.detailed]),
      onScreenText: texts.onScreenText,
      confidence: CONFIDENCES.includes(item.confidence) ? item.confidence : '',
      status: 'ai',
      by: 'ai',
    };
    const held = winners.get(slot.id);
    if (held && held.cue.priority <= cue.priority) {
      problems.push({ type: 'duplicate-slot', detail: `${where}: slot ${slot.id}` });
      return;
    }
    if (held) problems.push({ type: 'duplicate-slot', detail: `cues[${held.index}]: slot ${slot.id}` });
    winners.set(slot.id, { cue, index });
  });

  // Ids only for the cues that stay, so the numbers have no holes.
  const first = Number.isInteger(nextNumber) && nextNumber > 0 ? nextNumber : 1;
  const cues = [...winners.values()]
    .map((w) => w.cue)
    .sort((a, b) => a.start - b.start)
    .map((cue, i) => layOut({ ...cue, id: cueId(first + i) }));

  return {
    cues,
    sceneStarts: sectionScenes(source.sceneStarts, span, problems),
    appearances: sectionAppearances(source.appearances, legendIds, span, problems),
    problems,
  };
}

/**
 * The number to pass to normalizeSection as nextNumber: one more than the
 * highest cue number in the script (1 for an empty script).
 * @param {import('./types.js').FilmScript} script
 * @returns {number}
 */
export function nextCueNumber(script) {
  let highest = 0;
  for (const cue of Array.isArray(script?.cues) ? script.cues : []) {
    const m = /^q_(\d+)$/.exec(typeof cue?.id === 'string' ? cue.id : '');
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return highest + 1;
}

/**
 * Add a normalised section to a script. Cues are kept sorted by start. A cue for
 * a slot that already has one replaces it only when the existing one is by 'ai':
 * what a person wrote or looked at is never overwritten by a later answer of the
 * model. Scene starts are united (sorted, each once, to a tenth of a second).
 * A new cue whose id is already taken gets the next free one, so ids stay unique
 * even when two sections were numbered from the same nextNumber.
 * @param {import('./types.js').FilmScript} script
 * @param {{cues?: import('./types.js').FilmCue[], sceneStarts?: number[]}} section  what normalizeSection returned
 * @returns {import('./types.js').FilmScript}
 */
export function mergeSection(script, section) {
  let cues = Array.isArray(script?.cues) ? script.cues.filter(isObject) : [];
  const incoming = (Array.isArray(section?.cues) ? section.cues : []).filter((c) => isObject(c) && typeof c.id === 'string' && finite(c.start));
  for (const cue of incoming) {
    if (cue.slot != null) {
      const holders = cues.filter((c) => c.slot === cue.slot);
      if (holders.some((c) => c.by !== 'ai')) continue;
      if (holders.length) cues = cues.filter((c) => c.slot !== cue.slot);
    }
    const taken = cues.some((c) => c.id === cue.id);
    cues.push(taken ? { ...cue, id: cueId(nextCueNumber({ cues })) } : cue);
  }
  cues.sort((a, b) => a.start - b.start);
  const scenes = sceneTimes([...(Array.isArray(script?.scenes) ? script.scenes : []), ...(Array.isArray(section?.sceneStarts) ? section.sceneStarts : [])]);
  return { ...script, cues, scenes };
}

/**
 * After characters were merged: every token of a dropped character becomes the
 * kept one's, in every text and in people. A chain ({ P7: 'P3', P3: 'P1' }, two
 * merges in a row) is followed to its end. No model call, and no text is lost.
 * @param {import('./types.js').FilmScript} script
 * @param {Object<string, string>} remap  { [dropId]: keepId }, as cast.mergeCharacters returns it
 * @returns {import('./types.js').FilmScript}
 */
export function remapTokens(script, remap) {
  const map = new Map(Object.entries(isObject(remap) ? remap : {}).filter(([from, to]) => isCharacterId(from) && isCharacterId(to) && from !== to));
  const target = (id) => {
    let now = id;
    // A loop in the map (P7 to P3 and back) must not hang: stop when an id comes round again.
    const seen = new Set([id]);
    while (map.has(now) && !seen.has(map.get(now))) {
      now = map.get(now);
      seen.add(now);
    }
    return now;
  };
  const swap = (text) => (typeof text === 'string' ? text.replace(tokenPattern(), (_, n) => tokenFor(target(`P${n}`))) : text);

  const cues = (Array.isArray(script?.cues) ? script.cues : []).map((cue) => {
    if (!isObject(cue)) return cue;
    const people = [];
    for (const person of (Array.isArray(cue.people) ? cue.people : []).filter(isObject)) {
      const char = target(person.char);
      const at = people.findIndex((p) => p.char === char);
      if (at < 0) {
        people.push(char === person.char ? person : { ...person, char });
        continue;
      }
      // Two entries are now one person: seen on the tracks of both, and not
      // demoted when either was seen.
      const one = { ...people[at] };
      const tracks = [...new Set([...(one.tracks || []), ...(person.tracks || [])])];
      if (one.tracks || person.tracks) one.tracks = tracks;
      if (one.demoted && person.demoted) one.demoted = true;
      else delete one.demoted;
      people[at] = one;
    }
    const next = { ...cue, brief: swap(cue.brief), standard: swap(cue.standard), detailed: swap(cue.detailed), people };
    const same = VERSIONS.every((v) => next[v] === cue[v]) && Array.isArray(cue.people) && people.length === cue.people.length && people.every((p, i) => p === cue.people[i]);
    return same ? cue : next;
  });
  return { ...script, cues };
}

/**
 * A person's edit of one cue. Only brief, standard, detailed, kind, priority,
 * status and onScreenText can be changed; times, slot and id cannot. The cue
 * becomes by 'human', so a later answer of the model never replaces it, and an
 * 'ai' cue becomes 'edited' unless the patch says another status. A
 * 'needs-check' cue (one that is not spoken) becomes 'edited' only when all
 * three versions were rewritten, or stays so until the patch gives a status: a
 * version the person did not touch still holds what was refused.
 *
 * Tokens typed with full-width braces are normalised and people follows the
 * tokens. A person's wording is not cut at the model's limits. An empty standard
 * is ignored (every cue has one); an empty brief or detailed means "the same as
 * standard". An unknown id, or a patch with nothing usable in it, returns the
 * script unchanged.
 * @param {import('./types.js').FilmScript} script
 * @param {string} id
 * @param {{brief?: string, standard?: string, detailed?: string, kind?: string, priority?: number,
 *   status?: string, onScreenText?: string}} patch
 * @returns {import('./types.js').FilmScript}
 */
export function editCue(script, id, patch) {
  const cues = Array.isArray(script?.cues) ? script.cues : [];
  const index = cues.findIndex((c) => isObject(c) && c.id === id);
  if (index < 0 || !isObject(patch)) return script;
  const old = cues[index];
  const next = { ...old };
  let touched = false;
  // How many of the three versions the patch rewrote. An empty standard is ignored, so it does not count.
  let rewritten = 0;

  for (const version of VERSIONS) {
    if (typeof patch[version] !== 'string') continue;
    const text = canonicalTokens(patch[version].replace(/\s+/g, ' ').trim());
    if (!text && version === 'standard') continue;
    next[version] = text;
    touched = true;
    rewritten += 1;
  }
  if (!next.brief) next.brief = next.standard;
  if (!next.detailed) next.detailed = next.standard;

  if (KINDS.includes(patch.kind)) {
    next.kind = patch.kind;
    touched = true;
  }
  const priority = priorityOf(patch.priority, 0);
  if (priority) {
    next.priority = priority;
    touched = true;
  }
  // Only a text cue carries a transcription: one typed for another kind is not kept,
  // and a cue that stops being a text cue loses its own.
  let screen = old.onScreenText;
  if (typeof patch.onScreenText === 'string' && next.kind === 'text') {
    screen = cleanScreenText(patch.onScreenText);
    touched = true;
  }
  delete next.onScreenText;
  if (next.kind === 'text' && screen) next.onScreenText = screen;

  if (STATUSES.includes(patch.status)) {
    next.status = patch.status;
    touched = true;
  } else if (touched && (!STATUSES.includes(old.status) || old.status === 'ai' || (old.status === 'needs-check' && rewritten === VERSIONS.length))) {
    // 'needs-check' keeps a cue from being spoken: only new wording for all three
    // versions lifts it, so that no version that was refused is spoken unread. A
    // person who has read the others says so with patch.status.
    next.status = 'edited';
  }
  if (!touched) return script;

  if (rewritten) next.people = peopleIn([next.standard, next.brief, next.detailed], cleanPeople(old.people));
  next.by = 'human';
  return { ...script, cues: cues.map((cue, i) => (i === index ? next : cue)) };
}

/**
 * Rendered cues as the extension's version-2 script, so the existing player
 * (Playback, chooseUtterance, the scheduler) plays a film without knowing it is
 * one. The room of a slot was measured from the dialogue, so gapMeasured is true
 * and the player keeps no margin back. Silent cues (a token was left in them)
 * are left out; the player knows two kinds, so 'intro' and 'extended' are 'visual'.
 * @param {import('./types.js').RenderedCue[]} renderedCues  from namegate.renderScript
 * @param {{videoId: string, lang: string, duration: number}} film
 * @returns {{version: number, videoId: string, lang: string, duration: number, cues: object[],
 *   characters: [], completedUntil: number, complete: true, model: 'film'}}
 */
export function toPlayerScript(renderedCues, { videoId, lang, duration } = {}) {
  const total = finite(duration) && duration > 0 ? duration : 0;
  const cues = (Array.isArray(renderedCues) ? renderedCues : [])
    .filter((c) => isObject(c) && !c.silent && finite(c.start) && typeof c.standard === 'string' && c.standard)
    .map((c) => ({
      id: c.id,
      start: c.start,
      gap: finite(c.room) && c.room >= 0 ? c.room : Math.max(0, finite(c.end) ? c.end - c.start : 0),
      gapMeasured: true,
      kind: c.kind === 'text' ? 'text' : 'visual',
      priority: priorityOf(c.priority, 2),
      brief: typeof c.brief === 'string' && c.brief ? c.brief : c.standard,
      standard: c.standard,
      detailed: typeof c.detailed === 'string' && c.detailed ? c.detailed : c.standard,
    }))
    .sort((a, b) => a.start - b.start);
  return {
    version: SCRIPT_VERSION,
    videoId: typeof videoId === 'string' ? videoId : '',
    lang: typeof lang === 'string' ? lang : '',
    duration: total,
    cues,
    characters: [],
    completedUntil: total,
    complete: true,
    model: 'film',
  };
}

/**
 * A short fingerprint of a text: FNV-1a, 32 bits, over the UTF-16 code units,
 * as eight lower-case hex digits. Kept with a recorded or synthesised clip to
 * tell that the words have changed since; not a secret, and not for security.
 * @param {string} text
 * @returns {string}
 */
export function textHash(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The cues whose clip no longer says what the cue says: the hash kept with the
 * clip differs from the hash of the rendered text of the version it was made
 * from. Renaming a character changes the rendered text and not the script, so
 * this is asked of the rendered cues. A cue that was not rendered cannot be
 * compared and is not listed.
 * @param {import('./types.js').FilmScript} script
 * @param {import('./types.js').RenderedCue[]} renderedCues
 * @returns {string[]} cue ids, in the script's order
 */
export function staleClips(script, renderedCues) {
  const rendered = new Map();
  for (const cue of Array.isArray(renderedCues) ? renderedCues : []) {
    if (isObject(cue)) rendered.set(cue.id, cue);
  }
  const stale = [];
  for (const cue of Array.isArray(script?.cues) ? script.cues : []) {
    if (!isObject(cue?.clip)) continue;
    const now = rendered.get(cue.id);
    if (!now) continue;
    const version = VERSIONS.includes(cue.clip.version) ? cue.clip.version : 'standard';
    if (textHash(now[version]) !== cue.clip.textHash) stale.push(cue.id);
  }
  return stale;
}
