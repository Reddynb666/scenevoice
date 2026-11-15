// Who is on screen (src/film/identity.js): labels made by hand, face tracks
// clustered on this computer, and the mode without faces. All three answer the
// same questions; an entry that makes no sense is left out, never thrown on.

import { describe, expect, it } from 'vitest';
import { faceClusterIdentity, groundTruthIdentity, promptBankIdentity } from '../src/film/identity.js';

const BOX = [100, 50, 80, 80];
const OTHER_BOX = [300, 60, 90, 90];
const THIRD_BOX = [500, 70, 70, 70];

const label = (t, characterId, extra = {}) => ({ t, box: BOX, characterId, ...extra });
const sample = (t, conf = 0.9, box = BOX) => ({ t, box, conf });
const track = (id, cluster, samples) => ({ id, cluster, samples });
const ids = (visible) => visible.map((v) => v.characterId);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** Things a file read from disk might hold instead of a list of labels or tracks. */
const JUNK = [undefined, null, 0, 42, NaN, '', 'labels', true, {}, { length: 3 }, () => [], [null, undefined, 1, 'x', [], {}, { t: 1 }, { characterId: 'P1' }, { box: BOX }]];

describe('every identity provider', () => {
  const providers = [
    groundTruthIdentity([label(10, 'P1')]),
    faceClusterIdentity([track('t1', 'c1', [sample(10), sample(12)])], { c1: 'P1' }),
    promptBankIdentity(),
  ];

  it('has the same shape: a mode and four questions', () => {
    for (const provider of providers) {
      expect(typeof provider.mode).toBe('string');
      expect(typeof provider.visibleAt).toBe('function');
      expect(typeof provider.visibleBetween).toBe('function');
      expect(typeof provider.peopleBetween).toBe('function');
      expect(typeof provider.screenSeconds).toBe('function');
    }
  });

  it('counts the people seen during a span, or answers null when it cannot tell', () => {
    expect(providers.map((p) => p.peopleBetween(0, 100))).toEqual([1, 1, null]);
    expect(providers.map((p) => p.peopleBetween(50, 100))).toEqual([0, 0, null]);
  });

  it('names its mode', () => {
    expect(providers.map((p) => p.mode)).toEqual(['ground-truth', 'face-cluster', 'prompt-bank']);
  });

  it('answers visibleAt with a list and screenSeconds with a plain object', () => {
    for (const provider of providers) {
      expect(Array.isArray(provider.visibleAt(10))).toBe(true);
      const seconds = provider.screenSeconds();
      expect(seconds && typeof seconds === 'object' && !Array.isArray(seconds)).toBe(true);
    }
  });
});

