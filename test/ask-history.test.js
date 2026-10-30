// Earlier questions about the same video go with a new one, so a follow-up is
// understood: cleaned, limited to the latest three, and marked as possibly wrong
// in the prompt for both Gemini (video clip) and models sent pictures.

import { describe, expect, it } from 'vitest';
import { askHistoryText, cleanAskHistory } from '../src/shared/ask.js';
import { buildAskRequest } from '../src/shared/gemini.js';
import { framesAskPrompt } from '../src/shared/frames.js';

const h = (n) => ({ question: `Question ${n}?`, answer: `Answer ${n}.` });

describe('ask history', () => {
  it('keeps the latest three well-formed pairs, shortened', () => {
    const list = cleanAskHistory([h(1), { question: 'no answer' }, 'junk', h(2), h(3), { question: 'x'.repeat(400), answer: 'y' }]);
    expect(list.map((x) => x.question.slice(0, 10))).toEqual(['Question 2', 'Question 3', 'xxxxxxxxxx']);
    expect(list[2].question).toHaveLength(300);
    expect(cleanAskHistory(null)).toEqual([]);
  });

  it('is written oldest first, marked as possibly wrong, and left out when empty', () => {
    const text = askHistoryText([h(1), h(2)]);
    expect(text).toMatch(/^Earlier questions .* may be wrong\)/);
    expect(text.indexOf('Question 1?')).toBeLessThan(text.indexOf('Question 2?'));
    expect(askHistoryText([])).toBe('');
  });

  it('goes into the Gemini question and the one with pictures', () => {
    const base = { meta: { title: 'T' }, time: 60, duration: 600, question: 'And now?', nearbyText: '', lang: 'en', history: [h(1)] };
    const gemini = JSON.stringify(buildAskRequest({ ...base, videoId: 'abcdefghijk', model: 'm' }));
    expect(gemini).toContain('Q: Question 1?');
    const frames = framesAskPrompt({ ...base, frames: [{ time: 59, data: 'x' }] });
    expect(frames.text).toContain('A: Answer 1.');
    expect(frames.text.indexOf('Earlier questions')).toBeLessThan(frames.text.indexOf('Question: And now?'));
  });
});
