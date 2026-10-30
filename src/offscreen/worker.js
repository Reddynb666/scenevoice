// Web worker inside the offscreen document: runs the long Gemini requests.
//
// Why here: a request that describes five minutes of video takes 30–90 seconds.
// Chrome terminates an extension service worker when a fetch takes longer than
// 30 seconds, and requests made from the YouTube tab are governed by YouTube's
// own page policies (CORS, connection allowlists) and expose the API key to the
// page's context. The offscreen document is an extension page with the
// extension's own host permissions, and this worker keeps running inside it.
//
// Messages from the page: {id, cmd: 'start'|'abort'|'status'|'ask'|'revise', ...}.
// Replies: {id, ...}. Events (no id): {event: 'started'|'chunk'|'done'|'error'|'stopped'|'model', key, ...}.

import { CHUNK_SECONDS } from '../shared/constants.js';
import { GeminiClient, GeminiError } from '../shared/gemini.js';
import { runAsk, runGeneration, runRevision } from '../shared/generation.js';

/** @type {Map<string, {done:number,total:number,chunkStartedAt:number,chunkMs:number[],controller:AbortController,videoId:string,lang:string}>} */
const jobs = new Map();

const jobInfo = (job) => ({ done: job.done, total: job.total, chunkStartedAt: job.chunkStartedAt, chunkMs: job.chunkMs });

function start({ key, config, params, script, force }) {
  const existing = jobs.get(key);
  if (existing && !force) return { already: true, ...jobInfo(existing) };
  if (existing) existing.controller.abort();

  const controller = new AbortController();
  const job = {
    videoId: params.videoId,
    lang: params.lang,
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
    onChunk: (sc, { done, total }) => {
      if (!mine()) return;
      const now = Date.now();
      if (job.chunkStartedAt) job.chunkMs.push(now - job.chunkStartedAt);
      job.done = done;
      job.total = total || job.total;
      job.chunkStartedAt = now;
      self.postMessage({ event: sc.complete ? 'done' : 'chunk', key, videoId: job.videoId, lang: job.lang, script: sc, ...jobInfo(job) });
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
      const code = err instanceof GeminiError ? err.code : 'unknown';
      if (code === 'aborted') self.postMessage({ event: 'stopped', key, videoId: job.videoId, lang: job.lang });
      else self.postMessage({ event: 'error', key, videoId: job.videoId, lang: job.lang, code, detail: err?.detail || String(err?.message || '') });
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

function status({ key }) {
  if (key) {
    const job = jobs.get(key);
    return job ? { status: 'generating', ...jobInfo(job) } : { status: 'idle' };
  }
  return { jobs: [...jobs.entries()].map(([k, job]) => ({ key: k, videoId: job.videoId, lang: job.lang, ...jobInfo(job) })) };
}

const failure = (err) => ({ error: err instanceof GeminiError ? err.code : 'unknown', detail: err?.detail || String(err?.message || '') });

async function ask({ config, params }) {
  const client = new GeminiClient(config);
  try {
    return await runAsk(client, params);
  } catch (err) {
    return failure(err);
  }
}

/** Describe one moment again. Replies { cue }, where cue is null when there is nothing there to describe. */
async function revise({ config, params }) {
  const client = new GeminiClient(config);
  try {
    return { cue: await runRevision(client, params) };
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
    else reply = { error: 'unknown-command' };
  } catch (err) {
    reply = { error: 'unknown', detail: String(err?.message || err) };
  }
  if (id != null) self.postMessage({ id, ...reply });
};
