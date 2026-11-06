// Description generation, independent of where it runs. The offscreen worker
// drives this; unit tests drive it with a fake client.
//
// A video is described in sections (CHUNK_SECONDS each). After every section the
// merged script is handed to onChunk so the caller can save it: a lost connection
// or a closed browser costs at most one section, and a later run resumes from
// script.completedUntil.

import { CHUNK_SECONDS, SCRIPT_VERSION } from './constants.js';
import { mergeScript, normalizeChunk, planChunks } from './script.js';
import { correctedCue } from './revision.js';
import { recentCues } from './coverage.js';
import {
  GeminiError,
  PREVIOUS_CUES,
  buildAskRequest,
  buildRevisionRequest,
  buildScriptRequest,
  chooseModel,
  parseAskResponse,
  parseScriptResponse,
  revisionClip,
  usageOf,
} from './gemini.js';
import { EMPTY_USAGE, addUsage } from './usage.js';

/** Make sure the client has a model; pick one from the key's list when it has none. */
export async function ensureModel(client) {
  if (client.model) return false;
  const model = chooseModel(await client.listModels());
  if (!model) throw new GeminiError('no-model');
  client.model = model;
  return true;
}

/**
 * The model family a model id belongs to, for quotas: the id without a dated
 * snapshot, preview or "latest" suffix. gemini-2.5-flash-001 shares a quota
 * with gemini-2.5-flash; gemini-2.5-flash-lite has its own.
 */
export const modelFamily = (id) => String(id || '').replace(/-(latest|preview.*|exp.*|\d{3,}.*)$/, '');

/**
 * Switch the client to the best model that has not been tried yet.
 * Used when the chosen model is missing for this key, stays overloaded, or
 * has no quota left today (then `otherFamily` keeps its own family out too:
 * a snapshot of the same model shares the used-up quota).
 * Returns the new model id, or '' when there is none left.
 */
