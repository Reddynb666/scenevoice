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

import { CLOUD_API_BASE, FRAME_SAMPLING, MSG, USAGE_KEY } from '../shared/constants.js';
import { adoptCloudScript, cloudScriptOk, shareableScript } from '../shared/cloud.js';
import { authorizeBackgroundMessage, platformOfSender } from '../shared/sender.js';
import { getLocal, getSettings, isDescriptionLanguage, protectLocalStorage, setLocal } from '../shared/storage.js';
import { addFeedback, cacheInfo, clearCache, deleteScript, getFeedback, getScript, putScript } from '../shared/cache.js';
import { mergeFramesChunk, newFramesScript, recentCues } from '../shared/coverage.js';
import { sanitizeFrames } from '../shared/frames.js';
import { platformOfVideoId } from '../shared/platforms.js';
import { effectiveProvider, inputModeFor, providerFor } from '../shared/providers.js';
import { applyCorrections, cueRef, findCueIndex, replaceCue } from '../shared/revision.js';
import { speechOptions } from '../shared/voices.js';
import { cleanAskHistory } from '../shared/ask.js';
import { budgetReached, recordUsage, todaysUsage } from '../shared/usage.js';

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

// Show the welcome page on first install: hear a sample, pick SceneVoice Cloud
// or a key of one's own, try a video. The browser window may not exist yet when
// the event fires (e.g. installed by policy at start-up), so retry briefly, and
// fall back to the settings page if the tab cannot be opened at all.
async function openWelcome(attempt = 0) {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  } catch {
    if (attempt < 10) setTimeout(() => openWelcome(attempt + 1), 1000);
    else chrome.runtime.openOptionsPage().catch(() => {});
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

/** Longest wait for the offscreen document's answer (it times out its own worker sooner). */
const OFFSCREEN_REPLY_MS = 660000;

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Send a command to the worker in the offscreen document. */
async function offscreen(data) {
  await ensureOffscreen();
  const send = () => withTimeout(chrome.runtime.sendMessage({ type: MSG.OFFSCREEN, data }).catch(() => undefined), OFFSCREEN_REPLY_MS);
  const reply = await send();
  if (reply !== undefined) return reply;
  // No answer: the document was closed between the check and the message (idle
  // clean-up), or its script has not finished loading. Give it a moment and try once more.
  await new Promise((r) => setTimeout(r, 300));
  await ensureOffscreen();
  return send();
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
      // The worker's own count too: a request this service worker instance did not
      // send (it was restarted meanwhile) must not have its document closed under it.
      const reply = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN, data: { cmd: 'status' } }).catch(() => null);
      if (reply?.jobs?.length === 0 && !reply.inFlight && !reply.waiting) await chrome.offscreen.closeDocument();
    } catch {
      // nothing to clean up
    }
  }, IDLE_CLOSE_MS);
}

// ---------- usage ----------

// One writer at a time: two answers arriving together would otherwise each
// read the counter, add their own, and the second write lose the first.
let usageQueue = Promise.resolve();

/**
 * Add what one answer cost to today's counter on this computer (usage.js):
 * tokens, requests and seconds of video, per provider. Nothing leaves the
 * computer; the options page shows the totals and the popup a video's cost.
 */
function countUsage(provider, usage, { model, seconds } = {}) {
  if (!usage) return Promise.resolve();
  const run = usageQueue.then(async () => {
    const { [USAGE_KEY]: stored } = await chrome.storage.local.get(USAGE_KEY);
    await chrome.storage.local.set({ [USAGE_KEY]: recordUsage(stored, provider, usage, { model, seconds }) });
  });
  usageQueue = run.catch((err) => console.warn('[SceneVoice] could not count usage', err));
  return usageQueue;
}

/** Whether today's video described has reached the listener's daily limit, so no new job or stretch should start. */
async function overBudget() {
  const { dailyBudgetSeconds } = await getSettings();
  if (!dailyBudgetSeconds) return false;
  const { [USAGE_KEY]: stored } = await chrome.storage.local.get(USAGE_KEY);
  return budgetReached(todaysUsage(stored), dailyBudgetSeconds);
}

