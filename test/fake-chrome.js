// A small stand-in for the chrome.* APIs the extension pages use, for tests.
// Storage keeps values in memory and reports changes like Chrome does
// (asynchronously, to every onChanged listener); i18n reads scripts/locales.mjs.

import { STRINGS } from '../scripts/locales.mjs';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * @param {object} opts
 * @param {'en'|'zh_CN'} [opts.locale]  interface language for chrome.i18n.getMessage
 * @param {string} [opts.uiLanguage]    chrome.i18n.getUILanguage()
 * @param {object} [opts.sync]          initial chrome.storage.sync contents
 * @param {object} [opts.local]         initial chrome.storage.local contents
 * @param {(msg: object) => any} [opts.reply]  answers chrome.runtime.sendMessage
 * @param {object[]} [opts.commands]    chrome.commands.getAll()
 * @param {(msg: object) => any} [opts.tabReply]  answers chrome.tabs.sendMessage, as a YouTube tab would;
 *   without it the active tab has no content script
 */
export function fakeChrome({ locale = 'en', uiLanguage = 'en-US', sync = {}, local = {}, reply = () => ({}), commands = [], tabReply = null } = {}) {
  const areas = { sync: clone(sync), local: clone(local) };
  const listeners = new Set();
  const sent = [];
  const failures = { sync: 0 };

  const fire = (changes, name) => {
    setTimeout(() => {
      for (const fn of listeners) fn(changes, name);
    }, 0);
  };

  const area = (name) => ({
    async get(key) {
      const bag = areas[name];
      if (key == null) return clone(bag);
      const keys = typeof key === 'string' ? [key] : Array.isArray(key) ? key : Object.keys(key);
      const out = {};
      for (const k of keys) if (k in bag) out[k] = clone(bag[k]);
      return out;
    },
    async set(items) {
      if (failures[name] > 0) {
        failures[name] -= 1;
        throw new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
      }
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(areas[name][k]), newValue: clone(v) };
        areas[name][k] = clone(v);
      }
      fire(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (!(k in areas[name])) continue;
        changes[k] = { oldValue: clone(areas[name][k]) };
        delete areas[name][k];
      }
      if (Object.keys(changes).length) fire(changes, name);
    },
    async getBytesInUse() {
      return 0;
    },
    async setAccessLevel() {},
  });

  const chrome = {
    i18n: {
      getMessage(key, subs = []) {
        if (key === '@@ui_locale') return locale;
        if (key === '@@bidi_dir') return 'ltr';
        const entry = STRINGS[key];
        const text = entry?.[locale] ?? entry?.en;
        if (!text) return '';
        return text.replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? '');
      },
      getUILanguage: () => uiLanguage,
    },
    storage: {
      sync: area('sync'),
      local: area('local'),
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    },
    runtime: {
      id: 'abcdefghijklmnopqrstuvwxyzabcdef',
      async sendMessage(msg) {
        sent.push(msg);
        return reply(msg);
      },
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (path) => `chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/${path}`,
      async openOptionsPage() {},
      onMessage: { addListener() {} },
    },
    tabs: {
      async query() {
        return [{ id: 1, url: 'https://example.com/' }];
      },
      async sendMessage(_tabId, msg) {
        if (tabReply) return tabReply(msg);
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async create() {},
    },
    commands: {
      async getAll() {
        return commands;
      },
    },
    permissions: {
      async request() {
        return true;
      },
    },
  };

  return {
    chrome,
    areas,
    sent,
    /** Make the next n writes to chrome.storage.sync fail, as when the write quota is used up. */
    failSyncWrites(n = 1) {
      failures.sync = n;
    },
  };
}
