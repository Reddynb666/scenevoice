// Service worker: text-to-speech, keyboard commands, status for the popup,
// cache housekeeping, and the hub for description generation.
//
// Gemini requests do not run here: Chrome terminates a service worker when a
// fetch takes longer than 30 seconds, and describing five minutes of video takes
// 30–90 seconds. They run in a worker inside the offscreen document
// (offscreen/worker.js), an extension page that Chrome keeps open and that has
// the extension's own host permissions. This file starts jobs there, saves each
// finished section to the cache, and tells the YouTube tabs what happened.

import { MSG } from '../shared/constants.js';
import { authorizeBackgroundMessage } from '../shared/sender.js';
import { getLocal, protectLocalStorage, setLocal } from '../shared/storage.js';
import { cacheInfo, clearCache, deleteScript, getScript, putScript } from '../shared/cache.js';

// Content scripts share the YouTube process and must not read the API key or
// the description cache. The level does not always survive a browser restart,
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

function speak({ text, lang, rate, voice, id, enqueue }, tabId) {
  const opts = {
    lang,
    rate: Math.min(4, Math.max(0.5, Number(rate) || 1)),
    enqueue: Boolean(enqueue),
    onEvent: (ev) => {
      if (['end', 'interrupted', 'cancelled', 'error'].includes(ev.type) && tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: MSG.TTS_EVENT, id, event: ev.type }).catch(() => {});
      }
    },
  };
  if (voice) opts.voiceName = voice;
  chrome.tts.speak(text, opts);
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
        justification: 'Runs the worker that sends long video-description requests to the Gemini API; such requests take longer than a service worker may wait.',
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
let busyAsks = 0;

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    try {
      if (busyAsks || !(await chrome.offscreen.hasDocument())) return;
      const reply = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN, data: { cmd: 'status' } }).catch(() => null);
      if (reply?.jobs?.length === 0) await chrome.offscreen.closeDocument();
    } catch {
      // nothing to clean up
    }
  }, IDLE_CLOSE_MS);
}

/** What the worker needs to call Gemini, or an error when no key is set. */
async function geminiConfig() {
  const local = await getLocal();
  if (!local.apiKey) return { error: 'no-key' };
  return { config: { apiKey: local.apiKey, apiBase: local.apiBase, model: local.model } };
}

const jobKey = (videoId, lang) => `${videoId}:${lang}`;

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

async function startGeneration({ videoId, duration, meta, lang, force }) {
  const { config, error } = await geminiConfig();
  if (error) return { error };
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

async function ask(params) {
  const { config, error } = await geminiConfig();
  if (error) return { error };
  busyAsks += 1;
  try {
    const reply = await offscreen({ cmd: 'ask', config, params });
    return reply || { error: 'offscreen-unavailable' };
  } finally {
    busyAsks -= 1;
    scheduleIdleClose();
  }
}

/** Events from the worker: save finished sections, then tell the tabs. */
async function onJobEvent(ev) {
  const { event, videoId, lang } = ev;
  if (event === 'chunk' || event === 'done') {
    await putScript(videoId, lang, ev.script);
  }
  if (event === 'model') {
    console.info(`[SceneVoice] switched to ${ev.model} (${ev.reason})`);
    // A model this key cannot use any more is replaced for good; an overloaded one is only skipped this time.
    if (ev.reason === 'model-not-found') await setLocal({ model: ev.model }).catch(() => {});
  }
  const { type, script, ...rest } = ev;
  await broadcast({ ...rest, type: MSG.GEN_EVENT, cueCount: script?.cues?.length ?? null, completedUntil: script?.completedUntil ?? null });
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
      return { hasKey: Boolean(local.apiKey), model: local.model, shortcuts: await shortcuts() };
    }
    case MSG.GET_SCRIPT:
      return { script: await getScript(msg.videoId, msg.lang) };
    case MSG.DELETE_SCRIPT:
      await stopGeneration(msg).catch(() => {});
      await deleteScript(msg.videoId, msg.lang);
      return { ok: true };
    case MSG.GEN_START:
      return startGeneration(msg);
    case MSG.GEN_STOP:
      return stopGeneration(msg);
    case MSG.GEN_STATUS:
      return generationStatus(msg);
    case MSG.ASK:
      return ask(msg.params);
    case MSG.JOB_EVENT:
      await onJobEvent(msg);
      return { ok: true };
    case MSG.SPEAK:
      speak(msg, sender.tab?.id ?? null);
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
