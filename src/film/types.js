// Shared vocabulary of the film engine: the character token, the naming levels,
// the default policy, and the shapes every module passes around (as JSDoc types).
// Pure data and tiny helpers only. See README.md in this folder for the contracts.

/**
 * How a description refers to a person. The model never writes a name: it
 * writes the token of the person it means ("{P3} walks to the window"), and the
 * name gate (namegate.js) turns the token into a visual label or the name.
 */
export const TOKEN_SOURCE = '\\{P(\\d+)\\}';
/** A fresh global matcher for character tokens (regular expressions with /g keep state). */
export const tokenPattern = () => new RegExp(TOKEN_SOURCE, 'g');
/** 'P3' → '{P3}'. */
export const tokenFor = (id) => `{${id}}`;
/** The highest character number: six digits, the most a token is read with ({P999999}). */
export const MAX_CHARACTER_NUMBER = 999999;
/** Whether a string is a character id: 'P1', 'P27'. Six digits at most, so its number is always exact. */
export const isCharacterId = (value) => typeof value === 'string' && /^P[1-9]\d{0,5}$/.test(value);
/** The character ids a text refers to, each once, in order of first mention. */
export function tokensIn(text) {
  const seen = [];
  for (const m of String(text || '').matchAll(tokenPattern())) {
    const id = `P${m[1]}`;
    if (!seen.includes(id)) seen.push(id);
  }
  return seen;
}

/**
 * How sure the name of a character is.
 * 0 no name evidence: a stable visual label only.
 * 1 one clue: never spoken, waits for a person to confirm.
 * 2 two independent clues that agree: spoken only when the policy allows automatic names.
 * 3 confirmed by a person (by ear or by sight), or carried by a package.
 */
export const LEVEL = Object.freeze({ LABEL: 0, CLUE: 1, CLUES: 2, CONFIRMED: 3 });

/** When a name may first be spoken. */
export const NAMING = Object.freeze(['first-appearance', 'on-reveal']);

/** Where a name clue came from. 'human' is a confirmation, not a clue. */
export const EVIDENCE_KINDS = Object.freeze(['vocative', 'self-intro', 'third-person', 'on-screen', 'credits', 'human']);

/**
 * The naming policy a film starts with. Names are spoken only once a person has
 * confirmed them (minLevel 3); two clues count as independent when they are at
 * least independentGapSec apart or of different kinds; a character not mentioned
 * for reanchorAfterSec is tied to the visual label again.
 */
export const DEFAULT_POLICY = Object.freeze({
  naming: 'first-appearance',
  minLevel: LEVEL.CONFIRMED,
  introBeforeFilm: true,
  reanchorAfterSec: 1200,
  independentGapSec: 90,
});

/** The speaking rate estimateSeconds (shared/script.js) assumes at rate 1. */
export const DEFAULT_RATE = Object.freeze({ cjkPerSec: 4.5, wordsPerSec: 2.8, lead: 0.25 });

/**
 * Whether a language is written without spaces between words (budgets count
 * characters). "zh_CN", the spelling of the locale files, counts as well as "zh-CN".
 */
export const isCjk = (lang) => /^(zh|ja|ko|yue|cmn)(?![a-z])/i.test(String(lang || ''));

