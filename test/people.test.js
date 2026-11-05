// People keep one label through the video: the instructions forbid a bare "a man"
// and re-introducing someone already labelled, and the labels go with every
// request that writes about people, questions included.

import { describe, expect, it } from 'vitest';
import { buildAskRequest, peopleText, scriptInstructions } from '../src/shared/gemini.js';
import { framesAskPrompt, framesScriptPrompt } from '../src/shared/frames.js';

const host = { label: '穿红衣服的女主持人', description: 'red dress, short hair' };

describe('people labels', () => {
  it('the instructions ask for telling labels and forbid re-introducing someone', () => {
    const text = scriptInstructions('zh-CN');
    expect(text).toContain('Never a bare "a man", "a woman", "一个男人", "一位女士".');
    expect(text).toContain('not "一个男人走进来。" but "戴眼镜的男人又走了进来。"');
  });

  it('lists the labels, shortened and capped, and nothing when there are none', () => {
    expect(peopleText([host])).toBe('People already introduced earlier in the video (reuse these labels): 穿红衣服的女主持人 (red dress, short hair)');
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `P${i}` }));
    expect(peopleText(many).match(/P\d+/g)).toHaveLength(20);
    expect(peopleText([{ label: '' }, null, 'x'])).toBe('');
    expect(peopleText(undefined)).toBe('');
  });

  it('goes with descriptions from pictures and with questions to both kinds of model', () => {
    const frames = [{ time: 10, data: 'x' }];
    expect(framesScriptPrompt({ meta: {}, window: { start: 0, end: 12 }, duration: 60, characters: [host], lang: 'zh-CN', frames }).text).toContain('穿红衣服的女主持人');
    expect(framesAskPrompt({ meta: {}, time: 10, duration: 60, question: '她在做什么？', characters: [host], lang: 'zh-CN', frames }).text).toContain('穿红衣服的女主持人');
    expect(JSON.stringify(buildAskRequest({ videoId: 'abcdefghijk', meta: {}, time: 10, duration: 60, question: '她在做什么？', characters: [host], lang: 'zh-CN', model: 'm' }))).toContain('穿红衣服的女主持人');
  });
});
