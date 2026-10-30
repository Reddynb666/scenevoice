// Descriptions from frames, with whichever model the user chose for the site.
// Runs in the offscreen worker; unit tests drive it with a fake fetch.
//
// A provider here is how to send a provider-neutral prompt (frames.js) and get
// its text back. Everything else, from reading the JSON to checking times and
// saying what is uncertain, is shared with descriptions made from a video link.

import { ApiError } from './errors.js';
import { framesAskPrompt, framesRevisionPrompt, framesScriptPrompt } from './frames.js';
import { GeminiClient, buildFramesRequest, parseAnswer, responseText } from './gemini.js';
import { ensureModel } from './generation.js';
import { QwenClient, buildQwenRequest, qwenResponseText } from './qwen.js';
import { correctedCue } from './revision.js';
import { extractJson, normalizeChunk } from './script.js';

const ADAPTERS = {
  gemini: {
    createClient: (config, fetchImpl) => new GeminiClient({ ...config, fetchImpl }),
    async complete(client, prompt, signal, retries) {
      await ensureModel(client);
      const body = await client.generate(buildFramesRequest({ ...prompt, model: client.model }), signal, { retries });
      return responseText(body);
    },
  },
  qwen: {
    createClient: (config, fetchImpl) => new QwenClient({ ...config, fetchImpl }),
    async complete(client, prompt, signal, retries) {
      const body = await client.chat(buildQwenRequest({ ...prompt, model: client.model, jsonMode: client.jsonMode }), signal, { retries });
      return qwenResponseText(body);
    },
  },
};

function adapter(provider) {
  const a = ADAPTERS[provider];
  if (!a) throw new ApiError('provider-unsupported', String(provider));
  return a;
}

/** A client for a provider, from what the service worker sends (key, address, model). */
export function createClient(provider, config, fetchImpl) {
  return adapter(provider).createClient(config || {}, fetchImpl);
}

function readJson({ text, finishReason }) {
  try {
    return extractJson(text);
  } catch {
    throw new ApiError(finishReason === 'MAX_TOKENS' ? 'truncated' : 'bad-json');
  }
}

/**
 * Describe one stretch of video from its frames.
 * @param {object} params  { meta, window: {start, end}, duration, lang, frames, characters, recent }
 * @returns {Promise<{cues: Array, characters: Array, videoType: string}>}
 */
export async function describeFrames(provider, client, params, signal) {
  const reply = await adapter(provider).complete(client, framesScriptPrompt(params), signal, 1);
  return normalizeChunk(readJson(reply), { duration: params.duration, chunkStart: params.window.start, chunkEnd: params.window.end, lang: params.lang });
}

/** Answer a question from frames. Resolves to { text, time, confidence }, like a question about a video link. */
export async function askFrames(provider, client, params, signal) {
  const reply = await adapter(provider).complete(client, framesAskPrompt(params), signal, 1);
  return parseAnswer(reply.text, params);
}

/**
 * Describe again, from frames around it, a moment whose description was marked
 * as wrong. Resolves to the corrected cue, or null when there is nothing to describe.
 */
export async function reviseFrames(provider, client, params, signal) {
  const { cue, duration, lang, frames } = params;
  const reply = await adapter(provider).complete(client, framesRevisionPrompt(params), signal, 2);
  const times = frames.map((f) => f.time);
  const span = { start: Math.max(0, Math.min(cue.start, ...times) - 2), end: Math.max(cue.start, ...times) + 2 };
  const { cues } = normalizeChunk(readJson(reply), { duration, chunkStart: span.start, chunkEnd: span.end, lang });
  return correctedCue(cue, cues, lang);
}
