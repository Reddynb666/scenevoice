// The menu accelerators: one table (shared/actions.js) is what the menu, the
// help text, the testers' guide, the test matrix and the README say, and no
// accelerator is a combination that the testers' assistive tools, Windows, its
// Chinese input method or the usual desktop programs keep for themselves
// (test/reserved-keys.js, with where each entry comes from).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildMenuTemplate, itemsWithId } from '../main/menu.js';
import { ACTIONS, COMMAND_ACCELERATORS, acceleratorWords, helpEntries } from '../shared/actions.js';
import { createT } from '../shared/i18n.js';
import { NEVER_KEYS, RESERVED, onWindows, reservedBy } from './reserved-keys.js';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(DESKTOP, file), 'utf8');
const menuItems = (platform = 'win32') => itemsWithId(buildMenuTemplate({ t: createT('zh_CN'), platform, appName: 'SceneVoice', onCommand: () => {} }));

describe('the accelerator table', () => {
  it('is Ctrl or Cmd with Alt and one key for every listening action', () => {
    const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a.accelerator]));
    expect(byId).toEqual({
      toggle: 'CmdOrCtrl+Alt+G',
      back: 'CmdOrCtrl+Alt+,',
      forward: 'CmdOrCtrl+Alt+.',
      describe: 'CmdOrCtrl+Alt+E',
      repeat: 'CmdOrCtrl+Alt+T',
      stop: 'CmdOrCtrl+Alt+C',
      who: 'CmdOrCtrl+Alt+Q',
      wrong: 'CmdOrCtrl+Alt+X',
      help: 'CmdOrCtrl+Alt+/',
    });
    for (const accelerator of Object.values(byId)) expect(accelerator).toMatch(/^CmdOrCtrl\+Alt\+[A-Z,./]$/);
    expect(COMMAND_ACCELERATORS).toEqual({ open: 'CmdOrCtrl+O' });
  });

  it('is where the menu takes every accelerator from', () => {
    const fromTable = [...ACTIONS.map((a) => a.accelerator), ...Object.values(COMMAND_ACCELERATORS)].sort();
    const inMenu = menuItems().map((item) => item.accelerator).filter(Boolean).sort();
    expect(inMenu).toEqual(fromTable);
    expect(new Set(inMenu).size).toBe(inMenu.length);
    // Nothing spelled out in the menu itself.
    expect(read('main/menu.js')).not.toMatch(/accelerator:\s*['"`]/);
  });
});

