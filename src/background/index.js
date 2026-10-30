// Service worker: text-to-speech, keyboard commands, status for the popup,
// cache housekeeping, and the hub for description generation.
//
// Model requests do not run here: Chrome terminates a service worker when a
// fetch takes longer than 30 seconds, and describing five minutes of video takes
// 30–90 seconds. They run in a worker inside the offscreen document
// (offscreen/worker.js), an extension page that Chrome keeps open and that has
// the extension's own host permissions. This file starts jobs there, saves each
// finished section to the cache, and tells the video tabs what happened.
//
// Which model, and how it is shown the video, follows the site of the tab that
// asks (shared/providers.js): Gemini on YouTube opens the video link; otherwise
// the tab sends frames from the playing video (MSG.GEN_FRAMES), described here
// stretch by stretch and added to the same cache.

import { FRAME_SAMPLING, LANGUAGES, MSG } from '../shared/constants.js';
import { authorizeBackgroundMessage, platformOfSender } from '../shared/sender.js';
import { getLocal, getSettings, protectLocalStorage, setLocal } from '../shared/storage.js';
import { addFeedback, cacheInfo, clearCache, deleteScript, getFeedback, getScript, putScript } from '../shared/cache.js';
import { mergeFramesChunk, newFramesScript, recentCues } from '../shared/coverage.js';
import { sanitizeFrames } from '../shared/frames.js';
import { platformOfVideoId } from '../shared/platforms.js';
import { inputModeFor, providerFor } from '../shared/providers.js';
import { applyCorrections, cueRef, findCueIndex, replaceCue } from '../shared/revision.js';
import { speechOptions } from '../shared/voices.js';

// Content scripts share the YouTube (or Bilibili) process and must not read the
// API keys or the description cache. The level does not always survive a browser restart,
// so set it on every worker start, before handling messages. Stored records
// are left as they are: existing users keep their key and cached scripts.
function restrictStorage() {
  return protectLocalStorage().catch((err) => {
    console.error('[SceneVoice] could not restrict local storage to trusted contexts', err);
  });
}

const storageAccess = restrictStorage();

// ---------- install ----------

// Show the setup page on first install. The browser window may not exist yet
// when the event fires (e.g. installed by policy at start-up), so retry briefly.
async function openWelcome(attempt = 0) {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    if (attempt < 10) setTimeout(() => openWelcome(attempt + 1), 1000);
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  restrictStorage();
  if (reason === 'install') openWelcome();
});

chrome.runtime.onStartup.addListener(() => {
  restrictStorage();
});

// ---------- speech ----------

// The chosen voice is checked against the voices on this computer: settings
// sync between computers, and Chrome does not look for a voice that speaks the
// language when asked for one it does not have. Then Chrome chooses by language.
async function speak(msg, tabId) {
  const installed = msg.voice ? await chrome.tts.getVoices().catch(() => []) : [];
  const opts = {
    ...speechOptions(msg, installed),
    onEvent: (ev) => {
      if (['end', 'interrupted', 'cancelled', 'error'].includes(ev.type) && tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: MSG.TTS_EVENT, id: msg.id, event: ev.type }).catch(() => {});
      }
    },
  };
  chrome.tts.speak(String(msg.text ?? ''), opts);
}

// ---------- offscreen document ----------

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

/** Open the offscreen document if it is not open already. Safe to call concurrently. */
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Runs the worker that sends long video-description requests to the Gemini or Qwen API; such requests take longer than a service worker may wait.',
      })
      .catch((err) => {
        // Another caller won the race.
        if (!/single offscreen|already exists/i.test(String(err?.message))) throw err;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/** Send a command to the worker in the offscreen document. */
async function offscreen(data) {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN, data }).catch(() => undefined);
  if (reply !== undefined) return reply;
  // No answer: the document was closed between the check and the message (idle
  // clean-up), or its script has not finished loading. Give it a moment and try once more.
  await new Promise((r) => setTimeout(r, 300));
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: MSG.OFFSCREEN, data }).catch(() => undefined);
}

/** Close the offscreen document once nothing has run in it for a while. */
const IDLE_CLOSE_MS = 60000;
let idleTimer = null;
/** Questions and descriptions being made again: requests in the worker that are not jobs. */
let busyRequests = 0;

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    try {
      if (busyRequests || !(await chrome.offscreen.hasDocument())) return;
      const reply = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN, data: { cmd: 'status' } }).catch(() => null);
      if (reply?.jobs?.length === 0) await chrome.offscreen.closeDocument();
    } catch {
      // nothing to clean up
    }
  }, IDLE_CLOSE_MS);
}

