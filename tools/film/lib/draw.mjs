// Drawing on raw RGB buffers, for pictures a person checks by eye: face boxes,
// landmark dots, small labels, shrinking a frame to a thumbnail and pasting
// thumbnails into a contact sheet. Plain loops, no dependencies.

/** 5x7 glyphs for the characters labels need: digits, colon, dot, minus, space. */
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

export const GREEN = [0, 255, 0];
export const YELLOW = [255, 230, 0];
export const RED = [255, 40, 40];
export const WHITE = [255, 255, 255];
export const BLACK = [0, 0, 0];

function fill(rgb, width, height, x0, y0, x1, y1, color) {
  const left = Math.max(0, Math.round(x0));
  const top = Math.max(0, Math.round(y0));
  const right = Math.min(width, Math.round(x1));
  const bottom = Math.min(height, Math.round(y1));
  for (let y = top; y < bottom; y += 1) {
    let at = (y * width + left) * 3;
    for (let x = left; x < right; x += 1) {
      rgb[at] = color[0];
      rgb[at + 1] = color[1];
      rgb[at + 2] = color[2];
      at += 3;
    }
  }
}

/** The outline of a box [x, y, w, h]. */
export function drawBox(rgb, width, height, box, color = GREEN, thickness = 2) {
  const [x, y, w, h] = box;
  fill(rgb, width, height, x, y, x + w, y + thickness, color);
  fill(rgb, width, height, x, y + h - thickness, x + w, y + h, color);
  fill(rgb, width, height, x, y, x + thickness, y + h, color);
  fill(rgb, width, height, x + w - thickness, y, x + w, y + h, color);
}

/** A small filled square centred on a point. */
export function drawDot(rgb, width, height, x, y, color = YELLOW, radius = 1) {
  fill(rgb, width, height, x - radius, y - radius, x + radius + 1, y + radius + 1, color);
}

/** A label (digits, ":", ".", "-", space) on a dark patch; returns its width in pixels. */
export function drawText(rgb, width, height, text, x, y, { scale = 2, color = WHITE, background = BLACK } = {}) {
  const chars = String(text).split('');
  const total = chars.length * 6 * scale + scale;
  if (background) fill(rgb, width, height, x, y, x + total, y + 9 * scale, background);
  chars.forEach((char, index) => {
    const glyph = GLYPHS[char] || GLYPHS[' '];
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row][col] !== '1') continue;
        const px = x + scale + (index * 6 + col) * scale;
        const py = y + scale + row * scale;
        fill(rgb, width, height, px, py, px + scale, py + scale, color);
      }
    }
  });
  return total;
}

/** Shrink a picture by averaging: every source pixel counts in the result. */
export function shrink(rgb, width, height, outWidth, outHeight) {
  const out = new Uint8Array(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = Math.floor((y * height) / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = Math.floor((x * width) / outWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let at = (sy * width + x0) * 3;
        for (let sx = x0; sx < x1; sx += 1) {
          r += rgb[at];
          g += rgb[at + 1];
          b += rgb[at + 2];
          at += 3;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (y * outWidth + x) * 3;
      out[to] = r / count;
      out[to + 1] = g / count;
      out[to + 2] = b / count;
    }
  }
  return out;
}

/** Paste one picture into another at (x, y); what falls outside is dropped. */
export function paste(target, targetWidth, targetHeight, rgb, width, height, x, y) {
  for (let row = 0; row < height; row += 1) {
    const ty = y + row;
    if (ty < 0 || ty >= targetHeight) continue;
    const from = Math.max(0, -x);
    const to = Math.min(width, targetWidth - x);
    if (to <= from) continue;
    target.set(rgb.subarray((row * width + from) * 3, (row * width + to) * 3), (ty * targetWidth + x + from) * 3);
  }
}

/** Cut a region out of a picture (clamped to it). */
export function crop(rgb, width, height, region) {
  const x = Math.max(0, Math.min(width - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(region.y)));
  const w = Math.max(1, Math.min(width - x, Math.round(region.w)));
  const h = Math.max(1, Math.min(height - y, Math.round(region.h)));
  const out = new Uint8Array(w * h * 3);
  for (let row = 0; row < h; row += 1) {
    out.set(rgb.subarray(((y + row) * width + x) * 3, ((y + row) * width + x + w) * 3), row * w * 3);
  }
  return { rgb: out, width: w, height: h };
}

/** Draw every face on a copy of a frame: box, five landmark dots, score in hundredths. */
export function drawFaces(rgb, width, height, faces, { scale = 1, thickness = 2, labels = true } = {}) {
  for (const face of faces) {
    const box = face.box.map((value) => value * scale);
    drawBox(rgb, width, height, box, GREEN, thickness);
    if (face.landmarks && box[2] >= 24) {
      for (const [x, y] of face.landmarks) drawDot(rgb, width, height, x * scale, y * scale, YELLOW, box[2] >= 80 ? 2 : 1);
    }
    if (labels) drawText(rgb, width, height, String(Math.round(face.score * 100)), box[0], Math.max(0, box[1] - 9), { scale: 1 });
  }
  return rgb;
}

/** A time as m:ss.s for labels. */
export function clock(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
