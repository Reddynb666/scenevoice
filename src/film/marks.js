// Numbered boxes on a frame, and the legend that goes with them. A frame sent to a
// model carries a coloured box around each known person, with the character id on
// a tag ("P3"); the legend says in words who each mark is. The model then writes
// the token of the person it means, and never has to recognise a face or be told
// a name it may not speak.
// Everything here is arithmetic on boxes and bytes, so the command line experiments
// and the app draw exactly the same picture: what the test of the model (K1)
// measures is what ships.

import { DEFAULT_POLICY, LEVEL, NAMING, isCharacterId } from './types.js';

const colour = (id, en, zh, rgb) => Object.freeze({ id, name: Object.freeze({ en, zh }), rgb: Object.freeze(rgb) });

/**
 * The colours of the marks: the eight of the Okabe-Ito palette, which stay apart
 * for readers with any of the common colour vision deficiencies (a sighted helper
 * at the production desk reads these frames too). `id` is the palette's own name;
 * `name` is the plain word the legend uses, the one a model would use for what it
 * sees ("red" for vermilion, "红" so that the legend reads "红框").
 * Neighbouring numbers get colours far apart, and black comes last because it is
 * the hardest to see on a dark frame.
 */
export const MARK_COLOURS = Object.freeze([
  colour('orange', 'orange', '橙', [230, 159, 0]),
  colour('sky-blue', 'sky blue', '天蓝', [86, 180, 233]),
  colour('vermilion', 'red', '红', [213, 94, 0]),
  colour('bluish-green', 'green', '绿', [0, 158, 115]),
  colour('yellow', 'yellow', '黄', [240, 228, 66]),
  colour('blue', 'blue', '蓝', [0, 114, 178]),
  colour('reddish-purple', 'purple', '紫', [204, 121, 167]),
  colour('black', 'black', '黑', [0, 0, 0]),
]);

/** A face box of fewer square pixels than this is too small to carry a mark: the person is boxed instead. */
const MIN_FACE_AREA = 4000;

const BLACK = Object.freeze([0, 0, 0]);
const WHITE = Object.freeze([255, 255, 255]);

/** 'P12' → 12. */
const numberOf = (id) => Number(id.slice(1));

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** A box that can be drawn: [x, y, width, height], all finite, with some area. */
const isBox = (box) => Array.isArray(box)
  && box.length === 4
  && box.every((v) => typeof v === 'number' && Number.isFinite(v))
  && box[2] > 0
  && box[3] > 0;

/** Three numbers that can be a colour. */
const isRgb = (rgb) => (Array.isArray(rgb) || ArrayBuffer.isView(rgb))
  && rgb.length === 3
  && [rgb[0], rgb[1], rgb[2]].every((v) => typeof v === 'number' && Number.isFinite(v));

/** The colour a character number has when nobody else on screen wants it. */
function homeColour(id) {
  const n = numberOf(id);
  return Number.isSafeInteger(n) ? (n - 1) % MARK_COLOURS.length : 0;
}

