// The YouTube tab's side of description generation.
//
// The work itself runs in a worker inside the extension's offscreen document
// (see offscreen/worker.js): a YouTube page may not reach the Gemini API under
// the page's own policies, and the API key never has to enter the page. This
// module only asks the service worker to start, stop or report a job; progress
// arrives as MSG.GEN_EVENT messages, handled in index.js.

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

/** Ask the model about one moment. Resolves to { text } or { error, detail }. */
export function askAboutMoment(send, params) {
  return send({ type: MSG.ASK, params });
}