describe('groundTruthIdentity: visibleAt', () => {
  it('counts a label for one second either side of its time by default', () => {
    const identity = groundTruthIdentity([label(10, 'P1')]);
    expect(ids(identity.visibleAt(10))).toEqual(['P1']);
    expect(ids(identity.visibleAt(9))).toEqual(['P1']);
    expect(ids(identity.visibleAt(11))).toEqual(['P1']);
    expect(ids(identity.visibleAt(9.5))).toEqual(['P1']);
    expect(identity.visibleAt(8.99)).toEqual([]);
    expect(identity.visibleAt(11.01)).toEqual([]);
    expect(identity.visibleAt(100)).toEqual([]);
  });

  it('takes the hold from the options', () => {
    const wide = groundTruthIdentity([label(10, 'P1')], { hold: 3 });
    expect(ids(wide.visibleAt(13))).toEqual(['P1']);
    expect(ids(wide.visibleAt(7))).toEqual(['P1']);
    expect(wide.visibleAt(13.5)).toEqual([]);

    const exact = groundTruthIdentity([label(10, 'P1')], { hold: 0 });
    expect(ids(exact.visibleAt(10))).toEqual(['P1']);
    expect(exact.visibleAt(10.01)).toEqual([]);
    expect(exact.visibleAt(9.99)).toEqual([]);
  });

  it('counts a label exactly `hold` away even when the arithmetic is a hair off', () => {
    // 0.9 - 0.7 is 0.20000000000000007 and 0.7 + 0.2 is 0.8999999999999999.
    const identity = groundTruthIdentity([label(0.7, 'P1')], { hold: 0.2 });
    expect(ids(identity.visibleAt(0.9))).toEqual(['P1']);
    expect(ids(identity.visibleAt(0.5))).toEqual(['P1']);
    expect(identity.visibleBetween(0.9, 5)).toEqual(['P1']);
    expect(identity.visibleBetween(0, 0.5)).toEqual(['P1']);
    expect(identity.visibleAt(0.901)).toEqual([]);
    expect(identity.visibleBetween(0.901, 5)).toEqual([]);
  });

  it('falls back to one second when the hold makes no sense', () => {
    for (const hold of [-1, NaN, Infinity, '3', null, undefined, {}]) {
      const identity = groundTruthIdentity([label(10, 'P1')], { hold });
      expect(ids(identity.visibleAt(11))).toEqual(['P1']);
      expect(identity.visibleAt(11.5)).toEqual([]);
    }
  });

  it('gives a visible person the box of the label, sure of it (conf 1)', () => {
    const identity = groundTruthIdentity([label(10, 'P3')]);
    expect(identity.visibleAt(10.4)).toEqual([{ characterId: 'P3', box: [100, 50, 80, 80], conf: 1 }]);
  });

  it('returns one entry per character, from the label nearest in time', () => {
    const identity = groundTruthIdentity([
      { t: 10, box: BOX, characterId: 'P1' },
      { t: 11.5, box: OTHER_BOX, characterId: 'P1' },
    ]);
    const early = identity.visibleAt(10.6);
    expect(early).toHaveLength(1);
    expect(early[0].box).toEqual(BOX);
    const late = identity.visibleAt(11);
    expect(late).toHaveLength(1);
    expect(late[0].box).toEqual(OTHER_BOX);
  });

  it('keeps the earlier of two labels that are equally far away, whatever order they came in', () => {
    const inOrder = groundTruthIdentity([
      { t: 10, box: BOX, characterId: 'P1' },
      { t: 12, box: OTHER_BOX, characterId: 'P1' },
    ]);
    const reversed = groundTruthIdentity([
      { t: 12, box: OTHER_BOX, characterId: 'P1' },
      { t: 10, box: BOX, characterId: 'P1' },
    ]);
    expect(inOrder.visibleAt(11)[0].box).toEqual(BOX);
    expect(reversed.visibleAt(11)[0].box).toEqual(BOX);
  });

  it('carries the track id of a label that has one, and no track id otherwise', () => {
    const identity = groundTruthIdentity([label(10, 'P1', { trackId: 'hand-7' }), label(10, 'P2')]);
    const [first, second] = identity.visibleAt(10);
    expect(first.trackId).toBe('hand-7');
    expect('trackId' in second).toBe(false);
  });

  it('lists people by character number, not by spelling', () => {
    const identity = groundTruthIdentity([label(10, 'P10'), label(10, 'P2'), label(10, 'P1'), label(10, 'P21')]);
    expect(ids(identity.visibleAt(10))).toEqual(['P1', 'P2', 'P10', 'P21']);
  });

  it('answers nobody for a time that is not a number', () => {
    const identity = groundTruthIdentity([label(0, 'P1'), label(10, 'P2')]);
    for (const t of [NaN, null, undefined, '0', '10', {}, [], true]) expect(identity.visibleAt(t)).toEqual([]);
    expect(identity.visibleAt(Infinity)).toEqual([]);
    expect(identity.visibleAt(-Infinity)).toEqual([]);
  });
});

describe('groundTruthIdentity: visibleBetween', () => {
  const identity = groundTruthIdentity([label(10, 'P1')]);

  it('gives the characters with a label whose held span meets the span asked about', () => {
    expect(identity.visibleBetween(0, 20)).toEqual(['P1']);
    expect(identity.visibleBetween(9.5, 10.5)).toEqual(['P1']);
    expect(identity.visibleBetween(10, 10)).toEqual(['P1']);
    // The label holds from 9 to 11: a span that only touches an end still meets it.
    expect(identity.visibleBetween(11, 20)).toEqual(['P1']);
    expect(identity.visibleBetween(0, 9)).toEqual(['P1']);
    expect(identity.visibleBetween(11.01, 20)).toEqual([]);
    expect(identity.visibleBetween(0, 8.99)).toEqual([]);
  });

  it('follows the hold', () => {
    expect(groundTruthIdentity([label(10, 'P1')], { hold: 5 }).visibleBetween(15, 30)).toEqual(['P1']);
    expect(groundTruthIdentity([label(10, 'P1')], { hold: 0 }).visibleBetween(10.5, 30)).toEqual([]);
    expect(groundTruthIdentity([label(10, 'P1')], { hold: 0 }).visibleBetween(10, 30)).toEqual(['P1']);
  });

  it('lists each character once, by character number', () => {
    const many = groundTruthIdentity([label(5, 'P12'), label(6, 'P3'), label(7, 'P12'), label(8, 'P3'), label(9, 'P1'), label(40, 'P2')]);
    expect(many.visibleBetween(0, 20)).toEqual(['P1', 'P3', 'P12']);
    expect(many.visibleBetween(0, 60)).toEqual(['P1', 'P2', 'P3', 'P12']);
    expect(many.visibleBetween(20, 30)).toEqual([]);
  });

  it('takes the ends in either order, and an open end', () => {
    expect(identity.visibleBetween(20, 0)).toEqual(['P1']);
    expect(identity.visibleBetween(-Infinity, Infinity)).toEqual(['P1']);
    expect(identity.visibleBetween(12, Infinity)).toEqual([]);
  });

  it('answers nobody (a list, not null) when an end is not a number', () => {
    for (const bad of [NaN, null, undefined, '5', {}]) {
      expect(identity.visibleBetween(bad, 20)).toEqual([]);
      expect(identity.visibleBetween(0, bad)).toEqual([]);
    }
    expect(identity.visibleBetween()).toEqual([]);
  });
});

