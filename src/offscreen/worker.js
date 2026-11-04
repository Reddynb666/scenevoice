// Web worker inside the offscreen document: runs the long model requests
// (Gemini, and Qwen or Gemini with frames for sites Gemini cannot open by link).
//
// Why here: a request that describes five minutes of video takes 30–90 seconds.
// Chrome terminates an extension service worker when a fetch takes longer than
// 30 seconds, and requests made from the YouTube tab are governed by YouTube's
// own page policies (CORS, connection allowlists) and expose the API key to the
// page's context. The offscreen document is an extension page with the
// extension's own host permissions, and this worker keeps running inside it.
//
// Messages from the page: {id, cmd: 'start'|'abort'|'status'|'ask'|'revise'|'frames'|'cloud-get'|'cloud-put', ...}.
// 'ask' and 'revise' carry mode 'frames' and a provider when the video is shown
// to the model as pictures (see shared/providers.js); 'frames' describes one
// stretch of video from its pictures. 'cloud-get' and 'cloud-put' are the
// SceneVoice Cloud shared cache (shared/cloud.js): short requests, kept here
// with the other network calls so there is one place they are made from.
// Replies: {id, ...}, with `usage` (shared/usage.js) for every model answer.
// Events (no id): {event: 'started'|'chunk'|'done'|'error'|'stopped'|'model', key, provider, ...};
// 'chunk' and 'done' carry the section's own usage and length in seconds.

import { CHUNK_SECONDS } from '../shared/constants.js';
import { cloudRequest, scriptGetPath, scriptPath } from '../shared/cloud.js';
import { askFrames, createClient, describeFrames, reviseFrames } from '../shared/describe.js';
import { ApiError } from '../shared/errors.js';
import { GeminiClient } from '../shared/gemini.js';
import { runAsk, runGeneration, runRevision } from '../shared/generation.js';

/** @type {Map<string, {done:number,total:number,chunkStartedAt:number,chunkMs:number[],controller:AbortController,videoId:string,lang:string,provider:string}>} */
const jobs = new Map();

/** What a job's events and replies say about it; `provider` so the service worker can count and share its work. */
const jobInfo = (job) => ({ done: job.done, total: job.total, chunkStartedAt: job.chunkStartedAt, chunkMs: job.chunkMs, provider: job.provider });

/**
 * Jobs that may run at once. Each one is a long video request against the
 * listener's own key; many tabs (or a page full of embedded players) must not
 * be able to start a dozen of them.
 */
const MAX_JOBS = 2;

function start({ key, provider, config, params, script, force }) {
  const existing = jobs.get(key);
  if (existing && !force) return { already: true, ...jobInfo(existing) };
  if (!existing && jobs.size >= MAX_JOBS) return { error: 'busy' };
  if (existing) existing.controller.abort();

  const controller = new AbortController();
  const job = {
    videoId: params.videoId,
    lang: params.lang,
    // Jobs open the video by its link: Gemini, or Gemini through the SceneVoice Cloud relay.
    provider: provider === 'cloud' ? 'cloud' : 'gemini',
    done: 0,
    total: Math.max(1, Math.ceil(params.duration / CHUNK_SECONDS)),
    chunkStartedAt: Date.now(),
    chunkMs: [],
    controller,
  };
  if (script && !force) {
    job.done = Math.max(0, Math.min(job.total - 1, Math.ceil((script.completedUntil || 0) / CHUNK_SECONDS)));
  }
  jobs.set(key, job);
  const mine = () => jobs.get(key) === job;
  self.postMessage({ event: 'started', key, videoId: job.videoId, lang: job.lang, ...jobInfo(job) });

  const client = new GeminiClient(config);
  runGeneration({
    client,
    videoId: params.videoId,
    duration: params.duration,
    meta: params.meta,
    lang: params.lang,
    script: force ? null : script,
    signal: controller.signal,
    onModel: (model, reason) => {
      if (mine()) self.postMessage({ event: 'model', key, videoId: job.videoId, lang: job.lang, model, reason });
    },
    onChunk: (sc, { done, total, usage, seconds }) => {
      if (!mine()) return;
      const now = Date.now();
      if (job.chunkStartedAt) job.chunkMs.push(now - job.chunkStartedAt);
      job.done = done;
      job.total = total || job.total;
      job.chunkStartedAt = now;
      self.postMessage({ event: sc.complete ? 'done' : 'chunk', key, videoId: job.videoId, lang: job.lang, script: sc, model: client.model || '', usage, seconds, ...jobInfo(job) });
    },
  })
    .then((sc) => {
      if (!mine()) return;
      // A script that was already complete produces no chunk events: report it once.
      if (sc.complete && !job.chunkMs.length) {
        self.postMessage({ event: 'done', key, videoId: job.videoId, lang: job.lang, script: sc, ...jobInfo(job) });
      }
    })
    .catch((err) => {
      if (!mine()) return;
      const code = err instanceof ApiError ? err.code : 'unknown';
      if (code === 'aborted') self.postMessage({ event: 'stopped', key, videoId: job.videoId, lang: job.lang, provider: job.provider });
      else self.postMessage({ event: 'error', key, videoId: job.videoId, lang: job.lang, provider: job.provider, code, detail: err?.detail || String(err?.message || ''), ...(err?.resetAt ? { resetAt: err.resetAt } : {}) });
    })
    .finally(() => {
      if (mine()) jobs.delete(key);
    });
  return { started: true, ...jobInfo(job) };
}

function abort({ key }) {
  const job = jobs.get(key);
  if (!job) return { stopped: false };
  jobs.delete(key);
  job.controller.abort();
  self.postMessage({ event: 'stopped', key, videoId: job.videoId, lang: job.lang });
  return { stopped: true };
}

