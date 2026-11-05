// On-screen text first, quiet moments left quiet: the pure parts.

import { describe, expect, it } from 'vitest';
import { fitCuesToDialogue } from '../src/shared/dialogue.js';
import { dropTextHeardInCaptions, heardShare, screenTextOf, textTokens } from '../src/shared/onscreen.js';
import { mayInterrupt, pickOne } from '../src/shared/scheduler.js';
import { chooseUtterance, cleanScreenText, normalizeChunk, passesDensity } from '../src/shared/script.js';

const visual = (start, extra = {}) => ({
  start,
  gap: 6,
  kind: 'visual',
  priority: 1,
  brief: 'She wipes the counter.',
  standard: 'The waitress wipes the long counter with a cloth.',
  detailed: 'The waitress in a yellow apron wipes the long chrome counter with a white cloth.',
  ...extra,
});
const text = (start, onScreenText, extra = {}) => ({
  start,
  gap: 6,
  kind: 'text',
  priority: 1,
  onScreenText,
  brief: `Sign: ${onScreenText}`,
  standard: `A sign reads: ${onScreenText}`,
  detailed: `A neon sign above the door reads: ${onScreenText}`,
  ...extra,
});

describe('textTokens', () => {
  it('compares words in lower case, numbers by their digits', () => {
    expect(textTokens("JOE'S DINER / Open late")).toEqual(['joe', 's', 'diner', 'open', 'late']);
    expect(textTokens('Today: pancakes $4.99')).toEqual(['today', 'pancakes', '4', '99']);
    expect(textTokens('')).toEqual([]);
    expect(textTokens(null)).toEqual([]);
  });
  it('reads full-width characters as their plain form', () => {
    expect(textTokens('ＳＡＬＥ　１９')).toEqual(['sale', '19']);
  });
  it('counts Chinese and Japanese in pairs of characters', () => {
    expect(textTokens('欢迎光临')).toEqual(['欢迎', '迎光', '光临']);
    expect(textTokens('第3章 开始')).toEqual(['第', '章', '开始', '3']);
  });
});

describe('screenTextOf', () => {
  it('uses the transcription of a text cue, never of a visual one', () => {
    expect(screenTextOf(text(1, 'EXIT'))).toBe('EXIT');
    expect(screenTextOf(visual(1, { onScreenText: 'EXIT' }))).toBe('');
    expect(screenTextOf(null)).toBe('');
  });
  it('falls back to what an older description quotes', () => {
    expect(screenTextOf({ kind: 'text', standard: 'A sign reads "Open late" over the door.' })).toBe('Open late');
    expect(screenTextOf({ kind: 'text', standard: '招牌上写着“欢迎光临”和「营业中」。' })).toBe('欢迎光临 营业中');
    expect(screenTextOf({ kind: 'text', standard: 'A sign above the door.' })).toBe('');
  });
  it('measures how much of a text was heard', () => {
    expect(heardShare(['a', 'b', 'c', 'd'], new Set(['a', 'b', 'c']))).toBe(0.75);
    expect(heardShare([], new Set(['a']))).toBe(0);
  });
});

