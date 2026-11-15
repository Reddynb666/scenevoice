// What the picture supports: the checks that stand between a model's answer and
// the name gate. A description may refer to a person only by a character token
// ({P3}). Here a token nobody knows, an id or a numbered box named in the open
// and a name written out are reported; a token whose character is not on screen
// around the cue is demoted to its visual label; and "a woman", written while the
// one main character on screen can only be her, is given that character's token.
// Everything is read off the text. Quotation marks and the cue's on-screen text
// are left alone: a sign may say "P3" and a shop may carry a character's name.
// Where a check cannot be sure it asks again rather than let a name through:
// better no name than a wrong one.
// See README.md in this folder for the contract.

import { isCjk, tokenFor, tokenPattern, tokensIn } from './types.js';

/** The three versions of a cue's text. Every check reads all of them. */
const FIELDS = Object.freeze(['brief', 'standard', 'detailed']);

/** How far around a cue a character must be seen for its token to stand, in seconds. */
const DEFAULT_WINDOW = Object.freeze({ before: 3, after: 1 });

/**
 * Stands in for text no rule may read: a quotation, on-screen text, a token.
 * One for each character hidden, so positions in the text stay what they were.
 */
const HIDDEN = '\u0000';

/**
 * The longest text the checks read. The engine's own texts stop at 800
 * characters and this is minutes of speech; a stored or typed text has no limit,
 * and the scans below are not made for one (a pattern built from a very long
 * text cannot even be compiled). A longer text is reported, not read.
 */
const MAX_CHECKED = 2000;
const tooLong = (text) => typeof text === 'string' && text.length > MAX_CHECKED;

/** A token as a model may write it: full-width braces, spaces inside, lower case, full-width letters and digits. */
const LOOSE_TOKEN = /[{｛]\s*[PpＰｐ]\s*([0-9０-９]{1,6})\s*[}｝]/g;
const asciiDigits = (digits) => digits.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

/**
 * Every way of writing a character token becomes {P3}: ｛P3｝, { P3 }, {p3},
 * {Ｐ３}, {P03}. Other braces are left as they are (violations reports them).
 * @param {string} text
 * @returns {string}  '' when there is no text
 */
export function normalizeTokens(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(LOOSE_TOKEN, (whole, digits) => `{P${Number(asciiDigits(digits))}}`);
}

const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/**
 * A letter or digit of a script that writes words apart: what a whole word must
 * not touch. Chinese, Japanese and Korean characters do not count, so "Matthew走到窗边"
 * still holds the word Matthew.
 */
const isWordChar = (ch) => ch !== undefined && WORD_CHAR.test(ch) && !CJK_CHAR.test(ch);