/**
 * Requests that are not jobs (frames, ask, revise) wait their turn: at most
 * MAX_IN_FLIGHT at once per provider, the rest in the order they came. A tab
 * sending a stretch every few seconds, plus a question, must not open a dozen
 * connections against one key and get them all rate-limited together.
 */
const MAX_IN_FLIGHT = 2;
/** @type {Map<string, {active: number, queue: Array<() => Promise<void>>}>} */
const lanes = new Map();

function lane(provider) {
  const name = provider || 'gemini';
  if (!lanes.has(name)) lanes.set(name, { active: 0, queue: [] });
  return lanes.get(name);
}

function pump(l) {
  while (l.active < MAX_IN_FLIGHT && l.queue.length) {
    l.active += 1;
    const next = l.queue.shift();
    next().finally(() => {
      l.active -= 1;
      pump(l);
    });
  }
}

/** Run fn when the provider has a free slot; resolves with fn's result. */
function inTurn(provider, fn) {
  const l = lane(provider);
  return new Promise((resolve) => {
    l.queue.push(() => fn().then(resolve, (err) => resolve(failure(err))));
    pump(l);
  });
}

/** Requests running and waiting, every provider together. */
function requestCounts() {
  let inFlight = 0;
  let waiting = 0;
  for (const l of lanes.values()) {
    inFlight += l.active;
    waiting += l.queue.length;
  }
  return { inFlight, waiting };
}

function status({ key }) {
  if (key) {
    const job = jobs.get(key);
    return job ? { status: 'generating', ...jobInfo(job) } : { status: 'idle' };
  }
  return { jobs: [...jobs.entries()].map(([k, job]) => ({ key: k, videoId: job.videoId, lang: job.lang, ...jobInfo(job) })), ...requestCounts() };
}

const failure = (err) => ({ error: err instanceof ApiError ? err.code : 'unknown', detail: err?.detail || String(err?.message || ''), ...(err?.resetAt ? { resetAt: err.resetAt } : {}) });

/** Answer a question. Replies { text, time, confidence, usage, model }. */
function ask({ mode, provider, config, params }) {
  return inTurn(mode === 'frames' ? provider : 'gemini', async () => {
    if (mode === 'frames') {
      const client = createClient(provider, config);
      return { ...(await askFrames(provider, client, params)), model: client.model || '' };
    }
    const client = new GeminiClient(config);
    return { ...(await runAsk(client, params)), model: client.model || '' };
  });
}

/** Describe one moment again. Replies { cue, usage, model }, where cue is null when there is nothing there to describe. */
function revise({ mode, provider, config, params }) {
  return inTurn(mode === 'frames' ? provider : 'gemini', async () => {
    if (mode === 'frames') {
      const client = createClient(provider, config);
      return { ...(await reviseFrames(provider, client, params)), model: client.model || '' };
    }
    const client = new GeminiClient(config);
    return { ...(await runRevision(client, params)), model: client.model || '' };
  });
}

/** Describe one stretch of video from its frames. Replies { chunk, model, usage }. */
function frames({ provider, config, params }) {
  return inTurn(provider, async () => {
    const client = createClient(provider, config);
    const { usage, ...chunk } = await describeFrames(provider, client, params);
    return { chunk, model: client.model || '', usage };
  });
}

// ---------- SceneVoice Cloud shared cache ----------
// Text only. The service worker checks what comes back (shared/cloud.js
// cloudScriptOk) before saving it; this only fetches.

/** The worker's own fetch, looked up at call time so tests can stand in for it. */
const cloudFetch = (input, init) => fetch(input, init);

/** The script another SceneVoice user finished for this video, or null. Replies { script } or { error, detail }. */
async function cloudGet({ config, params }) {
  try {
    const { status, body } = await cloudRequest(cloudFetch, scriptGetPath(params?.videoId, params?.lang), { token: config?.apiKey || '' });
    if (status === 404) return { script: null };
    if (status < 200 || status >= 300) return { error: 'request-failed', detail: `HTTP ${status}` };
    return { script: body };
  } catch (err) {
    return failure(err);
  }
}

/** Put a finished script into the shared cache. Replies { ok } or { error, detail }; the caller only logs a failure. */
async function cloudPut({ config, params }) {
  try {
    const { status, body } = await cloudRequest(cloudFetch, scriptPath(params?.videoId, params?.lang), { method: 'PUT', token: config?.apiKey || '', body: params?.script });
    if (status < 200 || status >= 300) return { error: 'request-failed', detail: String(body?.error?.message || `HTTP ${status}`) };
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

// No chrome.runtime listener here. offscreen.js creates this worker and is the
// only caller; it forwards a command only after the service worker is confirmed
// as the sender. Messages that are not one of those commands are ignored below.
self.onmessage = async ({ data }) => {
  const { id, cmd } = data || {};
  let reply;
  try {
    if (cmd === 'start') reply = start(data);
    else if (cmd === 'abort') reply = abort(data);
    else if (cmd === 'status') reply = status(data);
    else if (cmd === 'ask') reply = await ask(data);
    else if (cmd === 'revise') reply = await revise(data);
    else if (cmd === 'frames') reply = await frames(data);
    else if (cmd === 'cloud-get') reply = await cloudGet(data);
    else if (cmd === 'cloud-put') reply = await cloudPut(data);
    else reply = { error: 'unknown-command' };
  } catch (err) {
    reply = { error: 'unknown', detail: String(err?.message || err) };
  }
  if (id != null) self.postMessage({ id, ...reply });
};
