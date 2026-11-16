// A small zip writer and reader for the Windows package: the zip a tester gets
// holds ONE folder with the build in it, so that "extract here" leaves one
// folder behind and not twenty files. (electron-builder's own zip target puts
// the files at the top of the archive.)
//
// Plain zip, deflate, no zip64: every file and the archive itself stay far
// below 4 GB. Node only, nothing to install.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_NAMES = 0x0800;
const LIMIT = 0xffffffff;

let table = null;
/** CRC-32 of a buffer: Node's own where it has one (22.2 and later), else computed here. */
export function crc32(data, { builtin = zlib.crc32 } = {}) {
  if (typeof builtin === 'function') return builtin(data);
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date, as a zip stores them (local time, two-second steps). */
export function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Every file under a folder, relative, with forward slashes, sorted; links are not followed. */
export function filesUnder(root, relative = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const here = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`a link cannot go into the zip: ${here}`);
    if (entry.isDirectory()) out.push(...filesUnder(root, here));
    else if (entry.isFile()) out.push(here);
  }
  return out.sort();
}

function header(signature, fields) {
  const buffer = Buffer.alloc(4 + fields.reduce((sum, [size]) => sum + size, 0));
  buffer.writeUInt32LE(signature, 0);
  let at = 4;
  for (const [size, value] of fields) {
    if (size === 2) buffer.writeUInt16LE(value, at);
    else buffer.writeUInt32LE(value, at);
    at += size;
  }
  return buffer;
}

/**
 * Zip a folder so that the archive holds the single folder `top` with the
 * folder's files in it.
 * @param {string} root  the folder whose contents go in
 * @param {string} out   the zip file to write (replaced when it exists)
 * @param {string} top   the name of the one folder inside the archive
 * @param {{level?: number}} [o]
 * @returns {{files: number, bytes: number}} what went in, and the size of the archive
 */
export function zipFolder(root, out, top, { level = 9 } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(top)) throw new Error(`not a plain folder name: ${top}`);
  const files = filesUnder(root);
  const folders = new Set([`${top}/`]);
  for (const file of files) {
    const parts = file.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) folders.add(`${top}/${parts.slice(0, i).join('/')}/`);
  }
  const fd = fs.openSync(out, 'w');
  const central = [];
  let offset = 0;
  const write = (buffer) => {
    fs.writeSync(fd, buffer);
    offset += buffer.length;
  };
  const add = (name, data, mtime, attributes) => {
    const raw = Buffer.from(name, 'utf8');
    if (data.length > LIMIT || offset > LIMIT) throw new Error(`too large for a plain zip: ${name}`);
    const packed = data.length ? zlib.deflateRawSync(data, { level }) : data;
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const { time, date } = dosTime(mtime);
    // Version needed 2.0, flags, method, time, date, CRC, compressed size, size, name length, extra length.
    const common = [[2, 20], [2, UTF8_NAMES], [2, stored ? 0 : 8], [2, time], [2, date], [4, crc32(data)], [4, body.length], [4, data.length], [2, raw.length], [2, 0]];
    // Central record: made by 2.0 on DOS, then the same fields, comment length, disk, internal and external attributes, offset.
    central.push(Buffer.concat([header(CENTRAL, [[2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, attributes], [4, offset]]), raw]));
    write(header(LOCAL, common));
    write(raw);
    write(body);
  };
  try {
    const now = new Date();
    for (const folder of [...folders].sort()) add(folder, Buffer.alloc(0), now, 0x10);
    for (const file of files) {
      const full = path.join(root, file);
      add(`${top}/${file}`, fs.readFileSync(full), fs.statSync(full).mtime, 0x20);
    }
    const start = offset;
    for (const record of central) write(record);
    if (central.length > 0xffff || offset > LIMIT) throw new Error('too large for a plain zip');
    // Disk numbers, records on this disk and in all, size and offset of the directory, comment length.
    write(header(END, [[2, 0], [2, 0], [2, central.length], [2, central.length], [4, offset - start], [4, start], [2, 0]]));
  } finally {
    fs.closeSync(fd);
  }
  return { files: files.length, bytes: offset };
}

/**
 * The entries of a zip archive, from its central directory.
 * @param {(offset: number, length: number) => Buffer} read  reads bytes of the archive
 * @param {number} size  the archive's size
 * @returns {{name: string, size: number, compressed: number, crc: number, method: number, offset: number}[]}
 */
export function zipEntries(read, size) {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = read(size - tailLength, tailLength);
  let at = tail.length - 22;
  while (at >= 0 && tail.readUInt32LE(at) !== END) at -= 1;
  if (at < 0) throw new Error('not a zip archive: no end record');
  const count = tail.readUInt16LE(at + 10);
  const length = tail.readUInt32LE(at + 12);
  const start = tail.readUInt32LE(at + 16);
  if (start + length > size) throw new Error('not a zip archive: the directory runs past the end');
  const directory = read(start, length);
  const entries = [];
  let pos = 0;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== CENTRAL) throw new Error('not a zip archive: bad directory record');
    const nameLength = directory.readUInt16LE(pos + 28);
    const skip = directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
    entries.push({
      name: directory.subarray(pos + 46, pos + 46 + nameLength).toString('utf8'),
      method: directory.readUInt16LE(pos + 10),
      crc: directory.readUInt32LE(pos + 16),
      compressed: directory.readUInt32LE(pos + 20),
      size: directory.readUInt32LE(pos + 24),
      offset: directory.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLength + skip;
  }
  return entries;
}

/** The bytes of one entry, unpacked and checked against its CRC. */
export function zipEntryData(read, entry) {
  const local = read(entry.offset, 30);
  if (local.readUInt32LE(0) !== LOCAL) throw new Error(`bad local header: ${entry.name}`);
  const dataAt = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const body = read(dataAt, entry.compressed);
  const data = entry.method === 8 ? zlib.inflateRawSync(body) : body;
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`damaged entry: ${entry.name}`);
  return data;
}

/** A reader for zipEntries and zipEntryData over a file. */
export function fileReader(file) {
  return (offset, length) => {
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    return buffer;
  };
}