/** A box rounded to whole pixels and cut to the frame; null when none of it is inside. */
function clipBox([x, y, w, h], frame) {
  const x0 = clamp(Math.round(x), 0, frame.w);
  const y0 = clamp(Math.round(y), 0, frame.h);
  const x1 = clamp(Math.round(x + w), 0, frame.w);
  const y1 = clamp(Math.round(y + h), 0, frame.h);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/** How bright a colour is to the eye, from 0 (black) to 1 (white): the relative luminance of WCAG. */
function luminance(rgb) {
  const linear = (v) => {
    const c = clamp(v, 0, 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/**
 * The colour of the id written on a tag of the given colour: black or white,
 * whichever stands out more (the contrast ratio of WCAG). White alone would not
 * do: on yellow, orange or sky blue it is close to unreadable, and a number the
 * model misreads is a description given to the wrong person.
 * @param {number[]} rgb  the tag's colour
 * @returns {number[]} [0, 0, 0] or [255, 255, 255]
 */
export function tagTextColour(rgb) {
  if (!isRgb(rgb)) return [...WHITE];
  const l = luminance(rgb) + 0.05;
  // Contrast with black is l / 0.05, with white 1.05 / l.
  return l * l > 1.05 * 0.05 ? [...BLACK] : [...WHITE];
}

/**
 * The marks to draw on a frame: one per visible character.
 * A character's colour comes from its number (P1 the first colour, P9 the first
 * again), so it is the same in every frame; when two people on screen would share
 * a colour, the one with the higher number takes the next colour nobody on screen
 * has. With more than eight people colours repeat, and the number on the tag still
 * tells them apart.
 * A face of less than minFaceArea square pixels is too small for a box anyone can
 * see: the mark is then a box around the person, the face box three times as wide
 * and reaching down to the bottom of the frame. Boxes are cut to the frame and
 * rounded to whole pixels; someone wholly outside the frame gets no mark.
 * @param {import('./types.js').Visible[]} visible  what an identity provider's visibleAt() returned
 * @param {{frame: {w: number, h: number}, minFaceArea?: number}} options  frame: the size of the picture in pixels
 * @returns {Array<{char: string, colour: {id: string, name: {en: string, zh: string}, rgb: number[]}, box: number[], kind: 'face'|'person'}>}
 *   in order of character number; [] without a frame size
 */
export function assignMarks(visible, options) {
  const size = options && options.frame;
  if (!size || !(size.w >= 1) || !(size.h >= 1) || !Number.isFinite(size.w) || !Number.isFinite(size.h)) return [];
  const frame = { w: Math.floor(size.w), h: Math.floor(size.h) };
  const minFaceArea = Number.isFinite(options.minFaceArea) && options.minFaceArea >= 0 ? options.minFaceArea : MIN_FACE_AREA;

  // One box per character: two marks with the same number would say nothing.
  const people = new Map();
  for (const person of Array.isArray(visible) ? visible : []) {
    if (!person || typeof person !== 'object' || !isCharacterId(person.characterId) || !isBox(person.box)) continue;
    const kept = people.get(person.characterId);
    if (!kept || (Number(person.conf) || 0) > (Number(kept.conf) || 0)) people.set(person.characterId, person);
  }

  const marks = [];
  for (const id of [...people.keys()].sort((a, b) => numberOf(a) - numberOf(b))) {
    const [x, y, w, h] = people.get(id).box;
    const small = w * h < minFaceArea;
    const box = clipBox(small ? [x - w, y, w * 3, frame.h - y] : [x, y, w, h], frame);
    if (box) marks.push({ char: id, box, kind: small ? 'person' : 'face' });
  }

  // First everyone whose own colour is free, so that a higher number looking for
  // another colour never takes one that a person on screen has by right.
  const uses = MARK_COLOURS.map(() => 0);
  const chosen = new Map();
  const waiting = [];
  for (const mark of marks) {
    const home = homeColour(mark.char);
    if (uses[home]) {
      waiting.push(mark);
    } else {
      uses[home] = 1;
      chosen.set(mark.char, home);
    }
  }
  for (const mark of waiting) {
    // The next colour nobody has; once all eight are out, the next one used least.
    const least = Math.min(...uses);
    let index = homeColour(mark.char);
    while (uses[index] !== least) index = (index + 1) % uses.length;
    uses[index] += 1;
    chosen.set(mark.char, index);
  }
  return marks.map((mark) => ({ char: mark.char, colour: MARK_COLOURS[chosen.get(mark.char)], box: mark.box, kind: mark.kind }));
}

/** The colour of a mark: the one it carries (an entry of MARK_COLOURS, or its id), else the one its number has. */
function colourOf(mark) {
  const given = mark.colour;
  if (given && typeof given === 'object' && isRgb(given.rgb)) return given;
  if (typeof given === 'string') {
    const found = MARK_COLOURS.find((c) => c.id === given);
    if (found) return found;
  }
  return MARK_COLOURS[homeColour(mark.char)];
}

/** The words of a legend line. They are for the model, not for the listener, so they live here and not with the interface text. */
const LEGEND = Object.freeze({
  en: Object.freeze({ open: ' (', box: ' box', close: ')', colon: ': ', then: '; ', wearing: 'wearing: ', name: 'confirmed name: ' }),
  zh: Object.freeze({ open: '（', box: '框', close: '）', colon: '：', then: '；', wearing: '当前着装：', name: '已确认名：' }),
});

/**
 * Whether the legend is worded in Chinese (every other language gets English, which
 * every model reads). "zh_CN", the spelling of the locale files, counts as well as "zh-CN".
 */
const isChinese = (lang) => /^(zh|yue|cmn)(?![a-z])/i.test(String(lang || ''));

/** A text on one line: the legend has one line per mark, whatever a descriptor or an outfit contains. */
const oneLine = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');

/** The first of the texts that says something. */
const firstText = (...texts) => texts.map(oneLine).find(Boolean) || '';

/**
 * Whether a character's name may be given at time t: the rule of namegate.js
 * unlocked(), without the demotion (that belongs to a cue, not to a frame).
 * A frame without a time unlocks nothing: when in doubt the name stays here.
 */
function nameUnlocked(character, t, policy) {
  if (typeof t !== 'number' || Number.isNaN(t)) return false;
  if (!character || !oneLine(character.name)) return false;
  if (!(character.level >= policy.minLevel)) return false;
  if (character.neverName) return false;
  const revealAt = typeof character.revealAt === 'number' && !Number.isNaN(character.revealAt) ? character.revealAt : null;
  const beforeReveal = revealAt !== null && t < revealAt;
  if (character.spoilerLock && (revealAt === null || beforeReveal)) return false;
  if (policy.naming === 'on-reveal' && beforeReveal) return false;
  return true;
}

/**
 * The two parts of the naming policy a legend needs. Each comes from the options
 * when they say it validly, else from the cast, else from the default: a policy that only
 * lowers the level must not also forget that the cast waits for the reveal.
 * As in the name gate, a level below 2 is never accepted: one clue is not a
 * name to hand to a model as confirmed.
 */
function policyFor(options, cast) {
  const layers = [options && options.policy, cast && cast.policy, DEFAULT_POLICY].filter((p) => p && typeof p === 'object');
  return {
    naming: layers.map((p) => p.naming).find((v) => NAMING.includes(v)),
    minLevel: layers.map((p) => p.minLevel).find((v) => v === LEVEL.CLUES || v === LEVEL.CONFIRMED),
  };
}

/** What a character is wearing at time t, from the cast's appearances; '' when none is current. */
function outfitAt(cast, id, t) {
  let current = null;
  for (const appearance of Array.isArray(cast && cast.appearances) ? cast.appearances : []) {
    if (!appearance || appearance.char !== id || typeof appearance.from !== 'number') continue;
    if (!(appearance.from <= t)) continue;
    if (appearance.to != null && !(t < appearance.to)) continue;
    if (!current || appearance.from > current.from) current = appearance;
  }
  return current ? oneLine(current.outfit) : '';
}

/**
 * The legend sent with a marked frame: one line per mark, in the order of the
 * marks, saying who the mark is.
 *   "P3 (red box): woman with long hair; wearing: a red dress; confirmed name: Matthew"
 *   "P3（红框）：长发女人；当前着装：红裙子；已确认名：马修"
 * The outfit is there only when the cast has one current at t. The name is there
 * only when it is unlocked at t (it tells the model whom the dialogue means; the
 * model still writes tokens): a name the listener may not hear yet is never sent.
 * @param {Array<{char: string, colour?: object|string}>} marks  from assignMarks
 * @param {import('./types.js').Cast} cast  plain data: characters, appearances, policy
 * @param {number} t  the time of the frame, in seconds
 * @param {{lang?: string, policy?: import('./types.js').Policy}} [options]
 *   lang: Chinese wording for zh, English otherwise; policy: the naming policy, over the cast's own
 * @returns {string} '' when there are no marks
 */
export function legendText(marks, cast, t, options) {
  const zh = isChinese(options && options.lang);
  const words = zh ? LEGEND.zh : LEGEND.en;
  const policy = policyFor(options, cast);
  const characters = Array.isArray(cast && cast.characters) ? cast.characters : [];

  const lines = [];
  for (const mark of Array.isArray(marks) ? marks : []) {
    if (!mark || typeof mark !== 'object' || !isCharacterId(mark.char)) continue;
    const character = characters.find((c) => c && c.id === mark.char);
    const descriptor = character && character.descriptor && typeof character.descriptor === 'object' ? character.descriptor : {};
    const names = colourOf(mark).name || {};
    const colourName = zh ? firstText(names.zh, names.en) : firstText(names.en, names.zh);
    const head = colourName ? `${mark.char}${words.open}${colourName}${words.box}${words.close}` : mark.char;

    const parts = [];
    const label = zh ? firstText(descriptor.zh, descriptor.en) : firstText(descriptor.en, descriptor.zh);
    if (label) parts.push(label);
    const outfit = outfitAt(cast, mark.char, t);
    if (outfit) parts.push(`${words.wearing}${outfit}`);
    if (nameUnlocked(character, t, policy)) parts.push(`${words.name}${oneLine(character.name)}`);
    lines.push(parts.length ? `${head}${words.colon}${parts.join(words.then)}` : head);
  }
  return lines.join('\n');
}

const GLYPH_W = 5;
const GLYPH_H = 7;
/**
 * The dot font of the tags: the letter P and the ten digits, five dots wide and
 * seven high. Nothing else is ever written on a frame. The zero has no stroke
 * through it: there is no letter O to tell it from, and a stroke reads as an 8
 * when the dots are small.
 */
const FONT = Object.freeze({
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  0: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
});

/** A copy of the picture's bytes, whatever kind of buffer they came in. */
function copyBytes(rgb) {
  if (ArrayBuffer.isView(rgb) && typeof rgb.length === 'number') return new Uint8Array(rgb);
  // A view on an ArrayBuffer would share its bytes: slice first.
  if (Object.prototype.toString.call(rgb) === '[object ArrayBuffer]') return new Uint8Array(rgb.slice(0));
  if (Array.isArray(rgb)) return Uint8Array.from(rgb, (v) => Number(v) || 0);
  return new Uint8Array(0);
}

/** Paints the pixels from (x0, y0) up to but not including (x1, y1), the part of them inside the frame. */
function fill(out, frame, x0, y0, x1, y1, rgb) {
  const left = Math.max(0, x0);
  const right = Math.min(frame.w, x1);
  const bottom = Math.min(frame.h, y1);
  for (let y = Math.max(0, y0); y < bottom; y += 1) {
    let i = (y * frame.w + left) * 3;
    for (let x = left; x < right; x += 1) {
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      i += 3;
    }
  }
}

/** The outline of a box, drawn inwards from its edges. */
function drawOutline(out, frame, [x, y, w, h], thickness, rgb) {
  // A line as thick as a small box is wide would paint over the face it is there to show.
  const t = Math.min(thickness, Math.max(1, Math.floor(Math.min(w, h) / 4)));
  fill(out, frame, x, y, x + w, y + t, rgb);
  fill(out, frame, x, y + h - t, x + w, y + h, rgb);
  fill(out, frame, x, y + t, x + t, y + h - t, rgb);
  fill(out, frame, x + w - t, y + t, x + w, y + h - t, rgb);
}

/**
 * The tag of a box: a filled rectangle with the id on it, one dot of margin around
 * the text and one dot between its characters. It sits on top of the box, flush
 * with its left edge, where it hides nothing of the person; when there is no room
 * there (the box touches the top of the frame, or its corner is too near the right
 * edge) it moves just far enough to be inside the frame.
 */
function drawTag(out, frame, id, [x, y], scale, rgb) {
  const glyphs = [...id].map((ch) => FONT[ch]).filter(Boolean);
  const w = (glyphs.length * (GLYPH_W + 1) + 1) * scale;
  const h = (GLYPH_H + 2) * scale;
  const left = clamp(x, 0, Math.max(0, frame.w - w));
  const top = clamp(y - h, 0, Math.max(0, frame.h - h));
  fill(out, frame, left, top, left + w, top + h, rgb);
  const ink = tagTextColour(rgb);
  glyphs.forEach((rows, n) => {
    const glyphLeft = left + (1 + n * (GLYPH_W + 1)) * scale;
    rows.forEach((row, r) => {
      for (let c = 0; c < GLYPH_W; c += 1) {
        if (row[c] !== '#') continue;
        const dotLeft = glyphLeft + c * scale;
        const dotTop = top + (1 + r) * scale;
        fill(out, frame, dotLeft, dotTop, dotLeft + scale, dotTop + scale, ink);
      }
    });
  });
}

/** An option that counts pixels: a whole number of at least 1, else the default. */
const wholePixels = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback);

/**
 * Draws the marks on a copy of a picture: around each mark's box a rectangle in the
 * mark's colour, and on top of its top-left corner a filled tag with the id ("P3")
 * in a 5×7 dot font, in black or white, whichever reads better on the colour.
 * Boxes are cut to the frame first, so a box that leaves the picture is closed
 * along the picture's edge; a box wholly outside draws nothing. All boxes are
 * drawn before any tag, so no number is crossed by a neighbour's box. Nothing is
 * written outside the frame, and the buffer passed in is left as it was.
 * @param {Uint8Array|Uint8ClampedArray|ArrayBuffer|number[]} rgb  the picture, three bytes per pixel, rows from the top
 * @param {number} width   in pixels
 * @param {number} height  in pixels
 * @param {Array<{char: string, colour?: object|string, box: number[]}>} marks  from assignMarks
 * @param {{thickness?: number, scale?: number}} [options]
 *   thickness: the line of the box in pixels (2 or more, growing with the frame: height / 240);
 *   scale: pixels per dot of the font (2 or more: height / 180)
 * @returns {Uint8Array} the marked copy; an unmarked copy when the size does not fit the buffer
 */
export function drawMarks(rgb, width, height, marks, options) {
  const out = copyBytes(rgb);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return out;
  if (out.length < width * height * 3) return out;
  const frame = { w: width, h: height };
  const thickness = wholePixels(options && options.thickness, Math.max(2, Math.round(height / 240)));
  const scale = wholePixels(options && options.scale, Math.max(2, Math.round(height / 180)));

  const drawn = [];
  for (const mark of Array.isArray(marks) ? marks : []) {
    if (!mark || typeof mark !== 'object' || !isCharacterId(mark.char) || !isBox(mark.box)) continue;
    const box = clipBox(mark.box, frame);
    if (!box) continue;
    const [r, g, b] = colourOf(mark).rgb;
    drawn.push({ id: mark.char, box, rgb: [r, g, b].map((v) => clamp(Math.round(v), 0, 255)) });
  }
  for (const mark of drawn) drawOutline(out, frame, mark.box, thickness, mark.rgb);
  for (const mark of drawn) drawTag(out, frame, mark.id, mark.box, scale, mark.rgb);
  return out;
}
