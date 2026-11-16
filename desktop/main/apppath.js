// What the app:// scheme serves: the page's own files and nothing else, plus
// the Content-Security-Policy sent with every one of them. The page is loaded
// from app://scenevoice/ (a standard, secure scheme), never from file://.
// Pure apart from path arithmetic: no Electron, no file access.

import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'scenevoice';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const START_URL = `${APP_ORIGIN}/renderer/index.html`;
export const MEDIA_SCHEME = 'svmedia';
export const MEDIA_HOST = 'media';

/**
 * The page may load its own scripts, styles and images, play media from its
 * own origin, a blob or the media scheme, and may not connect anywhere:
 * no fetch, no XMLHttpRequest, no WebSocket, no inline script.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  `media-src 'self' blob: ${MEDIA_SCHEME}:`,
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
});

/** The folders of desktop/ the page may read from. */
export const SERVED_FOLDERS = Object.freeze(['renderer', 'locales', 'shared']);

/**
 * A JSON file is also served as a module under its name plus ".js"
 * (narration.json.js is `export default <the JSON>`): the page may not fetch
 * anything, a JSON module import included (connect-src 'none'), but it may
 * import its own scripts.
 */
const JSON_MODULE_SUFFIX = '.json.js';

/**
 * The file an app:// address stands for, or null when it is not served.
 * @param {string} url
 * @param {string} root  absolute path of desktop/
 * @param {Record<string, string>} [extra]  exact pathname to absolute file (the self-test's axe-core)
 * @returns {{file: string, type: string, jsonModule?: boolean} | null}
 */
export function resolveAppFile(url, root, extra = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.hostname !== APP_HOST) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const type = CONTENT_TYPES[path.posix.extname(pathname).toLowerCase()];
  if (!type) return null;
  if (Object.hasOwn(extra, pathname)) return { file: extra[pathname], type };
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  const segments = pathname.split('/').slice(1);
  if (segments.length < 2 || !SERVED_FOLDERS.includes(segments[0])) return null;
  if (segments.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return null;
  const folder = path.join(root, segments[0]);
  const jsonModule = pathname.toLowerCase().endsWith(JSON_MODULE_SUFFIX);
  const file = path.join(root, ...segments).slice(0, jsonModule ? -'.js'.length : undefined);
  if (!file.startsWith(folder + path.sep)) return null;
  return jsonModule ? { file, type, jsonModule: true } : { file, type };
}

/** The body served for a file: a JSON module is the JSON as a default export. */
export function appFileBody(hit, bytes) {
  if (!hit.jsonModule) return bytes;
  // Parsing first makes sure only JSON is ever served as script.
  return `export default ${JSON.stringify(JSON.parse(Buffer.from(bytes).toString('utf8')))};\n`;
}

/** The address of a media token. The page gets this and never a path. */
export function mediaUrl(token) {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${token}`;
}

/** The token in a media-scheme address, or null. */
export function mediaToken(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null;
  const token = parsed.pathname.slice(1);
  return /^[0-9a-f]{32}$/.test(token) ? token : null;
}
