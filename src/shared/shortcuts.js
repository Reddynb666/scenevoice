// Keyboard shortcuts: the syntax Chrome uses ("Alt+Shift+D") and the symbols
// it returns on a Mac ("⌥⇧D"), matching a keydown by its physical key, and
// which command a key belongs to: Chrome's own binding or the page's layer.
//
// Chrome lets an extension suggest four keys; the rest are set on
// chrome://extensions/shortcuts, a page screen readers struggle with. So the
// commands Chrome leaves unset have keys of their own (PAGE_SHORTCUT_DEFAULTS),
// handled by the content script and changed on SceneVoice's settings page,
// stored in the synced setting `pageShortcuts`. A command that has a Chrome
// key is never handled by the page as well, or it would fire twice.
//
// A key is matched by e.code, the physical key: Option+Shift+W on a Mac gives
// e.key "„", and still counts as W. No browser APIs here.

import { COMMANDS, PAGE_SHORTCUT_DEFAULTS, SAY_SHORTCUTS } from './constants.js';

/** Every command a key can run: the manifest's, plus the page-only "say the shortcuts". */
export const BINDABLE_COMMANDS = Object.freeze([...COMMANDS, SAY_SHORTCUTS]);

/** The message key of each command's description (the manifest uses the same ones). */
export const COMMAND_LABEL_KEYS = Object.freeze({
  'toggle-descriptions': 'cmd_toggle',
  'describe-now': 'cmd_describe_now',
  'repeat-last': 'cmd_repeat',
  'ask-question': 'cmd_ask',
  'report-wrong': 'cmd_report_wrong',
  'cycle-detail': 'cmd_cycle_detail',
  'cycle-mode': 'cmd_cycle_mode',
  'cycle-density': 'cmd_cycle_density',
  'speed-up': 'cmd_speed_up',
  'speed-down': 'cmd_speed_down',
  'stop-speaking': 'cmd_stop',
  [SAY_SHORTCUTS]: 'cmd_say_shortcuts',
});

/** The message key of each command's short name, for the spoken list. */
export const COMMAND_SHORT_KEYS = Object.freeze({
  'toggle-descriptions': 'key_toggle',
  'describe-now': 'key_describe_now',
  'repeat-last': 'key_repeat',
  'ask-question': 'key_ask',
  'report-wrong': 'key_report_wrong',
  'cycle-detail': 'quick_detail',
  'cycle-mode': 'quick_mode',
  'cycle-density': 'quick_density',
  'speed-up': 'quick_faster',
  'speed-down': 'quick_slower',
  'stop-speaking': 'key_stop',
  [SAY_SHORTCUTS]: 'key_say_shortcuts',
});

/** The spoken list, in two sentences: what you do to the video, then the settings. */
export const SPOKEN_GROUPS = Object.freeze([
  Object.freeze(['toggle-descriptions', 'describe-now', 'repeat-last', 'ask-question', 'report-wrong', 'stop-speaking']),
  Object.freeze(['cycle-detail', 'cycle-mode', 'cycle-density', 'speed-up', 'speed-down', SAY_SHORTCUTS]),
]);

const MODIFIER_OF = {
  ctrl: 'ctrl',
  control: 'ctrl',
  macctrl: 'ctrl',
  '⌃': 'ctrl',
  alt: 'alt',
  option: 'alt',
  '⌥': 'alt',
  shift: 'shift',
  '⇧': 'shift',
  command: 'meta',
  cmd: 'meta',
  meta: 'meta',
  win: 'meta',
  super: 'meta',
  search: 'meta',
  '⌘': 'meta',
};
const MODIFIER_SYMBOLS = new Set(['⌃', '⌥', '⇧', '⌘']);

/** Named keys, as Chrome spells them, with the spellings they may arrive in. */
const NAMED_KEYS = {
  up: 'Up',
  arrowup: 'Up',
  '↑': 'Up',
  down: 'Down',
  arrowdown: 'Down',
  '↓': 'Down',
  left: 'Left',
  arrowleft: 'Left',
  '←': 'Left',
  right: 'Right',
  arrowright: 'Right',
  '→': 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  space: 'Space',
  ' ': 'Space',
  insert: 'Insert',
  ins: 'Insert',
  delete: 'Delete',
  del: 'Delete',
  comma: 'Comma',
  ',': 'Comma',
  period: 'Period',
  '.': 'Period',
};

/** Keys a page shortcut may use: letters, digits, arrows and function keys. */
const PAGE_KEY = /^([A-Z0-9]|F([1-9]|1[0-2])|Up|Down|Left|Right)$/;

function keyToken(token) {
  const up = token.toUpperCase();
  if (/^[A-Z0-9]$/.test(up) || /^F([1-9]|1[0-2])$/.test(up)) return up;
  return NAMED_KEYS[token.toLowerCase()] || null;
}

/**
 * "Alt+Shift+D", "Option+Shift+D", "⌥⇧D", "Command+Up" or "⌘↑" →
 * { ctrl, alt, shift, meta, key }, or null for anything else.
 */
