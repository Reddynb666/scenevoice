import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG, SCRIPT_VERSION } from '../src/shared/constants.js';
import { authorizeBackgroundMessage, authorizeContentMessage, authorizeOffscreenMessage, classifySender } from '../src/shared/sender.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'abcdefghijklmnopqrstuvwxyzabcdef';
const ORIGIN = `chrome-extension://${ID}`;

const serviceWorker = { id: ID, origin: ORIGIN };
const serviceWorkerScript = { id: ID, origin: ORIGIN, url: `${ORIGIN}/background.js` };
const offscreen = { id: ID, origin: ORIGIN, url: `${ORIGIN}/offscreen.html` };
const popup = { id: ID, origin: ORIGIN, url: `${ORIGIN}/popup.html` };
const optionsTab = {
  id: ID,
  origin: ORIGIN,
  url: `${ORIGIN}/options.html`,
  tab: { id: 4, url: `${ORIGIN}/options.html` },
};
const transcript = { id: ID, origin: ORIGIN, url: `${ORIGIN}/transcript.html`, tab: { id: 5, url: `${ORIGIN}/transcript.html` } };
const youtube = {
  id: ID,
  origin: 'https://www.youtube.com',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  tab: { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  frameId: 0,
};
const mobile = {
  id: ID,
  origin: 'https://m.youtube.com',
  url: 'https://m.youtube.com/watch?v=abcdefghijk',
  tab: { id: 8, url: 'https://m.youtube.com/watch?v=abcdefghijk#t=12' },
  frameId: 0,
};
const embed = {
  id: ID,
  origin: 'https://www.youtube-nocookie.com',
  url: 'https://www.youtube-nocookie.com/embed/abcdefghijk',
  tab: { id: 9, url: 'https://example.com/article' },
  frameId: 2,
};
const external = { id: 'other-extension-id-xxxxxxxxxxxx', origin: ORIGIN, url: `${ORIGIN}/popup.html` };
const webPage = {
  id: ID,
  origin: 'https://evil.example',
  url: 'https://evil.example/watch?v=abcdefghijk',
  tab: { id: 10, url: 'https://evil.example/watch?v=abcdefghijk' },
  frameId: 0,
};
const mismatchedTab = {
  id: ID,
  origin: 'https://www.youtube.com',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  tab: { id: 11, url: 'https://evil.example/' },
  frameId: 0,
};

const kinds = {
  serviceWorker,
  serviceWorkerScript,
  offscreen,
  popup,
  optionsTab,
  transcript,
  youtube,
  mobile,
  embed,
  external,
  webPage,
  mismatchedTab,
};

function allowed(check, type, ...names) {
  for (const [name, sender] of Object.entries(kinds)) {
    expect(check(type, sender, ID), name).toBe(names.includes(name));
  }
  expect(check(type, null, ID)).toBe(false);
  expect(check(type, {}, ID)).toBe(false);
  expect(check(type, youtube, '')).toBe(false);
  expect(check(type, { ...youtube, id: undefined }, ID)).toBe(false);
}

describe('sender classification', () => {
  it('recognises the service worker with or without a script url', () => {
    expect(classifySender(serviceWorker, ID)).toBe('service-worker');
    expect(classifySender(serviceWorkerScript, ID)).toBe('service-worker');
    expect(classifySender({ id: ID }, ID)).toBe('service-worker');
  });

  it('recognises extension pages, including ones open in a tab', () => {
    expect(classifySender(popup, ID)).toBe('extension-page');
    expect(classifySender(optionsTab, ID)).toBe('extension-page');
    expect(classifySender(transcript, ID)).toBe('extension-page');
    expect(classifySender(offscreen, ID)).toBe('offscreen');
  });

  it('recognises YouTube content scripts and rejects lookalikes', () => {
    expect(classifySender(youtube, ID)).toBe('youtube-content');
    expect(classifySender(mobile, ID)).toBe('youtube-content');
    expect(classifySender(embed, ID)).toBe('youtube-content');
    expect(classifySender(webPage, ID)).toBe('rejected');
    expect(classifySender(mismatchedTab, ID)).toBe('rejected');
    expect(classifySender(external, ID)).toBe('external');
    const bare = { ...youtube, url: 'https://youtube.com/watch?v=abcdefghijk', origin: 'https://youtube.com' };
    expect(classifySender(bare, ID)).toBe('rejected');
    const watchOnNocookie = {
      ...embed,
      url: 'https://www.youtube-nocookie.com/watch?v=abcdefghijk',
      origin: 'https://www.youtube-nocookie.com',
      frameId: 0,
      tab: { id: 9, url: 'https://www.youtube-nocookie.com/watch?v=abcdefghijk' },
    };
    expect(classifySender(watchOnNocookie, ID)).toBe('rejected');
  });

  it('rejects a YouTube frame whose origin does not match its url', () => {
    const spoofed = { ...youtube, origin: 'https://evil.example' };
    expect(classifySender(spoofed, ID)).toBe('rejected');
  });
});

describe('background message authorization', () => {
  it('accepts job events only from the offscreen document', () => {
    allowed(authorizeBackgroundMessage, MSG.JOB_EVENT, 'offscreen');
  });

  it('accepts tab actions that spend quota or read the cache only from YouTube', () => {
    for (const type of [MSG.GEN_START, MSG.GEN_STOP, MSG.GEN_STATUS, MSG.ASK, MSG.GET_SCRIPT, MSG.DELETE_SCRIPT, MSG.OPEN_OPTIONS, MSG.STOP_SPEAKING]) {
      allowed(authorizeBackgroundMessage, type, 'youtube', 'mobile', 'embed');
    }
  });

  it('accepts status and speech from the tab and from extension pages', () => {
    allowed(authorizeBackgroundMessage, MSG.GET_STATUS, 'youtube', 'mobile', 'embed', 'popup', 'optionsTab', 'transcript');
    allowed(authorizeBackgroundMessage, MSG.SPEAK, 'youtube', 'mobile', 'embed', 'popup', 'optionsTab', 'transcript');
  });

  it('accepts voices and cache changes only from extension pages', () => {
    for (const type of [MSG.GET_VOICES, MSG.CACHE_INFO, MSG.CACHE_CLEAR]) {
      allowed(authorizeBackgroundMessage, type, 'popup', 'optionsTab', 'transcript');
    }
  });

  it('does not handle messages aimed at other contexts', () => {
    for (const type of [MSG.OFFSCREEN, MSG.COMMAND, MSG.GEN_EVENT, MSG.TTS_EVENT, MSG.TAB_STATE, MSG.TAB_ACTION, 'sv:made-up']) {
      allowed(authorizeBackgroundMessage, type);
    }
  });
});

describe('content script message authorization', () => {
  it('accepts worker events only from the service worker', () => {
    for (const type of [MSG.COMMAND, MSG.GEN_EVENT, MSG.TTS_EVENT]) {
      allowed(authorizeContentMessage, type, 'serviceWorker', 'serviceWorkerScript');
    }
  });

  it('accepts popup actions from extension pages and the service worker', () => {
    for (const type of [MSG.TAB_STATE, MSG.TAB_ACTION]) {
      allowed(authorizeContentMessage, type, 'serviceWorker', 'serviceWorkerScript', 'popup', 'optionsTab', 'transcript');
    }
  });

  it('ignores cache and job messages', () => {
    allowed(authorizeContentMessage, MSG.JOB_EVENT);
    allowed(authorizeContentMessage, MSG.CACHE_CLEAR);
    allowed(authorizeContentMessage, MSG.GET_SCRIPT);
  });
});

describe('offscreen message authorization', () => {
  it('accepts worker commands only from the service worker', () => {
    allowed(authorizeOffscreenMessage, MSG.OFFSCREEN, 'serviceWorker', 'serviceWorkerScript');
  });

  it('rejects every other type, including from the service worker', () => {
    allowed(authorizeOffscreenMessage, MSG.JOB_EVENT);
    allowed(authorizeOffscreenMessage, MSG.ASK);
    expect(authorizeOffscreenMessage(MSG.OFFSCREEN, offscreen, ID)).toBe(false);
    expect(authorizeOffscreenMessage(MSG.OFFSCREEN, youtube, ID)).toBe(false);
  });
});

describe('listeners are wired to the checks', () => {
  const source = (path) => readFileSync(join(root, path), 'utf8');

  it('the service worker restricts storage and checks the sender', () => {
    const text = source('src/background/index.js');
    expect(text).toContain('protectLocalStorage()');
    expect(text).toContain('onStartup');
    expect(text).toMatch(/if \(msg\.type === MSG\.OFFSCREEN\) return false;[\s\S]*authorizeBackgroundMessage\(/);
  });

  it('content scripts do not touch local storage', () => {
    for (const file of ['index.js', 'announcer.js', 'generator.js', 'ui.js', 'youtube.js']) {
      const text = source(join('src/content', file));
      expect(text, file).not.toMatch(/chrome\.storage\.local\s*\./);
      expect(text, file).not.toMatch(/from ['"][^'"]*cache\.js['"]/);
    }
    expect(source('src/content/index.js')).toContain('MSG.GET_SCRIPT');
    expect(source('src/content/announcer.js')).toContain('authorizeContentMessage');
  });

  it('preference helpers shared with content scripts use sync storage only', () => {
    for (const file of ['settings.js', 'voices.js', 'labels.js', 'form.js']) {
      const text = source(join('src/shared', file));
      expect(text, file).not.toMatch(/chrome\.storage\.local/);
      expect(text, file).not.toMatch(/apiKey/);
    }
    // Restoring defaults clears preferences, never the key or the cache.
    expect(source('src/shared/storage.js')).toMatch(/export function resetSettings\(\) \{[\s\S]*?chrome\.storage\.sync\.remove\('settings'\)[\s\S]*?\n\}/);
    expect(source('src/shared/storage.js')).not.toMatch(/chrome\.storage\.local\.(remove|clear)/);
  });

  it('the offscreen document and its worker check where commands come from', () => {
    const offscreen = source('src/offscreen/offscreen.js');
    expect(offscreen).toContain('authorizeOffscreenMessage');
    expect(offscreen).toContain('unknown-command');
    const worker = source('src/offscreen/worker.js');
    expect(worker).toContain('only caller');
    expect(worker).toContain("cmd === 'ask'");
  });
});

describe('local storage access', () => {
  let areas;
  let setCalls;
  let removeCalls;

  beforeEach(() => {
    areas = { local: {}, sync: {} };
    setCalls = [];
    removeCalls = [];
    const area = (name) => ({
      async get(key) {
        const bag = areas[name];
        if (key == null) return { ...bag };
        if (typeof key === 'string') return { [key]: bag[key] };
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) out[k] = bag[k];
          return out;
        }
        return {};
      },
      async set(items) {
        setCalls.push({ area: name, items });
        Object.assign(areas[name], items);
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        removeCalls.push({ area: name, keys: list });
        for (const k of list) delete areas[name][k];
      },
      async getBytesInUse() {
        return 12;
      },
      async setAccessLevel(opts) {
        areas[name].__access = opts.accessLevel;
      },
    });
    globalThis.chrome = {
      storage: {
        local: area('local'),
        sync: area('sync'),
        onChanged: { addListener() {}, removeListener() {} },
      },
    };
  });

  it('limits local storage to trusted contexts without moving the key or the cache', async () => {
    const { protectLocalStorage, getLocal, setLocal } = await import('../src/shared/storage.js');
    const { getScript } = await import('../src/shared/cache.js');
    areas.local.local = { apiKey: 'secret-key', model: 'gemini-2.5-flash', apiBase: 'https://generativelanguage.googleapis.com' };
    areas.local['script:abcdefghijk:en'] = { version: SCRIPT_VERSION, videoId: 'abcdefghijk', lang: 'en', cues: [{ standard: 'Chef Lin enters.' }] };
    areas.local.scriptIndex = { 'script:abcdefghijk:en': 1 };

    await protectLocalStorage();
    await protectLocalStorage();

    expect(areas.local.__access).toBe('TRUSTED_CONTEXTS');
    expect(setCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
    expect(areas.local.local.apiKey).toBe('secret-key');
    expect(areas.local['script:abcdefghijk:en'].cues[0].standard).toBe('Chef Lin enters.');

    const local = await getLocal();
    expect(local.apiKey).toBe('secret-key');
    expect(local.model).toBe('gemini-2.5-flash');
    const script = await getScript('abcdefghijk', 'en');
    expect(script.cues[0].standard).toBe('Chef Lin enters.');
    expect(JSON.stringify(script)).not.toContain('secret-key');

    // A lookup cannot be aimed at the secret record: keys are prefixed.
    expect(await getScript('local', '')).toBeNull();
    expect(areas.local.local.apiKey).toBe('secret-key');

    const saved = await setLocal({ model: 'gemini-2.0-flash' });
    expect(saved.apiKey).toBe('secret-key');
    expect(areas.local.local.apiKey).toBe('secret-key');
    expect(areas.sync.local).toBeUndefined();
  });

  it('keeps non-secret preferences in sync storage', async () => {
    const { getSettings, setSettings } = await import('../src/shared/storage.js');
    const saved = await setSettings({ enabled: false, mode: 'manual' });
    expect(saved.enabled).toBe(false);
    expect(areas.sync.settings.mode).toBe('manual');
    expect(areas.local.settings).toBeUndefined();
    expect(areas.local.local).toBeUndefined();
    const again = await getSettings();
    expect(again.mode).toBe('manual');
    expect(again.detail).toBe('standard');
  });

  it('does not grant content scripts access back', async () => {
    const { protectLocalStorage } = await import('../src/shared/storage.js');
    const setAccessLevel = vi.fn(async () => {});
    chrome.storage.local.setAccessLevel = setAccessLevel;
    await protectLocalStorage();
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(setAccessLevel).not.toHaveBeenCalledWith({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  });
});
