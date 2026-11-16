// Interface strings: both languages have the same keys and placeholders, and
// every key the code asks for exists.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import en from '../locales/en.mjs';
import zhCN from '../locales/zh_CN.mjs';
import { ACTIONS, acceleratorWords, helpEntries } from '../shared/actions.js';
import { LOCALES, createT, pickLanguage, placeholders } from '../shared/i18n.js';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(DESKTOP, file), 'utf8');
const SOURCES = ['main/index.js', 'main/menu.js', 'main/selftest.js', 'renderer/app.js', 'renderer/selftest.js', 'renderer/dialogs.js', 'renderer/mictest.js', 'shared/actions.js'];

describe('locale parity', () => {
  it('has the same keys in both languages, in the same order', () => {
    expect(Object.keys(zhCN)).toEqual(Object.keys(en));
  });

  it('has the same placeholders in every string', () => {
    for (const key of Object.keys(en)) {
      expect(placeholders(zhCN[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('has no empty string', () => {
    for (const table of [en, zhCN]) {
      for (const [key, value] of Object.entries(table)) {
        expect(typeof value, key).toBe('string');
        expect(value.trim().length, key).toBeGreaterThan(0);
      }
    }
  });

  it('really is Chinese where it should be', () => {
    const latinOnly = new Set(['htmlLang', 'htmlDir', 'speechLang', 'scriptLang', 'modControl', 'modAlt', 'modCommand', 'modOption', 'modShift']);
    for (const [key, value] of Object.entries(zhCN)) {
      if (latinOnly.has(key)) continue;
      // A string made of placeholders and punctuation only (helpLine) has no word to translate.
      if (!/[A-Za-z0-9一-鿿]/.test(value.replace(/\{\w+\}/g, ''))) continue;
      expect(/[一-鿿]/.test(value), `${key}: ${value}`).toBe(true);
    }
  });

  it('uses full-width punctuation where a Chinese sentence is put together from parts', () => {
    expect(zhCN.helpLine).toBe('{key}：{action}（{accelerator}）。');
    expect(zhCN.listSeparator).toBe('、');
  });

  it('says in words what the microphone test found, and that nothing was recorded', () => {
    expect(zhCN.btnMic).toBe('测试麦克风');
    expect(zhCN.stMicHeard).toMatch(/^麦克风有声音。/);
    expect(zhCN.stMicSilent).toMatch(/^麦克风没有声音。/);
    for (const table of [en, zhCN]) {
      // No number, no meter: a level said in words.
      for (const key of ['stMicListening', 'stMicHeard', 'stMicSilent']) expect(table[key], key).not.toMatch(/\d|%|dB/);
      for (const key of ['stMicDenied', 'stMicMissing', 'stMicBusy', 'stMicFailed']) expect(table[key], key).toContain('{reason}');
    }
    expect(zhCN.stMicHeard).toContain('没有录下任何内容');
    expect(en.stMicHeard).toContain('nothing was recorded');
    expect(zhCN.intro).toContain('不录音');
  });

  it('says which channel reads the descriptions after the app voice gave up', () => {
    expect(zhCN.stVoiceFailed).toContain('现在改由读屏念口述');
    expect(zhCN.stNoVoiceReader).toContain('口述改由读屏来念');
    expect(en.stVoiceFailed).toContain('your screen reader reads them from now on');
    expect(en.stNoVoiceReader).toContain('your screen reader reads the descriptions');
  });

  it('says what to do in a build without the sample clip', () => {
    expect(zhCN.stSampleMissing).toContain('请先按“打开影片”');
    expect(zhCN.stSampleMissing).toContain('再按“听示例”');
    expect(zhCN.stFilmDemoHint).toContain('不带示例影片');
    expect(zhCN.noFilmOpen).not.toContain('听示例');
  });

  it('names the buttons as the test checklist does', () => {
    expect(zhCN.heading).toBe('SceneVoice 影院版 测试版');
    expect([zhCN.btnSample, zhCN.btnOpen, zhCN.btnDialog, zhCN.btnNotify, zhCN.btnUseReader, zhCN.btnUseApp, zhCN.btnHelp]).toEqual([
      '听示例',
      '打开影片',
      '打开一个对话框',
      '发一条通知',
      '用读屏念口述',
      '用软件声音念口述',
      '帮助',
    ]);
  });

  it('carries the credit the licence of the sample film requires', () => {
    for (const table of [en, zhCN]) {
      expect(table.credit).toContain('Tears of Steel');
      expect(table.credit).toContain('(CC) Blender Foundation | mango.blender.org');
      expect(table.credit).toContain('CC BY 3.0');
      // The composer, as the soundtrack's own notice asks.
      expect(table.credit).toContain('(C) Joram Letwory');
      expect(table.credit).toContain('www.tearsofsteel.org');
    }
    const notices = read('THIRD-PARTY-NOTICES.md');
    expect(notices).toContain('(CC) Blender Foundation | mango.blender.org');
    expect(notices).toContain('(C) Joram Letwory - www.tearsofsteel.org');
  });
});

describe('keys used by the code', () => {
  it('all exist in en.mjs', () => {
    const used = new Set();
    for (const file of SOURCES) {
      for (const match of read(file).matchAll(/\bt\(\s*'([A-Za-z]+)'/g)) used.add(match[1]);
      for (const match of read(file).matchAll(/\bt\([^)']*\?\s*'([A-Za-z]+)'\s*:\s*'([A-Za-z]+)'/g)) {
        used.add(match[1]);
        used.add(match[2]);
      }
    }
    const html = read('renderer/index.html');
    for (const match of html.matchAll(/data-i18n(?:-label)?="([A-Za-z]+)"/g)) used.add(match[1]);
    for (const action of ACTIONS) {
      used.add(action.label);
      if (action.keyString) used.add(action.keyString);
    }
    expect(used.size).toBeGreaterThan(60);
    for (const key of used) expect(Object.hasOwn(en, key), key).toBe(true);
  });

  it('leaves no string in en.mjs unused', () => {
    const everything = SOURCES.map(read).join('\n') + read('renderer/index.html');
    const unused = Object.keys(en).filter((key) => !new RegExp(`['"]${key}['"]`).test(everything));
    expect(unused).toEqual([]);
  });

  it('keeps user-facing text out of the page markup', () => {
    const html = read('renderer/index.html').replace(/<!--[\s\S]*?-->/g, '');
    const text = html
      .replace(/<title>[^<]*<\/title>/, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    expect(text).toBe('');
  });
});

describe('pickLanguage and createT', () => {
  it('chooses Chinese for zh locales and English otherwise', () => {
    for (const locale of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans-CN', 'zh-TW', 'ZH-hk']) expect(pickLanguage(locale), locale).toBe('zh_CN');
    for (const locale of ['en-US', 'ja', 'de-DE', '', undefined, null, 'zhx']) expect(pickLanguage(locale), String(locale)).toBe('en');
    expect(Object.keys(LOCALES)).toEqual(['en', 'zh_CN']);
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    const t = createT('zh_CN');
    expect(t('stRate', { rate: 1.5 })).toBe('语速 1.5 倍。');
    expect(t('stRate')).toBe('语速 {rate} 倍。');
    expect(t('durHours', { h: 2, m: 4 })).toBe('2 小时 4 分钟');
    expect(t('noSuchKey')).toBe('noSuchKey');
    expect(createT('fr')('btnHelp')).toBe('Help');
  });
});

describe('help text', () => {
  it('names each key, action and accelerator in words, for both platforms', () => {
    const t = createT('zh_CN');
    const windows = helpEntries(t, 'win32');
    expect(windows).toHaveLength(ACTIONS.length);
    expect(windows[0].line).toBe('空格：播放或暂停（Ctrl+Alt+G）。');
    expect(windows[1].line).toBe('左箭头：后退 10 秒（Ctrl+Alt+逗号）。');
    expect(windows[2].line).toBe('右箭头：前进 10 秒（Ctrl+Alt+句号）。');
    expect(windows[3].line).toBe('D：现在描述（Ctrl+Alt+E）。');
    expect(windows[4].line).toBe('R：重复上一条口述（Ctrl+Alt+T）。');
    expect(windows[5].line).toBe('S：停止朗读（Ctrl+Alt+C）。');
    expect(windows[6].line).toBe('W：谁在画面里（Ctrl+Alt+Q）。');
    expect(windows[7].line).toBe('X：名字错了（Ctrl+Alt+X）。');
    expect(windows[8].line).toBe('问号：按键帮助（Ctrl+Alt+斜杠）。');
    const mac = helpEntries(t, 'darwin');
    expect(mac[3].line).toBe('D：现在描述（Command+Option+E）。');
    expect(mac[1].line).toBe('左箭头：后退 10 秒（Command+Option+逗号）。');
  });

  it('spells accelerators without symbols a screen reader may skip', () => {
    const t = createT('en');
    expect(acceleratorWords('CmdOrCtrl+Alt+W', 'win32', t)).toBe('Ctrl+Alt+W');
    expect(acceleratorWords('CmdOrCtrl+Space', 'win32', t)).toBe('Ctrl+Space');
    expect(acceleratorWords('CmdOrCtrl+Alt+/', 'darwin', t)).toBe('Command+Option+Slash');
    expect(acceleratorWords('CmdOrCtrl+Alt+,', 'win32', t)).toBe('Ctrl+Alt+Comma');
    expect(acceleratorWords('CmdOrCtrl+Alt+.', 'win32', t)).toBe('Ctrl+Alt+Period');
    // No accelerator of the table is left with a bare symbol in it.
    for (const entry of helpEntries(t, 'win32')) expect(entry.accelerator).toMatch(/^[A-Za-z+]+$/);
  });
});
