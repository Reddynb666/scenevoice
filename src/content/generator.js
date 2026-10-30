// The YouTube tab's side of description generation.
//
// The work itself runs in a worker inside the extension's offscreen document
// (see offscreen/worker.js): a YouTube page may not reach the Gemini API under
// the page's own policies, and the API key stays in the service worker. This
// module only asks the service worker to start, stop or report a job; progress
// arrives as MSG.GEN_EVENT messages, handled in index.js. Cached scripts are
// loaded the same way (MSG.GET_SCRIPT): content scripts cannot read
// chrome.storage.local, where the key and the cache are stored.

import { MSG } from '../shared/constants.js';

/**
 * Start (or join) the job for a video. Resolves to one of
 *   { error, detail }                                   nothing started
 *   { status: 'ready' }                                 the cache already holds the complete script
 *   { status: 'generating', done, total, chunkStartedAt, chunkMs, already }
 */
export function startGeneration(send, { videoId, duration, meta, lang, force }) {
  return send({ type: MSG.GEN_START, videoId, duration, meta, lang, force: Boolean(force) });
}

export function stopGeneration(send, { videoId, lang }) {
  return send({ type: MSG.GEN_STOP, videoId, lang });
}

export function generationStatus(send, { videoId, lang }) {
  return send({ type: MSG.GEN_STATUS, videoId, lang });
}

/** Ask the model about one moment. Resolves to { text, time, confidence } or { error, detail }. */
export function askAboutMoment(send, params) {
  return send({ type: MSG.ASK, params });
}

/**
 * A description the user marked as wrong: describe that moment again. The
 * service worker replaces it in the saved script. Resolves to
 * { status: 'revised', cue } | { status: 'removed' } | { error, detail }.
 * @param {object} params  { videoId, lang, cue: { start, kind, standard }, meta, duration }
 */
export function reviseDescription(send, params) {
  return send({ type: MSG.REVISE, ...params });
}
