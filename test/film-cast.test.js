// The cast registry of the film engine (src/film/cast.js): characters, the
// evidence for their names and how sure a name is, what a person confirmed,
// rejected or merged, outfits over time, and what of all this a package carries.
import { describe, expect, it } from 'vitest';
import {
  addCharacter,
  addEvidence,
  appearanceAt,
  confirmName,
  createCast,
  exportCast,
  getCharacter,
  levelFromEvidence,
  mergeCharacters,
  neverName,
  rejectName,
  setAppearance,
  updateCharacter,
  validateCast,
} from '../src/film/cast.js';
import { DEFAULT_POLICY, LEVEL } from '../src/film/types.js';

const GAP = { independentGapSec: 90 };
const clue = (t, name, kind = 'vocative', extra = {}) => ({ t, kind, name, ...extra });
const human = (name, extra = {}) => ({ t: 0, kind: 'human', name, ...extra });

/** A cast with one character per argument: P1, P2, … */
function castWith(...fields) {
  let cast = createCast();
  for (const f of fields) ({ cast } = addCharacter(cast, f));
  return cast;
}

/** Freeze a value all the way down: a function that changes its argument then throws. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** Every key used anywhere inside a value. */
function keysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysIn(v, found);
    }
  }
  return found;
}

const EMPTY_CHARACTER = {
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
};

const JUNK = [null, undefined, 0, 7, NaN, 'x', '', true, [], {}, [null], [[]], { a: 1 }, () => 1];

describe('createCast', () => {
  it('is an empty cast with the default policy', () => {
    const cast = createCast();
    expect(cast).toEqual({
      v: 1,
      policy: { ...DEFAULT_POLICY },
      characters: [],
      appearances: [],
      constraints: { mustLink: [], cannotLink: [] },
      events: [],
    });
    expect(cast.policy).not.toBe(DEFAULT_POLICY);
    expect(Object.isFrozen(cast.policy)).toBe(false);
  });

  it('takes a policy, whole or in part', () => {
    expect(createCast({ policy: { naming: 'on-reveal', minLevel: 2 } }).policy).toEqual({ ...DEFAULT_POLICY, naming: 'on-reveal', minLevel: 2 });
    expect(createCast({ policy: { introBeforeFilm: false, reanchorAfterSec: 600, independentGapSec: 0 } }).policy).toEqual({
      ...DEFAULT_POLICY,
      introBeforeFilm: false,
      reanchorAfterSec: 600,
      independentGapSec: 0,
    });
  });

  it('falls back to the default for a policy value that is not valid, and drops unknown ones', () => {
    const policy = { naming: 'always', minLevel: 1, introBeforeFilm: 'no', reanchorAfterSec: -5, independentGapSec: NaN, shout: true };
    expect(createCast({ policy }).policy).toEqual({ ...DEFAULT_POLICY });
    for (const junk of JUNK) {
      expect(createCast(junk).policy).toEqual({ ...DEFAULT_POLICY });
      expect(createCast({ policy: junk }).policy).toEqual({ ...DEFAULT_POLICY });
    }
  });
});

describe('validateCast', () => {
  it('throws bad-cast when the value is not an object', () => {
    for (const raw of [null, undefined, 'cast', 3, true, [], [{ v: 1 }]]) {
      expect(() => validateCast(raw)).toThrow('bad-cast');
    }
  });

  it('fills an empty object in as an empty cast', () => {
    expect(validateCast({})).toEqual(createCast());
  });

  it('drops unknown fields of the cast and of a character', () => {
    const cast = validateCast({
      v: 7,
      title: 'a film',
      thumbnails: { P1: 'data:…' },
      characters: [{ id: 'P1', faces: [[0.1, 0.2]], embedding: 'abc', thumbnail: 'data:…', descriptor: { zh: '长发女人' } }],
    });
    expect(Object.keys(cast)).toEqual(['v', 'policy', 'characters', 'appearances', 'constraints', 'events']);
    expect(cast.v).toBe(1);
    expect(Object.keys(cast.characters[0])).toEqual(['id', 'name', 'level', 'aliases', 'descriptor', 'revealAt', 'spoilerLock', 'neverName', 'main', 'screenSec', 'evidence', 'clusters']);
    expect(cast.characters[0]).toEqual({ ...EMPTY_CHARACTER, id: 'P1', descriptor: { zh: '长发女人' } });
  });

  it('keeps only characters with a valid id, each id once', () => {
    const cast = validateCast({
      characters: [{ id: 'P1' }, { id: 'P0' }, { id: 'p3' }, { id: 'P03' }, { id: 3 }, { id: '{P5}' }, null, 'P4', { id: 'P1', main: true }, { id: 'P12' }],
    });
    expect(cast.characters.map((c) => c.id)).toEqual(['P1', 'P12']);
    expect(cast.characters[0].main).toBe(false);
  });

  it('turns values of the wrong type into the defaults', () => {
    const cast = validateCast({
      characters: [{
        id: 'P2',
        name: 42,
        level: '3',
        aliases: 'Matt',
        say: 5,
        descriptor: 'a woman',
        revealAt: 'soon',
        spoilerLock: 0,
        neverName: null,
        main: 'yes',
        screenSec: -4,
        evidence: 'none',
        clusters: { a: 1 },
      }],
    });
    expect(cast.characters[0]).toEqual({ ...EMPTY_CHARACTER, id: 'P2' });
    expect('say' in cast.characters[0]).toBe(false);
  });

  it('keeps valid values, trims text and reads a time written as text', () => {
    const [ch] = validateCast({
      characters: [{
        id: 'P3',
        name: '  马  修 ',
        level: 2,
        aliases: [{ text: '小马' }],
        say: ' mǎ xiū ',
        descriptor: { zh: ' 长发女人 ', en: 'woman with long hair' },
        revealAt: '3:12',
        spoilerLock: true,
        neverName: true,
        main: true,
        screenSec: 2040.5,
        clusters: ['c12'],
      }],
    }).characters;
    expect(ch).toEqual({
      id: 'P3',
      name: '马 修',
      level: 2,
      aliases: [{ text: '小马' }],
      say: 'mǎ xiū',
      descriptor: { zh: '长发女人', en: 'woman with long hair' },
      revealAt: 192,
      spoilerLock: true,
      neverName: true,
      main: true,
      screenSec: 2040.5,
      evidence: [],
      clusters: ['c12'],
    });
  });

  it('treats any truthy lock as a lock: not naming is the safe mistake', () => {
    const [ch] = validateCast({ characters: [{ id: 'P1', spoilerLock: 'yes', neverName: 1 }] }).characters;
    expect(ch.spoilerLock).toBe(true);
    expect(ch.neverName).toBe(true);
  });

  it('cleans evidence entry by entry', () => {
    const [ch] = validateCast({
      characters: [{
        id: 'P1',
        evidence: [
          { t: 10, kind: 'vocative', name: '马修', quote: ' 马修，等等 ', extra: 1 },
          { t: 20, kind: 'gossip', name: '马修' },
          { t: 30, kind: 'vocative', name: '   ' },
          { kind: 'vocative', name: '马修' },
          { t: -3, kind: 'credits', name: '马修' },
          { kind: 'human', name: '马修', by: 'guess' },
          { t: '3:12', kind: 'self-intro', name: '马修', by: 'ear', line: '我叫马修' },
          { t: 40, kind: 'on-screen', name: '老陈', rejected: 'yes' },
          null,
          'x',
          5,
        ],
      }],
    }).characters;
    expect(ch.evidence).toEqual([
      { t: 10, kind: 'vocative', name: '马修', quote: '马修，等等' },
      { t: 0, kind: 'human', name: '马修' },
      { t: 192, kind: 'self-intro', name: '马修', quote: '我叫马修' },
      { t: 40, kind: 'on-screen', name: '老陈', rejected: true },
    ]);
    expect(ch.name).toBe('马修');
    expect(ch.level).toBe(LEVEL.CONFIRMED);
  });

  it('sets name and level from the evidence where there is any', () => {
    const cast = validateCast({
      characters: [
        { id: 'P1', name: '老陈', level: 2, evidence: [clue(10, '马修')] },
        { id: 'P2', name: '马修', level: 1, evidence: [clue(10, '马修'), clue(20, '马修', 'self-intro')] },
        { id: 'P3', name: '马修', level: 3, evidence: [clue(10, '老陈', 'vocative', { rejected: true })] },
      ],
    });
    expect(cast.characters.map((c) => [c.name, c.level])).toEqual([['马修', 1], ['马修', 2], ['马修', 3]]);
  });

  it('uses the gap of the cast it reads when it counts independent clues', () => {
    const characters = [{ id: 'P1', evidence: [clue(10, '马修'), clue(60, '马修')] }];
    expect(validateCast({ characters }).characters[0].level).toBe(1);
    expect(validateCast({ policy: { independentGapSec: 30 }, characters }).characters[0].level).toBe(2);
  });

  it('keeps a name carried without evidence, never at level 0 and never without a name above it', () => {
    const cast = validateCast({
      characters: [
        { id: 'P1', name: '马修', level: 2 },
        { id: 'P2', name: '马修' },
        { id: 'P3', name: '马修', level: 0 },
        { id: 'P4', name: '马修', level: 7 },
        { id: 'P5', level: 3 },
        { id: 'P6', name: '', level: 2 },
      ],
    });
    expect(cast.characters.map((c) => [c.name, c.level])).toEqual([['马修', 2], ['马修', 1], ['马修', 1], ['马修', 1], [null, 0], [null, 0]]);
    expect(cast.characters.every((c) => c.evidence.length === 0)).toBe(true);
  });

  it('records a confirmed name that arrives without evidence as a confirmation, by ear or by sight when the package says', () => {
    const cast = validateCast({
      characters: [
        { id: 'P1', name: '马修', level: 3, confirmedBy: 'ear' },
        { id: 'P2', name: 'Matthew', level: 3, confirmedBy: 'sight' },
        { id: 'P3', name: '老陈', level: 3 },
        { id: 'P4', name: '小李', level: 3, confirmedBy: 'rumour' },
        { id: 'P5', name: '阿强', level: 2, confirmedBy: 'ear' },
      ],
    });
    expect(cast.characters.map((c) => c.evidence)).toEqual([
      [{ t: 0, kind: 'human', name: '马修', by: 'ear' }],
      [{ t: 0, kind: 'human', name: 'Matthew', by: 'sight' }],
      [{ t: 0, kind: 'human', name: '老陈' }],
      [{ t: 0, kind: 'human', name: '小李' }],
      [],
    ]);
    expect(cast.characters.map((c) => c.level)).toEqual([3, 3, 3, 3, 2]);
    expect(keysIn(cast).has('confirmedBy')).toBe(false);
  });

  it('does not bring back a name a person rejected', () => {
    const rejected = { t: 5, kind: 'human', by: 'ear', name: '马修', rejected: true };
    const [ch] = validateCast({ characters: [{ id: 'P1', name: '马修', level: 3, evidence: [rejected] }] }).characters;
    expect(ch.name).toBeNull();
    expect(ch.level).toBe(0);
    expect(ch.evidence).toEqual([rejected]);
  });

  it('cleans aliases: strings or objects, each text once', () => {
    const [ch] = validateCast({
      characters: [{
        id: 'P1',
        aliases: ['小马', { text: 'Matt', lang: 'en', kind: 'nickname', validFrom: 600, junk: 1 }, { text: 'matt' }, '小马', { text: '' }, { lang: 'en' }, 5, null],
      }],
    }).characters;
    expect(ch.aliases).toEqual([{ text: '小马' }, { text: 'Matt', lang: 'en', kind: 'nickname', validFrom: 600 }]);
  });

  it('cleans the visual label: Chinese and English only, no article in English, no braces', () => {
    const label = (descriptor) => validateCast({ characters: [{ id: 'P1', descriptor }] }).characters[0].descriptor;
    expect(label({ zh: '长发女人', en: 'woman with long hair', ja: '髪の長い女' })).toEqual({ zh: '长发女人', en: 'woman with long hair' });
    expect(label({ en: 'The woman with long hair' })).toEqual({ en: 'woman with long hair' });
    expect(label({ en: 'a man in glasses' })).toEqual({ en: 'man in glasses' });
    expect(label({ en: 'an elderly man' })).toEqual({ en: 'elderly man' });
    expect(label({ en: 'another man' })).toEqual({ en: 'another man' });
    expect(label({ zh: '{长发}女人', en: 'woman {P3}' })).toEqual({ zh: '长发女人', en: 'woman P3' });
    expect(label({ zh: '', en: 7 })).toEqual({});
  });

  it('removes braces from a name, which would silence every cue that says it', () => {
    const [ch] = validateCast({ characters: [{ id: 'P1', name: '｛马修}', level: 2 }] }).characters;
    expect(ch.name).toBe('马修');
  });

  it('cuts text that runs on without end', () => {
    const [ch] = validateCast({
      characters: [{
        id: 'P1',
        name: '修'.repeat(500),
        level: 2,
        descriptor: { zh: '长'.repeat(500), en: 'x'.repeat(500) },
        aliases: ['马'.repeat(500)],
        evidence: [clue(1, '马修', 'vocative', { quote: '等'.repeat(5000) })],
      }],
      appearances: [{ char: 'P1', from: 0, outfit: '裙'.repeat(500) }],
    }).characters;
    expect(ch.descriptor.zh).toHaveLength(120);
    expect(ch.descriptor.en).toHaveLength(120);
    expect(ch.aliases[0].text).toHaveLength(80);
    expect(ch.evidence[0].quote).toHaveLength(300);
    const long = validateCast({ characters: [{ id: 'P1', name: '修'.repeat(500), level: 2 }], appearances: [{ char: 'P1', from: 0, outfit: '裙'.repeat(500) }] });
    expect(long.characters[0].name).toHaveLength(80);
    expect(long.appearances[0].outfit).toHaveLength(120);
  });

  it('cleans clusters: text ids, each once', () => {
    const [ch] = validateCast({ characters: [{ id: 'P1', clusters: ['c1', 'c1', 7, '', null, ' c2 ', {}] }] }).characters;
    expect(ch.clusters).toEqual(['c1', '7', 'c2']);
  });

  it('cleans appearances and puts each character\'s in order', () => {
    const cast = validateCast({
      characters: [{ id: 'P1' }, { id: 'P2' }],
      appearances: [
        { char: 'P1', from: 600, outfit: '灰大衣', src: 'human', scene: 4, junk: true },
        { char: 'P1', from: 0, to: null, outfit: ' 红裙子 ', src: 'model' },
        { char: 'P9', from: 0, outfit: '蓝西装', src: 'model' },
        { char: 'P2', from: 'x', outfit: '黑夹克' },
        { char: 'P2', from: 50, outfit: '  ' },
        { char: 'P2', from: 100, to: 100, outfit: '黑夹克' },
        { char: 'P2', from: 30, to: 90, outfit: '黑夹克', src: 'robot', scene: 'two' },
        { from: 0, outfit: '黑夹克' },
        null,
        'x',
      ],
    });
    expect(cast.appearances).toEqual([
      { char: 'P1', from: 0, to: 600, outfit: '红裙子', src: 'model' },
      { char: 'P2', from: 30, to: 90, outfit: '黑夹克', src: 'model' },
      { char: 'P1', from: 600, to: null, outfit: '灰大衣', scene: 4, src: 'human' },
    ]);
  });

  it('clips overlapping appearances, keeps the later of two with one start, and joins neighbours in the same outfit', () => {
    const cast = validateCast({
      characters: [{ id: 'P1' }],
      appearances: [
        { char: 'P1', from: 0, to: 500, outfit: '红裙子' },
        { char: 'P1', from: 300, to: null, outfit: '灰大衣' },
        { char: 'P1', from: 300, to: null, outfit: '蓝西装' },
        { char: 'P1', from: 800, to: 900, outfit: '蓝西装' },
        { char: 'P1', from: 1000, to: 1100, outfit: '蓝西装' },
      ],
    });
    expect(cast.appearances).toEqual([
      { char: 'P1', from: 0, to: 300, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 300, to: 900, outfit: '蓝西装', src: 'model' },
      { char: 'P1', from: 1000, to: 1100, outfit: '蓝西装', src: 'model' },
    ]);
  });

  it('cleans constraints: groups of at least two ids', () => {
    const cast = validateCast({ constraints: { mustLink: [['c1', 'c2', 'c1'], ['c3'], 'x', [1, 2], [' c4 ', 'c5']], cannotLink: 'no' } });
    expect(cast.constraints).toEqual({ mustLink: [['c1', 'c2'], ['c4', 'c5']], cannotLink: [] });
  });

  it('keeps the record of changes, entries of kinds it does not know too, with plain values only', () => {
    const cast = validateCast({
      events: [
        { type: 'confirm', char: 'P1', name: '马修', by: 'ear', t: 12 },
        { type: 'split', from: 'P1', into: ['P4'], note: { a: 1 }, t: 5, bad: NaN, by: null, ok: false },
        { char: 'P1' },
        { type: '' },
        { type: 9 },
        null,
        'x',
      ],
    });
    expect(cast.events).toEqual([
      { type: 'confirm', char: 'P1', name: '马修', by: 'ear', t: 12 },
      { type: 'split', from: 'P1', t: 5, by: null, ok: false },
    ]);
  });

  it('survives junk in every field', () => {
    for (const junk of JUNK) {
      const cast = validateCast({ v: junk, policy: junk, characters: junk, appearances: junk, constraints: junk, events: junk });
      expect(cast).toEqual(createCast());
      const inside = validateCast({
        characters: [junk, {
          id: 'P1', name: junk, level: junk, aliases: [junk], say: junk, descriptor: { zh: junk, en: junk }, revealAt: junk,
          spoilerLock: false, neverName: false, main: junk, screenSec: junk, evidence: [junk, { t: junk, kind: junk, name: junk }], clusters: junk,
        }],
        appearances: [junk, { char: junk, from: junk, to: junk, outfit: junk, scene: junk, src: junk }],
        constraints: { mustLink: [junk], cannotLink: junk },
        events: [junk, { type: junk }],
      });
      expect(inside.characters.map((c) => c.id)).toEqual(['P1']);
      // 'x' is the one piece of junk that could be a name; without evidence it stays below level 2.
      expect(inside.characters[0].name).toBe(junk === 'x' ? 'x' : null);
      expect(inside.characters[0].level).toBe(junk === 'x' ? 1 : 0);
      expect(inside.characters[0].evidence).toEqual([]);
      expect(inside.appearances).toEqual([]);
      expect(inside.constraints).toEqual({ mustLink: [], cannotLink: [] });
    }
  });

  it('leaves a cast this module built as it is, also after a trip through JSON, and is the same twice', () => {
    let cast = castWith(
      { descriptor: { zh: '长发女人', en: 'woman with long hair' }, main: true, screenSec: 2040, clusters: ['c1'], aliases: ['小马'], say: 'mǎ xiū' },
      { descriptor: { zh: '戴眼镜的男人' }, clusters: ['c2'] },
      { clusters: ['c3'] },
      {},
    );
    cast = addEvidence(cast, 'P1', clue(192, '马修', 'vocative', { quote: '马修，等等' }));
    cast = addEvidence(cast, 'P1', clue(400, '马修', 'self-intro'));
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 420 });
    cast = addEvidence(cast, 'P2', clue(300, '老陈'));
    cast = rejectName(cast, 'P2', '老陈', { t: 500 });
    cast = neverName(cast, 'P3');
    cast = setAppearance(cast, { char: 'P1', from: 0, outfit: '红裙子', src: 'model' });
    cast = setAppearance(cast, { char: 'P1', from: 600, outfit: '灰大衣', scene: 4, src: 'human' });
    cast = setAppearance(cast, { char: 'P2', from: 30, outfit: '黑夹克', src: 'model' });
    ({ cast } = mergeCharacters(cast, 'P3', 'P4', { t: 600 }));
    cast = updateCharacter(cast, 'P2', { revealAt: 300, spoilerLock: true });

    expect(validateCast(cast)).toEqual(cast);
    expect(validateCast(JSON.parse(JSON.stringify(cast)))).toEqual(cast);
    expect(JSON.stringify(validateCast(cast))).toBe(JSON.stringify(cast));
    expect(validateCast(validateCast(cast))).toEqual(validateCast(cast));
  });

  it('does not change what it is given', () => {
    const raw = deepFreeze({
      policy: { naming: 'on-reveal' },
      characters: [{ id: 'P1', name: '马修', level: 3, aliases: ['小马'], descriptor: { en: 'the woman' }, evidence: [clue(10, '马修')], clusters: ['c1'] }],
      appearances: [{ char: 'P1', from: 5, outfit: '红裙子' }, { char: 'P1', from: 0, outfit: '灰大衣' }],
      constraints: { mustLink: [['c1', 'c2']] },
      events: [{ type: 'confirm', char: 'P1' }],
    });
    expect(() => validateCast(raw)).not.toThrow();
  });
});

