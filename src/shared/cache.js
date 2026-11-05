// Description scripts cached in chrome.storage.local, keyed by video and language.
// An index keeps last-use times so the oldest scripts can be evicted.
//
// Next to each script, the descriptions the user marked as wrong and their
// corrections (`feedback:*`). They stay on this computer, like the scripts,
// and go when their script goes.
//
// This module is for the service worker and extension pages only. Content
// scripts cannot read chrome.storage.local (see protectLocalStorage); they
// request a script with MSG.GET_SCRIPT.

import { CACHE_LIMIT, FEEDBACK_LIMIT, SCRIPT_VERSION } from './constants.js';

const INDEX_KEY = 'scriptIndex';
const keyFor = (videoId, lang) => `script:${videoId}:${lang}`;
const feedbackKeyFor = (videoId, lang) => `feedback:${videoId}:${lang}`;
/** The feedback key that belongs with a script key. */
const feedbackOf = (scriptKey) => scriptKey.replace(/^script:/, 'feedback:');

async function readIndex() {
  const { [INDEX_KEY]: index } = await chrome.storage.local.get(INDEX_KEY);
  return index && typeof index === 'object' ? index : {};
}

export async function getScript(videoId, lang) {
  const key = keyFor(videoId, lang);
  const { [key]: script } = await chrome.storage.local.get(key);
  if (!script || script.version !== SCRIPT_VERSION) return null;
  const index = await readIndex();
  index[key] = Date.now();
  await chrome.storage.local.set({ [INDEX_KEY]: index });
  return script;
}

export async function putScript(videoId, lang, script) {
  const key = keyFor(videoId, lang);
  const index = await readIndex();
  index[key] = Date.now();
  const keys = Object.keys(index);
  const toRemove = [];
  if (keys.length > CACHE_LIMIT) {
    keys
      .sort((a, b) => index[a] - index[b])
      .slice(0, keys.length - CACHE_LIMIT)
      .forEach((k) => {
        if (k !== key) {
          delete index[k];
          toRemove.push(k, feedbackOf(k));
        }
      });
  }
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
  await chrome.storage.local.set({ [key]: script, [INDEX_KEY]: index });
}

export async function deleteScript(videoId, lang) {
  const key = keyFor(videoId, lang);
  const index = await readIndex();
  delete index[key];
  await chrome.storage.local.remove([key, feedbackKeyFor(videoId, lang)]);
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}

/**
 * Descriptions marked as wrong for one video and language, oldest first:
 * [{ at, start, kind, standard, status: 'revised'|'removed'|'failed', replacement?, error? }]
 */
export async function getFeedback(videoId, lang) {
  const key = feedbackKeyFor(videoId, lang);
  const { [key]: list } = await chrome.storage.local.get(key);
  return Array.isArray(list) ? list : [];
}

/** Remember a description marked as wrong. Only the newest FEEDBACK_LIMIT are kept. */
export async function addFeedback(videoId, lang, record) {
  const key = feedbackKeyFor(videoId, lang);
  const list = [...(await getFeedback(videoId, lang)), record].slice(-FEEDBACK_LIMIT);
  await chrome.storage.local.set({ [key]: list });
  return list;
}

export async function cacheInfo() {
  const index = await readIndex();
  let bytes = 0;
  try {
    bytes = await chrome.storage.local.getBytesInUse(null);
  } catch {
    bytes = 0;
  }
  return { count: Object.keys(index).length, bytes };
}

export async function clearCache() {
  const index = await readIndex();
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('script:') || k.startsWith('feedback:'));
  await chrome.storage.local.remove([...new Set([...keys, ...Object.keys(index)])]);
  await chrome.storage.local.set({ [INDEX_KEY]: {} });
}
