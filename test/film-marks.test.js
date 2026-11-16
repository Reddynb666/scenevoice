// Numbered boxes and their legend (src/film/marks.js): which colour a character
// gets, what the legend tells the model (and what it must not), and the pixels
// drawMarks writes, read back one by one.

import { describe, expect, it } from 'vitest';
import { groundTruthIdentity } from '../src/film/identity.js';
import { MARK_COLOURS, assignMarks, drawMarks, legendText, tagTextColour } from '../src/film/marks.js';
import { DEFAULT_POLICY } from '../src/film/types.js';

const FRAME = { w: 960, h: 540 };
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

/** A face box big enough to be marked as a face (100 × 100 = 10000 square pixels). */
const seen = (characterId, box = [100, 100, 100, 100], extra = {}) => ({ characterId, box, conf: 1, ...extra });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// ---- colour arithmetic of the test's own, so the palette is checked against the definitions and not against itself

const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
/** WCAG contrast ratio of two colours, 1 to 21. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What a colour looks like with no working cone of one kind (Machado, Oliveira and Fernandes 2009, severity 1). */
const DEFICIENCY = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
function simulate(rgb, matrix) {
  const l = rgb.map(linear);
  return matrix.map((row) => {
    const v = Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
    return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  });
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function closestPair(colours, matrix) {
  let least = Infinity;
  for (let i = 0; i < colours.length; i += 1) {
    for (let j = i + 1; j < colours.length; j += 1) {
      least = Math.min(least, distance(simulate(colours[i], matrix), simulate(colours[j], matrix)));
    }
  }
  return least;
}

// ---- pictures

/** A picture with a pattern no mark colour and no text colour can match, so a stray pixel shows. */
function picture(width, height, extraBytes = 0) {
  const bytes = new Uint8Array(width * height * 3 + extraBytes);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) % 251;
  return bytes;
}
const pixel = (bytes, width, x, y) => [bytes[(y * width + x) * 3], bytes[(y * width + x) * 3 + 1], bytes[(y * width + x) * 3 + 2]];
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
/** How many pixels of the frame differ between two pictures. */
function changedPixels(before, after, width, height) {
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!same(pixel(before, width, x, y), pixel(after, width, x, y))) count += 1;
    }
  }
  return count;
}
/** How many pixels of a rectangle have exactly this colour. */
function countColour(bytes, width, [x0, y0, w, h], rgb) {
  let count = 0;
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      if (same(pixel(bytes, width, x, y), rgb)) count += 1;
    }
  }
  return count;
}
/**
 * A rectangle of the picture as text, one character per dot of `scale` pixels:
 * '#' the text colour, 'o' the mark's colour, '.' anything else, '?' a dot that is
 * not of one colour throughout.
 */
function ascii(bytes, width, [x0, y0, cols, rows], colour, ink, scale = 1) {
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      const kinds = new Set();
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const p = pixel(bytes, width, x0 + c * scale + dx, y0 + r * scale + dy);
          kinds.add(same(p, ink) ? '#' : same(p, colour) ? 'o' : '.');
        }
      }
      line += kinds.size === 1 ? [...kinds][0] : '?';
    }
    lines.push(line);
  }
  return lines;
}

/** The font the tags are written in, as the test expects it: changing a glyph changes what the model is shown. */
const GLYPHS = {
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
};
/** The tag of an id as ascii() would show it: a margin of one dot, one dot between characters. */
function expectedTag(id) {
  const blank = 'o'.repeat(id.length * 6 + 1);
  const rows = [];
  for (let r = 0; r < 7; r += 1) {
    rows.push(`o${[...id].map((ch) => GLYPHS[ch][r].replaceAll('.', 'o')).join('o')}o`);
  }
  return [blank, ...rows, blank];
}

const mark = (char, box, colourIndex = (Number(char.slice(1)) - 1) % 8, kind = 'face') => ({ char, colour: MARK_COLOURS[colourIndex], box, kind });

// ---- a cast as plain data, the way cast.js keeps it

const character = (id, fields = {}) => ({
  id,
  name: null,
  level: 0,
  aliases: [],
  descriptor: {},
  revealAt: null,
  spoilerLock: false,
  neverName: false,
  main: false,
  screenSec: 0,
  evidence: [],
  clusters: [],
  ...fields,
});
const castOf = (characters, appearances = [], policy = { ...DEFAULT_POLICY }) => ({
  v: 1,
  policy,
  characters,
  appearances,
  constraints: { mustLink: [], cannotLink: [] },
  events: [],
});
const matthew = (fields = {}) => character('P3', { name: 'Matthew', level: 3, descriptor: { en: 'woman with long hair', zh: '长发女人' }, ...fields });
const maxiu = (fields = {}) => character('P3', { name: '马修', level: 3, descriptor: { en: 'woman with long hair', zh: '长发女人' }, ...fields });
const P3_MARK = [mark('P3', [100, 100, 100, 100])];