describe('getCharacter', () => {
  it('finds a character by id, or gives undefined', () => {
    const cast = castWith({ main: true }, {});
    expect(getCharacter(cast, 'P1')).toBe(cast.characters[0]);
    expect(getCharacter(cast, 'P2').id).toBe('P2');
    expect(getCharacter(cast, 'P3')).toBeUndefined();
    expect(getCharacter(cast, undefined)).toBeUndefined();
    expect(getCharacter(null, 'P1')).toBeUndefined();
    expect(getCharacter({}, 'P1')).toBeUndefined();
  });
});

describe('addCharacter', () => {
  it('numbers characters P1, P2, P3 and gives each the defaults', () => {
    const first = addCharacter(createCast());
    const second = addCharacter(first.cast);
    const third = addCharacter(second.cast, null);
    expect([first.id, second.id, third.id]).toEqual(['P1', 'P2', 'P3']);
    expect(third.cast.characters.map((c) => c.id)).toEqual(['P1', 'P2', 'P3']);
    expect(getCharacter(third.cast, 'P1')).toEqual({ ...EMPTY_CHARACTER, id: 'P1' });
    expect('say' in getCharacter(third.cast, 'P1')).toBe(false);
  });

  it('takes fields, cleaned, and gives the id itself', () => {
    const { cast, id } = addCharacter(createCast(), {
      id: 'P99',
      descriptor: { zh: '长发女人', en: 'a woman with long hair' },
      main: true,
      screenSec: 2040,
      clusters: ['c12'],
      aliases: ['小马'],
      say: 'mǎ xiū',
      revealAt: 192,
      spoilerLock: true,
      neverName: true,
      faces: [1, 2, 3],
    });
    expect(id).toBe('P1');
    expect(getCharacter(cast, 'P1')).toEqual({
      ...EMPTY_CHARACTER,
      id: 'P1',
      descriptor: { zh: '长发女人', en: 'woman with long hair' },
      main: true,
      screenSec: 2040,
      clusters: ['c12'],
      aliases: [{ text: '小马' }],
      say: 'mǎ xiū',
      revealAt: 192,
      spoilerLock: true,
      neverName: true,
    });
    expect(getCharacter(cast, 'P99')).toBeUndefined();
  });

  it('keeps a name and level given without evidence, and follows the evidence when there is some', () => {
    const cast = castWith(
      { name: '马修', level: 2 },
      { name: 'Matthew', level: 3 },
      { evidence: [clue(10, '老陈'), clue(20, '老陈', 'self-intro')] },
      { name: '马修', level: 3, evidence: [clue(10, '老陈')] },
    );
    expect(cast.characters.map((c) => [c.name, c.level])).toEqual([['马修', 2], ['Matthew', 3], ['老陈', 2], ['马修', 3]]);
    // A confirmed name is held by a confirmation, so the clue that follows cannot unseat it.
    const after = addEvidence(cast, 'P2', clue(50, 'Matt'));
    expect(getCharacter(after, 'P2')).toMatchObject({ name: 'Matthew', level: 3 });
  });

  it('goes on from the highest number in use, not from how many there are', () => {
    const cast = validateCast({ characters: [{ id: 'P2' }, { id: 'P7' }] });
    expect(addCharacter(cast).id).toBe('P8');
  });

  it('knows no id of more than six digits, in a character or in the record of changes', () => {
    const cast = validateCast({
      characters: [{ id: 'P1' }, { id: 'P1000000' }, { id: 'P9007199254740992' }, { id: 'P9007199254740993' }],
      events: [{ type: 'merge', keep: 'P1', drop: 'P999999999999999999999999' }, { type: 'confirm', char: 'P9007199254740992', name: 'x' }],
    });
    expect(cast.characters.map((c) => c.id)).toEqual(['P1']);
    const next = addCharacter(cast, { descriptor: { en: 'new person' } });
    expect(next.id).toBe('P2');
    expect(next.cast.characters.map((c) => c.id)).toEqual(['P1', 'P2']);
    expect(getCharacter(next.cast, 'P2').descriptor).toEqual({ en: 'new person' });
    // The six digits a token may have are all usable.
    expect(addCharacter(validateCast({ characters: [{ id: 'P999998' }] })).id).toBe('P999999');
  });

  it('throws cast-full when the last id was given out, instead of an id that is none or one in use', () => {
    const full = validateCast({ characters: [{ id: 'P999999' }] });
    expect(() => addCharacter(full)).toThrow('cast-full');
    expect(full.characters.map((c) => c.id)).toEqual(['P999999']);
    // Also when the last number was merged away: a number is not used twice.
    const merged = validateCast({ characters: [{ id: 'P1' }], events: [{ type: 'merge', keep: 'P1', drop: 'P999999' }] });
    expect(() => addCharacter(merged)).toThrow('cast-full');
  });

  it('goes on from the highest number after a merge removed a character', () => {
    const three = castWith({}, {}, {});
    const { cast } = mergeCharacters(three, 'P1', 'P2');
    expect(cast.characters.map((c) => c.id)).toEqual(['P1', 'P3']);
    const added = addCharacter(cast);
    expect(added.id).toBe('P4');
    expect(added.cast.characters.map((c) => c.id)).toEqual(['P1', 'P3', 'P4']);
  });

  it('does not give the number of a merged character out again, even when it was the highest', () => {
    const three = castWith({}, {}, {});
    const { cast } = mergeCharacters(three, 'P1', 'P3');
    expect(cast.characters.map((c) => c.id)).toEqual(['P1', 'P2']);
    expect(addCharacter(cast).id).toBe('P4');
    // The record of the merge is what remembers the number: it survives a save and a load.
    expect(addCharacter(validateCast(JSON.parse(JSON.stringify(cast)))).id).toBe('P4');
  });

  it('throws bad-cast for something that is not a cast, and does not change the cast it is given', () => {
    expect(() => addCharacter(null)).toThrow('bad-cast');
    expect(() => addCharacter('cast')).toThrow('bad-cast');
    const cast = deepFreeze(castWith({ main: true }));
    const fields = deepFreeze({ descriptor: { zh: '男孩' }, aliases: ['小明'], evidence: [clue(1, '小明')], clusters: ['c9'] });
    const added = addCharacter(cast, fields);
    expect(cast.characters).toHaveLength(1);
    expect(added.cast).not.toBe(cast);
    expect(added.cast.characters).toHaveLength(2);
  });
});

