import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DENSITIES, DETAILS, MODES, VIDEO_TYPES } from '../src/shared/constants.js';
import { typeAdjustedText, typeChosenText } from '../src/shared/labels.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { knownType, pageVideoType, resolveVideoType, titleLooksLikeTutorial, typeAdjustments, typeSettingKey } from '../src/shared/videotype.js';
import { extractCategory } from '../src/content/youtube.js';
import { STRINGS } from '../scripts/locales.mjs';
import { fakeChrome } from './fake-chrome.js';

const defaults = normalizeSettings({});

describe('video type from the watch page', () => {
  it('maps YouTube categories to entertainment or tutorial', () => {
    for (const c of ['Film & Animation', 'Music', 'Gaming', 'Comedy', 'Entertainment', 'Sports', 'Pets & Animals', 'Travel & Events']) {
      expect(pageVideoType({ category: c }), c).toBe('entertainment');
    }
    for (const c of ['Education', 'Howto & Style', 'Science & Technology', 'News & Politics']) {
      expect(pageVideoType({ category: c }), c).toBe('tutorial');
    }
  });

  it('reads categories however the page spells them', () => {
    expect(pageVideoType({ category: 'Howto &amp; Style' })).toBe('tutorial');
    expect(pageVideoType({ category: '  science  &  technology ' })).toBe('tutorial');
    expect(pageVideoType({ category: '教育' })).toBe('tutorial');
    expect(pageVideoType({ category: '音乐' })).toBe('entertainment');
  });

  it('lets a clear category win over the title', () => {
    expect(pageVideoType({ category: 'Education', title: 'My favourite songs' })).toBe('tutorial');
    expect(pageVideoType({ category: 'Music', title: 'How to Save a Life (Official Video)' })).toBe('entertainment');
  });

  it('asks the title when the category says little', () => {
    expect(pageVideoType({ category: 'People & Blogs', title: 'Sourdough for beginners' })).toBe('tutorial');
    expect(pageVideoType({ category: 'People & Blogs', title: 'A week in Lisbon' })).toBe('entertainment');
    expect(pageVideoType({ category: 'Autos & Vehicles', title: 'How to change a tyre' })).toBe('tutorial');
    expect(pageVideoType({ category: 'Autos & Vehicles', title: 'Sunday drive' })).toBe('');
    expect(pageVideoType({ title: 'Excel 数据透视表入门教程' })).toBe('tutorial');
    expect(pageVideoType({ title: '周末去露营' })).toBe('');
    expect(pageVideoType({})).toBe('');
    expect(pageVideoType()).toBe('');
  });

  it('recognises tutorial titles in English and Chinese', () => {
    for (const title of ['Python Tutorial', 'How-to: fold a fitted sheet', 'Guitar lesson 3', 'Quantum computing, explained', '手把手教你包饺子', '如何做 PPT', '红烧肉的做法', '三分钟科普黑洞']) {
      expect(titleLooksLikeTutorial(title), title).toBe(true);
    }
    for (const title of ['Official trailer', 'Taylor Swift - Shake It Off', '我的一天 vlog', '', null]) {
      expect(titleLooksLikeTutorial(title), String(title)).toBe(false);
    }
  });

  it('reads the category from the player response, or from the genre meta tag', () => {
    const response = '<script>var ytInitialPlayerResponse = {"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"Knots"},"description":{"simpleText":"Say \\"hi\\" \\u0026 tie"},"category":"Howto \\u0026 Style","publishDate":"2024-01-01"}}};</script>';
    expect(extractCategory(response)).toBe('Howto & Style');
    expect(extractCategory('<meta itemprop="genre" content="Film &amp; Animation">')).toBe('Film & Animation');
    // A "category" elsewhere on the page is not the video's.
    expect(extractCategory('{"chip":{"category":"Music"}}')).toBe('');
    expect(extractCategory('<html>nothing</html>')).toBe('');
    expect(extractCategory(null)).toBe('');
  });
});

describe('which type counts', () => {
  it("prefers Gemini's judgement, then the page's", () => {
    expect(resolveVideoType({ scriptType: 'tutorial', pageType: 'entertainment' })).toBe('tutorial');
    expect(resolveVideoType({ scriptType: '', pageType: 'entertainment' })).toBe('entertainment');
    expect(resolveVideoType({ scriptType: 'other', pageType: 'tutorial' })).toBe('tutorial');
    expect(resolveVideoType({ scriptType: 'nonsense', pageType: '' })).toBe('');
    expect(resolveVideoType()).toBe('');
    expect(knownType('__proto__')).toBe('');
  });
});

