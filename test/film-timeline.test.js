import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSrt } from '../src/film/subs.js';
import { budgetFor, buildSlots, slotAt, slotsBetween, speechFromLines, unionIntervals } from '../src/film/timeline.js';
import { DEFAULT_RATE } from '../src/film/types.js';
import { estimateSeconds } from '../src/shared/script.js';

/** Freeze a value all the way down: a function that changed its argument would throw. */
function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

const chinese = (count) => '字'.repeat(count);
const english = (count) => Array(count).fill('word').join(' ');

describe('unionIntervals', () => {
  it('sorts and merges two lists that overlap each other', () => {
    const a = [{ start: 10, end: 20 }, { start: 0, end: 2 }];
    const b = [{ start: 15, end: 25 }, { start: 30, end: 31 }];
    expect(unionIntervals(a, b)).toEqual([
      { start: 0, end: 2 },
      { start: 10, end: 25 },
      { start: 30, end: 31 },
    ]);
  });

  it('puts one unsorted, self-overlapping list in order', () => {
    const speech = [{ start: 10, end: 20 }, { start: 5, end: 8 }, { start: 7, end: 9 }, { start: 12, end: 15 }];
    expect(unionIntervals(speech, [])).toEqual([
      { start: 5, end: 9 },
      { start: 10, end: 20 },
    ]);
    expect(unionIntervals(speech)).toEqual(unionIntervals(speech, []));
    expect(unionIntervals([], speech)).toEqual(unionIntervals(speech, []));
  });

  it('keeps the longer end when one interval lies inside another', () => {
    expect(unionIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 3 }])).toEqual([{ start: 0, end: 10 }]);
  });

  it('merges intervals that touch, and keeps apart those with any pause between them', () => {
    expect(unionIntervals([{ start: 0, end: 1 }], [{ start: 1, end: 2 }])).toEqual([{ start: 0, end: 2 }]);
    expect(unionIntervals([{ start: 0, end: 1 }], [{ start: 1.01, end: 2 }])).toEqual([
      { start: 0, end: 1 },
      { start: 1.01, end: 2 },
    ]);
  });

  it('closes pauses shorter than join, and no longer ones', () => {
    const a = [{ start: 0, end: 1 }, { start: 5, end: 6 }];
    const b = [{ start: 1.4, end: 2 }, { start: 2.5, end: 3 }];
    expect(unionIntervals(a, b, 0.5)).toEqual([
      { start: 0, end: 2 },
      { start: 2.5, end: 3 },
      { start: 5, end: 6 },
    ]);
    expect(unionIntervals(a, b, 0.6)).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
    ]);
    expect(unionIntervals(a, b, 10)).toEqual([{ start: 0, end: 6 }]);
  });

  it('leaves out entries without a length or without numbers', () => {
    const odd = [{ start: 3, end: 3 }, { start: 5, end: 4 }, { start: NaN, end: 2 }, { start: 1, end: Infinity }, null, undefined, {}, { start: 6, end: 7 }];
    expect(unionIntervals(odd, [])).toEqual([{ start: 6, end: 7 }]);
  });

  it('returns an empty list for empty or missing lists', () => {
    expect(unionIntervals([], [])).toEqual([]);
    expect(unionIntervals()).toEqual([]);
    expect(unionIntervals(null, undefined)).toEqual([]);
    expect(unionIntervals('nonsense', 7)).toEqual([]);
  });

  it('returns new objects with start and end only, and leaves its arguments alone', () => {
    const a = frozen([{ start: 0, end: 2, text: 'kept out' }]);
    const b = frozen([{ start: 1, end: 3 }]);
    const out = unionIntervals(a, b);
    expect(out).toEqual([{ start: 0, end: 3 }]);
    expect(out[0]).not.toBe(a[0]);
    expect(a).toEqual([{ start: 0, end: 2, text: 'kept out' }]);
  });
});