describe('updateCharacter', () => {
  it('changes descriptor, say, main, screenSec, revealAt, spoilerLock, neverName, aliases and clusters', () => {
    const cast = castWith({}, {});
    const next = updateCharacter(cast, 'P2', {
      descriptor: { zh: '长发女人', en: 'woman with long hair' },
      say: 'mǎ xiū',
      main: true,
      screenSec: 300,
      revealAt: 192,
      spoilerLock: true,
      neverName: true,
      aliases: ['小马', { text: 'Matt', lang: 'en' }],
      clusters: ['c1', 'c2'],
    });
    expect(getCharacter(next, 'P2')).toEqual({
      ...EMPTY_CHARACTER,
      id: 'P2',
      descriptor: { zh: '长发女人', en: 'woman with long hair' },
      say: 'mǎ xiū',
      main: true,
      screenSec: 300,
      revealAt: 192,
      spoilerLock: true,
      neverName: true,
      aliases: [{ text: '小马' }, { text: 'Matt', lang: 'en' }],
      clusters: ['c1', 'c2'],
    });
    expect(getCharacter(next, 'P1')).toEqual(getCharacter(cast, 'P1'));
    expect(next.events).toEqual([]);
  });

  it('cannot change the id, the name, the level or the evidence', () => {
    const cast = addEvidence(castWith({}), 'P1', clue(10, '马修'));
    const next = updateCharacter(cast, 'P1', { id: 'P9', name: '老陈', level: 3, evidence: [human('老陈')], main: true });
    expect(getCharacter(next, 'P1')).toMatchObject({ id: 'P1', name: '马修', level: 1, main: true });
    expect(getCharacter(next, 'P1').evidence).toEqual([clue(10, '马修')]);
    expect(getCharacter(next, 'P9')).toBeUndefined();
    // With no evidence to overrule it: a patched name, level or evidence is still not taken.
    const bare = updateCharacter(castWith({}), 'P1', { name: '老陈', level: 3, evidence: [human('老陈')], main: true });
    expect(getCharacter(bare, 'P1')).toMatchObject({ name: null, level: 0, main: true, evidence: [] });
  });

  it('replaces a field as a whole: a new label in one language drops the old one in the other', () => {
    const cast = castWith({ descriptor: { zh: '长发女人', en: 'woman with long hair' }, aliases: ['小马'], clusters: ['c1'] });
    const next = updateCharacter(cast, 'P1', { descriptor: { zh: '短发女人' }, aliases: [], clusters: ['c2'] });
    expect(getCharacter(next, 'P1')).toMatchObject({ descriptor: { zh: '短发女人' }, aliases: [], clusters: ['c2'] });
    expect(getCharacter(next, 'P1').descriptor).toEqual({ zh: '短发女人' });
  });

  it('clears the pronunciation with an empty text or null, and the reveal point with null', () => {
    const cast = castWith({ say: 'mǎ xiū', revealAt: 192 });
    expect('say' in getCharacter(updateCharacter(cast, 'P1', { say: '' }), 'P1')).toBe(false);
    expect('say' in getCharacter(updateCharacter(cast, 'P1', { say: null }), 'P1')).toBe(false);
    expect(getCharacter(updateCharacter(cast, 'P1', { revealAt: null }), 'P1').revealAt).toBeNull();
    expect(getCharacter(updateCharacter(cast, 'P1', { revealAt: '1:02:30' }), 'P1').revealAt).toBe(3750);
    expect(getCharacter(updateCharacter(cast, 'P1', { revealAt: 0 }), 'P1').revealAt).toBe(0);
  });

  it('ignores values of the wrong type', () => {
    const cast = castWith({ descriptor: { zh: '长发女人' }, say: 'mǎ xiū', main: true, screenSec: 300, revealAt: 192, spoilerLock: true, neverName: true, aliases: ['小马'], clusters: ['c1'] });
    const next = updateCharacter(cast, 'P1', {
      descriptor: 'short hair', say: 5, main: 'no', screenSec: -1, revealAt: 'later', spoilerLock: 0, neverName: 'off', aliases: 'Matt', clusters: 'c2',
    });
    expect(getCharacter(next, 'P1')).toEqual(getCharacter(cast, 'P1'));
  });

  it('changes nothing for an unknown id or a patch with nothing in it', () => {
    const cast = castWith({});
    expect(updateCharacter(cast, 'P5', { main: true })).toBe(cast);
    expect(updateCharacter(cast, 'P1', {})).toBe(cast);
    expect(updateCharacter(cast, 'P1', { name: '马修' })).toBe(cast);
    expect(updateCharacter(cast, 'P1', null)).toBe(cast);
    expect(updateCharacter(cast, 'P1')).toBe(cast);
  });

  it('does not change the cast or the patch it is given', () => {
    const cast = deepFreeze(castWith({ descriptor: { zh: '长发女人' }, aliases: ['小马'] }));
    const patch = deepFreeze({ descriptor: { zh: '短发女人' }, aliases: ['阿修'], clusters: ['c1'], main: true });
    const next = updateCharacter(cast, 'P1', patch);
    expect(next).not.toBe(cast);
    expect(getCharacter(cast, 'P1').main).toBe(false);
    expect(getCharacter(next, 'P1').main).toBe(true);
  });
});

