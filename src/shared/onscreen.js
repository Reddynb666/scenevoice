// On-screen text the viewer already hears. A slide title the presenter reads
// out, or subtitles burned into the picture that match the video's captions,
// would only be heard twice: such text cues are dropped before playback.
// No browser APIs here, so everything is unit-testable.

import { isNonSpeech } from './dialogue.js';

const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g;

/**
 * Words of a text, for comparing on-screen text with captions: letters and
 * digits in lower case ("$19.99" → "19", "99"). Chinese, Japanese and Korean
 * have no spaces, so they count in pairs of characters.
 */
export function textTokens(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase();
  const tokens = [];
  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  for (const word of s.replace(CJK_RUN, ' ').split(/[^\p{L}\p{N}]+/u)) {
    if (word) tokens.push(word);
  }
  return tokens;
}

/**
 * What a text cue reads from the screen: its transcription or, in scripts made
 * before there was one, what its description quotes. '' when neither says.
 */
export function screenTextOf(cue) {
  if (cue?.kind !== 'text') return '';
  if (cue.onScreenText) return cue.onScreenText;
  const quoted = [...String(cue.standard || '').matchAll(/"([^"]+)"|“([^”]+)”|「([^」]+)」|『([^』]+)』/g)];
  return quoted.map((m) => m.slice(1).find(Boolean)).join(' ');
}

/** Share (0..1) of the words in `tokens` that are among `heard`. */
export function heardShare(tokens, heard) {
  if (!tokens.length) return 0;
  return tokens.filter((tok) => heard.has(tok)).length / tokens.length;
}

/**
 * Drop text cues whose words are spoken around the same time, going by the
 * captions. Visual cues are never dropped, nor text the captions do not cover.
 * @param {Array} cues  sorted by start
 * @param {Array<{start: number, end: number, text: string}>} lines  caption lines
 * @param {object} [o]
 * @param {number} [o.before]  seconds of captions before the text appears that count
 * @param {number} [o.after]   seconds after: a presenter may read a slide a little later
 * @param {number} [o.share]   how much of the text must be heard to count as heard
 * @returns {{cues: Array, dropped: Array}}
 */
export function dropTextHeardInCaptions(cues, lines, { before = 10, after = 15, share = 0.8 } = {}) {
  const speech = (lines || []).filter((l) => l && Number.isFinite(l.start) && Number.isFinite(l.end) && !isNonSpeech(l.text));
  if (!speech.length) return { cues, dropped: [] };
  const kept = [];
  const dropped = [];
  for (const cue of cues) {
    const tokens = cue.kind === 'text' ? textTokens(screenTextOf(cue)) : [];
    if (tokens.length) {
      const heard = new Set();
      for (const l of speech) {
        if (l.end >= cue.start - before && l.start <= cue.start + after) textTokens(l.text).forEach((tok) => heard.add(tok));
      }
      if (heardShare(tokens, heard) >= share) {
        dropped.push(cue);
        continue;
      }
    }
    kept.push(cue);
  }
  return { cues: kept, dropped };
}