describe('the reserved combinations', () => {
  it('are written the way an accelerator is compared with them', () => {
    expect(onWindows('CmdOrCtrl+Alt+G')).toBe('Ctrl+Alt+G');
    expect(onWindows('Alt+CmdOrCtrl+g')).toBe('Ctrl+Alt+G');
    expect(onWindows('CmdOrCtrl+Alt+,')).toBe('Ctrl+Alt+,');
    expect(onWindows('CmdOrCtrl+Space')).toBe('Ctrl+Space');
    expect(onWindows('Shift+CmdOrCtrl+Left')).toBe('Ctrl+Shift+Left');
    expect(onWindows('CmdOrCtrl++')).toBe('Ctrl++');
    for (const entry of RESERVED) {
      expect(entry.by && entry.what && entry.source, entry.by).toBeTruthy();
      expect(typeof entry.documented).toBe('boolean');
      // A documented entry names the vendor's own page.
      if (entry.documented) expect(entry.source).toMatch(/^https:\/\/(download\.nvaccess\.org|www\.freedomscientific\.com|support\.microsoft\.com)\//);
      for (const combination of entry.combinations) expect(onWindows(combination), `${entry.by}: ${combination}`).toBe(combination);
    }
  });

  it('hold what the reviews found the first table colliding with', () => {
    const taken = (combination) => reservedBy(combination).map((entry) => entry.by);
    expect(taken('Ctrl+Left')).toEqual(expect.arrayContaining(['NVDA', 'JAWS']));
    expect(taken('Ctrl+Right')).toEqual(expect.arrayContaining(['NVDA', 'JAWS']));
    expect(taken('Ctrl+Alt+D')).toContain('Windows Magnifier');
    expect(taken('Ctrl+Alt+R')).toContain('Windows Magnifier');
    expect(taken('Ctrl+Alt+P')).toContain('Windows Magnifier');
    expect(taken('Ctrl+Space')).toHaveLength(1);
    expect(taken('Ctrl+Alt+W')).toEqual(['WeChat for Windows']);
    expect(taken('Ctrl+Alt+G')).toEqual([]);
  });
});

describe('every accelerator of the menu', () => {
  for (const item of menuItems().filter((entry) => entry.accelerator)) {
    it(`${item.id} (${onWindows(item.accelerator)}) is not a reserved combination`, () => {
      const combination = onWindows(item.accelerator);
      expect(reservedBy(combination).map((entry) => `${entry.by}: ${entry.what}`)).toEqual([]);
    });

    it(`${item.id} uses no key that presses a button or moves a cursor`, () => {
      // Space and Enter press the focused button whatever is held with them (so Ctrl+Space would
      // also start the sample again from the "Hear a sample" button); the arrows move a cursor.
      const key = onWindows(item.accelerator).split('+').pop();
      expect(NEVER_KEYS).not.toContain(key);
    });
  }

  it('reaches the page as a key press that the single-key map leaves alone', async () => {
    const { actionForKey } = await import('../renderer/keys.js');
    for (const action of ACTIONS) {
      const key = action.accelerator.split('+').pop();
      const code = /^[A-Z]$/.test(key) ? `Key${key}` : { ',': 'Comma', '.': 'Period', '/': 'Slash' }[key];
      expect(actionForKey({ code, key: key.toLowerCase(), ctrlKey: true, altKey: true }, 'plain'), action.id).toBe(null);
      expect(actionForKey({ code, key: key.toLowerCase(), metaKey: true, altKey: true }, 'button'), action.id).toBe(null);
    }
  });
});

describe('the documents that list the keys', () => {
  const zh = createT('zh_CN');
  const en = createT('en');
  const guide = fs.readFileSync(path.join(DESKTOP, '..', 'docs', 'film', 'k3-tester-guide.zh-CN.md'), 'utf8');
  const matrix = fs.readFileSync(path.join(DESKTOP, '..', 'docs', 'desktop-sr-matrix.md'), 'utf8');

  it('the testers\' guide lists each accelerator with its action, as the table has it', () => {
    for (const action of ACTIONS) {
      const line = `- ${acceleratorWords(action.accelerator, 'win32', zh)}：${zh(action.label)}`;
      expect(guide.includes(line), line).toBe(true);
    }
    // And no accelerator that is not in the table: every "Ctrl+Alt+something" of the guide is one of ours.
    const ours = new Set(ACTIONS.map((a) => acceleratorWords(a.accelerator, 'win32', zh)));
    const listed = [...guide.matchAll(/^- (Ctrl\+Alt\+[^：\s]+)：/gm)].map((m) => m[1]);
    expect(listed.length).toBe(ACTIONS.length);
    for (const combination of listed) expect(ours.has(combination), combination).toBe(true);
    expect(guide).toContain(`也可以按 ${acceleratorWords(COMMAND_ACCELERATORS.open, 'win32', zh)}`);
  });

  it('the testers\' guide lists each single key with its action', () => {
    for (const entry of helpEntries(zh, 'win32').filter((e) => e.id !== 'help')) {
      const line = `- ${entry.key}：${entry.action}`;
      expect(guide.includes(line), line).toBe(true);
    }
  });

  it('the test matrix names the same accelerator keys', () => {
    const keys = ACTIONS.filter((a) => a.id !== 'help').map((a) => acceleratorWords(a.accelerator, 'win32', en).split('+').pop());
    expect(matrix).toContain(`all Ctrl+Alt+key: ${keys.join(', ')}`);
  });

  it('the README names every accelerator', () => {
    const readme = read('README.md');
    for (const action of ACTIONS) expect(readme, action.id).toContain(acceleratorWords(action.accelerator, 'win32', en));
  });
});