/**
 * @typedef {object} Evidence
 * @property {number} t            seconds into the film
 * @property {'vocative'|'self-intro'|'third-person'|'on-screen'|'credits'|'human'} kind
 * @property {string} name         the name this evidence supports
 * @property {'ear'|'sight'} [by]  for kind 'human': confirmed by listening, or by a sighted person
 * @property {string} [quote]      the line of dialogue or on-screen text (never exported in a package)
 * @property {boolean} [rejected]  a person said this name is not this character's
 *
 * @typedef {object} Character
 * @property {string} id                     'P3'
 * @property {string|null} name
 * @property {0|1|2|3} level
 * @property {Array<{text: string, lang?: string, kind?: string, validFrom?: number}>} aliases
 * @property {string} [say]                  how the name is pronounced, when the spelling does not say
 * @property {{zh?: string, en?: string}} descriptor  a stable visual label of features that do not
 *   change with the costume: zh "长发女人", en "woman with long hair" (no article, lower case)
 * @property {number|null} revealAt          the film reveals the name here; null = no reveal point
 * @property {boolean} spoilerLock           the identity is a plot secret: never named before revealAt
 * @property {boolean} neverName             a person asked that this character is never named
 * @property {boolean} main                  one of the lockable main characters
 * @property {number} screenSec
 * @property {Evidence[]} evidence
 * @property {string[]} clusters             face clusters, on this computer only (never exported)
 *
 * @typedef {object} Appearance
 * @property {string} char
 * @property {number} from
 * @property {number|null} to                null = still current
 * @property {string} outfit                 zh "红裙子", en "a red dress"
 * @property {number} [scene]
 * @property {'model'|'human'} src
 *
 * @typedef {object} Policy
 * @property {'first-appearance'|'on-reveal'} naming
 * @property {2|3} minLevel
 * @property {boolean} introBeforeFilm
 * @property {number} reanchorAfterSec
 * @property {number} independentGapSec
 *
 * @typedef {object} Cast
 * @property {1} v
 * @property {Policy} policy
 * @property {Character[]} characters
 * @property {Appearance[]} appearances
 * @property {{mustLink: string[][], cannotLink: string[][]}} constraints
 * @property {object[]} events               append-only record of what people changed
 *
 * @typedef {object} Slot  A pause in the dialogue a description may be spoken in.
 * @property {string} id                     'g_0001'
 * @property {number} start
 * @property {number} end
 * @property {number} room                   seconds available (end - start)
 * @property {{units: 'chars'|'words', brief: number, standard: number, detailed: number}} budget
 * @property {'subs'|'vad'|'asr'} src
 *
 * @typedef {object} FilmCue
 * @property {string} id                     'q_000001'
 * @property {string|null} slot              the slot it is spoken in; null for an extended description
 * @property {number} start
 * @property {number} end
 * @property {'visual'|'text'|'intro'|'extended'} kind
 * @property {1|2|3} priority
 * @property {string} brief                  text with character tokens
 * @property {string} standard
 * @property {string} detailed
 * @property {Array<{char: string, tracks?: string[], demoted?: boolean}>} people
 * @property {string} [onScreenText]
 * @property {'high'|'medium'|'low'} [confidence]
 * @property {number} [scene]
 * @property {'ai'|'edited'|'reviewed'|'blind-ok'|'locked'|'needs-check'} status
 * @property {'ai'|'human'} by
 * @property {{file: string, dur: number, voice: string, textHash: string, version: 'brief'|'standard'|'detailed'}} [clip]
 *
 * @typedef {object} FilmScript
 * @property {3} v
 * @property {string} filmId
 * @property {string} lang
 * @property {number} duration
 * @property {Slot[]} slots
 * @property {FilmCue[]} cues
 * @property {number[]} scenes               scene start times
 *
 * @typedef {object} RenderedCue  A cue with every token filled in, ready to be spoken or exported.
 * @property {string} id
 * @property {number} start
 * @property {number} end
 * @property {number} room
 * @property {'visual'|'text'|'intro'|'extended'} kind
 * @property {1|2|3} priority
 * @property {string} brief
 * @property {string} standard
 * @property {string} detailed
 * @property {string[]} people
 * @property {Object<string, 'label'|'label-outfit'|'intro'|'name'|'reanchor'>} forms
 * @property {boolean} [silent]              not to be spoken: it still carried a token or an id
 *
 * @typedef {object} Visible  One person on screen at a moment.
 * @property {string} characterId
 * @property {[number, number, number, number]} box  x, y, width, height in pixels of the sampled frame
 * @property {number} conf
 * @property {string} [trackId]
 *
 * @typedef {object} IdentityProvider
 * @property {'ground-truth'|'face-cluster'|'prompt-bank'} mode
 * @property {(t: number) => Visible[]} visibleAt
 * @property {(t0: number, t1: number) => string[]|null} visibleBetween  null = this mode cannot tell
 * @property {(t0: number, t1: number) => number|null} peopleBetween  how many people are seen between two
 *   times, those nobody has placed yet included; null = this mode cannot tell
 *
 * @typedef {object} KillTestReport
 * @property {string} id                     'K1'
 * @property {string} metric
 * @property {number} value
 * @property {number} threshold
 * @property {boolean} pass
 * @property {string} film
 * @property {string} source                 where the film came from (open licence, public domain, bought, partner)
 * @property {string} model
 * @property {string} date                   ISO date
 */
