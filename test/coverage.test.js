// How far the part being watched is described, when descriptions come from pictures.

import { describe, expect, it } from 'vitest';
import { describedUpTo } from '../src/shared/coverage.js';

describe('describedUpTo', () => {
  const ranges = [[0, 24], [60, 84]];
  it('is the end of the described stretch the viewer is in', () => {
    expect(describedUpTo(ranges, 10)).toBe(24);
    expect(describedUpTo(ranges, 70)).toBe(84);
  });
  it('is the end of the last stretch passed, while the next is still being described', () => {
    expect(describedUpTo(ranges, 30)).toBe(24);
    expect(describedUpTo(ranges, 45)).toBe(24);
    expect(describedUpTo(ranges, 59.5)).toBe(84); // within a second of the next stretch
  });
  it('is 0 before anything is described', () => {
    expect(describedUpTo([], 30)).toBe(0);
    expect(describedUpTo([[40, 52]], 10)).toBe(0);
  });
});
