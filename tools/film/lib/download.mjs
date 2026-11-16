// Downloads for the fetch scripts: resume from a .part file, check the size the
// server announced, and hash what landed on disk. Uses the fetch built into Node
// and nothing else; behind a proxy run Node with NODE_USE_ENV_PROXY=1.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Largest single file these scripts will ever download. */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

const USER_AGENT = 'film-tools-fetch/0 (node)';

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

/** SHA-256 of a file, as lower-case hex. */
export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** fetch(), with the reason of a network failure in the message instead of a bare "fetch failed". */
async function request(url, headers) {
  try {
    return await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'follow' });
  } catch (error) {
    const reason = error.cause?.code || error.cause?.message || error.message;
    const hint = process.env.NODE_USE_ENV_PROXY ? '' : ' (behind a proxy? run with NODE_USE_ENV_PROXY=1)';
    throw new Error(`GET ${url}: ${reason}${hint}`, { cause: error });
  }
}

/** GET a small text resource. Returns the body and the response headers. */
export async function fetchText(url, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const response = await request(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > maxBytes) throw new Error(`GET ${url}: body larger than ${maxBytes} bytes`);
  return { text, headers: response.headers, status: response.status };
}

/** GET and parse a JSON resource. */
export async function fetchJson(url) {
  const { text, headers } = await fetchText(url);
  try {
    return { json: JSON.parse(text), headers };
  } catch {
    throw new Error(`GET ${url}: not JSON (${text.slice(0, 80)}…)`);
  }
}

/**
 * Download `url` to `dest`. A finished file of the expected size is kept as it
 * is; an unfinished one continues from `dest.part` with a Range request.
 *
 * @param {string} url
 * @param {string} dest
 * @param {{ bytes?: number, sha256?: string, maxBytes?: number, onProgress?: (done: number, total: number) => void }} [expect]
 * @returns {Promise<{ path: string, bytes: number, sha256: string, date: string | null, resumedFrom: number, alreadyThere: boolean }>}
 */
export async function download(url, dest, expect = {}) {
  const maxBytes = expect.maxBytes ?? MAX_DOWNLOAD_BYTES;
  await mkdir(dirname(dest), { recursive: true });

  const have = await sizeOf(dest);
  if (have >= 0 && (expect.bytes === undefined || have === expect.bytes)) {
    const sha256 = await sha256File(dest);
    if (!expect.sha256 || sha256 === expect.sha256) {
      return { path: dest, bytes: have, sha256, date: null, resumedFrom: have, alreadyThere: true };
    }
  }

  const part = `${dest}.part`;
  let offset = Math.max(0, await sizeOf(part));
  let date = null;
  // A few attempts: every one continues where the last one stopped.
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await request(url, offset > 0 ? { range: `bytes=${offset}-` } : {});
      if (response.status === 416) {
        // The .part file is already as long as the resource.
        await response.body?.cancel();
      } else {
        if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
        date = response.headers.get('date') || date;
        const resumed = response.status === 206;
        if (!resumed) offset = 0;
        const length = Number(response.headers.get('content-length'));
        const total = Number.isFinite(length) && length > 0 ? offset + length : expect.bytes ?? 0;
        if (total > maxBytes) {
          await response.body?.cancel();
          throw Object.assign(new Error(`${url} is ${total} bytes, over the ${maxBytes} byte limit`), { fatal: true });
        }
        if (expect.bytes !== undefined && total && total !== expect.bytes) {
          await response.body?.cancel();
          throw Object.assign(new Error(`${url}: server announces ${total} bytes, expected ${expect.bytes}`), { fatal: true });
        }
        let done = offset;
        const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
        const body = Readable.fromWeb(response.body);
        body.on('data', (chunk) => {
          done += chunk.length;
          expect.onProgress?.(done, total);
        });
        await pipeline(body, out);
      }
      break;
    } catch (error) {
      if (error.fatal || attempt >= 5) throw error;
      offset = Math.max(0, await sizeOf(part));
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  const bytes = await sizeOf(part);
  if (expect.bytes !== undefined && bytes !== expect.bytes) {
    throw new Error(`${url}: got ${bytes} bytes, expected ${expect.bytes} (kept as ${part}; run again to resume)`);
  }
  const sha256 = await sha256File(part);
  if (expect.sha256 && sha256 !== expect.sha256) {
    throw new Error(`${url}: SHA-256 is ${sha256}, expected ${expect.sha256} (left as ${part})`);
  }
  await rename(part, dest);
  return { path: dest, bytes, sha256, date, resumedFrom: offset, alreadyThere: false };
}

/** A progress printer that writes at most one line per five percent; silent for files under 5 MB. */
export function progressLine(label) {
  let last = -1;
  return (done, total) => {
    if (!total || total < 5e6) return;
    const step = Math.floor((done / total) * 20);
    if (step === last) return;
    last = step;
    process.stderr.write(`${label}: ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB\n`);
  };
}
