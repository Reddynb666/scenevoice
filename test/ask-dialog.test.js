// @vitest-environment jsdom
// The ask dialog's question field: Enter sends, Shift+Enter makes a new line,
// and an Enter that belongs to an input method (choosing a candidate, or
// committing the letters typed so far, in Chinese, Japanese or Korean) sends
// nothing. Typing never reaches the site's own single-key shortcuts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageUI, sendsQuestion } from '../src/content/ui.js';
import { fakeChrome } from './fake-chrome.js';

globalThis.chrome = fakeChrome().chrome;

// jsdom has no dialog.showModal yet.
HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

const platform = { getPlayer: () => document.body, rightControls: () => null, progressPlacement: () => ({}), buttonClass: 'b' };

/** A keydown as the browser delivers it. keyCode is not part of KeyboardEventInit in jsdom, so it is defined on the event. */
function keydown(target, { keyCode, ...init }) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: keyCode });
  target.dispatchEvent(e);
  return e;
}

describe('sendsQuestion', () => {
  it('is Enter alone: not Shift+Enter, not another key', () => {
    expect(sendsQuestion({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })).toBe(true);
    expect(sendsQuestion({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 })).toBe(false);
    expect(sendsQuestion({ key: 'a', shiftKey: false, isComposing: false, keyCode: 65 })).toBe(false);
  });

  it('is not an Enter that belongs to an input method, however the browser reports it', () => {
    // Chrome on macOS: key "Enter" with isComposing while the candidate window is open.
    expect(sendsQuestion({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 229 })).toBe(false);
    expect(sendsQuestion({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 })).toBe(false);
    // Some input methods report the committing Enter after composition has formally ended, as keyCode 229.
    expect(sendsQuestion({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false);
    // Windows usually reports key "Process" during composition: not Enter at all.
    expect(sendsQuestion({ key: 'Process', shiftKey: false, isComposing: true, keyCode: 229 })).toBe(false);
  });
});

describe('the question field', () => {
  let ui;
  let asked;
  let input;

  beforeEach(() => {
    document.body.replaceChildren();
    asked = vi.fn(async () => ({ text: 'A chef holds a dumpling.', time: null }));
    ui = new PageUI({ onToggle() {}, platform });
    ui.openAsk({ onSubmit: asked, onClose() {} });
    input = ui.root.querySelector('#sv-ask-input');
  });

  it('sends the question on Enter', async () => {
    input.value = '她手里拿的是什么？';
    const e = keydown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith('她手里拿的是什么？'));
  });

  it('does not send while an input method is composing: choosing a candidate, or committing letters with Enter', async () => {
    // Half a sentence in the field, the rest still in the input method's window.
    input.value = '她手里拿的是';
    const choosing = keydown(input, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
    // The Enter is the input method's: not sent, and not cancelled either, so the candidate is committed.
    expect(choosing.defaultPrevented).toBe(false);
    keydown(input, { key: 'Enter', code: 'Enter', isComposing: false, keyCode: 229 });
    keydown(input, { key: 'Process', code: 'Enter', isComposing: true, keyCode: 229 });
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).not.toHaveBeenCalled();
    // Composition over, the sentence complete: the next Enter sends all of it, once.
    input.value = '她手里拿的是什么？';
    keydown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(asked).toHaveBeenCalledWith('她手里拿的是什么？');
  });

  it('makes a new line on Shift+Enter, and keeps every key from the site’s shortcuts, composing or not', () => {
    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    try {
      input.value = 'Who is';
      const e = keydown(input, { key: 'Enter', code: 'Enter', shiftKey: true, keyCode: 13 });
      expect(e.defaultPrevented).toBe(false);
      expect(asked).not.toHaveBeenCalled();
      for (const init of [{ key: 'f', code: 'KeyF', keyCode: 70 }, { key: ' ', code: 'Space', keyCode: 32 }, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }]) keydown(input, init);
      expect(reached).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', reached);
    }
  });
});

describe('a notice on the video', () => {
  it('is shown as SceneVoice’s own words, without the AI description mark a description carries', () => {
    document.body.replaceChildren();
    const ui = new PageUI({ onToggle() {}, platform });
    ui.showText('A woman enters.', 'visual', 2);
    expect(ui.overlay.querySelector('.kind').textContent).toBe('AI description');
    ui.showText('The built-in voice cannot read these descriptions.', 'notice', 12);
    expect(ui.overlay.hidden).toBe(false);
    expect(ui.overlay.querySelector('.kind')).toBeNull();
    expect(ui.overlay.textContent).toBe('The built-in voice cannot read these descriptions.');
  });
});
