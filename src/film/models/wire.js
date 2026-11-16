// Requests for any model in the catalog, and one call with a deadline and
// retries of its own. Two protocols cover every provider: OpenAI-style chat
// completions (Qwen, Doubao, DeepSeek, OpenRouter, Ollama…) and Gemini's
// generateContent. The network clients are the extension's own (QwenClient and
// GeminiClient in src/shared), used as they are with their own retries switched
// off, so there is one retry policy, here, and not two multiplied together.
// The extension's adapter layer (describe.js) is not used: it is tied to the
// extension's prompts and to a parser that drops the fields a film needs.

import { ApiError } from '../../shared/errors.js';
import { responseText, tuningFor, usageOf } from '../../shared/gemini.js';
import { qwenResponseText, qwenUsageOf } from '../../shared/qwen.js';
import { extractJson } from '../../shared/script.js';

/** Errors that may pass if the same request is simply sent again. */
const RETRYABLE = ['network', 'server', 'timeout'];
/** The wait before the first retry; it doubles each time. */
const RETRY_BASE_MS = 2000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The frames of a prompt that carry a picture. */
const framesOf = (prompt) => (Array.isArray(prompt.frames) ? prompt.frames : []).filter((f) => f && typeof f.data === 'string' && f.data);

/**
 * The instructions with the answer format in words after them. The words go
 * to every model, also to one held to a schema: the schema says which fields,
 * the words say what belongs in them.
 */
const instructionsOf = (prompt) => [prompt.system, prompt.jsonShape].filter((s) => typeof s === 'string' && s).join('\n\n');

/**
 * How an OpenAI-style endpoint is asked for JSON, by the strongest mode the model has.
 * The schema is sent as a guide, not in strict mode: strict mode refuses a
 * schema that has optional properties or lacks additionalProperties: false
 * (the film's schemas have both), with a 400 that is not tried again. The
 * caller checks the answer against the schema (json.js check).
 */
function responseFormat(model, prompt) {
  if (model.json === 'schema' && isObject(prompt.schema)) {
    // The name may hold letters, digits, "_" and "-" only.
    const name = String(prompt.kind || 'answer').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    return { type: 'json_schema', json_schema: { name, schema: prompt.schema } };
  }
  if (model.json === 'schema' || model.json === 'object') return { type: 'json_object' };
  return null;
}

