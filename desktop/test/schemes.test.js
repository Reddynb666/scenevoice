// The two schemes of the shell: which files app:// serves, and how the media
// scheme answers byte ranges and tokens.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSP, START_URL, appFileBody, mediaToken, mediaUrl, resolveAppFile } from '../main/apppath.js';
import { MediaRegistry, mediaResponse, mediaType, parseRange } from '../main/media.js';

const ROOT = path.join(path.sep, 'opt', 'scenevoice', 'desktop');

describe('the Content-Security-Policy', () => {
  it('forbids every connection and inline script, and allows media from the media scheme only', () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("media-src 'self' blob: svmedia:");
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });
});

describe('resolveAppFile', () => {
  it('serves the page and its modules', () => {
    expect(resolveAppFile(START_URL, ROOT)).toEqual({ file: path.join(ROOT, 'renderer', 'index.html'), type: 'text/html; charset=utf-8' });
    expect(resolveAppFile('app://scenevoice/renderer/app.js', ROOT).type).toBe('text/javascript; charset=utf-8');
    expect(resolveAppFile('app://scenevoice/locales/zh_CN.mjs', ROOT).file).toBe(path.join(ROOT, 'locales', 'zh_CN.mjs'));
    expect(resolveAppFile('app://scenevoice/shared/actions.js', ROOT).file).toBe(path.join(ROOT, 'shared', 'actions.js'));
    expect(resolveAppFile('app://scenevoice/renderer/style.css?x=1', ROOT).type).toBe('text/css; charset=utf-8');
  });

  it('serves a JSON file as a module under its name plus .js', () => {
    const hit = resolveAppFile('app://scenevoice/renderer/sample/narration.json.js', ROOT);
    expect(hit).toEqual({ file: path.join(ROOT, 'renderer', 'sample', 'narration.json'), type: 'text/javascript; charset=utf-8', jsonModule: true });
    expect(appFileBody(hit, Buffer.from('{"a": "口述", "b": [1, 2]}'))).toBe('export default {"a":"口述","b":[1,2]};\n');
    expect(() => appFileBody(hit, Buffer.from('alert(1)'))).toThrow();
    const plain = Buffer.from('body {}');
    expect(appFileBody({ file: 'x.css', type: 'text/css' }, plain)).toBe(plain);
  });

  it('serves nothing outside the three page folders', () => {
    for (const url of [
      'app://scenevoice/main/index.js',
      'app://scenevoice/ipc/contract.js',
      'app://scenevoice/package.json',
      'app://scenevoice/node_modules/axe-core/axe.min.js',
      'app://scenevoice/renderer',
      'app://scenevoice/',
      'app://scenevoice/renderer/../main/index.js',
      'app://scenevoice/renderer/%2e%2e/main/index.js',
      'app://scenevoice/renderer/..%2Fmain%2Findex.js',
      'app://scenevoice/renderer/..%5Cmain%5Cindex.js',
      'app://scenevoice/renderer/%00.js',
      'app://scenevoice/renderer//app.js',
      'app://scenevoice/renderer/.hidden.js',
      'app://scenevoice/locales/../../../etc/passwd.js',
    ]) {
      expect(resolveAppFile(url, ROOT), url).toBeNull();
    }
  });

  it('serves only the file types of a page, never the film', () => {
    expect(resolveAppFile('app://scenevoice/renderer/sample/sample.mp4', ROOT)).toBeNull();
    expect(resolveAppFile('app://scenevoice/renderer/notes.txt', ROOT)).toBeNull();
    expect(resolveAppFile('app://scenevoice/renderer/app', ROOT)).toBeNull();
  });

  it('answers only its own scheme and host', () => {
    expect(resolveAppFile('app://other/renderer/app.js', ROOT)).toBeNull();
    expect(resolveAppFile('file:///renderer/app.js', ROOT)).toBeNull();
    expect(resolveAppFile('https://scenevoice/renderer/app.js', ROOT)).toBeNull();
    expect(resolveAppFile('not a url', ROOT)).toBeNull();
  });

  it('adds the self-test file only when it is given', () => {
    const extra = { '/selftest/axe.min.js': '/somewhere/axe.min.js' };
    expect(resolveAppFile('app://scenevoice/selftest/axe.min.js', ROOT)).toBeNull();
    expect(resolveAppFile('app://scenevoice/selftest/axe.min.js', ROOT, extra)).toEqual({ file: '/somewhere/axe.min.js', type: 'text/javascript; charset=utf-8' });
  });
});

describe('media tokens', () => {
  it('round-trips a token and refuses anything that is not one', () => {
    const token = 'ab'.repeat(16);
    expect(mediaUrl(token)).toBe(`svmedia://media/${token}`);
    expect(mediaToken(mediaUrl(token))).toBe(token);
    expect(mediaToken('svmedia://media/../../etc/passwd')).toBeNull();
    expect(mediaToken('svmedia://media/%2Fetc%2Fpasswd')).toBeNull();
    expect(mediaToken(`svmedia://other/${token}`)).toBeNull();
    expect(mediaToken(`app://media/${token}`)).toBeNull();
    expect(mediaToken('svmedia://media/short')).toBeNull();
  });
});

