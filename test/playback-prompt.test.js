// What the prompts say about pauses and about the section before: the model is
// never told to invent a pause, and a later section neither repeats the last
// descriptions of the one before nor opens the video again.

import { describe, expect, it } from 'vitest';
import { PREVIOUS_CUES, buildScriptRequest, scriptPrompt } from '../src/shared/gemini.js';
import { framesScriptPrompt } from '../src/shared/frames.js';

const frames = [{ time: 0, data: '/9j/AAAA' }];

describe('scriptPrompt and the section before', () => {
  const previous = [
    { start: 250, text: 'A woman in a red coat enters.' },
    { start: 262, text: 'She sits at the counter.' },
    { start: 270, text: 'The cook turns round.' },
    { start: 281, text: 'He hands her a menu.' },
    { start: 290.4, text: 'She opens the menu.' },
    { start: 297, text: 'A bell rings above the door.' },
  ];

  it('says nothing about an earlier section for the first one', () => {
    const text = scriptPrompt({ meta: {}, chunk: { start: 0, end: 300 }, duration: 900, lang: 'en' });
    expect(text).not.toMatch(/not the start of the video/);
    expect(text).not.toMatch(/Already described just before/);
  });

  it('tells a later section that the video did not begin there, so there is no establishing description', () => {
    const text = scriptPrompt({ meta: {}, chunk: { start: 300, end: 600 }, duration: 900, lang: 'en' });
    expect(text).toMatch(/This section is not the start of the video/);
    expect(text).toMatch(/no establishing description/);
  });

  it('passes the last four descriptions of the section before, with their times', () => {
    expect(PREVIOUS_CUES).toBe(4);
    const text = scriptPrompt({ meta: {}, chunk: { start: 300, end: 600 }, duration: 900, previous, lang: 'en' });
    const line = text.split('\n').find((l) => l.startsWith('Already described just before this section; do not describe it again unless it changed:'));
    expect(line).toBeDefined();
    expect(line).toContain('4:30 The cook turns round.');
    expect(line).toContain('4:41 He hands her a menu.');
    expect(line).toContain('4:50 She opens the menu.');
    expect(line).toContain('4:57 A bell rings above the door.');
    // Only the last four: the first two of the six are left out.
    expect(line).not.toContain('red coat');
    expect(line).not.toContain('sits at the counter');
    // The line comes after the section it applies to, before the people and the language, as the frames prompt does it.
    expect(text.indexOf('Describe only the section')).toBeLessThan(text.indexOf('Already described just before'));
    expect(text.indexOf('Already described just before')).toBeLessThan(text.indexOf('Write in English.'));
  });

  it('goes into the request for a later chunk', () => {
    const req = buildScriptRequest({ videoId: 'abcdefghijk', meta: {}, chunk: { start: 300, end: 600 }, duration: 900, characters: [], previous: previous.slice(-2), lang: 'en' });
    const text = req.contents[0].parts[1].text;
    expect(text).toContain('4:50 She opens the menu.');
    expect(text).toMatch(/not the start of the video/);
    // The first chunk of a video keeps its establishing description.
    const first = buildScriptRequest({ videoId: 'abcdefghijk', meta: {}, chunk: { start: 0, end: 300 }, duration: 900, characters: [], lang: 'en' });
    expect(first.contents[0].parts[1].text).not.toMatch(/not the start of the video/);
    expect(first.systemInstruction.parts[0].text).toMatch(/At the very start of the video \(0 to 2 seconds\), give an establishing description/);
  });
});

describe('frames prompt and pauses', () => {
  it('asks for gap 0 when the model cannot tell whether anyone speaks, never an invented pause', () => {
    const { system } = framesScriptPrompt({ meta: {}, window: { start: 0, end: 12 }, duration: 60, lang: 'en', frames });
    expect(system).toMatch(/use 0 when you cannot tell/);
    expect(system).toMatch(/Never invent a pause/);
    expect(system).not.toMatch(/use 3 when you cannot tell/);
  });
});
