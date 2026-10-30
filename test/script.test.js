import { describe, expect, it } from 'vitest';
import {
  applyConfidence,
  chooseUtterance,
  cleanText,
  hedged,
  isHedged,
  passesDensity,
  cueAt,
  estimateSeconds,
  extractJson,
  mergeScript,
  normalizeChunk,
  parseTime,
  planChunks,
} from '../src/shared/script.js';
import { HEDGE_WORDS, LANGUAGES, UNCERTAIN_LEAD, ANSWER_AT } from '../src/shared/constants.js';
import { CueScheduler, pickOne } from '../src/shared/scheduler.js';
import { resolveLanguage } from '../src/shared/storage.js';
import { parseIsoDuration, videoIdFromUrl } from '../src/content/youtube.js';

const cue = (start, extra = {}) => ({
  start,
  gap: 3,
  kind: 'visual',
  priority: 2,
  brief: 'A door opens.',
  standard: 'A tall man opens the front door and steps inside.',
  detailed: 'A tall man in a grey raincoat opens the heavy front door, shakes off his umbrella and steps into the dim hallway.',
  ...extra,
});

describe('parseTime', () => {
  it.each([
    [12, 12],
    ['12', 12],
    ['12.5', 12.5],
    ['75s', 75],
    ['1:15', 75],
    ['01:02:03', 3723],
    ['1m15s', 75],
    ['1h2m', 3720],
  ])('%s -> %s', (input, out) => expect(parseTime(input)).toBe(out));
  it('rejects junk', () => {
    expect(parseTime('soon')).toBeNaN();
    expect(parseTime('')).toBeNaN();
    expect(parseTime(null)).toBeNaN();
  });
});

describe('cleanText', () => {
  it('strips markdown and quotes', () => {
    expect(cleanText('**"She smiles."**')).toBe('She smiles.');
    expect(cleanText('  - A   cat\n jumps ')).toBe('A cat jumps');
  });
  it('shortens long text at a sentence end', () => {
    const t = cleanText(`${'Word '.repeat(20)}ends here. ${'more '.repeat(40)}`, 120);
    expect(t.length).toBeLessThanOrEqual(121);
  });
});

describe('extractJson', () => {
  it('reads fenced and bare JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":2} thanks')).toEqual({ a: 2 });
  });
  it('throws on garbage', () => expect(() => extractJson('nope')).toThrow());
});

describe('normalizeChunk', () => {
  it('validates, sorts, fills missing variants and clamps', () => {
    const raw = {
      characters: [{ label: 'Maya' }, { label: 'maya' }, { name: 'The chef', description: 'white apron' }],
      cues: [
        { start: '0:20', gap: 2, kind: 'visual', priority: 1, standard: 'Maya waves.' },
        { start: 5, gap: 'x', kind: 'text', priority: 9, brief: 'Sign: Open', standard: '', detailed: '' },
        { start: 5.4, gap: 1, kind: 'text', priority: 1, brief: 'Sign: Open late' },
        { start: 999, standard: 'beyond the end' },
        { start: -3, standard: 'negative' },
        { start: 8, standard: '' },
        'junk',
      ],
    };
    const { cues, characters } = normalizeChunk(raw, { duration: 60 });
    expect(characters.map((c) => c.label)).toEqual(['Maya', 'The chef']);
    expect(cues.map((c) => c.start)).toEqual([5.4, 20]);
    const sign = cues[0];
    expect(sign.priority).toBe(1); // the more important duplicate wins
    expect(sign.brief).toBe('Sign: Open late');
    expect(sign.standard).toBe('Sign: Open late');
    const maya = cues[1];
    expect(maya.brief).toBe('Maya waves.');
    expect(maya.detailed).toBe('Maya waves.');
  });

  it('shifts clip-relative timestamps of a later chunk', () => {
    const raw = { cues: [{ start: 10, standard: 'a' }, { start: 200, standard: 'b' }] };
    const { cues } = normalizeChunk(raw, { duration: 2000, chunkStart: 480, chunkEnd: 960 });
    expect(cues.map((c) => c.start)).toEqual([490, 680]);
  });

  it('keeps absolute timestamps of a later chunk', () => {
    const raw = { cues: [{ start: 500, standard: 'a' }, { start: 900, standard: 'b' }] };
    const { cues } = normalizeChunk(raw, { duration: 2000, chunkStart: 480, chunkEnd: 960 });
    expect(cues.map((c) => c.start)).toEqual([500, 900]);
  });

  it('accepts a bare array', () => {
    expect(normalizeChunk([{ start: 1, standard: 'x' }]).cues).toHaveLength(1);
  });

  it('keeps the video type only when it is one SceneVoice has settings for', () => {
    expect(normalizeChunk({ videoType: 'tutorial', cues: [] }).videoType).toBe('tutorial');
    expect(normalizeChunk({ videoType: 'entertainment', cues: [] }).videoType).toBe('entertainment');
    expect(normalizeChunk({ videoType: 'other', cues: [] }).videoType).toBe('');
    expect(normalizeChunk({ videoType: 'constructor', cues: [] }).videoType).toBe('');
    expect(normalizeChunk([{ start: 1, standard: 'x' }]).videoType).toBe('');
  });
});

