// The listening actions of the test shell, in one table: the single key of the
// player region, the accelerator of the native menu and the strings that name
// them. The key map (renderer/keys.js), the menu (main/menu.js) and the help
// text all read this table, so the three cannot drift apart; the key lists of
// the testers' guide and of the README are checked against it
// (test/accelerators.test.js).
// Pure data and pure functions: no DOM, no Electron.

/**
 * code: the physical key (KeyboardEvent.code), so a Chinese input method or
 *   another layout cannot change which key it is.
 * key: what KeyboardEvent.key says for it, used only when a tool that injects
 *   keys leaves `code` empty.
 * accelerator: Electron's syntax. CmdOrCtrl is Ctrl on Windows and Cmd on
 *   macOS, so every one is Ctrl+Alt+key or Cmd+Alt+key, which a screen reader
 *   that keeps the single keys for itself still lets through. The key is the
 *   single key's own letter where nothing the testers run is known to take it,
 *   and otherwise a free one (test/reserved-keys.js holds what is taken, with
 *   where each entry comes from, and test/accelerators.test.js checks this
 *   table against it): never Space or Enter (they also press the focused
 *   button, and Ctrl+Space switches the Chinese input method), never the
 *   arrows (Ctrl+arrow moves by word in a screen reader's browse mode;
 *   Ctrl+Alt+arrow is table navigation and Windows Magnifier's panning), not
 *   P, D or R (Magnifier: lock the view, docked view, resize the lens), not S
 *   or W (QQ and WeChat register them system-wide, as far as we know). So: G
 *   ("go") for play or pause, comma and period (the keys of "<" and ">") for
 *   back and forward, E for describe (the key above D), T for repeat (the key
 *   next to R), C ("cut") for stop, Q for who (the key next to W). None of
 *   this has been tried on Windows.
 * keyString / keyText: how the single key is named in the help text (a locale
 *   key, or the letter itself).
 * repeats: holding the key repeats the action (seeking); the others act once.
 */
export const ACTIONS = Object.freeze([
  Object.freeze({ id: 'toggle', code: 'Space', key: ' ', keyString: 'keySpace', accelerator: 'CmdOrCtrl+Alt+G', label: 'actionToggle' }),
  Object.freeze({ id: 'back', code: 'ArrowLeft', key: 'arrowleft', keyString: 'keyLeft', accelerator: 'CmdOrCtrl+Alt+,', label: 'actionBack', repeats: true }),
  Object.freeze({ id: 'forward', code: 'ArrowRight', key: 'arrowright', keyString: 'keyRight', accelerator: 'CmdOrCtrl+Alt+.', label: 'actionForward', repeats: true }),
  Object.freeze({ id: 'describe', code: 'KeyD', key: 'd', keyText: 'D', accelerator: 'CmdOrCtrl+Alt+E', label: 'actionDescribe' }),
  Object.freeze({ id: 'repeat', code: 'KeyR', key: 'r', keyText: 'R', accelerator: 'CmdOrCtrl+Alt+T', label: 'actionRepeat' }),
  Object.freeze({ id: 'stop', code: 'KeyS', key: 's', keyText: 'S', accelerator: 'CmdOrCtrl+Alt+C', label: 'actionStop' }),
  Object.freeze({ id: 'who', code: 'KeyW', key: 'w', keyText: 'W', accelerator: 'CmdOrCtrl+Alt+Q', label: 'actionWho' }),
  Object.freeze({ id: 'wrong', code: 'KeyX', key: 'x', keyText: 'X', accelerator: 'CmdOrCtrl+Alt+X', label: 'actionWrong' }),
  Object.freeze({ id: 'help', code: 'Slash', shift: true, key: '?', keyString: 'keyQuestion', accelerator: 'CmdOrCtrl+Alt+/', label: 'actionHelp' }),
]);

export const ACTION_IDS = Object.freeze(ACTIONS.map((a) => a.id));

/** Seconds one press of the back or forward key moves. */
export const SEEK_SECONDS = 10;

/**
 * The other commands of the native menu. The main process passes the first
 * three on to the page; 'report' it carries out itself (the page's own button
 * runs the same command).
 */
export const MENU_COMMANDS = Object.freeze(['sample', 'open', 'channel', 'report']);

/** The accelerators of those commands: only "Open a film" has one, the usual one. */
export const COMMAND_ACCELERATORS = Object.freeze({ open: 'CmdOrCtrl+O' });

export function actionById(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

/** Keys a screen reader may skip or misread as a symbol: named in words. */
const PART_STRINGS = Object.freeze({
  Space: 'keySpace',
  Left: 'keyLeft',
  Right: 'keyRight',
  ',': 'keyComma',
  '.': 'keyPeriod',
  '/': 'keySlash',
  Shift: 'modShift',
});

/**
 * An accelerator in words a screen reader can say: "Ctrl+Alt+E" on Windows and
 * Linux, "Command+Option+E" on macOS.
 * @param {string} accelerator  Electron syntax
 * @param {string} platform     process.platform
 * @param {(key: string) => string} t
 */
export function acceleratorWords(accelerator, platform, t) {
  const mac = platform === 'darwin';
  return String(accelerator)
    .split('+')
    .map((part) => {
      if (part === 'CmdOrCtrl') return t(mac ? 'modCommand' : 'modControl');
      if (part === 'Alt') return t(mac ? 'modOption' : 'modAlt');
      return PART_STRINGS[part] ? t(PART_STRINGS[part]) : part;
    })
    .join('+');
}

/**
 * The key list, one entry per action, in the order of the table.
 * @returns {{id: string, key: string, action: string, accelerator: string, line: string}[]}
 */
export function helpEntries(t, platform) {
  return ACTIONS.map((a) => {
    const key = a.keyString ? t(a.keyString) : a.keyText;
    const action = t(a.label);
    const accelerator = acceleratorWords(a.accelerator, platform, t);
    return { id: a.id, key, action, accelerator, line: t('helpLine', { key, action, accelerator }) };
  });
}
