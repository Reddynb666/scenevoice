// The one permission the shell ever grants: the microphone, to the page's own
// main frame, for the one request that follows a press of "Test the
// microphone" (the page asks the main process to arm it first, and the arming
// runs out by itself). Every other permission request is refused.
// Pure: no Electron.

import { senderAllowed } from '../ipc/contract.js';

/** How long after the button was pressed the page's request for the microphone is still let through. */
export const MIC_ARMED_MS = 15_000;

/**
 * Whether a permission request is the microphone test's own.
 * @param {object} o
 * @param {string} o.permission          what Chromium asks for ('media' for getUserMedia)
 * @param {string[]} [o.mediaTypes]      'audio' and/or 'video'
 * @param {string} [o.url]               the page that asks
 * @param {boolean} [o.isMainFrame]
 * @param {boolean} [o.isAppWindow]      the request comes from the shell's one window
 * @param {number} o.armedUntil          0 when the button was not pressed
 * @param {number} o.now
 */
export function microphoneRequestAllowed({ permission, mediaTypes, url, isMainFrame, isAppWindow, armedUntil, now }) {
  if (permission !== 'media') return false;
  // Sound alone: a request that also wants the camera is refused whole.
  if (!Array.isArray(mediaTypes) || mediaTypes.length !== 1 || mediaTypes[0] !== 'audio') return false;
  if (!(Number.isFinite(armedUntil) && now < armedUntil)) return false;
  return senderAllowed({ url, isMainFrame, isAppWindow });
}