/** What the worker needs to call a provider, or an error when its key is not set. */
function providerConfig(local, provider) {
  if (provider === 'qwen') {
    if (!local.qwenApiKey) return { error: 'no-key' };
    return {
      config: {
        apiKey: local.qwenApiKey,
        apiBase: local.qwenApiBase,
        model: local.qwenModel,
        jsonMode: Boolean(local.qwenJsonMode),
        maxFrames: local.qwenMaxFrames,
      },
    };
  }
  if (!local.apiKey) return { error: 'no-key' };
  return { config: { apiKey: local.apiKey, apiBase: local.apiBase, model: local.model } };
}

/**
 * The provider for the tab that asks, from its site (never from the message)
 * and the settings, how it takes the video, and its config.
 * @returns {Promise<{platform: string, provider: string, mode: 'video'|'frames', config?: object, error?: string}>}
 */
async function setupFor(sender) {
  const platform = platformOfSender(sender, chrome.runtime.id) || 'youtube';
  const provider = providerFor(await getSettings(), platform);
  const { config, error } = providerConfig(await getLocal(), provider);
  return { platform, provider, mode: inputModeFor(provider, platform), config, error };
}

/** Most frames one request carries: the per-computer limit for Qwen (待确认), at most 12. */
function frameLimit(config, fallback = FRAME_SAMPLING.maxFrames) {
  const n = Math.floor(Number(config?.maxFrames));
  return Number.isFinite(n) && n > 0 ? Math.min(12, n) : fallback;
}

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));
const text = (value, n) => (typeof value === 'string' ? value.slice(0, n) : '');
/** Title, uploader and description from the tab, as plain strings of sensible length. */
const cleanMeta = (meta) => ({ title: text(meta?.title, 300), channel: text(meta?.channel, 120), description: text(meta?.description, 2000) });

const jobKey = (videoId, lang) => `${videoId}:${lang}`;

/**
 * Run changes to one video's saved script one after the other. A job saves its
 * own copy after every section while a correction reads, changes and writes
 * the saved one: interleaved, either could undo the other.
 */
const scriptQueues = new Map();
function inTurn(key, fn) {
  const run = (scriptQueues.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  scriptQueues.set(key, tail);
  tail.then(() => {
    if (scriptQueues.get(key) === tail) scriptQueues.delete(key);
  });
  return run;
}

/** Save a script from a job, with the corrections the user has made to it since the job began. */
function saveJobScript(videoId, lang, script) {
  return inTurn(jobKey(videoId, lang), async () => {
    const saved = applyCorrections(script, await getFeedback(videoId, lang));
    await putScript(videoId, lang, saved);
    return saved;
  });
}

/**
 * Tell every YouTube tab (and its frames) about a generation event. Without the
 * "tabs" permission tabs cannot be filtered by URL, so every tab is tried; tabs
 * without the content script simply have no listener.
 */
async function broadcast(msg) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (tab.id != null) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
}

async function startGeneration({ videoId, duration, meta, lang, force }, sender) {
  const { config, error, mode } = await setupFor(sender);
  if (error) return { error };
  // Only a model that opens the video link describes ahead of playback; the others are sent frames.
  if (mode !== 'video') return { error: 'provider-unsupported' };
  const script = force ? null : await getScript(videoId, lang);
  if (script?.complete) return { status: 'ready' };
  const reply = await offscreen({ cmd: 'start', key: jobKey(videoId, lang), config, params: { videoId, duration, meta, lang }, script, force });
  if (!reply || reply.error) return { error: reply?.error || 'offscreen-unavailable', detail: reply?.detail };
  return { status: 'generating', done: reply.done, total: reply.total, chunkStartedAt: reply.chunkStartedAt, chunkMs: reply.chunkMs, already: Boolean(reply.already) };
}

async function generationStatus({ videoId, lang }) {
  if (!(await chrome.offscreen.hasDocument())) return { status: 'idle' };
  const reply = await offscreen({ cmd: 'status', key: jobKey(videoId, lang) });
  return reply?.status ? reply : { status: 'idle' };
}

async function stopGeneration({ videoId, lang }) {
  if (!(await chrome.offscreen.hasDocument())) return { stopped: false };
  return offscreen({ cmd: 'abort', key: jobKey(videoId, lang) });
}

/** A request to the worker that is not a job (a question, a description made again). */
async function workerRequest(data) {
  busyRequests += 1;
  try {
    return (await offscreen(data)) || { error: 'offscreen-unavailable' };
  } finally {
    busyRequests -= 1;
    scheduleIdleClose();
  }
}

