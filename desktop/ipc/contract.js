// The IPC contract of the test shell: every channel between the page and the
// main process, with who sends it and a validator for what it carries. The
// main process registers handlers from this table only, rejects a message whose
// sender is not the app's own main frame (senderAllowed) and passes a handler
// nothing but the validated copy. The page gets the channel names through the
// preload script and can use no other.
// Pure: no Electron, no DOM. The same idea as src/shared/sender.js in the extension.

import { ACTION_IDS, MENU_COMMANDS } from '../shared/actions.js';

export const APP_PROTOCOL = 'app:';
export const APP_HOST = 'scenevoice';

/**
 * Whether a message may be handled: it has to come from the main frame of the
 * shell's one window, and that frame has to show the app's own page.
 * @param {{url?: string, isMainFrame?: boolean, isAppWindow?: boolean}} sender
 */
export function senderAllowed(sender) {
  if (!sender || sender.isMainFrame !== true || sender.isAppWindow !== true) return false;
  let parsed;
  try {
    parsed = new URL(String(sender.url || ''));
  } catch {
    return false;
  }
  return parsed.protocol === APP_PROTOCOL && parsed.hostname === APP_HOST;
}

const fail = (error) => ({ ok: false, error });
const pass = (value) => ({ ok: true, value });

/** No payload at all. */
function nothing(payload) {
  return payload === undefined || payload === null ? pass(undefined) : fail('no payload expected');
}

/** One line of text of at most `max` characters, without control characters. */
function text(max, { empty = false } = {}) {
  return (value) => {
    if (typeof value !== 'string') return fail('not a string');
    if (value.length > max) return fail(`longer than ${max}`);
    if (!empty && !value.trim()) return fail('empty');
    if (/[\u0000-\u001f\u007f]/.test(value)) return fail('control character');
    return pass(value);
  };
}

function oneOf(values) {
  return (value) => (values.includes(value) ? pass(value) : fail('not an allowed value'));
}

function bool(value) {
  return typeof value === 'boolean' ? pass(value) : fail('not a boolean');
}

function number(min, max) {
  return (value) => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? pass(value) : fail('not a number in range'));
}

function listOf(item, max) {
  return (value) => {
    if (!Array.isArray(value) || value.length > max) return fail('not a list of the allowed length');
    const out = [];
    for (const entry of value) {
      const r = item(entry);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return pass(out);
  };
}

/** A plain object with exactly these fields; each field has its own validator. */
function shape(fields, optional = []) {
  return (payload) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return fail('not an object');
    if (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null) return fail('not a plain object');
    for (const key of Object.keys(payload)) {
      if (!Object.hasOwn(fields, key)) return fail(`unknown field ${key}`);
    }
    const value = {};
    for (const [key, check] of Object.entries(fields)) {
      if (!Object.hasOwn(payload, key)) {
        if (optional.includes(key)) continue;
        return fail(`missing field ${key}`);
      }
      const r = check(payload[key]);
      if (!r.ok) return fail(`${key}: ${r.error}`);
      value[key] = r.value;
    }
    return pass(value);
  };
}

const check = shape({
  name: text(60),
  ok: bool,
  detail: text(400, { empty: true }),
});

/**
 * kind: 'invoke' page to main, answered; 'send' page to main, one way;
 *       'event' main to page.
 * selftest: registered only when the app runs with --selftest.
 */
export const CHANNELS = Object.freeze({
  // Start the bundled sample: answers { url } (a media-scheme address with an opaque token), or
  // { missing: true } in a build without the clip.
  'sample:open': { kind: 'invoke', validate: nothing },
  // Show the native open dialog: answers { url, audioWarning } or { canceled: true }. The page never sees a path.
  'film:open': { kind: 'invoke', validate: nothing },
  // Show one system notification: answers { supported, shown, reason }.
  'notify:show': { kind: 'invoke', validate: shape({ title: text(80), body: text(240) }) },
  // Ask where to save the diagnostic report and write it: answers { saved, reason }.
  'report:save': { kind: 'invoke', validate: nothing },
  // "Test the microphone" was pressed: the main process lets the page's next request for the
  // microphone through, that one only, and for a few seconds only (main/permissions.js).
  'mic:arm': { kind: 'invoke', validate: nothing },
  // One line for the shell's own log (what was pressed, what the speech bus did). Never a file name.
  'log:write': { kind: 'send', validate: shape({ line: text(300) }) },
  // Keeps the native menu in step: a dialog is open (listening items are off), which channel reads descriptions.
  'ui:state': { kind: 'send', validate: shape({ modal: bool, channel: oneOf(['app', 'reader']) }) },
  // A menu item was chosen (or its accelerator pressed).
  'menu:action': { kind: 'event', validate: shape({ action: oneOf([...ACTION_IDS, ...MENU_COMMANDS]) }) },
  // "Save diagnostic report" was chosen in the menu. The main process saves it by itself, so a
  // report can be had from a page that no longer answers; this tells the page how it went.
  'report:result': { kind: 'event', validate: shape({ saved: bool, reason: text(120, { empty: true }) }) },
  // A native menu, or a native dialog (Open, Save, a message box), opened (open: true) or closed:
  // the screen reader is reading it, so the page's own voice has to be silent meanwhile.
  'reader:busy': { kind: 'event', validate: shape({ cause: oneOf(['menu', 'dialog']), open: bool }) },

  // Self-test only.
  'selftest:input': {
    kind: 'invoke',
    selftest: true,
    validate: shape({ keyCode: text(20), modifiers: listOf(oneOf(['shift', 'control', 'alt', 'meta']), 4), char: text(4) }, ['modifiers', 'char']),
  },
  'selftest:menu': { kind: 'invoke', selftest: true, validate: shape({ id: text(40) }) },
  'selftest:dialog': { kind: 'invoke', selftest: true, validate: shape({ ms: number(0, 5000) }) },
  'selftest:zoom': { kind: 'invoke', selftest: true, validate: shape({ factor: number(0.5, 3) }) },
  'selftest:shot': { kind: 'invoke', selftest: true, validate: shape({ name: text(30) }) },
  'selftest:emulate': { kind: 'invoke', selftest: true, validate: shape({ forcedColors: bool }) },
  'selftest:ax': { kind: 'invoke', selftest: true, validate: nothing },
  'selftest:done': {
    kind: 'send',
    selftest: true,
    validate: shape({
      checks: listOf(check, 80),
      axe: shape({ ran: bool, violations: number(0, 9999), incomplete: number(0, 9999), passes: number(0, 9999), detail: text(2000, { empty: true }) }),
      info: text(2000, { empty: true }),
    }),
  },
});

/** Channel names of one kind, self-test channels only when asked for. */
export function channelsOfKind(kind, { selftest = false } = {}) {
  return Object.keys(CHANNELS).filter((name) => CHANNELS[name].kind === kind && (selftest || !CHANNELS[name].selftest));
}

/**
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function validatePayload(channel, payload) {
  const spec = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : null;
  if (!spec) return fail(`unknown channel ${String(channel)}`);
  const result = spec.validate(payload);
  return result.ok ? result : fail(`${channel}: ${result.error}`);
}
