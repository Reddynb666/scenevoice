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