describe('levelFromEvidence', () => {
  it('has no name without evidence', () => {
    expect(levelFromEvidence([], GAP)).toEqual({ name: null, level: 0 });
    expect(levelFromEvidence(undefined, GAP)).toEqual({ name: null, level: 0 });
    expect(levelFromEvidence(null)).toEqual({ name: null, level: 0 });
    expect(levelFromEvidence('马修', GAP)).toEqual({ name: null, level: 0 });
    expect(levelFromEvidence([null, 'x', {}, { kind: 'vocative' }, { t: 5, name: '马修' }, { t: 5, kind: 'rumour', name: '马修' }], GAP)).toEqual({ name: null, level: 0 });
  });

  it('gives one clue level 1', () => {
    expect(levelFromEvidence([clue(192, '马修')], GAP)).toEqual({ name: '马修', level: 1 });
    expect(levelFromEvidence([clue(192, 'Matthew', 'credits')], GAP)).toEqual({ name: 'Matthew', level: 1 });
  });

  it('counts two clues of one kind as independent only when they are at least the gap apart', () => {
    expect(levelFromEvidence([clue(10, '马修'), clue(99, '马修')], GAP)).toEqual({ name: '马修', level: 1 });
    expect(levelFromEvidence([clue(10, '马修'), clue(99.9, '马修')], GAP)).toEqual({ name: '马修', level: 1 });
    expect(levelFromEvidence([clue(10, '马修'), clue(100, '马修')], GAP)).toEqual({ name: '马修', level: 2 });
    expect(levelFromEvidence([clue(10, '马修'), clue(5000, '马修')], GAP)).toEqual({ name: '马修', level: 2 });
  });

  it('counts two clues of different kinds as independent however close they are', () => {
    expect(levelFromEvidence([clue(10, '马修', 'vocative'), clue(12, '马修', 'self-intro')], GAP)).toEqual({ name: '马修', level: 2 });
    expect(levelFromEvidence([clue(10, 'Matthew', 'on-screen'), clue(10, 'Matthew', 'third-person')], GAP)).toEqual({ name: 'Matthew', level: 2 });
  });

  it('counts greedily in time order: a clue too close to the first does not block a later one', () => {
    expect(levelFromEvidence([clue(10, '马修'), clue(50, '马修'), clue(100, '马修')], GAP)).toEqual({ name: '马修', level: 2 });
    // Many clues in one scene are one clue.
    expect(levelFromEvidence([clue(10, '马修'), clue(20, '马修'), clue(30, '马修'), clue(95, '马修')], GAP)).toEqual({ name: '马修', level: 1 });
  });

  it('counts a clue only when it is independent of every clue already counted, not just the last', () => {
    // 马修: the third clue is of another kind than the second, but too close to the first of its own kind: two count.
    const two = [clue(0, '马修', 'vocative'), clue(80, '马修', 'self-intro'), clue(85, '马修', 'vocative')];
    // 老陈: three kinds, three clues. More than two, so there is no tie and the name is at level 2.
    const three = [clue(1000, '老陈', 'vocative'), clue(1001, '老陈', 'self-intro'), clue(1002, '老陈', 'credits')];
    expect(levelFromEvidence([...two, ...three], GAP)).toEqual({ name: '老陈', level: 2 });
  });

  it('counts every kind of clue', () => {
    const kinds = ['vocative', 'self-intro', 'third-person', 'on-screen', 'credits'];
    for (const kind of kinds) {
      expect(levelFromEvidence([clue(10, 'Matthew', kind)], GAP)).toEqual({ name: 'Matthew', level: 1 });
      expect(levelFromEvidence([clue(10, 'Matthew', kind), clue(20, 'Matthew', kind)], GAP)).toEqual({ name: 'Matthew', level: 1 });
      for (const other of kinds.filter((k) => k !== kind)) {
        expect(levelFromEvidence([clue(10, 'Matthew', kind), clue(20, 'Matthew', other)], GAP)).toEqual({ name: 'Matthew', level: 2 });
      }
    }
  });

  it('does not depend on the order the clues are listed in', () => {
    const clues = [clue(100, '马修'), clue(50, '老陈'), clue(10, '马修'), clue(60, '老陈', 'self-intro'), clue(70, '马修')];
    const expected = levelFromEvidence([...clues].sort((a, b) => a.t - b.t), GAP);
    expect(levelFromEvidence(clues, GAP)).toEqual(expected);
    expect(levelFromEvidence([...clues].reverse(), GAP)).toEqual(expected);
  });

  it('takes the gap from the options, the default policy\'s when there is none or it is not valid', () => {
    const near = [clue(0, '马修'), clue(40, '马修')];
    expect(levelFromEvidence(near, { independentGapSec: 30 }).level).toBe(2);
    expect(levelFromEvidence(near, { independentGapSec: 41 }).level).toBe(1);
    expect(levelFromEvidence([clue(5, '马修'), clue(5, '马修', 'vocative', { quote: 'again' })], { independentGapSec: 0 }).level).toBe(2);
    const edge = [clue(0, '马修'), clue(DEFAULT_POLICY.independentGapSec, '马修')];
    const inside = [clue(0, '马修'), clue(DEFAULT_POLICY.independentGapSec - 1, '马修')];
    for (const options of [undefined, null, {}, { independentGapSec: NaN }, { independentGapSec: -1 }, { independentGapSec: '5' }]) {
      expect(levelFromEvidence(edge, options).level).toBe(2);
      expect(levelFromEvidence(inside, options).level).toBe(1);
    }
  });

  it('does not count rejected clues', () => {
    expect(levelFromEvidence([clue(10, '马修', 'vocative', { rejected: true }), clue(200, '马修')], GAP)).toEqual({ name: '马修', level: 1 });
    expect(levelFromEvidence([clue(10, '马修', 'vocative', { rejected: true }), clue(200, '马修', 'self-intro', { rejected: true })], GAP)).toEqual({ name: null, level: 0 });
    expect(levelFromEvidence([clue(10, '马修', 'vocative', { rejected: true }), clue(20, '老陈')], GAP)).toEqual({ name: '老陈', level: 1 });
  });

  it('gives the name with most independent clues', () => {
    const matthew = [clue(0, '马修'), clue(5, '马修', 'self-intro'), clue(7000, '马修', 'credits')];
    const chen = [clue(10, '老陈'), clue(200, '老陈')];
    expect(levelFromEvidence([...matthew, ...chen], GAP)).toEqual({ name: '马修', level: 2 });
    expect(levelFromEvidence([...chen, ...matthew], GAP)).toEqual({ name: '马修', level: 2 });
    expect(levelFromEvidence([clue(300, 'Matthew'), clue(10, 'Chen'), clue(400, 'Matthew')], GAP)).toEqual({ name: 'Matthew', level: 2 });
    expect(levelFromEvidence([clue(0, '马修'), clue(10, '老陈'), clue(200, '老陈')], GAP)).toEqual({ name: '老陈', level: 2 });
  });

  it('settles a tie at level 1 with the name evidenced earlier', () => {
    expect(levelFromEvidence([clue(50, '马修'), clue(10, '老陈')], GAP)).toEqual({ name: '老陈', level: 1 });
    expect(levelFromEvidence([clue(10, '马修'), clue(50, '老陈')], GAP)).toEqual({ name: '马修', level: 1 });
    // Two clues each: still a tie, and a tie is never level 2.
    const tied = [clue(50, 'Matthew'), clue(60, 'Matthew', 'self-intro'), clue(10, 'Chen'), clue(20, 'Chen', 'self-intro')];
    expect(levelFromEvidence(tied, GAP)).toEqual({ name: 'Chen', level: 1 });
    // Three names, the first and the last tied.
    const three = [clue(5, '甲'), clue(6, '甲', 'on-screen'), clue(7, '乙'), clue(8, '丙'), clue(9, '丙', 'credits')];
    expect(levelFromEvidence(three, GAP)).toEqual({ name: '甲', level: 1 });
    // Listed first wins when the two names are first evidenced at the same moment.
    expect(levelFromEvidence([clue(10, '马修'), clue(10, '老陈')], GAP)).toEqual({ name: '马修', level: 1 });
  });

  it('lets a confirmation by a person win over any number of clues', () => {
    const clues = [clue(0, '老陈'), clue(5, '老陈', 'self-intro'), clue(7000, '老陈', 'credits')];
    expect(levelFromEvidence([...clues, human('马修', { by: 'ear' })], GAP)).toEqual({ name: '马修', level: 3 });
    expect(levelFromEvidence([human('马修', { by: 'sight' }), ...clues], GAP)).toEqual({ name: '马修', level: 3 });
    expect(levelFromEvidence([human('Matthew')], GAP)).toEqual({ name: 'Matthew', level: 3 });
  });

  it('takes the confirmation made last, whatever its time in the film', () => {
    expect(levelFromEvidence([human('马修', { t: 10 }), human('马秀', { t: 20 })], GAP)).toEqual({ name: '马秀', level: 3 });
    expect(levelFromEvidence([human('马修', { t: 3000 }), human('马秀', { t: 20 })], GAP)).toEqual({ name: '马秀', level: 3 });
    expect(levelFromEvidence([human('马秀', { t: 20 }), human('马修', { t: 10 })], GAP)).toEqual({ name: '马修', level: 3 });
  });

  it('ignores a rejected confirmation', () => {
    expect(levelFromEvidence([human('马修', { rejected: true })], GAP)).toEqual({ name: null, level: 0 });
    expect(levelFromEvidence([human('马修', { rejected: true }), clue(10, '老陈')], GAP)).toEqual({ name: '老陈', level: 1 });
    expect(levelFromEvidence([human('马修'), human('马秀', { rejected: true })], GAP)).toEqual({ name: '马修', level: 3 });
  });

  it('treats spellings that differ in case, width or spacing as one name, and gives the earlier spelling', () => {
    expect(levelFromEvidence([clue(7000, 'MATTHEW', 'credits'), clue(100, 'Matthew', 'vocative')], GAP)).toEqual({ name: 'Matthew', level: 2 });
    expect(levelFromEvidence([clue(100, 'Ｍａｔｔｈｅｗ', 'on-screen'), clue(200, 'matthew', 'vocative')], GAP)).toEqual({ name: 'Ｍａｔｔｈｅｗ', level: 2 });
    expect(levelFromEvidence([clue(100, 'Mary  Ann', 'vocative'), clue(101, ' mary ann ', 'self-intro')], GAP)).toEqual({ name: 'Mary Ann', level: 2 });
    // Two different names stay two names.
    expect(levelFromEvidence([clue(100, '马修'), clue(300, '马秀')], GAP)).toEqual({ name: '马修', level: 1 });
  });

  it('does not change the evidence it is given', () => {
    const evidence = deepFreeze([clue(100, '马修'), clue(10, '马修', 'self-intro'), human('老陈', { rejected: true })]);
    expect(levelFromEvidence(evidence, deepFreeze({ independentGapSec: 90 }))).toEqual({ name: '马修', level: 2 });
    expect(evidence.map((e) => e.t)).toEqual([100, 10, 0]);
  });
});

describe('addEvidence', () => {
  it('appends the clue and sets name, level and the reveal point', () => {
    const cast = castWith({}, {});
    const first = addEvidence(cast, 'P2', clue(192, '马修', 'vocative', { quote: '马修，等等' }));
    expect(getCharacter(first, 'P2')).toMatchObject({ name: '马修', level: 1, revealAt: 192 });
    expect(getCharacter(first, 'P2').evidence).toEqual([{ t: 192, kind: 'vocative', name: '马修', quote: '马修，等等' }]);
    const second = addEvidence(first, 'P2', clue(400, '马修', 'self-intro', { quote: '我叫马修' }));
    expect(getCharacter(second, 'P2')).toMatchObject({ name: '马修', level: 2, revealAt: 192 });
    expect(getCharacter(second, 'P2').evidence).toHaveLength(2);
    expect(getCharacter(second, 'P1')).toEqual(getCharacter(cast, 'P1'));
    expect(second.events).toEqual([]);
  });

  it('works the same in English', () => {
    let cast = castWith({});
    cast = addEvidence(cast, 'P1', clue(30, 'Matthew', 'vocative', { quote: 'Matthew, wait!' }));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: 'Matthew', level: 1, revealAt: 30 });
    cast = addEvidence(cast, 'P1', clue(60, 'Matthew', 'vocative'));
    expect(getCharacter(cast, 'P1').level).toBe(1);
    cast = addEvidence(cast, 'P1', clue(120, 'MATTHEW', 'on-screen'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: 'Matthew', level: 2 });
  });

  it('uses the gap of the cast\'s policy', () => {
    const add = (cast) => addEvidence(addEvidence(cast, 'P1', clue(10, '马修')), 'P1', clue(60, '马修'));
    expect(getCharacter(add(castWith({})), 'P1').level).toBe(1);
    const quick = addCharacter(createCast({ policy: { independentGapSec: 30 } })).cast;
    expect(getCharacter(add(quick), 'P1').level).toBe(2);
  });

  it('changes the name when another name gathers more clues', () => {
    let cast = castWith({});
    cast = addEvidence(cast, 'P1', clue(10, '马特'));
    cast = addEvidence(cast, 'P1', clue(500, '马修'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马特', level: 1 });
    cast = addEvidence(cast, 'P1', clue(700, '马修', 'self-intro'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 2 });
  });

  it('sets the reveal point only when it is null', () => {
    const kept = addEvidence(updateCharacter(castWith({}), 'P1', { revealAt: 50 }), 'P1', clue(192, '马修'));
    expect(getCharacter(kept, 'P1').revealAt).toBe(50);
    // Once set it stays, also when a clue from earlier in the film is added later.
    const later = addEvidence(addEvidence(castWith({}), 'P1', clue(192, '马修')), 'P1', clue(20, '马修', 'self-intro'));
    expect(getCharacter(later, 'P1').revealAt).toBe(192);
    // Null with clues already there: the earliest of them all.
    const born = castWith({ evidence: [clue(300, '马修')] });
    expect(getCharacter(born, 'P1').revealAt).toBeNull();
    expect(getCharacter(addEvidence(born, 'P1', clue(100, '马修', 'self-intro')), 'P1').revealAt).toBe(100);
    expect(getCharacter(addEvidence(born, 'P1', clue(900, '马修', 'self-intro')), 'P1').revealAt).toBe(300);
  });

  it('lets a reveal point a clue set follow the name that stands', () => {
    const at = (cast) => getCharacter(cast, 'P1').revealAt;
    // The only clue is refused: its time is no reveal point any more, and the next clue sets it.
    let cast = addEvidence(castWith({ spoilerLock: true }), 'P1', clue(100, 'Bob'));
    expect(at(cast)).toBe(100);
    cast = rejectName(cast, 'P1', 'Bob');
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: null, level: 0, revealAt: null, spoilerLock: true });
    cast = addEvidence(cast, 'P1', clue(4000, 'Vader', 'self-intro'));
    expect(at(cast)).toBe(4000);
    cast = confirmName(cast, 'P1', { name: 'Vader', by: 'sight' });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: 'Vader', level: 3, revealAt: 4000 });

    // No refusal: another name is confirmed, and the point moves to that name's first clue.
    let other = addEvidence(addEvidence(castWith({}), 'P1', clue(100, 'Bob')), 'P1', clue(4000, 'Vader', 'self-intro'));
    expect(getCharacter(other, 'P1')).toMatchObject({ name: 'Bob', revealAt: 100 });
    other = confirmName(other, 'P1', { name: 'Vader', by: 'sight' });
    expect(getCharacter(other, 'P1')).toMatchObject({ name: 'Vader', revealAt: 4000 });

    // Another name gathers more clues.
    let more = addEvidence(addEvidence(castWith({}), 'P1', clue(100, 'Bob')), 'P1', clue(4000, 'Vader'));
    expect(at(more)).toBe(100);
    more = addEvidence(more, 'P1', clue(4200, 'Vader', 'self-intro'));
    expect(getCharacter(more, 'P1')).toMatchObject({ name: 'Vader', level: 2, revealAt: 4000 });

    // A clue for another name that arrives after a confirmation sets no reveal point.
    let late = confirmName(castWith({ spoilerLock: true }), 'P1', { name: 'Vader', by: 'sight' });
    late = addEvidence(late, 'P1', clue(100, 'Bob'));
    expect(getCharacter(late, 'P1')).toMatchObject({ name: 'Vader', revealAt: null });
    expect(at(addEvidence(late, 'P1', clue(4000, 'Vader')))).toBe(4000);

    // A point that stayed at a later clue of the refused name goes with the name too.
    let stayed = addEvidence(addEvidence(castWith({}), 'P1', clue(192, 'Bob')), 'P1', clue(20, 'Bob', 'self-intro'));
    expect(at(stayed)).toBe(192);
    stayed = rejectName(stayed, 'P1', 'Bob');
    expect(at(stayed)).toBeNull();
    stayed = confirmName(addEvidence(stayed, 'P1', clue(4000, 'Vader')), 'P1', { name: 'Vader', by: 'ear' });
    expect(at(stayed)).toBe(4000);
  });

  it('never moves a reveal point a person set', () => {
    let cast = updateCharacter(castWith({}), 'P1', { revealAt: 50 });
    cast = addEvidence(cast, 'P1', clue(100, 'Bob'));
    cast = rejectName(cast, 'P1', 'Bob');
    expect(getCharacter(cast, 'P1').revealAt).toBe(50);
    cast = confirmName(addEvidence(cast, 'P1', clue(4000, 'Vader')), 'P1', { name: 'Vader', by: 'ear' });
    expect(getCharacter(cast, 'P1').revealAt).toBe(50);
    // Nor do the changes that leave the evidence alone.
    const set = addEvidence(castWith({}), 'P1', clue(100, 'Bob'));
    expect(getCharacter(neverName(updateCharacter(set, 'P1', { main: true }), 'P1'), 'P1').revealAt).toBe(100);
  });

  it('adds the same clue once', () => {
    const once = addEvidence(castWith({}), 'P1', clue(192, '马修', 'vocative', { quote: '马修，等等' }));
    expect(addEvidence(once, 'P1', clue(192, '马修', 'vocative', { quote: '马修，等等' }))).toBe(once);
    expect(addEvidence(once, 'P1', clue(192, ' 马修 ', 'vocative', { line: '马修，等等' }))).toBe(once);
    // Another line at the same moment is another clue.
    expect(getCharacter(addEvidence(once, 'P1', clue(192, '马修', 'vocative', { quote: '马修！' })), 'P1').evidence).toHaveLength(2);
  });

  it('changes nothing for evidence it cannot use or a character it does not know', () => {
    const cast = castWith({});
    for (const bad of [null, undefined, 'x', {}, { t: 5, kind: 'vocative' }, { t: 5, kind: 'rumour', name: '马修' }, { kind: 'vocative', name: '马修' }, { t: 'soon', kind: 'vocative', name: '马修' }]) {
      expect(addEvidence(cast, 'P1', bad)).toBe(cast);
    }
    expect(addEvidence(cast, 'P7', clue(5, '马修'))).toBe(cast);
    expect(() => addEvidence(null, 'P1', clue(5, '马修'))).toThrow('bad-cast');
  });

  it('keeps a clue that comes in rejected, without counting it', () => {
    const cast = addEvidence(castWith({}), 'P1', clue(10, '马修', 'vocative', { rejected: true }));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: null, level: 0, revealAt: null });
    expect(getCharacter(cast, 'P1').evidence).toEqual([{ t: 10, kind: 'vocative', name: '马修', rejected: true }]);
  });

  it('does not let later clues bring back a name a person rejected', () => {
    let cast = addEvidence(castWith({}), 'P1', clue(10, '马修'));
    cast = rejectName(cast, 'P1', '马修');
    cast = addEvidence(cast, 'P1', clue(500, '马修', 'self-intro'));
    cast = addEvidence(cast, 'P1', clue(900, '马修', 'credits'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: null, level: 0 });
    expect(getCharacter(cast, 'P1').evidence.map((e) => e.rejected)).toEqual([true, true, true]);
    // Other names are still heard.
    cast = addEvidence(cast, 'P1', clue(950, '老陈'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '老陈', level: 1 });
    // The person changes their mind: from then on the clues count again.
    cast = confirmName(cast, 'P1', { name: '马修', by: 'sight', t: 1000 });
    cast = addEvidence(cast, 'P1', clue(1200, '马修', 'on-screen'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(getCharacter(cast, 'P1').evidence.at(-1)).toEqual({ t: 1200, kind: 'on-screen', name: '马修' });
  });

  it('takes an entry of kind human as a confirmation', () => {
    const cast = addEvidence(addEvidence(castWith({}), 'P1', clue(10, '老陈')), 'P1', { t: 40, kind: 'human', by: 'sight', name: '马修' });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(cast.events).toEqual([{ type: 'confirm', char: 'P1', name: '马修', by: 'sight', t: 40 }]);
  });

  it('does not change the cast or the evidence it is given', () => {
    const cast = deepFreeze(addEvidence(castWith({}), 'P1', clue(10, '马修')));
    const evidence = deepFreeze(clue(300, '马修', 'self-intro', { quote: '我叫马修' }));
    const next = addEvidence(cast, 'P1', evidence);
    expect(getCharacter(cast, 'P1').evidence).toHaveLength(1);
    expect(getCharacter(cast, 'P1').level).toBe(1);
    expect(getCharacter(next, 'P1').level).toBe(2);
  });
});