describe('MARK_COLOURS', () => {
  it('is eight colours, each with an id, a name in English and Chinese, and three bytes', () => {
    expect(MARK_COLOURS).toHaveLength(8);
    for (const colour of MARK_COLOURS) {
      expect(typeof colour.id).toBe('string');
      expect(colour.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(colour.name.en).toMatch(/^[a-z]+( [a-z]+)*$/);
      expect(colour.name.zh).toMatch(/^[一-鿿]+$/);
      expect(colour.rgb).toHaveLength(3);
      for (const v of colour.rgb) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });

  it('has no two entries with the same id, name or colour', () => {
    for (const read of [(c) => c.id, (c) => c.name.en, (c) => c.name.zh, (c) => c.rgb.join(',')]) {
      expect(new Set(MARK_COLOURS.map(read)).size).toBe(8);
    }
  });

  it('is the Okabe-Ito palette', () => {
    const okabeIto = ['0,0,0', '230,159,0', '86,180,233', '0,158,115', '240,228,66', '0,114,178', '213,94,0', '204,121,167'];
    expect(MARK_COLOURS.map((c) => c.rgb.join(',')).sort()).toEqual([...okabeIto].sort());
  });

  it('stays apart for readers with each kind of colour vision deficiency', () => {
    const colours = MARK_COLOURS.map((c) => c.rgb);
    expect(closestPair(colours, DEFICIENCY.protanopia)).toBeGreaterThan(45);
    expect(closestPair(colours, DEFICIENCY.deuteranopia)).toBeGreaterThan(45);
    expect(closestPair(colours, DEFICIENCY.tritanopia)).toBeGreaterThan(25);
  });

  it('is measured by a check that can fail: a grey in place of the black would merge with the purple', () => {
    const withGrey = MARK_COLOURS.map((c) => (c.id === 'black' ? [153, 153, 153] : c.rgb));
    expect(closestPair(withGrey, DEFICIENCY.deuteranopia)).toBeLessThan(25);
  });

  it('calls the colours by words a legend can use: the third one is the red of "P3 (red box)"', () => {
    expect(MARK_COLOURS.map((c) => c.name.en)).toEqual(['orange', 'sky blue', 'red', 'green', 'yellow', 'blue', 'purple', 'black']);
    expect(MARK_COLOURS.map((c) => c.name.zh)).toEqual(['橙', '天蓝', '红', '绿', '黄', '蓝', '紫', '黑']);
  });

  it('keeps black, the hardest to see on a dark frame, for last', () => {
    expect(MARK_COLOURS[7].id).toBe('black');
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(MARK_COLOURS)).toBe(true);
    for (const colour of MARK_COLOURS) {
      expect(Object.isFrozen(colour)).toBe(true);
      expect(Object.isFrozen(colour.name)).toBe(true);
      expect(Object.isFrozen(colour.rgb)).toBe(true);
    }
  });
});

describe('tagTextColour', () => {
  it('is black or white, whichever contrasts more with the colour', () => {
    for (const colour of MARK_COLOURS) {
      const text = tagTextColour(colour.rgb);
      const other = same(text, BLACK) ? WHITE : BLACK;
      expect(same(text, BLACK) || same(text, WHITE)).toBe(true);
      expect(contrast(text, colour.rgb)).toBeGreaterThan(contrast(other, colour.rgb));
    }
  });

  it('is easy to read on every mark colour (4.5 to 1 or better), which white alone would not be', () => {
    for (const colour of MARK_COLOURS) expect(contrast(tagTextColour(colour.rgb), colour.rgb)).toBeGreaterThanOrEqual(4.5);
    const yellow = MARK_COLOURS.find((c) => c.id === 'yellow').rgb;
    expect(contrast(WHITE, yellow)).toBeLessThan(1.5);
  });

  it('writes black on the light colours and white on the dark ones', () => {
    const textOn = (id) => tagTextColour(MARK_COLOURS.find((c) => c.id === id).rgb);
    for (const id of ['yellow', 'orange', 'sky-blue', 'bluish-green', 'vermilion', 'reddish-purple']) expect(textOn(id)).toEqual(BLACK);
    for (const id of ['blue', 'black']) expect(textOn(id)).toEqual(WHITE);
    expect(tagTextColour([255, 255, 255])).toEqual(BLACK);
    expect(tagTextColour([128, 128, 128])).toEqual(BLACK);
    expect(tagTextColour([90, 90, 90])).toEqual(WHITE);
  });

  it('returns a new array, and white for something that is not a colour', () => {
    const first = tagTextColour([0, 0, 0]);
    first[0] = 7;
    expect(tagTextColour([0, 0, 0])).toEqual(WHITE);
    for (const junk of [undefined, null, 'red', [], [1, 2], [1, 2, NaN], {}, 5]) expect(tagTextColour(junk)).toEqual(WHITE);
  });
});

describe('assignMarks: colours', () => {
  const colourIndex = (marks, char) => MARK_COLOURS.indexOf(marks.find((m) => m.char === char).colour);

  it('gives a character the colour of its number: (number - 1) mod 8', () => {
    for (let n = 1; n <= 20; n += 1) {
      const [only] = assignMarks([seen(`P${n}`)], { frame: FRAME });
      expect(only.char).toBe(`P${n}`);
      expect(only.colour).toBe(MARK_COLOURS[(n - 1) % 8]);
    }
  });

  it('keeps a character in the same colour whoever else is on screen', () => {
    const alone = assignMarks([seen('P3')], { frame: FRAME });
    const crowd = assignMarks([seen('P5'), seen('P3'), seen('P1'), seen('P8')], { frame: FRAME });
    const later = assignMarks([seen('P3'), seen('P4')], { frame: FRAME });
    for (const marks of [alone, crowd, later]) expect(colourIndex(marks, 'P3')).toBe(2);
    expect(colourIndex(crowd, 'P1')).toBe(0);
    expect(colourIndex(crowd, 'P5')).toBe(4);
    expect(colourIndex(crowd, 'P8')).toBe(7);
  });

  it('returns one mark per character, in order of character number', () => {
    const marks = assignMarks([seen('P10'), seen('P2'), seen('P1')], { frame: FRAME });
    expect(marks.map((m) => m.char)).toEqual(['P1', 'P2', 'P10']);
  });

  it('gives the later of two characters that would share a colour the next free one', () => {
    const marks = assignMarks([seen('P9'), seen('P1')], { frame: FRAME });
    expect(colourIndex(marks, 'P1')).toBe(0);
    expect(colourIndex(marks, 'P9')).toBe(1);
  });

  it('skips colours that are taken when looking for the next free one', () => {
    const marks = assignMarks([seen('P1'), seen('P2'), seen('P3'), seen('P9')], { frame: FRAME });
    expect(colourIndex(marks, 'P9')).toBe(3);
    expect(new Set(marks.map((m) => m.colour.id)).size).toBe(4);
  });

  it('never takes the own colour of someone on screen for a character that had to move', () => {
    // P9 wants the colour of P1; P10 is on screen and keeps its own (the second).
    const marks = assignMarks([seen('P1'), seen('P9'), seen('P10')], { frame: FRAME });
    expect(colourIndex(marks, 'P1')).toBe(0);
    expect(colourIndex(marks, 'P10')).toBe(1);
    expect(colourIndex(marks, 'P9')).toBe(2);
  });

  it('wraps round the palette when looking for a free colour', () => {
    const marks = assignMarks([seen('P8'), seen('P16')], { frame: FRAME });
    expect(colourIndex(marks, 'P8')).toBe(7);
    expect(colourIndex(marks, 'P16')).toBe(0);
  });

  it('gives eight people eight different colours, whatever their numbers', () => {
    const marks = assignMarks([1, 9, 17, 25, 2, 10, 33, 41].map((n) => seen(`P${n}`)), { frame: FRAME });
    expect(marks).toHaveLength(8);
    expect(new Set(marks.map((m) => m.colour.id)).size).toBe(8);
  });

  it('still marks everyone when more than eight are on screen: colours repeat evenly', () => {
    const marks = assignMarks(Array.from({ length: 11 }, (_, i) => seen(`P${i + 1}`)), { frame: FRAME });
    expect(marks.map((m) => m.char)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11']);
    const uses = MARK_COLOURS.map((colour) => marks.filter((m) => m.colour === colour).length);
    expect(Math.max(...uses)).toBe(2);
    expect(Math.min(...uses)).toBe(1);
    for (let n = 1; n <= 8; n += 1) expect(colourIndex(marks, `P${n}`)).toBe(n - 1);
  });

  it('marks a character once when it is listed twice: the more confident box', () => {
    const marks = assignMarks(
      [seen('P1', [100, 100, 100, 100], { conf: 0.4 }), seen('P1', [400, 100, 100, 100], { conf: 0.9 }), seen('P1', [700, 100, 100, 100], { conf: 0.5 })],
      { frame: FRAME },
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].box).toEqual([400, 100, 100, 100]);
  });

  it('copes with a character number too long to count: it is no character id, and gets no mark', () => {
    // An id has six digits at most (types.js isCharacterId), the most a token is read with.
    const marks = assignMarks([seen(`P${'9'.repeat(400)}`), seen('P1000000'), seen('P999999'), seen('P1')], { frame: FRAME });
    expect(marks.map((m) => m.char)).toEqual(['P1', 'P999999']);
    for (const m of marks) expect(MARK_COLOURS).toContain(m.colour);
  });
});

describe('assignMarks: boxes', () => {
  it('keeps the face box of a face that is big enough', () => {
    expect(assignMarks([seen('P1', [100, 120, 80, 90])], { frame: FRAME })).toEqual([
      { char: 'P1', colour: MARK_COLOURS[0], box: [100, 120, 80, 90], kind: 'face' },
    ]);
  });

  it('rounds a box to whole pixels by its edges', () => {
    const [m] = assignMarks([seen('P1', [10.4, 20.6, 100.2, 80.3])], { frame: FRAME });
    // Left 10.4 → 10, right 110.6 → 111; top 20.6 → 21, bottom 100.9 → 101.
    expect(m.box).toEqual([10, 21, 101, 80]);
    for (const v of m.box) expect(Number.isInteger(v)).toBe(true);
  });

  it('cuts a box to the frame', () => {
    const box = (b) => assignMarks([seen('P1', b)], { frame: FRAME })[0].box;
    expect(box([-30, -20, 130, 120])).toEqual([0, 0, 100, 100]);
    expect(box([900, 480, 200, 200])).toEqual([900, 480, 60, 60]);
    expect(box([-50, 100, 2000, 100])).toEqual([0, 100, 960, 100]);
    expect(box([-0.4, -0.4, 100.8, 100.8])).toEqual([0, 0, 100, 100]);
  });

  it('gives no mark to someone wholly outside the frame', () => {
    for (const b of [[1000, 100, 100, 100], [-200, 100, 100, 100], [100, 600, 100, 100], [100, -300, 100, 100], [960, 0, 100, 100]]) {
      expect(assignMarks([seen('P1', b)], { frame: FRAME })).toEqual([]);
    }
    const marks = assignMarks([seen('P1', [1000, 100, 100, 100]), seen('P9')], { frame: FRAME });
    // P1 is not in the picture, so P9 has the first colour to itself.
    expect(marks).toEqual([{ char: 'P9', colour: MARK_COLOURS[0], box: [100, 100, 100, 100], kind: 'face' }]);
  });

  it('boxes the person when the face is under 4000 square pixels: three times as wide, down to the bottom of the frame', () => {
    const [m] = assignMarks([seen('P2', [400, 200, 40, 50])], { frame: FRAME });
    expect(m.kind).toBe('person');
    expect(m.box).toEqual([360, 200, 120, 340]);
    expect(m.colour).toBe(MARK_COLOURS[1]);
  });

  it('draws the line between face and person at minFaceArea exactly', () => {
    const kind = (b, options = {}) => assignMarks([seen('P1', b)], { frame: FRAME, ...options })[0].kind;
    expect(kind([100, 100, 80, 50])).toBe('face'); // 4000
    expect(kind([100, 100, 79, 50])).toBe('person'); // 3950
    expect(kind([100, 100, 30, 30], { minFaceArea: 900 })).toBe('face');
    expect(kind([100, 100, 30, 29], { minFaceArea: 900 })).toBe('person');
    expect(kind([100, 100, 200, 200], { minFaceArea: 50000 })).toBe('person');
    expect(kind([100, 100, 2, 2], { minFaceArea: 0 })).toBe('face');
  });

  it('uses 4000 when minFaceArea makes no sense', () => {
    for (const minFaceArea of [NaN, -1, '900', null, undefined, Infinity]) {
      expect(assignMarks([seen('P1', [100, 100, 79, 50])], { frame: FRAME, minFaceArea })[0].kind).toBe('person');
      expect(assignMarks([seen('P1', [100, 100, 80, 50])], { frame: FRAME, minFaceArea })[0].kind).toBe('face');
    }
  });

  it('cuts a person box to the frame too', () => {
    const [left] = assignMarks([seen('P1', [10, 300, 40, 40])], { frame: FRAME });
    expect(left).toEqual({ char: 'P1', colour: MARK_COLOURS[0], box: [0, 300, 90, 240], kind: 'person' });
    const [right] = assignMarks([seen('P1', [930, 100, 40, 40])], { frame: FRAME });
    expect(right.box).toEqual([890, 100, 70, 440]);
  });

  it('judges the size of a face by the box as detected, not by what is left of it in the frame', () => {
    const [m] = assignMarks([seen('P1', [-60, 100, 100, 100])], { frame: FRAME });
    expect(m.kind).toBe('face');
    expect(m.box).toEqual([0, 100, 40, 100]);
  });

  it('works on the size of the frame it is given', () => {
    const [m] = assignMarks([seen('P1', [600, 300, 30, 30])], { frame: { w: 640, h: 360 } });
    expect(m.box).toEqual([570, 300, 70, 60]);
  });
});

describe('assignMarks: input that makes no sense', () => {
  it('returns no marks without the size of the frame', () => {
    for (const options of [undefined, null, {}, { frame: null }, { frame: {} }, { frame: { w: 0, h: 100 } }, { frame: { w: 100, h: -5 } }, { frame: { w: NaN, h: 100 } }, { frame: { w: '960', h: '540' } }, { frame: { w: Infinity, h: 100 } }, 'x']) {
      expect(assignMarks([seen('P1')], options)).toEqual([]);
    }
  });

  it('returns no marks for something that is not a list of people', () => {
    for (const visible of [undefined, null, 'x', 5, {}, { length: 2 }, []]) expect(assignMarks(visible, { frame: FRAME })).toEqual([]);
  });

  it('leaves out an entry without a character id or a usable box, and keeps the others', () => {
    const marks = assignMarks(
      [
        null,
        'P1',
        {},
        { characterId: 'P0', box: [1, 2, 300, 400] },
        { characterId: 'Matthew', box: [1, 2, 300, 400] },
        { characterId: 'P4' },
        { characterId: 'P5', box: [1, 2, 3] },
        { characterId: 'P6', box: [1, 2, NaN, 400] },
        { characterId: 'P7', box: [1, 2, 0, 400] },
        { characterId: 'P2', box: [10, 20, 300, 400] },
      ],
      { frame: FRAME },
    );
    expect(marks).toEqual([{ char: 'P2', colour: MARK_COLOURS[1], box: [10, 20, 300, 400], kind: 'face' }]);
  });

  it('does not change what it is given, and returns boxes of its own', () => {
    const visible = deepFreeze([seen('P2', [10, 20, 300, 400]), seen('P1', [500, 20, 30, 30])]);
    const options = deepFreeze({ frame: { w: 960, h: 540 }, minFaceArea: 4000 });
    const marks = assignMarks(visible, options);
    expect(marks.map((m) => m.char)).toEqual(['P1', 'P2']);
    expect(marks[1].box).not.toBe(visible[0].box);
    marks[1].box[0] = 999;
    expect(assignMarks(visible, options)[1].box).toEqual([10, 20, 300, 400]);
  });

  it('takes what an identity provider answers', () => {
    const identity = groundTruthIdentity([
      { t: 10, box: [100, 100, 100, 100], characterId: 'P3' },
      { t: 10.5, box: [600, 200, 30, 40], characterId: 'P1' },
    ]);
    expect(assignMarks(identity.visibleAt(10.2), { frame: FRAME })).toEqual([
      { char: 'P1', colour: MARK_COLOURS[0], box: [570, 200, 90, 340], kind: 'person' },
      { char: 'P3', colour: MARK_COLOURS[2], box: [100, 100, 100, 100], kind: 'face' },
    ]);
  });
});

describe('legendText: the line of a mark', () => {
  it('says who a mark is, what they wear and their confirmed name (English)', () => {
    const cast = castOf([matthew()], [{ char: 'P3', from: 0, to: null, outfit: 'a red dress', src: 'model' }]);
    expect(legendText(P3_MARK, cast, 10, { lang: 'en' })).toBe('P3 (red box): woman with long hair; wearing: a red dress; confirmed name: Matthew');
  });

  it('says the same in Chinese', () => {
    const cast = castOf([maxiu()], [{ char: 'P3', from: 0, to: null, outfit: '红裙子', src: 'model' }]);
    expect(legendText(P3_MARK, cast, 10, { lang: 'zh-CN' })).toBe('P3（红框）：长发女人；当前着装：红裙子；已确认名：马修');
  });

  it('words the legend in Chinese for Chinese only, and in English for everything else', () => {
    const cast = castOf([maxiu()]);
    for (const lang of ['zh', 'zh-CN', 'zh_CN', 'zh-TW', 'ZH-Hant', 'yue', 'cmn-Hans']) expect(legendText(P3_MARK, cast, 10, { lang })).toBe('P3（红框）：长发女人；已确认名：马修');
    for (const lang of ['en', 'en-GB', 'ja', 'ko', 'fr', 'zha', '', undefined, null, 42]) expect(legendText(P3_MARK, cast, 10, { lang })).toBe('P3 (red box): woman with long hair; confirmed name: 马修');
    expect(legendText(P3_MARK, cast, 10)).toBe('P3 (red box): woman with long hair; confirmed name: 马修');
    expect(legendText(P3_MARK, cast, 10, null)).toBe('P3 (red box): woman with long hair; confirmed name: 马修');
  });

  it('writes one line per mark, in the order of the marks, each with its own colour', () => {
    const cast = castOf([
      character('P1', { descriptor: { en: 'man with glasses', zh: '戴眼镜的男人' } }),
      character('P2', { descriptor: { en: 'boy in a cap', zh: '戴帽子的男孩' } }),
      matthew(),
    ]);
    const marks = [mark('P3', [0, 0, 100, 100]), mark('P1', [200, 0, 100, 100]), mark('P2', [400, 0, 100, 100])];
    expect(legendText(marks, cast, 10, { lang: 'en' }).split('\n')).toEqual([
      'P3 (red box): woman with long hair; confirmed name: Matthew',
      'P1 (orange box): man with glasses',
      'P2 (sky blue box): boy in a cap',
    ]);
    expect(legendText(marks, cast, 10, { lang: 'zh' }).split('\n')).toEqual([
      'P3（红框）：长发女人；已确认名：Matthew',
      'P1（橙框）：戴眼镜的男人',
      'P2（天蓝框）：戴帽子的男孩',
    ]);
  });

  it('names the colour the mark has, not the one its number would have', () => {
    const cast = castOf([character('P9', { descriptor: { en: 'tall man', zh: '高个男人' } })]);
    expect(legendText([mark('P9', [0, 0, 100, 100], 1)], cast, 0, { lang: 'en' })).toBe('P9 (sky blue box): tall man');
    expect(legendText([{ char: 'P9', colour: 'yellow', box: [0, 0, 100, 100] }], cast, 0, { lang: 'zh' })).toBe('P9（黄框）：高个男人');
    // No colour on the mark: the colour of the number.
    expect(legendText([{ char: 'P9', box: [0, 0, 100, 100] }], cast, 0, { lang: 'en' })).toBe('P9 (orange box): tall man');
    expect(legendText([{ char: 'P9', colour: 'no-such-colour' }], cast, 0, { lang: 'en' })).toBe('P9 (orange box): tall man');
  });

  it('agrees with the colours assignMarks gives', () => {
    const cast = castOf([character('P1', { descriptor: { en: 'old man' } }), character('P9', { descriptor: { en: 'girl' } })]);
    const marks = assignMarks([seen('P9'), seen('P1')], { frame: FRAME });
    expect(legendText(marks, cast, 0, { lang: 'en' })).toBe('P1 (orange box): old man\nP9 (sky blue box): girl');
  });

  it('is empty without marks', () => {
    expect(legendText([], castOf([matthew()]), 10, { lang: 'en' })).toBe('');
    for (const marks of [undefined, null, 'P3', {}, 5]) expect(legendText(marks, castOf([matthew()]), 10, { lang: 'en' })).toBe('');
  });
});

describe('legendText: the descriptor', () => {
  it('uses the descriptor in the language of the legend', () => {
    const cast = castOf([character('P1', { descriptor: { en: 'man in a grey coat', zh: '灰大衣男人' } })]);
    expect(legendText([mark('P1', [0, 0, 100, 100])], cast, 0, { lang: 'en' })).toBe('P1 (orange box): man in a grey coat');
    expect(legendText([mark('P1', [0, 0, 100, 100])], cast, 0, { lang: 'zh' })).toBe('P1（橙框）：灰大衣男人');
  });

  it('falls back to the other language when the descriptor is missing in this one', () => {
    const onlyZh = castOf([character('P1', { descriptor: { zh: '灰大衣男人' } })]);
    const onlyEn = castOf([character('P1', { descriptor: { en: 'man in a grey coat', zh: '  ' } })]);
    expect(legendText([mark('P1', [0, 0, 100, 100])], onlyZh, 0, { lang: 'en' })).toBe('P1 (orange box): 灰大衣男人');
    expect(legendText([mark('P1', [0, 0, 100, 100])], onlyEn, 0, { lang: 'zh' })).toBe('P1（橙框）：man in a grey coat');
  });

  it('writes the mark alone when nothing is known about the character', () => {
    const marks = [mark('P1', [0, 0, 100, 100]), mark('P4', [200, 0, 100, 100])];
    const cast = castOf([character('P1')]);
    expect(legendText(marks, cast, 0, { lang: 'en' })).toBe('P1 (orange box)\nP4 (green box)');
    expect(legendText(marks, cast, 0, { lang: 'zh' })).toBe('P1（橙框）\nP4（绿框）');
  });

  it('keeps each mark on one line whatever the texts contain', () => {
    const cast = castOf(
      [matthew({ descriptor: { en: ' woman with\nlong   hair ' }, name: ' Matthew\n' })],
      [{ char: 'P3', from: 0, to: null, outfit: 'a red\r\ndress', src: 'human' }],
    );
    expect(legendText(P3_MARK, cast, 10, { lang: 'en' })).toBe('P3 (red box): woman with long hair; wearing: a red dress; confirmed name: Matthew');
  });
});

describe('legendText: the outfit', () => {
  const appearances = [
    { char: 'P3', from: 100, to: 200, outfit: 'a red dress', src: 'model' },
    { char: 'P3', from: 200, to: null, outfit: 'a grey coat', src: 'human' },
    { char: 'P1', from: 0, to: null, outfit: 'a uniform', src: 'model' },
  ];
  const cast = castOf([character('P3', { descriptor: { en: 'woman with long hair' } })], appearances);
  const at = (t, c = cast) => legendText(P3_MARK, c, t, { lang: 'en' });

  it('says what is worn only when an appearance is current at the time of the frame', () => {
    expect(at(99.9)).toBe('P3 (red box): woman with long hair');
    expect(at(100)).toBe('P3 (red box): woman with long hair; wearing: a red dress');
    expect(at(199.9)).toBe('P3 (red box): woman with long hair; wearing: a red dress');
  });

  it('ends an appearance at its `to`, and keeps an open one for the rest of the film', () => {
    expect(at(200)).toBe('P3 (red box): woman with long hair; wearing: a grey coat');
    expect(at(7000)).toBe('P3 (red box): woman with long hair; wearing: a grey coat');
    const closed = castOf(cast.characters, [{ char: 'P3', from: 100, to: 200, outfit: 'a red dress', src: 'model' }]);
    expect(at(200, closed)).toBe('P3 (red box): woman with long hair');
    expect(at(500, closed)).toBe('P3 (red box): woman with long hair');
  });

  it('takes an appearance without a `to` as still current', () => {
    const open = castOf(cast.characters, [{ char: 'P3', from: 100, outfit: 'a red dress', src: 'model' }]);
    expect(at(5000, open)).toBe('P3 (red box): woman with long hair; wearing: a red dress');
  });

  it('never borrows the outfit of somebody else', () => {
    expect(at(50)).toBe('P3 (red box): woman with long hair');
    expect(legendText([mark('P1', [0, 0, 100, 100])], cast, 50, { lang: 'en' })).toBe('P1 (orange box): wearing: a uniform');
  });

  it('takes the latest of two appearances that both claim the moment', () => {
    const overlapping = castOf(cast.characters, [
      { char: 'P3', from: 0, to: null, outfit: 'a red dress', src: 'model' },
      { char: 'P3', from: 300, to: null, outfit: 'pyjamas', src: 'model' },
    ]);
    expect(at(100, overlapping)).toBe('P3 (red box): woman with long hair; wearing: a red dress');
    expect(at(400, overlapping)).toBe('P3 (red box): woman with long hair; wearing: pyjamas');
  });

  it('leaves the outfit out when it is empty, or when the appearances make no sense', () => {
    for (const list of [undefined, null, 'x', [null, 'x', {}, { char: 'P3' }, { char: 'P3', from: '0', outfit: 'a hat' }, { char: 'P3', from: 0, to: null, outfit: '   ' }, { char: 'P3', from: 0, to: null }]]) {
      expect(at(10, { ...cast, appearances: list })).toBe('P3 (red box): woman with long hair');
    }
  });

  it('says it in Chinese', () => {
    const zh = castOf([character('P3', { descriptor: { zh: '长发女人' } })], [{ char: 'P3', from: 0, to: null, outfit: '红裙子', src: 'model' }]);
    expect(legendText(P3_MARK, zh, 10, { lang: 'zh' })).toBe('P3（红框）：长发女人；当前着装：红裙子');
  });
});

describe('legendText: the name', () => {
  const NAMED = 'P3 (red box): woman with long hair; confirmed name: Matthew';
  const UNNAMED = 'P3 (red box): woman with long hair';
  const legend = (fields, t = 10, policy = undefined, castPolicy = { ...DEFAULT_POLICY }) => legendText(P3_MARK, castOf([matthew(fields)], [], castPolicy), t, { lang: 'en', policy });

  it('gives a name a person confirmed', () => {
    expect(legend({})).toBe(NAMED);
  });

  it('gives no name when there is none', () => {
    expect(legend({ name: null })).toBe(UNNAMED);
    expect(legend({ name: '' })).toBe(UNNAMED);
    expect(legend({ name: '   ' })).toBe(UNNAMED);
    expect(legend({ name: 42 })).toBe(UNNAMED);
  });

  it('gives no name below the level the policy asks for', () => {
    expect(legend({ level: 2 })).toBe(UNNAMED);
    expect(legend({ level: 1 })).toBe(UNNAMED);
    expect(legend({ level: 0 })).toBe(UNNAMED);
    expect(legend({ level: undefined })).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(NAMED);
    expect(legend({ level: 1 }, 10, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(UNNAMED);
  });

  it('gives no name for a character a person asked never to name', () => {
    expect(legend({ neverName: true })).toBe(UNNAMED);
  });

  it('keeps a plot secret until it is revealed', () => {
    expect(legend({ spoilerLock: true, revealAt: null })).toBe(UNNAMED);
    expect(legend({ spoilerLock: true, revealAt: 3000 }, 2999.9)).toBe(UNNAMED);
    expect(legend({ spoilerLock: true, revealAt: 3000 }, 3000)).toBe(NAMED);
    expect(legend({ spoilerLock: true, revealAt: 3000 }, 5000)).toBe(NAMED);
  });

  it('waits for the reveal when names follow the story', () => {
    const onReveal = { ...DEFAULT_POLICY, naming: 'on-reveal' };
    expect(legend({ revealAt: 600 }, 599, onReveal)).toBe(UNNAMED);
    expect(legend({ revealAt: 600 }, 600, onReveal)).toBe(NAMED);
    // No reveal point: nothing to wait for.
    expect(legend({ revealAt: null }, 0, onReveal)).toBe(NAMED);
    // Named from the first appearance: the reveal point does not hold the name back.
    expect(legend({ revealAt: 600 }, 10)).toBe(NAMED);
  });

  it('takes the policy from the options first, then from the cast, then the default', () => {
    const lenient = { ...DEFAULT_POLICY, minLevel: 2 };
    const strict = { ...DEFAULT_POLICY, minLevel: 3 };
    expect(legend({ level: 2 }, 10, lenient, strict)).toBe(NAMED);
    expect(legend({ level: 2 }, 10, strict, lenient)).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, undefined, lenient)).toBe(NAMED);
    expect(legend({ level: 2 }, 10, undefined, strict)).toBe(UNNAMED);
    const noPolicy = { characters: [matthew({ level: 2 })], appearances: [] };
    expect(legendText(P3_MARK, noPolicy, 10, { lang: 'en' })).toBe(UNNAMED);
    expect(legendText(P3_MARK, { ...noPolicy, characters: [matthew()] }, 10, { lang: 'en' })).toBe(NAMED);
  });

  it('fills what a policy in the options leaves out from the cast, so lowering the level does not forget the reveal', () => {
    const onReveal = { ...DEFAULT_POLICY, naming: 'on-reveal' };
    expect(legend({ level: 2, revealAt: 600 }, 10, { minLevel: 2 }, onReveal)).toBe(UNNAMED);
    expect(legend({ level: 2, revealAt: 600 }, 600, { minLevel: 2 }, onReveal)).toBe(NAMED);
    expect(legend({ level: 2, revealAt: 600 }, 10, { minLevel: 2 }, { ...DEFAULT_POLICY })).toBe(NAMED);
    // A way of naming nobody knows is no way of naming: the cast's stands.
    expect(legend({ revealAt: 600 }, 10, { naming: 'always' }, onReveal)).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, { naming: 'on-reveal' }, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(NAMED);
  });

  it('asks for a confirmed name when the policy does not say how sure a name must be', () => {
    expect(legend({ level: 2 }, 10, {})).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, { naming: 'first-appearance', minLevel: 'low' })).toBe(UNNAMED);
    expect(legend({ level: 3 }, 10, {})).toBe(NAMED);
    expect(legend({ level: 2 }, 10, { minLevel: NaN }, { minLevel: 'x' })).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, 'lenient', 'lenient')).toBe(UNNAMED);
  });

  it('never accepts a level below two clues, whatever the policy says: the rule of the name gate', () => {
    // One clue is not a name: a policy that asks for less is not a policy, and the next layer decides.
    expect(legend({ level: 1 }, 10, { ...DEFAULT_POLICY, minLevel: 1 })).toBe(UNNAMED);
    expect(legend({ level: 1 }, 10, { ...DEFAULT_POLICY, minLevel: 0 })).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, { ...DEFAULT_POLICY, minLevel: 0 })).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, { ...DEFAULT_POLICY, minLevel: 4 })).toBe(UNNAMED);
    // Through the cast's own policy, with none in the options.
    expect(legend({ level: 1 }, 10, undefined, { ...DEFAULT_POLICY, minLevel: 1 })).toBe(UNNAMED);
    expect(legend({ level: 2 }, 10, undefined, { ...DEFAULT_POLICY, minLevel: 0 })).toBe(UNNAMED);
    // A level that is not valid in the options falls through to the cast's.
    expect(legend({ level: 2 }, 10, { minLevel: 1 }, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(NAMED);
    expect(legend({ level: 1 }, 10, { minLevel: 1 }, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(UNNAMED);
    // In Chinese too.
    const zh = castOf([matthew({ level: 1 })], [], { ...DEFAULT_POLICY });
    expect(legendText(P3_MARK, zh, 10, { lang: 'zh', policy: { minLevel: 0 } })).not.toContain('已确认名');
  });

  it('gives no name for a frame without a time', () => {
    const open = castOf([matthew()]);
    const locked = castOf([matthew({ spoilerLock: true, revealAt: 5 })]);
    for (const t of [NaN, undefined, null, '10', {}]) {
      expect(legendText(P3_MARK, open, t, { lang: 'en' })).toBe(UNNAMED);
      expect(legendText(P3_MARK, locked, t, { lang: 'en' })).toBe(UNNAMED);
    }
    expect(legendText(P3_MARK, open, 0, { lang: 'en' })).toBe(NAMED);
  });

  it('never lets a locked name into a line, whatever else the line says', () => {
    const cases = [
      { level: 2 },
      { neverName: true },
      { spoilerLock: true },
      { spoilerLock: true, revealAt: 9000 },
      { level: 0 },
    ];
    for (const fields of cases) {
      for (const lang of ['en', 'zh']) {
        const cast = castOf(
          [maxiu({ ...fields, aliases: [{ text: '小马', lang: 'zh' }], say: 'mǎ xiū' }), character('P1', { name: 'Chen', level: 1, descriptor: { en: 'man with glasses', zh: '戴眼镜的男人' } })],
          [{ char: 'P3', from: 0, to: null, outfit: '红裙子', src: 'model' }],
        );
        const text = legendText([mark('P3', [0, 0, 100, 100]), mark('P1', [200, 0, 100, 100])], cast, 10, { lang });
        expect(text).not.toContain('马修');
        expect(text).not.toContain('小马');
        expect(text).not.toContain('mǎ');
        expect(text).not.toContain('Chen');
        expect(text).not.toMatch(/confirmed name|已确认名/);
        expect(text.split('\n')).toHaveLength(2);
      }
    }
  });

  it('names one person and not the other in the same legend', () => {
    const cast = castOf([maxiu(), character('P1', { name: '老陈', level: 2, descriptor: { zh: '戴眼镜的男人' } })]);
    expect(legendText([mark('P1', [200, 0, 100, 100]), mark('P3', [0, 0, 100, 100])], cast, 10, { lang: 'zh' })).toBe('P1（橙框）：戴眼镜的男人\nP3（红框）：长发女人；已确认名：马修');
  });
});