describe('groundTruthIdentity: peopleBetween', () => {
  it('counts each labelled character once, however many labels it has', () => {
    const identity = groundTruthIdentity([label(10, 'P1'), label(11, 'P1'), label(12, 'P1', { trackId: 't2' }), label(11, 'P2'), label(40, 'P3')]);
    expect(identity.peopleBetween(9, 13)).toBe(2);
    expect(identity.peopleBetween(0, 100)).toBe(3);
    expect(identity.peopleBetween(20, 30)).toBe(0);
    expect(identity.peopleBetween(100, 0)).toBe(3);
    // It follows the hold, as visibleBetween does.
    expect(identity.peopleBetween(13.5, 20)).toBe(0);
    expect(groundTruthIdentity([label(10, 'P1')], { hold: 5 }).peopleBetween(13.5, 20)).toBe(1);
  });

  it('counts a box drawn around somebody without a character id: a person nobody has placed', () => {
    const identity = groundTruthIdentity([label(10, 'P1'), label(10, undefined), label(11, 'the usher', { trackId: 'u1' }), label(12, null, { trackId: 'u1' })]);
    expect(identity.visibleBetween(0, 100)).toEqual(['P1']);
    // The box without a track id, and the two boxes of track u1 once.
    expect(identity.peopleBetween(0, 100)).toBe(3);
    expect(identity.peopleBetween(11.5, 20)).toBe(1);
    // An entry that is no box on the film at all is nobody.
    expect(groundTruthIdentity([{ characterId: 'x' }, { t: 5, characterId: 'x' }, { t: -1, box: BOX }, null]).peopleBetween(0, 100)).toBe(0);
  });

  it('answers 0 when an end is not a number', () => {
    const identity = groundTruthIdentity([label(10, 'P1')]);
    expect(identity.peopleBetween(NaN, 100)).toBe(0);
    expect(identity.peopleBetween(0, undefined)).toBe(0);
    expect(identity.peopleBetween('0', '100')).toBe(0);
  });
});

describe('groundTruthIdentity: screenSeconds', () => {
  it('adds up the stretches the labels hold for, counting an overlap once', () => {
    // P1: 10, 11 and 12 hold from 9 to 13 together (4 s); 20 holds from 19 to 21 (2 s).
    const identity = groundTruthIdentity([label(10, 'P1'), label(11, 'P1'), label(12, 'P1'), label(20, 'P1'), label(30, 'P2')]);
    expect(identity.screenSeconds()).toEqual({ P1: 6, P2: 2 });
  });

  it('does not count the part of a hold that falls before the start of the film', () => {
    expect(groundTruthIdentity([label(0, 'P1')]).screenSeconds()).toEqual({ P1: 1 });
    expect(groundTruthIdentity([label(0.5, 'P1')]).screenSeconds()).toEqual({ P1: 1.5 });
  });

  it('follows the hold, and lists a character seen for no time at all with 0', () => {
    expect(groundTruthIdentity([label(10, 'P1'), label(20, 'P1')], { hold: 2.5 }).screenSeconds()).toEqual({ P1: 10 });
    expect(groundTruthIdentity([label(10, 'P1')], { hold: 0 }).screenSeconds()).toEqual({ P1: 0 });
  });

  it('counts two labels at the same moment once', () => {
    expect(groundTruthIdentity([label(10, 'P1'), label(10, 'P1')]).screenSeconds()).toEqual({ P1: 2 });
  });

  it('gives round numbers for times that are not (to the millisecond)', () => {
    const identity = groundTruthIdentity([label(0.1, 'P1'), label(0.2, 'P1'), label(0.3, 'P1')], { hold: 0.1 });
    expect(identity.screenSeconds()).toEqual({ P1: 0.4 });
  });

  it('lists the characters by number', () => {
    const identity = groundTruthIdentity([label(10, 'P10'), label(10, 'P2'), label(10, 'P1')]);
    expect(Object.keys(identity.screenSeconds())).toEqual(['P1', 'P2', 'P10']);
  });

  it('is empty without labels', () => {
    expect(groundTruthIdentity([]).screenSeconds()).toEqual({});
  });
});

