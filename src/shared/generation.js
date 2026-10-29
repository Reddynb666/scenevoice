// Description generation, independent of where it runs. The offscreen worker
// drives this; unit tests drive it with a fake client.
//
// A video is described in sections (CHUNK_SECONDS each). After every section the
// merged script is handed to onChunk so the caller can save it: a lost connection
// or a closed browser costs at most one section, and a later run resumes from
// script.completedUntil.

import { CHUNK_SECONDS, SCRIPT_VERSION } from './constants.js';
import { mergeScript, normalizeChunk, planChunks } from './script.js';
import { GeminiError, buildAskRequest, buildScriptRequest, chooseModel, parseScriptResponse, responseText } from './gemini.js';

/** Make sure the client has a model; pick one from the key's list when it has none. */
export async function ensureModel(client) {
  if (client.model) return false;
  const model = chooseModel(await client.listModels());
  if (!model) throw new GeminiError('no-model');
  client.model = model;
  return true;
}

/**
 * Switch the client to the best model that has not been tried yet.
 * Used when the chosen model is missing for this key or stays overloaded.
 * Returns the new model id, or '' when there is none left.
 */
export async function switchModel(client, tried) {
  const models = (await client.listModels()).filter((m) => !tried.has(String(m.name || '').replace(/^models\//, '')));
  const next = chooseModel(models);
  if (!next) return '';
  client.model = next;
  return next;
}

async function generateChunk(client, req, chunk, signal, depth = 0) {
  try {
    const body = await client.generate(buildScriptRequest({ ...req, chunk, model: client.model }), signal);
    const raw = parseScriptResponse(body);
    return normalizeChunk(raw, { duration: req.duration, chunkStart: chunk.start, chunkEnd: chunk.end });
  } catch (err) {
    // Output cut off or malformed: split the section in two and try again.
    if (err instanceof GeminiError && ['truncated', 'bad-json', 'too-long'].includes(err.code) && depth < 2 && chunk.end - chunk.start > 90) {
      const mid = Math.round((chunk.start + chunk.end) / 2);
      const a = await generateChunk(client, req, { start: chunk.start, end: mid }, signal, depth + 1);
      const b = await generateChunk(client, { ...req, characters: [...req.characters, ...a.characters] }, { start: mid, end: chunk.end }, signal, depth + 1);
      return { cues: [...a.cues, ...b.cues], characters: [...a.characters, ...b.characters] };
    }
    throw err;
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
 * @param {(script: object, info: {done: number, total: number}) => (void|Promise<void>)} [o.onChunk]
 *   called after every section with the merged script; the last call has script.complete = true
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
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let part;
    try {
      part = await generateChunk(client, { videoId, meta, duration, lang, characters: current.characters }, chunk, signal);
    } catch (err) {
      // The model is gone for this key, or has been overloaded through all retries:
      // carry on with the next best model rather than giving up.
      if (err instanceof GeminiError && SWITCHABLE.has(err.code) && tried.size <= MAX_MODEL_SWITCHES) {
        const next = await switchModel(client, tried).catch(() => '');
        if (next) {
          tried.add(next);
          onModel?.(next, err.code);
          i -= 1;
          continue;
        }
      }
      throw err;
    }
    if (signal?.aborted) throw new GeminiError('aborted');
    current = mergeScript(current, part, chunk.end);
    current.model = client.model;
    current.complete = i === chunks.length - 1;
    await onChunk?.(current, { done: before + i + 1, total });
  }
  return current;
}

/** Ask the model about one moment. Resolves to the answer text. */
export async function runAsk(client, params, signal) {
  await ensureModel(client);
  const body = await client.generate(buildAskRequest({ ...params, model: client.model }), signal, { retries: 1 });
  return responseText(body).text.trim();
}
