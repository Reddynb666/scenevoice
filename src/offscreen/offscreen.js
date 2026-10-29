// Offscreen document: hosts the worker that talks to Gemini (see worker.js) and
// bridges it to the service worker over chrome.runtime messages.
//
// Only chrome.runtime is available here, so the service worker supplies the
// API key and saved script with each job and writes results to the cache.

import { MSG } from '../shared/constants.js';

const worker = new Worker(chrome.runtime.getURL('offscreen-worker.js'), { type: 'classic' });
const pending = new Map();
let seq = 0;

/** Send a command to the worker and wait for its reply. */
function call(data) {
  const id = (seq += 1);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, ...data });
  });
}

worker.onmessage = ({ data }) => {
  if (data?.id != null) {
    const { id, ...reply } = data;
    pending.get(id)?.(reply);
    pending.delete(id);
    return;
  }
  if (data?.event) {
    chrome.runtime.sendMessage({ type: MSG.JOB_EVENT, ...data }).catch(() => {});
  }
};

worker.onerror = (ev) => {
  console.error('[SceneVoice] worker error', ev.message);
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== MSG.OFFSCREEN) return false;
  call(msg.data).then(sendResponse);
  return true;
});