describe('legendText: input that makes no sense', () => {
  it('never throws on a cast that is not one', () => {
    for (const cast of [undefined, null, 'cast', 5, [], {}, { characters: 'x', appearances: 7, policy: 'strict' }, { characters: [null, 'P3', {}, { id: 'P3' }] }]) {
      expect(legendText(P3_MARK, cast, 10, { lang: 'en' })).toBe('P3 (red box)');
      expect(legendText(P3_MARK, cast, 10, { lang: 'zh' })).toBe('P3（红框）');
    }
  });

  it('leaves out a mark without a character id', () => {
    const cast = castOf([matthew()]);
    const marks = [null, 'P3', {}, { char: 'P0' }, { char: 'Matthew' }, { char: 3 }, ...P3_MARK];
    expect(legendText(marks, cast, 10, { lang: 'en' })).toBe('P3 (red box): woman with long hair; confirmed name: Matthew');
  });

  it('does not change the marks, the cast or the options', () => {
    const marks = deepFreeze([{ char: 'P3', colour: MARK_COLOURS[2], box: [0, 0, 100, 100], kind: 'face' }]);
    const cast = deepFreeze(castOf([matthew()], [{ char: 'P3', from: 0, to: null, outfit: 'a red dress', src: 'model' }]));
    const options = deepFreeze({ lang: 'en', policy: { ...DEFAULT_POLICY } });
    expect(legendText(marks, cast, 10, options)).toBe('P3 (red box): woman with long hair; wearing: a red dress; confirmed name: Matthew');
  });
});