function openaiBody(model, prompt, frames) {
  const text = String(prompt.text ?? '');
  // Without pictures the content is a plain string: text-only endpoints (DeepSeek among
  // them) have refused a list of parts, and every endpoint takes a string.
  let content = text;
  if (frames.length) {
    content = [];
    for (const f of frames) {
      if (f.label) content.push({ type: 'text', text: String(f.label) });
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.data}` } });
    }
    content.push({ type: 'text', text });
  }
  const system = instructionsOf(prompt);
  const body = {
    model: model.id,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }],
  };
  if (Number.isFinite(prompt.temperature)) body.temperature = prompt.temperature;
  if (Number.isFinite(prompt.maxTokens)) body[model.maxTokensField || 'max_tokens'] = prompt.maxTokens;
  const format = responseFormat(model, prompt);
  if (format) body.response_format = format;
  return body;
}

/** Keywords Gemini's responseSchema takes as they are. */
const GEMINI_KEYWORDS = ['description', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems'];

/**
 * A JSON schema in the dialect of Gemini's responseSchema (the one the
 * extension's own schemas are written in): type names in upper case, a list of
 * types with null as `nullable`, the order of the properties spelled out so the
 * answer is written in the order the schema's author chose. Keywords it does
 * not know are left out, `additionalProperties` among them, and a numeric enum
 * becomes a range (its enum holds strings only). The answer is checked against
 * the full schema afterwards (json.js), so nothing is lost by asking for less.
 */
function geminiSchema(schema) {
  if (!isObject(schema)) return {};
  const out = {};
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((name) => typeof name === 'string').map((name) => name.toLowerCase());
  const real = types.filter((name) => name !== 'null');
  if (real.length) out.type = real[0].toUpperCase();
  else if (types.length) out.type = 'NULL';
  if (real.length && types.includes('null')) out.nullable = true;
  for (const key of GEMINI_KEYWORDS) if (schema[key] !== undefined) out[key] = schema[key];
  if (Array.isArray(schema.enum) && schema.enum.length) {
    if (schema.enum.every((v) => typeof v === 'string')) out.enum = [...schema.enum];
    else if (schema.enum.every((v) => typeof v === 'number')) {
      if (out.minimum === undefined) out.minimum = Math.min(...schema.enum);
      if (out.maximum === undefined) out.maximum = Math.max(...schema.enum);
    }
  }
  if (isObject(schema.properties)) {
    const keys = Object.keys(schema.properties);
    out.properties = Object.fromEntries(keys.map((key) => [key, geminiSchema(schema.properties[key])]));
    // A required name that is not a property is refused with the whole request.
    if (Array.isArray(schema.required)) out.required = schema.required.filter((key) => keys.includes(key));
    out.propertyOrdering = Array.isArray(schema.propertyOrdering) ? schema.propertyOrdering.filter((key) => keys.includes(key)) : keys;
  }
  if (isObject(schema.items)) out.items = geminiSchema(schema.items);
  return out;
}

function geminiBody(model, prompt, frames) {
  const parts = [];
  for (const f of frames) {
    if (f.label) parts.push({ text: String(f.label) });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.data } });
  }
  parts.push({ text: String(prompt.text ?? '') });
  // tuningFor is the extension's knowledge of the Gemini families: Gemini 3 keeps its own
  // temperature and thinks little (thoughts are paid for out of the output limit).
  const generationConfig = { ...tuningFor(model.id, prompt.temperature) };
  if (Number.isFinite(prompt.maxTokens)) generationConfig.maxOutputTokens = prompt.maxTokens;
  if (model.json !== 'prompt') generationConfig.responseMimeType = 'application/json';
  if (model.json === 'schema' && isObject(prompt.schema)) generationConfig.responseSchema = geminiSchema(prompt.schema);
  const system = instructionsOf(prompt);
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
}

/**
 * The request body for a prompt, in the model's protocol.
 *
 * 'openai' (chat completions): a system message (the instructions, then the
 * answer format in words), and a user message with, for each frame, its label
 * and the picture as a base64 data URL, then the request text; a plain string
 * when there are no frames. `response_format` follows model.json: 'schema'
 * with a schema in the prompt asks for that schema (as a guide, not in strict
 * mode: the caller checks the answer with json.js check); 'object', or
 * 'schema' without one, asks for a JSON object; 'prompt' sends none. The output
 * limit goes under model.maxTokensField.
 *
 * 'gemini' (generateContent): systemInstruction, one user turn with inlineData
 * parts, and a generationConfig with the output limit, a JSON answer (unless
 * model.json is 'prompt') and, for 'schema' with a schema in the prompt, a
 * responseSchema in Gemini's dialect. Temperature and thinking follow the
 * extension's tuningFor: a Gemini 3 model is not sent a temperature.
 *
 * @param {object} model   an entry of the catalog (catalog.js)
 * @param {{kind?: string, system?: string, jsonShape?: string, frames?: Array<{time?: number, data: string, label?: string}>,
 *   text?: string, maxTokens?: number, temperature?: number, schema?: object}} prompt
 * @returns {{wire: 'openai'|'gemini', body: object}}
 * @throws {ApiError} 'no-model' without a model; 'provider-unsupported' when frames are given to a
 *   model that takes no pictures, or the wire is unknown; 'too-long' for more frames than model.maxImages
 */
export function buildRequest(model, prompt) {
  if (!isObject(model) || typeof model.id !== 'string' || !model.id) throw new ApiError('no-model');
  const p = isObject(prompt) ? prompt : {};
  const frames = framesOf(p);
  if (frames.length && !(Array.isArray(model.input) && model.input.includes('image'))) {
    throw new ApiError('provider-unsupported', `${model.id} takes no pictures`);
  }
  if (typeof model.maxImages === 'number' && frames.length > model.maxImages) {
    throw new ApiError('too-long', `${frames.length} frames, ${model.id} takes ${model.maxImages}`);
  }
  if (model.wire === 'openai') return { wire: 'openai', body: openaiBody(model, p, frames) };
  if (model.wire === 'gemini') return { wire: 'gemini', body: geminiBody(model, p, frames) };
  throw new ApiError('provider-unsupported', `unknown wire: ${String(model.wire)}`);
}

/**
 * The address to build the shared client with: QwenClient takes the model's
 * base as it is, GeminiClient adds "/v1beta" itself and so takes the base
 * without it.
 * @param {{wire: string, base: string}} model
 * @returns {string}
 */
export function clientBase(model) {
  const base = String(model?.base || '').replace(/\/+$/, '');
  return model?.wire === 'gemini' ? base.replace(/\/v1beta$/, '') : base;
}

/** Our own deadline, marked the way gemini.js marks its own: the request was cut here, not refused there. */
function deadlineError(timeoutMs) {
  const err = new ApiError('timeout', `no answer within ${timeoutMs} ms`);
  err.clientDeadline = true;
  return err;
}

/**
 * One request with a controller of its own, aborted by the deadline or by the
 * caller. Settles the moment either happens, without waiting for the client to
 * notice its signal: a client that never does must not hold the film up.
 */
function attempt(send, { signal, timeoutMs, setTimer, clearTimer }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timed = Number.isFinite(timeoutMs) && timeoutMs > 0;
    let settled = false;
    let timer;
    const onAbort = () => stop(new ApiError('aborted'));
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timed) clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      settle(value);
    };
    // Settled first, aborted second: the client answers the abort with an error of its
    // own ('aborted', whoever pulled the plug), which must not be the one reported.
    function stop(err) {
      finish(reject, err);
      controller.abort();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timed) timer = setTimer(() => stop(deadlineError(timeoutMs)), timeoutMs);
    let call;
    try {
      call = send(controller.signal);
    } catch (err) {
      finish(reject, err);
      return;
    }
    Promise.resolve(call).then(
      (reply) => finish(resolve, reply),
      (err) => finish(reject, err),
    );
  });
}

/** The default wait between attempts. The timer is dropped when the caller aborts, so nothing lingers. */
const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Waits, unless the caller aborts first: then it throws at once, whatever the sleep does with its signal. */
async function pause(sleep, ms, signal) {
  if (!signal) {
    await sleep(ms);
    return;
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new ApiError('aborted'));
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([sleep(ms, signal), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Sends a prompt to a model and returns its answer.
 *
 * One request per attempt, each with its own AbortController and its own
 * deadline. The client's own retries are off: 'openai' calls
 * client.chat(body, signal, { retries: 0 }), 'gemini' calls
 * client.generate(body, signal, { retries: 0, timeoutMs: 0 }) (its own deadline
 * off too, so the one here is the only one). A deadline, or an ApiError
 * 'network', 'server' or 'timeout', is tried again up to `retries` times after
 * 2 s, 4 s, 8 s…; anything else is thrown as it came, a rate limit included
 * (the caller decides how long a film may wait for one). When the caller
 * aborts, ApiError('aborted') is thrown at once, in a request or between two.
 *
 * @param {object} client  a QwenClient (for wire 'openai') or a GeminiClient (for 'gemini') from
 *   src/shared, made for this model: its address from clientBase(model) and, for Gemini, its model id
 * @param {object} model   an entry of the catalog
 * @param {object} prompt  see buildRequest
 * @param {object} [o]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]   the deadline of each attempt; 0 for none
 * @param {number} [o.retries]     attempts after the first
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [o.sleep]  the wait between attempts (setTimeout by default)
 * @param {(fn: () => void, ms: number) => *} [o.setTimer]   the deadline's timer (setTimeout by default)
 * @param {(timer: *) => void} [o.clearTimer]
 * @returns {Promise<{text: string, usage: {input: number, output: number, thinking: number, requests: number}, finishReason: string}>}
 *   finishReason is 'MAX_TOKENS' when the answer was cut at the output limit, on either wire.
 * @throws {ApiError} whatever buildRequest throws; 'aborted'; 'timeout' when the last attempt met its deadline;
 *   and the client's and the reply parsers' own errors ('bad-key', 'blocked', 'truncated', 'empty-response'…)
 */
export async function complete(client, model, prompt, { signal, timeoutMs = 120000, retries = 2, sleep = defaultSleep, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (timer) => clearTimeout(timer) } = {}) {
  const { wire, body } = buildRequest(model, prompt);
  const send = wire === 'gemini'
    ? (attemptSignal) => client.generate(body, attemptSignal, { retries: 0, timeoutMs: 0 })
    : (attemptSignal) => client.chat(body, attemptSignal, { retries: 0 });
  const limit = Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0;
  for (let n = 0; ; n += 1) {
    if (signal?.aborted) throw new ApiError('aborted');
    try {
      const reply = await attempt(send, { signal, timeoutMs, setTimer, clearTimer });
      const { text, finishReason } = wire === 'gemini' ? responseText(reply) : qwenResponseText(reply);
      return { text, usage: wire === 'gemini' ? usageOf(reply) : qwenUsageOf(reply), finishReason };
    } catch (err) {
      if (signal?.aborted) throw new ApiError('aborted');
      if (!(err instanceof ApiError) || !RETRYABLE.includes(err.code) || n >= limit) throw err;
    }
    await pause(sleep, RETRY_BASE_MS * 2 ** n, signal);
  }
}

/**
 * The JSON in a model's reply: bare, in a code fence, or with words around it
 * (shared/script.js extractJson). Whether it has the right shape is json.js's
 * question, not this one's.
 * @param {string|object} text  the reply; an object already parsed is returned as it is
 * @returns {object}  an object or an array
 * @throws {ApiError} 'bad-json' when there is none, or it is a bare number, string, boolean or null
 */
export function readJson(text) {
  let value;
  try {
    value = extractJson(text);
  } catch {
    throw new ApiError('bad-json');
  }
  if (value === null || typeof value !== 'object') throw new ApiError('bad-json');
  return value;
}
