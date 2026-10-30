// A protected (DRM) video draws as solid black: the check looks at the pixels
// drawn, counts a dark but real picture as not blank, and never throws.

import { describe, expect, it } from 'vitest';
import { canvasLooksBlank } from '../src/content/frames.js';

const canvasOf = (fill, { w = 64, h = 36, spot = null } = {}) => ({
  width: w,
  height: h,
  getContext: () => ({
    getImageData: () => {
      const data = new Uint8ClampedArray(w * h * 4).fill(fill);
      if (spot != null) for (let i = 0; i < data.length; i += 4 * 97) data[i] = spot;
      return { data };
    },
  }),
});

describe('canvasLooksBlank', () => {
  it('is true for solid black', () => {
    expect(canvasLooksBlank(canvasOf(0))).toBe(true);
    expect(canvasLooksBlank(canvasOf(6))).toBe(true);
  });
  it('is false for a dark scene with something in it', () => {
    expect(canvasLooksBlank(canvasOf(0, { spot: 90 }))).toBe(false);
    expect(canvasLooksBlank(canvasOf(40))).toBe(false);
  });
  it('is false when the pixels cannot be read', () => {
    expect(canvasLooksBlank(null)).toBe(false);
    expect(canvasLooksBlank({ width: 10, height: 10, getContext: () => null })).toBe(false);
    expect(canvasLooksBlank({ width: 10, height: 10, getContext: () => ({ getImageData: () => { throw new Error('tainted'); } }) })).toBe(false);
  });
});
