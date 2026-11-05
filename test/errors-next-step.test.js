// @vitest-environment jsdom
// When generation fails part-way, the user hears what went wrong, what is saved
// and how to carry on; a lost connection is resumed by itself once the computer
// is back online; and after an error the shortcut carries on from where it
// stopped instead of switching descriptions off. Real content script, fake service worker.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MSG } from '../src/shared/constants.js';
import { fakeChrome } from './fake-chrome.js';

const ID = 'netDropAAAA';
const cue = { start: 5, gap: 3, kind: 'visual', priority: 1, brief: 'A dog.', standard: 'A dog runs.', detailed: 'A brown dog runs on a beach.' };
const partial = { version: 2, videoId: ID, lang: 'en', duration: 900, cues: [cue], characters: [], completedUntil: 300, complete: false, model: 'gemini-test' };

let fake;
let said;
let saved = null;
/** What the fake service worker answers a request to start with; null = a job started. */
let startRefusal = null;
const listeners = [];
const sender = () => ({ id: fake.chrome.runtime.id });
const sent = (type) => fake.sent.filter((m) => m.type === type);

function tabState() {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_STATE }, sender(), resolve);
  });
}
function command(name) {
  for (const fn of listeners) fn({ type: MSG.COMMAND, command: name }, sender(), () => {});
}
/** An action from the popup; resolves with the tab's state afterwards. */
function action(name) {
  return new Promise((resolve) => {
    for (const fn of listeners) fn({ type: MSG.TAB_ACTION, action: name }, sender(), resolve);
  });
}
function genEvent(ev) {
  for (const fn of listeners) fn({ type: MSG.GEN_EVENT, videoId: ID, lang: 'en', ...ev }, sender(), () => {});
}

beforeAll(async () => {
  jsdom.reconfigure({ url: `https://www.youtube.com/watch?v=${ID}` });
  document.body.innerHTML = `
    <ytd-watch-metadata><h1>Dogs</h1></ytd-watch-metadata>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div class="ytp-right-controls"></div></div>`;
  const video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => true, configurable: true });
  Object.defineProperty(video, 'duration', { get: () => 900, configurable: true });
  Object.defineProperty(video, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });

  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
  fake = fakeChrome({
    reply: (msg) => {
      if (msg.type === MSG.GET_STATUS) return { hasKey: true, shortcuts: { 'toggle-descriptions': 'Alt+Shift+D' } };
      if (msg.type === MSG.GET_SCRIPT) return { script: saved };
      if (msg.type === MSG.GEN_STATUS) return { status: 'idle' };
      if (msg.type === MSG.GEN_START) return startRefusal || { status: 'generating', done: saved ? 1 : 0, total: 3, chunkStartedAt: Date.now(), chunkMs: [] };
      return {};
    },
  });
  fake.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
  globalThis.chrome = fake.chrome;

  const { Announcer } = await import('../src/content/announcer.js');
  const spoken = [];
  const announce = Announcer.prototype.announceToScreenReader;
  Announcer.prototype.announceToScreenReader = function record(text, urgent) {
    spoken.push(text);
    return announce.call(this, text, urgent);
  };
  said = () => spoken;
  await import('../src/content/index.js');
  await vi.waitFor(async () => expect((await tabState()).status).toBe('none'), { timeout: 3000 });
});

