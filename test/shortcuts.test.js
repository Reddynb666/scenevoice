// @vitest-environment jsdom
// Keyboard shortcuts: the syntax, the pageShortcuts setting, and the key layer
// in the real content script: a page key runs its command and never reaches
// the site, a key Chrome owns is left to Chrome, typing is left alone, and
// Alt+Shift+H says every key.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, MSG, PAGE_SHORTCUT_DEFAULTS, SAY_SHORTCUTS } from '../src/shared/constants.js';
import {
  BINDABLE_COMMANDS,
  cleanPageShortcuts,
  displayShortcut,
  effectiveShortcuts,
  isMac,
  isPageShortcut,
  matchShortcut,
  normalizeShortcut,
  pageBindings,
  parseShortcut,
  shortcutConflict,
  shortcutFromEvent,
} from '../src/shared/shortcuts.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { fakeChrome } from './fake-chrome.js';

const keydown = (init) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init });

describe('shortcut syntax', () => {
  it('reads Chrome’s syntax and its Mac symbols, and writes one form', () => {
    expect(parseShortcut('Alt+Shift+D')).toEqual({ ctrl: false, alt: true, shift: true, meta: false, key: 'D' });
    expect(normalizeShortcut('⌥⇧D')).toBe('Alt+Shift+D');
    expect(normalizeShortcut('Option+Shift+d')).toBe('Alt+Shift+D');
    expect(normalizeShortcut('⌘↑')).toBe('Command+Up');
    expect(normalizeShortcut('Ctrl+Shift+Comma')).toBe('Ctrl+Shift+Comma');
    expect(normalizeShortcut('shift+alt+f5')).toBe('Alt+Shift+F5');
    expect(normalizeShortcut(' Ctrl + Alt + 2 ')).toBe('Ctrl+Alt+2');
    for (const bad of ['', 'Alt+', 'Alt+Shift', 'Alt+Alt+D', 'Alt+D+E', 'Alt+Escape', 'F13', 42, null, undefined]) expect(normalizeShortcut(bad), String(bad)).toBe('');
  });

  it('says Option on a Mac and Alt elsewhere, from either spelling', () => {
    expect(displayShortcut('Alt+Shift+W', true)).toBe('Option+Shift+W');
    expect(displayShortcut('⌥⇧W', false)).toBe('Alt+Shift+W');
    expect(displayShortcut('Command+Shift+Up', true)).toBe('Shift+Command+Up');
    expect(displayShortcut('', true)).toBe('');
    expect(isMac({ platform: 'MacIntel' })).toBe(true);
    expect(isMac({ platform: 'Win32' })).toBe(false);
    expect(isMac({ userAgentData: { platform: 'macOS' }, platform: '' })).toBe(true);
    expect(isMac(undefined)).toBe(false);
  });

  it('allows a page key only with Alt, Ctrl or Command and a letter, digit, arrow or function key', () => {
    for (const ok of ['Alt+Shift+W', 'Ctrl+Alt+1', 'Command+Up', 'Alt+F9', 'Ctrl+Shift+Left']) expect(isPageShortcut(ok), ok).toBe(true);
    for (const no of ['Shift+W', 'W', 'Alt+Shift+Comma', 'Alt+Space', 'Alt+Home', '']) expect(isPageShortcut(no), no).toBe(false);
  });

  it('matches a keydown by its physical key, so Option+Shift+W on a Mac is W', () => {
    const bindings = { 'report-wrong': 'Alt+Shift+W', 'speed-up': 'Alt+Shift+Up', 'cycle-detail': '' };
    expect(matchShortcut(keydown({ key: '„', code: 'KeyW', altKey: true, shiftKey: true }), bindings)).toBe('report-wrong');
    expect(matchShortcut(keydown({ key: 'ArrowUp', code: 'ArrowUp', altKey: true, shiftKey: true }), bindings)).toBe('speed-up');
    // The modifiers must match exactly.
    expect(matchShortcut(keydown({ key: 'w', code: 'KeyW', altKey: true }), bindings)).toBe(null);
    expect(matchShortcut(keydown({ key: 'W', code: 'KeyW', altKey: true, shiftKey: true, ctrlKey: true }), bindings)).toBe(null);
    expect(matchShortcut(keydown({ key: 'Alt', code: 'AltLeft', altKey: true }), bindings)).toBe(null);
    expect(matchShortcut(keydown({ key: 'W', code: 'KeyW', altKey: true, shiftKey: true }), {})).toBe(null);
    // No code (a synthetic event): the key as typed.
    expect(shortcutFromEvent(keydown({ key: 'w', altKey: true, shiftKey: true }))).toBe('Alt+Shift+W');
    expect(shortcutFromEvent(keydown({ key: 'ArrowDown', altKey: true }))).toBe('Alt+Down');
    expect(shortcutFromEvent(keydown({ key: 'Shift', shiftKey: true }))).toBe('');
    expect(shortcutFromEvent(keydown({ key: 'Enter', code: 'Enter', altKey: true }))).toBe('');
  });

  it('gives Chrome’s key precedence, hands the page the rest, and names the command already on a key', () => {
    const chromeKeys = { 'toggle-descriptions': '⌥⇧D', 'speed-up': 'Alt+Shift+Up' };
    const page = { ...PAGE_SHORTCUT_DEFAULTS, 'speed-up': 'Alt+Shift+K' };
    const all = effectiveShortcuts(chromeKeys, page);
    expect(all['toggle-descriptions']).toBe('Alt+Shift+D');
    expect(all['speed-up']).toBe('Alt+Shift+Up');
    expect(all['report-wrong']).toBe('Alt+Shift+W');
    expect(all['describe-now']).toBe('');
    expect(Object.keys(all)).toEqual(BINDABLE_COMMANDS);
    const handled = pageBindings(chromeKeys, page);
    expect(handled).not.toHaveProperty('toggle-descriptions');
    expect(handled).not.toHaveProperty('speed-up');
    expect(handled).not.toHaveProperty('describe-now');
    expect(handled['cycle-detail']).toBe('Alt+Shift+E');
    expect(handled[SAY_SHORTCUTS]).toBe('Alt+Shift+H');
    expect(shortcutConflict('⌥⇧D', 'cycle-detail', chromeKeys, page)).toBe('toggle-descriptions');
    expect(shortcutConflict('Alt+Shift+X', 'cycle-detail', chromeKeys, page)).toBe('stop-speaking');
    expect(shortcutConflict('Alt+Shift+E', 'cycle-detail', chromeKeys, page)).toBe(null);
    expect(shortcutConflict('Alt+Shift+J', 'cycle-detail', chromeKeys, page)).toBe(null);
    expect(effectiveShortcuts(undefined, undefined)['cycle-detail']).toBe('');
  });
});