describe('speechFromLines', () => {
  const lines = [
    { start: 1, end: 2, text: 'Hello.' },
    { start: 2.2, end: 3, text: 'How are you?' },
    { start: 3.5, end: 4, text: '我很好。' },
    { start: 10, end: 12, text: '再见。' },
  ];

  it('joins lines with less than 0.3 seconds between them into one stretch of speech', () => {
    // 2 -> 2.2 is closed (0.2 s); 3 -> 3.5 is a pause.
    expect(speechFromLines(lines)).toEqual([
      { start: 1, end: 3 },
      { start: 3.5, end: 4 },
      { start: 10, end: 12 },
    ]);
  });

  it('takes the join from its options', () => {
    expect(speechFromLines(lines, { join: 0.6 })).toEqual([
      { start: 1, end: 4 },
      { start: 10, end: 12 },
    ]);
    expect(speechFromLines(lines, { join: 0 })).toHaveLength(4);
    expect(speechFromLines(lines, {})).toEqual(speechFromLines(lines));
    expect(speechFromLines(lines, { join: NaN })).toEqual(speechFromLines(lines));
  });

  it('keeps a pause that is exactly as long as the join', () => {
    const quarter = [
      { start: 1, end: 2, text: 'A' },
      { start: 2.25, end: 3, text: 'B' },
    ];
    expect(speechFromLines(quarter, { join: 0.25 })).toHaveLength(2);
    expect(speechFromLines(quarter, { join: 0.26 })).toEqual([{ start: 1, end: 3 }]);
  });

  it('does not count lines that only label a sound', () => {
    const withSounds = [
      { start: 0, end: 5, text: '[Music]' },
      { start: 6, end: 7, text: 'Hello.' },
      { start: 8, end: 9, text: '（掌声）' },
      { start: 10, end: 11, text: '♪♪' },
      { start: 12, end: 13, text: '你好。' },
    ];
    expect(speechFromLines(withSounds)).toEqual([
      { start: 6, end: 7 },
      { start: 12, end: 13 },
    ]);
  });

  it('sorts unsorted lines and merges overlapping ones', () => {
    const tangled = [
      { start: 5, end: 9, text: 'B' },
      { start: 1, end: 6, text: 'A' },
      { start: 6.5, end: 7, text: 'C' },
    ];
    expect(speechFromLines(tangled)).toEqual([{ start: 1, end: 9 }]);
  });

  it('returns an empty list for no lines, and skips lines without a length', () => {
    expect(speechFromLines([])).toEqual([]);
    expect(speechFromLines(undefined)).toEqual([]);
    expect(speechFromLines(null, { join: 1 })).toEqual([]);
    expect(speechFromLines([{ start: 2, end: 2, text: 'x' }, { start: NaN, end: 3, text: 'y' }, null])).toEqual([]);
  });

  it('leaves the lines it was given alone', () => {
    const given = frozen(lines.map((l) => ({ ...l })));
    speechFromLines(given);
    expect(given).toEqual(lines);
  });

  it('reads what the subtitle parsers return', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n2\n00:00:02,100 --> 00:00:03,000\n你好。\n\n3\n00:00:08,000 --> 00:00:09,500\n[door slams]\n';
    expect(speechFromLines(parseSrt(srt))).toEqual([{ start: 1, end: 3 }]);
  });
});