export async function switchModel(client, tried, { otherFamily = false } = {}) {
  const family = modelFamily(client.model);
  const models = (await client.listModels()).filter((m) => {
    const id = String(m.name || '').replace(/^models\//, '');
    return !tried.has(id) && !(otherFamily && modelFamily(id) === family);
  });
  const next = chooseModel(models);
  if (!next) return '';
  client.model = next;
  return next;
}

/**
 * Attach what was spent before `err` ended a request to the error, on top of
 * what it already carries, so the caller can still count it: a reply that was
 * cut off or unreadable is billed like any other. Nothing is attached when
 * nothing was billed (the request never got an answer).
 */
function withUsage(err, usage) {
  const total = addUsage(usage, err?.usage);
  if (total.requests && err && typeof err === 'object') err.usage = total;
  return err;
}

/** One section's descriptions, with what the request(s) cost: { cues, characters, videoType, usage }. */
async function generateChunk(client, req, chunk, signal, depth = 0) {
  let usage = EMPTY_USAGE;
  try {
    const body = await client.generate(buildScriptRequest({ ...req, chunk, model: client.model }), signal);
    usage = usageOf(body);
    const raw = parseScriptResponse(body);
    return { ...normalizeChunk(raw, { duration: req.duration, chunkStart: chunk.start, chunkEnd: chunk.end, lang: req.lang }), usage };
  } catch (err) {
    // What the failed reply cost goes with the halves, or with the error.
    const spent = addUsage(usage, err?.usage);
    // Output cut off or malformed, or the section did not come back before the
    // deadline: split it in two and try again. Retrying the same long section
    // is what turns a slow first request into "no descriptions".
    if (err instanceof GeminiError && ['truncated', 'bad-json', 'too-long', 'timeout'].includes(err.code) && depth < 2 && chunk.end - chunk.start > 90) {
      const mid = Math.round((chunk.start + chunk.end) / 2);
      let a;
      try {
        a = await generateChunk(client, req, { start: chunk.start, end: mid }, signal, depth + 1);
      } catch (e) {
        throw withUsage(e, spent);
      }
      let b;
      try {
        b = await generateChunk(client, { ...req, characters: [...req.characters, ...a.characters] }, { start: mid, end: chunk.end }, signal, depth + 1);
      } catch (e) {
        throw withUsage(e, addUsage(spent, a.usage));
      }
      return { cues: [...a.cues, ...b.cues], characters: [...a.characters, ...b.characters], videoType: a.videoType || b.videoType, usage: addUsage(addUsage(spent, a.usage), b.usage) };
    }
    throw withUsage(err, usage);
  }
}

/** Errors that another model may not have: missing for this key, or overloaded right now. */
const SWITCHABLE = new Set(['model-not-found', 'server']);
const MAX_MODEL_SWITCHES = 2;

/**
 * Generate, or resume, the script for one video.
 *
 * @param {object} o
 * @param {import('./gemini.js').GeminiClient} o.client
 * @param {object|null} o.script  the saved script to resume from, or null
 * @param {AbortSignal} [o.signal]
 * @param {(script: object, info: {done: number, total: number, usage?: object, seconds?: number}) => (void|Promise<void>)} [o.onChunk]
 *   called after every section with the merged script (script.usage is the running total; info.usage
 *   and info.seconds are this section's own); the last call has script.complete = true
 * @param {(model: string, reason: string) => void} [o.onModel]  called when a different model takes over
 * @returns {Promise<object>} the complete script
 */
export async function runGeneration({ client, videoId, duration, meta, lang, script, signal, onChunk, onModel }) {
  await ensureModel(client);
  let current = script && !script.complete ? script : null;
  if (script?.complete) return script;
  if (!current) {
    current = { version: SCRIPT_VERSION, videoId, lang, duration, cues: [], characters: [], completedUntil: 0, complete: false, model: client.model, createdAt: Date.now() };
  }
  const chunks = planChunks(duration, CHUNK_SECONDS, current.completedUntil || 0);
  // Sections are counted over the whole video, so a resumed run reports "3 of 4", not "1 of 2".
  const before = Math.ceil((current.completedUntil || 0) / CHUNK_SECONDS);
  const total = before + chunks.length;
  if (!chunks.length) {
    current = { ...current, complete: true, updatedAt: Date.now() };
    await onChunk?.(current, { done: total, total });
    return current;
  }
  const tried = new Set([client.model]);
  // A used-up daily quota moves to another model family once; a second one is where it stops.
  let quotaSwitched = false;
  // What a failed attempt at a section cost (a model switched away from): counted with the next section, or with the error.
  let pending = EMPTY_USAGE;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let part;
    try {
      // The last descriptions of the section before go along, so this one neither repeats them nor opens the video again.
      part = await generateChunk(client, { videoId, meta, duration, lang, characters: current.characters, previous: recentCues(current, chunk.start, { seconds: CHUNK_SECONDS, max: PREVIOUS_CUES }) }, chunk, signal);
    } catch (err) {
      // The model is gone for this key, has been overloaded through all retries, or
      // has no quota left today: carry on with the next best model rather than giving up.
      const daily = err instanceof GeminiError && err.code === 'quota-daily' && !quotaSwitched;
      if (daily || (err instanceof GeminiError && SWITCHABLE.has(err.code) && tried.size <= MAX_MODEL_SWITCHES)) {
        const next = await switchModel(client, tried, { otherFamily: daily }).catch(() => '');
        if (next) {
          if (daily) quotaSwitched = true;
          tried.add(next);
          onModel?.(next, err.code);
          pending = addUsage(pending, err.usage);
          i -= 1;
          continue;
        }
      }
      throw withUsage(err, pending);
    }
    if (signal?.aborted) throw withUsage(new GeminiError('aborted'), addUsage(pending, part.usage));
    const { usage: own, ...descriptions } = part;
    const usage = addUsage(pending, own);
    pending = EMPTY_USAGE;
    current = mergeScript(current, descriptions, chunk.end);
    current.usage = addUsage(current.usage, usage);
    current.model = client.model;
    current.complete = i === chunks.length - 1;
    await onChunk?.(current, { done: before + i + 1, total, usage, seconds: chunk.end - chunk.start });
  }
  return current;
}

/**
 * Ask the model about one moment. Resolves to { text, time, confidence, usage }:
 * the answer, led by the moment it is about, that moment in seconds, and what
 * the request cost.
 */
export async function runAsk(client, params, signal) {
  await ensureModel(client);
  const body = await client.generate(buildAskRequest({ ...params, model: client.model }), signal, { retries: 1 });
  return { ...parseAskResponse(body, params), usage: usageOf(body) };
}

/**
 * Describe again the moment of a description the user marked as wrong.
 * Resolves to { cue, usage }: the corrected cue (at the old cue's time), or
 * null when, looking again, there is nothing there worth describing, and what
 * the request cost.
 * @param {object} params  { videoId, meta, duration, lang, cue, characters }
 */
export async function runRevision(client, params, signal) {
  await ensureModel(client);
  const { cue, duration, lang } = params;
  const body = await client.generate(buildRevisionRequest({ ...params, model: client.model }), signal, { retries: 2 });
  const span = revisionClip(cue.start, duration);
  let raw;
  try {
    raw = parseScriptResponse(body);
  } catch (err) {
    throw withUsage(err, usageOf(body));
  }
  const { cues } = normalizeChunk(raw, { duration, chunkStart: span.start, chunkEnd: span.end, lang });
  return { cue: correctedCue(cue, cues, lang), usage: usageOf(body) };
}
