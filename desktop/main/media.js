// The media scheme of the shell: it serves the bundled sample and the one film
// the user picked in the native open dialog, each under an opaque token, and
// nothing else. Opening another film retires the token of the one before. Byte
// ranges work, so a film of several gigabytes can seek without being read
// through. No Electron here: the handler takes a web Request and returns a web
// Response, both of which Node has.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  // Chromium reads QuickTime files with its MP4 reader.
  '.mov': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
});

/** File name extensions the open dialog offers. */
export const FILM_EXTENSIONS = Object.freeze(['mp4', 'm4v', 'mkv', 'mov', 'webm']);

export function mediaType(file) {
  return TYPES[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

/**
 * A Range header against a file size.
 * @returns {null | 'unsatisfiable' | {start: number, end: number}}
 *   null: no range, or not a single byte range (the whole file is then a valid answer).
 */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (!(size > 0)) return 'unsatisfiable';
  let start;
  let end;
  if (match[1] === '') {
    // The last n bytes.
    const n = Number(match[2]);
    if (!Number.isSafeInteger(n) || n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** The files the media scheme will serve, by token. */
export class MediaRegistry {
  /** @param {{newToken?: () => string}} [o] */
  constructor({ newToken = () => randomBytes(16).toString('hex') } = {}) {
    this.newToken = newToken;
    /** token -> { kind, file, size, type } */
    this.entries = new Map();
  }

  /**
   * Serve a file from now on; the file of the same kind served before is retired.
   * @param {'sample'|'film'} kind
   * @param {string} file  absolute path; it never leaves the main process
   * @returns {Promise<string>} the token
   */
  async open(kind, file) {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    for (const [token, entry] of this.entries) {
      if (entry.kind === kind) this.entries.delete(token);
    }
    const token = this.newToken();
    this.entries.set(token, { kind, file, size: stat.size, type: mediaType(file) });
    return token;
  }

  get(token) {
    return this.entries.get(token) || null;
  }

  /** The entry of a kind, or null. */
  current(kind) {
    for (const entry of this.entries.values()) {
      if (entry.kind === kind) return entry;
    }
    return null;
  }
}

/** A web stream over a byte range of a file that stops reading when the reader goes away. */
function fileStream(file, start, end) {
  const source = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  let closed = false;
  return new ReadableStream({
    start(controller) {
      source.on('data', (chunk) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (controller.desiredSize <= 0) source.pause();
      });
      source.on('end', () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
      source.on('error', (err) => {
        if (closed) return;
        closed = true;
        controller.error(err);
      });
    },
    pull() {
      source.resume();
    },
    cancel() {
      closed = true;
      source.destroy();
    },
  });
}

/**
 * Answer one request to the media scheme.
 * @param {MediaRegistry} registry
 * @param {string|null} token
 * @param {{method: string, headers: {get(name: string): string|null}}} request
 * @returns {Response}
 */
export function mediaResponse(registry, token, request) {
  const entry = token ? registry.get(token) : null;
  if (!entry) return new Response(null, { status: 404 });
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const base = { 'Content-Type': entry.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = parseRange(request.headers.get('range'), entry.size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${entry.size}` } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : entry.size - 1;
  const headers = { ...base, 'Content-Length': String(Math.max(0, end - start + 1)) };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${entry.size}`;
  const status = range ? 206 : 200;
  if (method === 'HEAD' || entry.size === 0) return new Response(null, { status, headers });
  return new Response(fileStream(entry.file, start, end), { status, headers });
}