describe('confidence', () => {
  const raw = (confidence, extra = {}) => ({ cues: [{ start: 3, gap: 4, kind: 'visual', priority: 1, confidence, brief: 'A man holds a phone.', standard: 'A man holds a phone to his ear.', detailed: 'A man in a grey coat holds a phone to his ear.', ...extra }] });

  it('keeps what Gemini said, and drops anything else', () => {
    expect(normalizeChunk(raw('high')).cues[0].confidence).toBe('high');
    expect(normalizeChunk(raw('medium')).cues[0].confidence).toBe('medium');
    expect(normalizeChunk(raw('certain')).cues[0]).not.toHaveProperty('confidence');
    // Scripts from before: nothing is added or changed.
    const old = normalizeChunk(raw(undefined)).cues[0];
    expect(old).not.toHaveProperty('confidence');
    expect(old).toMatchObject({ priority: 1, brief: 'A man holds a phone.' });
  });

  it('makes a low-confidence description less important, and says it is not certain in every length', () => {
    const [cue] = normalizeChunk(raw('low'), { lang: 'en' }).cues;
    expect(cue).toMatchObject({
      confidence: 'low',
      priority: 2,
      brief: 'Not certain. A man holds a phone.',
      standard: 'Not certain. A man holds a phone to his ear.',
      detailed: 'Not certain. A man in a grey coat holds a phone to his ear.',
    });
    // With "essentials only" it is no longer heard; it never goes below "atmosphere".
    expect(passesDensity(cue, 'essential')).toBe(false);
    expect(normalizeChunk(raw('low', { priority: 3 })).cues[0].priority).toBe(3);
  });

  it('leaves the words alone where they already say it is not clear', () => {
    const [cue] = normalizeChunk(raw('low', { brief: 'He seems to hold a phone.', standard: 'He holds what appears to be a phone.' }), { lang: 'en' }).cues;
    expect(cue.brief).toBe('He seems to hold a phone.');
    expect(cue.standard).toBe('He holds what appears to be a phone.');
    expect(cue.detailed).toBe('Not certain. A man in a grey coat holds a phone to his ear.');
  });

  it('says it in the description language', () => {
    const zh = { brief: '一个男人拿着手机。', standard: '他手里好像拿着手机。', detailed: '画面很暗，看不清他手里拿的是什么。' };
    const [cue] = normalizeChunk(raw('low', zh), { lang: 'zh-CN' }).cues;
    expect(cue.brief).toBe('不太确定。一个男人拿着手机。');
    expect(cue.standard).toBe(zh.standard);
    expect(cue.detailed).toBe(zh.detailed);
    expect(hedged('Un hombre sostiene un teléfono.', 'es')).toBe('No está claro. Un hombre sostiene un teléfono.');
    expect(hedged('Un hombre parece sostener un teléfono.', 'es')).toBe('Un hombre parece sostener un teléfono.');
  });

  it('marks on-screen text that could not be read in full', () => {
    const [cue] = normalizeChunk({ cues: [{ start: 1, kind: 'text', priority: 1, confidence: 'low', onScreenText: 'OPEN …', brief: 'Sign: OPEN …', standard: 'Sign: OPEN …, the rest is hard to read' }] }, { lang: 'en' }).cues;
    expect(cue).toMatchObject({ kind: 'text', priority: 2, onScreenText: 'OPEN …', brief: 'Not certain. Sign: OPEN …', standard: 'Sign: OPEN …, the rest is hard to read' });
    // Text gets one step more: still read with "essentials only".
    expect(passesDensity(cue, 'essential')).toBe(true);
  });

  it('applies once: a description already said to be uncertain is not changed again', () => {
    const once = applyConfidence({ priority: 1, confidence: 'low', brief: 'A dog.', standard: 'A dog runs.', detailed: 'A dog runs.' }, 'en');
    expect(once.brief).toBe('Not certain. A dog.');
    expect(hedged(once.brief, 'en')).toBe(once.brief);
    expect(applyConfidence({ priority: 1, confidence: 'high', brief: 'A dog.' }, 'en')).toEqual({ priority: 1, confidence: 'high', brief: 'A dog.' });
  });

  it('has words for every description language', () => {
    for (const { code } of LANGUAGES) {
      expect(UNCERTAIN_LEAD[code], code).toBeTruthy();
      expect(ANSWER_AT[code], code).toContain('$1');
      expect(HEDGE_WORDS[code]?.length, code).toBeGreaterThan(2);
      // The lead counts as saying so, so it is never added twice.
      expect(isHedged(UNCERTAIN_LEAD[code], code), code).toBe(true);
      for (const w of HEDGE_WORDS[code]) expect(w, code).toBe(w.toLowerCase());
    }
  });
});