/** What the worker needs to call a provider, or an error when its key is not set. */
function providerConfig(local, provider) {
  if (provider === 'cloud') {
    // The device token stands where the key goes; the relay's address is fixed, never read from storage.
    if (!local.cloudToken) return { error: 'no-key' };
    return { config: { apiKey: local.cloudToken, apiBase: CLOUD_API_BASE, model: local.cloudModel || '' } };
  }
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

/** Which keys are set (the Cloud device token counts as one), and nothing else about them. */
const keysOf = (local) => ({ gemini: Boolean(local.apiKey), qwen: Boolean(local.qwenApiKey), cloud: Boolean(local.cloudToken) });

/**
 * The provider for the tab that asks, from its site (never from the message)
 * and the settings, how it takes the video, and its config. With only one key
 * saved, that key's model describes every site (effectiveProvider).
 * @returns {Promise<{platform: string, provider: string, mode: 'video'|'frames', config?: object, error?: string}>}
 */
async function setupFor(sender) {
  const platform = platformOfSender(sender, chrome.runtime.id) || 'youtube';
  const local = await getLocal();
  const provider = effectiveProvider(await getSettings(), platform, keysOf(local));
  const { config, error } = providerConfig(local, provider);
  return { platform, provider, mode: inputModeFor(provider, platform), config, error };
}

/** Longest video a job is started for (a day-long stream is not a video to describe ahead). */
const MAX_DURATION = 12 * 3600;

/** A video id of the sender's own site, with a language SceneVoice writes. */
function ownVideo(videoId, lang, platform) {
  return typeof videoId === 'string' && platformOfVideoId(videoId) === platform && isDescriptionLanguage(lang);
}

/** The site of the tab a message came from (the popup and the options page count as YouTube). */
const senderPlatform = (sender) => platformOfSender(sender, chrome.runtime.id) || 'youtube';

/** Frame requests a tab may make per minute: a normal stretch is 12 seconds, so about 5, plus retries. */
const FRAMES_PER_MINUTE = 30;
const framesLog = new Map();

function overFramesLimit(tabId) {
  const now = Date.now();
  const recent = (framesLog.get(tabId) || []).filter((at) => now - at < 60000);
  recent.push(now);
  framesLog.set(tabId, recent);
  return recent.length > FRAMES_PER_MINUTE;
}

/** Most frames one request carries: the per-computer limit for Qwen (待确认), at most 12. */
function frameLimit(config, fallback = FRAME_SAMPLING.maxFrames) {
  const n = Math.floor(Number(config?.maxFrames));
  return Number.isFinite(n) && n > 0 ? Math.min(12, n) : fallback;
}

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

/**
 * SceneVoice Cloud's shared cache: the finished descriptions another listener
 * made for this video, if any, saved here as if made on this computer (with
 * this listener's own corrections applied). Only text ever comes back, and
 * only a script that checks out (cloudScriptOk) is kept. Resolves to the
 * saved script, or null when there is none or the relay cannot be reached.
 */
async function fetchSharedScript(config, { videoId, lang, duration }) {
  const reply = await offscreen({ cmd: 'cloud-get', config, params: { videoId, lang } }).catch(() => null);
  if (!reply || reply.error || !reply.script) return null;
  if (!cloudScriptOk(reply.script, { videoId, lang, duration })) return null;
  return saveJobScript(videoId, lang, adoptCloudScript(reply.script));
}

async function startGeneration({ videoId, duration, meta, lang, force }, sender) {
  const { config, error, mode, platform, provider } = await setupFor(sender);
  // A tab starts jobs only for videos of its own site, of a length a video can have.
  if (!ownVideo(videoId, lang, platform) || !Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION) return { error: 'unknown' };
  if (error) return { error };
  // Only a model that opens the video link describes ahead of playback; the others are sent frames.
  if (mode !== 'video') return { error: 'provider-unsupported' };
  const script = force ? null : await getScript(videoId, lang);
  if (script?.complete) return { status: 'ready' };
  // Through the relay, a video someone else already had described costs nothing and takes no time.
  if (provider === 'cloud' && !force && (await fetchSharedScript(config, { videoId, lang, duration }))) return { status: 'ready', fromCloud: true };
  // The day's limit stops new jobs only: one already running finishes its video,
  // and a tab asking after it must be told so, not refused while it goes on. The
  // worker decides, as the only one that knows whether the job is still there.
  const newJobsAllowed = !(await overBudget());
  // Without an offscreen document no job is running, so there is nothing to open one for.
  if (!newJobsAllowed && !(await chrome.offscreen.hasDocument())) return { error: 'budget' };
  const reply = await offscreen({ cmd: 'start', key: jobKey(videoId, lang), provider, config, params: { videoId, duration, meta, lang }, script, force, newJobsAllowed });
  if (!reply || reply.error) return { error: reply?.error || 'offscreen-unavailable', detail: reply?.detail };
  return { status: 'generating', done: reply.done, total: reply.total, chunkStartedAt: reply.chunkStartedAt, chunkMs: reply.chunkMs, already: Boolean(reply.already) };
}

/**
 * Offer a finished script to the shared cache, once, after a Cloud job
 * completes and only while the listener has sharing on. Text only, stripped
 * of anything about this computer (shareableScript). Fire and forget: a
 * failure is logged and changes nothing here.
 */
async function shareScript(videoId, lang, script) {
  const { shareDescriptions } = await getSettings();
  if (!shareDescriptions) return;
  const local = await getLocal();
  const { config } = providerConfig(local, 'cloud');
  const shared = shareableScript(script);
  if (!config || !shared) return;
  offscreen({ cmd: 'cloud-put', config, params: { videoId, lang, script: shared } })
    .then((reply) => {
      if (reply?.error) console.warn('[SceneVoice] could not share the descriptions', reply.error, reply.detail || '');
    })
    .catch((err) => console.warn('[SceneVoice] could not share the descriptions', err));
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

/** A worker reply for the tab: its usage counted here and left out, with the model that answered. */
async function counted(provider, reply) {
  const { usage, model, ...rest } = reply || {};
  if (usage) await countUsage(provider, usage, { model });
  return rest;
}

async function ask(params, sender) {
  const { config, error, mode, provider } = await setupFor(sender);
  if (error) return { error };
  const history = cleanAskHistory(params?.history);
  if (mode !== 'frames') return counted(provider, await workerRequest({ cmd: 'ask', config, params: { ...params, history } }));
  // Pictures of the last 20 seconds, as many as one request takes (Gemini gets a 24-second clip).
  const frames = sanitizeFrames(params?.frames, { max: frameLimit(config) });
  if (!frames.length) return { error: 'frames-missing' };
  return counted(provider, await workerRequest({ cmd: 'ask', mode, provider, config, params: { ...params, history, meta: cleanMeta(params?.meta), frames } }));
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
  const reply = await counted(
    provider,
    frames ? await workerRequest({ cmd: 'revise', mode, provider, config, params: { ...params, meta: cleanMeta(meta), frames } }) : await workerRequest({ cmd: 'revise', config, params }),
  );
  if (reply.error) {
    await inTurn(jobKey(videoId, lang), () => addFeedback(videoId, lang, { ...mark, status: 'failed', error: reply.error })).catch(() => {});
    return { error: reply.error, detail: reply.detail, ...(reply.resetAt ? { resetAt: reply.resetAt } : {}) };
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
  if (typeof videoId !== 'string' || !isDescriptionLanguage(lang) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 120) {
    return { error: 'unknown' };
  }
  const setup = await setupFor(sender);
  // A tab describes only videos of its own site.
  if (platformOfVideoId(videoId) !== setup.platform) return { error: 'unknown' };
  if (setup.error) return { error: setup.error };
  if (setup.mode !== 'frames') return { error: 'provider-unsupported' };
  // A page cannot make the key pay for more than the video it is playing.
  if (overFramesLimit(sender?.tab?.id ?? -1)) return { error: 'busy' };
  if (await overBudget()) return { error: 'budget' };
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
  if (reply.usage) await countUsage(setup.provider, reply.usage, { model: reply.model, seconds: end - start });
  if (reply.error || !Array.isArray(reply.chunk?.cues)) return { error: reply.error || 'unknown', detail: reply.detail, ...(reply.resetAt ? { resetAt: reply.resetAt } : {}) };
  const script = await inTurn(jobKey(videoId, lang), async () => {
    const base = (await getScript(videoId, lang)) || newFramesScript({ videoId, lang, duration, platform: setup.platform, provider: setup.provider });
    const merged = mergeFramesChunk(base, reply.chunk, { start, end, duration, model: reply.model, provider: setup.provider, usage: reply.usage });
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
  // Jobs open the video by its link: Gemini, or Gemini through the Cloud relay. The worker says which.
  const provider = ev.provider === 'cloud' ? 'cloud' : 'gemini';
  let saved = ev.script;
  if (event === 'chunk' || event === 'done') {
    saved = await saveJobScript(videoId, lang, { ...ev.script, provider });
    // The event carries this section's own usage, counted on the row of whoever is paying for it.
    if (ev.usage) await countUsage(provider, ev.usage, { model: ev.model || ev.script?.model, seconds: ev.seconds });
    // What is shared is the saved script: the descriptions this listener marked as wrong are already out of it (PRIVACY.md).
    if (event === 'done' && provider === 'cloud') shareScript(videoId, lang, saved).catch(() => {});
  }
  // A job that ended in an error, or was stopped, may still have been billed for a reply it could not use.
  if ((event === 'error' || event === 'stopped') && ev.usage) await countUsage(provider, ev.usage, { model: ev.model });
  if (event === 'model') {
    console.info(`[SceneVoice] switched to ${ev.model} (${ev.reason})`);
    // A model this key cannot use any more is replaced for good; an overloaded one is only skipped this time.
    if (ev.reason === 'model-not-found') await setLocal({ model: ev.model }).catch(() => {});
  }
  const { type, script, usage, ...rest } = ev;
  await broadcast({ ...rest, type: MSG.GEN_EVENT, cueCount: saved?.cues?.length ?? null, completedUntil: saved?.completedUntil ?? null });
  if (['done', 'error', 'stopped'].includes(event)) scheduleIdleClose();
}

// ---------- messages ----------

/**
 * Open the settings page. Named a provider, it opens at that provider's key
 * field (options.html#gemini / #qwen) or at the SceneVoice Cloud block
 * (#cloud), so a listener sent there for a missing key lands on the control to
 * use, not at the top of a long page.
 */
async function openOptions(provider) {
  if (provider === 'gemini' || provider === 'qwen' || provider === 'cloud') {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${provider}`) });
      return;
    } catch {
      // Fall back to the plain settings page.
    }
  }
  await chrome.runtime.openOptionsPage();
}

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
      const keys = keysOf(local);
      const settings = await getSettings();
      // Only whether each key exists: never the key itself. `providers` is the
      // model that will describe each site, given the keys there are.
      return {
        hasKey: keys.gemini,
        keys,
        providers: { youtube: effectiveProvider(settings, 'youtube', keys), bilibili: effectiveProvider(settings, 'bilibili', keys) },
        model: local.model,
        shortcuts: await shortcuts(),
      };
    }
    case MSG.GET_SCRIPT:
      if (!ownVideo(msg.videoId, msg.lang, senderPlatform(sender))) return { script: null };
      return { script: await getScript(msg.videoId, msg.lang) };
    case MSG.DELETE_SCRIPT:
      if (!ownVideo(msg.videoId, msg.lang, senderPlatform(sender))) return { error: 'unknown' };
      await stopGeneration(msg).catch(() => {});
      await deleteScript(msg.videoId, msg.lang);
      return { ok: true };
    case MSG.GEN_START:
      return startGeneration(msg, sender);
    case MSG.GEN_STOP:
      if (!ownVideo(msg.videoId, msg.lang, senderPlatform(sender))) return { stopped: false };
      return stopGeneration(msg);
    case MSG.GEN_STATUS:
      if (!ownVideo(msg.videoId, msg.lang, senderPlatform(sender))) return { status: 'idle' };
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
      await openOptions(msg.provider);
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