describe('groundTruthIdentity: input that makes no sense', () => {
  it('never throws, and sees nobody', () => {
    for (const junk of JUNK) {
      for (const options of [undefined, null, {}, 'x', 7]) {
        const identity = groundTruthIdentity(junk, options);
        expect(identity.mode).toBe('ground-truth');
        expect(identity.visibleAt(1)).toEqual([]);
        expect(identity.visibleBetween(0, 100)).toEqual([]);
        expect(identity.peopleBetween(0, 100)).toBe(0);
        expect(identity.screenSeconds()).toEqual({});
      }
    }
  });

  it('leaves out a label without a character id it knows', () => {
    for (const characterId of ['P0', 'p3', 'P03', 'P', '3', 3, null, undefined, 'Matthew', '马修', '{P3}', ['P3']]) {
      expect(groundTruthIdentity([{ t: 10, box: BOX, characterId }]).visibleAt(10)).toEqual([]);
    }
  });

  it('leaves out a label without a usable time', () => {
    for (const t of [NaN, Infinity, -1, '10', null, undefined, {}]) {
      const identity = groundTruthIdentity([{ t, box: BOX, characterId: 'P1' }]);
      expect(identity.visibleBetween(-Infinity, Infinity)).toEqual([]);
      expect(identity.screenSeconds()).toEqual({});
    }
  });

  it('leaves out a label without a usable box', () => {
    for (const box of [null, undefined, 'box', [], [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, NaN, 4], [1, 2, '3', 4], [1, 2, 0, 4], [1, 2, 3, 0], [1, 2, -3, 4], [1, 2, 3, Infinity], { 0: 1, 1: 2, 2: 3, 3: 4 }]) {
      expect(groundTruthIdentity([{ t: 10, box, characterId: 'P1' }]).visibleAt(10)).toEqual([]);
    }
  });

  it('keeps the good labels that stand next to bad ones', () => {
    const identity = groundTruthIdentity([null, label(10, 'P0'), label(10, 'P2'), { t: 'x' }, label(NaN, 'P1'), label(10.5, 'P1'), 'P3']);
    expect(ids(identity.visibleAt(10.2))).toEqual(['P1', 'P2']);
  });

  it('ignores a track id that is not a text', () => {
    const [seen] = groundTruthIdentity([label(10, 'P1', { trackId: 7 })]).visibleAt(10);
    expect('trackId' in seen).toBe(false);
  });
});

describe('groundTruthIdentity: no shared state', () => {
  it('does not change the labels it is given', () => {
    const labels = deepFreeze([label(12, 'P2', { box: [1, 2, 30, 40] }), label(10, 'P1', { box: [5, 6, 70, 80] })]);
    const identity = groundTruthIdentity(labels, deepFreeze({ hold: 2 }));
    expect(ids(identity.visibleAt(11))).toEqual(['P1', 'P2']);
    expect(labels.map((l) => l.t)).toEqual([12, 10]);
  });

  it('is not changed by what happens to the labels afterwards', () => {
    const box = [5, 6, 70, 80];
    const labels = [{ t: 10, box, characterId: 'P1' }];
    const identity = groundTruthIdentity(labels);
    box[0] = 999;
    labels[0].characterId = 'P9';
    labels.push(label(10, 'P2'));
    expect(identity.visibleAt(10)).toEqual([{ characterId: 'P1', box: [5, 6, 70, 80], conf: 1 }]);
  });

  it('hands out a new list and new boxes every time', () => {
    const identity = groundTruthIdentity([label(10, 'P1')]);
    const first = identity.visibleAt(10);
    first[0].box[0] = -1;
    first[0].characterId = 'P7';
    first.push('junk');
    expect(identity.visibleAt(10)).toEqual([{ characterId: 'P1', box: [100, 50, 80, 80], conf: 1 }]);
    const between = identity.visibleBetween(0, 20);
    between.push('P9');
    expect(identity.visibleBetween(0, 20)).toEqual(['P1']);
    const seconds = identity.screenSeconds();
    seconds.P1 = 999;
    expect(identity.screenSeconds()).toEqual({ P1: 2 });
  });
});