describe('drawMarks: the box', () => {
  const W = 320;
  const H = 240;
  const ORANGE = MARK_COLOURS[0].rgb;
  const source = picture(W, H);
  const out = drawMarks(source, W, H, [mark('P1', [100, 80, 120, 100])]);
  const at = (x, y) => pixel(out, W, x, y);
  const untouched = (x, y) => same(at(x, y), pixel(source, W, x, y));

  it('returns a new Uint8Array of the same length and leaves the picture it was given alone', () => {
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).not.toBe(source);
    expect(out.buffer).not.toBe(source.buffer);
    expect(out.length).toBe(source.length);
    expect(Array.from(source)).toEqual(Array.from(picture(W, H)));
  });

  it('draws the outline in the colour of the mark, two pixels thick on a small frame', () => {
    // Corners.
    for (const [x, y] of [[100, 80], [219, 80], [100, 179], [219, 179], [101, 81], [218, 178]]) expect(at(x, y)).toEqual(ORANGE);
    // Top, bottom, left and right edges, both pixels of the line.
    for (const [x, y] of [[160, 80], [160, 81], [160, 179], [160, 178], [100, 130], [101, 130], [219, 130], [218, 130]]) expect(at(x, y)).toEqual(ORANGE);
  });

  it('leaves the inside of the box as it was', () => {
    expect(untouched(160, 130)).toBe(true);
    for (const [x, y] of [[102, 82], [217, 177], [160, 82], [160, 177], [102, 130], [217, 130]]) expect(untouched(x, y)).toBe(true);
    expect(changedPixels(source, out, W, H)).toBeGreaterThan(0);
    let inside = 0;
    for (let y = 82; y < 178; y += 1) {
      for (let x = 102; x < 218; x += 1) if (!untouched(x, y)) inside += 1;
    }
    expect(inside).toBe(0);
  });

  it('leaves the outside of the box as it was, apart from the tag', () => {
    for (const [x, y] of [[99, 130], [220, 130], [160, 180], [160, 79], [99, 79], [220, 180]]) expect(untouched(x, y)).toBe(true);
    // The outline (120 × 100 less its 116 × 96 inside) and the tag (26 × 18) are all that changed.
    expect(changedPixels(source, out, W, H)).toBe(120 * 100 - 116 * 96 + 26 * 18);
  });

  it('draws nothing at all without marks', () => {
    expect(Array.from(drawMarks(source, W, H, []))).toEqual(Array.from(source));
  });

  it('takes the thickness from the options', () => {
    const thick = drawMarks(source, W, H, [mark('P1', [100, 80, 120, 100])], { thickness: 6 });
    for (let d = 0; d < 6; d += 1) expect(pixel(thick, W, 100 + d, 130)).toEqual(ORANGE);
    expect(same(pixel(thick, W, 106, 130), pixel(source, W, 106, 130))).toBe(true);
    for (let d = 0; d < 6; d += 1) expect(pixel(thick, W, 160, 179 - d)).toEqual(ORANGE);
    expect(same(pixel(thick, W, 160, 173), pixel(source, W, 160, 173))).toBe(true);
    const thin = drawMarks(source, W, H, [mark('P1', [100, 80, 120, 100])], { thickness: 1 });
    expect(pixel(thin, W, 100, 130)).toEqual(ORANGE);
    expect(same(pixel(thin, W, 101, 130), pixel(source, W, 101, 130))).toBe(true);
  });

  it('never fills a small box with its own outline', () => {
    const small = drawMarks(source, W, H, [mark('P1', [100, 100, 12, 12])], { thickness: 10 });
    expect(pixel(small, W, 100, 106)).toEqual(ORANGE);
    expect(pixel(small, W, 102, 106)).toEqual(ORANGE);
    expect(same(pixel(small, W, 106, 106), pixel(source, W, 106, 106))).toBe(true);
    expect(same(pixel(small, W, 103, 103), pixel(source, W, 103, 103))).toBe(true);
  });

  it('rounds a box that is not on whole pixels the way assignMarks does', () => {
    const rounded = drawMarks(source, W, H, [mark('P1', [99.6, 80.4, 120.2, 99.9])]);
    expect(Array.from(rounded)).toEqual(Array.from(out));
  });
});