describe('budgetFor', () => {
  it('counts characters for Chinese, Japanese and Korean, and words for other languages', () => {
    for (const lang of ['zh', 'zh-CN', 'zh-TW', 'ZH-Hans', 'ja', 'ja-JP', 'ko', 'ko-KR', 'yue', 'cmn']) {
      expect(budgetFor(10, lang).units).toBe('chars');
    }
    for (const lang of ['en', 'en-US', 'fr', 'de', 'es', 'ru', '', undefined, null]) {
      expect(budgetFor(10, lang).units).toBe('words');
    }
  });

  it('reads the spelling of the locale files too: zh_CN is Chinese, as the name gate and the prompts take it', () => {
    for (const lang of ['zh_CN', 'ZH_cn', 'zh_Hans_CN', 'ja_JP', 'ko_KR', 'yue_HK', 'cmn_Hans']) {
      expect(budgetFor(10, lang).units, lang).toBe('chars');
    }
    expect(budgetFor(6, 'zh_CN')).toEqual(budgetFor(6, 'zh-CN'));
    expect(buildSlots([{ start: 5, end: 8 }], 20, { lang: 'zh_CN' })).toEqual(buildSlots([{ start: 5, end: 8 }], 20, { lang: 'zh-CN' }));
    // A longer code that only begins with the same letters is another language.
    for (const lang of ['zhx', 'kok', 'jam', 'jav', 'en_US']) {
      expect(budgetFor(10, lang).units, lang).toBe('words');
    }
  });

  it('gives the full count as detailed: floor((room - 0.25) x 4.5) characters or x 2.8 words', () => {
    expect(budgetFor(10, 'zh-CN')).toEqual({ units: 'chars', brief: 14, standard: 28, detailed: 43 });
    expect(budgetFor(10, 'en')).toEqual({ units: 'words', brief: 9, standard: 18, detailed: 27 });
    expect(budgetFor(2.25, 'zh')).toEqual({ units: 'chars', brief: 3, standard: 6, detailed: 9 });
    expect(budgetFor(5.25, 'en')).toEqual({ units: 'words', brief: 4, standard: 9, detailed: 14 });
  });

  it('gives two thirds as standard and one third as brief, rounded down', () => {
    for (const lang of ['zh', 'en']) {
      for (let room = 0; room <= 60; room += 0.7) {
        const b = budgetFor(room, lang);
        expect(b.standard).toBe(Math.floor((b.detailed * 2) / 3));
        expect(b.brief).toBe(Math.floor(b.detailed / 3));
        expect(b.brief).toBeLessThanOrEqual(b.standard);
        expect(b.standard).toBeLessThanOrEqual(b.detailed);
        for (const n of [b.brief, b.standard, b.detailed]) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('is zero when there is no room, never negative', () => {
    const none = { brief: 0, standard: 0, detailed: 0 };
    for (const room of [0, 0.1, 0.25, -3, NaN, undefined, null, Infinity, -Infinity, 'long']) {
      expect(budgetFor(room, 'zh')).toEqual({ units: 'chars', ...none });
      expect(budgetFor(room, 'en')).toEqual({ units: 'words', ...none });
    }
    // The first character needs the quarter second of lead and its own time.
    expect(budgetFor(0.47, 'zh').detailed).toBe(0);
    expect(budgetFor(0.48, 'zh').detailed).toBe(1);
    expect(budgetFor(0.6, 'en').detailed).toBe(0);
    expect(budgetFor(0.61, 'en').detailed).toBe(1);
  });

  it('grows with the speaking speed', () => {
    expect(budgetFor(10, 'zh', { speed: 2 })).toEqual({ units: 'chars', brief: 29, standard: 58, detailed: 87 });
    expect(budgetFor(10, 'en', { speed: 2 })).toEqual({ units: 'words', brief: 18, standard: 36, detailed: 54 });
    expect(budgetFor(10, 'zh', { speed: 0.5 }).detailed).toBe(21);
    expect(budgetFor(10, 'zh', { speed: 1 })).toEqual(budgetFor(10, 'zh'));
    expect(budgetFor(10, 'zh', {})).toEqual(budgetFor(10, 'zh'));
  });

  it('treats the speed as estimateSeconds does: nothing below 0.3, and 1 for none', () => {
    expect(budgetFor(10, 'zh', { speed: 0.1 })).toEqual(budgetFor(10, 'zh', { speed: 0.3 }));
    expect(budgetFor(10, 'en', { speed: -2 })).toEqual(budgetFor(10, 'en', { speed: 0.3 }));
    for (const speed of [0, NaN, undefined, null, Infinity]) {
      expect(budgetFor(10, 'zh', { speed })).toEqual(budgetFor(10, 'zh'));
    }
  });

  it('takes another rate, and the default for fields that are missing or impossible', () => {
    const rate = { cjkPerSec: 5, wordsPerSec: 3, lead: 0 };
    expect(budgetFor(2, 'zh', { rate }).detailed).toBe(10);
    expect(budgetFor(2, 'en', { rate }).detailed).toBe(6);
    expect(budgetFor(2.25, 'zh', { rate: { cjkPerSec: 6 } }).detailed).toBe(12);
    expect(budgetFor(10, 'zh', { rate: DEFAULT_RATE })).toEqual(budgetFor(10, 'zh'));
    for (const bad of [{ cjkPerSec: 0, wordsPerSec: -1, lead: -1 }, { cjkPerSec: NaN, wordsPerSec: 'fast' }, null, 2]) {
      expect(budgetFor(10, 'zh', { rate: bad })).toEqual(budgetFor(10, 'zh'));
      expect(budgetFor(10, 'en', { rate: bad })).toEqual(budgetFor(10, 'en'));
    }
  });

  it('is the inverse of estimateSeconds for Chinese: the detailed budget fits the room, one character more does not', () => {
    for (const speed of [0.5, 0.8, 1, 1.25, 1.5, 2, 3]) {
      for (let i = 0; i <= 800; i += 1) {
        const room = i * 0.05;
        const { detailed, standard, brief } = budgetFor(room, 'zh-CN', { speed });
        expect(estimateSeconds(chinese(detailed), speed)).toBeLessThanOrEqual(room);
        expect(estimateSeconds(chinese(standard), speed)).toBeLessThanOrEqual(room);
        expect(estimateSeconds(chinese(brief), speed)).toBeLessThanOrEqual(room);
        expect(estimateSeconds(chinese(detailed + 1), speed)).toBeGreaterThan(room);
      }
    }
  });

  it('is the inverse of estimateSeconds for English: the detailed budget fits the room, one word more does not', () => {
    for (const speed of [0.5, 0.8, 1, 1.25, 1.5, 2, 3]) {
      for (let i = 0; i <= 800; i += 1) {
        const room = i * 0.05;
        const { detailed, standard, brief } = budgetFor(room, 'en', { speed });
        expect(estimateSeconds(english(detailed), speed)).toBeLessThanOrEqual(room);
        expect(estimateSeconds(english(standard), speed)).toBeLessThanOrEqual(room);
        expect(estimateSeconds(english(brief), speed)).toBeLessThanOrEqual(room);
        expect(estimateSeconds(english(detailed + 1), speed)).toBeGreaterThan(room);
      }
    }
  });

  it('agrees with estimateSeconds where the room is exactly the time of a whole count', () => {
    // Rooms built from the forward formula: the product (room - lead) x rate can land a hair under the count.
    for (const speed of [0.7, 1, 1.3, 1.7]) {
      for (let n = 1; n <= 300; n += 1) {
        expect(budgetFor(estimateSeconds(chinese(n), speed), 'zh', { speed }).detailed).toBe(n);
        expect(budgetFor(estimateSeconds(english(n), speed), 'en', { speed }).detailed).toBe(n);
      }
    }
  });

  it('leaves its options alone', () => {
    const options = frozen({ rate: { cjkPerSec: 5, wordsPerSec: 3, lead: 0.2 }, speed: 1.5 });
    expect(() => budgetFor(8, 'zh', options)).not.toThrow();
    expect(options).toEqual({ rate: { cjkPerSec: 5, wordsPerSec: 3, lead: 0.2 }, speed: 1.5 });
  });
});

describe('budgetFor and buildSlots: numbers too large to count with', () => {
  // The cases below never returned: the count could not be lowered by one. A regression would hang the
  // test run, so each is run in a process of its own that is stopped after a few seconds.
  const timeline = pathToFileURL(fileURLToPath(new URL('../src/film/timeline.js', import.meta.url))).href;
  const prompts = pathToFileURL(fileURLToPath(new URL('../src/film/prompts.js', import.meta.url))).href;
  const run = (expression) => {
    const code = `import { budgetFor, buildSlots } from ${JSON.stringify(timeline)}; import { sectionPrompt } from ${JSON.stringify(prompts)}; console.log(JSON.stringify(${expression}));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 8000, encoding: 'utf8' });
    return { finished: child.status === 0 && !child.error, out: child.status === 0 ? JSON.parse(child.stdout) : null };
  };
  const whole = (budget) => ['brief', 'standard', 'detailed'].every((v) => Number.isSafeInteger(budget[v]) && budget[v] >= 0);

  it.each([
    ['a room of 1e308 seconds', "budgetFor(1e308, 'en')"],
    ['the same in Chinese', "budgetFor(1e308, 'zh-CN')"],
    ['a room of 1e300 seconds', "budgetFor(1e300, 'en')"],
    ['a room of 1.7e16 seconds', "budgetFor(1.7e16, 'en')"],
    ['a speed of 1e308', "budgetFor(5, 'en', { speed: 1e308 })"],
    ['a rate of 1e308 words a second', "budgetFor(5, 'en', { rate: { wordsPerSec: 1e308 } })"],
    ['a rate and a speed that overflow together', "budgetFor(5, 'zh', { rate: { cjkPerSec: 1e200 }, speed: 1e200 })"],
  ])('returns whole numbers for %s', (_, expression) => {
    const { finished, out } = run(expression);
    expect(finished).toBe(true);
    expect(whole(out)).toBe(true);
    expect(out.detailed).toBe(Number.MAX_SAFE_INTEGER);
    expect(out.standard).toBeLessThanOrEqual(out.detailed);
    expect(out.brief).toBeLessThanOrEqual(out.standard);
  }, 20000);

  it.each([
    ['a film of 1.7e16 seconds', "buildSlots([], 1.7e16, { lang: 'en' })"],
    ['an ordinary film at a speed of 1e308', "buildSlots([], 60, { lang: 'en', speed: 1e308 })"],
    ['a film of 1e308 seconds', "buildSlots([], 1e308, { lang: 'en' })"],
  ])('builds the slot of %s', (_, expression) => {
    const { finished, out } = run(expression);
    expect(finished).toBe(true);
    expect(out).toHaveLength(1);
    expect(whole(out[0].budget)).toBe(true);
  }, 20000);

  it('writes a section prompt for a slot of 1e308 seconds that carries no budget', () => {
    const { finished, out } = run("sectionPrompt({ lang: 'en', window: { start: 0, end: 60 }, frames: [], legend: '', dialogue: [], slots: [{ id: 'g_0001', start: 0, end: 5, room: 1e308 }], previous: [] }).text.includes('g_0001')");
    expect(finished).toBe(true);
    expect(out).toBe(true);
  }, 20000);

  it('changes no ordinary budget', () => {
    expect(budgetFor(10, 'zh-CN')).toEqual({ units: 'chars', brief: 14, standard: 28, detailed: 43 });
    expect(budgetFor(4000, 'en', { speed: 4 })).toEqual({ units: 'words', brief: 14932, standard: 29864, detailed: 44797 });
    expect(budgetFor(1e12, 'en').detailed).toBe(2799999999999);
  });
});

describe('buildSlots', () => {
  const speech = [
    { start: 5, end: 8 },
    { start: 10, end: 20 },
  ];

  it('makes a slot of each pause, lead after speech ends and tail before it resumes', () => {
    const slots = buildSlots(speech, 30, { lang: 'en' });
    expect(slots.map(({ id, start, end, room }) => ({ id, start, end, room }))).toEqual([
      { id: 'g_0001', start: 0, end: 4.7, room: 4.7 },
      { id: 'g_0002', start: 8.1, end: 9.7, room: 1.6 },
      { id: 'g_0003', start: 20.1, end: 30, room: 9.9 },
    ]);
  });

  it('counts the stretch before the first speech from 0 and the stretch after the last up to the duration', () => {
    const slots = buildSlots([{ start: 50, end: 60 }], 100);
    expect(slots.map((s) => [s.start, s.end])).toEqual([
      [0, 49.7],
      [60.1, 100],
    ]);
  });

  it('takes lead and tail from its options', () => {
    // The middle pause would run from 8.5 to 9: half a second, less than minGap.
    const slots = buildSlots(speech, 30, { lead: 0.5, tail: 1 });
    expect(slots.map((s) => [s.start, s.end, s.room])).toEqual([
      [0, 4, 4],
      [20.5, 30, 9.5],
    ]);
    const none = buildSlots(speech, 30, { lead: 0, tail: 0 });
    expect(none.map((s) => [s.start, s.end, s.room])).toEqual([
      [0, 5, 5],
      [8, 10, 2],
      [20, 30, 10],
    ]);
  });

  it('leaves out slots with less room than minGap, and keeps one with exactly that much', () => {
    // 5 -> 6.4: starts at 5.1, ends at 6.1, exactly one second.
    const exact = buildSlots([{ start: 0, end: 5 }, { start: 6.4, end: 10 }], 10);
    expect(exact.map((s) => [s.start, s.end, s.room])).toEqual([[5.1, 6.1, 1]]);
    const short = buildSlots([{ start: 0, end: 5 }, { start: 6.39, end: 10 }], 10);
    expect(short).toEqual([]);
    const speechHere = [{ start: 2, end: 5 }, { start: 6, end: 10 }, { start: 13, end: 19.5 }];
    expect(buildSlots(speechHere, 20, { minGap: 2 }).map((s) => [s.start, s.end])).toEqual([[10.1, 12.7]]);
    expect(buildSlots(speechHere, 20, { minGap: 0.5 }).map((s) => [s.start, s.end])).toEqual([
      [0, 1.7],
      [5.1, 5.7],
      [10.1, 12.7],
    ]);
    expect(buildSlots(speechHere, 20, { minGap: 0 }).map((s) => s.room)).toEqual([1.7, 0.6, 2.6, 0.4]);
  });

  it('numbers the slots in time order after the short ones are left out', () => {
    const many = Array.from({ length: 12 }, (unused, i) => ({ start: 10 * i + 5, end: 10 * i + 10 }));
    const slots = buildSlots([...many, { start: 3, end: 4.5 }], 120);
    expect(slots.map((s) => s.id)).toEqual(['g_0001', 'g_0002', 'g_0003', 'g_0004', 'g_0005', 'g_0006', 'g_0007', 'g_0008', 'g_0009', 'g_0010', 'g_0011', 'g_0012']);
    expect(slots.every((s) => /^g_\d{4}$/.test(s.id))).toBe(true);
    const starts = slots.map((s) => s.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('puts unsorted and overlapping speech in order first', () => {
    const tangled = [{ start: 10, end: 20 }, { start: 5, end: 8 }, { start: 7, end: 9 }, { start: 12, end: 15 }];
    // Speech is 5-9 and 10-20: the pause between them has 0.6 s of room.
    expect(buildSlots(tangled, 30).map((s) => [s.start, s.end])).toEqual([
      [0, 4.7],
      [20.1, 30],
    ]);
    expect(buildSlots(tangled, 30)).toEqual(buildSlots(unionIntervals(tangled, []), 30));
  });

  it('gives every slot the budget of its room in the language, rate and speed given', () => {
    for (const options of [{ lang: 'zh-CN' }, { lang: 'en' }, { lang: 'zh-CN', speed: 1.5 }, { lang: 'en', rate: { wordsPerSec: 3.5 } }, {}]) {
      const slots = buildSlots(speech, 30, options);
      expect(slots).toHaveLength(3);
      for (const slot of slots) {
        expect(slot.budget).toEqual(budgetFor(slot.room, options.lang, { rate: options.rate, speed: options.speed }));
      }
    }
    expect(buildSlots(speech, 30, { lang: 'zh-CN' })[0].budget).toEqual({ units: 'chars', brief: 6, standard: 13, detailed: 20 });
    expect(buildSlots(speech, 30, { lang: 'en' })[0].budget).toEqual({ units: 'words', brief: 4, standard: 8, detailed: 12 });
    expect(buildSlots(speech, 30)[0].budget.units).toBe('words');
  });

  it('has room for the detailed budget of every slot, by estimateSeconds', () => {
    const zh = buildSlots(speech, 30, { lang: 'zh', speed: 1.2 });
    for (const slot of zh) expect(estimateSeconds(chinese(slot.budget.detailed), 1.2)).toBeLessThanOrEqual(slot.room);
    const en = buildSlots(speech, 30, { lang: 'en', speed: 1.2 });
    for (const slot of en) expect(estimateSeconds(english(slot.budget.detailed), 1.2)).toBeLessThanOrEqual(slot.room);
  });

  it('gives each slot exactly the fields of a Slot, with room = end - start', () => {
    const slots = buildSlots(speech, 30, { lang: 'zh' });
    for (const slot of slots) {
      expect(Object.keys(slot).sort()).toEqual(['budget', 'end', 'id', 'room', 'src', 'start']);
      expect(slot.room).toBeCloseTo(slot.end - slot.start, 9);
      expect(slot.end).toBeGreaterThan(slot.start);
    }
  });

  it('says where the speech came from: subs unless told otherwise', () => {
    expect(buildSlots(speech, 30).every((s) => s.src === 'subs')).toBe(true);
    expect(buildSlots(speech, 30, { src: 'vad' }).every((s) => s.src === 'vad')).toBe(true);
    expect(buildSlots(speech, 30, { src: 'asr' }).every((s) => s.src === 'asr')).toBe(true);
  });

  it('keeps times to the millisecond', () => {
    // 5.3 + 0.1 and 7.2 - 0.3 are not round numbers in floating point.
    const slots = buildSlots([{ start: 1, end: 5.3 }, { start: 7.2, end: 9 }], 9, { minGap: 0 });
    expect(slots.map((s) => [s.start, s.end, s.room])).toEqual([
      [0, 0.7, 0.7],
      [5.4, 6.9, 1.5],
    ]);
  });

  it('makes one slot of a film with no speech', () => {
    for (const none of [[], undefined, null]) {
      const slots = buildSlots(none, 90, { lang: 'zh' });
      expect(slots).toEqual([{ id: 'g_0001', start: 0, end: 90, room: 90, budget: budgetFor(90, 'zh'), src: 'subs' }]);
    }
  });

  it('makes no slot when speech fills the film or the film has no length', () => {
    expect(buildSlots([{ start: 0, end: 60 }], 60)).toEqual([]);
    expect(buildSlots([{ start: 0.5, end: 59.5 }], 60)).toEqual([]);
    for (const duration of [0, -5, NaN, undefined, null, Infinity]) {
      expect(buildSlots(speech, duration)).toEqual([]);
    }
    expect(buildSlots([], 0.5)).toEqual([]);
  });

  it('cuts speech off at 0 and at the duration', () => {
    const slots = buildSlots([{ start: -5, end: 2 }, { start: 28, end: 45 }, { start: 50, end: 60 }], 30);
    expect(slots.map((s) => [s.start, s.end])).toEqual([[2.1, 27.7]]);
    // Speech that ends just before the end leaves no slot that runs past the duration.
    expect(buildSlots([{ start: 10, end: 29.95 }], 30).map((s) => [s.start, s.end])).toEqual([[0, 9.7]]);
  });

  it('falls back to the defaults for impossible options', () => {
    expect(buildSlots(speech, 30, { minGap: -1, lead: NaN, tail: -2 })).toEqual(buildSlots(speech, 30));
    expect(buildSlots(speech, 30, undefined)).toEqual(buildSlots(speech, 30, {}));
  });

  it('leaves its arguments alone', () => {
    const given = frozen([{ start: 10, end: 20 }, { start: 5, end: 8 }]);
    const options = frozen({ lang: 'zh', rate: { cjkPerSec: 4 }, speed: 1 });
    expect(() => buildSlots(given, 30, options)).not.toThrow();
    expect(given).toEqual([{ start: 10, end: 20 }, { start: 5, end: 8 }]);
  });

  it('turns a subtitle file into slots, end to end', () => {
    const srt = [
      '1', '00:00:05,000 --> 00:00:08,000', '你来了。', '',
      '2', '00:00:08,200 --> 00:00:10,000', '我来了。', '',
      '3', '00:00:15,000 --> 00:00:20,000', '[音乐]', '',
      '4', '00:00:30,000 --> 00:00:32,500', '走吧。', '',
    ].join('\n');
    const slots = buildSlots(speechFromLines(parseSrt(srt)), 40, { lang: 'zh-CN' });
    expect(slots.map(({ id, start, end }) => ({ id, start, end }))).toEqual([
      { id: 'g_0001', start: 0, end: 4.7 },
      { id: 'g_0002', start: 10.1, end: 29.7 },
      { id: 'g_0003', start: 32.6, end: 40 },
    ]);
    expect(slots[1].budget).toEqual({ units: 'chars', brief: 29, standard: 58, detailed: 87 });
  });
});

describe('slotAt', () => {
  const slots = buildSlots([{ start: 5, end: 8 }, { start: 10, end: 20 }], 30);

  it('finds the slot that holds a time, its first and last moment included', () => {
    expect(slotAt(slots, 0).id).toBe('g_0001');
    expect(slotAt(slots, 3).id).toBe('g_0001');
    expect(slotAt(slots, 4.7).id).toBe('g_0001');
    expect(slotAt(slots, 8.1).id).toBe('g_0002');
    expect(slotAt(slots, 9).id).toBe('g_0002');
    expect(slotAt(slots, 25).id).toBe('g_0003');
    expect(slotAt(slots, 30).id).toBe('g_0003');
    expect(slotAt(slots, 25)).toBe(slots[2]);
  });

  it('returns null for a time on speech, in the lead or tail, or outside the film', () => {
    for (const t of [6, 4.71, 8.05, 9.9, 15, 20.05, -1, 31]) {
      expect(slotAt(slots, t)).toBeNull();
    }
  });

  it('returns null for no slots or no time', () => {
    expect(slotAt([], 3)).toBeNull();
    expect(slotAt(undefined, 3)).toBeNull();
    expect(slotAt(null, 3)).toBeNull();
    for (const t of [NaN, undefined, null, '3', Infinity]) {
      expect(slotAt(slots, t)).toBeNull();
    }
  });
});

describe('slotsBetween', () => {
  // Slots: 0-4.7, 8.1-9.7, 20.1-30.
  const slots = buildSlots([{ start: 5, end: 8 }, { start: 10, end: 20 }], 30);
  const ids = (found) => found.map((s) => s.id);

  it('returns the slots that start in the window', () => {
    expect(ids(slotsBetween(slots, 0, 30))).toEqual(['g_0001', 'g_0002', 'g_0003']);
    expect(ids(slotsBetween(slots, 5, 15))).toEqual(['g_0002']);
    expect(ids(slotsBetween(slots, 10, 20))).toEqual([]);
    expect(ids(slotsBetween(slots, 0, Infinity))).toEqual(['g_0001', 'g_0002', 'g_0003']);
  });

  it('gives a slot to the window it starts in, however far it runs on', () => {
    // The last slot runs from 20.1 to 30: it belongs to the window that holds 20.1.
    expect(ids(slotsBetween(slots, 15, 25))).toEqual(['g_0003']);
    expect(ids(slotsBetween(slots, 25, 30))).toEqual([]);
    // The first runs from 0 to 4.7: a window from 2 on does not have it.
    expect(ids(slotsBetween(slots, 2, 9))).toEqual(['g_0002']);
  });

  it('includes a slot that starts exactly at the start of the window, not one that starts at its end', () => {
    expect(ids(slotsBetween(slots, 8.1, 20.1))).toEqual(['g_0002']);
    expect(ids(slotsBetween(slots, 20.1, 30))).toEqual(['g_0003']);
  });

  it('shares the slots out among windows laid end to end, none left over and none twice', () => {
    const film = buildSlots(Array.from({ length: 40 }, (unused, i) => ({ start: 7 * i + 3, end: 7 * i + 5.5 })), 300);
    for (const size of [10, 25, 60, 300]) {
      const shared = [];
      for (let start = 0; start < 300; start += size) shared.push(...slotsBetween(film, start, start + size));
      expect(ids(shared)).toEqual(ids(film));
    }
  });

  it('returns the same slot objects in a new list', () => {
    const found = slotsBetween(slots, 0, 30);
    expect(found).not.toBe(slots);
    expect(found[0]).toBe(slots[0]);
  });

  it('returns an empty list for no slots, an empty window or a window that is not numbers', () => {
    expect(slotsBetween([], 0, 30)).toEqual([]);
    expect(slotsBetween(undefined, 0, 30)).toEqual([]);
    expect(slotsBetween(slots, 12, 12)).toEqual([]);
    expect(slotsBetween(slots, 30, 0)).toEqual([]);
    expect(slotsBetween(slots, NaN, 30)).toEqual([]);
    expect(slotsBetween(slots, 0, undefined)).toEqual([]);
  });
});
