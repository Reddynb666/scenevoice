// Descriptions stay short by default: one that runs well past what the model was
// asked for is cut at a sentence end, in Chinese by characters and in other
// languages by length; on-screen text quoted word for word is not cut that way.

import { describe, expect, it } from 'vitest';
import { normalizeChunk } from '../src/shared/script.js';
import { scriptInstructions } from '../src/shared/gemini.js';

const one = (cue) => normalizeChunk({ cues: [{ start: 1, gap: 3, kind: 'visual', priority: 1, ...cue }] }).cues[0];

describe('description length', () => {
  it('cuts a long Chinese standard description at a sentence end, near 60 characters', () => {
    const first = '穿红衣服的女主持人走到台前，拿起话筒向观众挥手致意。';
    const long = `${first}${'她身后的大屏幕上播放着节目片头，灯光逐渐变暗，舞台两侧升起白色的烟雾。'.repeat(2)}`;
    const cue = one({ brief: '女主持人上台。', standard: long, detailed: long });
    expect(cue.standard.length).toBeLessThanOrEqual(60);
    expect(cue.standard.startsWith(first)).toBe(true);
    expect(cue.standard.endsWith('。')).toBe(true);
  });

  it('leaves descriptions within the asked length alone', () => {
    const cue = one({ brief: 'A dog runs.', standard: 'A brown dog runs across the beach toward the water.', detailed: 'A brown dog runs across a wide beach toward the water, kicking up sand.' });
    expect(cue.standard).toBe('A brown dog runs across the beach toward the water.');
    expect(cue.detailed).toBe('A brown dog runs across a wide beach toward the water, kicking up sand.');
  });

  it('cuts a long English brief one', () => {
    const cue = one({ brief: 'A brown dog runs across the wide sandy beach. It chases a red ball toward the waves and barks.', standard: 'A dog runs.' });
    expect(cue.brief.length).toBeLessThanOrEqual(80);
  });

  it('does not cut on-screen text that way', () => {
    const slide = '幻灯片：第一，收集数据；第二，清洗数据；第三，训练模型；第四，评估模型；第五，部署上线；第六，持续监控与迭代。';
    const cue = normalizeChunk({ cues: [{ start: 1, gap: 3, kind: 'text', priority: 1, onScreenText: slide, brief: slide, standard: slide, detailed: slide }] }).cues[0];
    expect(cue.standard).toBe(slide);
  });

  it('asks for no filler', () => {
    expect(scriptInstructions('zh-CN')).toContain('画面中可以看到');
  });
});