describe('the pageShortcuts setting', () => {
  it('has a default for every command Chrome leaves unset, none for Chrome’s four, and no key twice', () => {
    expect(Object.keys(PAGE_SHORTCUT_DEFAULTS)).toEqual(BINDABLE_COMMANDS);
    for (const c of ['toggle-descriptions', 'describe-now', 'repeat-last', 'ask-question']) expect(PAGE_SHORTCUT_DEFAULTS[c]).toBe('');
    for (const c of BINDABLE_COMMANDS.slice(4)) expect(isPageShortcut(PAGE_SHORTCUT_DEFAULTS[c]), c).toBe(true);
    const keys = Object.values(PAGE_SHORTCUT_DEFAULTS).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    // None of them is one of the four keys the manifest suggests.
    for (const k of ['Alt+Shift+D', 'Alt+Shift+S', 'Alt+Shift+L', 'Alt+Shift+Q']) expect(keys).not.toContain(k);
    expect(normalizeSettings({}).pageShortcuts).toEqual(PAGE_SHORTCUT_DEFAULTS);
    expect(DEFAULT_SETTINGS.pageShortcuts).toBe(PAGE_SHORTCUT_DEFAULTS);
  });

  it('keeps valid keys in one spelling and a cleared key, falls back to the default for the rest, and drops unknown commands', () => {
    const s = normalizeSettings({ pageShortcuts: { 'cycle-detail': 'option+shift+k', 'cycle-mode': '', 'stop-speaking': 'Shift+X', 'speed-up': 42, bogus: 'Alt+Shift+Z' } }).pageShortcuts;
    expect(s['cycle-detail']).toBe('Alt+Shift+K');
    expect(s['cycle-mode']).toBe('');
    expect(s['stop-speaking']).toBe('Alt+Shift+X');
    expect(s['speed-up']).toBe('Alt+Shift+Up');
    expect(s['report-wrong']).toBe('Alt+Shift+W');
    expect(s).not.toHaveProperty('bogus');
    expect(Object.keys(s)).toEqual(BINDABLE_COMMANDS);
    expect(cleanPageShortcuts('nope')).toEqual(PAGE_SHORTCUT_DEFAULTS);
    expect(cleanPageShortcuts([])).toEqual(PAGE_SHORTCUT_DEFAULTS);
    expect(cleanPageShortcuts(null)).toEqual(PAGE_SHORTCUT_DEFAULTS);
  });

  it('never lets two commands share a key: the later one loses it', () => {
    const s = cleanPageShortcuts({ 'cycle-detail': 'Alt+Shift+X' });
    expect(s['cycle-detail']).toBe('Alt+Shift+X');
    expect(s['stop-speaking']).toBe('');
  });
});