describe('drawMarks: sizes that follow the frame', () => {
  /** The thickness of the line and the size of a dot, measured on a picture of this height. */
  function measure(height, options) {
    const width = 400;
    const source = picture(width, height);
    const top = Math.round(height / 2);
    const out = drawMarks(source, width, height, [mark('P1', [100, top, 200, Math.round(height / 3)])], options);
    const colour = MARK_COLOURS[0].rgb;
    let thickness = 0;
    while (same(pixel(out, width, 100 + thickness, top + Math.round(height / 6)), colour)) thickness += 1;
    // The left margin of the tag is one dot wide and nine dots high, all in the mark's colour.
    let tagHeight = 0;
    while (same(pixel(out, width, 100, top - 1 - tagHeight), colour)) tagHeight += 1;
    return { thickness, scale: tagHeight / 9 };
  }

  it('draws a line of max(2, round(height / 240)) pixels and dots of max(2, round(height / 180))', () => {
    expect(measure(240)).toEqual({ thickness: 2, scale: 2 });
    expect(measure(360)).toEqual({ thickness: 2, scale: 2 });
    expect(measure(480)).toEqual({ thickness: 2, scale: 3 });
    expect(measure(540)).toEqual({ thickness: 2, scale: 3 });
    expect(measure(720)).toEqual({ thickness: 3, scale: 4 });
    expect(measure(1080)).toEqual({ thickness: 5, scale: 6 });
  });

  it('takes both from the options instead', () => {
    expect(measure(540, { thickness: 7, scale: 5 })).toEqual({ thickness: 7, scale: 5 });
    expect(measure(540, { thickness: 1, scale: 1 })).toEqual({ thickness: 1, scale: 1 });
    expect(measure(540, { scale: 4 })).toEqual({ thickness: 2, scale: 4 });
    expect(measure(540, { thickness: 3.6, scale: 2.4 })).toEqual({ thickness: 4, scale: 2 });
  });

  it('keeps its own sizes when an option makes no sense', () => {
    for (const bad of [0, -3, NaN, Infinity, '4', null, undefined, {}]) {
      expect(measure(540, { thickness: bad, scale: bad })).toEqual({ thickness: 2, scale: 3 });
    }
    expect(measure(540, null)).toEqual({ thickness: 2, scale: 3 });
  });
});