export function parseShortcut(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  let tokens;
  if (s.includes('+')) {
    tokens = s.split('+').map((p) => p.trim());
    if (tokens.some((p) => !p)) return null;
  } else {
    // Chrome's form on a Mac: modifier symbols, then the key.
    tokens = [];
    let rest = s;
    while (rest && MODIFIER_SYMBOLS.has(rest[0])) {
      tokens.push(rest[0]);
      rest = rest.slice(1);
    }
    if (!rest) return null;
    tokens.push(rest);
  }
  const out = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const token of tokens) {
    const mod = MODIFIER_OF[token.toLowerCase()];
    if (mod) {
      if (out[mod]) return null;
      out[mod] = true;
      continue;
    }
    if (out.key) return null;
    const key = keyToken(token);
    if (!key) return null;
    out.key = key;
  }
  return out.key ? out : null;
}

/**
 * A shortcut as text. Stored and compared in Chrome's syntax ("Alt+Shift+D",
 * "Ctrl+Alt+Shift+Command+Up" at most); shown with `mac` as "Option+Shift+D",
 * which a screen reader reads out, unlike "⌥⇧D".
 */
export function formatShortcut(shortcut, { mac = false } = {}) {
  const p = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut;
  if (!p?.key) return '';
  const parts = [];
  if (p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push(mac ? 'Option' : 'Alt');
  if (p.shift) parts.push('Shift');
  if (p.meta) parts.push('Command');
  parts.push(p.key);
  return parts.join('+');
}

/** The stored form of a shortcut written any of the accepted ways, or '' when it is not one. */
export const normalizeShortcut = (text) => formatShortcut(parseShortcut(text));

/** Whether this computer is a Mac, where Alt is called Option. */
export function isMac(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /^Mac|iPhone|iPad/i.test(platform);
}

/** A shortcut as the listener should hear it on this computer; '' for none. */
export const displayShortcut = (text, mac = isMac()) => formatShortcut(parseShortcut(text), { mac });

/**
 * Whether a key may be a page shortcut: Alt, Ctrl or Command held (Shift
 * alone would type, and clash with the players' own Shift keys), with a
 * letter, digit, arrow or function key.
 */
export function isPageShortcut(text) {
  const p = parseShortcut(text);
  return Boolean(p && (p.alt || p.ctrl || p.meta) && PAGE_KEY.test(p.key));
}

/** The key a keydown names, by its physical key (e.code) first, or null for a modifier alone or a key we do not bind. */
export function keyFromEvent(e) {
  const code = e.code || '';
  let m = /^(?:Key|Digit|Numpad)([A-Z0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Arrow(Up|Down|Left|Right)$/.exec(code);
  if (m) return m[1];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  // No code (an old or synthetic event): the key as typed, if it is one we bind.
  const key = e.key || '';
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  m = /^Arrow(Up|Down|Left|Right)$/.exec(key);
  if (m) return m[1];
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  return null;
}

/** The shortcut a keydown is, in stored form, or '' for a modifier alone or a key we do not bind. */
export function shortcutFromEvent(e) {
  const key = keyFromEvent(e);
  if (!key) return '';
  return formatShortcut({ ctrl: Boolean(e.ctrlKey), alt: Boolean(e.altKey), shift: Boolean(e.shiftKey), meta: Boolean(e.metaKey), key });
}

/** The command a keydown runs, given { command: shortcut } bindings, or null. */
export function matchShortcut(e, bindings) {
  const pressed = shortcutFromEvent(e);
  if (!pressed) return null;
  for (const [command, key] of Object.entries(bindings || {})) {
    if (key && normalizeShortcut(key) === pressed) return command;
  }
  return null;
}

/**
 * The key each command answers to, in stored form, '' for none: Chrome's own
 * key when it has one (the page never handles those), the page key otherwise.
 * @param {object} chromeKeys  { command: shortcut } from chrome.commands.getAll()
 * @param {object} pageKeys    the pageShortcuts setting
 */
export function effectiveShortcuts(chromeKeys, pageKeys) {
  const out = {};
  for (const command of BINDABLE_COMMANDS) {
    out[command] = normalizeShortcut(chromeKeys?.[command]) || normalizeShortcut(pageKeys?.[command]) || '';
  }
  return out;
}

/** The commands the page handles itself: those with a page key and no Chrome key. */
export function pageBindings(chromeKeys, pageKeys) {
  const out = {};
  for (const command of BINDABLE_COMMANDS) {
    if (normalizeShortcut(chromeKeys?.[command])) continue;
    const key = normalizeShortcut(pageKeys?.[command]);
    if (key) out[command] = key;
  }
  return out;
}

/** The other command already on this key (Chrome's or the page's), or null when it is free. */
export function shortcutConflict(shortcut, command, chromeKeys, pageKeys) {
  const key = normalizeShortcut(shortcut);
  if (!key) return null;
  for (const other of BINDABLE_COMMANDS) {
    if (other === command) continue;
    if (normalizeShortcut(chromeKeys?.[other]) === key || normalizeShortcut(pageKeys?.[other]) === key) return other;
  }
  return null;
}

/**
 * The pageShortcuts setting, cleaned: every bindable command present, '' for
 * none, an unusable value replaced by the default, two commands on one key
 * reduced to the first. Anything else in the object is dropped.
 */
export function cleanPageShortcuts(raw, defaults = PAGE_SHORTCUT_DEFAULTS) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  const used = new Set();
  for (const command of BINDABLE_COMMANDS) {
    const fallback = defaults[command] || '';
    const value = src[command];
    let key;
    if (value === '') key = '';
    else if (typeof value === 'string' && isPageShortcut(value)) key = normalizeShortcut(value);
    else key = fallback;
    if (key && used.has(key)) key = '';
    if (key) used.add(key);
    out[command] = key;
  }
  return out;
}