// ---------- the key layer in the content script ----------

const watchPage = () => '<html><script>var ytInitialPlayerResponse = {"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"}}}};</script></html>';
const cue = { start: 100, gap: 8, kind: 'visual', priority: 1, brief: 'A door opens.', standard: 'A door opens.', detailed: 'A door opens.' };
const SCRIPTS = {
  keysVideoAA: { version: 2, videoId: 'keysVideoAA', lang: 'en', duration: 600, cues: [cue], characters: [], completedUntil: 600, complete: true, model: 'gemini-test' },
  keysVideoBB: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
let said;
let video;
/** What the site's own key handling sees: a handled key must never get there. */
let siteKeys;
const playback = { paused: true };
const listeners = [];
/** Chrome's own keys, as GET_STATUS reports them; changed in a later test. */
const chromeKeys = { 'toggle-descriptions': 'Alt+Shift+D', 'describe-now': 'Alt+Shift+S', 'repeat-last': 'Alt+Shift+L', 'ask-question': 'Alt+Shift+Q' };
const sender = () => ({ id: fake.chrome.runtime.id });
const stored = () => fake.areas.sync.settings || {};
const uiRoot = () => document.querySelector('[data-scenevoice=ui]')?.shadowRoot;

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}

function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}

/** A key pressed on the page (on the body unless said otherwise), as a browser would deliver it. */
function press(init, target = document.body) {
  const e = keydown(init);
  target.dispatchEvent(e);
  return e;
}

const saveSettings = async (patch) => {
  await chrome.storage.sync.set({ settings: { ...stored(), ...patch } });
  await sleep(50);
};