describe('drawMarks: the tag', () => {
  const W = 120;
  const H = 80;
  const source = picture(W, H);

  it('writes the id in the 5×7 dot font on a filled tag, on top of the box at its left edge', () => {
    const orange = MARK_COLOURS[0].rgb;
    const out = drawMarks(source, W, H, [mark('P1', [20, 30, 60, 40])], { scale: 1, thickness: 1 });
    // "P1" is 13 dots wide and 9 high; the tag ends where the box begins.
    expect(ascii(out, W, [20, 21, 13, 9], orange, BLACK)).toEqual([
      'ooooooooooooo',
      'o####oooo#ooo',
      'o#ooo#oo##ooo',
      'o#ooo#ooo#ooo',
      'o####oooo#ooo',
      'o#ooooooo#ooo',
      'o#ooooooo#ooo',
      'o#oooooo###oo',
      'ooooooooooooo',
    ]);
    // Nothing beside it or above it.
    expect(ascii(out, W, [19, 20, 15, 1], orange, BLACK)).toEqual(['...............']);
    expect(ascii(out, W, [19, 21, 1, 9], orange, BLACK).join('')).toBe('.........');
    expect(ascii(out, W, [33, 21, 1, 9], orange, BLACK).join('')).toBe('.........');
  });

  it('holds both the colour of the mark and the colour of the text', () => {
    const out = drawMarks(source, W, H, [mark('P1', [20, 30, 60, 40])], { scale: 2, thickness: 2 });
    const tag = [20, 12, 26, 18];
    const ink = countColour(out, W, tag, BLACK);
    const fill = countColour(out, W, tag, MARK_COLOURS[0].rgb);
    expect(ink).toBeGreaterThan(0);
    expect(fill).toBeGreaterThan(ink);
    expect(ink + fill).toBe(26 * 18);
  });

  it('has a glyph for P and for each digit, all different', () => {
    const drawn = {};
    for (const id of ['P10', 'P23', 'P45', 'P67', 'P89']) {
      const m = mark(id, [10, 30, 90, 40], 0);
      const out = drawMarks(source, W, H, [m], { scale: 1, thickness: 1 });
      const tag = ascii(out, W, [10, 21, 19, 9], MARK_COLOURS[0].rgb, BLACK);
      expect(tag).toEqual(expectedTag(id));
      [...id].forEach((ch, n) => {
        drawn[ch] = tag.slice(1, 8).map((row) => row.slice(1 + n * 6, 6 + n * 6)).join('\n');
      });
    }
    expect(Object.keys(drawn).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'P']);
    expect(new Set(Object.values(drawn)).size).toBe(11);
    for (const glyph of Object.values(drawn)) expect(glyph).toContain('#');
  });

  it('makes every dot a square of `scale` pixels', () => {
    for (const scale of [2, 3, 4]) {
      const width = 200;
      const height = 120;
      const big = picture(width, height);
      const out = drawMarks(big, width, height, [mark('P7', [30, 60, 120, 50], 3)], { scale, thickness: 1 });
      const text = tagTextColour(MARK_COLOURS[3].rgb);
      expect(ascii(out, width, [30, 60 - 9 * scale, 13, 9], MARK_COLOURS[3].rgb, text, scale)).toEqual(expectedTag('P7'));
    }
  });

  it('grows with the number of digits', () => {
    const out = drawMarks(source, W, H, [mark('P123', [5, 30, 100, 40], 5)], { scale: 1, thickness: 1 });
    expect(ascii(out, W, [5, 21, 25, 9], MARK_COLOURS[5].rgb, WHITE)).toEqual(expectedTag('P123'));
  });

  it('writes the text in black or white, whichever reads better on the colour', () => {
    MARK_COLOURS.forEach((colour, index) => {
      const out = drawMarks(source, W, H, [mark('P8', [20, 30, 60, 40], index)], { scale: 2, thickness: 2 });
      const expected = contrast(BLACK, colour.rgb) > contrast(WHITE, colour.rgb) ? BLACK : WHITE;
      const other = expected === BLACK ? WHITE : BLACK;
      const tag = [20, 12, 26, 18];
      expect(countColour(out, W, tag, expected)).toBeGreaterThan(0);
      // On the black mark the fill itself is black: only then may the other colour be there.
      if (colour.id !== 'black') expect(countColour(out, W, tag, other)).toBe(0);
      expect(ascii(out, W, [20, 12, 13, 9], colour.rgb, expected, 2)).toEqual(expectedTag('P8'));
    });
  });

  it('moves down into the frame when the box touches the top edge', () => {
    const orange = MARK_COLOURS[0].rgb;
    for (const y of [0, 3, 8]) {
      const out = drawMarks(source, W, H, [mark('P1', [20, y, 60, 50])], { scale: 1, thickness: 1 });
      expect(ascii(out, W, [20, 0, 13, 9], orange, BLACK)).toEqual(expectedTag('P1'));
    }
    // With room above, it sits above.
    const out = drawMarks(source, W, H, [mark('P1', [20, 9, 60, 50])], { scale: 1, thickness: 1 });
    expect(ascii(out, W, [20, 0, 13, 9], orange, BLACK)).toEqual(expectedTag('P1'));
    expect(same(pixel(out, W, 40, 30), pixel(source, W, 40, 30))).toBe(true);
  });

  it('moves left into the frame when the corner of the box is too near the right edge', () => {
    const orange = MARK_COLOURS[0].rgb;
    const out = drawMarks(source, W, H, [mark('P1', [112, 30, 8, 40])], { scale: 1, thickness: 1 });
    expect(ascii(out, W, [107, 21, 13, 9], orange, BLACK)).toEqual(expectedTag('P1'));
    // Nothing wrapped round to the left edge of the rows the tag is on.
    for (let y = 20; y < 32; y += 1) {
      for (let x = 0; x < 20; x += 1) expect(same(pixel(out, W, x, y), pixel(source, W, x, y))).toBe(true);
    }
  });

  it('stays at the left edge for a box that starts there', () => {
    const out = drawMarks(source, W, H, [mark('P1', [0, 30, 50, 40])], { scale: 1, thickness: 1 });
    expect(ascii(out, W, [0, 21, 13, 9], MARK_COLOURS[0].rgb, BLACK)).toEqual(expectedTag('P1'));
  });

  it('draws what fits of a tag bigger than the frame, and nothing outside', () => {
    const tiny = picture(10, 6, 9);
    const out = drawMarks(tiny, 10, 6, [mark('P1', [0, 0, 10, 6])], { scale: 2, thickness: 1 });
    expect(out.length).toBe(tiny.length);
    expect(pixel(out, 10, 0, 0)).toEqual(MARK_COLOURS[0].rgb);
    expect(Array.from(out.slice(180))).toEqual(Array.from(tiny.slice(180)));
  });
});

