// The China site (Bilibili and Qwen), piece by piece: video ids, which model a
// site uses, settings, language, video type, subtitles, frames, who may send
// what, the manifest, and keeping keys out of the page.

// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STRINGS } from '../scripts/locales.mjs';
import { DEFAULT_LOCAL, DEFAULT_SETTINGS, MSG } from '../src/shared/constants.js';
import { addRange, contiguousFromStart, coveredRanges, isCovered, mergeFramesChunk, newFramesScript, pickEvenly, recentCues } from '../src/shared/coverage.js';
import { parseTimedText, speechIntervals } from '../src/shared/dialogue.js';
import { sanitizeFrames } from '../src/shared/frames.js';
import { errorMessage } from '../src/shared/i18n.js';
import { bilibiliIdFromUrl, parseBilibiliVideoId, platformOfUrl, platformOfVideoId, videoPageUrl } from '../src/shared/platforms.js';
import { effectiveProvider, inputModeFor, providerFor } from '../src/shared/providers.js';
import { authorizeBackgroundMessage, classifySender, platformOfSender } from '../src/shared/sender.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { resolveLanguage } from '../src/shared/storage.js';
import { bilibiliCategoryType, pageVideoType } from '../src/shared/videotype.js';
import { initialVideoData, subtitleUrl } from '../src/content/bilibili.js';
import { FrameSampler, captureFrame } from '../src/content/frames.js';
import { fakeChrome } from './fake-chrome.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const EXT = 'abcdefghijklmnopqrstuvwxyzabcdef';

