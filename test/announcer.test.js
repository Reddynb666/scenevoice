// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from './fake-chrome.js';

let Announcer;
let settings;

beforeEach(async () => {
  vi.useFakeTimers();
  globalThis.chrome = fakeChrome().chrome;
  document.body.innerHTML = '';
  settings = { output: 'screenreader', readerSpeed: 1.6, interrupt: false, announceStatus: true, ttsRate: 1.2, ttsPitch: 1 };
  vi.resetModules();
  ({ Announcer } = await import('../src/content/announcer.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

const regionTexts = () => [...document.querySelectorAll('[data-scenevoice="live"]')].map((el) => el.textContent).filter(Boolean);

describe('live region writes', () => {
  it('delivers two status messages sent in the same moment, one after the other', () => {
    const a = new Announcer(() => settings);
    a.status('Descriptions loaded.');
    a.status('Tutorial: pausing for detailed descriptions.');
    vi.advanceTimersByTime(40);
    expect(regionTexts()).toEqual(['Descriptions loaded.']);
    vi.advanceTimersByTime(100);
    expect(regionTexts()).toEqual(['Tutorial: pausing for detailed descriptions.']);
  });

  it('puts urgent text in an assertive region and the rest in a polite one', () => {
    const a = new Announcer(() => settings);
    a.say('A woman enters.', { urgent: true });
    vi.advanceTimersByTime(40);
    const [el] = [...document.querySelectorAll('[data-scenevoice="live"]')].filter((r) => r.textContent);
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });

  it('forgets what was waiting when stopped', () => {
    const a = new Announcer(() => settings);
    a.status('First.');
    a.status('Second.');
    a.stop();
    vi.advanceTimersByTime(500);
    expect(regionTexts()).toEqual([]);
  });
});

describe('the language of each write', () => {
  const filled = () => [...document.querySelectorAll('[data-scenevoice="live"]')].find((el) => el.textContent);

  it('is the description language for a description and the interface language for status and feedback', () => {
    const a = new Announcer(() => settings);
    a.lang = 'it';
    a.say('Una donna entra.');
    vi.advanceTimersByTime(40);
    expect(filled().getAttribute('lang')).toBe('it');
    expect(filled().textContent).toBe('Una donna entra.');
    a.status('Creating descriptions…');
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('en');
    // Direct writes (feedback, errors) are interface text unless said otherwise.
    a.announceToScreenReader('Descriptions off.', false);
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('en');
    a.announceToScreenReader('Risposta.', false, { lang: 'it' });
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('it');
  });

  it('splits "Earlier:" from the description it leads, each in its own language, as one announcement', () => {
    const a = new Announcer(() => settings);
    a.lang = 'it';
    a.say('Earlier: Una donna entra.', { lead: 'Earlier: ' });
    vi.advanceTimersByTime(40);
    const region = filled();
    expect(region.hasAttribute('lang')).toBe(false);
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect([...region.children].map((el) => [el.getAttribute('lang'), el.textContent])).toEqual([
      ['en', 'Earlier: '],
      ['it', 'Una donna entra.'],
    ]);
    expect(region.textContent).toBe('Earlier: Una donna entra.');
    // Same language on both sides: one plain write.
    a.lang = 'en';
    a.say('Earlier: A woman enters.', { lead: 'Earlier: ' });
    vi.advanceTimersByTime(100);
    expect(filled().getAttribute('lang')).toBe('en');
    expect(filled().children).toHaveLength(0);
  });

  it('gives the built-in voice the interface language for status text and the description language for descriptions', () => {
    const fake = fakeChrome();
    globalThis.chrome = fake.chrome;
    settings = { ...settings, output: 'tts', ttsVoices: { it: 'Alice', en: 'Daniel' } };
    const a = new Announcer(() => settings);
    a.lang = 'it';
    a.status('Creating descriptions…');
    a.say('Una donna entra.');
    const spoken = fake.sent.filter((m) => m.type === 'sv:speak');
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toMatchObject({ text: 'Creating descriptions…', lang: 'en', voice: 'Daniel' });
    expect(spoken[1]).toMatchObject({ text: 'Una donna entra.', lang: 'it', voice: 'Alice' });
  });
});

describe('built-in voice in a hidden tab', () => {
  const hide = () => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  let sent;
  const spoken = () => sent.filter((m) => m.type === 'sv:speak');

  beforeEach(() => {
    const fake = fakeChrome();
    globalThis.chrome = fake.chrome;
    sent = fake.sent;
    settings = { ...settings, output: 'tts' };
  });

  it('waits silently when its video is paused or muted, so it does not talk over the tab being watched', () => {
    hide();
    const a = new Announcer(() => settings, { isAudible: () => false });
    const done = vi.fn();
    a.say('A woman enters.').then(done);
    expect(spoken()).toHaveLength(0);
    expect(a.speaking).toBe(false);
    // The wait stands in for the speech, so the scheduler is not thrown off.
    return vi.advanceTimersByTimeAsync(5000).then(() => expect(done).toHaveBeenCalled());
  });

  it('speaks when its video is playing with sound, hidden or not', () => {
    hide();
    const a = new Announcer(() => settings, { isAudible: () => true });
    a.say('A woman enters.');
    expect(spoken()).toHaveLength(1);
    expect(spoken()[0]).toMatchObject({ text: 'A woman enters.', rate: 1.2 });
  });

  it('speaks in a visible tab whatever the video is doing', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const a = new Announcer(() => settings, { isAudible: () => false });
    a.say('A woman enters.');
    expect(spoken()).toHaveLength(1);
  });
});