describe('typeAdjustments', () => {
  it('uses pause and detailed for tutorials, gaps, brief and essentials only for entertainment, by default', () => {
    // The default density already suits tutorials: only mode and detail change.
    expect(typeAdjustments(defaults, 'tutorial')).toEqual({ mode: 'pause', detail: 'detailed' });
    // The default mode is already "keep playing"; quiet moments stay quiet.
    expect(typeAdjustments(defaults, 'entertainment')).toEqual({ detail: 'brief', density: 'essential' });
    expect(typeAdjustments(defaults, '')).toEqual({});
  });

  it('follows the choices made for each type', () => {
    const s = normalizeSettings({ tutorialMode: 'manual', tutorialDetail: 'standard', tutorialDensity: 'full', entertainmentMode: 'pause', entertainmentDetail: 'standard', entertainmentDensity: 'standard' });
    expect(typeAdjustments(s, 'tutorial')).toEqual({ mode: 'manual', density: 'full' });
    expect(typeAdjustments(s, 'entertainment')).toEqual({ mode: 'pause' });
  });

  it('never changes a mode, detail or density the user picked, and nothing when turned off', () => {
    expect(typeAdjustments({ ...defaults, mode: 'gaps', modeChosen: true }, 'tutorial')).toEqual({ detail: 'detailed' });
    expect(typeAdjustments({ ...defaults, detail: 'brief', detailChosen: true }, 'tutorial')).toEqual({ mode: 'pause' });
    expect(typeAdjustments({ ...defaults, modeChosen: true, detailChosen: true }, 'tutorial')).toEqual({});
    expect(typeAdjustments({ ...defaults, densityChosen: true }, 'entertainment')).toEqual({ detail: 'brief' });
    expect(typeAdjustments({ ...defaults, autoByType: false }, 'tutorial')).toEqual({});
    expect(typeAdjustments(null, 'tutorial')).toEqual({});
  });

  it('has a valid default mode, detail and density for every type', () => {
    for (const type of VIDEO_TYPES) {
      expect(MODES).toContain(DEFAULT_SETTINGS[typeSettingKey(type, 'mode')]);
      expect(DETAILS).toContain(DEFAULT_SETTINGS[typeSettingKey(type, 'detail')]);
      expect(DENSITIES).toContain(DEFAULT_SETTINGS[typeSettingKey(type, 'density')]);
    }
  });
});

describe('what the user is told', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('names the type and what changed, in English', () => {
    globalThis.chrome = fakeChrome().chrome;
    expect(typeAdjustedText('tutorial', { mode: 'pause', detail: 'detailed' })).toBe('Tutorial or explainer: SceneVoice will pause when needed, with detailed descriptions.');
    expect(typeAdjustedText('entertainment', { detail: 'brief' })).toBe('Entertainment video: SceneVoice switches to brief descriptions.');
    expect(typeAdjustedText('tutorial', { mode: 'manual' })).toBe('Tutorial or explainer: SceneVoice will describe only when you ask.');
    expect(typeAdjustedText('tutorial', {})).toBe('');
  });

  it('adds what the density became, or says only that', () => {
    globalThis.chrome = fakeChrome().chrome;
    expect(typeAdjustedText('entertainment', { detail: 'brief', density: 'essential' })).toBe('Entertainment video: SceneVoice switches to brief descriptions. It describes only the essentials.');
    expect(typeAdjustedText('tutorial', { mode: 'pause', detail: 'detailed', density: 'full' })).toBe('Tutorial or explainer: SceneVoice will pause when needed, with detailed descriptions. It describes as much as possible.');
    expect(typeAdjustedText('entertainment', { density: 'essential' })).toBe('Entertainment video: SceneVoice describes only the essentials.');
    globalThis.chrome = fakeChrome({ locale: 'zh_CN' }).chrome;
    expect(typeAdjustedText('entertainment', { detail: 'brief', density: 'essential' })).toBe('娱乐类视频，已切换为简短口述。 描述密度为“仅关键”。');
    expect(typeAdjustedText('tutorial', { density: 'standard' })).toBe('教程讲解类视频，描述密度已切换为“适中”。');
  });

  it('names what the user chose and what the type still decides', () => {
    globalThis.chrome = fakeChrome().chrome;
    expect(typeChosenText({})).toBe('');
    expect(typeChosenText({ modeChosen: true })).toBe('You chose the mode yourself, so the video type now decides only the detail and how much to describe.');
    expect(typeChosenText({ detailChosen: true, densityChosen: true })).toBe('You chose the detail and how much to describe yourself, so the video type now decides only the mode.');
    expect(typeChosenText({ modeChosen: true, detailChosen: true, densityChosen: true })).toBe('You chose the mode, the detail and how much to describe yourself, so every video uses your choice.');
    globalThis.chrome = fakeChrome({ locale: 'zh_CN' }).chrome;
    expect(typeChosenText({ densityChosen: true })).toBe('描述密度是你自己选的，所以只有模式和详细程度会按视频类型调整。');
    expect(typeChosenText({ modeChosen: true, detailChosen: true })).toBe('模式和详细程度是你自己选的，所以只有描述密度会按视频类型调整。');
  });

  it('and in Chinese', () => {
    globalThis.chrome = fakeChrome({ locale: 'zh_CN' }).chrome;
    expect(typeAdjustedText('tutorial', { mode: 'pause', detail: 'detailed' })).toBe('教程讲解类视频，已切换为暂停模式、详细口述。');
    expect(typeAdjustedText('entertainment', { mode: 'gaps', detail: 'brief' })).toBe('娱乐类视频，已切换为空隙模式、简短口述。');
    expect(typeAdjustedText('entertainment', { mode: 'manual' })).toBe('娱乐类视频，已切换为手动模式。');
  });

  it('has words for every type, mode and detail', () => {
    for (const type of VIDEO_TYPES) expect(STRINGS[`type_name_${type}`], type).toBeTruthy();
    for (const mode of MODES) expect(STRINGS[`type_mode_${mode}`], mode).toBeTruthy();
    for (const detail of DETAILS) expect(STRINGS[`type_detail_${detail}`], detail).toBeTruthy();
    for (const density of DENSITIES) expect(STRINGS[`type_density_${density}`], density).toBeTruthy();
    for (const key of ['mode', 'detail', 'density']) expect(STRINGS[`type_key_${key}`], key).toBeTruthy();
  });
});
