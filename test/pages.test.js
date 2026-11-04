// @vitest-environment jsdom
// The popup and settings page, loaded from their real HTML with a fake chrome.*:
// quick settings, voices, restore defaults, and what screen readers are told.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const VOICES = [
  { name: 'Samantha', lang: 'en-US' },
  { name: 'Thomas', lang: 'fr-FR' },
  { name: 'Meijia', lang: 'zh-TW' },
  { name: 'Tingting', lang: 'zh-CN' },
  { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
];

const COMMANDS = [
  { name: 'toggle-descriptions', description: 'Create descriptions, or turn them on and off', shortcut: 'Alt+Shift+D' },
  { name: 'cycle-detail', description: 'Change the level of detail', shortcut: '' },
  { name: 'speed-up', description: 'Speak faster', shortcut: '' },
];

let fake;

// A page left polling (the popup while "generating") would fire into the next
// test's document: every timer a page sets is remembered and cleared before
// the next page is loaded.
const timers = new Set();
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const id = realSetTimeout(...args);
  timers.add(id);
  return id;
};

/** Load an extension page's HTML (without running its script tag) and then its module. */
async function openPage(page, opts = {}) {
  // The page before is left, as when its tab closes: what it does on unload (the
  // welcome page stops its sample) happens now, against its own fake, not in this test.
  window.dispatchEvent(new Event('pagehide'));
  for (const id of timers) clearTimeout(id);
  timers.clear();
  const html = readFileSync(join(root, 'src', page, `${page}.html`), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/g, '');
  fake = fakeChrome({
    commands: COMMANDS,
    ...opts,
    reply: (msg) => {
      if (msg.type === MSG.GET_VOICES) return { voices: opts.voices ?? VOICES };
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: opts.shortcuts ?? { 'toggle-descriptions': 'Alt+Shift+D', 'describe-now': 'Alt+Shift+S' }, ...opts.status };
      if (msg.type === MSG.CACHE_INFO) return { count: 0, bytes: 0 };
      return { ok: true };
    },
  });
  globalThis.chrome = fake.chrome;
  window.confirm = vi.fn(() => true);
  vi.resetModules();
  await import(`../src/${page}/${page}.js`);
  // Wait for init() to finish: these are filled in after every listener is attached.
  const last = { options: '#cacheInfo', guide: null, popup: '#quickKeys', welcome: '#shortcutText' }[page];
  if (last) await vi.waitFor(() => expect(document.querySelector(last).textContent).not.toBe(''));
}

const $ = (sel) => document.querySelector(sel);
const settle = () => new Promise((r) => setTimeout(r, 10));
const stored = () => fake.areas.sync.settings || {};

