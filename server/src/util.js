// Small helpers shared by the routes: error bodies in the two upstream styles,
// UTC day arithmetic, random identifiers, hashing and CORS.

const encoder = new TextEncoder();

/** Gemini's status names for the HTTP codes this relay produces itself. */
const GOOGLE_STATUS = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  405: 'INVALID_ARGUMENT',
  409: 'ABORTED',
  413: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  501: 'UNIMPLEMENTED',
  502: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/**
 * An error body the extension's classifiers already understand.
 * style 'gemini' is Google's shape (used on /v1beta/* and the relay's own /v1/*);
 * style 'openai' is DashScope's shape (used on /compatible-mode/*).
 */
export function errorBody(style, status, message, extra = {}) {
  if (style === 'openai') {
    return { error: { message, type: extra.type || 'scenevoice_error', code: extra.code || String(status), ...(extra.fields || {}) } };
  }
  const error = { code: status, message, status: GOOGLE_STATUS[status] || 'UNKNOWN' };
  if (extra.details) error.details = extra.details;
  return { error };
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** The UTC day a time falls in, as YYYY-MM-DD. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The next UTC midnight after a time, as an ISO string. */
export function nextUtcMidnight(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

export function randomHex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A licence key: svl- plus three groups of four base32 characters (60 bits). */
export function randomLicenceKey() {
  const buf = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...buf].map((b) => BASE32[b % 32]);
  return `svl-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

export function normaliseLicenceKey(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^svl-([a-z2-7]{4})-([a-z2-7]{4})-([a-z2-7]{4})$/i);
  return m ? `svl-${m[1]}-${m[2]}-${m[3]}`.toUpperCase().replace(/^SVL/, 'svl') : '';
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings without leaking where they differ through timing. */
export function timingSafeEqual(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Whether a request's Origin may use the relay. Requests from the extension
 * carry a chrome-extension:// (or moz-extension://) origin or none at all;
 * the project's own site is listed in ALLOWED_ORIGINS. Other web pages are
 * refused, so a page cannot spend a token it somehow learned.
 */
export function originAllowed(origin, allowedList) {
  if (!origin || origin === 'null') return true;
  if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return true;
  return allowedList.includes(origin);
}

export function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export const EXPOSED_HEADERS = 'x-scenevoice-plan, x-scenevoice-used-today, x-scenevoice-seconds-per-day, x-scenevoice-resets-at';

export function corsHeaders(origin) {
  const headers = {
    'access-control-expose-headers': EXPOSED_HEADERS,
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-goog-api-key',
    'access-control-max-age': '86400',
  };
  if (origin && origin !== 'null') {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  return headers;
}
