import { describe, expect, it } from 'vitest';
import { applyCorrections, correctedCue, cueRef, findCueIndex, replaceCue } from '../src/shared/revision.js';

const cue = (start, standard, extra = {}) => ({ start, gap: 3, kind: 'visual', priority: 1, brief: standard, standard, detailed: standard, ...extra });
const script = () => ({ version: 2, videoId: 'abcdefghijk', lang: 'en', cues: [cue(1, 'A door opens.'), cue(10, 'A woman smiles.'), cue(10, 'OPEN', { kind: 'text' }), cue(20, 'A dog runs.')], completedUntil: 300 });

describe('finding a marked description', () => {
  it('by start, kind and words', () => {
    const { cues } = script();
    expect(findCueIndex(cues, cueRef(cues[1]))).toBe(1);
    expect(findCueIndex(cues, cueRef(cues[2]))).toBe(2);
    // A little off in time is the same description; other words are not.
    expect(findCueIndex(cues, { start: 10.1, kind: 'visual', standard: 'A woman smiles.' })).toBe(1);
    expect(findCueIndex(cues, { start: 10, kind: 'visual', standard: 'A man smiles.' })).toBe(-1);
    expect(findCueIndex(cues, { start: 12, kind: 'visual', standard: 'A woman smiles.' })).toBe(-1);
    expect(findCueIndex(cues, { start: 'x' })).toBe(-1);
    expect(findCueIndex(null, cueRef(cues[0]))).toBe(-1);
  });

  it('refers to a cue with only what identifies it', () => {
    expect(cueRef({ ...cue(4, 'A cat.'), source: {}, gapMeasured: true })).toEqual({ start: 4, kind: 'visual', standard: 'A cat.' });
  });
});

describe('replacing a marked description', () => {
  it('puts the corrected one in its place, or removes it', () => {
    const sc = script();
    const fixed = cue(10, 'A man waves.', { revised: true });
    const out = replaceCue(sc, cueRef(sc.cues[1]), fixed);
    expect(out.cues.map((c) => c.standard)).toEqual(['A door opens.', 'A man waves.', 'OPEN', 'A dog runs.']);
    expect(out.completedUntil).toBe(300);
    expect(sc.cues[1].standard).toBe('A woman smiles.'); // not changed in place
    expect(replaceCue(sc, cueRef(sc.cues[3]), null).cues.map((c) => c.standard)).toEqual(['A door opens.', 'A woman smiles.', 'OPEN']);
    expect(replaceCue(sc, { start: 50, kind: 'visual', standard: 'gone' }, fixed)).toBe(sc);
  });

  it('applies saved corrections again to a copy saved without them, and only once', () => {
    const sc = script();
    const records = [
      { ...cueRef(sc.cues[1]), status: 'revised', replacement: cue(10, 'A man waves.', { revised: true }) },
      { ...cueRef(sc.cues[3]), status: 'removed', replacement: null },
      // Failed: the description stays as it was.
      { ...cueRef(sc.cues[0]), status: 'failed', error: 'quota' },
      // Corrected again later: follows on from the first correction.
      { start: 10, kind: 'visual', standard: 'A man waves.', status: 'revised', replacement: cue(10, 'A man in grey waves.', { revised: true }) },
    ];
    const once = applyCorrections(sc, records);
    expect(once.cues.map((c) => c.standard)).toEqual(['A door opens.', 'A man in grey waves.', 'OPEN']);
    expect(applyCorrections(once, records).cues).toEqual(once.cues);
    expect(applyCorrections(sc, [])).toBe(sc);
    expect(applyCorrections(null, records)).toBeNull();
  });
});

describe('the corrected description', () => {
  const old = cue(61.5, 'A woman in red smiles.', { gap: 2.5 });

  it('is the one nearest the marked moment, at its time and pause', () => {
    const out = correctedCue(old, [cue(55, 'Far away.'), cue(60, 'A man waves.', { gap: 9, confidence: 'high' })], 'en');
    expect(out).toMatchObject({ start: 61.5, gap: 2.5, standard: 'A man waves.', revised: true, confidence: 'high' });
  });

  it('is null when there is nothing to describe', () => {
    expect(correctedCue(old, [], 'en')).toBeNull();
  });

  it('is said to be uncertain when Gemini only says the same again', () => {
    const out = correctedCue(old, [cue(61, ' a woman in red  smiles. ', { confidence: 'high' })], 'zh-CN');
    expect(out).toMatchObject({ confidence: 'low', priority: 2, brief: '不太确定。 a woman in red  smiles. ' });
    // Already uncertain: not changed twice.
    const unsure = cue(61, 'A woman in red smiles.', { confidence: 'low', priority: 2, brief: 'Not certain. A woman in red smiles.' });
    expect(correctedCue(old, [unsure], 'en')).toMatchObject({ priority: 2, brief: 'Not certain. A woman in red smiles.' });
  });
});
