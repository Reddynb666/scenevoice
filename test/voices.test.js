import { describe, expect, it } from 'vitest';
import { groupVoices, languageMatch, pickVoice, speechOptions } from '../src/shared/voices.js';

const VOICES = [
  { name: 'Samantha', lang: 'en-US' },
  { name: 'Daniel', lang: 'en-GB' },
  { name: 'Thomas', lang: 'fr-FR' },
  { name: 'Meijia', lang: 'zh-TW' },
  { name: 'Sinji', lang: 'zh-HK' },
  { name: 'Tingting', lang: 'zh-CN' },
  { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
  { name: 'Xiaoxiao', lang: 'cmn-Hans-CN' },
  { name: 'Mystery' },
];

describe('languageMatch', () => {
  it('ranks the same tag, then the same language and script, then the same language', () => {
    expect(languageMatch('zh-CN', 'zh-CN')).toBe(3);
    expect(languageMatch('zh_CN', 'zh-CN')).toBe(3);
    expect(languageMatch('cmn-Hans-CN', 'zh-CN')).toBe(2);
    expect(languageMatch('zh-TW', 'zh-CN')).toBe(1);
    expect(languageMatch('zh-HK', 'zh-TW')).toBe(2);
    expect(languageMatch('yue-HK', 'zh-TW')).toBe(2);
    expect(languageMatch('en-US', 'en')).toBe(2);
    expect(languageMatch('en-US', 'zh-CN')).toBe(0);
    expect(languageMatch('', 'en')).toBe(0);
    expect(languageMatch(undefined, 'en')).toBe(0);
  });
});

describe('groupVoices', () => {
  it('lists Chinese voices first for Simplified Chinese descriptions, best match first', () => {
    const { matching, other } = groupVoices(VOICES, 'zh-CN');
    expect(matching.map((v) => v.name)).toEqual(['Google 普通话（中国大陆）', 'Tingting', 'Xiaoxiao', 'Meijia', 'Sinji']);
    expect(other.map((v) => v.name)).toEqual(['Daniel', 'Samantha', 'Thomas', 'Mystery']);
  });

  it('puts Traditional Chinese voices first for Traditional Chinese descriptions', () => {
    const { matching } = groupVoices(VOICES, 'zh-TW');
    expect(matching.map((v) => v.name)).toEqual(['Meijia', 'Sinji', 'Google 普通话（中国大陆）', 'Tingting', 'Xiaoxiao']);
  });

  it('lists every voice of the language for a language without a region', () => {
    const { matching, other } = groupVoices(VOICES, 'en');
    expect(matching.map((v) => v.name)).toEqual(['Daniel', 'Samantha']);
    expect(other.some((v) => v.lang?.startsWith('zh'))).toBe(true);
  });

  it('says when no voice speaks the language', () => {
    expect(groupVoices(VOICES, 'ko').matching).toEqual([]);
    expect(groupVoices([], 'en')).toEqual({ matching: [], other: [] });
  });

  it('drops nameless and repeated voices', () => {
    const { matching, other } = groupVoices([{ name: '' }, { name: 'A', lang: 'en' }, { name: 'A', lang: 'en' }, null], 'en');
    expect(matching).toHaveLength(1);
    expect(other).toHaveLength(0);
  });
});

describe('pickVoice', () => {
  const installed = VOICES.map((v) => ({ voiceName: v.name, lang: v.lang }));

  it('uses a chosen voice that is installed, even for another language', () => {
    expect(pickVoice(installed, 'Tingting', 'zh-CN')).toBe('Tingting');
    expect(pickVoice(installed, 'Samantha', 'zh-CN')).toBe('Samantha');
  });

  it('lets Chrome choose by language when the voice is not on this computer', () => {
    expect(pickVoice(installed, 'Microsoft Huihui', 'zh-CN')).toBe('');
    expect(pickVoice(installed, '', 'zh-CN')).toBe('');
    expect(pickVoice([], 'Tingting', 'zh-CN')).toBe('');
  });

  it('drops the old single voice when it does not speak the language', () => {
    expect(pickVoice(installed, 'Samantha', 'zh-CN', true)).toBe('');
    expect(pickVoice(installed, 'Samantha', 'en', true)).toBe('Samantha');
    // A voice that does not say its language is given the benefit of the doubt.
    expect(pickVoice(installed, 'Mystery', 'zh-CN', true)).toBe('Mystery');
  });
});

describe('speechOptions', () => {
  const installed = [{ voiceName: 'Tingting', lang: 'zh-CN' }];

  it('passes rate, pitch, language and an installed voice to chrome.tts', () => {
    expect(speechOptions({ lang: 'zh-CN', rate: 1.4, pitch: 0.8, voice: 'Tingting' }, installed)).toEqual({
      lang: 'zh-CN',
      rate: 1.4,
      pitch: 0.8,
      enqueue: false,
      voiceName: 'Tingting',
    });
  });

  it('clamps rate and pitch to what chrome.tts accepts, whoever sent them', () => {
    const o = speechOptions({ lang: 'en', rate: 50, pitch: -3, enqueue: 1 });
    expect(o).toEqual({ lang: 'en', rate: 4, pitch: 0, enqueue: true });
    // Missing or unreadable values (an older content script sends no pitch) mean normal.
    expect(speechOptions({ rate: 'x', pitch: null })).toMatchObject({ rate: 1, pitch: 1 });
    expect(speechOptions({})).toEqual({ rate: 1, pitch: 1, enqueue: false });
  });

  it('leaves the voice out when it is missing here', () => {
    expect(speechOptions({ lang: 'zh-CN', voice: 'Ting-Ting (Premium)' }, installed)).not.toHaveProperty('voiceName');
  });
});
