// The single keys of the player: which listening action a key press means.
// Keys are matched by the physical key (event.code), so a Chinese input method
// or another keyboard layout cannot swallow or move them. A press is left alone
// while the user types in a field, during input-method composition, when a
// modifier is held (those are the menu accelerators and the screen reader's own
// commands), inside an open dialog, and, for Space, on a button, which Space
// and Enter activate. The map itself is a pure function; listenForKeys is the
// only part that touches the DOM.

import { ACTIONS } from '../shared/actions.js';

const HELP = ACTIONS.find((a) => a.id === 'help');
const BY_CODE = new Map(ACTIONS.filter((a) => a !== HELP).map((a) => [a.code, a]));
const BY_KEY = new Map(ACTIONS.filter((a) => a !== HELP).map((a) => [a.key, a]));

/** Input types that behave like a button: Space presses them, other keys are free. */
const BUTTON_INPUTS = new Set(['button', 'submit', 'reset', 'image', 'checkbox']);
const BUTTON_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'menuitem', 'tab', 'option']);
const BUTTON_TAGS = new Set(['BUTTON', 'SUMMARY']);

/**
 * What the focused element does with keys.
 *   'typing': a field that takes letters or arrows for itself: no single key acts.
 *   'modal':  inside an open dialog: no single key acts.
 *   'button': Space (and Enter) belong to it; the other keys act.
 *   'plain':  every key acts.
 * @param {{tag?: string, type?: string, role?: string, editable?: boolean, href?: boolean, inOpenDialog?: boolean}} target
 * @returns {'typing'|'modal'|'button'|'plain'}
 */
export function targetKind(target) {
  if (!target) return 'plain';
  if (target.inOpenDialog) return 'modal';
  const tag = String(target.tag || '').toUpperCase();
  const type = String(target.type || '').toLowerCase();
  if (target.editable || tag === 'TEXTAREA' || tag === 'SELECT') return 'typing';
  if (tag === 'INPUT') return BUTTON_INPUTS.has(type) ? 'button' : 'typing';
  if (BUTTON_TAGS.has(tag) || (tag === 'A' && target.href) || BUTTON_ROLES.has(String(target.role || '').toLowerCase())) return 'button';
  return 'plain';
}

function altGraph(event) {
  return typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
}

/**
 * The action a keydown means, or null.
 * @param {{code?: string, key?: string, shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean,
 *          metaKey?: boolean, isComposing?: boolean, repeat?: boolean}} event
 * @param {'typing'|'modal'|'button'|'plain'} [target]
 * @returns {string|null} an id of shared/actions.js
 */
export function actionForKey(event, target = 'plain') {
  if (!event || event.isComposing) return null;
  if (event.ctrlKey || event.altKey || event.metaKey || altGraph(event)) return null;
  if (target === 'typing' || target === 'modal') return null;
  const code = event.code && event.code !== 'Unidentified' ? event.code : '';
  const key = String(event.key || '');
  let action = null;
  if (code === HELP.code ? event.shiftKey : key === HELP.key) {
    // Shift+Slash on the layouts testers use; "?" itself wherever else a layout puts it.
    action = HELP;
  } else if (!event.shiftKey) {
    // A tool that injects keys may leave `code` empty: then go by the character.
    action = code ? BY_CODE.get(code) : BY_KEY.get(key.toLowerCase());
  }
  if (!action) return null;
  if (target === 'button' && action.code === 'Space') return null;
  if (event.repeat && !action.repeats) return null;
  return action.id;
}

/** targetKind for a real element. */
export function kindOfElement(el) {
  if (!el || typeof el.closest !== 'function') return 'plain';
  return targetKind({
    tag: el.tagName,
    type: el.getAttribute('type') || el.type,
    role: el.getAttribute('role'),
    editable: el.isContentEditable === true,
    href: el.hasAttribute('href'),
    inOpenDialog: Boolean(el.closest('dialog[open]')),
  });
}

/**
 * Listen for the single keys on `root` (the document: the keys work wherever
 * the focus is, the player region is where a screen reader lets them through).
 * @param {EventTarget} root
 * @param {(action: string, event: KeyboardEvent) => void} onAction
 */
export function listenForKeys(root, onAction) {
  root.addEventListener('keydown', (event) => {
    const action = actionForKey(event, kindOfElement(event.target));
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    onAction(action, event);
  });
}
