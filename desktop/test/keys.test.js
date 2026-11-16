// The single keys of the player: the pure key map of renderer/keys.js.

import { describe, expect, it } from 'vitest';

import { ACTIONS, ACTION_IDS } from '../shared/actions.js';
import { actionForKey, targetKind } from '../renderer/keys.js';

const press = (code, extra = {}) => ({ code, key: '', ...extra });

describe('actionForKey', () => {
  it('maps the eight single keys and the question mark by physical key', () => {
    expect(actionForKey(press('Space', { key: ' ' }))).toBe('toggle');
    expect(actionForKey(press('ArrowLeft'))).toBe('back');
    expect(actionForKey(press('ArrowRight'))).toBe('forward');
    expect(actionForKey(press('KeyD'))).toBe('describe');
    expect(actionForKey(press('KeyR'))).toBe('repeat');
    expect(actionForKey(press('KeyS'))).toBe('stop');
    expect(actionForKey(press('KeyW'))).toBe('who');
    expect(actionForKey(press('KeyX'))).toBe('wrong');
    expect(actionForKey(press('Slash', { shiftKey: true, key: '?' }))).toBe('help');
  });

  it('covers every action of the table exactly once', () => {
    const hit = ACTIONS.map((a) => actionForKey({ code: a.code, key: a.key, shiftKey: Boolean(a.shift) }));
    expect(hit).toEqual(ACTION_IDS);
    expect(new Set(ACTIONS.map((a) => a.code)).size).toBe(ACTIONS.length);
  });

  it('goes by the physical key when an input method reports "Process"', () => {
    // A Chinese input method that is switched on reports key "Process" (keyCode 229) for letters.
    expect(actionForKey(press('KeyD', { key: 'Process' }))).toBe('describe');
    expect(actionForKey(press('Slash', { key: 'Process', shiftKey: true }))).toBe('help');
    // On another layout the letter differs but the key is the same key.
    expect(actionForKey(press('KeyW', { key: 'z' }))).toBe('who');
  });

  it('ignores keys during input-method composition', () => {
    expect(actionForKey(press('KeyD', { key: 'Process', isComposing: true }))).toBeNull();
    expect(actionForKey(press('Space', { key: ' ', isComposing: true }))).toBeNull();
  });

  it('ignores keys with a modifier: those are menu accelerators and screen reader commands', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      expect(actionForKey(press('KeyD', { [modifier]: true }))).toBeNull();
      expect(actionForKey(press('Space', { key: ' ', [modifier]: true }))).toBeNull();
      expect(actionForKey(press('ArrowLeft', { [modifier]: true }))).toBeNull();
    }
    expect(actionForKey(press('KeyD', { shiftKey: true }))).toBeNull();
    expect(actionForKey(press('Space', { key: ' ', shiftKey: true }))).toBeNull();
    expect(actionForKey({ code: 'KeyD', key: 'd', getModifierState: (name) => name === 'AltGraph' })).toBeNull();
  });

  it('needs Shift for the question mark on the Slash key, and accepts "?" from any other key', () => {
    expect(actionForKey(press('Slash', { key: '/' }))).toBeNull();
    // German layout: "?" is Shift + the key right of 0.
    expect(actionForKey(press('Minus', { key: '?', shiftKey: true }))).toBe('help');
  });

  it('leaves typing alone: text fields, selects, editable text', () => {
    for (const key of ACTIONS) {
      expect(actionForKey({ code: key.code, key: key.key, shiftKey: Boolean(key.shift) }, 'typing')).toBeNull();
    }
  });

  it('acts on nothing inside an open dialog', () => {
    for (const key of ACTIONS) {
      expect(actionForKey({ code: key.code, key: key.key, shiftKey: Boolean(key.shift) }, 'modal')).toBeNull();
    }
  });

  it('leaves Space to a focused button, and lets the other keys act there', () => {
    expect(actionForKey(press('Space', { key: ' ' }), 'button')).toBeNull();
    expect(actionForKey(press('Enter', { key: 'Enter' }), 'button')).toBeNull();
    expect(actionForKey(press('KeyD'), 'button')).toBe('describe');
    expect(actionForKey(press('ArrowRight'), 'button')).toBe('forward');
  });

  it('repeats seeking while the key is held, and nothing else', () => {
    expect(actionForKey(press('ArrowLeft', { repeat: true }))).toBe('back');
    expect(actionForKey(press('ArrowRight', { repeat: true }))).toBe('forward');
    expect(actionForKey(press('Space', { key: ' ', repeat: true }))).toBeNull();
    expect(actionForKey(press('KeyX', { repeat: true }))).toBeNull();
    expect(actionForKey(press('Slash', { key: '?', shiftKey: true, repeat: true }))).toBeNull();
  });

  it('falls back to the character when a tool injects keys without a physical key', () => {
    expect(actionForKey({ code: '', key: 'd' })).toBe('describe');
    expect(actionForKey({ code: 'Unidentified', key: 'W' })).toBe('who');
    expect(actionForKey({ code: '', key: ' ' })).toBe('toggle');
    expect(actionForKey({ code: '', key: 'ArrowLeft' })).toBe('back');
    expect(actionForKey({ code: '', key: '?' })).toBe('help');
    expect(actionForKey({ code: '', key: 'q' })).toBeNull();
  });

  it('ignores keys that are not in the table, and no event at all', () => {
    expect(actionForKey(press('KeyQ'))).toBeNull();
    expect(actionForKey(press('Enter', { key: 'Enter' }))).toBeNull();
    expect(actionForKey(press('Tab', { key: 'Tab' }))).toBeNull();
    expect(actionForKey(null)).toBeNull();
  });
});

describe('targetKind', () => {
  it('treats fields that take typing or arrows as typing', () => {
    expect(targetKind({ tag: 'INPUT', type: 'text' })).toBe('typing');
    expect(targetKind({ tag: 'input', type: '' })).toBe('typing');
    expect(targetKind({ tag: 'INPUT', type: 'range' })).toBe('typing');
    expect(targetKind({ tag: 'INPUT', type: 'radio' })).toBe('typing');
    expect(targetKind({ tag: 'TEXTAREA' })).toBe('typing');
    expect(targetKind({ tag: 'SELECT' })).toBe('typing');
    expect(targetKind({ tag: 'DIV', editable: true })).toBe('typing');
  });

  it('treats buttons, links and button-like roles as buttons', () => {
    expect(targetKind({ tag: 'BUTTON' })).toBe('button');
    expect(targetKind({ tag: 'INPUT', type: 'checkbox' })).toBe('button');
    expect(targetKind({ tag: 'INPUT', type: 'submit' })).toBe('button');
    expect(targetKind({ tag: 'A', href: true })).toBe('button');
    expect(targetKind({ tag: 'DIV', role: 'button' })).toBe('button');
    expect(targetKind({ tag: 'SUMMARY' })).toBe('button');
  });

  it('puts an open dialog before everything else', () => {
    expect(targetKind({ tag: 'BUTTON', inOpenDialog: true })).toBe('modal');
    expect(targetKind({ tag: 'INPUT', type: 'text', inOpenDialog: true })).toBe('modal');
  });

  it('lets every key act on plain content: the player region, a heading, the page', () => {
    expect(targetKind({ tag: 'DIV', role: 'application' })).toBe('plain');
    expect(targetKind({ tag: 'H1' })).toBe('plain');
    expect(targetKind({ tag: 'A' })).toBe('plain');
    expect(targetKind(null)).toBe('plain');
  });
});