describe('Bilibili video ids', () => {
  it('reads the video and part from the address, ignoring tracking parameters', () => {
    expect(bilibiliIdFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.1007&vd_source=x')).toBe('bili:BV1GJ411x7h7');
    expect(bilibiliIdFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=1')).toBe('bili:BV1GJ411x7h7');
    expect(bilibiliIdFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3')).toBe('bili:BV1GJ411x7h7:p3');
    expect(bilibiliIdFromUrl('https://www.bilibili.com/video/av170001')).toBe('bili:av170001');
    expect(bilibiliIdFromUrl('https://www.bilibili.com/')).toBeNull();
    expect(bilibiliIdFromUrl('https://www.bilibili.com/bangumi/play/ep1')).toBeNull();
    expect(bilibiliIdFromUrl('https://evil.example/video/BV1GJ411x7h7')).toBeNull();
    expect(bilibiliIdFromUrl('https://www.bilibili.com/video/bv1gj411x7h7')).toBeNull();
  });

  it('goes back to the page, and tells the sites apart', () => {
    expect(parseBilibiliVideoId('bili:BV1GJ411x7h7:p3')).toEqual({ bvid: 'BV1GJ411x7h7', aid: '', page: 3 });
    expect(parseBilibiliVideoId('bili:av170001')).toEqual({ bvid: '', aid: '170001', page: 1 });
    expect(parseBilibiliVideoId('abcdefghijk')).toBeNull();
    expect(videoPageUrl('bili:BV1GJ411x7h7:p3')).toBe('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3');
    expect(videoPageUrl('bili:av170001')).toBe('https://www.bilibili.com/video/av170001/');
    expect(videoPageUrl('abcdefghijk')).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    expect(platformOfVideoId('bili:BV1GJ411x7h7')).toBe('bilibili');
    expect(platformOfVideoId('abcdefghijk')).toBe('youtube');
    expect(platformOfVideoId('local')).toBeNull();
    expect(platformOfUrl('https://www.bilibili.com/video/BV1GJ411x7h7/')).toBe('bilibili');
    expect(platformOfUrl('https://www.youtube.com/watch?v=abcdefghijk')).toBe('youtube');
    expect(platformOfUrl('https://www.bilibili.com/')).toBeNull();
    expect(platformOfUrl('http://www.bilibili.com/video/BV1GJ411x7h7/')).toBeNull();
  });
});

describe('which model describes each site', () => {
  it('defaults to Gemini on YouTube and Qwen on Bilibili, and follows the user’s choice', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ youtubeProvider: 'gemini', bilibiliProvider: 'qwen' });
    expect(providerFor(DEFAULT_SETTINGS, 'youtube')).toBe('gemini');
    expect(providerFor(DEFAULT_SETTINGS, 'bilibili')).toBe('qwen');
    expect(providerFor({ youtubeProvider: 'qwen' }, 'youtube')).toBe('qwen');
    expect(providerFor({ bilibiliProvider: 'gpt' }, 'bilibili')).toBe('qwen');
    expect(providerFor({}, 'somewhere')).toBe('gemini');
  });

  it('uses the one key there is, whichever site it is', () => {
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', { gemini: false, qwen: true })).toBe('qwen');
    expect(effectiveProvider(DEFAULT_SETTINGS, 'bilibili', { gemini: true, qwen: false })).toBe('gemini');
    expect(effectiveProvider(DEFAULT_SETTINGS, 'bilibili', { gemini: true, qwen: true })).toBe('qwen');
    // No key at all: the chosen one, which is what the listener is asked for.
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', { gemini: false, qwen: false })).toBe('gemini');
    expect(effectiveProvider(DEFAULT_SETTINGS, 'youtube', null)).toBe('gemini');
  });

  it('opens the video by its link only for Gemini on YouTube; everything else is sent frames', () => {
    expect(inputModeFor('gemini', 'youtube')).toBe('video');
    expect(inputModeFor('qwen', 'youtube')).toBe('frames');
    expect(inputModeFor('gemini', 'bilibili')).toBe('frames');
    expect(inputModeFor('qwen', 'bilibili')).toBe('frames');
  });

  it('keeps a valid choice in the synced settings and drops anything else', () => {
    expect(normalizeSettings({ youtubeProvider: 'qwen', bilibiliProvider: 'gemini' })).toMatchObject({ youtubeProvider: 'qwen', bilibiliProvider: 'gemini' });
    expect(normalizeSettings({ youtubeProvider: 'evil', bilibiliProvider: 3 })).toMatchObject({ youtubeProvider: 'gemini', bilibiliProvider: 'qwen' });
  });

  it('keeps the Qwen key and its settings with the Gemini key, in local storage', () => {
    expect(DEFAULT_LOCAL).toMatchObject({ qwenApiKey: '', qwenModel: 'qwen3-vl-plus', qwenApiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', qwenJsonMode: false, qwenMaxFrames: 6 });
    expect(Object.keys(DEFAULT_SETTINGS).some((k) => /key/i.test(k))).toBe(false);
  });
});

describe('Chinese on Bilibili', () => {
  it('describes in Chinese on Bilibili when the language follows the browser', () => {
    expect(resolveLanguage('auto', 'en-US', 'bilibili')).toBe('zh-CN');
    expect(resolveLanguage('auto', 'zh-TW', 'bilibili')).toBe('zh-TW');
    expect(resolveLanguage('en', 'zh-CN', 'bilibili')).toBe('en');
    expect(resolveLanguage('auto', 'en-US', 'youtube')).toBe('en');
    expect(resolveLanguage('auto', 'en-US')).toBe('en');
  });

  it('chooses the video type from Bilibili’s section, then the title', () => {
    expect(bilibiliCategoryType('美食制作')).toBe('tutorial');
    expect(bilibiliCategoryType('科学科普')).toBe('tutorial');
    expect(bilibiliCategoryType('音乐教学')).toBe('tutorial');
    expect(bilibiliCategoryType('单机游戏')).toBe('entertainment');
    expect(bilibiliCategoryType('翻唱')).toBe('entertainment');
    expect(bilibiliCategoryType('其他')).toBe('');
    expect(pageVideoType({ category: '日常', title: '入门教程', platform: 'bilibili' })).toBe('entertainment');
    expect(pageVideoType({ category: '', title: 'Python 入门教程', platform: 'bilibili' })).toBe('tutorial');
    // YouTube's categories are unchanged.
    expect(pageVideoType({ category: 'Education', title: '' })).toBe('tutorial');
  });

  it('takes dialogue timing from Bilibili CC subtitles', () => {
    const body = JSON.stringify({ font_size: 0.4, body: [{ from: 1.5, to: 3.2, location: 2, content: '大家好' }, { from: 3.3, to: 5, content: '今天做宫保鸡丁' }, { from: 8, to: 9, content: '（音乐）' }, { from: 'x', to: 2, content: 'bad' }] });
    const lines = parseTimedText(body);
    expect(lines).toEqual([
      { start: 1.5, end: 3.2, text: '大家好' },
      { start: 3.3, end: 5, text: '今天做宫保鸡丁' },
      { start: 8, end: 9, text: '（音乐）' },
    ]);
    expect(speechIntervals(lines)).toEqual([{ start: 1.5, end: 5 }]);
  });

  it('reads subtitle files only from Bilibili’s subtitle hosts, Chinese written subtitles first', () => {
    expect(subtitleUrl('//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json')).toBe('https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json');
    expect(subtitleUrl('http://i0.hdslb.com/bfs/subtitle/2.json')).toBe('https://i0.hdslb.com/bfs/subtitle/2.json');
    expect(subtitleUrl('https://evil.example/bfs/subtitle/2.json')).toBeNull();
    expect(subtitleUrl('javascript:alert(1)')).toBeNull();
  });

  it('reads the video data the page was delivered with, only for the video shown', () => {
    const page = (state) => {
      const doc = document.implementation.createHTMLDocument('');
      doc.body.innerHTML = `<script src="x.js"></script><script>window.__INITIAL_STATE__=${JSON.stringify(state)};(function(){var a="}{";}());</script>`;
      return doc;
    };
    const state = { videoData: { bvid: 'BV1GJ411x7h7', aid: 170001, title: '标题 "带引号" {括号}', tname: '美食制作', pages: [{ page: 1, part: '', duration: 120 }] } };
    expect(initialVideoData(page(state), { bvid: 'BV1GJ411x7h7', aid: '', page: 1 })).toMatchObject({ title: '标题 "带引号" {括号}', tname: '美食制作' });
    expect(initialVideoData(page(state), { bvid: '', aid: '170001', page: 1 })?.tname).toBe('美食制作');
    // Moved to another video without reloading: the HTML still has the first one's.
    expect(initialVideoData(page(state), { bvid: 'BV1xx411c7mD', aid: '', page: 1 })).toBeNull();
    expect(initialVideoData(document.implementation.createHTMLDocument(''), { bvid: 'BV1GJ411x7h7', aid: '', page: 1 })).toBeNull();
  });
});

describe('frames from the page', () => {
  const video = (props = {}) => {
    const v = document.createElement('video');
    for (const [k, value] of Object.entries({ readyState: 4, videoWidth: 1920, videoHeight: 1080, currentTime: 12.34, ...props })) Object.defineProperty(v, k, { value, configurable: true });
    return v;
  };
  const canvas = (toDataURL) => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL });

  it('takes a scaled-down JPEG of the moment', () => {
    const c = canvas(() => 'data:image/jpeg;base64,/9j/QUJD');
    expect(captureFrame(video(), { canvas: c, maxWidth: 640 })).toEqual({ time: 12.3, data: '/9j/QUJD' });
    expect([c.width, c.height]).toEqual([640, 360]);
  });

  it('says why when it cannot: a protected (cross-origin) picture, no picture yet, or a player that is not a <video>', () => {
    const tainted = canvas(() => {
      throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
    });
    expect(() => captureFrame(video(), { canvas: tainted })).toThrow(expect.objectContaining({ code: 'frames-tainted' }));
    expect(() => captureFrame(video({ readyState: 1 }), { canvas: tainted })).toThrow(expect.objectContaining({ code: 'frames-not-ready' }));
    expect(() => captureFrame(document.createElement('bwp-video'), { canvas: tainted })).toThrow(expect.objectContaining({ code: 'frames-unsupported' }));
    expect(() => captureFrame(null)).toThrow(expect.objectContaining({ code: 'no-video' }));
    expect(() => captureFrame(video(), { canvas: canvas(() => 'data:,') })).toThrow(expect.objectContaining({ code: 'frames-failed' }));
  });

  it('samples every two seconds and hands over a stretch every twelve, starting again after a seek', () => {
    const s = new FrameSampler({ intervalSeconds: 2, windowSeconds: 12, maxFrames: 4 });
    for (let t = 0; t <= 13; t += 0.5) {
      if (s.advance(t)) s.add({ time: t, data: `f${t}` });
      const w = s.takeWindow(t);
      if (w) {
        expect(w.start).toBe(0);
        expect(w.end).toBe(12);
        expect(w.frames.map((f) => f.time)).toEqual([0, 4, 8, 12]);
      }
    }
    expect(s.takeWindow(13)).toBeNull();
    // A jump forward: the next stretch starts there.
    expect(s.advance(60)).toBe(true);
    s.add({ time: 60, data: 'f60' });
    expect(s.takeWindow(61, { force: true, end: 61 })).toMatchObject({ start: 60, end: 61, frames: [{ time: 60 }] });
    expect(s.around(60, 8, 0).map((f) => f.time)).toEqual([60]);
    expect(s.around(10, 3, 3).map((f) => f.time)).toEqual([8, 10, 12]);
  });

  it('only lets well-formed pictures through to the model', () => {
    const ok = (time) => ({ time, data: '/9j/AAAA' });
    expect(sanitizeFrames([ok(3), ok(1), { time: 2, data: 'data:image/jpeg;base64,AA' }, { time: -1, data: 'AA' }, { time: 4, data: 'A'.repeat(1500001) }, null, ok(2.04)], { max: 6 })).toEqual([ok(1), { time: 2, data: '/9j/AAAA' }, ok(3)]);
    expect(sanitizeFrames('nope')).toEqual([]);
    expect(sanitizeFrames(Array.from({ length: 30 }, (_, i) => ok(i)), { max: 100 })).toHaveLength(12);
    expect(pickEvenly([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([1, 4, 7]);
  });
});

describe('what has been described', () => {
  it('joins described stretches and finds the gaps', () => {
    let r = addRange([], 0, 12);
    r = addRange(r, 12.4, 24);
    r = addRange(r, 60, 72);
    expect(r).toEqual([[0, 24], [60, 72]]);
    expect(contiguousFromStart(r)).toBe(24);
    expect(isCovered(r, 10)).toBe(true);
    expect(isCovered(r, 30)).toBe(false);
    expect(isCovered(r, 23.8)).toBe(false);
    expect(coveredRanges({ completedUntil: 300 })).toEqual([[0, 300]]);
    expect(coveredRanges({ covered: [[60, 72]], completedUntil: 24 })).toEqual([[0, 24], [60, 72]]);
  });

  it('merges a described stretch into the saved script and completes it with the last one', () => {
    const cue = (start, standard) => ({ start, gap: 3, kind: 'visual', priority: 1, brief: standard, standard, detailed: standard });
    let sc = newFramesScript({ videoId: 'bili:BV1GJ411x7h7', lang: 'zh-CN', duration: 30, platform: 'bilibili', provider: 'qwen' });
    sc = mergeFramesChunk(sc, { cues: [cue(5, '切鸡肉。')], characters: [], videoType: 'tutorial' }, { start: 0, end: 12, duration: 30, model: 'qwen-vl-max', provider: 'qwen' });
    expect(sc).toMatchObject({ covered: [[0, 12]], completedUntil: 12, complete: false, videoType: 'tutorial', model: 'qwen-vl-max', mode: 'frames' });
    sc = mergeFramesChunk(sc, { cues: [cue(20, '下锅。')], characters: [], videoType: '' }, { start: 12, end: 30, duration: 30 });
    expect(sc).toMatchObject({ covered: [[0, 30]], completedUntil: 30, complete: true });
    expect(sc.cues.map((c) => c.standard)).toEqual(['切鸡肉。', '下锅。']);
    expect(recentCues(sc, 25)).toEqual([{ start: 5, text: '切鸡肉。' }, { start: 20, text: '下锅。' }]);
  });
});

describe('who may send what, from Bilibili', () => {
  const page = (url, extra = {}) => ({ id: EXT, origin: new URL(url).origin, url, tab: { id: 3, url }, frameId: 0, ...extra });
  const video = page('https://www.bilibili.com/video/BV1GJ411x7h7/');

  it('trusts the content script on a Bilibili video page, in the top frame only', () => {
    expect(classifySender(video, EXT)).toBe('bilibili-content');
    expect(platformOfSender(video, EXT)).toBe('bilibili');
    expect(classifySender(page('https://www.bilibili.com/'), EXT)).toBe('rejected');
    expect(classifySender(page('https://space.bilibili.com/video/BV1GJ411x7h7'), EXT)).toBe('rejected');
    expect(classifySender({ ...video, frameId: 2, tab: { id: 3, url: 'https://example.com/' } }, EXT)).toBe('rejected');
    expect(classifySender({ ...video, tab: { id: 3, url: 'https://evil.example/' } }, EXT)).toBe('rejected');
    expect(classifySender({ ...video, origin: 'https://evil.example' }, EXT)).toBe('rejected');
    expect(classifySender({ ...video, id: 'another-extension' }, EXT)).toBe('external');
    expect(platformOfSender({ id: EXT }, EXT)).toBeNull();
  });

  it('lets that page do what a YouTube page may, and nothing more', () => {
    for (const type of [MSG.GET_STATUS, MSG.GET_SCRIPT, MSG.GEN_FRAMES, MSG.ASK, MSG.REVISE, MSG.SPEAK, MSG.STOP_SPEAKING, MSG.OPEN_OPTIONS, MSG.DELETE_SCRIPT]) {
      expect(authorizeBackgroundMessage(type, video, EXT), type).toBe(true);
    }
    for (const type of [MSG.JOB_EVENT, MSG.CACHE_CLEAR, MSG.CACHE_INFO, MSG.GET_VOICES, MSG.OFFSCREEN]) {
      expect(authorizeBackgroundMessage(type, video, EXT), type).toBe(false);
    }
    const popup = { id: EXT, origin: `chrome-extension://${EXT}`, url: `chrome-extension://${EXT}/popup.html` };
    expect(authorizeBackgroundMessage(MSG.GEN_FRAMES, popup, EXT)).toBe(false);
  });
});

describe('the manifest asks for as little as it can', () => {
  const manifest = JSON.parse(read('static/manifest.json'));

  it('runs on Bilibili video pages only, in the top frame', () => {
    const bili = manifest.content_scripts.filter((c) => c.matches.some((m) => m.includes('bilibili')));
    expect(bili).toEqual([{ matches: ['https://www.bilibili.com/video/*'], js: ['content.js'], run_at: 'document_idle', all_frames: false }]);
  });

  it('reaches only the two model APIs and the SceneVoice Cloud relay; Bilibili’s own APIs are called from the Bilibili page', () => {
    expect(manifest.host_permissions).toEqual(['https://generativelanguage.googleapis.com/*', 'https://dashscope.aliyuncs.com/*', 'https://api.scenevoice.app/*']);
    expect(manifest.permissions).toEqual(['storage', 'unlimitedStorage', 'tts', 'activeTab', 'offscreen']);
  });
});

describe('keys stay out of the page', () => {
  it('content scripts and the helpers they use never touch local storage or keys', () => {
    for (const file of ['src/content/bilibili.js', 'src/content/frames.js', 'src/content/dom.js', 'src/content/platforms.js', 'src/content/index.js', 'src/shared/providers.js', 'src/shared/platforms.js', 'src/shared/coverage.js']) {
      const text = read(file);
      expect(text, file).not.toMatch(/chrome\.storage\.local\s*\./);
      expect(text, file).not.toMatch(/apiKey/i);
      expect(text, file).not.toMatch(/from ['"][^'"]*(cache|qwen|describe)\.js['"]/);
    }
  });

  it('builds no content script code that talks to a model API', () => {
    const content = readdirSync(join(root, 'src/content')).map((f) => read(join('src/content', f))).join('\n');
    expect(content).not.toMatch(/dashscope|generativelanguage/);
  });
});

describe('messages', () => {
  const t = (key, ...subs) => STRINGS[key].en.replace(/\$(\d)/g, (_, n) => subs[n - 1]);

  it('has Qwen’s own words for every error a Qwen request can end in, in both languages', () => {
    for (const code of ['no-key', 'bad-key', 'forbidden', 'model-not-found', 'no-model', 'quota', 'server', 'request-failed', 'network', 'blocked', 'empty-response', 'truncated', 'bad-json']) {
      const key = `error_qwen_${code.replace(/-/g, '_')}`;
      expect(STRINGS[key]?.en, key).toBeTruthy();
      expect(STRINGS[key]?.zh_CN, key).toBeTruthy();
    }
    for (const code of ['frames-tainted', 'frames-unsupported', 'frames-not-ready', 'frames-unavailable', 'frames-failed', 'frames-missing', 'provider-unsupported']) {
      expect(STRINGS[`error_${code.replace(/-/g, '_')}`], code).toBeTruthy();
    }
    for (const p of ['gemini', 'qwen']) expect(STRINGS[`provider_name_${p}`], p).toBeTruthy();
    expect(t('status_live_start', 'Qwen')).toMatch(/to Qwen/);
  });

  it('names the right model in an error, and keeps Gemini’s words for Gemini', () => {
    globalThis.chrome = fakeChrome({ locale: 'zh_CN' }).chrome;
    expect(errorMessage('bad-key', 'qwen')).toBe('通义千问 API Key 无效，请在 SceneVoice 设置页检查。');
    expect(errorMessage('bad-key', 'gemini')).toBe('Gemini API 密钥无效，请在 SceneVoice 设置页检查。');
    expect(errorMessage('bad-key')).toBe('Gemini API 密钥无效，请在 SceneVoice 设置页检查。');
    // No Qwen wording of its own: the shared message.
    expect(errorMessage('too-long', 'qwen')).toBe('这段视频即使拆成小段，模型也处理不了。请在设置页换一个模型再试。');
    expect(errorMessage('frames-tainted', 'qwen')).toMatch(/^SceneVoice 截不到这个视频的画面：.*跨域保护/);
    expect(errorMessage('made-up', 'qwen')).toBe('出现了问题，请重试。');
  });
});
