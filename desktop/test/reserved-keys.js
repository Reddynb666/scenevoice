// Key combinations the menu accelerators of the shell must stay off: what the
// testers' screen readers, Windows itself, its Chinese input method and the
// programs that are open on almost every Chinese desktop do with them.
// test/accelerators.test.js checks shared/actions.js against this list.
//
// Each entry says where it comes from. `documented: true` means the vendor's
// own key reference was read on 2026-11-16 and lists the combination;
// `documented: false` means it is written from memory and no vendor reference
// was read. Nothing here was tried on Windows: no Windows machine was at hand.
//
// NOT KNOWN: 争渡读屏 and 保益读屏. No key reference of either could be found
// from here, so nothing in this list speaks for them. Whether they keep any
// Ctrl+Alt combination for themselves is one of the things K3 measures (guide
// step 6). By analogy with NVDA (Ctrl+Alt+N) and JAWS (Ctrl+Alt+J) their
// desktop shortcuts may be Ctrl+Alt+Z and Ctrl+Alt+B: a guess, kept off anyway.
//
// Combinations are written for Windows, modifiers in the order Ctrl, Alt,
// Shift, then the key as Electron names it in an accelerator.

const NVDA_KEYS = 'https://download.nvaccess.org/documentation/keyCommands.html';
const NVDA_GUIDE = 'https://download.nvaccess.org/documentation/userGuide.html';
const JAWS_KEYS = 'https://www.freedomscientific.com/Content/Documents/Manuals/JAWS/Keystrokes.pdf';
const MAGNIFIER_KEYS = 'https://support.microsoft.com/en-us/accessibility/windows/magnifier/keyboard-shortcuts-for-magnifier';
const PINYIN_KEYS = 'https://support.microsoft.com/en-us/windows/microsoft-simplified-chinese-ime-9b962a3b-2fa4-4f37-811c-b1886320dd72';

const ARROWS = ['Left', 'Right', 'Up', 'Down'];
const withModifiers = (modifiers, keys) => keys.map((key) => `${modifiers}+${key}`);

