// The cast registry of a film: who the characters are, what each is called, how
// sure that name is, and what each is wearing when. A character is not a face
// cluster: one character may have several clusters (ages, make-up), and the
// cast carries names and text only. Every function returns a new cast and
// leaves the one it was given alone. The contract is in README.md in this folder.

import { parseTime } from '../shared/script.js';
import { DEFAULT_POLICY, EVIDENCE_KINDS, LEVEL, MAX_CHARACTER_NUMBER, NAMING, isCharacterId } from './types.js';

/** Hard limits in characters, so junk in a file cannot grow without end. */
const MAX_NAME = 80;
const MAX_LABEL = 120;
const MAX_QUOTE = 300;

/** How a person confirmed a name: by listening, or as a sighted person looking at the picture. */
const CONFIRMED_BY = Object.freeze(['ear', 'sight']);

/** The fields of a character updateCharacter may change. Names, levels and evidence have their own doors. */
const PATCHABLE = Object.freeze(['descriptor', 'say', 'main', 'screenSec', 'revealAt', 'spoilerLock', 'neverName', 'aliases', 'clusters']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const numberOf = (id) => Number(id.slice(1));

/**
 * A time in the film in seconds, from a number or from "3:12" as a model or a
 * person may write it. NaN when the value is not a time.
 */
function seconds(value) {
  const s = parseTime(value);
  return Number.isFinite(s) && s >= 0 ? s : NaN;
}

/** The time a caller passed in for the record, or null: this module never reads a clock. */
function when(value) {
  const s = seconds(value);
  return Number.isFinite(s) ? s : null;
}

/**
 * A name, label or outfit as it is stored: one line, trimmed, within a limit.
 * Braces are removed: the name gate does not speak a text that still holds
 * one, so a stray brace in a name would silence every cue of that character.
 */
function words(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/[{}｛｝]/g, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}

/**
 * What two spellings of one name have in common: "MATTHEW" in the credits and
 * "Matthew" in a line of dialogue are one name, and so are full-width and
 * half-width letters.
 */
const nameKey = (name) => String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const sameName = (a, b) => nameKey(a) === nameKey(b);

function cleanPolicy(raw) {
  const p = isObject(raw) ? raw : {};
  const span = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  return {
    naming: NAMING.includes(p.naming) ? p.naming : DEFAULT_POLICY.naming,
    minLevel: p.minLevel === LEVEL.CLUES || p.minLevel === LEVEL.CONFIRMED ? p.minLevel : DEFAULT_POLICY.minLevel,
    introBeforeFilm: typeof p.introBeforeFilm === 'boolean' ? p.introBeforeFilm : DEFAULT_POLICY.introBeforeFilm,
    reanchorAfterSec: span(p.reanchorAfterSec, DEFAULT_POLICY.reanchorAfterSec),
    independentGapSec: span(p.independentGapSec, DEFAULT_POLICY.independentGapSec),
  };
}

/** One piece of name evidence, or null when it says nothing usable. */
function cleanEvidence(raw) {
  if (!isObject(raw) || !EVIDENCE_KINDS.includes(raw.kind)) return null;
  const name = words(raw.name, MAX_NAME);
  if (!name) return null;
  const human = raw.kind === 'human';
  let t = seconds(raw.t);
  if (!Number.isFinite(t)) {
    // A clue with no place in the film cannot be told apart from another clue; a person's word needs no time.
    if (!human) return null;
    t = 0;
  }
  const out = { t, kind: raw.kind, name };
  if (human && CONFIRMED_BY.includes(raw.by)) out.by = raw.by;
  // The names prompt calls the line of dialogue "line".
  const quote = words(raw.quote ?? raw.line, MAX_QUOTE);
  if (quote) out.quote = quote;
  // Anything truthy counts: leaving a clue out is the safe mistake.
  if (raw.rejected) out.rejected = true;
  return out;
}

/** Aliases as { text, lang?, kind?, validFrom? }, each text once. A package gives them as plain strings. */
function cleanAliases(raw) {
  const out = [];
  const seen = new Set();
  for (const item of list(raw)) {
    const from = typeof item === 'string' ? { text: item } : item;
    if (!isObject(from)) continue;
    const text = words(from.text, MAX_NAME);
    const key = nameKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    const alias = { text };
    const lang = words(from.lang, 20);
    if (lang) alias.lang = lang;
    const kind = words(from.kind, 40);
    if (kind) alias.kind = kind;
    const validFrom = seconds(from.validFrom);
    if (Number.isFinite(validFrom)) alias.validFrom = validFrom;
    out.push(alias);
  }
  return out;
}

/**
 * The visual label in Chinese and English. The English one is stored without
 * an article ("woman with long hair"): the name gate adds "the" or "a".
 */
function cleanDescriptor(raw) {
  const d = isObject(raw) ? raw : {};
  const out = {};
  const zh = words(d.zh, MAX_LABEL);
  if (zh) out.zh = zh;
  const en = words(d.en, MAX_LABEL).replace(/^(?:the|an|a)\s+/i, '');
  if (en) out.en = en;
  return out;
}

function cleanClusters(raw) {
  const out = [];
  for (const item of list(raw)) {
    const id = typeof item === 'number' && Number.isFinite(item) ? String(item) : typeof item === 'string' ? item.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** One appearance, or null when it has no character, no start, no outfit or no length. */
function cleanAppearance(raw) {
  if (!isObject(raw) || !isCharacterId(raw.char)) return null;
  const from = seconds(raw.from);
  const outfit = words(raw.outfit, MAX_LABEL);
  if (!Number.isFinite(from) || !outfit) return null;
  let to = null;
  if (raw.to !== null && raw.to !== undefined) {
    const end = seconds(raw.to);
    if (Number.isFinite(end)) {
      if (end <= from) return null;
      to = end;
    }
  }
  const out = { char: raw.char, from, to, outfit };
  if (typeof raw.scene === 'number' && Number.isFinite(raw.scene) && raw.scene >= 0) out.scene = raw.scene;
  out.src = raw.src === 'human' ? 'human' : 'model';
  return out;
}

/**
 * The appearances of one character as a timeline: in time order, none
 * overlapping the next, only the last one open. Of two that start at the same
 * moment the later in the list stays; a neighbour in the same outfit is joined on.
 */
function timeline(entries) {
  const sorted = [...entries].sort((a, b) => a.from - b.from);
  const out = [];
  sorted.forEach((a, i) => {
    const next = sorted[i + 1];
    const to = next && (a.to === null || a.to > next.from) ? next.from : a.to;
    if (to !== null && to <= a.from) return;
    const prev = out[out.length - 1];
    if (prev && prev.to === a.from && sameName(prev.outfit, a.outfit)) out[out.length - 1] = { ...prev, to };
    else out.push({ ...a, to });
  });
  return out;
}

/** Every character's timeline, in one list by start time (then by character number, so the order never depends on history). */
function tidyAppearances(entries) {
  const byChar = new Map();
  for (const a of entries) byChar.set(a.char, [...(byChar.get(a.char) || []), a]);
  const out = [];
  for (const mine of byChar.values()) out.push(...timeline(mine));
  return out.sort((a, b) => a.from - b.from || numberOf(a.char) - numberOf(b.char));
}

/** Groups of ids that must, or must never, be one character: at least two ids each. */
function cleanConstraints(raw) {
  const c = isObject(raw) ? raw : {};
  const groups = (value) => list(value)
    .map((group) => [...new Set(list(group).filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))])
    .filter((group) => group.length >= 2);
  return { mustLink: groups(c.mustLink), cannotLink: groups(c.cannotLink) };
}

/**
 * One entry of the record of what people changed. The record is open: a later
 * version may write kinds this one does not know, and an append-only record
 * must not lose them, so every plain value of an entry with a type is kept.
 */
function cleanEvent(raw) {
  if (!isObject(raw) || typeof raw.type !== 'string' || !raw.type.trim()) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

/**
 * The names a person refused for a character: a name with a rejected entry and
 * no confirmation still standing. A refusal lasts: later clues for the name do
 * not bring it back.
 */
function refusedNames(evidence) {
  const rejected = new Set();
  const upheld = new Set();
  for (const e of evidence) {
    if (e.rejected) rejected.add(nameKey(e.name));
    else if (e.kind === 'human') upheld.add(nameKey(e.name));
  }
  return new Set([...rejected].filter((key) => !upheld.has(key)));
}

/**
 * The reveal point after the evidence changed. A time no clue has was set by a
 * person and stays. Null, or a time a clue set, follows the name that stands: it
 * stays while a live clue for that name is at that time, else it is the earliest
 * live clue for the name, and null when there is none (the next clue sets it).
 * A person's confirmation is not a clue: it says nothing about where the film
 * gives the name.
 */
function revealFor(ch) {
  const clues = ch.evidence.filter((e) => e.kind !== 'human');
  const forName = (e) => !e.rejected && ch.name !== null && sameName(e.name, ch.name);
  const setHere = clues.filter((e) => e.t === ch.revealAt);
  if (ch.revealAt !== null && (!setHere.length || setHere.some(forName))) return ch.revealAt;
  const times = clues.filter(forName).map((e) => e.t);
  return times.length ? Math.min(...times) : null;
}

/**
 * Name and level as the evidence has them. Where the evidence says nothing, a
 * name the character carries without evidence (from a package) stays, below
 * level 3, unless a person refused it. The pronunciation belongs to the name:
 * it goes when the name changes.
 */
function settle(ch, gap) {
  const found = levelFromEvidence(ch.evidence, { independentGapSec: gap });
  let { name, level } = found;
  if (name === null && ch.name !== null && !ch.evidence.some((e) => e.rejected && sameName(e.name, ch.name))) {
    name = ch.name;
    level = Math.min(LEVEL.CLUES, Math.max(LEVEL.CLUE, ch.level));
  }
  const next = { ...ch, name, level };
  if (next.say !== undefined && ch.name !== null && (name === null || !sameName(name, ch.name))) delete next.say;
  return next;
}

/**
 * A character with every field in place and nothing else, or null when it has
 * no valid id. `confirmedBy` is read from a package's character (exportCast).
 */
function cleanCharacter(raw, gap) {
  if (!isObject(raw) || !isCharacterId(raw.id)) return null;
  const name = words(raw.name, MAX_NAME) || null;
  const level = name !== null && [LEVEL.CLUE, LEVEL.CLUES, LEVEL.CONFIRMED].includes(raw.level) ? raw.level : LEVEL.LABEL;
  let evidence = list(raw.evidence).map(cleanEvidence).filter(Boolean);
  // A confirmed name that arrives without the person's word behind it (a package carries names, not evidence)
  // gets that word here, so that a later clue cannot unseat it and a rejection or a merge treats it as any other.
  const spokenFor = evidence.some((e) => (e.kind === 'human' && !e.rejected) || (e.rejected && sameName(e.name, name)));
  if (level === LEVEL.CONFIRMED && !spokenFor) {
    const carried = { t: 0, kind: 'human', name };
    if (CONFIRMED_BY.includes(raw.confirmedBy)) carried.by = raw.confirmedBy;
    evidence = [...evidence, carried];
  }
  const say = words(raw.say, MAX_NAME);
  const revealAt = seconds(raw.revealAt);
  return settle({
    id: raw.id,
    name,
    level,
    aliases: cleanAliases(raw.aliases),
    ...(say ? { say } : {}),
    descriptor: cleanDescriptor(raw.descriptor),
    revealAt: Number.isFinite(revealAt) ? revealAt : null,
    // Anything truthy locks: not naming someone is the safe mistake.
    spoilerLock: Boolean(raw.spoilerLock),
    neverName: Boolean(raw.neverName),
    main: raw.main === true,
    screenSec: typeof raw.screenSec === 'number' && Number.isFinite(raw.screenSec) && raw.screenSec > 0 ? raw.screenSec : 0,
    evidence,
    clusters: cleanClusters(raw.clusters),
  }, gap);
}

/** The six parts of a cast, whatever else the object holds. Throws Error('bad-cast') when it is not an object. */
function parts(cast) {
  if (!isObject(cast)) throw new Error('bad-cast');
  return {
    v: 1,
    policy: isObject(cast.policy) ? cast.policy : { ...DEFAULT_POLICY },
    characters: list(cast.characters),
    appearances: list(cast.appearances),
    constraints: isObject(cast.constraints) ? cast.constraints : { mustLink: [], cannotLink: [] },
    events: list(cast.events),
  };
}

const gapOf = (policy) => cleanPolicy(policy).independentGapSec;

/**
 * The highest character number this cast has ever given out: its characters,
 * and the ones the record says were merged away. A number is not used twice:
 * a script, a recorded clip or a section still being written may hold the old
 * token, and it must not come to mean somebody else.
 */
function highestNumber(characters, events) {
  let max = 0;
  const see = (id) => {
    if (isCharacterId(id)) max = Math.max(max, numberOf(id));
  };
  for (const c of characters) if (isObject(c)) see(c.id);
  for (const e of events) {
    if (!isObject(e)) continue;
    see(e.char);
    see(e.keep);
    see(e.drop);
  }
  return max;
}

/**
 * Change one character. `edit` gets the character (clean) and returns
 * { character, event? }, or null for no change; an unknown id is no change.
 * Name and level are settled again from the evidence in every case, and the
 * reveal point whenever the evidence itself changed (see revealFor).
 */
function withCharacter(cast, id, edit) {
  const base = parts(cast);
  const index = base.characters.findIndex((c) => isObject(c) && c.id === id);
  if (index < 0) return cast;
  const gap = gapOf(base.policy);
  const current = cleanCharacter(base.characters[index], gap);
  if (!current) return cast;
  const result = edit(current);
  if (!result) return cast;
  const settled = settle(result.character, gap);
  if (result.character.evidence !== current.evidence) settled.revealAt = revealFor(settled);
  const characters = base.characters.slice();
  characters[index] = cleanCharacter(settled, gap);
  return { ...base, characters, events: result.event ? [...base.events, result.event] : base.events };
}

/**
 * An empty cast.
 * @param {{policy?: Partial<import('./types.js').Policy>}} [options]  the naming policy; what is
 *   missing or not valid comes from DEFAULT_POLICY
 * @returns {import('./types.js').Cast}
 */
export function createCast(options) {
  return {
    v: 1,
    policy: cleanPolicy(isObject(options) ? options.policy : undefined),
    characters: [],
    appearances: [],
    constraints: { mustLink: [], cannotLink: [] },
    events: [],
  };
}

/**
 * A cast read from a file or a package, with every field checked: unknown
 * fields are dropped, values of the wrong type become the default, characters
 * without a valid id (or with one already seen) and appearances of nobody are
 * left out, and overlapping appearances are put in order. Name and level follow
 * the evidence where there is any; a name carried without evidence is kept, and
 * a confirmed one (a package's `confirmedBy`) is recorded as a person's word.
 * @param {object} raw
 * @returns {import('./types.js').Cast}
 * @throws {Error} 'bad-cast' when raw is not an object
 */
export function validateCast(raw) {
  if (!isObject(raw)) throw new Error('bad-cast');
  const policy = cleanPolicy(raw.policy);
  const characters = [];
  const ids = new Set();
  for (const item of list(raw.characters)) {
    const ch = cleanCharacter(item, policy.independentGapSec);
    if (!ch || ids.has(ch.id)) continue;
    ids.add(ch.id);
    characters.push(ch);
  }
  return {
    v: 1,
    policy,
    characters,
    appearances: tidyAppearances(list(raw.appearances).map(cleanAppearance).filter((a) => a && ids.has(a.char))),
    constraints: cleanConstraints(raw.constraints),
    events: list(raw.events).map(cleanEvent).filter(Boolean),
  };
}

/**
 * The character with this id.
 * @returns {import('./types.js').Character | undefined}
 */
export function getCharacter(cast, id) {
  return list(cast?.characters).find((c) => isObject(c) && c.id === id);
}

/**
 * Add a character. Its id is 'P' + (the highest number ever given out + 1):
 * the number of a character that was merged away is not given out again.
 * @param {import('./types.js').Cast} cast
 * @param {object} [fields]  any fields of a character except the id; name and level follow the
 *   evidence when evidence is given
 * @returns {{cast: import('./types.js').Cast, id: string}}
 * @throws {Error} 'cast-full' when P999999, the last id a token can carry, was already given out
 */
export function addCharacter(cast, fields) {
  const base = parts(cast);
  const number = highestNumber(base.characters, base.events) + 1;
  // A number is not used twice, so past the last one there is no id to give.
  if (number > MAX_CHARACTER_NUMBER) throw new Error('cast-full');
  const id = `P${number}`;
  const character = cleanCharacter({ ...(isObject(fields) ? fields : {}), id }, gapOf(base.policy));
  return { cast: { ...base, characters: [...base.characters, character] }, id };
}

/**
 * Change what a person or the analysis may change freely: descriptor, say,
 * main, screenSec, revealAt, spoilerLock, neverName, aliases, clusters. Each
 * field given replaces the old one (a new descriptor in one language drops the
 * other, which would describe the old label); `say: ''` and `revealAt: null`
 * clear. Other keys and values of the wrong type are ignored, and so is an
 * unknown id. A person's "never name" is better made with neverName(), which
 * also records it.
 * @returns {import('./types.js').Cast}
 */
export function updateCharacter(cast, id, patch) {
  if (!isObject(patch) || !PATCHABLE.some((key) => key in patch)) return isObject(cast) ? cast : parts(cast);
  return withCharacter(cast, id, (ch) => {
    const next = { ...ch };
    if (isObject(patch.descriptor)) next.descriptor = cleanDescriptor(patch.descriptor);
    if (typeof patch.say === 'string' || patch.say === null) {
      const say = words(patch.say, MAX_NAME);
      if (say) next.say = say;
      else delete next.say;
    }
    if (typeof patch.main === 'boolean') next.main = patch.main;
    if (typeof patch.screenSec === 'number' && Number.isFinite(patch.screenSec) && patch.screenSec >= 0) next.screenSec = patch.screenSec;
    if (patch.revealAt === null) next.revealAt = null;
    else if (Number.isFinite(seconds(patch.revealAt))) next.revealAt = seconds(patch.revealAt);
    if (typeof patch.spoilerLock === 'boolean') next.spoilerLock = patch.spoilerLock;
    if (typeof patch.neverName === 'boolean') next.neverName = patch.neverName;
    if (Array.isArray(patch.aliases)) next.aliases = cleanAliases(patch.aliases);
    if (Array.isArray(patch.clusters)) next.clusters = cleanClusters(patch.clusters);
    return { character: next };
  });
}

/**
 * The name the evidence gives a character, and how sure it is.
 * A person's confirmation that was not rejected wins: its name, level 3. Of
 * several, the one made last (the last in the list) stands, whatever its time
 * in the film: a person who goes back and renames has still spoken last.
 * Otherwise the clues that are independent of each other are counted per name,
 * in time order: a clue counts when it is at least independentGapSec from
 * every clue already counted for the name, or of another kind. No clue is
 * { name: null, level: 0 }; the name with most clues has level 1 (one clue) or
 * 2 (two or more); when two names have as many, the one evidenced earlier is
 * given, at level 1. Spellings that differ only in case or width are one name.
 * @param {import('./types.js').Evidence[]} evidence
 * @param {{independentGapSec?: number}} [options]  DEFAULT_POLICY's when missing
 * @returns {{name: string|null, level: 0|1|2|3}}
 */
export function levelFromEvidence(evidence, options) {
  const independentGapSec = isObject(options) ? options.independentGapSec : undefined;
  const gap = typeof independentGapSec === 'number' && independentGapSec >= 0 ? independentGapSec : DEFAULT_POLICY.independentGapSec;
  const live = list(evidence).map(cleanEvidence).filter((e) => e && !e.rejected);

  for (let i = live.length - 1; i >= 0; i -= 1) {
    if (live[i].kind === 'human') return { name: live[i].name, level: LEVEL.CONFIRMED };
  }

  // Names in the order of their first clue, so the earlier-evidenced name is met first.
  const names = new Map();
  for (const clue of [...live].sort((a, b) => a.t - b.t)) {
    const key = nameKey(clue.name);
    const entry = names.get(key) || { name: clue.name, counted: [] };
    if (entry.counted.every((c) => clue.t - c.t >= gap || clue.kind !== c.kind)) entry.counted.push(clue);
    names.set(key, entry);
  }
  let best = null;
  let tie = false;
  for (const entry of names.values()) {
    if (!best || entry.counted.length > best.counted.length) {
      best = entry;
      tie = false;
    } else if (entry.counted.length === best.counted.length) tie = true;
  }
  if (!best) return { name: null, level: LEVEL.LABEL };
  return { name: best.name, level: best.counted.length >= 2 && !tie ? LEVEL.CLUES : LEVEL.CLUE };
}

/** A person's confirmation, appended and recorded. Shared by confirmName and addEvidence. */
function confirm(cast, id, entry, t) {
  return withCharacter(cast, id, (ch) => ({
    character: { ...ch, evidence: [...ch.evidence, entry] },
    event: { type: 'confirm', char: id, name: entry.name, by: entry.by || null, t: when(t) },
  }));
}

/**
 * Add one clue to a character's name: appended, then name and level are set
 * from levelFromEvidence, and revealAt, when it is null or came from a clue for
 * a name that no longer stands, becomes the time of the earliest clue for the
 * name that stands (a time a person set stays). The same clue twice is added
 * once. A clue for a name a person refused for this character is kept as
 * rejected: it does not bring the name back. An entry of kind 'human' is a
 * confirmation, as with confirmName.
 * Evidence that cannot be used (no name, an unknown kind, a clue with no
 * time) and an unknown id change nothing.
 * @param {import('./types.js').Cast} cast
 * @param {string} id
 * @param {import('./types.js').Evidence} evidence
 * @returns {import('./types.js').Cast}
 */
export function addEvidence(cast, id, evidence) {
  const entry = cleanEvidence(evidence);
  if (!entry) return isObject(cast) ? cast : parts(cast);
  if (entry.kind === 'human' && !entry.rejected) return confirm(cast, id, entry, evidence.t);
  return withCharacter(cast, id, (ch) => {
    const key = nameKey(entry.name);
    const same = (e) => e.kind === entry.kind && e.t === entry.t && nameKey(e.name) === key && (e.quote || '') === (entry.quote || '');
    if (ch.evidence.some(same)) return null;
    const refused = refusedNames(ch.evidence).has(key);
    const evidenceNow = [...ch.evidence, refused ? { ...entry, rejected: true } : entry];
    return { character: { ...ch, evidence: evidenceNow } };
  });
}

/**
 * A person says what a character is called: the name goes to level 3 and no
 * clue can change it. Also how a person renames: the confirmation made last
 * stands. `by` says how the person knows: 'ear' (listening) or 'sight' (a
 * sighted person checked the picture); a package states which. `t` is where in
 * the film the person was. A reveal point that a clue for another name set
 * moves to the earliest clue for this one, or to null (see addEvidence). An
 * empty name and an unknown id change nothing.
 * @param {import('./types.js').Cast} cast
 * @param {string} id
 * @param {{name: string, by?: 'ear'|'sight', t?: number}} confirmation
 * @returns {import('./types.js').Cast}
 */
export function confirmName(cast, id, confirmation) {
  const { name, by, t } = isObject(confirmation) ? confirmation : {};
  const entry = cleanEvidence({ kind: 'human', name, by, t });
  if (!entry) return isObject(cast) ? cast : parts(cast);
  return confirm(cast, id, entry, t);
}

/**
 * A person says a name is not this character's: every entry for the name is
 * marked rejected, a person's own confirmation too, and name and level are
 * worked out again from what is left (an earlier confirmation of another name,
 * the other clues, or nothing), and so is a reveal point that a clue for the
 * refused name set. The refusal lasts: see addEvidence. A name the
 * character does not have, in evidence or as its name, changes nothing.
 * @param {import('./types.js').Cast} cast
 * @param {string} id
 * @param {string} name
 * @param {{t?: number}} [options]  where in the film the person was, for the record
 * @returns {import('./types.js').Cast}
 */
export function rejectName(cast, id, name, options) {
  const t = isObject(options) ? options.t : undefined;
  const given = words(name, MAX_NAME);
  if (!given) return isObject(cast) ? cast : parts(cast);
  return withCharacter(cast, id, (ch) => {
    const key = nameKey(given);
    const standing = ch.evidence.some((e) => !e.rejected && nameKey(e.name) === key);
    const carried = ch.name !== null && nameKey(ch.name) === key;
    if (!standing && !carried) return null;
    let evidence = ch.evidence.map((e) => (!e.rejected && nameKey(e.name) === key ? { ...e, rejected: true } : e));
    // A name carried without evidence has nothing to mark: the refusal itself is written down, so it lasts.
    if (!evidence.some((e) => nameKey(e.name) === key)) evidence = [...evidence, { t: when(t) ?? 0, kind: 'human', name: ch.name, rejected: true }];
    return { character: { ...ch, evidence }, event: { type: 'reject', char: id, name: given, t: when(t) } };
  });
}

/**
 * A person asks that a character is never named (or, with `on` false, takes
 * that back). Nothing changes when it is already so.
 * @param {import('./types.js').Cast} cast
 * @param {string} id
 * @param {boolean} [on]
 * @param {{t?: number}} [options]  where in the film the person was, for the record
 * @returns {import('./types.js').Cast}
 */
export function neverName(cast, id, on = true, options) {
  const t = isObject(options) ? options.t : undefined;
  const flag = Boolean(on);
  return withCharacter(cast, id, (ch) => {
    if (ch.neverName === flag) return null;
    return { character: { ...ch, neverName: flag }, event: { type: 'neverName', char: id, on: flag, t: when(t) } };
  });
}

/** When the name of a merged character may be said: a secret on either side stays one. */
function mergedReveal(keep, drop) {
  if (keep.spoilerLock && drop.spoilerLock) return keep.revealAt === null || drop.revealAt === null ? null : Math.max(keep.revealAt, drop.revealAt);
  // One side locked: its reveal point, also when that is null (never), whatever the other side's clues say.
  if (drop.spoilerLock) return drop.revealAt;
  if (keep.spoilerLock) return keep.revealAt;
  return keep.revealAt ?? drop.revealAt;
}

/**
 * Two characters turn out to be one person. Evidence, aliases, clusters and
 * appearances move to keepId and the other character is removed; name and
 * level are worked out again. A confirmed name on either side survives, and
 * the kept side wins when both have one; a name a person refused on one side
 * is refused for the merged character unless a confirmation still stands.
 * screenSec adds up; main, neverName and spoilerLock hold if either had them.
 * The reveal point is the locked side's (the later one when both are locked),
 * else the kept side's, and when a clue for a name that lost the merge set it,
 * the earliest clue for the name that stands.
 * The caller rewrites tokens with the remap (filmscript.js remapTokens).
 * Unknown ids, or the same id twice, change nothing and give an empty remap.
 * @param {import('./types.js').Cast} cast
 * @param {string} keepId
 * @param {string} dropId
 * @param {{t?: number}} [options]  where in the film the person was, for the record
 * @returns {{cast: import('./types.js').Cast, remap: Object<string, string>}}
 */
export function mergeCharacters(cast, keepId, dropId, options) {
  const t = isObject(options) ? options.t : undefined;
  const base = parts(cast);
  const gap = gapOf(base.policy);
  const find = (id) => base.characters.findIndex((c) => isObject(c) && c.id === id);
  const k = find(keepId);
  const d = find(dropId);
  const keep = k >= 0 ? cleanCharacter(base.characters[k], gap) : null;
  const drop = d >= 0 && d !== k ? cleanCharacter(base.characters[d], gap) : null;
  if (!keep || !drop) return { cast, remap: {} };

  // The kept character's clues come first and its confirmations last: among equals the earlier clue
  // and the last confirmation decide, so the kept side wins both ways.
  const human = (e) => e.kind === 'human';
  const joined = [
    ...keep.evidence.filter((e) => !human(e)),
    ...drop.evidence.filter((e) => !human(e)),
    ...drop.evidence.filter(human),
    ...keep.evidence.filter(human),
  ];
  const refused = refusedNames(joined);
  const evidence = joined.map((e) => (!e.rejected && refused.has(nameKey(e.name)) ? { ...e, rejected: true } : e));

  const carrier = keep.name !== null ? keep : drop;
  const merged = settle({
    ...keep,
    name: carrier.name,
    level: carrier.level,
    aliases: cleanAliases([...keep.aliases, ...drop.aliases]),
    // A label the kept character lacks in one language is taken from the other.
    descriptor: { ...drop.descriptor, ...keep.descriptor },
    revealAt: mergedReveal(keep, drop),
    spoilerLock: keep.spoilerLock || drop.spoilerLock,
    neverName: keep.neverName || drop.neverName,
    main: keep.main || drop.main,
    screenSec: keep.screenSec + drop.screenSec,
    evidence,
    clusters: cleanClusters([...keep.clusters, ...drop.clusters]),
  }, gap);
  // A locked side's null means never and stays; a time from a clue for a name that lost does not.
  if (merged.revealAt !== null) merged.revealAt = revealFor(merged);
  // The pronunciation goes with the name it was given for.
  delete merged.say;
  const sayOf = [keep, drop].find((c) => c.say && c.name !== null && merged.name !== null && sameName(c.name, merged.name));
  if (sayOf) merged.say = sayOf.say;

  // The dropped character's appearances go first, so that where both start at the same moment the kept one stays.
  const clean = base.appearances.map(cleanAppearance).filter(Boolean);
  const appearances = tidyAppearances([
    ...clean.filter((a) => a.char !== keepId && a.char !== dropId),
    ...clean.filter((a) => a.char === dropId).map((a) => ({ ...a, char: keepId })),
    ...clean.filter((a) => a.char === keepId),
  ]);

  const characters = base.characters.filter((_, i) => i !== d).map((c) => (isObject(c) && c.id === keepId ? cleanCharacter(merged, gap) : c));
  return {
    cast: { ...base, characters, appearances, events: [...base.events, { type: 'merge', keep: keepId, drop: dropId, t: when(t) }] },
    remap: { [dropId]: keepId },
  };
}

/**
 * The outfit a character wears from `from` on. The appearance current at that
 * moment is closed there; the new one lasts until the next change already
 * known, or stays open. Nothing changes when the outfit is the one current at
 * `from`, when the character is not in the cast, or when the outfit or the
 * time is missing.
 * @param {import('./types.js').Cast} cast
 * @param {{char: string, from: number, outfit: string, scene?: number, src?: 'model'|'human'}} appearance
 * @returns {import('./types.js').Cast}
 */
export function setAppearance(cast, appearance) {
  const base = parts(cast);
  const { char, from, outfit, scene, src } = isObject(appearance) ? appearance : {};
  const entry = cleanAppearance({ char, from, to: null, outfit, scene, src });
  if (!entry || !base.characters.some((c) => isObject(c) && c.id === entry.char)) return cast;
  const current = appearanceAt(base, entry.char, entry.from);
  if (current && sameName(current.outfit, entry.outfit)) return cast;
  // The new one goes last: where an appearance already starts at this moment, it is replaced.
  return { ...base, appearances: tidyAppearances([...base.appearances.map(cleanAppearance).filter(Boolean), entry]) };
}

/**
 * What a character is wearing at time t: the appearance that has started and
 * has not ended (`from` <= t < `to`, or still open), or null.
 * @returns {import('./types.js').Appearance | null}
 */
export function appearanceAt(cast, charId, t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  let found = null;
  for (const a of list(cast?.appearances)) {
    if (!isObject(a) || a.char !== charId || !(a.from <= t)) continue;
    if (a.to !== null && a.to !== undefined && !(t < a.to)) continue;
    if (!found || a.from >= found.from) found = a;
  }
  return found;
}

/** How the name of a confirmed character was confirmed, from the confirmation that stands. */
function confirmedBy(ch) {
  if (ch.level !== LEVEL.CONFIRMED) return null;
  for (let i = ch.evidence.length - 1; i >= 0; i -= 1) {
    const e = ch.evidence[i];
    if (e.kind === 'human' && !e.rejected) return e.by || null;
  }
  return null;
}

/**
 * The cast as a package may carry it: names and text only. Per character
 * { id, name, level, aliases: [text], say (when set), descriptor, revealAt,
 * spoilerLock, neverName, main, confirmedBy }, then the appearances and the
 * policy. Face clusters, evidence with its lines of dialogue, constraints and
 * the record of changes stay on this computer: the result is built field by
 * field, so nothing else a cast object holds can get out. validateCast reads
 * the result back.
 * @param {import('./types.js').Cast} cast
 * @returns {{v: 1, policy: object, characters: object[], appearances: object[]}}
 */
export function exportCast(cast) {
  const clean = validateCast(cast);
  return {
    v: 1,
    policy: { ...clean.policy },
    characters: clean.characters.map((ch) => ({
      id: ch.id,
      name: ch.name,
      level: ch.level,
      aliases: ch.aliases.map((a) => a.text),
      ...(ch.say ? { say: ch.say } : {}),
      descriptor: { ...ch.descriptor },
      revealAt: ch.revealAt,
      spoilerLock: ch.spoilerLock,
      neverName: ch.neverName,
      main: ch.main,
      confirmedBy: confirmedBy(ch),
    })),
    appearances: clean.appearances.map((a) => ({ ...a })),
  };
}