describe('confirmName', () => {
  it('adds a confirmation by a person and puts the name at level 3', () => {
    const cast = confirmName(castWith({}), 'P1', { name: '马修', by: 'ear', t: 300 });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: LEVEL.CONFIRMED });
    expect(getCharacter(cast, 'P1').evidence).toEqual([{ t: 300, kind: 'human', by: 'ear', name: '马修' }]);
    const english = confirmName(castWith({}), 'P1', { name: 'Matthew', by: 'sight', t: 12 });
    expect(getCharacter(english, 'P1')).toMatchObject({ name: 'Matthew', level: 3 });
    expect(getCharacter(english, 'P1').evidence).toEqual([{ t: 12, kind: 'human', by: 'sight', name: 'Matthew' }]);
  });

  it('wins over clues, those already there and those that come later', () => {
    let cast = castWith({});
    cast = addEvidence(cast, 'P1', clue(10, '老陈'));
    cast = addEvidence(cast, 'P1', clue(200, '老陈', 'self-intro'));
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 250 });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    cast = addEvidence(cast, 'P1', clue(400, '老陈', 'on-screen'));
    cast = addEvidence(cast, 'P1', clue(7000, '老陈', 'credits'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(getCharacter(cast, 'P1').evidence).toHaveLength(5);
  });

  it('renames: a later confirmation replaces an earlier one', () => {
    let cast = confirmName(castWith({}), 'P1', { name: '马修', by: 'ear', t: 300 });
    cast = confirmName(cast, 'P1', { name: '马秀', by: 'sight', t: 900 });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马秀', level: 3 });
    expect(getCharacter(cast, 'P1').evidence.map((e) => e.name)).toEqual(['马修', '马秀']);
    // Also when the person had gone back in the film to do it.
    cast = confirmName(cast, 'P1', { name: '玛修', by: 'sight', t: 5 });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '玛修', level: 3 });
    // And back to a name confirmed before.
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 5 });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
  });

  it('does not set a reveal point: a person\'s word is not a clue in the film', () => {
    const cast = confirmName(castWith({}), 'P1', { name: '马修', by: 'ear', t: 300 });
    expect(getCharacter(cast, 'P1').revealAt).toBeNull();
  });

  it('records the confirmation with the time passed in', () => {
    let cast = confirmName(castWith({}), 'P1', { name: '马修', by: 'ear', t: 300 });
    cast = confirmName(cast, 'P1', { name: '马秀', by: 'sight', t: 900 });
    expect(cast.events).toEqual([
      { type: 'confirm', char: 'P1', name: '马修', by: 'ear', t: 300 },
      { type: 'confirm', char: 'P1', name: '马秀', by: 'sight', t: 900 },
    ]);
  });

  it('accepts a confirmation that does not say how or when', () => {
    const cast = confirmName(castWith({}), 'P1', { name: '马修', by: 'telepathy' });
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(getCharacter(cast, 'P1').evidence).toEqual([{ t: 0, kind: 'human', name: '马修' }]);
    expect(cast.events).toEqual([{ type: 'confirm', char: 'P1', name: '马修', by: null, t: null }]);
  });

  it('changes nothing without a name or for an unknown character', () => {
    const cast = castWith({});
    expect(confirmName(cast, 'P1', { name: '  ', by: 'ear', t: 1 })).toBe(cast);
    expect(confirmName(cast, 'P1', { by: 'ear', t: 1 })).toBe(cast);
    expect(confirmName(cast, 'P1')).toBe(cast);
    expect(confirmName(cast, 'P1', null)).toBe(cast);
    expect(confirmName(cast, 'P9', { name: '马修', by: 'ear', t: 1 })).toBe(cast);
  });

  it('drops the pronunciation when the name changes, and keeps it when only the spelling\'s case does', () => {
    let cast = confirmName(castWith({}), 'P1', { name: 'matthew', by: 'ear', t: 1 });
    cast = updateCharacter(cast, 'P1', { say: 'MATH-yoo' });
    const recased = confirmName(cast, 'P1', { name: 'Matthew', by: 'ear', t: 2 });
    expect(getCharacter(recased, 'P1')).toMatchObject({ name: 'Matthew', say: 'MATH-yoo' });
    const renamed = confirmName(cast, 'P1', { name: 'Mathieu', by: 'ear', t: 2 });
    expect(getCharacter(renamed, 'P1').name).toBe('Mathieu');
    expect('say' in getCharacter(renamed, 'P1')).toBe(false);
  });

  it('does not change the cast it is given', () => {
    const cast = deepFreeze(addEvidence(castWith({}), 'P1', clue(10, '老陈')));
    const next = confirmName(cast, 'P1', deepFreeze({ name: '马修', by: 'ear', t: 20 }));
    expect(getCharacter(cast, 'P1').name).toBe('老陈');
    expect(cast.events).toEqual([]);
    expect(getCharacter(next, 'P1').name).toBe('马修');
  });
});

describe('rejectName', () => {
  it('marks every entry for the name rejected and works the name out again', () => {
    let cast = castWith({});
    cast = addEvidence(cast, 'P1', clue(10, '马修'));
    cast = addEvidence(cast, 'P1', clue(20, '马修', 'self-intro'));
    cast = addEvidence(cast, 'P1', clue(30, '老陈'));
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 2 });
    const next = rejectName(cast, 'P1', '马修');
    expect(getCharacter(next, 'P1')).toMatchObject({ name: '老陈', level: 1 });
    expect(getCharacter(next, 'P1').evidence).toEqual([
      { t: 10, kind: 'vocative', name: '马修', rejected: true },
      { t: 20, kind: 'self-intro', name: '马修', rejected: true },
      { t: 30, kind: 'vocative', name: '老陈' },
    ]);
  });

  it('undoes a person\'s own confirmation of that name', () => {
    const confirmed = confirmName(castWith({}), 'P1', { name: '马修', by: 'ear', t: 300 });
    const next = rejectName(confirmed, 'P1', '马修');
    expect(getCharacter(next, 'P1')).toMatchObject({ name: null, level: 0 });
    expect(getCharacter(next, 'P1').evidence).toEqual([{ t: 300, kind: 'human', by: 'ear', name: '马修', rejected: true }]);
  });

  it('falls back to what is left: the clues, or an earlier confirmation of another name', () => {
    let cast = addEvidence(castWith({}), 'P1', clue(10, '老陈'));
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 300 });
    expect(getCharacter(rejectName(cast, 'P1', '马修'), 'P1')).toMatchObject({ name: '老陈', level: 1 });

    let renamed = confirmName(castWith({}), 'P1', { name: 'Matthew', by: 'sight', t: 10 });
    renamed = confirmName(renamed, 'P1', { name: 'Mathieu', by: 'ear', t: 20 });
    expect(getCharacter(rejectName(renamed, 'P1', 'Mathieu'), 'P1')).toMatchObject({ name: 'Matthew', level: 3 });
  });

  it('rejects a name whatever its case or width', () => {
    let cast = addEvidence(castWith({}), 'P1', clue(10, 'Matthew'));
    cast = addEvidence(cast, 'P1', clue(7000, 'MATTHEW', 'credits'));
    const next = rejectName(cast, 'P1', ' ｍａｔｔｈｅｗ ');
    expect(getCharacter(next, 'P1')).toMatchObject({ name: null, level: 0 });
    expect(getCharacter(next, 'P1').evidence.every((e) => e.rejected === true)).toBe(true);
  });

  it('records the rejection, with the time when one is passed in', () => {
    const cast = addEvidence(castWith({}), 'P1', clue(10, '马修'));
    expect(rejectName(cast, 'P1', '马修', { t: 44 }).events).toEqual([{ type: 'reject', char: 'P1', name: '马修', t: 44 }]);
    expect(rejectName(cast, 'P1', '马修').events).toEqual([{ type: 'reject', char: 'P1', name: '马修', t: null }]);
    expect(rejectName(cast, 'P1', '马修', null).events).toEqual([{ type: 'reject', char: 'P1', name: '马修', t: null }]);
  });

  it('changes nothing for a name the character does not have, an empty name or an unknown character', () => {
    const cast = addEvidence(castWith({}), 'P1', clue(10, '马修'));
    expect(rejectName(cast, 'P1', '老陈')).toBe(cast);
    expect(rejectName(cast, 'P1', '')).toBe(cast);
    expect(rejectName(cast, 'P1', undefined)).toBe(cast);
    expect(rejectName(cast, 'P4', '马修')).toBe(cast);
    const once = rejectName(cast, 'P1', '马修');
    expect(rejectName(once, 'P1', '马修')).toBe(once);
  });

  it('takes away a name carried without evidence, and writes the refusal down so it lasts', () => {
    const carried = castWith({ name: '马修', level: 2 });
    const next = rejectName(carried, 'P1', '马修', { t: 70 });
    expect(getCharacter(next, 'P1')).toMatchObject({ name: null, level: 0 });
    expect(getCharacter(next, 'P1').evidence).toEqual([{ t: 70, kind: 'human', name: '马修', rejected: true }]);
    expect(getCharacter(addEvidence(next, 'P1', clue(100, '马修')), 'P1')).toMatchObject({ name: null, level: 0 });

    const fromPackage = validateCast({ characters: [{ id: 'P1', name: 'Matthew', level: 3, confirmedBy: 'sight' }] });
    expect(getCharacter(rejectName(fromPackage, 'P1', 'Matthew'), 'P1')).toMatchObject({ name: null, level: 0 });
  });

  it('does not change the cast it is given', () => {
    const cast = deepFreeze(confirmName(addEvidence(castWith({}), 'P1', clue(10, '马修')), 'P1', { name: '马修', by: 'ear', t: 20 }));
    const next = rejectName(cast, 'P1', '马修');
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(getCharacter(cast, 'P1').evidence.some((e) => e.rejected)).toBe(false);
    expect(getCharacter(next, 'P1').name).toBeNull();
  });
});