describe('mergeScript', () => {
  it('merges cues and characters and tracks progress', () => {
    const base = { cues: [cue(1)], characters: [{ label: 'Ann' }], completedUntil: 480 };
    const merged = mergeScript(base, { cues: [cue(500), cue(1.4)], characters: [{ label: 'ann' }, { label: 'Bo' }] }, 960);
    expect(merged.cues.map((c) => c.start)).toEqual([1, 500]);
    expect(merged.characters.map((c) => c.label)).toEqual(['Ann', 'Bo']);
    expect(merged.completedUntil).toBe(960);
  });

  it('takes the video type from the first section that names one', () => {
    const first = mergeScript({ cues: [], characters: [] }, { cues: [], characters: [], videoType: '' }, 300);
    expect(first.videoType).toBe('');
    const second = mergeScript(first, { cues: [], characters: [], videoType: 'tutorial' }, 600);
    expect(second.videoType).toBe('tutorial');
    expect(mergeScript(second, { cues: [], characters: [], videoType: 'entertainment' }, 900).videoType).toBe('tutorial');
  });
});

describe('planChunks', () => {
  it('splits and folds a short remainder into the last chunk', () => {
    expect(planChunks(1000, 480)).toEqual([
      { start: 0, end: 480 },
      { start: 480, end: 1000 },
    ]);
    expect(planChunks(1100, 480)).toEqual([
      { start: 0, end: 480 },
      { start: 480, end: 960 },
      { start: 960, end: 1100 },
    ]);
  });
  it('resumes from a point', () => {
    expect(planChunks(1000, 480, 480)).toEqual([{ start: 480, end: 1000 }]);
    expect(planChunks(1000, 480, 1000)).toEqual([]);
  });
  it('handles short videos and bad input', () => {
    expect(planChunks(45, 480)).toEqual([{ start: 0, end: 45 }]);
    expect(() => planChunks(Infinity, 480)).toThrow();
    expect(() => planChunks(0, 480)).toThrow();
  });
});

