import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';

const ID = 'abcdefghijklmnopqrstuvwxyzabcdef';
const ORIGIN = `chrome-extension://${ID}`;
const youtube = {
  id: ID,
  origin: 'https://www.youtube.com',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  tab: { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  frameId: 0,
};
const popup = { id: ID, origin: ORIGIN, url: `${ORIGIN}/popup.html` };
const webPage = { ...youtube, origin: 'https://evil.example', url: 'https://evil.example/', tab: { id: 9, url: 'https://evil.example/' } };

let onMessage;
const speak = vi.fn();
const accessLevels = [];
let installed = [];

beforeAll(async () => {
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async ({ accessLevel }) => accessLevels.push(accessLevel), get: async () => ({}) } },
    runtime: {
      id: ID,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => (onMessage = fn) },
      sendMessage: vi.fn(async () => undefined),
    },
    commands: { onCommand: { addListener() {} }, getAll: async () => [] },
    tabs: { sendMessage: vi.fn(async () => {}), query: async () => [] },
    tts: { speak, stop: vi.fn(), getVoices: async () => installed },
    offscreen: { hasDocument: async () => false },
  };
  await import('../src/background/index.js');
});

beforeEach(() => {
  installed = [
    { voiceName: 'Tingting', lang: 'zh-CN' },
    { voiceName: 'Samantha', lang: 'en-US' },
  ];
});

/** Deliver a message the way Chrome does and wait for the reply. */
function deliver(msg, sender) {
  return new Promise((resolve) => {
    const async = onMessage(msg, sender, resolve);
    if (!async) setTimeout(() => resolve(undefined), 20);
  });
}

describe('speaking with the built-in voice', () => {
  it('passes the chosen voice, rate and pitch from the YouTube tab to chrome.tts', async () => {
    const reply = await deliver({ type: MSG.SPEAK, text: '她走进厨房。', lang: 'zh-CN', rate: 1.6, pitch: 0.8, voice: 'Tingting', voiceMustMatch: false, id: 'u1' }, youtube);
    expect(reply).toEqual({ ok: true });
    expect(speak).toHaveBeenCalledTimes(1);
    const [text, opts] = speak.mock.calls[0];
    expect(text).toBe('她走进厨房。');
    expect(opts).toMatchObject({ lang: 'zh-CN', rate: 1.6, pitch: 0.8, voiceName: 'Tingting', enqueue: false });
  });

  it('lets Chrome pick by language when the synced voice is not on this computer', async () => {
    await deliver({ type: MSG.SPEAK, text: 'Hi', lang: 'en', voice: 'Microsoft Zira', id: 'u2' }, youtube);
    expect(speak.mock.calls[0][1]).not.toHaveProperty('voiceName');
    expect(speak.mock.calls[0][1].lang).toBe('en');
  });

  it('does not use the old single voice for a language it does not speak', async () => {
    await deliver({ type: MSG.SPEAK, text: '你好', lang: 'zh-CN', voice: 'Samantha', voiceMustMatch: true, id: 'u3' }, youtube);
    expect(speak.mock.calls[0][1]).not.toHaveProperty('voiceName');
  });

  it('plays the voice test from the popup', async () => {
    await deliver({ type: MSG.SPEAK, text: 'A woman crosses the street.', lang: 'en', rate: 1.2, pitch: 1.3, voice: '', id: 'test' }, popup);
    expect(speak.mock.calls[0][1]).toMatchObject({ rate: 1.2, pitch: 1.3 });
  });

  it('still refuses speech from a page that is not YouTube', async () => {
    const reply = await deliver({ type: MSG.SPEAK, text: 'spoofed', lang: 'en', id: 'x' }, webPage);
    expect(reply).toEqual({ error: 'forbidden' });
    expect(speak).not.toHaveBeenCalled();
  });

  it('still lists voices only for extension pages', async () => {
    expect(await deliver({ type: MSG.GET_VOICES }, youtube)).toEqual({ error: 'forbidden' });
    expect(await deliver({ type: MSG.GET_VOICES }, popup)).toEqual({
      voices: [
        { name: 'Tingting', lang: 'zh-CN' },
        { name: 'Samantha', lang: 'en-US' },
      ],
    });
  });

  it('restricts local storage before answering', () => {
    expect(accessLevels).toEqual(['TRUSTED_CONTEXTS']);
  });
});