function choose(el) {
  if (el.type === 'radio' || el.type === 'checkbox') el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectValue(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Every control a keyboard user can reach has a name a screen reader can read. */
function unnamedControls() {
  return [...document.querySelectorAll('input, select, button, textarea')].filter((el) => {
    if (el.type === 'hidden') return false;
    const labelled = [...(el.labels || [])].some((l) => l.textContent.trim());
    const aria = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').some((id) => document.getElementById(id)?.textContent.trim());
    const text = el.tagName === 'BUTTON' && el.textContent.trim();
    return !(labelled || aria || text);
  });
}

/** axe-core accessibility rules that work without layout (jsdom has none; the e2e test runs the rest in Chromium). */
async function axeViolations() {
  const axe = (await import('axe-core')).default;
  const { violations } = await axe.run(document, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

afterEach(() => {
  // Leave the page while it is still there, as a closing tab does (see openPage).
  window.dispatchEvent(new Event('pagehide'));
  document.documentElement.innerHTML = '';
});

describe('accessibility checks', () => {
  it('popup, in both voice modes', async () => {
    await openPage('popup');
    expect(await axeViolations()).toEqual([]);
    choose($('input[name=output][value=tts]'));
    await vi.waitFor(() => expect($('#ttsSpeed').hidden).toBe(false));
    expect(await axeViolations()).toEqual([]);
  });

  it('key guide, in both languages', async () => {
    await openPage('guide');
    expect(await axeViolations()).toEqual([]);
    await openPage('guide', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect(await axeViolations()).toEqual([]);
  });

  it('settings page, with the built-in voice options shown', async () => {
    await openPage('options', { sync: { settings: { output: 'tts', language: 'zh-CN' } } });
    await vi.waitFor(() => expect($('#voice optgroup')).not.toBeNull());
    expect(await axeViolations()).toEqual([]);
  });
});

describe('popup quick settings', () => {
  it('shows the screen reader speed for screen reader output, with a hint, and names every control', async () => {
    await openPage('popup');
    await vi.waitFor(() => expect($('#readerSpeed').hidden).toBe(false));
    expect($('#ttsSpeed').hidden).toBe(true);
    const select = $('#readerSpeed select');
    expect(select.value).toBe('1.6');
    expect(select.getAttribute('aria-describedby')).toBe('readerSpeedHint');
    expect($('#readerSpeedHint').textContent).toMatch(/cannot hear your screen reader/);
    // Detail and mode are in the popup too.
    expect(document.querySelectorAll('input[name=detail]')).toHaveLength(3);
    expect(document.querySelectorAll('input[name=mode]')).toHaveLength(3);
    expect(unnamedControls()).toEqual([]);
  });

  it('saves the screen reader speed', async () => {
    await openPage('popup');
    await vi.waitFor(() => expect($('#readerSpeed').hidden).toBe(false));
    selectValue($('#readerSpeed select'), '3.2');
    await vi.waitFor(() => expect(stored().readerSpeed).toBe(3.2));
  });

  it('switches to the speaking rate slider for the built-in voice, read out as "1.2×"', async () => {
    await openPage('popup');
    await vi.waitFor(() => expect($('#readerSpeed').hidden).toBe(false));
    choose($('input[name=output][value=tts]'));
    await vi.waitFor(() => expect($('#ttsSpeed').hidden).toBe(false));
    expect($('#readerSpeed').hidden).toBe(true);
    const rate = $('#rate');
    expect(rate.getAttribute('aria-valuetext')).toBe('1.2×');
    expect($('#rateOut').textContent).toBe('1.2×');
    expect($('#rateOut').getAttribute('aria-hidden')).toBe('true');

    // Moving the slider updates what is read out at once, and saves on release.
    rate.value = '1.5';
    rate.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rate.getAttribute('aria-valuetext')).toBe('1.5×');
    await settle();
    expect(stored().ttsRate).toBe(1.2);
    rate.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(stored().ttsRate).toBe(1.5));
  });

  it('changes detail and mode with a single choice each', async () => {
    await openPage('popup');
    await vi.waitFor(() => expect($('input[name=detail][value=standard]').checked).toBe(true));
    choose($('input[name=detail][value=detailed]'));
    choose($('input[name=mode][value=pause]'));
    await vi.waitFor(() => expect(stored()).toMatchObject({ detail: 'detailed', mode: 'pause' }));
  });

  it('tests the voice in the description language, with the saved rate, pitch and voice', async () => {
    await openPage('popup', {
      locale: 'zh_CN',
      uiLanguage: 'zh-CN',
      sync: { settings: { output: 'tts', language: 'auto', ttsRate: 1.4, ttsPitch: 1.2, ttsVoices: { 'zh-CN': 'Tingting' } } },
    });
    await vi.waitFor(() => expect($('#ttsSpeed').hidden).toBe(false));
    expect($('#testVoice').textContent).toBe('试听');
    expect($('#rate').getAttribute('aria-valuetext')).toBe('1.4 倍');
    $('#testVoice').click();
    await vi.waitFor(() => expect(fake.sent.some((m) => m.type === MSG.SPEAK)).toBe(true));
    expect(fake.sent.find((m) => m.type === MSG.SPEAK)).toMatchObject({
      text: '一位穿红色大衣的女人走过积雪的街道。',
      lang: 'zh-CN',
      rate: 1.4,
      pitch: 1.2,
      voice: 'Tingting',
    });
  });

  it('says where to set shortcuts for the quick settings, or which keys they have', async () => {
    await openPage('popup');
    await vi.waitFor(() => expect($('#quickKeys').textContent).toMatch(/can each have a shortcut/));
    await openPage('popup', { shortcuts: { 'cycle-detail': 'Alt+Shift+1', 'cycle-density': 'Alt+Shift+3', 'speed-up': 'Alt+Shift+Up' } });
    await vi.waitFor(() => expect($('#quickKeys').textContent).toBe('Shortcuts: Alt+Shift+1 detail · Alt+Shift+3 how much to describe · Alt+Shift+Up faster'));
  });

  it('reads on-screen text by default, with a switch that says what it reads', async () => {
    for (const page of ['popup', 'options']) {
      await openPage(page);
      const box = $('input[data-setting=onScreenText]');
      await vi.waitFor(() => expect(box.checked).toBe(true));
      expect(box.labels[0].textContent.trim()).toBe('Read on-screen text');
      expect(box.getAttribute('aria-describedby')).toBe('onScreenTextHint');
      expect($('#onScreenTextHint').textContent).toMatch(/prices, contact details, code and menus, word for word and before other descriptions/);
      expect([...document.querySelectorAll('input[name=density]')].map((r) => r.labels[0].querySelector('span').textContent)).toEqual(['Essentials only', 'Moderate', 'As much as possible']);
      expect($('input[name=density][value=standard]').checked).toBe(true);
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(stored().onScreenText).toBe(false));
      // Not one of the settings the video type decides.
      expect(stored()).not.toHaveProperty('densityChosen', true);
    }
  });

  it('labels the on-screen text switch and density in Chinese', async () => {
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect($('input[data-setting=onScreenText]').labels[0].textContent.trim()).toBe('朗读屏幕文字');
    expect($('#onScreenTextHint').textContent).toBe('标题、人名、幻灯片、图表数字、价格、联系方式、代码、菜单等按原文朗读，并且优先于其他描述；对白里已经说出的文字不再重复。');
    expect($('fieldset:has(input[name=density]) legend').textContent).toBe('描述密度');
    expect([...document.querySelectorAll('input[name=density]')].map((r) => r.labels[0].textContent)).toEqual(['仅关键', '适中', '尽量多']);
  });

  it('says so when a setting could not be saved, and clears the message on the next change', async () => {
    await openPage('popup');
    await vi.waitFor(() => expect($('input[name=detail][value=standard]').checked).toBe(true));
    const status = $('#settingsStatus');
    expect(status.getAttribute('role')).toBe('status');
    fake.failSyncWrites(1);
    choose($('input[name=detail][value=brief]'));
    await vi.waitFor(() => expect(status.textContent).toMatch(/could not be saved/));
    choose($('input[name=detail][value=detailed]'));
    expect(status.textContent).toBe('');
    await vi.waitFor(() => expect(stored().detail).toBe('detailed'));
  });
});

describe('popup: interface and description languages', () => {
  const tab = (lang) => (msg) =>
    msg.type === MSG.TAB_STATE ? { supported: true, videoId: 'abcdefghijk', title: 'Diner', status: 'ready', cueCount: 4, firstCue: 1, lang, videoType: '' } : { ok: true };

  it('says nothing when the descriptions are in the interface language', async () => {
    await openPage('popup');
    await vi.waitFor(() => expect($('input[name=detail][value=standard]').checked).toBe(true));
    expect($('#languageNote').hidden).toBe(true);
    expect($('#languageNote').textContent).toBe('');
    expect($('#language').hasAttribute('aria-describedby')).toBe(false);
  });

  it('names both when a browser language without an interface gets descriptions of its own', async () => {
    await openPage('popup', { uiLanguage: 'sv-SE' });
    await vi.waitFor(() => expect($('#languageNote').hidden).toBe(false));
    expect($('#languageNote').textContent).toBe('Interface: English · Descriptions: svenska');
    expect($('#language').getAttribute('aria-describedby')).toBe('languageNote');
  });

  it('follows the language of the video in the tab, in Chinese for a Chinese interface', async () => {
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN', tabReply: tab('en') });
    await vi.waitFor(() => expect($('#languageNote').hidden).toBe(false));
    expect($('#languageNote').textContent).toBe('界面语言：简体中文 · 口述语言：English');
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN', tabReply: tab('zh-CN') });
    await vi.waitFor(() => expect($('#videoTitle').textContent).toBe('Diner'));
    expect($('#languageNote').hidden).toBe(true);
  });

  it('marks right-to-left language names as such in the list', async () => {
    await openPage('popup');
    expect($('#language option[value=ar]').getAttribute('dir')).toBe('rtl');
    expect($('#language option[value=ur]').lang).toBe('ur');
    expect($('#language option[value=fr]').hasAttribute('dir')).toBe(false);
  });
});

describe('the language a page declares', () => {
  it('is the language of the strings shown, not the browser locale: English, left to right, for a browser language without strings of its own', async () => {
    // An Italian browser gets English strings (no it.mjs): a screen reader must not read them with an Italian voice.
    await openPage('welcome', { locale: 'it', uiLanguage: 'it-IT' });
    expect($('#title').textContent).toBe('Welcome to SceneVoice');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    // Strings of its own: that language, and its direction.
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dir).toBe('ltr');
    await openPage('options', { locale: 'ar', uiLanguage: 'ar' });
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('popup: a Hebrew browser gets English text, so not laid out right to left either', async () => {
    await openPage('popup', { locale: 'he', uiLanguage: 'he' });
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('popup: names both languages for a browser language without strings of its own, whatever locale the browser reports', async () => {
    await openPage('popup', { locale: 'sv', uiLanguage: 'sv-SE' });
    await vi.waitFor(() => expect($('#languageNote').hidden).toBe(false));
    expect($('#languageNote').textContent).toBe('Interface: English · Descriptions: svenska');
  });
});

describe('popup: description is wrong', () => {
  const tab = (cueCount) => (msg) =>
    msg.type === MSG.TAB_STATE ? { supported: true, videoId: 'abcdefghijk', title: 'Diner', status: 'ready', cueCount, firstCue: 1, lang: 'en', videoType: '' } : { ok: true };

  it('offers it once there are descriptions, with a hint that says what it does and where the mark stays', async () => {
    await openPage('popup', { tabReply: tab(4) });
    await vi.waitFor(() => expect($('#report').hidden).toBe(false));
    expect($('#report').textContent).toBe('Last description is wrong');
    expect($('#report').getAttribute('aria-describedby')).toBe('reportHint');
    expect($('#reportHint').hidden).toBe(false);
    expect($('#reportHint').textContent).toMatch(/describes only that moment again\. The mark stays on this computer\./);
    expect(unnamedControls()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('is not offered when there are no descriptions', async () => {
    await openPage('popup', { tabReply: tab(0) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toMatch(/nothing visual that needs describing/));
    expect($('#report').hidden).toBe(true);
    expect($('#reportHint').hidden).toBe(true);
  });

  it('asks the tab, then closes so the screen reader hears the page', async () => {
    const asked = [];
    await openPage('popup', { tabReply: (msg) => (asked.push(msg), tab(4)(msg)) });
    await vi.waitFor(() => expect($('#report').hidden).toBe(false));
    window.close = vi.fn();
    $('#report').click();
    await vi.waitFor(() => expect(asked).toContainEqual({ type: MSG.TAB_ACTION, action: 'report-wrong' }));
    expect(window.close).toHaveBeenCalled();
  });

  it('is in Chinese for a Chinese interface', async () => {
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN', tabReply: tab(4) });
    await vi.waitFor(() => expect($('#report').hidden).toBe(false));
    expect($('#report').textContent).toBe('上一条描述有误');
    expect($('#reportHint').textContent).toBe('把刚听到的描述（没有的话就是当前这一刻的描述）标记为有误，只重新生成这一段。标记记录只保存在这台电脑上。');
  });
});

describe('popup and the video type', () => {
  const tab = (videoType) => (msg) =>
    msg.type === MSG.TAB_STATE ? { supported: true, videoId: 'abcdefghijk', title: 'Tie a bowline', status: 'ready', cueCount: 4, firstCue: 1, lang: 'en', videoType } : null;
  const checked = (name) => $(`input[name=${name}]:checked`)?.value;

  it('shows the mode and detail a tutorial uses, and says why', async () => {
    await openPage('popup', { tabReply: tab('tutorial') });
    await vi.waitFor(() => expect($('#typeNote').hidden).toBe(false));
    expect($('#typeNote').textContent).toBe('Tutorial or explainer: SceneVoice will pause when needed, with detailed descriptions. Choose another option below to keep it for every video.');
    expect(checked('mode')).toBe('pause');
    expect(checked('detail')).toBe('detailed');
    // Nothing is saved: the type only applies to this video.
    expect(stored()).toEqual({});
    for (const fieldset of document.querySelectorAll('fieldset:has(input[name=mode]), fieldset:has(input[name=detail]), fieldset:has(input[name=density])')) {
      expect(fieldset.getAttribute('aria-describedby')).toBe('typeNote');
    }
    expect(await axeViolations()).toEqual([]);
  });

  it("makes a choice in the popup the user's own, for every video", async () => {
    await openPage('popup', { tabReply: tab('tutorial') });
    await vi.waitFor(() => expect(checked('mode')).toBe('pause'));
    choose($('input[name=mode][value=gaps]'));
    await vi.waitFor(() => expect(stored()).toMatchObject({ mode: 'gaps', modeChosen: true, detailChosen: false }));
    await vi.waitFor(() => expect($('#typeNote').textContent).toMatch(/^Tutorial or explainer: SceneVoice switches to detailed descriptions\./));
    expect(checked('mode')).toBe('gaps');
    expect(checked('detail')).toBe('detailed');
  });

  it('shows the saved settings when adjusting is off, the type is unknown or there is no video', async () => {
    await openPage('popup', { tabReply: tab('tutorial'), sync: { settings: { autoByType: false } } });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toMatch(/4 descriptions ready/));
    expect($('#typeNote').hidden).toBe(true);
    expect($('#typeNote').textContent).toBe('');
    expect(checked('mode')).toBe('gaps');
    expect(checked('detail')).toBe('standard');

    await openPage('popup', { tabReply: tab('') });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toMatch(/4 descriptions ready/));
    expect($('#typeNote').hidden).toBe(true);

    await openPage('popup');
    await vi.waitFor(() => expect($('#videoStatus').textContent).toMatch(/Open a YouTube or Bilibili video/));
    expect($('#typeNote').hidden).toBe(true);
  });

  it('explains it in Chinese for a Chinese interface', async () => {
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN', tabReply: tab('entertainment') });
    await vi.waitFor(() => expect($('#typeNote').hidden).toBe(false));
    expect($('#typeNote').textContent).toBe('娱乐类视频，已切换为简短口述。 描述密度为“仅关键”。 在下面另选一项，之后每个视频都按你的选择。');
    expect(checked('detail')).toBe('brief');
    expect(checked('density')).toBe('essential');
    expect($('input[name=density][value=essential]').labels[0].textContent).toBe('仅关键');
  });
});

describe('settings page', () => {
  const ttsChinese = { settings: { output: 'tts', language: 'zh-CN' } };

  it('lists voices for the description language first, Chinese included', async () => {
    await openPage('options', { sync: ttsChinese });
    await vi.waitFor(() => expect($('#voice optgroup')).not.toBeNull());
    expect($('#voiceLabel').textContent).toBe('Voice for Simplified Chinese descriptions');
    const groups = [...document.querySelectorAll('#voice optgroup')];
    expect(groups.map((g) => g.label)).toEqual(['Simplified Chinese voices', 'Other languages']);
    expect([...groups[0].querySelectorAll('option')].map((o) => o.value)).toEqual(['Google 普通话（中国大陆）', 'Tingting', 'Meijia']);
    expect([...groups[1].querySelectorAll('option')].map((o) => o.value)).toEqual(['Samantha', 'Thomas']);
    expect($('#voice option[value=Tingting]').textContent).toBe('Tingting (Simplified Chinese)');
    expect($('#voice option[value=Tingting]').lang).toBe('zh-CN');
    expect($('#voice').value).toBe('');
    expect($('#voice').getAttribute('aria-describedby')).toBe('voiceHint voiceNote');
    expect(unnamedControls()).toEqual([]);
  });

  it('remembers a voice for each description language', async () => {
    await openPage('options', { sync: ttsChinese });
    await vi.waitFor(() => expect($('#voice optgroup')).not.toBeNull());
    selectValue($('#voice'), 'Tingting');
    await vi.waitFor(() => expect(stored().ttsVoices).toEqual({ 'zh-CN': 'Tingting' }));

    selectValue($('#language'), 'en');
    await vi.waitFor(() => expect($('#voiceLabel').textContent).toBe('Voice for English descriptions'));
    expect($('#voice').value).toBe('');
    expect($('#voice optgroup').label).toBe('English voices');
    selectValue($('#voice'), 'Samantha');
    await vi.waitFor(() => expect(stored().ttsVoices).toEqual({ 'zh-CN': 'Tingting', en: 'Samantha' }));

    selectValue($('#language'), 'zh-CN');
    await vi.waitFor(() => expect($('#voice').value).toBe('Tingting'));
  });

  it('labels the voice list in Chinese for a Chinese interface', async () => {
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN', sync: ttsChinese });
    await vi.waitFor(() => expect($('#voice optgroup')).not.toBeNull());
    expect($('#voiceLabel').textContent).toBe('朗读简体中文口述的语音');
    expect($('#voice optgroup').label).toBe('简体中文语音');
    expect($('#voice option[value=Tingting]').textContent).toBe('Tingting（简体中文）');
    expect($('#pitch').getAttribute('aria-valuetext')).toBe('标准');
  });

  it('warns when no installed voice speaks the description language', async () => {
    await openPage('options', { sync: ttsChinese, voices: [{ name: 'Samantha', lang: 'en-US' }] });
    await vi.waitFor(() => expect($('#voiceNote').textContent).toMatch(/no Simplified Chinese voice/));
    expect($('#voiceNote').getAttribute('aria-live')).toBe('polite');
  });

  it('keeps a voice chosen on another computer, and says it is not available here', async () => {
    await openPage('options', { sync: { settings: { ...ttsChinese.settings, ttsVoices: { 'zh-CN': 'Microsoft Huihui' } } } });
    await vi.waitFor(() => expect($('#voice').value).toBe('Microsoft Huihui'));
    expect($('#voice option[value="Microsoft Huihui"]').textContent).toBe('Microsoft Huihui (not on this computer)');
    expect($('#voiceNote').textContent).toMatch(/not on this computer/);
  });

  it('warns when the chosen voice is for another language', async () => {
    await openPage('options', { sync: ttsChinese });
    await vi.waitFor(() => expect($('#voice optgroup')).not.toBeNull());
    selectValue($('#voice'), 'Samantha');
    await vi.waitFor(() => expect($('#voiceNote').textContent).toBe('This voice is for American English. It may not read Simplified Chinese descriptions properly.'));
  });

  it('adjusts pitch, and reads slider values as words', async () => {
    await openPage('options', { sync: ttsChinese });
    await vi.waitFor(() => expect($('#pitch').getAttribute('aria-valuetext')).toBe('Normal'));
    expect($('#rate').getAttribute('aria-valuetext')).toBe('1.2×');
    expect($('#duckLevel').getAttribute('aria-valuetext')).toBe('35%');
    expect($('#duckOut').textContent).toBe('35%');
    expect($('#pitch').getAttribute('aria-describedby')).toBe('pitchHint');
    const pitch = $('#pitch');
    pitch.value = '1.3';
    pitch.dispatchEvent(new Event('input', { bubbles: true }));
    expect(pitch.getAttribute('aria-valuetext')).toBe('130%');
    expect($('#pitchOut').textContent).toBe('130%');
    pitch.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(stored().ttsPitch).toBe(1.3));
  });

  it('tests the chosen voice with a sentence in the description language, not the interface language', async () => {
    await openPage('options', { sync: { settings: { ...ttsChinese.settings, ttsPitch: 0.8, ttsVoices: { 'zh-CN': 'Tingting' } } } });
    await vi.waitFor(() => expect($('#voice').value).toBe('Tingting'));
    $('#testVoice').click();
    await vi.waitFor(() => expect(fake.sent.some((m) => m.type === MSG.SPEAK)).toBe(true));
    expect(fake.sent.find((m) => m.type === MSG.SPEAK)).toMatchObject({ text: '一位穿红色大衣的女人走过积雪的街道。', lang: 'zh-CN', pitch: 0.8, voice: 'Tingting', id: 'test' });
  });

  it('restores the default settings after asking, and keeps the key and saved descriptions', async () => {
    const local = { local: { apiKey: '', model: 'gemini-2.5-flash' }, 'script:abcdefghijk:en': { cues: [] } };
    await openPage('options', {
      local,
      sync: { settings: { output: 'tts', detail: 'brief', mode: 'manual', ttsRate: 2.5, ttsPitch: 1.4, ttsVoices: { en: 'Samantha' }, duckLevel: 0.6 } },
    });
    await vi.waitFor(() => expect($('input[name=detail][value=brief]').checked).toBe(true));
    const button = $('#resetSettings');
    expect(button.getAttribute('aria-describedby')).toBe('resetIntro');

    window.confirm.mockReturnValueOnce(false);
    button.click();
    await settle();
    expect(stored().detail).toBe('brief');

    button.click();
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringMatching(/API key and saved descriptions stay/));
    await vi.waitFor(() => expect($('#settingsStatus').textContent).toBe('Default settings restored.'));
    expect($('#settingsStatus').getAttribute('role')).toBe('status');
    expect(fake.areas.sync.settings).toBeUndefined();
    expect(fake.areas.local).toEqual(local);
    await vi.waitFor(() => expect($('input[name=detail][value=standard]').checked).toBe(true));
    expect($('input[name=mode][value=gaps]').checked).toBe(true);
    expect($('input[name=output][value=screenreader]').checked).toBe(true);
    expect($('#ttsOptions').hidden).toBe(true);
    expect($('#rate').getAttribute('aria-valuetext')).toBe('1.2×');
    expect($('#pitch').getAttribute('aria-valuetext')).toBe('Normal');
    expect($('#duckOut').textContent).toBe('35%');
  });

  it('says when restoring the defaults failed', async () => {
    await openPage('options', { sync: ttsChinese });
    await vi.waitFor(() => expect($('#voice optgroup')).not.toBeNull());
    fake.chrome.storage.sync.remove = async () => {
      throw new Error('quota');
    };
    $('#resetSettings').click();
    await vi.waitFor(() => expect($('#settingsStatus').textContent).toMatch(/could not be restored/));
    expect($('#settingsStatus').className).toContain('status-bad');
  });

  it('shows save errors next to the settings, not in the API key section', async () => {
    await openPage('options', { sync: ttsChinese });
    await vi.waitFor(() => expect($('#voice optgroup')).not.toBeNull());
    fake.failSyncWrites(1);
    choose($('input[name=detail][value=brief]'));
    await vi.waitFor(() => expect($('#settingsStatus').textContent).toMatch(/could not be saved/));
    expect($('#keyStatus').textContent).not.toMatch(/could not be saved/);
  });

  it('sets the mode, detail and density for each video type, changeable while adjusting is on', async () => {
    await openPage('options');
    const box = $('#autoByType');
    await vi.waitFor(() => expect(box.checked).toBe(true));
    expect(box.getAttribute('aria-describedby')).toBe('autoByTypeHint');
    expect($('#autoByTypeHint').textContent).toMatch(/A mode, detail or amount you choose yourself .* always comes first/);
    expect($('#h-type').tagName).toBe('H3');
    const select = (key) => $(`select[data-setting=${key}]`);
    expect([select('entertainmentMode').value, select('entertainmentDetail').value]).toEqual(['gaps', 'brief']);
    expect([select('tutorialMode').value, select('tutorialDetail').value]).toEqual(['pause', 'detailed']);
    expect([select('entertainmentDensity').value, select('tutorialDensity').value]).toEqual(['essential', 'standard']);
    expect(select('entertainmentDensity').labels[0].querySelector('span').textContent).toBe('How much to describe');
    // Each list is named by its own label, inside a group named for the type.
    expect(select('tutorialMode').labels[0].querySelector('span').textContent).toBe('When a description does not fit');
    expect(select('tutorialMode').closest('fieldset').querySelector('legend').textContent).toMatch(/^Tutorials and explainers/);
    expect(unnamedControls()).toEqual([]);
    expect($('#typeChosenBox').hidden).toBe(true);

    selectValue(select('tutorialMode'), 'manual');
    await vi.waitFor(() => expect(stored().tutorialMode).toBe('manual'));
    selectValue(select('entertainmentDensity'), 'standard');
    await vi.waitFor(() => expect(stored().entertainmentDensity).toBe('standard'));
    // A type's setting is not a choice of the general one.
    expect(stored()).toMatchObject({ modeChosen: false, densityChosen: false });

    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(stored().autoByType).toBe(false));
    await vi.waitFor(() => expect($('#typeTutorial').disabled).toBe(true));
    expect($('#typeEntertainment').disabled).toBe(true);
    expect(await axeViolations()).toEqual([]);
  });

  it('says which of mode, detail and density the user chose, and lets the video type decide again', async () => {
    await openPage('options', { sync: { settings: { mode: 'manual', modeChosen: true } } });
    await vi.waitFor(() => expect($('#typeChosenBox').hidden).toBe(false));
    expect($('#typeChosen').textContent).toBe('You chose the mode yourself, so the video type now decides only the detail and how much to describe.');
    expect($('#typeAgain').getAttribute('aria-describedby')).toBe('typeChosen');
    expect(await axeViolations()).toEqual([]);

    choose($('input[name=detail][value=brief]'));
    await vi.waitFor(() => expect($('#typeChosen').textContent).toBe('You chose the mode and the detail yourself, so the video type now decides only how much to describe.'));
    choose($('input[name=density][value=full]'));
    await vi.waitFor(() => expect($('#typeChosen').textContent).toBe('You chose the mode, the detail and how much to describe yourself, so every video uses your choice.'));

    $('#typeAgain').click();
    await vi.waitFor(() => expect(stored()).toMatchObject({ modeChosen: false, detailChosen: false, densityChosen: false }));
    // The values stay; they are just no longer the user's own choice.
    expect(stored()).toMatchObject({ mode: 'manual', detail: 'brief', density: 'full' });
    await vi.waitFor(() => expect($('#typeChosenBox').hidden).toBe(true));
    expect(document.activeElement).toBe($('#autoByType'));
    expect($('#settingsStatus').textContent).toBe('Mode, detail and how much to describe follow the video type again.');
  });

  it('labels the video type settings in Chinese', async () => {
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN', sync: { settings: { detail: 'brief', detailChosen: true } } });
    await vi.waitFor(() => expect($('#typeChosenBox').hidden).toBe(false));
    expect($('#autoByType').labels[0].textContent).toBe('按视频类型自动调整');
    expect([...document.querySelectorAll('.type-grid legend')].map((l) => l.textContent)).toEqual(['娱乐类：影视、音乐、Vlog、游戏', '教程讲解类：教学、操作演示、科普、新闻图表']);
    expect($('select[data-setting=tutorialMode] option[value=pause]').textContent).toBe('暂停视频');
    expect($('#typeChosen').textContent).toBe('详细程度是你自己选的，所以只有模式和描述密度会按视频类型调整。');
    expect($('select[data-setting=entertainmentDensity] option[value=full]').textContent).toBe('尽量多');
    expect($('#typeAgain').textContent).toBe('重新按视频类型调整');
  });

  it('hides the note about own choices when adjusting is off', async () => {
    await openPage('options', { sync: { settings: { autoByType: false, mode: 'pause', modeChosen: true } } });
    await vi.waitFor(() => expect($('#typeTutorial').disabled).toBe(true));
    expect($('#typeChosenBox').hidden).toBe(true);
  });

  it('shows on-screen text exactly as written in the transcript, where the description does not quote it in full', async () => {
    const cues = [
      { start: 3, gap: 2, kind: 'text', priority: 1, onScreenText: 'hello@joes.example / 555-0199', brief: 'Contact: email and phone', standard: 'Contact: email hello at joes dot example, phone 555-0199', detailed: 'x' },
      { start: 9, gap: 2, kind: 'text', priority: 1, onScreenText: 'OPEN', brief: 'Sign: OPEN', standard: 'Sign: OPEN', detailed: 'Sign: OPEN' },
      { start: 12, gap: 2, kind: 'visual', priority: 1, brief: 'She smiles.', standard: 'She smiles.', detailed: 'She smiles.' },
      { start: 15, gap: 2, kind: 'visual', priority: 1, brief: 'A man waves.', standard: 'A man waves.', detailed: 'A man waves.', revised: true },
    ];
    jsdom.reconfigure({ url: 'https://extension.test/transcript.html?v=abcdefghijk&lang=en&title=Diner' });
    URL.createObjectURL = vi.fn(() => 'blob:transcript');
    URL.revokeObjectURL = vi.fn();
    try {
      const html = readFileSync(join(root, 'src', 'transcript', 'transcript.html'), 'utf8');
      document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/g, '');
      fake = fakeChrome({ local: { 'script:abcdefghijk:en': { version: 2, cues, model: 'gemini-test' } } });
      globalThis.chrome = fake.chrome;
      vi.resetModules();
      await import('../src/transcript/transcript.js');
      await vi.waitFor(() => expect($('#table').hidden).toBe(false));
      const cells = [...document.querySelectorAll('#rows td:not(.time)')];
      expect(cells[0].querySelector('.exact').textContent).toBe('Exact text: hello@joes.example / 555-0199');
      // Already quoted in full, or not text: nothing added.
      expect(cells[1].querySelector('.exact')).toBeNull();
      expect(cells[2].querySelector('.exact')).toBeNull();
      expect(cells[0].textContent).toBe('On screenContact: email hello at joes dot example, phone 555-0199Exact text: hello@joes.example / 555-0199');
      // A description corrected after the user marked it as wrong says so.
      expect([...cells[3].querySelectorAll('.tag')].map((tag) => tag.textContent)).toEqual(['Corrected']);
      expect(cells[2].querySelector('.tag')).toBeNull();
    } finally {
      jsdom.reconfigure({ url: 'http://localhost:3000/' });
    }
  });

  it('names a description language outside the list in itself in the transcript intro, never by its code', async () => {
    const cues = [{ start: 3, gap: 2, kind: 'visual', priority: 1, brief: 'Hon ler.', standard: 'Hon ler.', detailed: 'Hon ler.' }];
    jsdom.reconfigure({ url: 'https://extension.test/transcript.html?v=abcdefghijk&lang=sv&title=Diner' });
    URL.createObjectURL = vi.fn(() => 'blob:transcript');
    URL.revokeObjectURL = vi.fn();
    try {
      const html = readFileSync(join(root, 'src', 'transcript', 'transcript.html'), 'utf8');
      document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/g, '');
      fake = fakeChrome({ local: { 'script:abcdefghijk:sv': { version: 2, cues, model: 'gemini-test' } } });
      globalThis.chrome = fake.chrome;
      vi.resetModules();
      await import('../src/transcript/transcript.js');
      await vi.waitFor(() => expect($('#table').hidden).toBe(false));
      expect($('#intro').textContent).toBe('1 descriptions · language svenska · model gemini-test');
      expect($('#intro').textContent).not.toMatch(/\bsv\b/);
    } finally {
      jsdom.reconfigure({ url: 'http://localhost:3000/' });
    }
  });

  it('says that marks of wrong descriptions stay on this computer, and what a correction sends', async () => {
    await openPage('options');
    const items = [...document.querySelectorAll('ul.small li')].map((li) => li.textContent);
    expect(items).toContain('The descriptions you mark as wrong are recorded only on this computer, so the corrected versions are kept. They are never sent to the developer, and are stripped before a video’s descriptions are shared. The record is deleted with the saved descriptions.');
    // The own-key statement is qualified, and the optional relay has a point of its own right after it.
    const ownKey = items.findIndex((s) => s.startsWith('With your own key, SceneVoice has no server and no account'));
    expect(ownKey).toBeGreaterThanOrEqual(0);
    expect(items[ownKey + 1]).toMatch(/^SceneVoice Cloud is off until you press “Start free”\./);
    expect(items[ownKey + 1]).toMatch(/“Stop using Cloud” removes the token\./);
    expect(items.some((s) => /SceneVoice has no server and no account\. It does not/.test(s))).toBe(false);
    expect(items.find((s) => s.startsWith('To create descriptions'))).toMatch(/To describe a moment again, the description you marked as wrong is sent too\./);
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect([...document.querySelectorAll('ul.small li')].map((li) => li.textContent)).toContain('你标记有误的描述只记录在这台电脑上，用来保留更正后的版本。它们不会发给开发者，分享口述前也会先去掉；删除已保存的口述时，这些记录会一并删除。');
  });

  it('lists the new speed shortcuts, unset by default', async () => {
    await openPage('options');
    await vi.waitFor(() => expect(document.querySelectorAll('#shortcuts tr')).toHaveLength(3));
    const rows = [...document.querySelectorAll('#shortcuts tr')].map((tr) => tr.textContent);
    expect(rows).toContain('Speak fasterNot set');
  });
});

describe('settings page: models for each site, and the Qwen key', () => {
  const okChat = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }) };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers Cloud, Gemini and Qwen for each site, Gemini on YouTube and Qwen on Bilibili by default, with a hint', async () => {
    await openPage('options');
    const youtube = $('#youtubeProvider');
    const bilibili = $('#bilibiliProvider');
    await vi.waitFor(() => expect(youtube.value).toBe('gemini'));
    expect(bilibili.value).toBe('qwen');
    expect(youtube.labels[0].querySelector('span').textContent).toBe('YouTube videos');
    expect(bilibili.labels[0].querySelector('span').textContent).toBe('Bilibili videos (experimental)');
    expect([...bilibili.options].map((o) => o.textContent)).toEqual(['SceneVoice Cloud', 'Gemini (Google)', 'Qwen (Alibaba Cloud Model Studio)']);
    expect(bilibili.getAttribute('aria-describedby')).toBe('providerHint');
    expect($('#providerHint').textContent).toMatch(/descriptions come a few seconds after the picture/);
    expect([...document.querySelectorAll('#main h2, #main h3')].slice(0, 5).map((h) => `${h.tagName} ${h.textContent}`)).toEqual([
      'H2 1. Connect an AI model',
      'H3 SceneVoice Cloud',
      'H3 Which model describes each site',
      'H3 Gemini (Google)',
      'H3 Qwen (Alibaba Cloud Model Studio)',
    ]);
    selectValue(youtube, 'qwen');
    await vi.waitFor(() => expect(stored().youtubeProvider).toBe('qwen'));
    // A preference, synced; never a key.
    expect(JSON.stringify(fake.areas.sync)).not.toMatch(/key/i);
    expect(unnamedControls()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('saves the Qwen key on this computer only, tests it, and says how it went', async () => {
    const fetchMock = vi.fn(async () => okChat);
    vi.stubGlobal('fetch', fetchMock);
    await openPage('options');
    expect($('#qwenApiKey').type).toBe('password');
    expect($('#qwenApiKey').getAttribute('aria-describedby')).toBe('qwenKeyHint qwenKeyStatus qwenKeyPrivacy');
    expect($('#qwenKeyStatus').getAttribute('role')).toBe('status');
    expect($('#qwenModel').value).toBe('qwen3-vl-plus');
    $('#qwenApiKey').value = '  sk-qwen-test  ';
    $('#saveQwenKey').click();
    await vi.waitFor(() => expect($('#qwenKeyStatus').textContent).toBe('Connected. Using qwen3-vl-plus. Next: open any Bilibili video and press Alt+Shift+D to hear descriptions.'));
    expect(fake.areas.local.local).toMatchObject({ qwenApiKey: 'sk-qwen-test', qwenModel: 'qwen3-vl-plus' });
    expect(fake.areas.sync.settings?.qwenApiKey).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-qwen-test');
  });

  it('gives a site back its usual model when the second key arrives, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okChat));
    // Gemini was the only key, so it was describing Bilibili too (adoptProviderIfOnlyKey).
    await openPage('options', { local: { local: { apiKey: 'AIza-first' } }, sync: { settings: { youtubeProvider: 'gemini', bilibiliProvider: 'gemini' } } });
    $('#qwenApiKey').value = 'sk-qwen-second';
    $('#saveQwenKey').click();
    await vi.waitFor(() => expect($('#qwenKeyStatus').textContent).toBe('Connected. Using qwen3-vl-plus. Each site now uses its usual model: Gemini on YouTube, Qwen on Bilibili. Change this under “Which model describes each site”. Next: open any Bilibili video and press Alt+Shift+D to hear descriptions.'));
    expect(stored()).toMatchObject({ youtubeProvider: 'gemini', bilibiliProvider: 'qwen' });
    // Nothing to say when both sites already had their usual model.
    $('#qwenApiKey').value = 'sk-qwen-third';
    $('#saveQwenKey').click();
    await vi.waitFor(() => expect($('#qwenKeyStatus').textContent).toBe('Connected. Using qwen3-vl-plus. Next: open any Bilibili video and press Alt+Shift+D to hear descriptions.'));
  });

  it('says in Chinese when Qwen refuses the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } }) })));
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect($('#h-qwen').textContent).toBe('通义千问（阿里云百炼）');
    expect($('#qwenApiKey').labels[0].textContent).toBe('通义千问 API Key');
    $('#qwenApiKey').value = 'wrong';
    $('#saveQwenKey').click();
    await vi.waitFor(() => expect($('#qwenKeyStatus').textContent).toBe('通义千问 API Key 无效，请在 SceneVoice 设置页检查。'));
    expect($('#qwenKeyStatus').className).toBe('status-bad');
  });

  it('removes the Qwen key, and saves another model name', async () => {
    await openPage('options', { local: { local: { qwenApiKey: 'sk-old' } } });
    expect($('#qwenKeyStatus').textContent).toMatch(/A key is saved/);
    $('#qwenModel').value = ' qwen-vl-plus ';
    $('#qwenModel').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(fake.areas.local.local.qwenModel).toBe('qwen-vl-plus'));
    $('#removeQwenKey').click();
    await vi.waitFor(() => expect(fake.areas.local.local.qwenApiKey).toBe(''));
    expect($('#qwenKeyStatus').textContent).toBe('Key removed.');
  });
});