const startsWithCapital = (text) => {
  const first = [...text][0] || '';
  return first !== first.toLowerCase();
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The source of a pattern for a phrase, with `gap` wherever the phrase has white space. */
const phraseSource = (phrase, gap) => phrase.trim().split(/\s+/).map(escapeRegExp).join(gap);

const charactersOf = (cast) => (Array.isArray(cast?.characters) ? cast.characters.filter((c) => c && typeof c === 'object') : []);

/**
 * Character ids as a Set: an array or a Set of ids (the Visible entries of an
 * identity provider are read too). null stays null: the identity mode cannot tell.
 */
function idSet(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return new Set([value]);
  if (typeof value[Symbol.iterator] !== 'function') return null;
  const ids = new Set();
  for (const item of value) {
    const id = typeof item === 'string' ? item : item?.characterId;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

// ---- Text that is quoted, or read off the screen ----

/** Quotation marks that come in pairs. Book-title marks count: a title is quoted, not said of a person. */
const QUOTE_CLOSERS = new Map([['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['《', '》'], ['«', '»']]);

/** Where the quotation opened at `open` closes; -1 when it never does. */
function pairedCloser(text, open, closer) {
  let at = text.indexOf(closer, open + 1);
  // ’ is also the apostrophe: ‘Matthew’s Bakery’ closes at the last one.
  while (closer === '’' && at >= 0 && isWordChar(text[at + 1])) at = text.indexOf(closer, at + 1);
  return at;
}

/**
 * A word that begins with an apostrophe ('em, 'til, 'cause, '90s, '67): not the
 * start of a quotation. The list cannot be complete; a quotation that begins
 * with a digit or one of these words is read as open text, the safe mistake.
 */
const ELIDED = /^(?:\p{N}|(?:em|im|er|til|till|cause|cos|coz|cuz|bout|round|neath|fore|tween|gainst|pon|n|tis|twas|twere|twill|twould)(?![\p{L}\p{N}_]))/iu;

/**
 * Where a quotation opened by the straight single quote at `open` closes; -1 when
 * this one is an apostrophe ("the man's hat", "'em") or nothing closes it.
 */
function straightSingleCloser(text, open) {
  const next = text[open + 1];
  if (isWordChar(text[open - 1]) || next === undefined || /\s/.test(next) || ELIDED.test(text.slice(open + 1, open + 12))) return -1;
  for (let at = text.indexOf('\'', open + 1); at >= 0; at = text.indexOf('\'', at + 1)) {
    if (!/\s/.test(text[at - 1]) && !isWordChar(text[at + 1])) return at;
  }
  return -1;
}

/** The quotations in a text as [start, end) pairs, marks included. A quotation that never closes hides nothing. */
function quotedSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let close = -1;
    if (QUOTE_CLOSERS.has(ch)) close = pairedCloser(text, i, QUOTE_CLOSERS.get(ch));
    else if (ch === '"') close = text.indexOf('"', i + 1);
    else if (ch === '\'') close = straightSingleCloser(text, i);
    if (close > i) {
      spans.push([i, close + 1]);
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return spans;
}

/**
 * Where a text repeats the cue's on-screen text: all of it, or one line of it
 * (lines are joined with " / "), whatever the spacing and the case. A text that
 * is itself a piece of the on-screen text (the short version of a long sign) is
 * on-screen text from end to end.
 */
function screenTextSpans(text, onScreenText) {
  const screen = typeof onScreenText === 'string' ? onScreenText.trim() : '';
  const body = text.trim();
  // One character proves nothing: a sign that says "A" would hide every "A".
  // A transcription too long to read excuses nothing (the patterns below are built from it).
  if (screen.length < 2 || body.length < 2 || tooLong(screen) || tooLong(body)) return [];
  if (new RegExp(phraseSource(body, '\\s*'), 'iu').test(screen)) return [[0, text.length]];
  const spans = [];
  const parts = new Set([screen, ...screen.split(/\s*\n\s*|\s+\/\s+/).map((line) => line.trim())]);
  for (const part of parts) {
    if (part.length < 2) continue;
    for (const m of text.matchAll(new RegExp(phraseSource(part, '\\s*'), 'giu'))) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** Whether a quotation runs from one end of the text to the other (a full stop may follow it). */
const wrapsAll = (text, [start, end]) => !text.slice(0, start).trim() && /^[\s。．.!！?？…]*$/.test(text.slice(end));

/**
 * The text with its quotations and the cue's on-screen text hidden: what is
 * left is what the description says in its own voice. A description of the
 * picture that is in quotation marks from end to end quotes nothing (a model
 * wraps its answer that way), so it is read like any other; a kind 'text' cue
 * may well be one quotation.
 */
function inTheOpen(text, cue) {
  const quoted = quotedSpans(text).filter((span) => cue?.kind === 'text' || !wrapsAll(text, span));
  return withHidden(text, [...quoted, ...screenTextSpans(text, cue?.onScreenText)]);
}

// ---- An id or a mark named in the open ----

/**
 * Colours a box may be called by. Wider than the eight of marks.js: a model
 * names the colour it sees, not the one in the table. A compound ("天蓝",
 * "sky blue") ends in one of these.
 */
const ZH_COLOUR = '[红橙橘黄绿青蓝紫粉白黑灰棕褐]';
const EN_COLOUR = '(?:red|orange|yellow|green|blue|purple|violet|pink|magenta|cyan|teal|turquoise|white|black|gr[ae]y|brown|vermill?ion)';

/** What a box does when it is the mark on the frame and not a thing in the scene: "a red box around her face". */
const DRAWN_ON = /^\s+(?:is\s+|are\s+)?(?:around|surround|highlight|outlin|fram|enclos|drawn|label)/i;

/**
 * The ways a description gives away the marks instead of using a token. Each
 * rule: `find` (global), and `when(match, text)` for what the pattern alone
 * cannot decide. They cost some true descriptions (a real "P90", "the red box"
 * on a table): such a cue is asked for again rather than spoken with the
 * machinery showing.
 */
const BARE_ID_RULES = Object.freeze([
  // The id itself: "P3 走到窗边", "(P3)", "Ｐ３". Tokens are hidden before this runs.
  { find: /(?<![A-Za-z0-9_])[PpＰｐ][0-9０-９]+(?![A-Za-z0-9_])/g },
  // A numbered person or box: "3 号人物", "3号框", "三号人物", "3号男子". Not "3 号线" or "7 号球员":
  // only the nouns a mark is called by.
  { find: /(?:[0-9０-９]+|[〇零一二两三四五六七八九十]+)\s*号\s*(?:人物|角色|人脸|方框|框|标记|男子|女子|男人|女人|男士|女士|男孩|女孩)/g },
  // The same the other way round: "人物 3", "框2". Not a count ("人物3个").
  { find: /(?:人物|角色|标记|方框|框)\s*[0-9０-９]+(?![0-9０-９]*\s*[个名位人])/g },
  // A box by its colour: "红框", "红色框", "蓝色的方框". Glasses have frames of a colour too ("黑框眼镜").
  { find: new RegExp(`${ZH_COLOUR}色?的?[方边线]?框(?!的?眼镜|镜|架)`, 'g') },
  // A person by the box around them: "框里的人", "方框中的男子". Not a photo frame, a doorway or a viewfinder.
  { find: /(?<![相画镜门窗眼景边])框(?:里|中|内|住|出)来?的?(?:那个|这个)?(?:人|男|女)/g },
  // "box 2", "person 2", "Person #2", "mark B". A single letter counts only as a capital, and "I" is a word.
  {
    find: /\b(?:box|person|mark|marker|character)(?:\s*#\s*|\s+(?:no\.\s*|number\s+)?)(\d+|[a-z])\b/gi,
    when: (m) => /\d/.test(m[1]) || (m[1] !== 'I' && m[1] !== m[1].toLowerCase()),
  },
  // "the red box", "the blue bounding box". "a small red box" introduces a thing in the scene (a mark
  // is "the red box"), unless it is said to be around someone: then it is the mark, seen as part of the picture.
  {
    find: new RegExp(`(\\ban?\\s+(?:[a-z-]+\\s+){0,2})?\\b${EN_COLOUR}(?:[- ]colou?red)?\\s+(?:bounding\\s+)?(?:box(?:es)?|rectangles?)\\b`, 'gi'),
    when: (m, text) => !m[1] || DRAWN_ON.test(text.slice(m.index + m[0].length)),
  },
  { find: /\bbounding\s+box(?:es)?\b/gi },
  { find: new RegExp(`\\bboxed\\s+in\\s+${EN_COLOUR}\\b`, 'gi') },
]);

/**
 * A brace that is not part of a token: "{Bob}", "{P}", a lone "{". The name gate
 * would refuse to speak it, in any width: it reads a text folded to its plain
 * form (NFKC), where ｛｝, ﹛﹜ and ︷︸ are braces too.
 */
const STRAY_BRACE = /[{｛﹛︷][^{}｛｝﹛﹜︷︸\u0000]*[}｝﹜︸]|[{}｛｝﹛﹜︷︸]/g;

// ---- Names ----

/**
 * Words that stand before the name in a longer one and are no name by
 * themselves: a title, an article, a particle. "Aunt" of "Aunt Mary" and "The"
 * of "The Dude" open any sentence. As the last word of a name they are the
 * name ("Mr. Young", "Stephen King").
 */
const NOT_A_NAME = new Set([
  'the', 'a', 'an', 'of', 'and',
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor', 'sir', 'dame', 'madam', 'madame', 'lady', 'lord',
  'aunt', 'auntie', 'uncle', 'father', 'mother', 'brother', 'sister', 'grandma', 'grandpa', 'old', 'young', 'big', 'little',
  'captain', 'officer', 'detective', 'inspector', 'sergeant', 'king', 'queen', 'saint', 'st',
  'de', 'la', 'le', 'du', 'del', 'di', 'da', 'van', 'von', 'der', 'den', 'el', 'al', 'bin',
]);

/** What two spellings of one name have in common: case, width and spacing. */
const nameKey = (name) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The names a description must not write, each once (two spellings of one name
 * are one; the cast's own spelling comes first):
 *   whole  every character's name and aliases, and every name the evidence ever
 *          gave a character: a clue for a name that did not win, and a name a
 *          person rejected, are still what the dialogue says;
 *   parts  each word of a name of several words that is written as a name
 *          ("Mary" of "Aunt Mary", "Lee" of "Mr. Lee", 玛丽 of 玛丽·安): outside
 *          Chinese, Japanese and Korean only a capitalised word, and not a
 *          title, an article or a particle that stands before the last word.
 * A name of one character (or one letter) is left out: "陈" is in too many
 * words to mean anything.
 */
function castNames(cast) {
  const whole = [];
  const parts = [];
  const seen = new Set();
  const add = (list, raw) => {
    const name = raw.trim();
    const size = CJK_CHAR.test(name) ? [...name].length : (name.match(/\p{L}/gu) || []).length;
    const key = nameKey(name);
    if (size < 2 || seen.has(key)) return;
    seen.add(key);
    list.push(name);
  };
  const given = [];
  const heard = [];
  for (const character of charactersOf(cast)) {
    const aliases = Array.isArray(character.aliases) ? character.aliases.map((a) => (typeof a === 'string' ? a : a?.text)) : [];
    const clues = Array.isArray(character.evidence) ? character.evidence.map((e) => e?.name) : [];
    given.push(...[character.name, ...aliases].filter((raw) => typeof raw === 'string'));
    heard.push(...clues.filter((raw) => typeof raw === 'string'));
  }
  const all = [...given, ...heard];
  for (const raw of all) add(whole, raw);
  for (const raw of all) {
    const words = raw.trim().split(/[\s·・‧•]+/).filter(Boolean);
    if (words.length < 2) continue;
    words.forEach((word, index) => {
      const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      // "de" and "the" are not names, and neither is "Aunt" before "Mary"; in Chinese any word of the name is one.
      const title = index < words.length - 1 && NOT_A_NAME.has(bare.toLowerCase());
      if (CJK_CHAR.test(bare) || (startsWithCapital(bare) && !title)) add(parts, bare);
    });
  }
  return { whole, parts };
}

/**
 * Where a name is written in a text, as [start, end) pairs. A name in Chinese,
 * Japanese or Korean is found anywhere (there are no word boundaries to go by,
 * so 小雨 is also found in "下着小雨": the price of never missing one). A name in
 * another script must be a whole word ("Matthews" is not Matthew) and written
 * as a name: "rose" is not Rose, unless the cast itself writes the name without
 * a capital.
 */
function nameSpans(open, name) {
  const spans = [];
  if (CJK_CHAR.test(name)) {
    for (let at = open.indexOf(name); at >= 0; at = open.indexOf(name, at + name.length)) spans.push([at, at + name.length]);
    return spans;
  }
  const capital = startsWithCapital(name);
  for (const m of open.matchAll(new RegExp(phraseSource(name, '\\s+'), 'giu'))) {
    if (isWordChar(open[m.index - 1]) || isWordChar(open[m.index + m[0].length])) continue;
    if (!capital || startsWithCapital(m[0])) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** A text with some stretches hidden, its length kept. */
function withHidden(text, spans) {
  if (!spans.length) return text;
  const chars = text.split('');
  for (const [start, end] of spans) chars.fill(HIDDEN, start, end);
  return chars.join('');
}

/**
 * What in a cue's text breaks the rule that people are referred to by token only.
 *   'unknown-token'  a token whose id is not in the cast, or not in this section's
 *                    legend when one is given; also a brace of any width that is no
 *                    token at all
 *   'bare-id'        an id or a mark named in the open: P3 without braces, "3 号人物",
 *                    "红框", "the red box", "person 2"
 *   'name-leak'      a name of two or more characters written in the cue's own words:
 *                    a character's name or alias, a name its evidence ever gave it
 *                    (a rejected one too), or one capitalised word of such a name of
 *                    several words ("Mary" of "Aunt Mary"; not a title or a particle
 *                    before its last word)
 *   'too-long'       a text of more than 2000 characters: it is not read at all
 * Quotations and the cue's onScreenText are not read for 'bare-id' and 'name-leak':
 * a parking sign may say "P3". A kind 'text' cue is read like any other, except
 * that a name its own onScreenText carries may stand anywhere in it. Tokens are
 * normalised first, so ｛P3｝ is a token.
 * @param {import('./types.js').FilmCue} cue
 * @param {import('./types.js').Cast} cast
 * @param {{legendIds?: Iterable<string>}} [options]  the ids marked on this section's frames
 * @returns {Array<{type: 'unknown-token'|'bare-id'|'name-leak'|'too-long', detail: string, field: 'brief'|'standard'|'detailed'}>}
 *   detail: the id, the words found, the name, or the length of the text. Each once per field.
 */
export function violations(cue, cast, options) {
  const found = [];
  const known = new Set(charactersOf(cast).map((c) => c.id));
  const legend = idSet(options?.legendIds);
  const names = castNames(cast);
  // The model chooses the kind: a text cue excuses only a name its own on-screen text carries.
  const screen = cue?.kind === 'text' && typeof cue.onScreenText === 'string' && !tooLong(cue.onScreenText) ? cue.onScreenText : '';
  const onScreen = (name) => Boolean(screen) && nameSpans(screen, name).length > 0;
  for (const field of FIELDS) {
    if (tooLong(cue?.[field])) {
      found.push({ type: 'too-long', detail: String(cue[field].length), field });
      continue;
    }
    const text = normalizeTokens(cue?.[field]);
    if (!text) continue;
    const add = (type, detail) => {
      if (!found.some((v) => v.type === type && v.field === field && v.detail === detail)) found.push({ type, detail, field });
    };
    // A token is filled in wherever it stands, so every one is checked, quoted or not.
    for (const id of tokensIn(text)) {
      if (!known.has(id) || (legend && !legend.has(id))) add('unknown-token', id);
    }
    const open = inTheOpen(text, cue);
    const bare = open.replace(tokenPattern(), (token) => HIDDEN.repeat(token.length));
    for (const m of bare.matchAll(STRAY_BRACE)) add('unknown-token', m[0]);
    for (const rule of BARE_ID_RULES) {
      for (const m of bare.matchAll(rule.find)) {
        if (!rule.when || rule.when(m, bare)) add('bare-id', m[0].trim());
      }
    }
    let rest = open;
    for (const name of names.whole) {
      if (onScreen(name)) continue;
      const spans = nameSpans(open, name);
      if (!spans.length) continue;
      add('name-leak', name);
      rest = withHidden(rest, spans);
    }
    // One word of a longer name counts where it stands alone: inside the whole name it was reported with it.
    for (const part of names.parts) {
      if (!onScreen(part) && nameSpans(rest, part).length) add('name-leak', part);
    }
  }
  return found;
}

/** The seconds around a cue in which its people must be seen: [start - before, end + after]. */
function cueWindow(cue, range) {
  const start = Number.isFinite(cue.start) ? cue.start : 0;
  const end = Number.isFinite(cue.end) ? Math.max(cue.end, start) : start;
  const before = Number.isFinite(range?.before) ? range.before : DEFAULT_WINDOW.before;
  const after = Number.isFinite(range?.after) ? range.after : DEFAULT_WINDOW.after;
  return [start - before, end + after];
}

/**
 * Checks one cue against the cast and against who is on screen around it.
 * A token whose character is not seen in [start - before, end + after] is
 * demoted: its entry in people gets demoted: true and the name gate uses the
 * label. When the identity mode cannot tell (visible returns null, or there is
 * no visible), the check is 'n/a' and is not taken as passed: every person is
 * demoted, unless allowNamesWithoutTracks says names may be spoken unchecked.
 * @param {import('./types.js').FilmCue} cue
 * @param {object} options
 * @param {import('./types.js').Cast} options.cast
 * @param {(t0: number, t1: number) => Iterable<string>|null} [options.visible]  the ids seen between two times
 * @param {{before: number, after: number}} [options.window]
 * @param {Iterable<string>} [options.legendIds]
 * @param {boolean} [options.allowNamesWithoutTracks]
 * @returns {{cue: import('./types.js').FilmCue, status: 'ok'|'demoted'|'needs-repair', demoted: string[],
 *   violations: Array<{type: string, detail: string, field: string}>, trackCheck: 'ok'|'failed'|'n/a'}}
 *   cue: a new cue with its tokens normalised and people rebuilt from the tokens of the three texts
 *   (tracks kept, demoted set afresh). status: 'needs-repair' when there are violations (the caller
 *   asks the model once more), else 'demoted' when someone was demoted, else 'ok'.
 *   trackCheck: 'ok' every token's character was seen, 'failed' one was not, 'n/a' nobody can tell.
 */
export function verifyCue(cue, options) {
  const { cast, visible, window: range = DEFAULT_WINDOW, legendIds, allowNamesWithoutTracks = false } = options || {};
  const texts = {};
  const ids = [];
  for (const field of FIELDS) {
    // A text too long to read stays as it is: violations reports it, and the cue is not spoken unchecked.
    if (typeof cue[field] !== 'string' || tooLong(cue[field])) continue;
    texts[field] = normalizeTokens(cue[field]);
    for (const id of tokensIn(texts[field])) {
      if (!ids.includes(id)) ids.push(id);
    }
  }

  const [from, to] = cueWindow(cue, range);
  const seen = typeof visible === 'function' ? idSet(visible(from, to)) : null;
  let unseen = ids.filter((id) => !seen?.has(id));
  if (!seen && allowNamesWithoutTracks) unseen = [];
  const trackCheck = !seen ? 'n/a' : unseen.length ? 'failed' : 'ok';

  const previous = new Map();
  for (const person of Array.isArray(cue.people) ? cue.people : []) {
    if (person && typeof person.char === 'string' && !previous.has(person.char)) previous.set(person.char, person);
  }
  const people = ids.map((id) => {
    const person = { char: id };
    const tracks = previous.get(id)?.tracks;
    if (Array.isArray(tracks)) person.tracks = [...tracks];
    if (unseen.includes(id)) person.demoted = true;
    return person;
  });

  const checked = { ...cue, ...texts, people };
  const found = violations(checked, cast, { legendIds });
  const status = found.length ? 'needs-repair' : unseen.length ? 'demoted' : 'ok';
  return { cue: checked, status, demoted: unseen, violations: found, trackCheck };
}

// ---- A generic person where a token belongs ----

/** What ends a clause, or stands where hidden text was. */
const CLAUSE_BREAK = /[\s，。！？；：、,.!?;:…—\u0000]/;
const atClauseStart = (before) => before === undefined || CLAUSE_BREAK.test(before);
const hasMore = (after) => after !== undefined && !CLAUSE_BREAK.test(after);

/**
 * "一个女人", "一名男子", "一位女士" and the other pairings, with the 有 that may
 * introduce them. Not after a number or a word that makes it someone else or
 * nobody ("二十一个男人", "另一个女人", "每一个男人"), and not in a comparison
 * ("像一个男人", "扮成一个女人").
 */
const ZH_GENERIC_NOUN = /(?<![另同每那这哪某第像是成为如似当做作十百千万两二三四五六七八九〇零0-9０-９])(有)?一[个名位](女人|男人|男子|女子|女士|男士)(?!们)/g;
const ZH_SOMEONE = /有人(?!的)|(?<!某)某人(?!们)/g;
/** "a man", "a woman", "a person", "someone", "somebody" as whole phrases: not "a manager", not "a man-made lake". */
const EN_GENERIC = /\b(?:a\s+(man|woman|person)|someone|somebody)(?![\w-])/gi;
/** After these the phrase compares or depicts, it does not point at a person: "dressed as a man", "a statue of a woman". */
const EN_NOT_A_PERSON = new Set([
  'like', 'as', 'than', 'such', 'what', 'quite', 'half', 'not', 'many', 'of', 'for',
  'is', 'was', 'are', 'were', 'be', 'been', 'being', 'become', 'becomes', 'became', 'becoming',
]);

// A generic person is a person, but not always the one on screen. Each of the
// rules below leaves the phrase standing (a relapse, so the model is asked again)
// where a token would name somebody the picture does not vouch for.

/** She, he or they earlier in the text already stand for whoever is on screen: the generic person is then someone else. */
const PRONOUN_BEFORE = /她|(?<![其吉])他|\b(?:s?he|her|hers|him|his|herself|himself|they|them|their|theirs|themselves)\b/i;
/** "一个女人的照片", "a woman's voice": what is named is hers and need not be her. */
const POSSESSIVE_AFTER = /^(?:的|['’]s(?![A-Za-z]))/;
/** "The photograph shows a woman": a picture of a person, like "a statue of a woman". */
const EN_DEPICTS = new Set(['shows', 'showing', 'depicts', 'depicting', 'portrays', 'portraying', 'pictures', 'picturing']);
/** A picture or a broadcast named earlier in the sentence: who is in it need not be who is in the room. */
const EN_PICTURE = /\b(?:photo(?:graph)?s?|pictures?|portraits?|paintings?|posters?|drawings?|sketch(?:es)?|murals?|billboards?|screens?|televisions?|tv|monitors?|videos?|radios?|newspapers?|magazines?)\b/i;
const ZH_PICTURE = /照片|相片|画像|肖像|海报|画[上中里]|屏幕|电视|视频|录像|收音机|广播|报纸|杂志/;
/**
 * A description of the generic person right after the phrase ("a woman in a red
 * dress", "一个女人穿着红裙子"): with a token there the name gate would say the
 * cast's label and outfit beside the model's own. Not "穿过马路" or "戴上帽子".
 */
const EN_OWN_LOOK = /^,?\s+(?:in|with|wearing|dressed|clad|who|whose)\b/i;
const ZH_OWN_LOOK = /^[，,]?\s*(?:身?穿(?![过越行梭透])|身着|头?戴(?![上好])|留着|披着)/;

/** The sentence a position stands in, up to that position: what follows the last full stop, question or exclamation mark. */
const SENTENCE_STOPS = Object.freeze(['。', '！', '？', '.', '!', '?']);
const sentenceUpTo = (before) => before.slice(Math.max(...SENTENCE_STOPS.map((stop) => before.lastIndexOf(stop))) + 1);

/** Whether the generic person at [start, end) can be the one person on screen, as far as the words around it say. */
function canBeTheOneOnScreen(open, start, end, picture, ownLook) {
  const before = open.slice(0, start);
  const after = open.slice(end);
  return !PRONOUN_BEFORE.test(before) && !picture.test(sentenceUpTo(before)) && !POSSESSIVE_AFTER.test(after) && !ownLook.test(after);
}

/**
 * The generic people in a text (already without its quotations): where each
 * stands, the gender the words give, and whether a token can take its place
 * (`safe`) without breaking the sentence or naming somebody else: see the rules
 * above. The description language picks the word list; without one both are tried.
 */
function genericMentions(open, lang) {
  const found = [];
  if (!/^en\b/i.test(String(lang || ''))) {
    for (const m of open.matchAll(ZH_GENERIC_NOUN)) {
      const end = m.index + m[0].length;
      const before = open[m.index - 1];
      // "没有一个女人" says there is none.
      if (m[1] && before === '没') continue;
      // In "有一个女人走进来" the 有 only introduces her and goes with the phrase;
      // in "门口有一个女人。" it is the verb and stays.
      const keep = m[1] && !(atClauseStart(before) && hasMore(open[end])) ? 1 : 0;
      found.push({ start: m.index + keep, end, gender: m[2].includes('女') ? 'f' : 'm', safe: canBeTheOneOnScreen(open, m.index, end, ZH_PICTURE, ZH_OWN_LOOK) });
    }
    for (const m of open.matchAll(ZH_SOMEONE)) {
      const end = m.index + m[0].length;
      const before = open[m.index - 1];
      const fine = canBeTheOneOnScreen(open, m.index, end, ZH_PICTURE, ZH_OWN_LOOK);
      if (m[0] === '某人') {
        found.push({ start: m.index, end, gender: null, safe: fine });
        continue;
      }
      // "没有人" is nobody and "所有人" everybody.
      if (before === '没' || before === '所') continue;
      // Only the 有人 that opens a clause and has a verb after it is a subject a token can replace
      // ("有人敲门"); "屋里有人。" would lose its verb.
      found.push({ start: m.index, end, gender: null, safe: fine && atClauseStart(before) && hasMore(open[end]) });
    }
  }
  if (!isCjk(lang)) {
    for (const m of open.matchAll(EN_GENERIC)) {
      const end = m.index + m[0].length;
      const lead = /([A-Za-z]+)\s+$/.exec(open.slice(0, m.index));
      if (lead && EN_NOT_A_PERSON.has(lead[1].toLowerCase())) continue;
      const noun = (m[1] || '').toLowerCase();
      const gender = noun === 'man' ? 'm' : noun === 'woman' ? 'f' : null;
      // "someone else" is a person, but not one a token can stand for; nor is the person a picture shows.
      const fine = !/^\s+else\b/i.test(open.slice(end)) && !(lead && EN_DEPICTS.has(lead[1].toLowerCase()));
      found.push({ start: m.index, end, gender, safe: fine && canBeTheOneOnScreen(open, m.index, end, EN_PICTURE, EN_OWN_LOOK) });
    }
  }
  return found;
}

/** The gender a character's visual label states ("长发女人", "man in a grey coat"); null when it states none or both. */
function genderOf(character) {
  const zh = String(character?.descriptor?.zh || '');
  const en = String(character?.descriptor?.en || '').toLowerCase();
  const female = /女|妇|太太|奶奶|阿姨|姑娘/.test(zh) || /\b(?:woman|girl|lady|female)\b/.test(en);
  const male = /男|老头|大叔|爷爷|小伙/.test(zh) || /\b(?:man|boy|gentleman|male)\b/.test(en);
  if (female === male) return null;
  return female ? 'f' : 'm';
}

/**
 * A generic person ("一个女人", "一名男子", "有人", "a man", "someone") written
 * while a main character is the only person with a track in the cue's window
 * (peopleCount is 1, a face nobody has placed counted, and visibleIds holds that
 * character alone) is replaced by that character's token. Left alone, with
 * relapse true, in every other case: nobody, several people or an unknown number
 * of them in the window, and also when the replacement could name the wrong
 * person or break the sentence:
 *   - the cue already holds a token: the character's own (the generic person is
 *     then someone else) or anybody else's (a second person the tracks do not show);
 *   - a version mentions two generic people;
 *   - the words say a woman and the character's label says a man;
 *   - a pronoun already stands before the phrase ("She hands the letter to a woman");
 *   - the phrase is a possessive ("a woman's voice", "一个女人的照片") or a picture
 *     or broadcast shows the person ("The photograph shows a woman", "照片里有一个女人");
 *   - the generic person carries a description of its own ("a woman in a red
 *     dress", "一个女人穿着红裙子"): the name gate would say the cast's beside it;
 *   - the phrase cannot be swapped for a name ("屋里有人。", "someone else");
 *   - the character is not in the section's legend (the token would be a violation).
 * The three versions are repaired together or not at all. A kind 'text' cue,
 * quoted text and a cue with a text too long to read are never touched.
 * @param {import('./types.js').FilmCue} cue
 * @param {{cast: import('./types.js').Cast, visibleIds: Iterable<string>, peopleCount?: number|null, lang?: string,
 *   legendIds?: Iterable<string>}} options
 *   visibleIds: who is seen in the cue's window (an identity provider's visibleBetween);
 *   peopleCount: how many people are seen there, placed or not (its peopleBetween), null or
 *   missing when nobody can count them; lang: the description language;
 *   legendIds: the ids marked on this section's frames, when the caller checks tokens against them
 * @returns {{cue: import('./types.js').FilmCue, repaired: boolean, relapse: boolean}}  a new cue
 */
export function repairGeneric(cue, options) {
  const { cast, visibleIds, peopleCount, lang, legendIds } = options || {};
  const same = { cue: { ...cue }, repaired: false, relapse: false };
  if (cue.kind === 'text' || FIELDS.some((field) => tooLong(cue[field]))) return same;

  const mentions = {};
  let total = 0;
  for (const field of FIELDS) {
    const text = typeof cue[field] === 'string' ? cue[field] : '';
    mentions[field] = text ? genericMentions(inTheOpen(text, cue), lang) : [];
    total += mentions[field].length;
  }
  if (!total) return same;

  const seen = idSet(visibleIds) || new Set();
  const legend = idSet(legendIds);
  const mains = charactersOf(cast).filter((c) => c.main && seen.has(c.id));
  // One person track in the window and no more: a stranger, placed or not, could be the one the words mean.
  const alone = peopleCount === 1 && seen.size === 1;
  const who = alone && mains.length === 1 ? mains[0] : null;
  const gender = genderOf(who);
  const replaceable = Boolean(who)
    && (!legend || legend.has(who.id))
    && !FIELDS.some((field) => tokensIn(normalizeTokens(cue[field])).length > 0)
    && FIELDS.every((field) => mentions[field].length <= 1
      && mentions[field].every((m) => m.safe && !(m.gender && gender && m.gender !== gender)));
  if (!replaceable) return { ...same, relapse: true };

  const repaired = { ...cue };
  for (const field of FIELDS) {
    const [mention] = mentions[field];
    if (mention) repaired[field] = cue[field].slice(0, mention.start) + tokenFor(who.id) + cue[field].slice(mention.end);
  }
  const people = Array.isArray(cue.people) ? cue.people : [];
  repaired.people = people.some((p) => p?.char === who.id) ? [...people] : [...people, { char: who.id }];
  return { cue: repaired, repaired: true, relapse: false };
}

/**
 * Checks every cue of a script: the generic repair first (the model's cues only:
 * what a person wrote is not rewritten), then verifyCue.
 * @param {import('./types.js').FilmScript} script
 * @param {object} options
 * @param {import('./types.js').Cast} options.cast
 * @param {{visibleBetween: (t0: number, t1: number) => string[]|null, peopleBetween?: (t0: number, t1: number) => number|null}} [options.identity]
 *   an identity provider; without one nobody can tell who is on screen, and one that cannot count the
 *   people (no peopleBetween, or null from it) gets no generic repair
 * @param {{before: number, after: number}} [options.window]
 * @param {Iterable<string>} [options.legendIds]
 * @param {boolean} [options.allowNamesWithoutTracks]
 * @param {string} [options.lang]  the description language; the script's own by default
 * @returns {{script: import('./types.js').FilmScript,
 *   report: {checked: number, demoted: number, needsRepair: number, relapses: number},
 *   results: Array<{id: string, status: string, demoted: string[], violations: object[], trackCheck: string, repaired: boolean, relapse: boolean}>}}
 *   script: a new script with the checked cues. report counts cues: checked, with someone demoted,
 *   with violations, with a generic person left standing. results: one entry per cue, in order, so
 *   the caller knows which cues to ask the model for again.
 */
export function verifyScript(script, options) {
  const { cast, identity, window: range = DEFAULT_WINDOW, legendIds, allowNamesWithoutTracks = false, lang = script?.lang } = options || {};
  const canTell = typeof identity?.visibleBetween === 'function';
  const report = { checked: 0, demoted: 0, needsRepair: 0, relapses: 0 };
  const results = [];

  const cues = (Array.isArray(script?.cues) ? script.cues : []).map((cue) => {
    if (!cue || typeof cue !== 'object') return cue;
    // One look at the picture serves both steps: the repair does not move the cue.
    const [from, to] = cueWindow(cue, range);
    const seen = canTell ? idSet(identity.visibleBetween(from, to)) : null;
    const peopleCount = seen && typeof identity.peopleBetween === 'function' ? identity.peopleBetween(from, to) : null;
    const fixed = cue.by === 'human'
      ? { cue, repaired: false, relapse: false }
      : repairGeneric(cue, { cast, visibleIds: seen || [], peopleCount, lang, legendIds });
    const result = verifyCue(fixed.cue, { cast, visible: () => seen, window: range, legendIds, allowNamesWithoutTracks });

    report.checked += 1;
    if (result.demoted.length) report.demoted += 1;
    if (result.status === 'needs-repair') report.needsRepair += 1;
    if (fixed.relapse) report.relapses += 1;
    results.push({
      id: cue.id,
      status: result.status,
      demoted: result.demoted,
      violations: result.violations,
      trackCheck: result.trackCheck,
      repaired: fixed.repaired,
      relapse: fixed.relapse,
    });
    return result.cue;
  });

  return { script: { ...script, cues }, report, results };
}