describe('neverName', () => {
  it('marks a character as never to be named, and takes that back', () => {
    const cast = confirmName(castWith({}, {}), 'P2', { name: '马修', by: 'ear', t: 1 });
    const on = neverName(cast, 'P2');
    expect(getCharacter(on, 'P2')).toMatchObject({ neverName: true, name: '马修', level: 3 });
    expect(getCharacter(on, 'P1').neverName).toBe(false);
    expect(getCharacter(neverName(cast, 'P2', true), 'P2').neverName).toBe(true);
    const off = neverName(on, 'P2', false);
    expect(getCharacter(off, 'P2').neverName).toBe(false);
  });

  it('records each change, with the time when one is passed in', () => {
    const on = neverName(castWith({}), 'P1', true, { t: 61 });
    const off = neverName(on, 'P1', false);
    expect(off.events).toEqual([
      { type: 'neverName', char: 'P1', on: true, t: 61 },
      { type: 'neverName', char: 'P1', on: false, t: null },
    ]);
  });

  it('changes nothing when it is already so, or for an unknown character', () => {
    const cast = castWith({});
    expect(neverName(cast, 'P1', false)).toBe(cast);
    expect(neverName(cast, 'P3')).toBe(cast);
    const on = neverName(cast, 'P1');
    expect(neverName(on, 'P1')).toBe(on);
    expect(neverName(on, 'P1', true, { t: 5 })).toBe(on);
  });

  it('does not change the cast it is given', () => {
    const cast = deepFreeze(castWith({}));
    expect(getCharacter(neverName(cast, 'P1'), 'P1').neverName).toBe(true);
    expect(getCharacter(cast, 'P1').neverName).toBe(false);
  });
});