describe('an error part-way through', () => {
  it('says what went wrong, what is saved, how to carry on, and that a lost connection resumes by itself', async () => {
    command('toggle-descriptions');
    await vi.waitFor(() => expect(sent(MSG.GEN_START)).toHaveLength(1), { timeout: 5000 });
    saved = partial;
    genEvent({ event: 'chunk', done: 1, total: 3, chunkStartedAt: Date.now(), chunkMs: [30000] });
    await vi.waitFor(async () => expect((await tabState()).cueCount).toBe(1));
    genEvent({ event: 'error', code: 'network' });
    await vi.waitFor(() =>
      expect(said().at(-1)).toBe(
        'Could not reach the Gemini API. Check your internet connection or the API address in settings. SceneVoice carries on by itself when the connection is back. Descriptions for the first 5 minutes are saved. Press Alt+Shift+D to carry on from where it stopped.',
      ),
    );
    expect((await tabState()).status).toBe('partial');
  });

  it('carries on by itself when the computer is back online', async () => {
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(sent(MSG.GEN_START)).toHaveLength(2));
    expect(said()).toContain('Back online. Carrying on with the descriptions.');
    await vi.waitFor(async () => expect((await tabState()).status).toBe('generating'));
  });

  it('after another error, the shortcut carries on instead of switching descriptions off', async () => {
    genEvent({ event: 'error', code: 'quota' });
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/quota is used up.*Press Alt\+Shift\+D to carry on from where it stopped\.$/));
    command('toggle-descriptions');
    await vi.waitFor(() => expect(sent(MSG.GEN_START)).toHaveLength(3));
    expect(fake.areas.sync.settings?.enabled ?? true).toBe(true);
    // Not a lost connection: coming back online does nothing more.
    genEvent({ event: 'error', code: 'quota' });
    await vi.waitFor(async () => expect((await tabState()).status).toBe('partial'));
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 200));
    expect(sent(MSG.GEN_START)).toHaveLength(3);
  });

  it("after this minute's rate limit, the shortcut carries on too; the day's quota names another model instead", async () => {
    command('toggle-descriptions');
    await vi.waitFor(() => expect(sent(MSG.GEN_START)).toHaveLength(4));
    genEvent({ event: 'error', code: 'rate-limited' });
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/^Too many requests to Gemini in a short time\..*Press Alt\+Shift\+D to carry on from where it stopped\.$/));
    command('toggle-descriptions');
    await vi.waitFor(() => expect(sent(MSG.GEN_START)).toHaveLength(5));
    genEvent({ event: 'error', code: 'quota-daily' });
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/^Today’s Gemini quota for this model is used up/));
    // Tomorrow's quota is not a reason to press again: no "carry on" offered.
    expect(said().at(-1)).not.toMatch(/Press Alt\+Shift\+D/);
  });

  it("says the day's limit, with the limit set, when the shortcut starts descriptions; a second press is answered too", async () => {
    // A video with no descriptions yet, descriptions on, and a limit of an hour.
    saved = null;
    expect((await action('delete')).cueCount).toBe(0);
    await fake.chrome.storage.sync.set({ settings: { enabled: true, dailyBudgetSeconds: 3600 } });
    // The page hears of the change on the next tick (storage.onChanged), as in Chrome.
    await new Promise((r) => setTimeout(r, 20));
    startRefusal = { error: 'budget' };
    const before = sent(MSG.GEN_START).length;
    command('toggle-descriptions');
    await vi.waitFor(() => expect(said().at(-1)).toBe('Today’s limit of 1 hour is reached. Change it in settings, or carry on tomorrow.'));
    expect(sent(MSG.GEN_START)).toHaveLength(before + 1);
    expect((await tabState()).status).toBe('error');
    // Not a reason to press again, so no "carry on" is offered; descriptions are not switched off either.
    expect(fake.areas.sync.settings.enabled).toBe(true);
    // The listener presses again (to raise the limit they go to settings): asked again, told again.
    command('toggle-descriptions');
    await vi.waitFor(() => expect(sent(MSG.GEN_START)).toHaveLength(before + 2));
    await vi.waitFor(() => expect(said().filter((s) => s.startsWith('Today’s limit of 1 hour')).length).toBe(2));
    startRefusal = null;
  });

  it('says when the SceneVoice Cloud allowance comes back, from the reply when it says so', async () => {
    startRefusal = { error: 'allowance', detail: 'used up', resetAt: '2026-11-05T00:00:00Z' };
    command('toggle-descriptions');
    const at = new Date('2026-11-05T00:00:00Z').toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    await vi.waitFor(() => expect(said().at(-1)).toBe(`Your free SceneVoice allowance for today is used up. It resets at ${at}. Use your own key in settings, or upgrade.`));
    startRefusal = { error: 'allowance' };
    command('toggle-descriptions');
    await vi.waitFor(() => expect(said().at(-1)).toBe('Your free SceneVoice allowance for today is used up. It resets at midnight UTC. Use your own key in settings, or upgrade.'));
    startRefusal = null;
  });
});