describe('shortcuts in the popup', () => {
  it('lists every shortcut with its key or "not set", and opens Chrome\u2019s shortcut page to change them', async () => {
    await openPage('popup');
    const items = [...document.querySelectorAll('#keyList li')].map((li) => li.textContent);
    expect(items).toEqual([
      'Create descriptions, or turn them on and off: Alt+Shift+D',
      'Change the level of detail: Not set',
      'Speak faster: Not set',
    ]);
    const create = vi.spyOn(fake.chrome.tabs, 'create');
    $('#editShortcuts').click();
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
    expect($('#allKeys summary').textContent).toBe('All keyboard shortcuts');
  });
});

describe('first use: getting a key', () => {
  it('starts at the Gemini key in English, with a sentence saying what to paste and where to get it', async () => {
    await openPage('options');
    expect(document.activeElement.id).toBe('apiKey');
    expect($('#apiKey').getAttribute('aria-describedby').split(' ')[0]).toBe('keyHint');
    expect($('#keyHint').textContent).toMatch(/^Paste your Gemini API key here\. Get one free/);
    const links = [...document.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toContainEqual(['Get a Gemini key at Google AI Studio (opens in a new tab)', 'https://aistudio.google.com/apikey']);
    expect(links).toContainEqual(['Step-by-step guide, written for screen readers', 'guide.html#gemini']);
    expect(links).toContainEqual(['Step-by-step guide, written for screen readers', 'guide.html#qwen']);
  });

  it('starts at the Qwen key in Chinese, since Gemini needs Google', async () => {
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect(document.activeElement.id).toBe('qwenApiKey');
    expect($('#qwenKeyHint').textContent).toMatch(/^在这里粘贴通义千问 API Key/);
  });

  it('stays where it is once a key is saved', async () => {
    await openPage('options', { local: { local: { apiKey: 'k' } } });
    expect(document.activeElement.id).not.toBe('apiKey');
  });

  it('the guide reads the part asked for first, with numbered steps for each key', async () => {
    window.location.hash = '#qwen';
    await openPage('guide', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect(document.activeElement.id).toBe('qwen');
    expect(document.activeElement.textContent).toBe('通义千问 Key（用于 B 站，以及在中国大陆使用）');
    expect(document.querySelectorAll('#gemini ~ ol li').length).toBe(7);
    expect(document.querySelectorAll('section[aria-labelledby=qwen] ol li').length).toBe(7);
    expect(document.title).toBe('如何申请 API Key');
    window.location.hash = '';
  });
});

describe('popup on a Bilibili video', () => {
  const tab = (state) => (msg) => (msg.type === MSG.TAB_STATE ? { supported: true, videoId: 'bili:BV1GJ411x7h7', title: '宫保鸡丁的做法', lang: 'zh-CN', videoType: '', platform: 'bilibili', provider: 'qwen', inputMode: 'frames', cueCount: 0, ...state } : null);

  it('asks for the Qwen key when it is missing, and not for Gemini’s', async () => {
    const onlyGemini = { status: { keys: { gemini: true, qwen: false } } };
    await openPage('popup', { ...onlyGemini, tabReply: tab({ status: 'none' }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('No descriptions yet.'));
    expect($('#keyBanner').hidden).toBe(false);
    expect($('#setupBody').textContent).toBe('Add your Qwen API key (Alibaba Cloud Model Studio) to create descriptions on this site.');
    expect(unnamedControls()).toEqual([]);
    expect(await axeViolations()).toEqual([]);

    // The same keys on a YouTube video, which uses Gemini: nothing to ask.
    await openPage('popup', { ...onlyGemini, tabReply: tab({ status: 'none', platform: 'youtube', provider: 'gemini', videoId: 'abcdefghijk' }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('No descriptions yet.'));
    expect($('#keyBanner').hidden).toBe(true);
  });

  it('says it is describing as you watch, offers Stop, and stops on request', async () => {
    const asked = [];
    await openPage('popup', { tabReply: (msg) => (asked.push(msg), tab({ status: 'live', cueCount: 3, percent: 20 })(msg)) });
    // The live region says the state once; the changing numbers stay out of it.
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('Describing as you watch. Descriptions come a few seconds after the picture; progress is shown below.'));
    expect($('#stop').hidden).toBe(false);
    expect($('#generate').hidden).toBe(true);
    // The same box as on the player: how much of the video is described, and how far the part being watched is.
    expect($('#progressBox').hidden).toBe(false);
    expect($('#progress').value).toBe(20);
    expect($('#progressText').textContent).toBe('Describing as you watch · 20% · First descriptions on the way');
    $('#stop').click();
    await vi.waitFor(() => expect(asked).toContainEqual({ type: MSG.TAB_ACTION, action: 'stop' }));
  });

  it('shows the same progress as the box on the player while creating descriptions', async () => {
    await openPage('popup', { tabReply: tab({ status: 'generating', done: 1, total: 3, percent: 45, eta: 130 }) });
    await vi.waitFor(() => expect($('#progressBox').hidden).toBe(false));
    expect($('#progress').value).toBe(45);
    expect($('#progressText').textContent).toBe('Creating descriptions: section 2 of 3 · 45% · About 3 minutes left');
    // At the very start it says 0%, as the page does; only the bar shows a sliver.
    await openPage('popup', { tabReply: tab({ status: 'generating', done: 0, total: 1, percent: 0, eta: null }) });
    await vi.waitFor(() => expect($('#progressText').textContent).toBe('Creating descriptions… · 0%'));
    expect($('#progress').value).toBe(2);
  });

  it('says how far the part being watched is described', async () => {
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN', tabReply: tab({ status: 'live', cueCount: 4, percent: 30, describedUpTo: 95 }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('正在边看边生成口述。口述会比画面晚几秒，进度见下方。'));
    expect($('#progressText').textContent).toContain('1:35');
  });

  it('keeps the live region quiet while the numbers change, and keeps focus on a button after Create and Stop', async () => {
    let state = { status: 'none' };
    const asked = [];
    await openPage('popup', {
      status: { keys: { gemini: true, qwen: true } },
      tabReply: (msg) => {
        asked.push(msg);
        if (msg.type === MSG.TAB_ACTION) state = msg.action === 'stop' ? { status: 'ready', cueCount: 3 } : { status: 'generating', done: 0, total: 3, percent: 1, eta: 200 };
        // The tab answers an action with its new state, as the content script does.
        return tab({ platform: 'youtube', provider: 'gemini', videoId: 'abcdefghijk', ...state })({ type: MSG.TAB_STATE });
      },
    });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('No descriptions yet.'));
    $('#generate').focus();
    $('#generate').click();
    await vi.waitFor(() => expect($('#stop').hidden).toBe(false));
    expect(document.activeElement.id).toBe('stop');
    const said = $('#videoStatus').textContent;
    expect(said).toBe('Creating descriptions. Progress is shown below.');
    // Progress moves on: the bar and its text change, the live region does not.
    state = { status: 'generating', done: 1, total: 3, percent: 40, eta: 100 };
    await vi.waitFor(() => expect($('#progress').value).toBe(40));
    expect($('#videoStatus').textContent).toBe(said);
    $('#stop').click();
    await vi.waitFor(() => expect($('#stop').hidden).toBe(true));
    expect(document.activeElement.id).toBe('generate');
  });

  it('explains an error in Qwen’s words', async () => {
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN', tabReply: tab({ status: 'error', errorCode: 'frames-tainted' }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toMatch(/^SceneVoice 截不到这个视频的画面/));
  });
});

describe('popup: what a video cost, and the daily limit', () => {
  const tab = (state) => (msg) => (msg.type === MSG.TAB_STATE ? { supported: true, videoId: 'abcdefghijk', title: 'Dogs', lang: 'en', videoType: '', platform: 'youtube', provider: 'gemini', inputMode: 'video', cueCount: 12, firstCue: 5, completedUntil: 600, complete: true, ...state } : null);

  it('says what the video cost with the status, once, in dollars or yuan', async () => {
    await openPage('popup', { tabReply: tab({ status: 'ready', cost: { amount: 0.03325, currency: 'USD' } }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('12 descriptions ready, the first at 0:05. This video: about $0.03.'));
    await openPage('popup', { locale: 'zh_CN', uiLanguage: 'zh-CN', tabReply: tab({ status: 'partial', complete: false, cost: { amount: 0.17, currency: 'CNY' }, platform: 'bilibili', provider: 'qwen', videoId: 'bili:BV1GJ411x7h7' }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('前 10 分钟的口述已就绪。这个视频约 0.2 元。'));
    // A model with no price, or an old script: nothing about money.
    await openPage('popup', { tabReply: tab({ status: 'ready', cost: null }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('12 descriptions ready, the first at 0:05.'));
  });

  it('names the limit set when the day’s limit is reached', async () => {
    await openPage('popup', { sync: { settings: { dailyBudgetSeconds: 7200 } }, tabReply: tab({ status: 'error', errorCode: 'budget', cueCount: 0 }) });
    await vi.waitFor(() => expect($('#videoStatus').textContent).toBe('Today’s limit of 2 hours is reached. Change it in settings, or carry on tomorrow.'));
  });
});

describe('settings page: usage today and the daily limit', () => {
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('says when nothing has been described yet, and offers the daily limit with none set', async () => {
    await openPage('options');
    expect($('#usageList').textContent).toBe('Nothing described yet today.');
    expect($('#usageNote').textContent).toMatch(/this computer only.*free-tier Gemini key is not charged/);
    const select = $('#dailyBudget');
    expect(select.value).toBe('0');
    expect([...select.options].map((o) => o.textContent)).toEqual(['No limit', '30 minutes', '1 hour', '2 hours', '4 hours']);
    expect(select.getAttribute('aria-describedby')).toBe('dailyBudgetHint');
    expect(unnamedControls()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('lists today’s requests, tokens, minutes and estimate per model, and follows the counter as it moves', async () => {
    const usage = {
      day: today(),
      gemini: { input: 92450, output: 2550, requests: 2, seconds: 325, cost: 0.03325 },
      qwen: { input: 3300, output: 240, requests: 1, seconds: 12, cost: 0.0057 },
      cloud: { input: 0, output: 0, requests: 0, seconds: 0, cost: 0 },
    };
    await openPage('options', { local: { usage } });
    const rows = () => [...document.querySelectorAll('#usageList li')].map((li) => li.textContent);
    expect(rows()).toEqual(['Gemini (Google): 2 requests, 95k tokens, about 5 minutes of video, about $0.03.', 'Qwen (Alibaba Cloud Model Studio): 1 requests, 4k tokens, about 1 minutes of video, about ¥0.1.']);
    // Another tab describes on: the page keeps up.
    await chrome.storage.local.set({ usage: { ...usage, cloud: { input: 500, output: 50, requests: 1, seconds: 5, cost: 0 } } });
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[2]).toBe('SceneVoice Cloud: 1 requests, 550 tokens, about 1 minutes of video.');
    // Yesterday's counter is not today's.
    await openPage('options', { local: { usage: { ...usage, day: '2020-01-01' } } });
    expect($('#usageList').textContent).toBe('Nothing described yet today.');
  });

  it('shows the usage in Chinese, in yuan', async () => {
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN', local: { usage: { day: today(), qwen: { input: 3300, output: 240, requests: 1, seconds: 12, cost: 0.17 } } } });
    expect($('#usageList').textContent).toBe('通义千问（阿里云百炼）：1 次请求，4k 个 token，约 1 分钟视频，约 0.2 元。');
    expect($('#h-usage').textContent).toBe('今日用量');
  });

  it('saves the daily limit', async () => {
    await openPage('options');
    selectValue($('#dailyBudget'), '3600');
    await vi.waitFor(() => expect(stored().dailyBudgetSeconds).toBe(3600));
  });
});

// ---------- SceneVoice Cloud: the welcome page, the popup banner and the settings block ----------

const TOKEN = `svd_${'0123456789abcdef'.repeat(2)}`;
const DEVICE = { token: TOKEN, plan: 'free', allowance: { secondsPerDay: 3600, usedToday: 0, resetsAt: '2026-11-05T00:00:00Z' } };

/** A fetch for the relay: one answer per path (the part after the origin, without the query), remembering every call. */
function relay(routes) {
  return vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname;
    const route = routes[path] || routes[`${init.method || 'GET'} ${path}`];
    if (!route) throw new TypeError(`Failed to fetch ${path}`);
    const [status, body] = typeof route === 'function' ? route(init) : route;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  });
}

/** A choice on the welcome page: its listeners are on the controls themselves, so the event need not bubble. */
function pick(el) {
  el.checked = true;
  el.dispatchEvent(new Event('change'));
}

/** Let the promise chain after a click run (a few awaits over the fake storage), under fake timers. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('welcome page (first run)', () => {
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it('starts on the heading, has three steps with every control named, and passes axe in both languages', async () => {
    await openPage('welcome');
    expect(document.activeElement.id).toBe('title');
    expect(document.activeElement.textContent).toBe('Welcome to SceneVoice');
    expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['1. Hear what SceneVoice does', '2. Choose how descriptions are made', '3. Try it']);
    // Nothing but the title and one sentence above step 1.
    expect($('main').children[1].tagName).toBe('P');
    expect($('main').children[2].getAttribute('aria-labelledby')).toBe('step1');
    expect(unnamedControls()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
    // "My own key" is the default until the Cloud relay is deployed: a listener who follows
    // the preselected path must not be sent to a service that does not answer.
    expect($('input[name=source][value=own]').checked).toBe(true);
    expect($('input[name=source][value=cloud]').checked).toBe(false);
    expect($('#cloudBox').hidden).toBe(true);
    expect($('#ownBox').hidden).toBe(false);
    expect($('span[data-i18n=welcome_source_cloud]').textContent).not.toMatch(/recommended/i);
    expect($('#ownKey').getAttribute('href')).toBe('options.html#gemini');
    expect($('#tryBilibiliItem').hidden).toBe(true);
    expect($('#tryYoutube').getAttribute('target')).toBe('_blank');
    expect($('#tryYoutube').textContent).toMatch(/opens in a new tab/);
    expect($('#shortcutText').textContent).toBe('Your shortcut to create descriptions, and to turn them on or off, is Alt+Shift+D.');
    expect($('#skip').textContent).toBe('Skip, open all settings');
    expect($('#skip').getAttribute('href')).toBe('options.html');

    await openPage('welcome', { locale: 'zh_CN', uiLanguage: 'zh-CN', commands: [] });
    expect(document.title).toBe('欢迎使用 SceneVoice');
    expect(document.activeElement.id).toBe('title');
    expect($('#ownKey').getAttribute('href')).toBe('options.html#qwen');
    expect($('#tryBilibiliItem').hidden).toBe(false);
    expect($('#shortcutText').textContent).toMatch(/^还没有为生成口述设置快捷键/);
    expect($('#startFree').textContent).toBe('免费开始');
    expect(unnamedControls()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('plays three sample descriptions in the live region, one at a time, with the sentence about pauses, and sends nothing', async () => {
    await openPage('welcome');
    const out = $('#sampleOut');
    expect(out.getAttribute('role')).toBe('status');
    vi.useFakeTimers();
    $('#sample').click();
    await flush();
    expect(out.getAttribute('aria-live')).toBe('polite');
    expect(out.textContent).toBe('Title: How to repot a plant.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('The video keeps playing; descriptions fit the pauses.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('A woman with grey hair and a green apron lifts a fern out of its pot.');
    // The 15-word line needs about 4.3 s at the default screen reader speed (1.6): not replaced at 4 s.
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('A woman with grey hair and a green apron lifts a fern out of its pot.');
    await vi.advanceTimersByTimeAsync(400);
    expect(out.textContent).toBe('She shakes the soil from the roots over a newspaper.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('That was the sample. Next: choose how descriptions are made.');
    expect(fake.sent.some((m) => m.type === MSG.SPEAK)).toBe(false);
    expect(realFetch === undefined || !vi.isMockFunction(realFetch) || realFetch.mock.calls.length === 0).toBe(true);
  });

  it('leaves each sample sentence in the live region for as long as the chosen screen reader speed needs', async () => {
    // "Default speed" (1): the 15-word line takes about 6.5 s, the short ones keep the 4 s floor.
    await openPage('welcome', { sync: { settings: { readerSpeed: 1 } } });
    const out = $('#sampleOut');
    vi.useFakeTimers();
    $('#sample').click();
    await flush();
    expect(out.textContent).toBe('Title: How to repot a plant.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('The video keeps playing; descriptions fit the pauses.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('A woman with grey hair and a green apron lifts a fern out of its pot.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('A woman with grey hair and a green apron lifts a fern out of its pot.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(out.textContent).toBe('She shakes the soil from the roots over a newspaper.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.textContent).toBe('She shakes the soil from the roots over a newspaper.');
    await vi.advanceTimersByTimeAsync(400);
    expect(out.textContent).toBe('That was the sample. Next: choose how descriptions are made.');
  });

  it('speaks the sample with the built-in voice when that is chosen, in Chinese for a Chinese interface, and keeps the live region quiet', async () => {
    await openPage('welcome', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    pick($('input[name=output][value=tts]'));
    await vi.waitFor(() => expect(stored().output).toBe('tts'));
    $('#sample').click();
    await vi.waitFor(() => expect(fake.sent.some((m) => m.type === MSG.SPEAK)).toBe(true));
    const msg = fake.sent.find((m) => m.type === MSG.SPEAK);
    expect(msg.lang).toBe('zh-CN');
    expect(msg.text).toBe('标题：怎样给植物换盆。 视频继续播放，口述只在对白空隙里说。 一位灰白头发、系绿色围裙的女人把一盆蕨类从花盆里提出来。 她在报纸上方抖掉根上的土。 示例结束。下一步：选择口述由谁生成。');
    expect($('#sampleOut').getAttribute('aria-live')).toBe('off');
  });

  it('silences a built-in-voice sample before the screen reader takes over, when the output changes, and when the page is left', async () => {
    await openPage('welcome');
    pick($('input[name=output][value=tts]'));
    await vi.waitFor(() => expect(stored().output).toBe('tts'));
    const types = () => fake.sent.map((m) => m.type);
    // Leaving the page or changing the output with no voice of ours speaking sends no stop: chrome.tts.stop() is
    // global, and a description being read for a video in another tab must not be cut off.
    window.dispatchEvent(new Event('pagehide'));
    expect(types()).not.toContain(MSG.STOP_SPEAKING);
    $('#sample').click();
    await vi.waitFor(() => expect(types()).toContain(MSG.SPEAK));
    expect($('#sample').textContent).toBe('Stop the sample');
    // Switching to the screen reader and asking again: the voice is stopped before the live region gets its first sentence.
    pick($('input[name=output][value=screenreader]'));
    expect(types().filter((t) => t === MSG.STOP_SPEAKING)).toHaveLength(1);
    expect(types().indexOf(MSG.STOP_SPEAKING)).toBeGreaterThan(types().indexOf(MSG.SPEAK));
    expect($('#sample').textContent).toBe('Hear a sample');
    await vi.waitFor(() => expect(stored().output).toBe('screenreader'));
    $('#sample').click();
    await vi.waitFor(() => expect($('#sampleOut').textContent).toBe('Title: How to repot a plant.'));
    expect($('#sampleOut').getAttribute('aria-live')).toBe('polite');
    expect(types().filter((t) => t === MSG.SPEAK)).toHaveLength(1);
    // Back to the voice: the button becomes a stop control while it speaks, and the page's unload stops it too.
    pick($('input[name=output][value=tts]'));
    await vi.waitFor(() => expect(stored().output).toBe('tts'));
    $('#sample').click();
    await vi.waitFor(() => expect(types().filter((t) => t === MSG.SPEAK)).toHaveLength(2));
    const second = fake.sent.filter((m) => m.type === MSG.SPEAK)[1];
    expect(second.id).not.toBe(fake.sent.find((m) => m.type === MSG.SPEAK).id);
    expect($('#sample').textContent).toBe('Stop the sample');
    $('#sample').click();
    expect(types().filter((t) => t === MSG.STOP_SPEAKING)).toHaveLength(2);
    expect($('#sample').textContent).toBe('Hear a sample');
    $('#sample').click();
    await vi.waitFor(() => expect(types().filter((t) => t === MSG.SPEAK)).toHaveLength(3));
    window.dispatchEvent(new Event('pagehide'));
    expect(types().filter((t) => t === MSG.STOP_SPEAKING)).toHaveLength(3);
    expect(await axeViolations()).toEqual([]);
  });

  it('says so, through the live region, when the built-in voice could not speak, and makes the region live again when it has finished', async () => {
    await openPage('welcome', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    pick($('input[name=output][value=tts]'));
    await vi.waitFor(() => expect(stored().output).toBe('tts'));
    const out = $('#sampleOut');
    $('#sample').click();
    await vi.waitFor(() => expect(fake.sent.some((m) => m.type === MSG.SPEAK)).toBe(true));
    const { id } = fake.sent.find((m) => m.type === MSG.SPEAK);
    expect(out.getAttribute('aria-live')).toBe('off');
    // Events of another utterance (the options page's voice test, a description in a video tab) are not this sample's.
    fake.deliver({ type: MSG.TTS_EVENT, id: 'test', event: 'error' });
    expect(out.getAttribute('aria-live')).toBe('off');
    expect($('#sample').textContent).toBe('停止示例');
    // Nor is a message from a web page or another extension, whatever it says.
    fake.deliver({ type: MSG.TTS_EVENT, id, event: 'error' }, { id: 'other-extension', origin: 'https://evil.example', url: 'https://evil.example/' });
    expect(out.getAttribute('aria-live')).toBe('off');
    fake.deliver({ type: MSG.TTS_EVENT, id, event: 'error' });
    expect(out.getAttribute('aria-live')).toBe('polite');
    expect($('#sample').textContent).toBe('听一段示例');
    // The failure is written after the region is live again, so a screen reader does not miss it.
    await vi.waitFor(() => expect(out.textContent).toBe('这台电脑上的内置语音无法朗读。请在上面选择“我的读屏软件”，再按一次“听一段示例”。'));
    expect(fake.sent.some((m) => m.type === MSG.STOP_SPEAKING)).toBe(false);

    // A sample that ends well: the region is live again and keeps the sample text.
    $('#sample').click();
    await vi.waitFor(() => expect(fake.sent.filter((m) => m.type === MSG.SPEAK)).toHaveLength(2));
    expect(out.getAttribute('aria-live')).toBe('off');
    fake.deliver({ type: MSG.TTS_EVENT, id: fake.sent.filter((m) => m.type === MSG.SPEAK)[1].id, event: 'end' });
    expect(out.getAttribute('aria-live')).toBe('polite');
    expect(out.textContent).toMatch(/^标题：怎样给植物换盆。/);
    expect($('#sample').textContent).toBe('听一段示例');
    // The privacy note is the Chinese policy, at its SceneVoice Cloud section.
    expect($('#privacyLink').getAttribute('href')).toBe('https://github.com/reddynb666/scenevoice/blob/main/PRIVACY.zh-CN.md#scenevoice-cloud可选');
  });

  it('Start free gets a device token, keeps it with the keys, has Cloud describe both sites with sharing on, and says the allowance', async () => {
    await openPage('welcome');
    globalThis.fetch = relay({ 'POST /v1/devices': [201, DEVICE] });
    $('#startFree').click();
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toBe('SceneVoice Cloud is ready. You have 60 minutes of newly described video a day. Videos already described by others do not count. Next: step 3, try it.'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.scenevoice.app/v1/devices');
    expect(JSON.parse(init.body)).toEqual({ client: 'extension', version: '1.0.0', locale: 'en' });
    expect(fake.areas.local.local).toMatchObject({ cloudToken: TOKEN, cloudPlan: 'free' });
    expect(stored()).toMatchObject({ youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true });
    expect(JSON.stringify(fake.areas.sync)).not.toContain(TOKEN);
    expect($('#startFree').hidden).toBe(true);
    expect(document.activeElement.id).toBe('step3');
    expect($('#privacyLink').getAttribute('href')).toMatch(/PRIVACY\.md#scenevoice-cloud-optional$/);
    expect($('#startFree').getAttribute('aria-describedby')).toBe('shareNote');
    expect($('#shareNote').textContent).toMatch(/turns on sharing/);
  });

  it('says plainly when the relay cannot be reached or answers nonsense, keeps nothing, and points at the own-key path', async () => {
    await openPage('welcome');
    globalThis.fetch = relay({});
    $('#startFree').click();
    // One remedy, named once, pointing at the radio right above the button: not the generation-time
    // sentence about "settings" and the user's connection, followed by the same advice again.
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toBe('SceneVoice Cloud could not be reached. You can use your own key instead: choose “My own key” above.'));
    expect(fake.areas.local.local?.cloudToken).toBeFalsy();
    expect(stored()).toEqual({});
    expect($('#startFree').disabled).toBe(false);

    // The relay's per-minute 429: nothing about descriptions "saved so far", there are none yet.
    globalThis.fetch = relay({ 'POST /v1/devices': [429, { error: { code: 429, message: 'Too many requests', status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'SCENEVOICE_RATE_LIMIT' }] } }] });
    $('#startFree').click();
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toBe('SceneVoice Cloud is busy right now. Try Start free again in a minute. You can use your own key instead: choose “My own key” above.'));
    expect(fake.areas.local.local?.cloudToken).toBeFalsy();

    globalThis.fetch = relay({ 'POST /v1/devices': [200, { token: '<script>alert(1)</script>', plan: 'free' }] });
    $('#startFree').click();
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toMatch(/^The request to SceneVoice Cloud failed\. Try again\./));
    expect(fake.areas.local.local?.cloudToken).toBeFalsy();

    pick($('input[name=source][value=own]'));
    expect($('#ownBox').hidden).toBe(false);
    expect($('#cloudBox').hidden).toBe(true);
    expect($('#ownKey').textContent).toBe('Add my key in settings');
  });

  it('says when this network has started as many new devices as it may today, and when that opens again, not "wait a minute"', async () => {
    await openPage('welcome');
    const resetsAt = '2026-11-05T00:00:00Z';
    const limit = (fields) => [429, { error: { code: 429, message: 'Too many new SceneVoice devices from this network today. Try again tomorrow.', status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'SCENEVOICE_DEVICE_LIMIT', ...fields }] } }];
    globalThis.fetch = relay({ 'POST /v1/devices': limit({ resetsAt }) });
    $('#startFree').click();
    const at = new Date(resetsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toBe(`Too many computers on this network have started SceneVoice Cloud today. Try again after ${at}. You can use your own key instead: choose “My own key” above.`));
    expect(fake.areas.local.local?.cloudToken).toBeFalsy();
    expect($('#startFree').disabled).toBe(false);
    // Without a time from the relay: midnight UTC. Nothing about saved descriptions, there are none.
    globalThis.fetch = relay({ 'POST /v1/devices': limit({}) });
    $('#startFree').click();
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toMatch(/^Too many computers on this network have started SceneVoice Cloud today\. Try again after midnight UTC\. You can use your own key/));
    expect($('#cloudStatus').textContent).not.toMatch(/saved/);
  });

  it('says Cloud is already set up when a token exists', async () => {
    await openPage('welcome', { locale: 'zh_CN', uiLanguage: 'zh-CN', local: { local: { cloudToken: TOKEN } } });
    expect($('#startFree').hidden).toBe(true);
    expect($('#cloudStatus').textContent).toBe('这台电脑已经设置好 SceneVoice 云端了。');
  });
});

describe('popup with nothing set up', () => {
  it('sends the listener to the welcome page, and asks for nothing once a Cloud token exists', async () => {
    await openPage('popup', { status: { hasKey: false, keys: { gemini: false, qwen: false, cloud: false } } });
    await vi.waitFor(() => expect($('#keyBanner').hidden).toBe(false));
    expect($('#setupKey').textContent).toBe('Set up SceneVoice');
    expect($('#setupBody').textContent).toBe('SceneVoice can describe videos for free, with nothing to set up. The welcome page shows how, in three steps.');
    const create = vi.spyOn(fake.chrome.tabs, 'create');
    const openOptions = vi.spyOn(fake.chrome.runtime, 'openOptionsPage');
    $('#setupKey').click();
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/welcome.html' });
    expect(openOptions).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);

    await openPage('popup', { status: { hasKey: false, keys: { gemini: false, qwen: false, cloud: true } } });
    expect($('#keyBanner').hidden).toBe(true);

    // A key of their own missing for this site, while another exists: the settings page, as before.
    await openPage('popup', { status: { hasKey: true, keys: { gemini: true, qwen: false, cloud: false } }, tabReply: (msg) => (msg.type === MSG.TAB_STATE ? { supported: true, videoId: 'bili:BV1GJ411x7h7', title: 'T', lang: 'zh-CN', videoType: '', platform: 'bilibili', provider: 'qwen', inputMode: 'frames', cueCount: 0, status: 'none' } : null) });
    await vi.waitFor(() => expect($('#keyBanner').hidden).toBe(false));
    expect($('#setupKey').textContent).toBe('Add API key');
  });
});

describe('settings page: SceneVoice Cloud', () => {
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const me = (plan, used, perDay) => [200, { plan, allowance: { secondsPerDay: perDay, usedToday: used, resetsAt: '2026-11-05T00:00:00Z' }, cacheHits: 1 }];

  it('offers Start free at the top of section 1 when there is no token, with the switch and the licence field named', async () => {
    await openPage('options');
    expect($('#h-key + h3').id).toBe('h-cloud');
    expect($('#h-cloud').textContent).toBe('SceneVoice Cloud');
    expect($('#cloudInfo').textContent).toBe('Not set up on this computer. Press Start free to get a device token and the free daily allowance. No account is needed.');
    expect($('#cloudStart').hidden).toBe(false);
    expect($('#cloudStop').hidden).toBe(true);
    expect($('#shareDescriptions').checked).toBe(false);
    expect($('#shareDescriptions').labels[0].textContent.trim()).toBe('Share finished descriptions with other SceneVoice users');
    expect($('#licenseKey').labels[0].textContent.trim()).toBe('Licence key');
    expect([...$('#youtubeProvider').options].map((o) => o.value)).toEqual(['cloud', 'gemini', 'qwen']);
    expect(unnamedControls()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('Start free registers, turns sharing on, has Cloud describe both sites when there is no key, and moves focus to Stop', async () => {
    await openPage('options');
    globalThis.fetch = relay({ 'POST /v1/devices': [201, DEVICE], '/v1/me': me('free', 0, 3600) });
    $('#cloudStart').click();
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toBe('SceneVoice Cloud is ready. You have 60 minutes of newly described video a day; videos already described by others do not count.'));
    expect(fake.areas.local.local).toMatchObject({ cloudToken: TOKEN, cloudPlan: 'free' });
    await vi.waitFor(() => expect(stored()).toMatchObject({ youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true }));
    await vi.waitFor(() => expect($('#shareDescriptions').checked).toBe(true));
    expect($('#cloudInfo').textContent).toMatch(/^Plan: Free\. Used today: 0 of 60 minutes\. The allowance resets at /);
    expect($('#cloudStart').hidden).toBe(true);
    expect(document.activeElement.id).toBe('cloudStop');
    // Registering is one request; the plan just received is not asked for again.
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/v1/devices']);
  });

  it('says when the network’s daily limit on new devices is reached, in Chinese too, and keeps no token', async () => {
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    globalThis.fetch = relay({ 'POST /v1/devices': [429, { error: { message: 'limit', details: [{ reason: 'SCENEVOICE_DEVICE_LIMIT' }] } }] });
    $('#cloudStart').click();
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toBe('今天这个网络里开始使用 SceneVoice 云端的电脑太多了。请在 世界标准时间零点 之后再试。 也可以改用自己的密钥：下方的 Gemini 或通义千问。'));
    expect(fake.areas.local.local?.cloudToken).toBeFalsy();
    expect($('#cloudStart').hidden).toBe(false);
  });

  it('reads the plan and today’s use with a token, once a minute, and activates a licence', async () => {
    globalThis.fetch = relay({
      '/v1/me': me('free', 600, 3600),
      'POST /v1/licenses/activate': (init) => (JSON.parse(init.body).licenseKey === 'svl-ABCD-EFGH-IJKL' ? [200, { plan: 'plus', allowance: { secondsPerDay: 14400, usedToday: 600 } }] : [404, { error: { message: 'no such licence' } }]),
    });
    await openPage('options', { local: { local: { cloudToken: TOKEN, cloudPlan: 'free' } } });
    await vi.waitFor(() => expect($('#cloudInfo').textContent).toMatch(/^Plan: Free\. Used today: 10 of 60 minutes\./));
    expect($('#cloudStart').hidden).toBe(true);
    expect($('#cloudStop').hidden).toBe(false);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.scenevoice.app/v1/me');
    expect(init.headers['x-goog-api-key']).toBe(TOKEN);
    // Not sent back to the key fields, not shown in them.
    expect($('#apiKey').value).toBe('');
    expect($('#qwenApiKey').value).toBe('');

    $('#activateLicense').click();
    await vi.waitFor(() => expect($('#licenseStatus').textContent).toBe('Enter the licence key first.'));
    expect(document.activeElement.id).toBe('licenseKey');
    $('#licenseKey').value = 'abc';
    $('#activateLicense').click();
    await vi.waitFor(() => expect($('#licenseStatus').textContent).toMatch(/^A licence key looks like svl-XXXX-XXXX-XXXX/));
    $('#licenseKey').value = 'svl-ZZZZ-ZZZZ-ZZZZ';
    $('#activateLicense').click();
    await vi.waitFor(() => expect($('#licenseStatus').textContent).toBe('That licence key was not found. Check it, or ask whoever gave it to you.'));
    $('#licenseKey').value = 'svl-ABCD-EFGH-IJKL';
    $('#activateLicense').click();
    await vi.waitFor(() => expect($('#licenseStatus').textContent).toBe('Licence activated. Plan: Plus, 240 minutes of newly described video a day.'));
    expect(fake.areas.local.local.cloudPlan).toBe('plus');
    expect($('#cloudInfo').textContent).toMatch(/^Plan: Plus\. Used today: 10 of 240 minutes\./);
    expect($('#licenseKey').value).toBe('');
    // The plan was read from the relay once; the licence answer stood in for the second read.
    expect(fetch.mock.calls.filter(([u]) => u.endsWith('/v1/me'))).toHaveLength(1);
  });

  it('says so when the relay cannot be reached, keeping the token and the plan it last saw', async () => {
    globalThis.fetch = relay({});
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN', local: { local: { cloudToken: TOKEN, cloudPlan: 'plus' } } });
    await vi.waitFor(() => expect($('#cloudInfo').textContent).toBe('套餐：Plus 版。现在连不上 SceneVoice 云端，暂时不知道今天的用量。'));
    expect(fake.areas.local.local.cloudToken).toBe(TOKEN);
    expect($('#h-cloud').textContent).toBe('SceneVoice 云端');
    expect($('#cloudStop').textContent).toBe('停用云端');
    expect($('#shareDescriptions').labels[0].textContent.trim()).toBe('把生成完成的口述分享给其他 SceneVoice 用户');
  });

  it('Stop using Cloud removes the token, gives the sites back to their default models, turns sharing off, and says so', async () => {
    globalThis.fetch = relay({ '/v1/me': me('free', 0, 3600) });
    await openPage('options', { local: { local: { cloudToken: TOKEN, cloudPlan: 'free' } }, sync: { settings: { youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true } } });
    await vi.waitFor(() => expect($('#cloudStop').hidden).toBe(false));
    $('#cloudStop').click();
    await vi.waitFor(() => expect($('#cloudStatus').textContent).toBe('SceneVoice Cloud is no longer used on this computer; the device token was removed.'));
    expect(fake.areas.local.local).toMatchObject({ cloudToken: '', cloudPlan: '' });
    await vi.waitFor(() => expect(stored()).toMatchObject({ youtubeProvider: 'gemini', bilibiliProvider: 'qwen', shareDescriptions: false }));
    expect($('#cloudInfo').textContent).toMatch(/^Not set up on this computer\./);
    expect($('#cloudStart').hidden).toBe(false);
    expect(document.activeElement.id).toBe('cloudStart');
  });

  it('opens at the Cloud block when sent there, and saves the sharing switch', async () => {
    window.location.hash = '#cloud';
    await openPage('options');
    expect(document.activeElement.id).toBe('cloudStart');
    window.location.hash = '';
    choose($('#shareDescriptions'));
    await vi.waitFor(() => expect(stored().shareDescriptions).toBe(true));
  });

  it('drops a token the relay no longer knows, shows Start free again (and lands on it when sent here), and keeps the sites on Cloud', async () => {
    // The listener was told "Press Start free in settings" and sent to #cloud: that button must be the one there.
    globalThis.fetch = relay({ '/v1/me': [401, { error: { code: 401, message: 'Unknown device token', status: 'UNAUTHENTICATED', details: [{ reason: 'SCENEVOICE_DEVICE_UNKNOWN' }] } }] });
    window.location.hash = '#cloud';
    await openPage('options', { local: { local: { cloudToken: TOKEN, cloudPlan: 'free' } }, sync: { settings: { youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true } } });
    window.location.hash = '';
    await vi.waitFor(() => expect($('#cloudStart').hidden).toBe(false));
    expect($('#cloudStop').hidden).toBe(true);
    expect($('#cloudInfo').textContent).toBe('SceneVoice Cloud no longer recognises this computer’s device token, so it has been removed. Press Start free to get a new one; your other settings are kept.');
    expect(fake.areas.local.local).toMatchObject({ cloudToken: '', cloudPlan: '' });
    expect(document.activeElement.id).toBe('cloudStart');
    // Unlike Stop using Cloud: the sites and sharing stay as they were, so a new token is all Start free has to get.
    expect(stored()).toMatchObject({ youtubeProvider: 'cloud', bilibiliProvider: 'cloud', shareDescriptions: true });
    // Not said through the live region: opening the page is not news.
    expect($('#cloudStatus').textContent).toBe('');
    globalThis.fetch = relay({ 'POST /v1/devices': [201, DEVICE] });
    $('#cloudStart').click();
    await vi.waitFor(() => expect($('#cloudStop').hidden).toBe(false));
    expect(fake.areas.local.local).toMatchObject({ cloudToken: TOKEN, cloudPlan: 'free' });
  });
});