async function ask(params, sender) {
  const { config, error, mode, provider } = await setupFor(sender);
  if (error) return { error };
  if (mode !== 'frames') return workerRequest({ cmd: 'ask', config, params });
  const frames = sanitizeFrames(params?.frames, { max: Math.min(4, frameLimit(config)) });
  if (!frames.length) return { error: 'frames-missing' };
  return workerRequest({ cmd: 'ask', mode, provider, config, params: { ...params, meta: cleanMeta(params?.meta), frames } });
}

/**
 * The user marked a description as wrong: describe that moment again and put
 * the new description in its place in the saved script. Which description was
 * marked, and what replaced it, is kept on this computer only (see cache.js),
 * and applied again to sections a running job saves later.
 * Resolves to { status: 'revised', cue } | { status: 'removed' } | { error }.
 */
async function revise({ videoId, lang, cue, meta, duration, frames: sent }, sender) {
  if (typeof videoId !== 'string' || typeof lang !== 'string' || !cue || typeof cue !== 'object') return { error: 'unknown' };
  const { config, error, mode, provider } = await setupFor(sender);
  if (error) return { error };
  // A model that is sent pictures looks again at those of that moment.
  const frames = mode === 'frames' ? sanitizeFrames(sent, { max: frameLimit(config) }) : null;
  if (frames && !frames.length) return { error: 'frames-missing' };
  const script = await getScript(videoId, lang);
  if (!script) return { error: 'no-script' };
  const i = findCueIndex(script.cues, cueRef(cue));
  if (i < 0) return { error: 'cue-not-found' };
  const old = script.cues[i];
  const mark = { at: Date.now(), ...cueRef(old) };
  const params = {
    videoId,
    lang,
    meta: meta || {},
    duration: Number.isFinite(duration) && duration > 0 ? duration : script.duration,
    cue: old,
    characters: script.characters || [],
  };
  const reply = frames
    ? await workerRequest({ cmd: 'revise', mode, provider, config, params: { ...params, meta: cleanMeta(meta), frames } })
    : await workerRequest({ cmd: 'revise', config, params });
  if (reply.error) {
    await inTurn(jobKey(videoId, lang), () => addFeedback(videoId, lang, { ...mark, status: 'failed', error: reply.error })).catch(() => {});
    return { error: reply.error, detail: reply.detail };
  }
  const replacement = reply.cue || null;
  const status = replacement ? 'revised' : 'removed';
  await inTurn(jobKey(videoId, lang), async () => {
    await addFeedback(videoId, lang, { ...mark, status, replacement });
    const current = await getScript(videoId, lang);
    if (current) await putScript(videoId, lang, replaceCue(current, mark, replacement));
  });
  await broadcast({ type: MSG.GEN_EVENT, event: 'revised', videoId, lang });
  return replacement ? { status, cue: replacement } : { status };
}

/**
 * Frames of one stretch of the video from the tab playing it: have them
 * described, then add the descriptions to the saved script (with the
 * corrections the user made) and count the stretch as described.
 * Resolves to { status: 'ok'|'done', cues, cueCount, completedUntil, complete } | { error }.
 */
async function describeStretch(msg, sender) {
  const { videoId, lang } = msg;
  const start = Number(msg.window?.start);
  const end = Number(msg.window?.end);
  if (typeof videoId !== 'string' || !LANGUAGE_CODES.has(lang) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 120) {
    return { error: 'unknown' };
  }
  const setup = await setupFor(sender);
  // A tab describes only videos of its own site.
  if (platformOfVideoId(videoId) !== setup.platform) return { error: 'unknown' };
  if (setup.error) return { error: setup.error };
  if (setup.mode !== 'frames') return { error: 'provider-unsupported' };
  const frames = sanitizeFrames(msg.frames, { max: frameLimit(setup.config) });
  if (!frames.length) return { error: 'frames-missing' };
  const saved = await getScript(videoId, lang);
  const duration = Number.isFinite(msg.duration) && msg.duration > 0 ? msg.duration : saved?.duration;
  const reply = await workerRequest({
    cmd: 'frames',
    provider: setup.provider,
    config: setup.config,
    params: { meta: cleanMeta(msg.meta), duration, lang, window: { start, end }, frames, characters: saved?.characters || [], recent: recentCues(saved, start) },
  });
  if (reply.error || !Array.isArray(reply.chunk?.cues)) return { error: reply.error || 'unknown', detail: reply.detail };
  const script = await inTurn(jobKey(videoId, lang), async () => {
    const base = (await getScript(videoId, lang)) || newFramesScript({ videoId, lang, duration, platform: setup.platform, provider: setup.provider });
    const merged = mergeFramesChunk(base, reply.chunk, { start, end, duration, model: reply.model, provider: setup.provider });
    const fixed = applyCorrections(merged, await getFeedback(videoId, lang));
    await putScript(videoId, lang, fixed);
    return fixed;
  });
  return {
    status: script.complete ? 'done' : 'ok',
    cues: reply.chunk.cues,
    cueCount: script.cues.length,
    completedUntil: script.completedUntil,
    complete: script.complete,
  };
}

