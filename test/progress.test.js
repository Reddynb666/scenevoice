// When generation progress is said: at each quarter, never within 20 seconds of
// the last generation message, a quarter passed too soon said once, later.

import { describe, expect, it } from 'vitest';
import { progressMilestone } from '../src/shared/progress.js';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { normalizeSettings } from '../src/shared/settings.js';

const S = 1000;

describe('progressMilestone', () => {
  it('says each quarter once', () => {
    expect(progressMilestone({ fraction: 0.1, said: 0, saidAt: 0, now: 60 * S })).toBe(null);
    expect(progressMilestone({ fraction: 0.26, said: 0, saidAt: 0, now: 60 * S })).toBe(0.25);
    expect(progressMilestone({ fraction: 0.4, said: 0.25, saidAt: 0, now: 90 * S })).toBe(null);
    expect(progressMilestone({ fraction: 0.5, said: 0.25, saidAt: 0, now: 90 * S })).toBe(0.5);
    expect(progressMilestone({ fraction: 0.8, said: 0.5, saidAt: 0, now: 120 * S })).toBe(0.75);
  });

  it('waits at least 20 seconds after the last generation message', () => {
    expect(progressMilestone({ fraction: 0.3, said: 0, saidAt: 100 * S, now: 110 * S })).toBe(null);
    expect(progressMilestone({ fraction: 0.3, said: 0, saidAt: 100 * S, now: 120 * S })).toBe(0.25);
  });

  it('says only the highest quarter reached when several passed too soon', () => {
    expect(progressMilestone({ fraction: 0.8, said: 0, saidAt: 0, now: 60 * S })).toBe(0.75);
  });

  it('leaves the end to the "ready" message', () => {
    expect(progressMilestone({ fraction: 1, said: 0.75, saidAt: 0, now: 999 * S })).toBe(null);
    expect(progressMilestone({ fraction: 0, said: 0, saidAt: 0, now: 999 * S })).toBe(null);
  });
});

describe('announceProgress setting', () => {
  it('is on by default and can be turned off', () => {
    expect(DEFAULT_SETTINGS.announceProgress).toBe(true);
    expect(normalizeSettings({ announceProgress: false }).announceProgress).toBe(false);
    expect(normalizeSettings({ announceProgress: 'no' }).announceProgress).toBe(true);
  });
});
