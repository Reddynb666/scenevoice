// Who is allowed to send which chrome.runtime message.
//
// Content scripts run in the YouTube renderer, so a compromised page process can
// call chrome.runtime.sendMessage. The service worker and the offscreen document
// must not trust the message body alone: Chrome fills in `sender`, and each
// message type is accepted only from the contexts that actually send it.
//
// Chrome leaves sender.url empty for a service worker today, and may later set
// it to the worker script (as Firefox does). Both shapes are recognised.

import { MSG } from './constants.js';

const SERVICE_WORKER_PATHS = new Set(['/background.js', '/']);

/** Hosts and paths the manifest injects the content script into. */
export function isYouTubeContentUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname === 'www.youtube.com' || parsed.hostname === 'm.youtube.com') return true;
  return parsed.hostname === 'www.youtube-nocookie.com' && parsed.pathname.startsWith('/embed/');
}

function extensionPath(url, extensionId) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'chrome-extension:' || parsed.hostname !== extensionId) return null;
  return parsed.pathname || '/';
}

/**
 * @returns {'external'|'rejected'|'service-worker'|'offscreen'|'extension-page'|'youtube-content'}
 */
export function classifySender(sender, extensionId) {
  if (!sender || typeof sender !== 'object') return 'external';
  if (typeof extensionId !== 'string' || !extensionId || sender.id !== extensionId) return 'external';

  const origin = `chrome-extension://${extensionId}`;
  const path = extensionPath(sender.url, extensionId);
  if (path != null) {
    if (sender.origin && sender.origin !== origin) return 'rejected';
    if (path === '/offscreen.html') return 'offscreen';
    if (SERVICE_WORKER_PATHS.has(path)) return 'service-worker';
    return 'extension-page';
  }

  // Service worker: no document, so Chrome leaves url empty (it may instead set
  // url to background.js, handled above). No other context has our id, no tab,
  // and no url. When origin is present it has to be the extension's.
  if (!sender.tab && !sender.url) {
    if (!sender.origin || sender.origin === origin) return 'service-worker';
    return 'rejected';
  }

  if (isYouTubeContentSender(sender)) return 'youtube-content';
  return 'rejected';
}

/** Content script on a YouTube tab, with sender.tab describing that same tab. */
function isYouTubeContentSender(sender) {
  const tab = sender.tab;
  if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return false;
  if (!isYouTubeContentUrl(sender.url)) return false;
  if (sender.origin) {
    try {
      if (sender.origin !== new URL(sender.url).origin) return false;
    } catch {
      return false;
    }
  }
  const frameId = sender.frameId == null ? 0 : sender.frameId;
  if (!Number.isInteger(frameId) || frameId < 0) return false;
  if (frameId !== 0) return true;
  // Top frame: the tab URL is the same YouTube document (hash and SPA path
  // can differ briefly; the origin cannot).
  if (tab.url) {
    if (!isYouTubeContentUrl(tab.url)) return false;
    try {
      if (new URL(tab.url).origin !== new URL(sender.url).origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Message types the service worker acts on, and the sender kinds allowed to use them. */
const BACKGROUND_ALLOW = Object.freeze({
  // YouTube tab, or the popup (it only needs to know whether a key exists).
  [MSG.GET_STATUS]: ['youtube-content', 'extension-page'],
  // Asked by the YouTube tab after the popup tells it to delete.
  [MSG.DELETE_SCRIPT]: ['youtube-content'],
  [MSG.GET_SCRIPT]: ['youtube-content'],
  [MSG.GEN_START]: ['youtube-content'],
  [MSG.GEN_STOP]: ['youtube-content'],
  [MSG.GEN_STATUS]: ['youtube-content'],
  [MSG.ASK]: ['youtube-content'],
  [MSG.OPEN_OPTIONS]: ['youtube-content'],
  [MSG.STOP_SPEAKING]: ['youtube-content'],
  // Spoken descriptions from the YouTube tab, and the options-page voice test.
  [MSG.SPEAK]: ['youtube-content', 'extension-page'],
  [MSG.GET_VOICES]: ['extension-page'],
  [MSG.CACHE_INFO]: ['extension-page'],
  [MSG.CACHE_CLEAR]: ['extension-page'],
  // Only the offscreen document forwards worker progress. Accepting this from a
  // content script would let the page write arbitrary description scripts.
  [MSG.JOB_EVENT]: ['offscreen'],
});

export function authorizeBackgroundMessage(type, sender, extensionId) {
  if (typeof type !== 'string') return false;
  const allow = BACKGROUND_ALLOW[type];
  if (!allow) return false;
  return allow.includes(classifySender(sender, extensionId));
}

/** Messages the YouTube content script may act on. */
export function authorizeContentMessage(type, sender, extensionId) {
  if (typeof type !== 'string') return false;
  const kind = classifySender(sender, extensionId);
  // Playback commands and generation progress come from the service worker.
  if (type === MSG.COMMAND || type === MSG.GEN_EVENT || type === MSG.TTS_EVENT) return kind === 'service-worker';
  // The popup asks the tab what to do. The service worker does too, when tests
  // (and chrome.commands' own delivery path) address the tab directly.
  if (type === MSG.TAB_STATE || type === MSG.TAB_ACTION) return kind === 'service-worker' || kind === 'extension-page';
  return false;
}

/** The offscreen document only takes job commands from the service worker. */
export function authorizeOffscreenMessage(type, sender, extensionId) {
  return type === MSG.OFFSCREEN && classifySender(sender, extensionId) === 'service-worker';
}