describe('faceClusterIdentity: which tracks count', () => {
  it('ignores a track whose cluster has no character', () => {
    const identity = faceClusterIdentity(
      [track('t1', 'c1', [sample(10), sample(12)]), track('t2', 'c9', [sample(10), sample(12)])],
      { c1: 'P1' },
    );
    expect(ids(identity.visibleAt(11))).toEqual(['P1']);
    expect(identity.visibleBetween(0, 100)).toEqual(['P1']);
    expect(identity.screenSeconds()).toEqual({ P1: 2 });
  });

  it('ignores a cluster that is mapped to something that is not a character id', () => {
    for (const mapped of ['Matthew', '马修', 'P0', 'p1', null, undefined, 3, {}, ['P1']]) {
      const identity = faceClusterIdentity([track('t1', 'c1', [sample(10), sample(12)])], { c1: mapped });
      expect(identity.visibleAt(11)).toEqual([]);
      expect(identity.visibleBetween(0, 100)).toEqual([]);
      expect(identity.screenSeconds()).toEqual({});
    }
  });

  it('does not take a property every object has for a cluster of the cast', () => {
    const tracks = ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((cluster, i) => track(`t${i}`, cluster, [sample(10), sample(12)]));
    expect(faceClusterIdentity(tracks, {}).visibleBetween(0, 100)).toEqual([]);
  });

  it('lets one character own several clusters', () => {
    const identity = faceClusterIdentity(
      [track('young', 'c1', [sample(10), sample(12)]), track('old', 'c2', [sample(50), sample(53)])],
      { c1: 'P3', c2: 'P3' },
    );
    expect(ids(identity.visibleAt(11))).toEqual(['P3']);
    expect(ids(identity.visibleAt(51))).toEqual(['P3']);
    expect(identity.screenSeconds()).toEqual({ P3: 5 });
  });

  it('reads cluster ids and track ids that are numbers', () => {
    const identity = faceClusterIdentity([track(12, 7, [sample(10), sample(12)])], { 7: 'P2' });
    expect(identity.visibleAt(11)).toEqual([{ characterId: 'P2', box: BOX, conf: 0.9, trackId: '12' }]);
  });

  it('gives no track id for a track without one', () => {
    const [seen] = faceClusterIdentity([{ cluster: 'c1', samples: [sample(10), sample(12)] }], { c1: 'P1' }).visibleAt(11);
    expect(seen.characterId).toBe('P1');
    expect('trackId' in seen).toBe(false);
  });
});

