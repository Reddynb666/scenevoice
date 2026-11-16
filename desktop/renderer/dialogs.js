// In-page dialogs of the shell (the plan: dialogs are always <dialog> elements
// in the page, never native windows). A dialog opens modally, keeps the focus
// inside, closes on Escape, and gives the focus back to the element that had it.

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function focusableIn(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.getClientRects().length > 0);
}

/**
 * Open a dialog. Buttons in it carry data-result; pressing one closes the
 * dialog with that result. Escape closes it with 'cancel'; Enter in a text
 * field closes it with 'ok' (not while an input method is composing).
 * @param {HTMLDialogElement} dialog
 * @param {object} [o]
 * @param {HTMLElement} [o.focus]                 what gets the focus first (default: the first control)
 * @param {(result: string) => void} [o.onClose]  called after the focus has gone back
 * @returns {boolean} false when it was already open
 */
export function openModal(dialog, { focus, onClose } = {}) {
  if (dialog.open) return false;
  const doc = dialog.ownerDocument;
  const opener = doc.activeElement;
  let result = 'cancel';

  const close = (value) => {
    result = value;
    dialog.close();
  };
  const onClick = (event) => {
    const button = event.target.closest('[data-result]');
    if (button && dialog.contains(button)) close(button.dataset.result);
  };
  const onKeydown = (event) => {
    const composing = event.isComposing || event.keyCode === 229;
    if (event.key === 'Escape' && !composing) {
      event.preventDefault();
      close('cancel');
      return;
    }
    if (event.key === 'Enter' && !composing && event.target.matches('input[type="text"]')) {
      event.preventDefault();
      close('ok');
      return;
    }
    if (event.key !== 'Tab') return;
    // showModal() already makes the rest of the page inert; this keeps Tab from leaving at either end.
    const items = focusableIn(dialog);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  const onCancel = (event) => {
    event.preventDefault();
    close('cancel');
  };
  const onClosed = () => {
    dialog.removeEventListener('click', onClick);
    dialog.removeEventListener('keydown', onKeydown);
    dialog.removeEventListener('cancel', onCancel);
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    if (onClose) onClose(result);
  };

  dialog.addEventListener('click', onClick);
  dialog.addEventListener('keydown', onKeydown);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onClosed, { once: true });
  dialog.showModal();
  const target = focus || focusableIn(dialog)[0];
  if (target) target.focus();
  return true;
}