/** Events from the worker: save finished sections, then tell the tabs. */
async function onJobEvent(ev) {
  const { event, videoId, lang } = ev;
  let saved = ev.script;
  if (event === 'chunk' || event === 'done') {
    saved = await saveJobScript(videoId, lang, ev.script);
  }
  if (event === 'model') {
    console.info(`[SceneVoice] switched to ${ev.model} (${ev.reason})`);
    // A model this key cannot use any more is replaced for good; an overloaded one is only skipped this time.
    if (ev.reason === 'model-not-found') await setLocal({ model: ev.model }).catch(() => {});
  }
  const { type, script, ...rest } = ev;
  await broadcast({ ...rest, type: MSG.GEN_EVENT, cueCount: saved?.cues?.length ?? null, completedUntil: saved?.completedUntil ?? null });
  if (['done', 'error', 'stopped'].includes(event)) scheduleIdleClose();
}

// ---------- messages ----------

async function shortcuts() {
  const out = {};
  for (const c of await chrome.commands.getAll()) if (c.shortcut) out[c.name] = c.shortcut;
  return out;
}

async function handle(msg, sender) {
  await storageAccess;
  switch (msg?.type) {
    case MSG.GET_STATUS: {
      const local = await getLocal();
      // Only whether each key exists: never the key itself.
      return { hasKey: Boolean(local.apiKey), keys: { gemini: Boolean(local.apiKey), qwen: Boolean(local.qwenApiKey) }, model: local.model, shortcuts: await shortcuts() };
    }
    case MSG.GET_SCRIPT:
      return { script: await getScript(msg.videoId, msg.lang) };
    case MSG.DELETE_SCRIPT:
      await stopGeneration(msg).catch(() => {});
      await deleteScript(msg.videoId, msg.lang);
      return { ok: true };
    case MSG.GEN_START:
      return startGeneration(msg, sender);
    case MSG.GEN_STOP:
      return stopGeneration(msg);
    case MSG.GEN_STATUS:
      return generationStatus(msg);
    case MSG.ASK:
      return ask(msg.params, sender);
    case MSG.REVISE:
      return revise(msg, sender);
    case MSG.GEN_FRAMES:
      return describeStretch(msg, sender);
    case MSG.JOB_EVENT:
      await onJobEvent(msg);
      return { ok: true };
    case MSG.SPEAK:
      await speak(msg, sender.tab?.id ?? null);
      return { ok: true };
    case MSG.STOP_SPEAKING:
      chrome.tts.stop();
      return { ok: true };
    case MSG.GET_VOICES:
      return { voices: (await chrome.tts.getVoices()).map((v) => ({ name: v.voiceName, lang: v.lang })) };
    case MSG.OPEN_OPTIONS:
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case MSG.CACHE_INFO:
      return cacheInfo();
    case MSG.CACHE_CLEAR:
      await clearCache();
      return { ok: true };
    default:
      return { error: 'unknown-message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg?.type?.startsWith('sv:')) return false;
    // Answered by the offscreen document. Responding here would race with it.
    if (msg.type === MSG.OFFSCREEN) return false;
    if (!authorizeBackgroundMessage(msg.type, sender, chrome.runtime.id)) {
      sendResponse({ error: 'forbidden' });
      return false;
    }
  } catch {
    sendResponse({ error: 'forbidden' });
    return false;
  }
  handle(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: 'unknown', detail: String(err?.message || '') }));
  return true;
});

// ---------- keyboard commands ----------

chrome.commands.onCommand.addListener(async (command, tab) => {
  let target = tab;
  if (!target?.id) {
    [target] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  if (!target?.id) return;
  if (command === 'stop-speaking') chrome.tts.stop();
  chrome.tabs.sendMessage(target.id, { type: MSG.COMMAND, command }).catch(() => {});
});