describe('faceClusterIdentity: visibleAt', () => {
  it('sees a track from its first to its last sample, the gaps between samples included', () => {
    const identity = faceClusterIdentity([track('t1', 'c1', [sample(10), sample(10.5), sample(12)])], { c1: 'P1' });
    expect(ids(identity.visibleAt(10))).toEqual(['P1']);
    expect(ids(identity.visibleAt(12))).toEqual(['P1']);
    expect(ids(identity.visibleAt(11.3))).toEqual(['P1']);
    expect(identity.visibleAt(9.99)).toEqual([]);
    expect(identity.visibleAt(12.01)).toEqual([]);
  });

  it('sees a track of one sample at that moment only', () => {
    const identity = faceClusterIdentity([track('t1', 'c1', [sample(10)])], { c1: 'P1' });
    expect(ids(identity.visibleAt(10))).toEqual(['P1']);
    expect(identity.visibleAt(10.1)).toEqual([]);
  });

  it('takes the box and the confidence of the sample nearest in time, and the id of the track', () => {
    const identity = faceClusterIdentity(
      [track('t1', 'c1', [sample(10, 0.9, BOX), sample(11, 0.5, OTHER_BOX), sample(12, 0.7, THIRD_BOX)])],
      { c1: 'P4' },
    );
    expect(identity.visibleAt(10.4)).toEqual([{ characterId: 'P4', box: BOX, conf: 0.9, trackId: 't1' }]);
    expect(identity.visibleAt(10.6)).toEqual([{ characterId: 'P4', box: OTHER_BOX, conf: 0.5, trackId: 't1' }]);
    expect(identity.visibleAt(11.9)).toEqual([{ characterId: 'P4', box: THIRD_BOX, conf: 0.7, trackId: 't1' }]);
    // Half way between two samples: the earlier one.
    expect(identity.visibleAt(10.5)[0].box).toEqual(BOX);
  });

  it('sorts samples that arrive out of order', () => {
    const identity = faceClusterIdentity(
      [track('t1', 'c1', [sample(12, 0.7, THIRD_BOX), sample(10, 0.9, BOX), sample(11, 0.5, OTHER_BOX)])],
      { c1: 'P4' },
    );
    expect(identity.visibleAt(10.1)[0].box).toEqual(BOX);
    expect(identity.visibleAt(12)[0].box).toEqual(THIRD_BOX);
    expect(identity.visibleAt(12.5)).toEqual([]);
    expect(identity.screenSeconds()).toEqual({ P4: 2 });
  });

  it('shows a character once when two of its tracks overlap: the more confident one', () => {
    const tracks = [
      track('t1', 'c1', [sample(10, 0.6, BOX), sample(12, 0.6, BOX)]),
      track('t2', 'c2', [sample(11, 0.95, OTHER_BOX), sample(13, 0.95, OTHER_BOX)]),
    ];
    const mapping = { c1: 'P3', c2: 'P3' };
    for (const list of [tracks, [...tracks].reverse()]) {
      const identity = faceClusterIdentity(list, mapping);
      expect(identity.visibleAt(11.5)).toEqual([{ characterId: 'P3', box: OTHER_BOX, conf: 0.95, trackId: 't2' }]);
      expect(identity.visibleAt(10.5)).toEqual([{ characterId: 'P3', box: BOX, conf: 0.6, trackId: 't1' }]);
      expect(identity.visibleAt(12.5)).toEqual([{ characterId: 'P3', box: OTHER_BOX, conf: 0.95, trackId: 't2' }]);
    }
  });

  it('breaks a tie in confidence by the sample nearer in time', () => {
    const identity = faceClusterIdentity(
      [
        track('far', 'c1', [sample(10, 0.8, BOX), sample(14, 0.8, BOX)]),
        track('near', 'c2', [sample(11.9, 0.8, OTHER_BOX), sample(13, 0.8, OTHER_BOX)]),
      ],
      { c1: 'P3', c2: 'P3' },
    );
    expect(identity.visibleAt(12)[0].trackId).toBe('near');
  });

  it('lists people by character number', () => {
    const identity = faceClusterIdentity(
      [track('a', 'c10', [sample(10), sample(12)]), track('b', 'c2', [sample(10), sample(12)]), track('c', 'c1', [sample(10), sample(12)])],
      { c10: 'P10', c2: 'P2', c1: 'P1' },
    );
    expect(ids(identity.visibleAt(11))).toEqual(['P1', 'P2', 'P10']);
  });

  it('keeps a confidence between 0 and 1, and counts a missing one as none', () => {
    const conf = (value) => faceClusterIdentity([track('t', 'c', [{ t: 10, box: BOX, conf: value }])], { c: 'P1' }).visibleAt(10)[0].conf;
    expect(conf(0.42)).toBe(0.42);
    expect(conf(1.7)).toBe(1);
    expect(conf(-0.2)).toBe(0);
    expect(conf(undefined)).toBe(0);
    expect(conf(NaN)).toBe(0);
    expect(conf('0.9')).toBe(0);
  });

  it('answers nobody for a time that is not a number', () => {
    const identity = faceClusterIdentity([track('t1', 'c1', [sample(0), sample(12)])], { c1: 'P1' });
    for (const t of [NaN, null, undefined, '5', {}, []]) expect(identity.visibleAt(t)).toEqual([]);
  });
});

describe('faceClusterIdentity: visibleBetween and screenSeconds', () => {
  const identity = faceClusterIdentity(
    [
      track('t1', 'c1', [sample(10), sample(12)]),
      track('t2', 'c2', [sample(11), sample(13)]),
      track('t3', 'c3', [sample(0), sample(4.5)]),
      track('t4', 'c4', [sample(30)]),
      track('t5', 'c5', [sample(40), sample(41)]),
    ],
    { c1: 'P12', c2: 'P12', c3: 'P1', c4: 'P2', c5: 'P3' },
  );

  it('gives the characters with a track that runs during some part of the span', () => {
    expect(identity.visibleBetween(12.5, 20)).toEqual(['P12']);
    expect(identity.visibleBetween(13, 20)).toEqual(['P12']);
    expect(identity.visibleBetween(13.01, 20)).toEqual([]);
    expect(identity.visibleBetween(5, 10)).toEqual(['P12']);
    expect(identity.visibleBetween(4.6, 9.9)).toEqual([]);
    expect(identity.visibleBetween(40.2, 40.4)).toEqual(['P3']);
    expect(identity.visibleBetween(30, 30)).toEqual(['P2']);
  });

  it('lists each character once, by character number', () => {
    expect(identity.visibleBetween(0, 100)).toEqual(['P1', 'P2', 'P3', 'P12']);
    expect(identity.visibleBetween(0, 12)).toEqual(['P1', 'P12']);
  });

  it('takes the ends in either order, and answers nobody when an end is not a number', () => {
    expect(identity.visibleBetween(100, 0)).toEqual(['P1', 'P2', 'P3', 'P12']);
    expect(identity.visibleBetween(-Infinity, Infinity)).toEqual(['P1', 'P2', 'P3', 'P12']);
    expect(identity.visibleBetween(NaN, 100)).toEqual([]);
    expect(identity.visibleBetween(0, undefined)).toEqual([]);
    expect(identity.visibleBetween('0', '100')).toEqual([]);
  });

  it('adds up what the tracks of a character cover, a moment two tracks share counted once', () => {
    // P12: 10–12 and 11–13 are three seconds, not four. P2 has one sample: no length.
    expect(identity.screenSeconds()).toEqual({ P1: 4.5, P2: 0, P3: 1, P12: 3 });
    expect(Object.keys(identity.screenSeconds())).toEqual(['P1', 'P2', 'P3', 'P12']);
  });
});