export const RESERVED = Object.freeze([
  {
    by: 'NVDA',
    what: 'table navigation: next and previous column and row, first and last column and row',
    combinations: withModifiers('Ctrl+Alt', [...ARROWS, 'Home', 'End', 'PageUp', 'PageDown']),
    documented: true,
    source: NVDA_KEYS,
  },
  {
    by: 'NVDA',
    what: 'starts or restarts NVDA (the desktop shortcut its installer offers)',
    combinations: ['Ctrl+Alt+N'],
    documented: true,
    source: NVDA_KEYS,
  },
  {
    by: 'NVDA',
    // The user guide, on browse mode: "a flat representation that can be navigated with the cursor
    // keys". It lists no key by key; that Ctrl+arrow is among them (by word, by paragraph) is how
    // cursor keys work in a text document.
    what: 'browse mode moves its own cursor with the cursor keys of a text document: by word, by paragraph, to the top and the bottom',
    combinations: withModifiers('Ctrl', [...ARROWS, 'Home', 'End']),
    documented: true,
    source: NVDA_GUIDE,
  },
  {
    by: 'JAWS',
    what: 'table navigation: next and prior cell in a row, cell above and below in a column',
    combinations: withModifiers('Ctrl+Alt', ARROWS),
    documented: true,
    source: JAWS_KEYS,
  },
  {
    by: 'JAWS',
    what: 'temporarily increase and decrease the voice rate',
    combinations: withModifiers('Ctrl+Alt', ['PageUp', 'PageDown']),
    documented: true,
    source: JAWS_KEYS,
  },
  {
    by: 'JAWS',
    what: 'move one word left and right (also with the virtual cursor)',
    combinations: withModifiers('Ctrl', ['Left', 'Right']),
    documented: true,
    source: JAWS_KEYS,
  },
  {
    by: 'JAWS',
    what: 'starts JAWS (the desktop shortcut of its installer)',
    combinations: ['Ctrl+Alt+J'],
    documented: false,
    source: 'memory',
  },
  {
    by: 'Windows Magnifier',
    what: 'views (full screen, lens, docked, cycle), invert colours, resize the lens (Windows 10), lock the view (the second shortcut of Windows 11), 1x, show the whole screen, pan',
    combinations: withModifiers('Ctrl+Alt', ['F', 'L', 'D', 'M', 'I', 'R', 'P', '-', 'Space', ...ARROWS]),
    documented: true,
    source: MAGNIFIER_KEYS,
  },
  {
    by: 'Windows Magnifier',
    what: 'reading: start or pause, previous sentence, next sentence (the reading modifier is Ctrl+Alt unless changed)',
    combinations: withModifiers('Ctrl+Alt', ['Enter', 'H', 'K']),
    documented: true,
    source: MAGNIFIER_KEYS,
  },
  {
    by: 'Microsoft Pinyin (the Simplified Chinese input method of Windows)',
    what: 'full-width or half-width characters; Chinese or English punctuation. Its reference lists nothing with Ctrl+Alt.',
    combinations: ['Shift+Space', 'Ctrl+.'],
    documented: true,
    source: PINYIN_KEYS,
  },
  {
    by: 'Windows, with a Chinese input method',
    what: 'switches the input method on and off',
    combinations: ['Ctrl+Space'],
    documented: false,
    source: 'memory',
  },
  {
    by: 'Windows',
    what: 'the security screen; the task switcher that stays open',
    combinations: ['Ctrl+Alt+Delete', 'Ctrl+Alt+Tab'],
    documented: false,
    source: 'memory',
  },
  {
    by: 'WeChat for Windows',
    what: 'brings its window to the front, system-wide',
    combinations: ['Ctrl+Alt+W'],
    documented: false,
    source: 'memory',
  },
  {
    by: 'QQ for Windows',
    what: 'system-wide: screenshot, read a message, screen recording, text recognition, translation',
    combinations: withModifiers('Ctrl+Alt', ['A', 'Z', 'S', 'O', 'F']),
    documented: false,
    source: 'memory',
  },
  {
    by: 'NetEase Cloud Music',
    what: 'system-wide: play or pause, like, lyrics, mini mode, previous and next, volume',
    combinations: withModifiers('Ctrl+Alt', ['P', 'L', 'D', 'M', ...ARROWS]),
    documented: false,
    source: 'memory',
  },
  {
    by: '争渡读屏, 保益读屏 (a guess: see the top of this file)',
    what: 'their desktop shortcuts, if they follow NVDA and JAWS',
    combinations: ['Ctrl+Alt+Z', 'Ctrl+Alt+B'],
    documented: false,
    source: 'guess',
  },
]);

/** Keys that do something to the focused control or move a cursor whatever is held with them. */
export const NEVER_KEYS = Object.freeze(['Space', 'Enter', 'Return', 'Tab', 'Esc', 'Escape', 'Backspace', 'Delete', ...ARROWS, 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * An Electron accelerator as the combination pressed on Windows: "Ctrl+Alt+G".
 * @param {string} accelerator  e.g. 'CmdOrCtrl+Alt+G'
 */
export function onWindows(accelerator) {
  const parts = String(accelerator).split('+');
  // "Ctrl++" and the like: the key itself is the plus sign.
  const key = accelerator.endsWith('++') ? '+' : parts.pop();
  const names = new Set(parts.filter(Boolean).map((part) => ({ CmdOrCtrl: 'Ctrl', CommandOrControl: 'Ctrl', Control: 'Ctrl', Option: 'Alt' })[part] || part));
  const modifiers = ['Ctrl', 'Alt', 'Shift', 'Super'].filter((name) => names.has(name));
  return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join('+');
}

/** The entries of RESERVED that hold this combination. */
export function reservedBy(combination) {
  return RESERVED.filter((entry) => entry.combinations.includes(combination));
}