describe('mergeCharacters', () => {
  /** P1 and P2 are one woman seen in two clusters; P3 is somebody else. */
  function twoClusters() {
    let cast = castWith(
      { descriptor: { zh: '长发女人' }, clusters: ['c1'], aliases: ['小马'], screenSec: 100 },
      { descriptor: { zh: '盘发女人', en: 'woman with her hair up' }, clusters: ['c2', 'c1'], aliases: ['Matt', '小马'], screenSec: 50.5, main: true },
      { descriptor: { zh: '戴眼镜的男人' }, clusters: ['c3'], screenSec: 80 },
    );
    cast = addEvidence(cast, 'P1', clue(10, '马修'));
    cast = addEvidence(cast, 'P2', clue(20, '马修', 'self-intro', { quote: '我叫马修' }));
    cast = addEvidence(cast, 'P3', clue(30, '老陈'));
    cast = setAppearance(cast, { char: 'P1', from: 0, outfit: '红裙子', src: 'model' });
    cast = setAppearance(cast, { char: 'P2', from: 600, outfit: '灰大衣', src: 'model' });
    cast = setAppearance(cast, { char: 'P3', from: 5, outfit: '黑夹克', src: 'model' });
    return cast;
  }

  it('moves evidence, aliases, clusters and appearances to the kept character and removes the other', () => {
    const before = twoClusters();
    const { cast, remap } = mergeCharacters(before, 'P1', 'P2');
    expect(remap).toEqual({ P2: 'P1' });
    expect(cast.characters.map((c) => c.id)).toEqual(['P1', 'P3']);
    expect(getCharacter(cast, 'P2')).toBeUndefined();
    expect(getCharacter(cast, 'P1')).toEqual({
      id: 'P1',
      // Two clues of different kinds, one from each side: now level 2.
      name: '马修',
      level: 2,
      aliases: [{ text: '小马' }, { text: 'Matt' }],
      descriptor: { zh: '长发女人', en: 'woman with her hair up' },
      revealAt: 10,
      spoilerLock: false,
      neverName: false,
      main: true,
      screenSec: 150.5,
      evidence: [
        { t: 10, kind: 'vocative', name: '马修' },
        { t: 20, kind: 'self-intro', name: '马修', quote: '我叫马修' },
      ],
      clusters: ['c1', 'c2'],
    });
    expect(cast.appearances).toEqual([
      { char: 'P1', from: 0, to: 600, outfit: '红裙子', src: 'model' },
      { char: 'P3', from: 5, to: null, outfit: '黑夹克', src: 'model' },
      { char: 'P1', from: 600, to: null, outfit: '灰大衣', src: 'model' },
    ]);
    expect(getCharacter(cast, 'P3')).toEqual(getCharacter(before, 'P3'));
  });

  it('keeps the kept character\'s place and the other way round gives the other id', () => {
    const { cast, remap } = mergeCharacters(twoClusters(), 'P2', 'P1');
    expect(remap).toEqual({ P1: 'P2' });
    expect(cast.characters.map((c) => c.id)).toEqual(['P2', 'P3']);
    expect(getCharacter(cast, 'P2')).toMatchObject({ name: '马修', level: 2, screenSec: 150.5, main: true, clusters: ['c2', 'c1'] });
    expect(getCharacter(cast, 'P2').descriptor).toEqual({ zh: '盘发女人', en: 'woman with her hair up' });
    expect(appearanceAt(cast, 'P2', 100).outfit).toBe('红裙子');
    expect(appearanceAt(cast, 'P2', 700).outfit).toBe('灰大衣');
    expect(appearanceAt(cast, 'P1', 100)).toBeNull();
  });

  it('records the merge, with the time when one is passed in', () => {
    expect(mergeCharacters(twoClusters(), 'P1', 'P2', { t: 77 }).cast.events).toEqual([{ type: 'merge', keep: 'P1', drop: 'P2', t: 77 }]);
    expect(mergeCharacters(twoClusters(), 'P1', 'P2').cast.events).toEqual([{ type: 'merge', keep: 'P1', drop: 'P2', t: null }]);
  });

  it('lets a confirmed name on the dropped side survive', () => {
    let cast = castWith({}, {});
    cast = addEvidence(cast, 'P1', clue(10, '马特'));
    cast = confirmName(cast, 'P2', { name: '马修', by: 'sight', t: 50 });
    const merged = mergeCharacters(cast, 'P1', 'P2').cast;
    expect(getCharacter(merged, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(exportCast(merged).characters[0].confirmedBy).toBe('sight');
  });

  it('lets a confirmed name on the kept side survive', () => {
    let cast = castWith({}, {});
    cast = confirmName(cast, 'P1', { name: 'Matthew', by: 'ear', t: 50 });
    cast = addEvidence(cast, 'P2', clue(10, 'Chen'));
    cast = addEvidence(cast, 'P2', clue(20, 'Chen', 'self-intro'));
    expect(getCharacter(mergeCharacters(cast, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: 'Matthew', level: 3 });
  });

  it('lets the kept side win when both names are confirmed', () => {
    let cast = castWith({}, {});
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 50 });
    cast = confirmName(cast, 'P2', { name: '老陈', by: 'sight', t: 900 });
    expect(getCharacter(mergeCharacters(cast, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(getCharacter(mergeCharacters(cast, 'P2', 'P1').cast, 'P2')).toMatchObject({ name: '老陈', level: 3 });
    // The other confirmation is still there: taking the kept name away brings it up.
    const merged = mergeCharacters(cast, 'P1', 'P2').cast;
    expect(getCharacter(rejectName(merged, 'P1', '马修'), 'P1')).toMatchObject({ name: '老陈', level: 3 });
  });

  it('lets the kept side win a tie between clues first heard at the same moment', () => {
    let cast = castWith({}, {});
    cast = addEvidence(cast, 'P1', clue(10, '马修'));
    cast = addEvidence(cast, 'P2', clue(10, '老陈'));
    expect(getCharacter(mergeCharacters(cast, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: '马修', level: 1 });
    expect(getCharacter(mergeCharacters(cast, 'P2', 'P1').cast, 'P2')).toMatchObject({ name: '老陈', level: 1 });
  });

  it('keeps a name carried without evidence, the kept side\'s first', () => {
    const keptHas = castWith({ name: '马修', level: 2 }, {});
    expect(getCharacter(mergeCharacters(keptHas, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: '马修', level: 2 });
    const droppedHas = castWith({}, { name: '老陈', level: 2 });
    expect(getCharacter(mergeCharacters(droppedHas, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: '老陈', level: 2 });
    const bothHave = castWith({ name: '马修', level: 1 }, { name: '老陈', level: 2 });
    expect(getCharacter(mergeCharacters(bothHave, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: '马修', level: 1 });
    const confirmed = castWith({}, { name: 'Matthew', level: 3 });
    expect(getCharacter(mergeCharacters(confirmed, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: 'Matthew', level: 3 });
  });

  it('carries a refusal over: a name rejected on one side is rejected for the merged character', () => {
    let cast = castWith({}, {});
    cast = addEvidence(cast, 'P1', clue(10, '马修'));
    cast = addEvidence(cast, 'P1', clue(20, '马修', 'self-intro'));
    cast = addEvidence(cast, 'P2', clue(500, '马修'));
    cast = rejectName(cast, 'P2', '马修');
    const merged = mergeCharacters(cast, 'P1', 'P2').cast;
    expect(getCharacter(merged, 'P1')).toMatchObject({ name: null, level: 0 });
    expect(getCharacter(merged, 'P1').evidence.every((e) => e.rejected === true)).toBe(true);
  });

  it('lets a confirmation that stands outweigh a refusal on the other side', () => {
    let cast = castWith({}, {});
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 5 });
    cast = addEvidence(cast, 'P2', clue(500, '马修'));
    cast = rejectName(cast, 'P2', '马修');
    expect(getCharacter(mergeCharacters(cast, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: '马修', level: 3 });
    expect(getCharacter(mergeCharacters(cast, 'P2', 'P1').cast, 'P2')).toMatchObject({ name: '马修', level: 3 });
  });

  it('adds the screen time up and keeps "main" from either side', () => {
    const cast = castWith({ main: true, screenSec: 10 }, { screenSec: 2.5 }, { screenSec: 7 }, { main: true }, {}, {});
    expect(getCharacter(mergeCharacters(cast, 'P1', 'P2').cast, 'P1')).toMatchObject({ main: true, screenSec: 12.5 });
    expect(getCharacter(mergeCharacters(cast, 'P3', 'P4').cast, 'P3')).toMatchObject({ main: true, screenSec: 7 });
    expect(getCharacter(mergeCharacters(cast, 'P5', 'P6').cast, 'P5')).toMatchObject({ main: false, screenSec: 0 });
  });

  it('keeps "never name" and a spoiler lock from either side', () => {
    const cast = castWith({}, { neverName: true, spoilerLock: true }, { neverName: true }, {});
    expect(getCharacter(mergeCharacters(cast, 'P1', 'P2').cast, 'P1')).toMatchObject({ neverName: true, spoilerLock: true });
    expect(getCharacter(mergeCharacters(cast, 'P3', 'P4').cast, 'P3')).toMatchObject({ neverName: true, spoilerLock: false });
    expect(getCharacter(mergeCharacters(cast, 'P1', 'P4').cast, 'P1')).toMatchObject({ neverName: false, spoilerLock: false });
  });

  it('takes the reveal point of the locked side, the later one when both are locked, else the kept side\'s', () => {
    const reveal = (keep, drop) => getCharacter(mergeCharacters(castWith(keep, drop), 'P1', 'P2').cast, 'P1').revealAt;
    expect(reveal({ revealAt: 100 }, { revealAt: 4000, spoilerLock: true })).toBe(4000);
    expect(reveal({ revealAt: 100 }, { revealAt: null, spoilerLock: true })).toBeNull();
    expect(reveal({ revealAt: 4000, spoilerLock: true }, { revealAt: 100 })).toBe(4000);
    expect(reveal({ revealAt: null, spoilerLock: true }, { revealAt: 500 })).toBeNull();
    expect(reveal({ revealAt: 100, spoilerLock: true }, { revealAt: 4000, spoilerLock: true })).toBe(4000);
    expect(reveal({ revealAt: 100, spoilerLock: true }, { revealAt: null, spoilerLock: true })).toBeNull();
    expect(reveal({ revealAt: 100 }, { revealAt: 500 })).toBe(100);
    expect(reveal({ revealAt: null }, { revealAt: 500 })).toBe(500);
    expect(reveal({}, {})).toBeNull();
  });

  it('does not take a reveal point from a clue for a name that lost the merge', () => {
    const merged = (cast) => getCharacter(mergeCharacters(cast, 'P1', 'P2').cast, 'P1');
    // The kept side has a clue for Bob, the dropped side the confirmed name with its own clue.
    let cast = addEvidence(castWith({}, {}), 'P1', clue(100, 'Bob'));
    cast = confirmName(addEvidence(cast, 'P2', clue(4000, 'Vader', 'self-intro')), 'P2', { name: 'Vader', by: 'sight' });
    expect(cast.characters.map((c) => c.revealAt)).toEqual([100, 4000]);
    expect(merged(cast)).toMatchObject({ name: 'Vader', level: 3, revealAt: 4000 });

    // A secret on the kept side, whose only clue is for a name the other side refused.
    let locked = addEvidence(castWith({ spoilerLock: true }, {}), 'P1', clue(100, 'Bob'));
    locked = rejectName(addEvidence(locked, 'P2', clue(150, 'Bob')), 'P2', 'Bob');
    locked = confirmName(locked, 'P2', { name: 'Vader', by: 'sight' });
    expect(merged(locked)).toMatchObject({ name: 'Vader', level: 3, spoilerLock: true, revealAt: null });
    expect(merged(addEvidence(locked, 'P2', clue(4000, 'Vader')))).toMatchObject({ name: 'Vader', revealAt: 4000 });

    // The name confirmed without a clue of its own: the other side's clue reveals nothing.
    let bare = addEvidence(castWith({}, {}), 'P2', clue(500, 'Bob'));
    bare = confirmName(bare, 'P1', { name: 'Vader', by: 'ear' });
    expect(merged(bare)).toMatchObject({ name: 'Vader', revealAt: null });
    // A reveal point a person set on either side is kept as before.
    expect(merged(updateCharacter(bare, 'P1', { revealAt: 60 })).revealAt).toBe(60);
  });

  it('keeps the pronunciation of the name that results, and no other', () => {
    let both = castWith({ say: 'mǎ xiū' }, { say: 'lǎo chén' });
    both = confirmName(both, 'P1', { name: '马修', by: 'ear', t: 1 });
    both = updateCharacter(both, 'P1', { say: 'mǎ xiū' });
    both = confirmName(both, 'P2', { name: '老陈', by: 'ear', t: 2 });
    both = updateCharacter(both, 'P2', { say: 'lǎo chén' });
    expect(getCharacter(mergeCharacters(both, 'P1', 'P2').cast, 'P1')).toMatchObject({ name: '马修', say: 'mǎ xiū' });

    // The kept side had only a clue and a pronunciation for it; the dropped side's confirmed name takes over.
    let clueSide = addEvidence(castWith({}, {}), 'P1', clue(10, '马特'));
    clueSide = updateCharacter(clueSide, 'P1', { say: 'mǎ tè' });
    clueSide = confirmName(clueSide, 'P2', { name: '老陈', by: 'ear', t: 2 });
    const noSay = getCharacter(mergeCharacters(clueSide, 'P1', 'P2').cast, 'P1');
    expect(noSay.name).toBe('老陈');
    expect('say' in noSay).toBe(false);
    const withSay = mergeCharacters(updateCharacter(clueSide, 'P2', { say: 'lǎo chén' }), 'P1', 'P2').cast;
    expect(getCharacter(withSay, 'P1')).toMatchObject({ name: '老陈', say: 'lǎo chén' });
  });

  it('keeps the kept character\'s outfit where both start at the same moment', () => {
    let cast = castWith({}, {});
    cast = setAppearance(cast, { char: 'P1', from: 0, outfit: '红裙子', src: 'model' });
    cast = setAppearance(cast, { char: 'P2', from: 0, outfit: '蓝西装', src: 'model' });
    cast = setAppearance(cast, { char: 'P2', from: 300, outfit: '灰大衣', src: 'human' });
    expect(mergeCharacters(cast, 'P1', 'P2').cast.appearances).toEqual([
      { char: 'P1', from: 0, to: 300, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 300, to: null, outfit: '灰大衣', src: 'human' },
    ]);
  });

  it('changes nothing for unknown ids or the same id twice', () => {
    const cast = twoClusters();
    expect(mergeCharacters(cast, 'P1', 'P9')).toEqual({ cast, remap: {} });
    expect(mergeCharacters(cast, 'P9', 'P1')).toEqual({ cast, remap: {} });
    expect(mergeCharacters(cast, 'P1', 'P1')).toEqual({ cast, remap: {} });
    expect(mergeCharacters(cast, 'P1', 'P9').cast).toBe(cast);
    expect(mergeCharacters(cast, 'P1', 'P1').cast).toBe(cast);
    expect(() => mergeCharacters(null, 'P1', 'P2')).toThrow('bad-cast');
  });

  it('does not change the cast it is given', () => {
    const cast = deepFreeze(twoClusters());
    const { cast: merged } = mergeCharacters(cast, 'P1', 'P2', deepFreeze({ t: 3 }));
    expect(cast.characters.map((c) => c.id)).toEqual(['P1', 'P2', 'P3']);
    expect(cast.events).toEqual([]);
    expect(getCharacter(cast, 'P1').screenSec).toBe(100);
    expect(merged.characters).toHaveLength(2);
  });
});

describe('setAppearance', () => {
  const dressed = () => {
    let cast = castWith({}, {});
    cast = setAppearance(cast, { char: 'P1', from: 0, outfit: '红裙子', src: 'model' });
    return setAppearance(cast, { char: 'P1', from: 600, outfit: '灰大衣', src: 'model' });
  };

  it('opens an appearance for a character', () => {
    const cast = setAppearance(castWith({}), { char: 'P1', from: 12, outfit: '红裙子', src: 'model' });
    expect(cast.appearances).toEqual([{ char: 'P1', from: 12, to: null, outfit: '红裙子', src: 'model' }]);
    const english = setAppearance(castWith({}), { char: 'P1', from: 0, outfit: ' a red  dress ', scene: 3, src: 'human' });
    expect(english.appearances).toEqual([{ char: 'P1', from: 0, to: null, outfit: 'a red dress', scene: 3, src: 'human' }]);
  });

  it('closes the open appearance where the new one starts', () => {
    expect(dressed().appearances).toEqual([
      { char: 'P1', from: 0, to: 600, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 600, to: null, outfit: '灰大衣', src: 'model' },
    ]);
  });

  it('ignores a repeat of the outfit current at that time', () => {
    const cast = dressed();
    expect(setAppearance(cast, { char: 'P1', from: 700, outfit: '灰大衣', src: 'model' })).toBe(cast);
    expect(setAppearance(cast, { char: 'P1', from: 600, outfit: ' 灰大衣 ', src: 'human', scene: 9 })).toBe(cast);
    expect(setAppearance(cast, { char: 'P1', from: 300, outfit: '红裙子', src: 'model' })).toBe(cast);
    const english = setAppearance(castWith({}), { char: 'P1', from: 0, outfit: 'a red dress', src: 'model' });
    expect(setAppearance(english, { char: 'P1', from: 50, outfit: 'A Red  Dress', src: 'model' })).toBe(english);
  });

  it('takes a return to an earlier outfit as a change', () => {
    const cast = setAppearance(dressed(), { char: 'P1', from: 900, outfit: '红裙子', src: 'model' });
    expect(cast.appearances.map((a) => [a.from, a.to, a.outfit])).toEqual([[0, 600, '红裙子'], [600, 900, '灰大衣'], [900, null, '红裙子']]);
  });

  it('keeps each character\'s outfits apart', () => {
    const cast = setAppearance(dressed(), { char: 'P2', from: 300, outfit: '黑夹克', src: 'model' });
    expect(cast.appearances).toEqual([
      { char: 'P1', from: 0, to: 600, outfit: '红裙子', src: 'model' },
      { char: 'P2', from: 300, to: null, outfit: '黑夹克', src: 'model' },
      { char: 'P1', from: 600, to: null, outfit: '灰大衣', src: 'model' },
    ]);
    // The same outfit on another character is not a repeat.
    const same = setAppearance(cast, { char: 'P2', from: 800, outfit: '灰大衣', src: 'model' });
    expect(appearanceAt(same, 'P2', 900).outfit).toBe('灰大衣');
    expect(appearanceAt(same, 'P2', 500).outfit).toBe('黑夹克');
  });

  it('fits an outfit reported for an earlier time in before what is already known', () => {
    const late = setAppearance(castWith({}), { char: 'P1', from: 600, outfit: '灰大衣', src: 'model' });
    expect(setAppearance(late, { char: 'P1', from: 0, outfit: '红裙子', src: 'model' }).appearances).toEqual([
      { char: 'P1', from: 0, to: 600, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 600, to: null, outfit: '灰大衣', src: 'model' },
    ]);
    expect(setAppearance(dressed(), { char: 'P1', from: 300, outfit: '蓝西装', src: 'human' }).appearances).toEqual([
      { char: 'P1', from: 0, to: 300, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 300, to: 600, outfit: '蓝西装', src: 'human' },
      { char: 'P1', from: 600, to: null, outfit: '灰大衣', src: 'model' },
    ]);
  });

  it('replaces the appearance that starts at the same moment, and joins on a neighbour in the same outfit', () => {
    const replaced = setAppearance(dressed(), { char: 'P1', from: 600, outfit: '黑大衣', src: 'human' });
    expect(replaced.appearances).toEqual([
      { char: 'P1', from: 0, to: 600, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 600, to: null, outfit: '黑大衣', src: 'human' },
    ]);
    const joined = setAppearance(dressed(), { char: 'P1', from: 300, outfit: '灰大衣', src: 'model' });
    expect(joined.appearances).toEqual([
      { char: 'P1', from: 0, to: 300, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 300, to: null, outfit: '灰大衣', src: 'model' },
    ]);
  });

  it('reads the source, the scene and a time written as text', () => {
    const one = (appearance) => setAppearance(castWith({}), { char: 'P1', from: 0, outfit: '红裙子', ...appearance }).appearances[0];
    expect(one({ src: 'human' }).src).toBe('human');
    expect(one({ src: 'model' }).src).toBe('model');
    expect(one({}).src).toBe('model');
    expect(one({ src: 'camera' }).src).toBe('model');
    expect(one({ scene: 0 }).scene).toBe(0);
    expect('scene' in one({ scene: 'two' })).toBe(false);
    expect('scene' in one({})).toBe(false);
    expect(one({ from: '10:00' }).from).toBe(600);
  });

  it('changes nothing for an unknown character, an empty outfit or a missing time', () => {
    const cast = dressed();
    expect(setAppearance(cast, { char: 'P9', from: 0, outfit: '红裙子', src: 'model' })).toBe(cast);
    expect(setAppearance(cast, { char: 'P2', from: 0, outfit: '   ', src: 'model' })).toBe(cast);
    expect(setAppearance(cast, { char: 'P2', from: 0, src: 'model' })).toBe(cast);
    expect(setAppearance(cast, { char: 'P2', outfit: '红裙子', src: 'model' })).toBe(cast);
    expect(setAppearance(cast, { char: 'P2', from: -5, outfit: '红裙子', src: 'model' })).toBe(cast);
    expect(setAppearance(cast, { char: 'P2', from: NaN, outfit: '红裙子', src: 'model' })).toBe(cast);
    expect(setAppearance(cast, { from: 0, outfit: '红裙子', src: 'model' })).toBe(cast);
    expect(setAppearance(cast)).toBe(cast);
    expect(setAppearance(cast, null)).toBe(cast);
    expect(() => setAppearance(undefined, { char: 'P1', from: 0, outfit: '红裙子' })).toThrow('bad-cast');
  });

  it('does not change the cast or the appearance it is given', () => {
    const cast = deepFreeze(dressed());
    const next = setAppearance(cast, deepFreeze({ char: 'P1', from: 900, outfit: '睡衣', src: 'model' }));
    expect(cast.appearances).toHaveLength(2);
    expect(cast.appearances[1].to).toBeNull();
    expect(next.appearances).toHaveLength(3);
    expect(next.appearances[1].to).toBe(900);
  });
});

describe('appearanceAt', () => {
  let cast = castWith({}, {}, {});
  cast = setAppearance(cast, { char: 'P1', from: 10, outfit: '红裙子', src: 'model' });
  cast = setAppearance(cast, { char: 'P1', from: 600, outfit: '灰大衣', src: 'model' });
  cast = setAppearance(cast, { char: 'P2', from: 300, outfit: '黑夹克', src: 'model' });

  it('is null before the first appearance starts', () => {
    expect(appearanceAt(cast, 'P1', 0)).toBeNull();
    expect(appearanceAt(cast, 'P1', 9.99)).toBeNull();
    expect(appearanceAt(cast, 'P2', 299)).toBeNull();
  });

  it('includes the start and excludes the end', () => {
    expect(appearanceAt(cast, 'P1', 10)).toEqual({ char: 'P1', from: 10, to: 600, outfit: '红裙子', src: 'model' });
    expect(appearanceAt(cast, 'P1', 599.9).outfit).toBe('红裙子');
    expect(appearanceAt(cast, 'P1', 600)).toEqual({ char: 'P1', from: 600, to: null, outfit: '灰大衣', src: 'model' });
  });

  it('stays with an open appearance to the end of the film', () => {
    expect(appearanceAt(cast, 'P1', 99999).outfit).toBe('灰大衣');
    expect(appearanceAt(cast, 'P2', 300).outfit).toBe('黑夹克');
  });

  it('is null after an appearance that was closed with nothing after it', () => {
    const closed = validateCast({ characters: [{ id: 'P1' }], appearances: [{ char: 'P1', from: 10, to: 50, outfit: '睡衣' }] });
    expect(appearanceAt(closed, 'P1', 49).outfit).toBe('睡衣');
    expect(appearanceAt(closed, 'P1', 50)).toBeNull();
    expect(appearanceAt(closed, 'P1', 500)).toBeNull();
  });

  it('is null for a character with no appearance, an unknown one, or a time that is not a number', () => {
    expect(appearanceAt(cast, 'P3', 100)).toBeNull();
    expect(appearanceAt(cast, 'P9', 100)).toBeNull();
    expect(appearanceAt(cast, 'P1', NaN)).toBeNull();
    expect(appearanceAt(cast, 'P1', undefined)).toBeNull();
    expect(appearanceAt(cast, 'P1', '100')).toBeNull();
    expect(appearanceAt(null, 'P1', 100)).toBeNull();
    expect(appearanceAt({}, 'P1', 100)).toBeNull();
  });
});

describe('exportCast', () => {
  const QUOTE = '马修，等等我！';
  const LINE = 'My name is Chen.';

  function fullCast() {
    let cast = createCast({ policy: { naming: 'on-reveal' } });
    ({ cast } = addCharacter(cast, {
      descriptor: { zh: '长发女人', en: 'woman with long hair' },
      main: true,
      screenSec: 2040,
      clusters: ['cluster-12', 'cluster-40'],
      aliases: [{ text: '小马', lang: 'zh', kind: 'nickname', validFrom: 900 }, 'Matt'],
    }));
    ({ cast } = addCharacter(cast, { descriptor: { zh: '戴眼镜的男人' }, clusters: ['cluster-7'], spoilerLock: true }));
    ({ cast } = addCharacter(cast, { clusters: ['cluster-9'] }));
    cast = addEvidence(cast, 'P1', clue(192, '马修', 'vocative', { quote: QUOTE }));
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 420 });
    cast = updateCharacter(cast, 'P1', { say: 'mǎ xiū' });
    cast = addEvidence(cast, 'P2', clue(300, 'Chen', 'self-intro', { quote: LINE }));
    cast = addEvidence(cast, 'P2', clue(310, 'Old Chen', 'vocative', { quote: 'Old Chen, over here' }));
    cast = rejectName(cast, 'P2', 'Old Chen', { t: 500 });
    cast = neverName(cast, 'P3', true, { t: 510 });
    cast = setAppearance(cast, { char: 'P1', from: 0, outfit: '红裙子', src: 'model' });
    cast = setAppearance(cast, { char: 'P1', from: 600, outfit: '灰大衣', scene: 4, src: 'human' });
    return { ...cast, constraints: { mustLink: [['cluster-12', 'cluster-40']], cannotLink: [['cluster-12', 'cluster-7']] } };
  }

  it('gives each character with names and text only, then the appearances and the policy', () => {
    const cast = fullCast();
    const exported = exportCast(cast);
    expect(Object.keys(exported)).toEqual(['v', 'policy', 'characters', 'appearances']);
    expect(exported.v).toBe(1);
    expect(exported.policy).toEqual({ ...DEFAULT_POLICY, naming: 'on-reveal' });
    expect(exported.characters).toEqual([
      {
        id: 'P1',
        name: '马修',
        level: 3,
        aliases: ['小马', 'Matt'],
        say: 'mǎ xiū',
        descriptor: { zh: '长发女人', en: 'woman with long hair' },
        revealAt: 192,
        spoilerLock: false,
        neverName: false,
        main: true,
        confirmedBy: 'ear',
      },
      {
        id: 'P2',
        name: 'Chen',
        level: 1,
        aliases: [],
        descriptor: { zh: '戴眼镜的男人' },
        revealAt: 300,
        spoilerLock: true,
        neverName: false,
        main: false,
        confirmedBy: null,
      },
      {
        id: 'P3',
        name: null,
        level: 0,
        aliases: [],
        descriptor: {},
        revealAt: null,
        spoilerLock: false,
        neverName: true,
        main: false,
        confirmedBy: null,
      },
    ]);
    expect(Object.keys(exported.characters[0])).toEqual(['id', 'name', 'level', 'aliases', 'say', 'descriptor', 'revealAt', 'spoilerLock', 'neverName', 'main', 'confirmedBy']);
    expect('say' in exported.characters[1]).toBe(false);
    expect(exported.appearances).toEqual([
      { char: 'P1', from: 0, to: 600, outfit: '红裙子', src: 'model' },
      { char: 'P1', from: 600, to: null, outfit: '灰大衣', scene: 4, src: 'human' },
    ]);
  });

  it('holds no clusters, no evidence, no quotes, no constraints and no events', () => {
    const cast = fullCast();
    // The cast really has all of them, so their absence below means something.
    expect(cast.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(cast)).toContain(QUOTE);
    expect(JSON.stringify(cast)).toContain('cluster-12');

    const exported = exportCast(cast);
    const json = JSON.stringify(exported);
    const keys = keysIn(exported);
    for (const key of ['clusters', 'evidence', 'quote', 'line', 'constraints', 'mustLink', 'cannotLink', 'events', 'screenSec', 'kind', 'rejected']) {
      expect(keys.has(key)).toBe(false);
      expect(json).not.toContain(`"${key}"`);
    }
    expect(json).not.toContain(QUOTE);
    expect(json).not.toContain('等等');
    expect(json).not.toContain(LINE);
    expect(json).not.toContain('over here');
    expect(json).not.toContain('cluster-');
    // A name a person rejected is not carried either.
    expect(json).not.toContain('Old Chen');
  });

  it('lets nothing else a cast object holds get out', () => {
    const cast = fullCast();
    const dirty = {
      ...cast,
      thumbnails: { P1: 'data:image/jpeg;base64,AAAA' },
      characters: cast.characters.map((c) => ({ ...c, faceVectors: [[0.1, 0.2]], quote: QUOTE })),
      appearances: cast.appearances.map((a) => ({ ...a, quote: QUOTE, track: 'track-77' })),
    };
    const json = JSON.stringify(exportCast(dirty));
    expect(json).not.toContain('thumbnails');
    expect(json).not.toContain('faceVectors');
    expect(json).not.toContain('track-77');
    expect(json).not.toContain(QUOTE);
    expect(exportCast(dirty)).toEqual(exportCast(cast));
  });

  it('says how a name was confirmed: by ear, by sight, or null', () => {
    let cast = castWith({}, {}, {}, {}, {});
    cast = confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 1 });
    cast = confirmName(cast, 'P2', { name: '老陈', by: 'sight', t: 2 });
    cast = confirmName(cast, 'P3', { name: '小李', t: 3 });
    cast = addEvidence(addEvidence(cast, 'P4', clue(10, '阿强')), 'P4', clue(20, '阿强', 'self-intro'));
    expect(exportCast(cast).characters.map((c) => [c.level, c.confirmedBy])).toEqual([[3, 'ear'], [3, 'sight'], [3, null], [2, null], [0, null]]);
    // The confirmation that stands is the one that counts.
    const reconfirmed = confirmName(cast, 'P1', { name: '马修', by: 'sight', t: 9 });
    expect(exportCast(reconfirmed).characters[0].confirmedBy).toBe('sight');
    const undone = rejectName(cast, 'P2', '老陈');
    expect(exportCast(undone).characters[1]).toMatchObject({ name: null, level: 0, confirmedBy: null });
    // A later confirmation that was rejected: the earlier one stands, and so does the way it was made.
    let renamed = confirmName(castWith({}), 'P1', { name: 'A', by: 'ear', t: 1 });
    renamed = rejectName(confirmName(renamed, 'P1', { name: 'B', by: 'sight', t: 2 }), 'P1', 'B');
    expect(exportCast(renamed).characters[0]).toMatchObject({ name: 'A', level: 3, confirmedBy: 'ear' });
  });

  it('can be read back with validateCast, names, levels and the way of confirmation intact', () => {
    const exported = exportCast(fullCast());
    const back = validateCast(JSON.parse(JSON.stringify(exported)));
    expect(back.characters.map((c) => [c.id, c.name, c.level])).toEqual([['P1', '马修', 3], ['P2', 'Chen', 1], ['P3', null, 0]]);
    expect(getCharacter(back, 'P1').aliases).toEqual([{ text: '小马' }, { text: 'Matt' }]);
    expect(back.appearances).toEqual(exported.appearances);
    expect(back.policy).toEqual(exported.policy);
    expect(back.events).toEqual([]);
    expect(back.characters.every((c) => c.clusters.length === 0)).toBe(true);
    expect(exportCast(back)).toEqual(exported);
    // A name carried by a package holds against a clue found later on this computer.
    expect(getCharacter(addEvidence(back, 'P1', clue(50, '老陈')), 'P1')).toMatchObject({ name: '马修', level: 3 });
  });

  it('gives copies, throws bad-cast for something that is not a cast, and does not change the cast', () => {
    const cast = deepFreeze(fullCast());
    const exported = exportCast(cast);
    expect(exported.policy).not.toBe(cast.policy);
    expect(exported.appearances[0]).not.toBe(cast.appearances[0]);
    expect(exported.characters[0].descriptor).not.toBe(cast.characters[0].descriptor);
    exported.characters[0].aliases.push('x');
    exported.appearances[0].outfit = 'x';
    expect(cast.characters[0].aliases).toHaveLength(2);
    expect(cast.appearances[0].outfit).toBe('红裙子');
    expect(() => exportCast(null)).toThrow('bad-cast');
    expect(() => exportCast([])).toThrow('bad-cast');
  });
});

describe('the record of what people changed', () => {
  it('only grows, in the order things were done, and is not written by the analysis', () => {
    let cast = castWith({}, {}, {});
    const seen = [];
    const step = (next) => {
      // Every earlier entry is still there, unchanged, at the same place.
      expect(next.events.slice(0, seen.length)).toEqual(seen);
      seen.splice(0, seen.length, ...next.events);
      return next;
    };
    cast = step(addEvidence(cast, 'P1', clue(10, '马修')));
    cast = step(updateCharacter(cast, 'P1', { main: true, neverName: false }));
    cast = step(setAppearance(cast, { char: 'P1', from: 0, outfit: '红裙子', src: 'human' }));
    expect(cast.events).toEqual([]);
    cast = step(confirmName(cast, 'P1', { name: '马修', by: 'ear', t: 100 }));
    cast = step(rejectName(cast, 'P1', '马修', { t: 200 }));
    cast = step(neverName(cast, 'P2', true, { t: 300 }));
    cast = step(mergeCharacters(cast, 'P2', 'P3', { t: 400 }).cast);
    cast = step(addCharacter(cast).cast);
    expect(cast.events).toEqual([
      { type: 'confirm', char: 'P1', name: '马修', by: 'ear', t: 100 },
      { type: 'reject', char: 'P1', name: '马修', t: 200 },
      { type: 'neverName', char: 'P2', on: true, t: 300 },
      { type: 'merge', keep: 'P2', drop: 'P3', t: 400 },
    ]);
  });
});