describe('faceClusterIdentity: peopleBetween', () => {
  const identity = faceClusterIdentity(
    [
      track('t1', 'c1', [sample(10), sample(12)]),
      // The same character again after a cut, and through another of its clusters.
      track('t2', 'c1', [sample(12.5), sample(14)]),
      track('t3', 'c2', [sample(13), sample(15)]),
      // Faces nobody has placed: cluster c9 twice, cluster c8 once, and a track with no cluster at all.
      track('t4', 'c9', [sample(11), sample(12)]),
      track('t5', 'c9', [sample(13), sample(14)]),
      track('t6', 'c8', [sample(30), sample(31)]),
      { id: 't7', samples: [sample(40), sample(41)] },
      { id: 't8', cluster: null, samples: [sample(40.5), sample(41)] },
      track('t9', 'c3', [sample(50), sample(52)]),
    ],
    { c1: 'P1', c2: 'P1', c3: 'P2' },
  );

  it('counts a character once however many of its tracks run during the span', () => {
    expect(identity.peopleBetween(9, 10.5)).toBe(1);
    expect(identity.peopleBetween(12.4, 12.6)).toBe(1);
    expect(identity.peopleBetween(14.5, 20)).toBe(1);
    expect(identity.peopleBetween(49, 60)).toBe(1);
  });

  it('counts a face nobody has placed, each unplaced cluster once, and never names it', () => {
    expect(identity.visibleBetween(10, 15)).toEqual(['P1']);
    expect(identity.peopleBetween(10, 15)).toBe(2);
    expect(identity.peopleBetween(29, 32)).toBe(1);
    expect(identity.visibleBetween(29, 32)).toEqual([]);
    expect(identity.visibleAt(30.5)).toEqual([]);
    expect(identity.screenSeconds()).toEqual({ P1: 4.5, P2: 2 });
  });

  it('counts a track without a usable cluster as one more face, each on its own', () => {
    expect(identity.peopleBetween(39, 42)).toBe(2);
    expect(identity.peopleBetween(40, 40.2)).toBe(1);
    expect(identity.peopleBetween(0, 100)).toBe(6);
  });

  it('counts a cluster mapped to something that is no character id as unplaced', () => {
    const odd = faceClusterIdentity([track('t1', 'c1', [sample(10), sample(12)]), track('t2', 'constructor', [sample(10), sample(12)])], { c1: 'Matthew' });
    expect(odd.visibleBetween(0, 100)).toEqual([]);
    expect(odd.peopleBetween(0, 100)).toBe(2);
  });

  it('takes the ends in either order, counts nobody outside the tracks, and answers 0 when an end is not a number', () => {
    expect(identity.peopleBetween(15, 10)).toBe(2);
    expect(identity.peopleBetween(16, 29)).toBe(0);
    expect(identity.peopleBetween(NaN, 100)).toBe(0);
    expect(identity.peopleBetween(0, undefined)).toBe(0);
    expect(faceClusterIdentity([], {}).peopleBetween(0, 100)).toBe(0);
  });

  it('leaves out a track without usable samples', () => {
    expect(faceClusterIdentity([track('t1', 'c9', []), track('t2', 'c8', [{ t: 'x', box: BOX }]), { id: 't3' }], {}).peopleBetween(0, 100)).toBe(0);
  });
});

