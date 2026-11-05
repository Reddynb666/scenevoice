// Which action a key press means on the web player. Plain keys count only
// inside the player region (role="application") and never in a text field;
// Alt+Shift+D/S/L/Q work anywhere on the page, the same letters as the
// extension's shortcuts. No browser APIs here, so everything is unit-testable.

const PLAIN = {
  ' ': 'play-pause',
  d: 'describe-now',
  r: 'repeat-last',
  a: 'ask',
  s: 'stop-speaking',
  m: 'cycle-mode',
  '?': 'help',
  ArrowLeft: 'back',
  ArrowRight: 'forward',
  ArrowUp: 'speed-up',
  ArrowDown: 'speed-down',
};

const GLOBAL = { d: 'toggle', s: 'describe-now', l: 'repeat-last', q: 'ask' };

const FIELD = /^(input|textarea|select)$/i;

/**
 * @param {{key: string, altKey?: boolean, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
 * @param {{inApplication: boolean, target?: Element | null}} where
 *   inApplication: the event target is inside the player region
 * @returns {string} an action name, or '' when the press is not ours
 */
export function keyAction(event, { inApplication, target = null }) {
  const key = event.key || '';
  const tag = target?.tagName || '';
  const inField = FIELD.test(tag) || target?.isContentEditable === true;
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
    // By physical key: Option+Shift+D on a Mac types "Î", and still counts as D.
    const letter = /^Key([A-Z])$/.exec(event.code || '')?.[1] || key;
    return GLOBAL[letter.toLowerCase()] || '';
  }
  if (!inApplication || inField || event.altKey || event.ctrlKey || event.metaKey) return '';
  // Space and Enter on a button press the button; the shift in "?" is part of the key.
  if (/^(button|a|summary)$/i.test(tag) && (key === ' ' || key === 'Enter')) return '';
  if (event.shiftKey && key !== '?') return '';
  const action = PLAIN[key] || PLAIN[key.toLowerCase()];
  return action || '';
}