describe('dropTextHeardInCaptions', () => {
  const captions = [
    { start: 3, end: 5, text: "Welcome to Joe's Diner. We're open late." },
    { start: 40, end: 42, text: 'Call us on 555 0199.' },
    { start: 60, end: 62, text: '[Music]' },
    { start: 80, end: 83, text: '欢迎光临本店，今天全场八折。' },
  ];

  it('leaves out on-screen text the dialogue says around the same time', () => {
    const cues = [text(1, "JOE'S DINER / OPEN LATE"), visual(2), text(10, 'Today: pancakes $4.99')];
    const { cues: kept, dropped } = dropTextHeardInCaptions(cues, captions);
    expect(dropped.map((c) => c.start)).toEqual([1]);
    expect(kept.map((c) => c.start)).toEqual([2, 10]);
  });

  it('counts speech a little before and after the text appears, not further', () => {
    // Heard 13 s later: a presenter reading the slide out.
    expect(dropTextHeardInCaptions([text(27, 'Call 555 0199')], captions).dropped).toHaveLength(1);
    // Heard 30 s later: too far apart to count.
    expect(dropTextHeardInCaptions([text(10, 'Call 555 0199')], captions).dropped).toHaveLength(0);
    // Heard 9 s earlier.
    expect(dropTextHeardInCaptions([text(14, 'Open late')], captions).dropped).toHaveLength(1);
  });

  it('keeps text that is only partly said: the rest would be missed', () => {
    const slide = text(41, 'Call 555 0199 / Mon–Fri 9–5 / hello@joes.example');
    expect(dropTextHeardInCaptions([slide], captions).dropped).toHaveLength(0);
  });

  it('works for Chinese, and ignores sound labels', () => {
    expect(dropTextHeardInCaptions([text(81, '欢迎光临')], captions).dropped).toHaveLength(1);
    expect(dropTextHeardInCaptions([text(82, '营业时间 9:00–21:00')], captions).dropped).toHaveLength(0);
    expect(dropTextHeardInCaptions([text(60, 'Music')], captions).dropped).toHaveLength(0);
  });

  it('never drops visual cues, text without words, or anything without captions', () => {
    const cues = [visual(3, { standard: "Welcome to Joe's Diner" }), text(3, '→ ★')];
    expect(dropTextHeardInCaptions(cues, captions).cues).toEqual(cues);
    expect(dropTextHeardInCaptions(cues, []).cues).toBe(cues);
    expect(dropTextHeardInCaptions(cues, null).cues).toBe(cues);
  });

  it('works on scripts made before the transcription existed', () => {
    const old = { start: 1, gap: 3, kind: 'text', priority: 1, brief: 'Sign', standard: 'A sign reads "Open late".', detailed: 'x' };
    expect(dropTextHeardInCaptions([old], captions).dropped).toHaveLength(1);
  });
});

describe('model output with on-screen text', () => {
  it('keeps the transcription of text cues, exactly, with line breaks shown', () => {
    const { cues } = normalizeChunk({
      cues: [
        { start: 2, gap: 3, kind: 'text', priority: 1, onScreenText: 'def __init__(self):\n    self.items = []', brief: 'Code: def __init__(self)', standard: 'Code: `def __init__(self):`', detailed: '' },
        { start: 5, gap: 3, kind: 'text', priority: 1, onScreenText: '#1 Best Seller  -20%', brief: '', standard: '', detailed: '' },
        { start: 9, gap: 3, kind: 'visual', priority: 2, onScreenText: 'stray', brief: '- She nods.', standard: '**She nods.**', detailed: '' },
      ],
    }, { duration: 60 });
    expect(cues[0].onScreenText).toBe('def __init__(self): / self.items = []');
    // Symbols that mean something on screen stay in what is spoken.
    expect(cues[0].brief).toBe('Code: def __init__(self)');
    expect(cues[0].standard).toBe('Code: def __init__(self):');
    // A text cue with nothing else to say reads the text itself.
    expect(cues[1]).toMatchObject({ onScreenText: '#1 Best Seller -20%', standard: '#1 Best Seller -20%', brief: '#1 Best Seller -20%' });
    // Visual cues carry no transcription, and their markdown is still removed.
    expect(cues[2]).not.toHaveProperty('onScreenText');
    expect(cues[2].brief).toBe('She nods.');
    expect(cues[2].standard).toBe('She nods.');
  });

  it('keeps long transcriptions to a reasonable size', () => {
    expect(cleanScreenText(`${'word '.repeat(200)}`).length).toBeLessThanOrEqual(601);
    expect(cleanScreenText('  Menu\n\n Soup  \n Salad ')).toBe('Menu / Soup / Salad');
    expect(cleanScreenText(42)).toBe('');
  });
});

