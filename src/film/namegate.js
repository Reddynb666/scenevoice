// The name gate: tokens into words. A cue of a film script refers to a person
// only by a character token ({P3}); here every token becomes what a listener is
// told: the visual label ("长发女人"), an introduction that ties the label to the
// name, or the name. Which one depends on the cast (is the name sure enough, is
// it a secret before some point, did a person ask that it is never said), on the
// naming policy, and on what was already said earlier in the film. Nothing here
// asks a model: renaming, confirming or merging a character is a new call of
// renderScript on the same script. The words of the forms, in Chinese and
// English, are data in this module. The contract is in README.md in this folder.

import { estimateSeconds } from '../shared/script.js';
import { appearanceAt, getCharacter } from './cast.js';
import { DEFAULT_POLICY, LEVEL, NAMING, TOKEN_SOURCE, isCharacterId, tokenPattern, tokensIn } from './types.js';
import { normalizeTokens, violations } from './verify.js';

/** The three versions of a cue, shortest first: a long form is said in all of them or in none, and must fit the first. */
const VERSIONS = Object.freeze(['brief', 'standard', 'detailed']);
const KINDS = Object.freeze(['visual', 'text', 'intro', 'extended']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const list = (value) => (Array.isArray(value) ? value : []);
/** A text on one line; '' for anything that is not a text. */
const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * Whether the forms are worded in Chinese. Every other language gets the
 * English forms. "zh_CN", the spelling of the locale files, counts as well as "zh-CN".
 */
const isChinese = (lang) => /^(zh|yue|cmn)(?![a-z])/i.test(String(lang || ''));

/**
 * The naming policy in force: each part from the first layer that states it
 * validly, else from the default. A policy that only lowers the level must not
 * also forget that the cast waits for the reveal. A level below 2 is never
 * accepted: one clue is not a name anybody should hear.
 */
function policyOf(...layers) {
  const given = [...layers.filter(isObject), DEFAULT_POLICY];
  const pick = (key, valid) => given.map((p) => p[key]).find(valid);
  return {
    naming: pick('naming', (v) => NAMING.includes(v)),
    minLevel: pick('minLevel', (v) => v === LEVEL.CLUES || v === LEVEL.CONFIRMED),
    introBeforeFilm: pick('introBeforeFilm', (v) => typeof v === 'boolean'),
    reanchorAfterSec: pick('reanchorAfterSec', (v) => typeof v === 'number' && v >= 0),
  };
}

/**
 * Whether a character's name may be spoken at time t.
 * False when the character has no name; when the name is not sure enough
 * (level below policy.minLevel); when a person asked that it is never said;
 * when the picture did not confirm the character in this cue (demoted); when
 * the identity is a plot secret (spoilerLock) that has no reveal point or whose
 * reveal point is still ahead; and, under the 'on-reveal' policy, before the
 * reveal point of a character that has one. A time that is not a number
 * unlocks nothing: when in doubt the name stays here.
 * @param {import('./types.js').Character} character
 * @param {number} t  seconds into the film
 * @param {Partial<import('./types.js').Policy>} [policy]  what is missing comes from DEFAULT_POLICY
 * @param {{demoted?: boolean}} [options]  demoted: verify.js did not see this character around the cue
 * @returns {boolean}
 */
export function unlocked(character, t, policy, options) {
  if (!isObject(character) || !oneLine(character.name)) return false;
  const rules = policyOf(policy);
  if (!(character.level >= rules.minLevel)) return false;
  if (character.neverName) return false;
  if (isObject(options) && options.demoted) return false;
  if (typeof t !== 'number' || Number.isNaN(t)) return false;
  const revealAt = typeof character.revealAt === 'number' && !Number.isNaN(character.revealAt) ? character.revealAt : null;
  const beforeReveal = revealAt !== null && t < revealAt;
  if (character.spoilerLock && (revealAt === null || beforeReveal)) return false;
  if (rules.naming === 'on-reveal' && beforeReveal) return false;
  return true;
}

// ---- The words of the forms ----

/** A descriptor in a script that takes an English article ("woman with long hair", not "长发女人"). */
const TAKES_ARTICLE = /^[A-Za-z0-9À-ɏ]/;

/** What a stored label or outfit may end in that the forms and the sentence bring themselves. */
const TRAILING = /[\s,，、.。;；!！?？]+$/;

/**
 * The visual label of a character in the language, else in the other one, else
 * ''. The English one is stored without an article; one that slipped in is
 * removed, because the forms add their own, and so is punctuation at its end.
 */
function labelOf(character, zh) {
  const d = isObject(character.descriptor) ? character.descriptor : {};
  const label = oneLine(zh ? d.zh : d.en) || oneLine(zh ? d.en : d.zh);
  return label.replace(TRAILING, '').replace(/^(?:the|an|a)\s+/i, '');
}

/** The label as it is said of someone already seen: "长发女人" / "the woman with long hair"; with no label, "某人" / "someone". */
function saidLabel(label, zh) {
  if (!label) return zh ? '某人' : 'someone';
  return zh || !TAKES_ARTICLE.test(label) ? label : `the ${label}`;
}

/** Written with a consonant or a digit, said with a vowel: "honest", "hour", "heir", "8-year-old", "18th", "1800s". */
const SOUNDS_VOWEL = /^(?:h(?:our|onest|onou?r|eir)|8|1[18](?:\d\d)?(?!\d))/i;
/**
 * Written with a vowel, said with a consonant: "uniformed", "used", "utility",
 * "Ukrainian", "U-shaped", "European", "one-eyed", "once-famous". Not
 * "unidentified", "unimpressed", "uninjured".
 */
const SOUNDS_CONSONANT = /^(?:eu|ewe|on(?:e|ce)(?![a-z])|u(?:ni(?![dmn]|ll)|s[eu]|t[aeio]|k|ri|bi|(?![a-z])))/i;

/**
 * The label as an introduction gives it: "长发女人" / "a woman with long hair"
 * ("an" before a vowel sound: "an honest-looking clerk", "a uniformed officer");
 * '' with no label. Initials said letter by letter ("FBI agent") cannot be told
 * from words by their spelling and get "a".
 */
function newLabel(label, zh) {
  if (!label || zh || !TAKES_ARTICLE.test(label)) return label;
  const an = SOUNDS_VOWEL.test(label) || (/^[aeiou]/i.test(label) && !SOUNDS_CONSONANT.test(label) && !/^U[A-Z]/.test(label));
  return `${an ? 'an' : 'a'} ${label}`;
}

/**
 * An outfit as the forms take it: "红裙子" / "a red dress". The forms add
 * "穿着" / "in" themselves, so a verb a model wrote in front is removed ("穿着",
 * "穿了", a bare "穿" that is not part of a noun such as 穿山甲; "wearing"), and
 * an English article that opens it is written small ("A red dress"). Any other
 * first word may be a proper noun and is left as it is.
 */
function outfitWords(text, zh) {
  const plain = oneLine(text).replace(TRAILING, '');
  if (zh) return plain.replace(/^(?:穿着|穿了|穿上|身穿|身着|穿(?!山甲|孔|搭|戴|堂|越|梭|过))/, '').trim();
  return plain
    .replace(/^(?:wearing|dressed in|in)\s+/i, '')
    .replace(/^(?:the|an|a)(?=\s)/i, (article) => article.toLowerCase())
    .trim();
}

/**
 * An outfit is free text a model or a person wrote, and the forms say it word
 * for word. One that holds a brace, an id, a mark or a name of the cast is not
 * said: the form goes without an outfit. (A brace or an id would silence every
 * cue of the character; a name would be spoken whatever its level.)
 */
function speakable(outfit, cast) {
  if (!outfit || hasResidue(outfit)) return '';
  return violations({ kind: 'visual', standard: outfit }, cast).length ? '' : outfit;
}

/** What two spellings of one outfit have in common (case, width, spacing), as cast.js compares them. */
const outfitKey = (outfit) => outfit.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * "长发女人，穿着红裙子，" / "the woman with long hair, in a red dress,". Without
 * a label the English form is one phrase, "someone in a red dress", and no
 * comma closes it.
 */
function labelOutfitForm(label, outfit, zh) {
  if (zh) return `${saidLabel(label, true)}，穿着${outfit}，`;
  return label ? `${saidLabel(label, false)}, in ${outfit},` : `someone in ${outfit}`;
}

/**
 * The introduction: the one time the name is tied to what the listener can
 * picture.
 *   first-appearance: "马修，长发女人，穿着红裙子，" / "Matthew, a woman with long hair in a red dress,"
 *   on-reveal:        "长发女人，马修，" / "the woman with long hair, Matthew,"
 * `outfit` is '' when none is to be said. With neither a label nor an outfit the
 * introduction is the name alone; with an outfit and no label the name comes
 * first under either policy ("马修，穿着红裙子，" / "Matthew, in a red dress,").
 * In English a label the listener has already heard (`labelSaid`: a deferred
 * introduction, a first mention the picture did not confirm, a secret kept to
 * its reveal) is "the woman", not "a woman", who would be another one:
 * "Matthew, the woman with long hair, in a red dress,".
 */
function introForm(naming, name, label, outfit, zh, labelSaid) {
  if (naming === 'on-reveal' && label) {
    // The listener knows the person by the label already: the label comes first, the name is the news.
    const known = [saidLabel(label, zh)];
    if (outfit) known.push(zh ? `穿着${outfit}` : `in ${outfit}`);
    return zh ? `${known.join('，')}，${name}，` : `${known.join(', ')}, ${name},`;
  }
  if (zh) {
    const look = [label, outfit ? `穿着${outfit}` : ''].filter(Boolean);
    return look.length ? `${name}，${look.join('，')}，` : name;
  }
  if (label && labelSaid) return reanchorForm(name, label, outfit, false, false);
  if (label) return `${name}, ${newLabel(label, false)}${outfit ? ` in ${outfit}` : ''},`;
  return outfit ? `${name}, in ${outfit},` : name;
}

/**
 * The name tied to the picture again: after a long absence the label
 * ("马修，长发女人，" / "Matthew, the woman with long hair,"), after a change of
 * clothes the new outfit ("马修，换了灰大衣，" / "Matthew, now in a grey coat,"),
 * both when both hold. An outfit said for the first time is not called a change
 * ("马修，穿着灰大衣，" / "Matthew, in a grey coat,"): the engine does not know
 * that it is one.
 */
function reanchorForm(name, label, outfit, changed, zh) {
  const parts = [name];
  if (label) parts.push(saidLabel(label, zh));
  if (outfit && zh) parts.push(`${changed ? '换了' : '穿着'}${outfit}`);
  if (outfit && !zh) parts.push(`${changed ? 'now in' : 'in'} ${outfit}`);
  return zh ? `${parts.join('，')}，` : `${parts.join(', ')},`;
}

// ---- Putting a form into a sentence ----

const ENDS_IN_COMMA = /[,，]$/;
/** What may follow a token so that a form's own closing comma would be one too many. */
const CLOSES = /^[,，.。!！?？;；:：…—–)）」』”’】》\]]/;
/** A straight quote right after a token closes a quotation; one that opens the next has a space before it. */
const CLOSING_QUOTE = /^["']/;
/** "{P3}'s hand", "{P3}的手": what follows belongs to the person. */
const POSSESSIVE = /^(?:['’]s(?![\p{L}\p{N}])|的)/u;

const capitalise = (text) => text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());

/**
 * Whether what comes next starts a sentence: nothing but opening quotes before
 * it, or a full stop, an exclamation or a question mark. A Latin stop counts
 * only with a space after it, so "3.5" does not end a sentence.
 */
function startsSentence(before) {
  const lead = before.replace(/[\s"'“‘「『（([]+$/, '');
  if (!lead) return true;
  if (/[。！？…]["”’」』）]*$/.test(lead)) return true;
  return /[.!?]["'”’)\]]*$/.test(lead) && /\s/.test(before.slice(lead.length));
}

/**
 * In Chinese nothing stands between a form and the words around it: the spaces
 * a model puts around a token go, and two tokens with only a space between them
 * are a list.
 */
function closeUp(text) {
  const token = `(?:${TOKEN_SOURCE})`;
  return text
    .replace(new RegExp(`(${token})\\s+(?=${token})`, 'g'), '$1、')
    .replace(new RegExp(`\\s+(${token})`, 'g'), '$1')
    .replace(new RegExp(`(${token})\\s+`, 'g'), '$1');
}

/**
 * Fill the tokens of one text. `picked` gives, per character, the words of its
 * first token in the cue (`text`) and of every later one (`rest`). A token of
 * somebody `picked` does not know is left where it is, and the caller then
 * keeps the cue from being spoken.
 *
 * A form that ends in a comma gives the comma up before a comma, a stop, a
 * closing bracket or quote or the end of the text, so punctuation is never doubled. In
 * Chinese it keeps its comma before a list mark and the mark goes ("{P1}、{P2}"):
 * the apposition closes as it opened, and "穿着红裙子、戴眼镜的男人" would dress
 * the next person. In English it is followed by one space and its first letter
 * is a capital at the start of a sentence. Before a possessive at the start of
 * a sentence the form becomes a sentence of its own and the short form carries
 * the possessive ("Matthew, a woman with long hair. Matthew's hand …"), which
 * says whose hand it is. (In mid-sentence renderScript gives such a token the
 * short form; were a long one put there, it would lose its comma.)
 */
function fill(template, zh, picked) {
  let out = '';
  let from = 0;
  const met = new Set();
  for (const m of template.matchAll(tokenPattern())) {
    const id = `P${m[1]}`;
    const words = picked.get(id);
    if (!words) continue;
    out += template.slice(from, m.index);
    from = m.index + m[0].length;
    let next = template.slice(from);
    const opens = startsSentence(out);
    let said = met.has(id) ? words.rest : words.text;
    met.add(id);
    if (ENDS_IN_COMMA.test(said)) {
      const bare = said.slice(0, -1);
      if (zh && next.startsWith('、')) {
        from += 1;
        next = next.slice(1);
      }
      if (POSSESSIVE.test(next)) said = opens ? `${bare}${zh ? `。${words.rest}` : `. ${capitalise(words.rest)}`}` : bare;
      else if (!next.trim() || CLOSES.test(next.trimStart()) || CLOSING_QUOTE.test(next)) said = bare;
      else if (!zh && !/^\s/.test(next)) said += ' ';
    }
    out += !zh && opens ? capitalise(said) : said;
  }
  return out + template.slice(from);
}

/**
 * Whether the first token of a character in a text carries a possessive in
 * mid-sentence ("down {P2}'s cheek", "握住{P2}的手"). A form that ends in a
 * comma cannot stand there: without its comma the outfit or the label would be
 * said of the cheek or the hand.
 */
function heldByPossessive(template, id) {
  for (const m of template.matchAll(tokenPattern())) {
    if (`P${m[1]}` !== id) continue;
    return POSSESSIVE.test(template.slice(m.index + m[0].length)) && !startsSentence(template.slice(0, m.index));
  }
  return false;
}

// ---- What is left that must never be spoken ----

/** A letter or digit of a script that writes words apart: "MP3" is a word, "P3走" is P3 and a verb. */
const WORD_CHAR = '(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])[\\p{L}\\p{N}_]';
const BARE_ID = new RegExp(`(?<!${WORD_CHAR})[Pp][0-9]+(?!${WORD_CHAR})`, 'u');

/**
 * Whether a text still holds what only the engine and the model may see: a
 * brace, or a character id in the open (P3 as a whole word; full-width and
 * lower-case spellings too). The frames a model is shown carry the ids as tags,
 * so an id in a description is far more likely a mark read off a frame than
 * something in the film; such a text is not spoken.
 * @param {string} text
 * @returns {boolean}
 */
export function hasResidue(text) {
  if (typeof text !== 'string' || !text) return false;
  const plain = text.normalize('NFKC');
  return /[{}]/.test(plain) || BARE_ID.test(plain);
}

// ---- Rendering a script ----

/** The three texts of a cue with their tokens in the one spelling, or null when the cue says nothing. */
function templatesOf(cue, zh) {
  const text = (value) => {
    const tidy = typeof value === 'string' ? normalizeTokens(value).trim() : '';
    return zh ? closeUp(tidy) : tidy;
  };
  const standard = text(cue.standard) || text(cue.detailed) || text(cue.brief);
  if (!standard) return null;
  return { brief: text(cue.brief) || standard, standard, detailed: text(cue.detailed) || standard };
}

/**
 * The seconds a cue may take: its own `room`, else the room of its slot, else
 * the length of the pause it sits in. 0 means no limit applies: an extended
 * description has no slot, the film waits for it.
 */
function roomOf(cue, slots) {
  if (finite(cue.room)) return Math.max(0, cue.room);
  if (typeof cue.slot !== 'string' || !cue.slot) return 0;
  const slot = slots.get(cue.slot);
  if (slot && finite(slot.room) && slot.room >= 0) return slot.room;
  if (slot && finite(slot.start) && finite(slot.end)) return Math.max(0, slot.end - slot.start);
  return finite(cue.start) && finite(cue.end) ? Math.max(0, cue.end - cue.start) : 0;
}

/**
 * The appearance a cue speaks of: the one current when the cue starts, else
 * the first one that begins before the cue ends. A cue starts with its pause,
 * but an outfit is on record from the frame that first showed it, and that
 * frame lies inside the pause: read at the start alone, what a person walks in
 * wearing would be said one mention late, and an introduction would lose its
 * outfit. An outfit that is current at the start is never passed over for a
 * later one: a change during the pause is said at the next mention.
 */
function appearanceIn(cast, id, start, end) {
  const current = appearanceAt(cast, id, start);
  if (current || !finite(start) || !finite(end) || !(end > start)) return current;
  let first = null;
  for (const a of list(cast?.appearances)) {
    if (!isObject(a) || a.char !== id || !finite(a.from) || !(a.from > start && a.from <= end)) continue;
    if (!first || a.from < first.from) first = a;
  }
  return first;
}

/** What is known of a character before anything was said of it. `labelSaid`: the listener has heard the label. */
const UNSAID = Object.freeze({ introduced: false, outfit: null, last: null, labelSaid: false });

/**
 * The two ways a character can be worded in a cue: `short`, which always
 * exists, and `long` (an introduction, an outfit, a re-anchoring) when the
 * state calls for one. Each holds the form's name, the words of the first
 * token and the words of later tokens; a long form also says what it will have
 * told the listener (`introduces`, `outfit`).
 */
function wordings(character, was, { t, zh, rules, demoted, outfit }) {
  const label = labelOf(character, zh);
  const plain = saidLabel(label, zh);
  const byLabel = { form: 'label', text: plain, rest: plain };
  const unsaid = Boolean(outfit) && outfitKey(outfit) !== was.outfit;

  if (!unlocked(character, t, rules, { demoted })) {
    // Someone the picture did not confirm gets the bare label: an outfit taken from the cast would be a second guess.
    if (demoted || !unsaid) return { short: byLabel, long: null };
    return { short: byLabel, long: { form: 'label-outfit', text: labelOutfitForm(label, outfit, zh), rest: plain, outfit: outfitKey(outfit) } };
  }

  const name = oneLine(character.name);
  if (!was.introduced) {
    // At a reveal the listener has usually heard the outfit with the label; it is said again only when it is news.
    const dress = rules.naming === 'on-reveal' && !unsaid ? '' : outfit;
    return {
      // Until the introduction is heard the name means nothing to the listener: the label stays.
      short: byLabel,
      long: { form: 'intro', text: introForm(rules.naming, name, label, dress, zh, was.labelSaid), rest: name, introduces: true, outfit: dress ? outfitKey(dress) : undefined },
    };
  }

  const byName = { form: 'name', text: name, rest: name };
  const away = rules.reanchorAfterSec > 0 && was.last !== null && t - was.last >= rules.reanchorAfterSec;
  const anchor = away ? label : '';
  if (!unsaid && !anchor) return { short: byName, long: null };
  return {
    short: byName,
    long: { form: 'reanchor', text: reanchorForm(name, anchor, unsaid ? outfit : '', was.outfit !== null, zh), rest: name, outfit: unsaid ? outfitKey(outfit) : undefined },
  };
}

/**
 * Fill every token of a film script: the words a listener hears and an export
 * prints.
 *
 * The cues are walked in time order (those `include` accepts). Per character
 * the walk remembers whether it was introduced, the outfit last said, when it
 * was last mentioned and whether its label was said. The first token of a
 * character in a cue takes one of:
 *   'label'         the name may not be said: "长发女人" / "the woman with long hair"
 *   'label-outfit'  the same, and the outfit current at the cue was not said yet: "长发女人，穿着红裙子，"
 *   'intro'         the name may be said and was not introduced:
 *                   first-appearance "马修，长发女人，穿着红裙子，", on-reveal "长发女人，马修，"
 *   'reanchor'      introduced, and the outfit is not the one last said ("马修，换了灰大衣，") or the
 *                   character was not mentioned for policy.reanchorAfterSec ("马修，长发女人，")
 *   'name'          otherwise
 * and later tokens of the same character take the short form: the name once it
 * is introduced, the label before. The three versions of a cue are worded from
 * the same state, and the state moves once per cue.
 *
 * The outfit of a cue is the one on record when the cue starts; when none is,
 * the first one recorded before the cue ends (cue.end, the end of its pause):
 * the frame that first shows an outfit lies inside the pause the description
 * is spoken in. An outfit that holds a brace, an id, a mark or a name of the
 * cast is not said: the forms are worded as if there were none.
 *
 * A long form is said in all three versions of a cue or in none: the player
 * speaks whichever version fits, so what one version tells the listener the
 * others must tell too. It is taken only where
 *   - all three versions hold the character's token (a brief version that
 *     leaves the character out would let the name follow with no introduction;
 *     an introduction that is the name alone is exempt: nothing is missed);
 *   - the brief version, worded with it, passes `fits(text, room)`;
 *   - the character's first token does not carry a possessive in mid-sentence
 *     in any version ("握住{P2}的手"), when the form ends in a comma.
 * Otherwise the cue is worded with the short form (the label, for someone not
 * introduced yet), nothing is taken as said, the cue is listed in
 * report.deferred, and the next cue that mentions the character tries again.
 * With several long forms in one cue they are tried in order of first mention,
 * so one that fits is not held back by one that does not. A cue with no room
 * to measure (room 0: an extended description) is not measured.
 *
 * A person in cue.people with `demoted: true` (verify.js did not see the
 * character around the cue) gets the bare label in that cue and the walk
 * forgets the mention, except that the label was heard. A cue that still holds
 * a brace or an id after filling (a token of nobody in the cast, "P3" written
 * in the open), or whose status is 'needs-check', comes back with
 * `silent: true`, is listed in report.silenced and moves no state: an
 * introduction nobody heard is made again.
 *
 * @param {import('./types.js').FilmScript} script
 * @param {import('./types.js').Cast} cast
 * @param {Partial<import('./types.js').Policy>} [policy]  over the cast's own policy; what both lack comes from DEFAULT_POLICY
 * @param {object} [options]
 * @param {string} [options.lang]  the description language (script.lang when missing): Chinese forms for zh, yue, cmn; English forms otherwise
 * @param {number} [options.rate]  the speaking rate estimateSeconds takes, 1 by default
 * @param {(cue: import('./types.js').FilmCue) => boolean} [options.include]  which cues are spoken; all by default
 * @param {(text: string, room: number) => boolean} [options.fits]  whether a text can be spoken in `room` seconds;
 *   estimateSeconds(text, rate) <= room by default
 * @returns {{cues: import('./types.js').RenderedCue[],
 *   report: {introducedAt: Object<string, string>, deferred: string[], silenced: string[]}}}
 *   cues: in time order; `people` lists every character id the texts refer to, in order of first mention;
 *   `forms` says, per character of the cast, the form its first token took.
 *   report.introducedAt: the cue each name was introduced in.
 */
export function renderScript(script, cast, policy, options) {
  const opts = isObject(options) ? options : {};
  const zh = isChinese(typeof opts.lang === 'string' && opts.lang ? opts.lang : script?.lang);
  const rules = policyOf(policy, cast?.policy);
  const rate = finite(opts.rate) && opts.rate > 0 ? opts.rate : 1;
  const fits = typeof opts.fits === 'function' ? opts.fits : (text, room) => estimateSeconds(text, rate) <= room;
  const include = typeof opts.include === 'function' ? opts.include : () => true;

  const slots = new Map();
  for (const slot of list(script?.slots)) {
    if (isObject(slot) && typeof slot.id === 'string') slots.set(slot.id, slot);
  }
  const when = (cue) => (finite(cue.start) ? cue.start : Infinity);
  const ordered = list(Array.isArray(script) ? script : script?.cues)
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => isObject(cue))
    .sort((a, b) => when(a.cue) - when(b.cue) || a.index - b.index);

  const state = new Map();
  const report = { introducedAt: {}, deferred: [], silenced: [] };
  const cues = [];
  // Each stored outfit is checked against the cast once per call.
  const checkedOutfits = new Map();
  const outfitToSay = (stored) => {
    if (!checkedOutfits.has(stored)) checkedOutfits.set(stored, speakable(outfitWords(stored, zh), cast));
    return checkedOutfits.get(stored);
  };

  for (const { cue } of ordered) {
    if (!include(cue)) continue;
    const templates = templatesOf(cue, zh);
    if (!templates) continue;

    const t = finite(cue.start) ? cue.start : NaN;
    const people = tokensIn(`${templates.standard} ${templates.brief} ${templates.detailed}`).filter(isCharacterId);
    const demoted = new Set(list(cue.people).filter((p) => isObject(p) && p.demoted === true).map((p) => p.char));

    const plans = new Map();
    for (const id of people) {
      const character = getCharacter(cast, id);
      if (!isObject(character)) continue;
      const current = appearanceIn(cast, id, t, cue.end);
      plans.set(id, wordings(character, state.get(id) || UNSAID, {
        t,
        zh,
        rules,
        demoted: demoted.has(id),
        outfit: current ? outfitToSay(current.outfit) : '',
      }));
    }

    const word = (template, long) => {
      const picked = new Map();
      for (const [id, plan] of plans) picked.set(id, plan.long && long.has(id) ? plan.long : plan.short);
      return fill(template, zh, picked);
    };

    // Which long forms are said here. One whose token carries a possessive in mid-sentence waits like one that does not fit.
    const wanting = [...plans.keys()].filter((id) => plans.get(id).long
      && !(ENDS_IN_COMMA.test(plans.get(id).long.text) && VERSIONS.some((v) => heldByPossessive(templates[v], id))));
    const room = roomOf(cue, slots);
    // A long form is said in all three versions or in none: the player speaks whichever one fits.
    // (An introduction that is the name alone tells nothing a later bare name would not, and needs no version to carry it.)
    let long = new Set();
    for (const id of wanting) {
      const form = plans.get(id).long;
      if (form.text !== form.rest && !VERSIONS.every((v) => tokensIn(templates[v]).includes(id))) continue;
      const trial = new Set([...long, id]);
      if (!(room > 0) || fits(word(templates.brief, trial), room)) long = trial;
    }

    const rendered = {
      id: typeof cue.id === 'string' ? cue.id : '',
      start: cue.start,
      end: finite(cue.end) ? cue.end : cue.start,
      room,
      kind: KINDS.includes(cue.kind) ? cue.kind : 'visual',
      priority: [1, 2, 3].includes(cue.priority) ? cue.priority : 2,
      brief: word(templates.brief, long),
      standard: word(templates.standard, long),
      detailed: word(templates.detailed, long),
      people,
      forms: {},
    };
    for (const [id, plan] of plans) rendered.forms[id] = (plan.long && long.has(id) ? plan.long : plan.short).form;

    // The last check before anything is spoken or exported: no brace, no id, no cue a person still has to look at.
    if (cue.status === 'needs-check' || VERSIONS.some((v) => hasResidue(rendered[v]))) {
      rendered.silent = true;
      report.silenced.push(rendered.id);
      cues.push(rendered);
      continue;
    }

    let waiting = false;
    for (const [id, plan] of plans) {
      const was = state.get(id) || UNSAID;
      const said = plan.long && long.has(id) ? plan.long : plan.short;
      // The label was heard, also where the mention is forgotten or the long form waits.
      const labelSaid = was.labelSaid || said.form === 'label' || said.form === 'label-outfit';
      if (demoted.has(id) || (plan.long && !long.has(id))) {
        // Nothing else is taken as said, the absence included, so the next cue asks for the same long form.
        if (!demoted.has(id)) waiting = true;
        if (labelSaid !== was.labelSaid) state.set(id, { ...was, labelSaid });
        continue;
      }
      const next = { ...was, labelSaid };
      if (finite(t)) next.last = t;
      if (plan.long) {
        if (plan.long.outfit !== undefined) next.outfit = plan.long.outfit;
        if (plan.long.introduces) {
          next.introduced = true;
          report.introducedAt[id] = rendered.id;
        }
      }
      state.set(id, next);
    }
    if (waiting) report.deferred.push(rendered.id);
    cues.push(rendered);
  }

  return { cues, report };
}

// ---- Outside the script: before the film, and "who is on screen" ----

const charactersOf = (cast) => list(cast?.characters).filter(isObject);

/**
 * The introduction spoken before the film starts: the main characters whose
 * name may be said from the first second and who are no plot secret, the one
 * longest on screen first.
 *   "主要人物：马修，长发女人；老陈，戴眼镜的男人。"
 *   "Main characters: Matthew, a woman with long hair; Chen, a man with glasses."
 * Outfits are left out: they change. The text is never longer than maxChars;
 * whole entries are dropped from the end, and '' is returned when not even the
 * first fits, when policy.introBeforeFilm is false or when nobody qualifies.
 * @param {import('./types.js').Cast} cast
 * @param {Partial<import('./types.js').Policy>} [policy]  over the cast's own policy
 * @param {{lang?: string, maxChars?: number}} [options]  maxChars: 200 by default, counted as the text's length
 * @returns {string}
 */
export function castIntro(cast, policy, options) {
  const { lang, maxChars } = isObject(options) ? options : {};
  const rules = policyOf(policy, cast?.policy);
  if (!rules.introBeforeFilm) return '';
  const zh = isChinese(lang);
  const limit = finite(maxChars) && maxChars > 0 ? maxChars : 200;
  const screen = (character) => (finite(character.screenSec) ? character.screenSec : 0);

  const entries = charactersOf(cast)
    .filter((c) => c.main === true && !c.spoilerLock && unlocked(c, 0, rules))
    .map((character, index) => ({ character, index }))
    .sort((a, b) => screen(b.character) - screen(a.character) || a.index - b.index)
    .map(({ character }) => {
      const name = oneLine(character.name);
      const label = newLabel(labelOf(character, zh), zh);
      if (!label) return name;
      return zh ? `${name}，${label}` : `${name}, ${label}`;
    });

  for (let count = entries.length; count > 0; count -= 1) {
    const said = entries.slice(0, count);
    const text = zh ? `主要人物：${said.join('；')}。` : `Main characters: ${said.join('; ')}.`;
    if (text.length <= limit) return text;
  }
  return '';
}

/** Character ids from a list of ids or of Visible entries, each once, in the order given. */
function idsOf(value) {
  const ids = [];
  for (const item of list(value)) {
    const id = typeof item === 'string' ? item : isObject(item) ? item.characterId : undefined;
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The answer to "who is on screen": the name of everyone whose name may be
 * said at t, the label of the others.
 *   "画面里：马修；灰大衣男人。" / "On screen: Matthew; the man in the grey coat."
 * An empty list gives a sentence saying nobody is recognised. `visibleIds` null
 * means the identity mode cannot tell (no faces are tracked): the answer says
 * so, and gives the people of `recentIds` (the last description's) when given.
 * Nothing checked those people against the picture, so they are given by their
 * labels, as verify.js demotes them in the descriptions:
 *   "本模式不核对画面。最近一条口述提到的人物：长发女人；灰大衣男人。"
 *   "This mode does not check the picture. The people last described: the woman with long hair; the man in the grey coat."
 * With `allowNamesWithoutTracks: true` (the option of the same name in
 * verify.js: names may be spoken unchecked) the names that are unlocked are said.
 * Ids the cast does not know are left out.
 * @param {Array<string|import('./types.js').Visible>|null} visibleIds  from an identity provider; null = it cannot tell
 * @param {import('./types.js').Cast} cast
 * @param {Partial<import('./types.js').Policy>} [policy]  over the cast's own policy
 * @param {number} t  the playback position in seconds
 * @param {{lang?: string, recentIds?: string[], allowNamesWithoutTracks?: boolean}} [options]
 * @returns {string}
 */
export function whoIsOnScreen(visibleIds, cast, policy, t, options) {
  const { lang, recentIds, allowNamesWithoutTracks = false } = isObject(options) ? options : {};
  const zh = isChinese(lang);
  const rules = policyOf(policy, cast?.policy);
  const say = (ids, demoted = false) => idsOf(ids)
    .map((id) => getCharacter(cast, id))
    .filter(isObject)
    .map((character) => (unlocked(character, t, rules, { demoted }) ? oneLine(character.name) : saidLabel(labelOf(character, zh), zh)));
  const between = zh ? '；' : '; ';

  if (visibleIds === null || visibleIds === undefined) {
    const recent = say(recentIds, allowNamesWithoutTracks !== true);
    if (zh) return recent.length ? `本模式不核对画面。最近一条口述提到的人物：${recent.join(between)}。` : '本模式不核对画面。';
    return recent.length ? `This mode does not check the picture. The people last described: ${recent.join(between)}.` : 'This mode does not check the picture.';
  }
  const seen = say(visibleIds);
  if (!seen.length) return zh ? '画面里没有认出的人物。' : 'Nobody on screen is recognised.';
  return zh ? `画面里：${seen.join(between)}。` : `On screen: ${seen.join(between)}.`;
}
