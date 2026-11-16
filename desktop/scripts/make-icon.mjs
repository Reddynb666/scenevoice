// Makes the application icon of the test shell from the extension's own icon
// artwork (../static/icons/icon16.png … icon128.png: the play frame with sound
// waves), so the program, its installer and its shortcuts do not carry
// Electron's default icon:
//
//   npm run make-icon     ->  build/icon.ico   (Windows: 16, 24, 32, 48, 64, 128, 256 px)
//                             build/icon.icns  (macOS:   16 to 1024 px)
//
// `npm run dist:win` and `npm run dist:mac` run it first; both files are
// git-ignored. Sizes the artwork has are taken as they are; the others are
// scaled from the 128 px picture, so the large ones are a little soft: there
// is no larger drawing. Node only: a PNG reader and writer for 8-bit pictures,
// nothing downloaded, nothing to install.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { crc32 } from './zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const ARTWORK = path.join(DESKTOP, '..', 'static', 'icons');
const OUT = path.join(DESKTOP, 'build');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The sizes of the artwork, the sizes of a Windows icon, and the macOS icon types with theirs. */
export const ARTWORK_SIZES = Object.freeze([16, 32, 48, 128]);
export const ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
export const ICNS_TYPES = Object.freeze([['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]);

/**
 * Read a PNG: 8 bits per channel, RGB or RGBA, not interlaced (what the artwork is).
 * @returns {{width: number, height: number, data: Buffer}} RGBA, top row first
 */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  let width = 0;
  let height = 0;
  let channels = 0;
  const packed = [];
  for (let at = 8; at + 12 <= file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || (colour !== 6 && colour !== 2) || interlace !== 0) throw new Error('only 8-bit RGB or RGBA PNG without interlacing is read here');
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      packed.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (!width || !height) throw new Error('PNG without a header');
  const raw = zlib.inflateSync(Buffer.concat(packed));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y ? rows[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predicted = a <= b && a <= c ? left : b <= c ? up : corner;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      rows[y * stride + x] = (line[x] + predicted) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i += 1) rows.copy(data, i * 4, i * 3, i * 3 + 3);
  return { width, height, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Write an RGBA picture as a PNG. */
export function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Scale a square RGBA picture: smaller by averaging the pixels each new one
 * covers, larger by blending between neighbours. Colour is weighted by
 * opacity, so the transparent corners do not darken the edge.
 */
export function resize(picture, size) {
  const { width: from, data } = picture;
  if (size === from) return picture;
  const out = Buffer.alloc(size * size * 4);
  const scale = from / size;
  const put = (x, y, sum) => {
    const at = (y * size + x) * 4;
    const alpha = sum[3];
    for (let c = 0; c < 3; c += 1) out[at + c] = alpha > 0 ? Math.min(255, Math.round(sum[c] / alpha)) : 0;
    out[at + 3] = Math.min(255, Math.round(alpha / sum[4]));
  };
  const take = (sum, sx, sy, weight) => {
    const at = (Math.min(from - 1, Math.max(0, sy)) * from + Math.min(from - 1, Math.max(0, sx))) * 4;
    const alpha = data[at + 3] * weight;
    for (let c = 0; c < 3; c += 1) sum[c] += data[at + c] * alpha;
    sum[3] += alpha;
    sum[4] += weight;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sum = [0, 0, 0, 0, 0];
      if (scale > 1) {
        // Every source pixel the new one covers, by the share it covers.
        const [x0, x1, y0, y1] = [x * scale, (x + 1) * scale, y * scale, (y + 1) * scale];
        for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
          for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
            const weight = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy));
            if (weight > 0) take(sum, sx, sy, weight);
          }
        }
      } else {
        // The four source pixels around the new one's centre.
        const fx = (x + 0.5) * scale - 0.5;
        const fy = (y + 0.5) * scale - 0.5;
        const [ix, iy] = [Math.floor(fx), Math.floor(fy)];
        const [tx, ty] = [fx - ix, fy - iy];
        take(sum, ix, iy, (1 - tx) * (1 - ty));
        take(sum, ix + 1, iy, tx * (1 - ty));
        take(sum, ix, iy + 1, (1 - tx) * ty);
        take(sum, ix + 1, iy + 1, tx * ty);
      }
      put(x, y, sum);
    }
  }
  return { width: size, height: size, data: out };
}

/** One picture of a Windows icon as a bitmap: 32 bits, bottom row first, with the (empty) mask every reader expects. */
function icoBitmap({ width, height, data }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // the picture and its mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((height - 1 - y) * width + x) * 4;
      const to = (y * width + x) * 4;
      pixels[to] = data[from + 2];
      pixels[to + 1] = data[from + 1];
      pixels[to + 2] = data[from];
      pixels[to + 3] = data[from + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(width / 32) * 4 * height);
  return Buffer.concat([header, pixels, mask]);
}

/**
 * A Windows .ico of square pictures: bitmaps up to 128 px and a PNG for 256 px,
 * the layout every tool that reads icons accepts.
 * @param {{width: number, height: number, data: Buffer}[]} pictures
 */
export function buildIco(pictures) {
  const images = pictures.map((picture) => (picture.width >= 256 ? encodePng(picture) : icoBitmap(picture)));
  const directory = Buffer.alloc(6 + 16 * pictures.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(pictures.length, 4);
  let offset = directory.length;
  pictures.forEach((picture, i) => {
    const at = 6 + i * 16;
    directory[at] = picture.width >= 256 ? 0 : picture.width;
    directory[at + 1] = picture.height >= 256 ? 0 : picture.height;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(images[i].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([directory, ...images]);
}

/** A macOS .icns: one PNG per icon type. */
export function buildIcns(entries) {
  const parts = entries.map(([type, picture]) => {
    const png = encodePng(picture);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

/** The artwork at a size: its own picture where it has one, else scaled from the largest. */
export function pictureAt(artwork, size) {
  return artwork.get(size) || resize(artwork.get(Math.max(...artwork.keys())), size);
}

/** Write build/icon.ico and build/icon.icns. @returns {string[]} the files written */
export function makeIcons({ artworkFolder = ARTWORK, out = OUT } = {}) {
  const artwork = new Map();
  for (const size of ARTWORK_SIZES) {
    const picture = decodePng(fs.readFileSync(path.join(artworkFolder, `icon${size}.png`)));
    if (picture.width !== size || picture.height !== size) throw new Error(`icon${size}.png is ${picture.width}x${picture.height}`);
    artwork.set(size, picture);
  }
  fs.mkdirSync(out, { recursive: true });
  const ico = path.join(out, 'icon.ico');
  const icns = path.join(out, 'icon.icns');
  fs.writeFileSync(ico, buildIco(ICO_SIZES.map((size) => pictureAt(artwork, size))));
  fs.writeFileSync(icns, buildIcns(ICNS_TYPES.map(([type, size]) => [type, pictureAt(artwork, size)])));
  return [ico, icns];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of makeIcons()) console.log(`${path.relative(DESKTOP, file)}  ${fs.statSync(file).size} bytes`);
}