describe('estimateSeconds', () => {
  it('counts words for English and characters for Chinese', () => {
    expect(estimateSeconds('one two three four five six')).toBeCloseTo(6 / 2.8 + 0.25, 2);
    expect(estimateSeconds('一位女人走进房间')).toBeCloseTo(8 / 4.5 + 0.25, 2);
    expect(estimateSeconds('abc', 2)).toBeLessThan(estimateSeconds('abc', 1));
    expect(estimateSeconds('')).toBe(0);
  });
});

describe('chooseUtterance', () => {
  it('gaps mode picks the longest version that fits', () => {
    const c = cue(0, { gap: 6 });
    expect(chooseUtterance(c, { mode: 'gaps', detail: 'detailed', rate: 1, onScreenText: true }).text).toBe(c.standard);
    const roomy = cue(0, { gap: 20 });
    expect(chooseUtterance(roomy, { mode: 'gaps', detail: 'detailed', rate: 1, onScreenText: true }).text).toBe(roomy.detailed);
    expect(chooseUtterance(roomy, { mode: 'gaps', detail: 'brief', rate: 1, onScreenText: true }).text).toBe(roomy.brief);
  });
  it('gaps mode skips a cue that does not fit, however important', () => {
    const tight = cue(0, { gap: 0.2, brief: 'A very long brief description that will not fit at all here' });
    for (const priority of [1, 2, 3]) {
      expect(chooseUtterance({ ...tight, priority }, { mode: 'gaps', detail: 'standard', rate: 1, onScreenText: true })).toBeNull();
    }
  });
  it('pause mode pauses for a cue that does not fit instead of skipping it', () => {
    const tight = cue(0, { gap: 0.2, priority: 1 });
    const u = chooseUtterance(tight, { mode: 'pause', detail: 'standard', rate: 1, onScreenText: true });
    expect(u).toEqual({ text: tight.standard, needsPause: true });
  });
  it('a gap measured from captions gets no extra leeway', () => {
    // "A door opens." takes about 1.3 s at rate 1.
    const c = cue(0, { gap: 1.2 });
    expect(chooseUtterance(c, { mode: 'gaps', detail: 'brief', rate: 1, onScreenText: true }).text).toBe(c.brief);
    expect(chooseUtterance({ ...c, gapMeasured: true }, { mode: 'gaps', detail: 'brief', rate: 1, onScreenText: true })).toBeNull();
    expect(chooseUtterance({ ...c, gapMeasured: true }, { mode: 'pause', detail: 'brief', rate: 1, onScreenText: true }).needsPause).toBe(true);
  });
  it('pause mode pauses only when needed', () => {
    expect(chooseUtterance(cue(0, { gap: 1 }), { mode: 'pause', detail: 'detailed', rate: 1, onScreenText: true }).needsPause).toBe(true);
    expect(chooseUtterance(cue(0, { gap: 30 }), { mode: 'pause', detail: 'detailed', rate: 1, onScreenText: true }).needsPause).toBe(false);
  });
  it('faster readers fit more', () => {
    const c = cue(0, { gap: 3 });
    expect(chooseUtterance(c, { mode: 'gaps', detail: 'detailed', rate: 1, onScreenText: true }).text).toBe(c.brief);
    expect(chooseUtterance(c, { mode: 'gaps', detail: 'detailed', rate: 2, onScreenText: true }).text).toBe(c.standard);
    expect(chooseUtterance(c, { mode: 'gaps', detail: 'detailed', rate: 3, onScreenText: true }).text).toBe(c.detailed);
  });
  it('respects the on-screen text setting', () => {
    expect(chooseUtterance(cue(0, { kind: 'text' }), { mode: 'gaps', detail: 'standard', rate: 1, onScreenText: false })).toBeNull();
  });
});