describe('keys on the video page', () => {
  beforeAll(async () => {
    // jsdom has no modal dialogs: open and close them as a browser would.
    const dialogProto = (globalThis.HTMLDialogElement || HTMLElement).prototype;
    dialogProto.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    dialogProto.close = function close() {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      setTimeout(() => this.dispatchEvent(new Event('close')), 0);
    };

    jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=keysVideoAA' });
    document.body.innerHTML = `
      <ytd-watch-metadata><h1>Keys</h1></ytd-watch-metadata>
      <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
    video = document.querySelector('video');
    Object.defineProperty(video, 'paused', { get: () => playback.paused, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
    video.pause = vi.fn(() => {
      playback.paused = true;
    });
    video.play = vi.fn(async () => {
      playback.paused = false;
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => watchPage() })));
    fake = fakeChrome({
      reply: (msg) => {
        if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { ...chromeKeys } };
        if (msg.type === MSG.GET_SCRIPT) return { script: SCRIPTS[msg.videoId] || null };
        return {};
      },
    });
    fake.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
    globalThis.chrome = fake.chrome;

    const { Announcer } = await import('../src/content/announcer.js');
    const spoken = [];
    const announce = Announcer.prototype.announceToScreenReader;
    Announcer.prototype.announceToScreenReader = function record(text, urgent) {
      spoken.push(text);
      return announce.call(this, text, urgent);
    };
    said = () => spoken;
    await import('../src/content/index.js');
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'keysVideoAA', status: 'ready' }), { timeout: 3000 });
    await sleep(100);
    siteKeys = vi.fn();
    document.addEventListener('keydown', siteKeys);
  });

  it('runs the command on a page key, which never reaches the site', async () => {
    const e = press({ key: 'N', code: 'KeyN', altKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(siteKeys).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(said().at(-1)).toBe('How much to describe: as much as possible.'));
    await vi.waitFor(() => expect(stored()).toMatchObject({ density: 'full', densityChosen: true }));
  });

  it('leaves a key Chrome owns to Chrome', async () => {
    siteKeys.mockClear();
    const before = said().length;
    const e = press({ key: 'D', code: 'KeyD', altKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(siteKeys).toHaveBeenCalledTimes(1);
    await sleep(100);
    expect(said()).toHaveLength(before);
  });

  it('does nothing for Escape, a letter on its own, or Shift with a letter', async () => {
    siteKeys.mockClear();
    const before = said().length;
    for (const init of [{ key: 'Escape', code: 'Escape' }, { key: 'n', code: 'KeyN' }, { key: 'N', code: 'KeyN', shiftKey: true }, { key: 'Alt', code: 'AltLeft', altKey: true }]) {
      expect(press(init).defaultPrevented).toBe(false);
    }
    expect(siteKeys).toHaveBeenCalledTimes(4);
    await sleep(100);
    expect(said()).toHaveLength(before);
    expect(stored().density).toBe('full');
  });

  it('ignores keys typed into a field, an editor, or the ask dialog', async () => {
    const area = document.createElement('textarea');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.append(area, editor);
    for (const target of [area, editor]) {
      target.focus();
      expect(press({ key: 'N', code: 'KeyN', altKey: true, shiftKey: true }, target).defaultPrevented).toBe(false);
    }
    await sleep(100);
    expect(stored().density).toBe('full');
    area.remove();
    editor.remove();

    command('ask-question');
    await vi.waitFor(() => expect(uiRoot().querySelector('dialog[open]')).toBeTruthy());
    const dialog = uiRoot().querySelector('dialog[open]');
    const e = press({ key: 'N', code: 'KeyN', altKey: true, shiftKey: true }, dialog.querySelector('textarea'));
    expect(e.defaultPrevented).toBe(false);
    await sleep(100);
    expect(stored().density).toBe('full');
    dialog.close();
    await sleep(20);
  });

  it('says every key on Alt+Shift+H, Chrome’s and the page’s, even with status messages turned off', async () => {
    await saveSettings({ announceStatus: false });
    press({ key: 'H', code: 'KeyH', altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/^SceneVoice keys: /));
    expect(said().at(-1)).toBe(
      'SceneVoice keys: Alt+Shift+D create or toggle descriptions, Alt+Shift+S describe now, Alt+Shift+L repeat the last, Alt+Shift+Q ask a question, Alt+Shift+W mark the last as wrong, Alt+Shift+X stop speaking. ' +
        'Settings: Alt+Shift+E detail, Alt+Shift+M mode, Alt+Shift+N how much to describe, Alt+Shift+Up faster, Alt+Shift+Down slower, Alt+Shift+H this list. Change any of them under SceneVoice settings, Keyboard shortcuts.',
    );
    await saveSettings({ announceStatus: true });
  });

  it('takes a custom binding from the settings instead of the default, and names a command without a key', async () => {
    await saveSettings({ pageShortcuts: { 'cycle-density': 'Alt+Shift+K', 'speed-down': '' } });
    siteKeys.mockClear();
    const e = press({ key: 'N', code: 'KeyN', altKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(siteKeys).toHaveBeenCalledTimes(1);
    press({ key: 'K', code: 'KeyK', altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(stored().density).toBe('essential'));
    press({ key: 'H', code: 'KeyH', altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/^SceneVoice keys: /));
    expect(said().at(-1)).toContain('Alt+Shift+K how much to describe');
    expect(said().at(-1)).toContain('No key: slower.');
  });

  it('matches the physical key, so Option+Shift on a Mac works although it types another character', async () => {
    press({ key: '˚', code: 'KeyK', altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(stored().density).toBe('standard'));
  });

  it('names the page key in messages when Chrome has none for the command', async () => {
    // The toggle key was cleared on Chrome's shortcuts page; the page has one of its own.
    delete chromeKeys['toggle-descriptions'];
    await saveSettings({ pageShortcuts: { ...stored().pageShortcuts, 'toggle-descriptions': 'Alt+Shift+J' }, generateHintGiven: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(50);
    // A video with no descriptions, played: the hint names the key that creates them.
    jsdom.reconfigure({ url: 'https://www.youtube.com/watch?v=keysVideoBB' });
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.waitFor(async () => expect(await tabState()).toMatchObject({ videoId: 'keysVideoBB', status: 'none' }), { timeout: 3000 });
    playback.paused = false;
    video.dispatchEvent(new Event('play'));
    await vi.waitFor(() => expect(said().some((s) => s.includes('Press Alt+Shift+J to create it'))).toBe(true));
    playback.paused = true;
  });
});