describe('drawMarks: boxes that leave the frame', () => {
  const W = 320;
  const H = 240;
  const source = picture(W, H);
  const ORANGE = MARK_COLOURS[0].rgb;
  const untouchedIn = (out, x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) if (!same(pixel(out, W, x, y), pixel(source, W, x, y))) return false;
    }
    return true;
  };

  it('closes a box that runs off the right and the bottom along the edge of the frame', () => {
    const out = drawMarks(source, W, H, [mark('P1', [280, 200, 100, 100])], { thickness: 2, scale: 2 });
    expect(out.length).toBe(source.length);
    expect(pixel(out, W, 319, 220)).toEqual(ORANGE);
    expect(pixel(out, W, 318, 220)).toEqual(ORANGE);
    expect(pixel(out, W, 300, 239)).toEqual(ORANGE);
    expect(pixel(out, W, 300, 238)).toEqual(ORANGE);
    expect(pixel(out, W, 280, 220)).toEqual(ORANGE);
    expect(pixel(out, W, 300, 200)).toEqual(ORANGE);
    expect(same(pixel(out, W, 300, 220), pixel(source, W, 300, 220))).toBe(true);
    // A pixel past the right edge would land at the start of the next row: none did.
    expect(untouchedIn(out, 0, 0, 270, H)).toBe(true);
    expect(untouchedIn(out, 0, 0, W, 180)).toBe(true);
  });

  it('closes a box that runs off the left and the top, with the tag in the corner of the frame', () => {
    const out = drawMarks(source, W, H, [mark('P1', [-30, -20, 100, 100])], { thickness: 2, scale: 1 });
    expect(ascii(out, W, [0, 0, 13, 9], ORANGE, BLACK)).toEqual(expectedTag('P1'));
    expect(pixel(out, W, 0, 40)).toEqual(ORANGE);
    expect(pixel(out, W, 69, 40)).toEqual(ORANGE);
    expect(pixel(out, W, 40, 79)).toEqual(ORANGE);
    expect(pixel(out, W, 40, 0)).toEqual(ORANGE);
    expect(same(pixel(out, W, 35, 40), pixel(source, W, 35, 40))).toBe(true);
    // Nothing wrapped round to the right edge, and nothing below the box.
    expect(untouchedIn(out, 70, 0, W, H)).toBe(true);
    expect(untouchedIn(out, 0, 80, W, H)).toBe(true);
  });

  it('draws a box bigger than the frame as the frame itself', () => {
    const out = drawMarks(source, W, H, [mark('P1', [-50, -50, 1000, 1000])], { thickness: 2, scale: 1 });
    for (const [x, y] of [[0, 120], [1, 120], [319, 120], [318, 120], [160, 239], [160, 238], [160, 0], [160, 1]]) expect(pixel(out, W, x, y)).toEqual(ORANGE);
    expect(untouchedIn(out, 2, 9, 318, 238)).toBe(true);
  });

  it('draws nothing, not even the tag, for a box wholly outside', () => {
    const outside = [
      [400, 300, 50, 50],
      [-200, -200, 100, 100],
      [100, 240, 50, 50],
      [320, 10, 20, 20],
      [-50, 100, 50, 50],
      [100, -50, 50, 50],
      [100000, 100000, 5, 5],
    ];
    const out = drawMarks(source, W, H, outside.map((box, i) => mark(`P${i + 1}`, box)));
    expect(Array.from(out)).toEqual(Array.from(source));
  });

  it('writes nothing past the frame into a buffer that is longer than the frame', () => {
    const padded = picture(W, H, 90);
    const out = drawMarks(padded, W, H, [mark('P1', [-10, 200, 400, 100]), mark('P2', [300, -10, 100, 300])], { thickness: 3, scale: 2 });
    expect(out.length).toBe(padded.length);
    expect(Array.from(out.slice(W * H * 3))).toEqual(Array.from(padded.slice(W * H * 3)));
    expect(pixel(out, W, 0, 239)).toEqual(MARK_COLOURS[0].rgb);
  });

  it('survives every corner of the frame at every scale without writing outside', () => {
    const w = 64;
    const h = 48;
    const small = picture(w, h, 30);
    for (const box of [[-5, -5, 20, 20], [50, -5, 30, 20], [-5, 40, 20, 20], [55, 40, 30, 30], [60, 44, 4, 4], [63, 47, 1, 1], [0, 0, 1, 1], [-1000, 10, 2000, 5]]) {
      for (const scale of [1, 2, 5, 20]) {
        const out = drawMarks(small, w, h, [mark('P12', box, 6)], { scale, thickness: scale });
        expect(out.length).toBe(small.length);
        expect(Array.from(out.slice(w * h * 3))).toEqual(Array.from(small.slice(w * h * 3)));
        expect(changedPixels(small, out, w, h)).toBeGreaterThan(0);
      }
    }
  });
});