describe('cueAt', () => {
  it('finds the cue for the current moment', () => {
    const cues = [cue(1), cue(10), cue(20)];
    expect(cueAt(cues, 0)).toBeNull();
    expect(cueAt(cues, 12).start).toBe(10);
    expect(cueAt(cues, 9.7).start).toBe(10);
  });
});

describe('CueScheduler', () => {
  const cues = [cue(0), cue(2), cue(5), cue(9)];

  it('fires cues as time passes, once each', () => {
    const s = new CueScheduler(cues);
    expect(s.tick(0.1).map((c) => c.start)).toEqual([0]);
    expect(s.tick(1)).toEqual([]);
    expect(s.tick(2.1).map((c) => c.start)).toEqual([2]);
    expect(s.tick(2.2)).toEqual([]);
    expect(s.tick(4)).toEqual([]);
    expect(s.tick(5.05).map((c) => c.start)).toEqual([5]);
  });

  it('does not flood after a forward seek', () => {
    const s = new CueScheduler(cues);
    s.tick(0.5);
    expect(s.tick(8)).toEqual([]);
    expect(s.tick(9.1).map((c) => c.start)).toEqual([9]);
  });

  it('replays after seeking backwards and when a Short loops', () => {
    const s = new CueScheduler(cues);
    s.tick(0.1);
    s.tick(2.1);
    s.tick(3);
    expect(s.tick(1)).toEqual([]); // seek back: silent
    expect(s.tick(2.05).map((c) => c.start)).toEqual([2]); // fires again
    s.tick(9.5);
    expect(s.tick(0.05).map((c) => c.start)).toEqual([0]); // loop to start
  });

  it('starts silently mid-video but fires at the very start', () => {
    const s = new CueScheduler(cues);
    expect(s.tick(4.9)).toEqual([]);
    expect(s.tick(5.1).map((c) => c.start)).toEqual([5]);
    const s2 = new CueScheduler(cues);
    expect(s2.tick(0.3).map((c) => c.start)).toEqual([0]);
  });

  it('pickOne prefers importance, then the latest', () => {
    expect(pickOne([cue(1, { priority: 2 }), cue(2, { priority: 1 }), cue(3, { priority: 2 })]).start).toBe(2);
    expect(pickOne([cue(1), cue(3)]).start).toBe(3);
    expect(pickOne([])).toBeNull();
  });
});

describe('resolveLanguage', () => {
  it('maps browser languages', () => {
    expect(resolveLanguage('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveLanguage('auto', 'zh-HK')).toBe('zh-TW');
    expect(resolveLanguage('auto', 'zh_TW')).toBe('zh-TW');
    expect(resolveLanguage('auto', 'en-GB')).toBe('en');
    expect(resolveLanguage('auto', 'fr-CA')).toBe('fr');
    expect(resolveLanguage('auto', 'xx')).toBe('en');
    expect(resolveLanguage('ja', 'en')).toBe('ja');
  });
});

describe('youtube helpers', () => {
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT4M13S')).toBe(253);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('')).toBeNaN();
    expect(parseIsoDuration(undefined)).toBeNaN();
  });
  it('extracts video ids', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromUrl('https://www.youtube.com/')).toBeNull();
    expect(videoIdFromUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(videoIdFromUrl('not a url')).toBeNull();
  });
});

describe('passesDensity', () => {
  it('filters by priority without regenerating', () => {
    expect([1, 2, 3].map((priority) => passesDensity({ priority }, 'essential'))).toEqual([true, false, false]);
    expect([1, 2, 3].map((priority) => passesDensity({ priority }, 'standard'))).toEqual([true, true, false]);
    expect([1, 2, 3].map((priority) => passesDensity({ priority }, 'full'))).toEqual([true, true, true]);
    expect(passesDensity({ priority: 3 }, undefined)).toBe(true);
  });
});