describe('parseRange', () => {
  it('reads a closed range, an open one and a suffix', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange(' bytes=0-0 ', 1000)).toEqual({ start: 0, end: 0 });
  });

  it('clips the end to the file and a long suffix to its start', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('seeks in a file of many gigabytes', () => {
    const size = 12 * 1024 ** 3 + 7;
    expect(parseRange(`bytes=${9 * 1024 ** 3}-`, size)).toEqual({ start: 9 * 1024 ** 3, end: size - 1 });
    expect(parseRange(`bytes=${size - 1}-${size - 1}`, size)).toEqual({ start: size - 1, end: size - 1 });
    expect(parseRange('bytes=-1048576', size)).toEqual({ start: size - 1048576, end: size - 1 });
  });

  it('says so when the range lies beyond the file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange(`bytes=${'9'.repeat(30)}-`, 1000)).toBe('unsatisfiable');
  });

  it('treats no header, other units and several ranges as "the whole file"', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('', 1000)).toBeNull();
    expect(parseRange('items=0-5', 1000)).toBeNull();
    expect(parseRange('bytes=0-5,10-15', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('bytes=a-b', 1000)).toBeNull();
  });
});

describe('MediaRegistry and mediaResponse', () => {
  let folder;
  let film;
  let other;
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const request = (range, method = 'GET') => ({ method, headers: { get: (name) => (name.toLowerCase() === 'range' ? range : null) } });

  beforeAll(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'scenevoice-media-test-'));
    film = path.join(folder, 'film.mkv');
    other = path.join(folder, 'other.mp4');
    fs.writeFileSync(film, bytes);
    fs.writeFileSync(other, Buffer.from('second film'));
  });

  afterAll(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('hands out an opaque token that says nothing about the file', async () => {
    const registry = new MediaRegistry();
    const token = await registry.open('film', film);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(mediaUrl(token)).not.toContain('film');
    expect(registry.get(token)).toMatchObject({ kind: 'film', size: 5000, type: 'video/x-matroska' });
    expect(await registry.open('film', film)).not.toBe(token);
  });

  it('serves only the one film the user picked last', async () => {
    const registry = new MediaRegistry();
    const first = await registry.open('film', film);
    const sample = await registry.open('sample', other);
    const second = await registry.open('film', other);
    expect(registry.get(first)).toBeNull();
    expect(registry.get(second).file).toBe(other);
    expect(registry.get(sample).kind).toBe('sample');
    expect(registry.current('film').file).toBe(other);
    expect(mediaResponse(registry, first, request(null)).status).toBe(404);
  });

  it('refuses a folder or a missing file', async () => {
    const registry = new MediaRegistry();
    await expect(registry.open('film', folder)).rejects.toThrow();
    await expect(registry.open('film', path.join(folder, 'nope.mp4'))).rejects.toThrow();
    expect(registry.current('film')).toBeNull();
  });

  it('answers a byte range with 206 and exactly those bytes', async () => {
    const registry = new MediaRegistry();
    const token = await registry.open('film', film);
    const response = mediaResponse(registry, token, request('bytes=1000-1999'));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1000-1999/5000');
    expect(response.headers.get('content-length')).toBe('1000');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('video/x-matroska');
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(1000, 2000))).toBe(true);
  });

  it('answers the last bytes and the whole file', async () => {
    const registry = new MediaRegistry();
    const token = await registry.open('film', film);
    const tail = mediaResponse(registry, token, request('bytes=-10'));
    expect(tail.headers.get('content-range')).toBe('bytes 4990-4999/5000');
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(4990))).toBe(true);
    const whole = mediaResponse(registry, token, request(null));
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-range')).toBeNull();
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('answers 416 beyond the end, 404 for an unknown token and 405 for a write', async () => {
    const registry = new MediaRegistry();
    const token = await registry.open('film', film);
    const beyond = mediaResponse(registry, token, request('bytes=6000-'));
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */5000');
    expect(mediaResponse(registry, '0'.repeat(32), request(null)).status).toBe(404);
    expect(mediaResponse(registry, null, request(null)).status).toBe(404);
    expect(mediaResponse(registry, token, request(null, 'POST')).status).toBe(405);
    const head = mediaResponse(registry, token, request('bytes=0-9', 'HEAD'));
    expect(head.status).toBe(206);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('stops reading the file when the player goes away', async () => {
    const registry = new MediaRegistry();
    const token = await registry.open('film', film);
    const response = mediaResponse(registry, token, request('bytes=0-'));
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
  });

  it('names the type by the file extension', () => {
    expect(mediaType('a.MP4')).toBe('video/mp4');
    expect(mediaType('a.mov')).toBe('video/mp4');
    expect(mediaType('a.webm')).toBe('video/webm');
    expect(mediaType('a.avi')).toBe('application/octet-stream');
  });
});