describe('faceClusterIdentity: input that makes no sense', () => {
  it('never throws, and sees nobody', () => {
    for (const tracks of JUNK) {
      for (const mapping of [undefined, null, {}, 'x', 7, [], { c1: 'P1' }]) {
        const identity = faceClusterIdentity(tracks, mapping);
        expect(identity.mode).toBe('face-cluster');
        expect(identity.visibleAt(1)).toEqual([]);
        expect(identity.visibleBetween(0, 100)).toEqual([]);
        expect(identity.peopleBetween(0, 100)).toBe(0);
        expect(identity.screenSeconds()).toEqual({});
      }
    }
  });

  it('ignores a track without usable samples', () => {
    for (const samples of [undefined, null, 'x', [], [null, 'x', {}], [{ t: 10 }], [{ t: 'x', box: BOX, conf: 1 }], [{ t: 10, box: [1, 2, 3], conf: 1 }], [{ t: -5, box: BOX, conf: 1 }]]) {
      const identity = faceClusterIdentity([track('t1', 'c1', samples)], { c1: 'P1' });
      expect(identity.visibleBetween(-Infinity, Infinity)).toEqual([]);
      expect(identity.screenSeconds()).toEqual({});
    }
  });

  it('keeps the good samples of a track that also has bad ones', () => {
    const identity = faceClusterIdentity(
      [track('t1', 'c1', [null, sample(10), { t: NaN, box: BOX, conf: 1 }, { t: 11, box: [0, 0, 0, 0], conf: 1 }, sample(12)])],
      { c1: 'P1' },
    );
    expect(identity.screenSeconds()).toEqual({ P1: 2 });
    expect(identity.visibleAt(11.2)[0].box).toEqual(BOX);
  });

  it('ignores a track whose cluster id is not a text or a number', () => {
    for (const cluster of [null, undefined, {}, ['c1'], true]) {
      expect(faceClusterIdentity([track('t1', cluster, [sample(10), sample(12)])], { c1: 'P1', null: 'P1', undefined: 'P1', true: 'P1' }).visibleBetween(0, 100)).toEqual([]);
    }
  });
});

describe('faceClusterIdentity: no shared state', () => {
  it('does not change the tracks or the mapping it is given', () => {
    const tracks = deepFreeze([track('t1', 'c1', [sample(12, 0.7, [1, 2, 30, 40]), sample(10, 0.9, [5, 6, 70, 80])])]);
    const mapping = deepFreeze({ c1: 'P1' });
    const identity = faceClusterIdentity(tracks, mapping);
    expect(identity.visibleAt(10)[0].box).toEqual([5, 6, 70, 80]);
    expect(tracks[0].samples.map((s) => s.t)).toEqual([12, 10]);
  });

  it('is not changed by what happens to its input or its answers afterwards', () => {
    const box = [5, 6, 70, 80];
    const tracks = [track('t1', 'c1', [{ t: 10, box, conf: 0.9 }, { t: 12, box, conf: 0.9 }])];
    const mapping = { c1: 'P1' };
    const identity = faceClusterIdentity(tracks, mapping);
    box[0] = 999;
    mapping.c1 = 'P9';
    tracks[0].samples.push(sample(50));
    const first = identity.visibleAt(11);
    expect(first).toEqual([{ characterId: 'P1', box: [5, 6, 70, 80], conf: 0.9, trackId: 't1' }]);
    first[0].box[1] = -1;
    expect(identity.visibleAt(11)[0].box).toEqual([5, 6, 70, 80]);
    expect(identity.visibleBetween(40, 60)).toEqual([]);
  });
});

describe('promptBankIdentity', () => {
  it('sees nobody at any moment', () => {
    const identity = promptBankIdentity();
    expect(identity.mode).toBe('prompt-bank');
    expect(identity.visibleAt(0)).toEqual([]);
    expect(identity.visibleAt(3600)).toEqual([]);
    expect(identity.visibleAt()).toEqual([]);
  });

  it('answers null, "cannot tell", when asked who was visible during a span: not an empty list, which would mean nobody', () => {
    const identity = promptBankIdentity();
    expect(identity.visibleBetween(0, 10)).toBeNull();
    expect(identity.visibleBetween(0, 7200)).toBeNull();
    expect(identity.visibleBetween()).toBeNull();
    expect(identity.visibleBetween(NaN, 'x')).toBeNull();
  });

  it('cannot count the people either: null, not 0', () => {
    const identity = promptBankIdentity();
    expect(identity.peopleBetween(0, 10)).toBeNull();
    expect(identity.peopleBetween()).toBeNull();
  });

  it('has no screen time to report', () => {
    expect(promptBankIdentity().screenSeconds()).toEqual({});
  });

  it('hands out a new answer every time', () => {
    const identity = promptBankIdentity();
    identity.visibleAt(1).push('junk');
    identity.screenSeconds().P1 = 5;
    expect(identity.visibleAt(1)).toEqual([]);
    expect(identity.screenSeconds()).toEqual({});
  });

  it('differs from the two modes that can tell: they answer with a list even when nobody is there', () => {
    expect(groundTruthIdentity([]).visibleBetween(0, 10)).toEqual([]);
    expect(faceClusterIdentity([], {}).visibleBetween(0, 10)).toEqual([]);
  });
});
