// Preload of the test shell: the only bridge between the page and the main
// process. It runs sandboxed (so it is CommonJS and may require nothing but
// `electron`) and exposes one small object, window.sv. The channel names come
// from ipc/contract.js through the window's additionalArguments, so the page
// can reach the channels of the contract and no others; the main process
// validates every message again.

const { contextBridge, ipcRenderer } = require('electron');

function argument(name) {
  const prefix = `--sv-${name}=`;
  const hit = process.argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const list = (name) => new Set(argument(name).split(',').filter(Boolean));
const invokes = list('invoke');
const sends = list('send');
const events = list('event');

contextBridge.exposeInMainWorld('sv', {
  /** Interface language chosen by the main process from the system locale: 'zh_CN' or 'en'. */
  lang: argument('lang'),
  platform: process.platform,
  selftest: argument('selftest') === '1' || argument('selftest') === '2',
  selftestTiming: argument('selftest') === '2',
  /** Whether this build carries the sample clip. */
  sample: argument('sample') === '1',
  /** Ask the main process and wait for the answer. */
  invoke(channel, payload) {
    if (!invokes.has(channel)) return Promise.reject(new Error(`unknown channel ${String(channel)}`));
    return ipcRenderer.invoke(channel, payload);
  },
  /** Tell the main process, one way. */
  send(channel, payload) {
    if (sends.has(channel)) ipcRenderer.send(channel, payload);
  },
  /** Listen to the main process. The listener gets the payload only, never the event. */
  on(channel, listener) {
    if (!events.has(channel) || typeof listener !== 'function') return;
    ipcRenderer.on(channel, (_event, payload) => listener(payload));
  },
});
