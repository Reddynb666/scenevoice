// @vitest-environment jsdom
// The popup and settings page, loaded from their real HTML with a fake chrome.*:
// quick settings, voices, restore defaults, and what screen readers are told.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Load an extension page's HTML (without running its script tag) and then its module. */
async function openPage(page, opts = {}) {
  const html = readFileSync(join(root, 'src', page, `${page}.html`), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/g, '');
  fake = fakeChrome({
    commands: COMMANDS,
    ...opts,
    reply: (msg) => {
      if (msg.type === MSG.GET_VOICES) return { voices: opts.voices ?? VOICES };
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: opts.shortcuts ?? { 'toggle-descriptions': 'Alt+Shift+D', 'describe-now': 'Alt+Shift+S' } };
      if (msg.type === MSG.CACHE_INFO) return { count: 0, bytes: 0 };
      return { ok: true };
    },
  });
  globalThis.chrome = fake.chrome;
  window.confirm = vi.fn(() => true);
  vi.resetModules();
  await import(`../src/${page}/${page}.js`);
  // Wait for init() to finish: these are filled in after every listener is attached.
  const last = page === 'options' ? '#cacheInfo' : '#quickKeys';
  await vi.waitFor(() => expect(document.querySelector(last).textContent).not.toBe(''));
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
    await vi.waitFor(() => expect($('#videoStatus').textContent).toMatch(/Open a YouTube video/));
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

  it('says that marks of wrong descriptions stay on this computer, and what a correction sends', async () => {
    await openPage('options');
    const items = [...document.querySelectorAll('ul.small li')].map((li) => li.textContent);
    expect(items).toContain('The descriptions you mark as wrong are recorded only on this computer, so the corrected versions are kept. There is no feedback server: nothing is sent to the developer. The record is deleted with the saved descriptions.');
    expect(items.find((s) => s.startsWith('To create descriptions'))).toMatch(/To describe a moment again, the description you marked as wrong is sent too\./);
    await openPage('options', { locale: 'zh_CN', uiLanguage: 'zh-CN' });
    expect([...document.querySelectorAll('ul.small li')].map((li) => li.textContent)).toContain('你标记有误的描述只记录在这台电脑上，用来保留更正后的版本。SceneVoice 没有收集反馈的服务器，什么都不会发给开发者；删除已保存的口述时，这些记录会一并删除。');
  });

  it('lists the new speed shortcuts, unset by default', async () => {
    await openPage('options');
    await vi.waitFor(() => expect(document.querySelectorAll('#shortcuts tr')).toHaveLength(3));
    const rows = [...document.querySelectorAll('#shortcuts tr')].map((tr) => tr.textContent);
    expect(rows).toContain('Speak fasterNot set');
  });
});