describe('on-screen text comes first', () => {
  it('reads text one density level further than other descriptions', () => {
    expect([1, 2, 3].map((priority) => passesDensity({ priority, kind: 'text' }, 'essential'))).toEqual([true, true, false]);
    expect([1, 2, 3].map((priority) => passesDensity({ priority, kind: 'text' }, 'standard'))).toEqual([true, true, true]);
    expect([1, 2, 3].map((priority) => passesDensity({ priority, kind: 'visual' }, 'essential'))).toEqual([true, false, false]);
  });

  it('wins over a visual description of the same importance', () => {
    expect(pickOne([visual(5), text(4, 'EXIT')]).kind).toBe('text');
    expect(pickOne([text(4, 'EXIT', { priority: 2 }), visual(5, { priority: 2 })]).kind).toBe('text');
    // A more important visual description still comes first.
    expect(pickOne([text(4, 'EXIT', { priority: 2 }), visual(5, { priority: 1 })]).kind).toBe('visual');
    // Among equals of one kind, the latest.
    expect(pickOne([text(4, 'A'), text(5, 'B')]).onScreenText).toBe('B');
  });

  it('is not cut off by a visual description that is no more important', () => {
    expect(mayInterrupt({ kind: 'text', priority: 1 }, visual(5, { priority: 1 }))).toBe(false);
    expect(mayInterrupt({ kind: 'text', priority: 2 }, visual(5, { priority: 3 }))).toBe(false);
    expect(mayInterrupt({ kind: 'text', priority: 2 }, visual(5, { priority: 1 }))).toBe(true);
    // Nothing of equal or lower importance cuts off a description any more (it waits for the next pause): not even text over text.
    expect(mayInterrupt({ kind: 'text', priority: 1 }, text(5, 'Next slide'))).toBe(false);
    expect(mayInterrupt({ kind: 'text', priority: 2 }, text(5, 'Next slide'))).toBe(true);
    expect(mayInterrupt({ kind: 'visual', priority: 1 }, visual(5, { priority: 3 }))).toBe(false);
    expect(mayInterrupt({ kind: 'visual', priority: 3 }, visual(5, { priority: 1 }))).toBe(true);
    expect(mayInterrupt(null, visual(5))).toBe(true);
  });
});

describe('on-screen text waits for a pause in speech', () => {
  const speech = [
    { start: 0, end: 4 },
    { start: 4.5, end: 9 },
    { start: 12, end: 20 },
    { start: 20.4, end: 30 },
  ];

  it('moves a text cue that lands in speech to the first pause with room, within 8 seconds', () => {
    // Shown at 1 s, during speech: the pause at 4–4.5 s is too short, the one at 9–12 s will do.
    const [c] = fitCuesToDialogue([text(1, 'Jane Doe / CEO, Acme', { gap: 0.5 })], speech);
    expect(c).toMatchObject({ start: 9, gap: 2.7, gapMeasured: true });
    expect(chooseUtterance(c, { mode: 'gaps', detail: 'brief', rate: 1.6, onScreenText: true })?.text).toBe(c.brief);
  });

  it('does not wait longer than that', () => {
    // Shown at 13 s: speech runs to 30 s with only a short break at 20 s.
    const [c] = fitCuesToDialogue([text(13, 'Chapter 2', { gap: 0.5 })], speech);
    expect(c).toMatchObject({ start: 13, gap: 0 });
  });

  it('leaves visual cues and text that already has room as they were', () => {
    const [v] = fitCuesToDialogue([visual(1, { gap: 0.5 })], speech);
    expect(v).toMatchObject({ start: 1, gap: 0 });
    const [t] = fitCuesToDialogue([text(9.5, 'OPEN', { gap: 6 })], speech);
    expect(t).toMatchObject({ start: 9.5, gap: 2.2 });
  });
});