describe('drawMarks: several marks', () => {
  const W = 320;
  const H = 240;
  const source = picture(W, H);

  it('draws each mark in its own colour', () => {
    const marks = [mark('P1', [20, 60, 80, 80]), mark('P2', [120, 60, 80, 80]), mark('P6', [220, 60, 80, 80])];
    const out = drawMarks(source, W, H, marks);
    expect(pixel(out, W, 20, 100)).toEqual(MARK_COLOURS[0].rgb);
    expect(pixel(out, W, 120, 100)).toEqual(MARK_COLOURS[1].rgb);
    expect(pixel(out, W, 220, 100)).toEqual(MARK_COLOURS[5].rgb);
    expect(ascii(out, W, [220, 42, 13, 9], MARK_COLOURS[5].rgb, WHITE, 2)).toEqual(expectedTag('P6'));
    expect(ascii(out, W, [120, 42, 13, 9], MARK_COLOURS[1].rgb, BLACK, 2)).toEqual(expectedTag('P2'));
  });

  it('draws every box before any tag, so no number is crossed by the box of a neighbour', () => {
    // The bottom line of the second box runs through the place of the first one's tag.
    const first = mark('P1', [100, 100, 80, 80]);
    const second = mark('P2', [90, 60, 100, 30]);
    for (const marks of [[first, second], [second, first]]) {
      const out = drawMarks(source, W, H, marks, { scale: 2, thickness: 2 });
      expect(ascii(out, W, [100, 82, 13, 9], MARK_COLOURS[0].rgb, BLACK, 2)).toEqual(expectedTag('P1'));
      expect(pixel(out, W, 95, 89)).toEqual(MARK_COLOURS[1].rgb);
    }
  });

  it('draws what assignMarks hands it, people and faces alike', () => {
    const marks = assignMarks(
      [{ characterId: 'P2', box: [200, 60, 30, 30], conf: 0.8 }, { characterId: 'P1', box: [20, 60, 80, 80], conf: 0.9 }],
      { frame: { w: W, h: H } },
    );
    expect(marks.map((m) => m.kind)).toEqual(['face', 'person']);
    const out = drawMarks(source, W, H, marks);
    expect(pixel(out, W, 20, 100)).toEqual(MARK_COLOURS[0].rgb);
    // The person box of P2: 170 to 260 across, 60 down to the bottom of the frame.
    expect(pixel(out, W, 170, 150)).toEqual(MARK_COLOURS[1].rgb);
    expect(pixel(out, W, 259, 150)).toEqual(MARK_COLOURS[1].rgb);
    expect(pixel(out, W, 215, 239)).toEqual(MARK_COLOURS[1].rgb);
    expect(same(pixel(out, W, 215, 150), pixel(source, W, 215, 150))).toBe(true);
  });

  it('takes a colour by its id, and the colour of the number when the mark has none', () => {
    const byId = drawMarks(source, W, H, [{ char: 'P1', colour: 'yellow', box: [20, 60, 80, 80] }]);
    expect(pixel(byId, W, 20, 100)).toEqual([240, 228, 66]);
    for (const colour of [undefined, null, 'no-such-colour', 7, {}, { rgb: [1, 2] }, { rgb: 'red' }]) {
      const fallback = drawMarks(source, W, H, [{ char: 'P3', colour, box: [20, 60, 80, 80] }]);
      expect(pixel(fallback, W, 20, 100)).toEqual(MARK_COLOURS[2].rgb);
    }
  });

  it('draws a colour of the caller, kept within a byte', () => {
    const out = drawMarks(source, W, H, [{ char: 'P1', colour: { rgb: [300, -20, 127.6] }, box: [20, 60, 80, 80] }]);
    expect(pixel(out, W, 20, 100)).toEqual([255, 0, 128]);
  });
});

describe('drawMarks: input that makes no sense', () => {
  const W = 64;
  const H = 48;
  const source = picture(W, H);
  const good = [mark('P1', [10, 20, 30, 20])];

  it('copies every kind of buffer and never draws on the one it was given', () => {
    const expected = Array.from(drawMarks(source, W, H, good));
    const clamped = new Uint8ClampedArray(source);
    const fromClamped = drawMarks(clamped, W, H, good);
    expect(fromClamped).toBeInstanceOf(Uint8Array);
    expect(Array.from(fromClamped)).toEqual(expected);
    expect(Array.from(clamped)).toEqual(Array.from(source));

    const buffer = source.buffer.slice(0);
    const fromBuffer = drawMarks(buffer, W, H, good);
    expect(Array.from(fromBuffer)).toEqual(expected);
    expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(source));

    const list = Array.from(source);
    expect(Array.from(drawMarks(list, W, H, good))).toEqual(expected);
    expect(list).toEqual(Array.from(source));

    const frozenMarks = deepFreeze([{ char: 'P1', colour: MARK_COLOURS[0], box: [10, 20, 30, 20], kind: 'face' }]);
    expect(Array.from(drawMarks(source, W, H, frozenMarks, deepFreeze({ thickness: 2, scale: 2 })))).toEqual(expected);
  });

  it('returns an empty picture for something that is not a picture', () => {
    for (const rgb of [undefined, null, 'pixels', 42, {}, { length: 10 }]) {
      const out = drawMarks(rgb, W, H, good);
      expect(out).toBeInstanceOf(Uint8Array);
      expect(out.length).toBe(0);
    }
  });

  it('returns an unmarked copy when the size does not fit the buffer', () => {
    for (const [w, h] of [[0, H], [W, 0], [-W, H], [W, NaN], [undefined, undefined], ['64', '48'], [W + 0.5, H], [W, H + 1], [1000, 1000], [Infinity, 1]]) {
      const out = drawMarks(source, w, h, good);
      expect(out).not.toBe(source);
      expect(Array.from(out)).toEqual(Array.from(source));
    }
  });

  it('returns an unmarked copy when the marks are not a list', () => {
    for (const marks of [undefined, null, 'P1', 5, {}, { length: 1, 0: good[0] }]) {
      const out = drawMarks(source, W, H, marks);
      expect(out).not.toBe(source);
      expect(Array.from(out)).toEqual(Array.from(source));
    }
  });

  it('skips a mark without a character id or a usable box, and draws the others', () => {
    const marks = [
      null,
      'P1',
      {},
      { char: 'P0', box: [1, 1, 20, 20] },
      { char: 'Matthew', box: [1, 1, 20, 20] },
      { char: 'P2' },
      { char: 'P2', box: [1, 1, 20] },
      { char: 'P2', box: [1, 1, NaN, 20] },
      { char: 'P2', box: [1, 1, -20, 20] },
      { char: 'P2', box: 'here' },
      ...good,
    ];
    expect(Array.from(drawMarks(source, W, H, marks))).toEqual(Array.from(drawMarks(source, W, H, good)));
  });

  it('writes nothing but the letter P and digits: an id is the only text on a frame', () => {
    const out = drawMarks(source, W, H, [{ char: 'P3 Matthew', box: [10, 20, 30, 20] }, { char: '马修', box: [10, 20, 30, 20] }]);
    expect(Array.from(out)).toEqual(Array.from(source));
  });
});
