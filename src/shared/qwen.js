// Qwen (通义千问) vision models through Alibaba Cloud Model Studio (阿里云百炼,
// DashScope) in its OpenAI-compatible mode: POST {apiBase}/chat/completions with
// "Authorization: Bearer <key>". Request builders are pure functions; network
// calls take an injectable fetch.
//
// Checked against the Model Studio documentation on 2026-10-31 (see constants.js):
// the address, the default model, images as base64 data URLs in "image_url"
// parts and how many fit, and JSON mode (local setting qwenJsonMode, off by
// default). Still 待确认 until run with a real key: the error codes and messages
// classified in classifyQwenHttp.

import { DEFAULT_QWEN_API_BASE, DEFAULT_QWEN_MODEL } from './constants.js';
import { ApiError } from './errors.js';
import { countedUsage } from './usage.js';

/**
 * The chat completion request for a provider-neutral prompt (see frames.js):
 * the instructions and the answer format as the system message, then each
 * frame's label and picture, then the request itself.
 */
export function buildQwenRequest({ system, jsonShape, frames = [], text, maxTokens = 4096, temperature = 0.3, model, jsonMode = false }) {
  const content = [];
  for (const f of frames) {
    content.push({ type: 'text', text: f.label });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.data}` } });
  }
  content.push({ type: 'text', text });
  const body = {
    model,
    messages: [
      { role: 'system', content: jsonShape ? `${system}\n\n${jsonShape}` : system },
      { role: 'user', content },
    ],
    max_tokens: maxTokens,
    temperature,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/** Text of the first choice, with a clear error for filtered, cut-off or empty output. */
export function qwenResponseText(body) {
  const choice = body?.choices?.[0];
  if (!choice) throw new ApiError('empty-response');
  const content = choice.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('')
      : '';
  const finishReason = choice.finish_reason || '';
  if (finishReason === 'content_filter') throw new ApiError('blocked', finishReason);
  if (!text.trim()) {
    if (finishReason === 'length') throw new ApiError('truncated');
    throw new ApiError('empty-response', finishReason);
  }
  return { text, finishReason: finishReason === 'length' ? 'MAX_TOKENS' : finishReason };
}

/** What one reply cost, from its usage (zeros when the server sent none): see usage.js. */
export function qwenUsageOf(body) {
  const u = body?.usage || {};
  return countedUsage({ input: u.prompt_tokens, output: u.completion_tokens, thinking: u.completion_tokens_details?.reasoning_tokens });
}

/**
 * An HTTP error from the compatible-mode API, as one of SceneVoice's error
 * codes. Best effort (待确认). 429 means this minute's limit ('rate-limited',
 * retried) unless it says the day's quota is gone ('quota-daily'); no credit
 * left stays 'quota'. The SceneVoice Cloud relay refuses a used-up allowance
 * with code 'allowance'.
 */
export function classifyQwenHttp(status, body) {
  const err = body?.error && typeof body.error === 'object' ? body.error : body || {};
  const message = String(err.message || '');
  const code = String(err.code || err.type || '');
  const both = `${code} ${message}`;
  if (code === 'allowance') {
    const out = new ApiError('allowance', message, status);
    const at = err.resetsAt || err.resetAt;
    out.resetAt = typeof at === 'string' ? at : '';
    return out;
  }
  if (status === 401 || /invalid[_ ]?api[_ ]?key|InvalidApiKey|incorrect api key/i.test(both)) return new ApiError('bad-key', message, status);
  if (/data_inspection_failed|DataInspectionFailed|inappropriate content/i.test(both)) return new ApiError('blocked', message, status);
  if (/Arrearage|overdue|insufficient[_ ]?(quota|balance)|FreeTierOnly/i.test(both)) return new ApiError('quota', message, status);
  if (status === 403) return new ApiError('forbidden', message, status);
  if (status === 404 || /model[_ ]?not[_ ]?found|ModelNotFound|model .*(does not exist|not exist|not found)/i.test(both)) return new ApiError('model-not-found', message, status);
  if (status === 429) {
    if (/per.?day|daily/i.test(both)) return new ApiError('quota-daily', message, status);
    return new ApiError('rate-limited', message, status);
  }
  if (status === 400 && /(token|too long|exceed|maximum context|length)/i.test(message)) return new ApiError('too-long', message, status);
  if (status >= 500) return new ApiError('server', message, status);
  return new ApiError('request-failed', message || `HTTP ${status}`, status);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new ApiError('aborted'));
    });
  });

export class QwenClient {
  constructor({ apiKey, apiBase, model, jsonMode = false, fetchImpl } = {}) {
    this.apiKey = apiKey;
    this.apiBase = (apiBase || DEFAULT_QWEN_API_BASE).replace(/\/+$/, '');
    this.model = model || DEFAULT_QWEN_MODEL;
    this.jsonMode = Boolean(jsonMode);
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  /**
   * A chat completion with retries: overloaded servers and network failures
   * after 2 and 4 s, the minute's rate limit after 5 and 10 s. A used-up daily
   * quota or allowance is not retried. A request refused because of
   * response_format is sent again without it.
   */
  async chat(body, signal, { retries = 2 } = {}) {
    if (!body.model) throw new ApiError('no-model');
    const url = `${this.apiBase}/chat/completions`;
    let payload = body;
    let attempt = 0;
    for (;;) {
      try {
        return await this.request(url, { method: 'POST', body: JSON.stringify(payload) }, signal);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (payload.response_format && err.status === 400 && /response_format|json_object/i.test(err.detail)) {
          const { response_format: _, ...rest } = payload;
          payload = rest;
          continue;
        }
        const retryable = ['server', 'network', 'rate-limited'].includes(err.code);
        if (!retryable || attempt >= retries) throw err;
        attempt += 1;
        await sleep((err.code === 'rate-limited' ? 5000 : 2000) * 2 ** (attempt - 1), signal);
      }
    }
  }

  /** The smallest request that shows the key, address and model work. Uses a few tokens. */
  test(signal) {
    return this.chat({ model: this.model, messages: [{ role: 'user', content: 'Reply with: OK' }], max_tokens: 5 }, signal, { retries: 0 });
  }

  async request(url, init, signal) {
    if (!this.apiKey) throw new ApiError('no-key');
    let res;
    try {
      res = await this.fetch(url, {
        ...init,
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      if (signal?.aborted) throw new ApiError('aborted');
      throw new ApiError('network', String(err?.message || err));
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw classifyQwenHttp(res.status, body);
    return body || {};
  }
}
