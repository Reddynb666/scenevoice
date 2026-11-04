// SceneVoice Cloud, the relay in server/: the few requests that are not model
// calls (register a device, read the plan, activate a licence, the shared
// description cache), and what may be shared. Protocol v1 is written up in
// server/README.md; both sides implement exactly that.
//
// For extension pages, the service worker and the offscreen worker only. The
// device token is a credential and content scripts never see it (they do not
// import this file: test/security.test.js checks).

import { CLOUD_API_BASE, SCRIPT_VERSION } from './constants.js';
import { ApiError } from './errors.js';

/** A device token as the relay issues them: svd_ and 32 hex digits. Nothing else is saved as one. */
export const validToken = (token) => typeof token === 'string' && /^svd_[0-9a-f]{32}$/i.test(token);

const PLANS = new Set(['free', 'plus', 'org']);
/** A plan name the relay uses, or 'free'. */
export const cleanPlan = (plan) => (PLANS.has(plan) ? plan : 'free');

/** Seconds per day and used today from the relay's allowance object, as whole numbers; missing values are 0. */
export function cleanAllowance(allowance) {
  const a = allowance && typeof allowance === 'object' ? allowance : {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const resetsAt = typeof a.resetsAt === 'string' && !Number.isNaN(Date.parse(a.resetsAt)) ? a.resetsAt : '';
  return { secondsPerDay: n(a.secondsPerDay), usedToday: n(a.usedToday), resetsAt };
}

/** The shared cache path of one video's descriptions in one language (PUT); GET adds the script version. */
export const scriptPath = (videoId, lang) => `/v1/scripts/${encodeURIComponent(videoId)}?lang=${encodeURIComponent(lang)}`;
export const scriptGetPath = (videoId, lang) => `${scriptPath(videoId, lang)}&v=${SCRIPT_VERSION}`;

/** How long a relay request that is not a model call may take. */
const TIMEOUT_MS = 15000;

/**
 * One request to the relay's own routes. The token goes in the x-goog-api-key
 * header (the relay reads the same header as Gemini), never in the address.
 * Resolves to { status, body }; throws ApiError('network') when nothing came back.
 */
export async function cloudRequest(fetchImpl, path, { method = 'GET', body, token = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-goog-api-key'] = token;
  let res;
  try {
    res = await fetchImpl(`${CLOUD_API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    throw new ApiError('network', String(err?.message || err));
  } finally {
    clearTimeout(timer);
  }
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** The relay's error message, when its reply had one, else the HTTP status. */
const detailOf = (status, body) => String(body?.error?.message || `HTTP ${status}`);

/**
 * Register this installation and get its anonymous device token with the free
 * allowance. No account: the relay only counts a token's seconds per day.
 * Resolves to { token, plan, allowance }.
 */
export async function registerDevice(fetchImpl, { version = '', locale = '' } = {}) {
  const { status, body } = await cloudRequest(fetchImpl, '/v1/devices', { method: 'POST', body: { client: 'extension', version, locale } });
  if (status === 429) {
    // The relay's own 429 here: this network has set up as many new devices as
    // it may today. Not a rate limit a minute's wait would clear, so it is its
    // own code, with the time (next UTC midnight) the relay says it opens again.
    const details = Array.isArray(body?.error?.details) ? body.error.details : [];
    const limit = details.find((d) => d?.reason === 'SCENEVOICE_DEVICE_LIMIT');
    if (limit) {
      const err = new ApiError('device-limit', detailOf(status, body), status);
      err.resetAt = cleanAllowance(limit).resetsAt;
      throw err;
    }
    throw new ApiError('rate-limited', detailOf(status, body), status);
  }
  if (status < 200 || status >= 300 || !validToken(body?.token)) throw new ApiError('request-failed', detailOf(status, body), status);
  return { token: body.token, plan: cleanPlan(body.plan), allowance: cleanAllowance(body.allowance) };
}

/** The plan and allowance of a token: { plan, allowance, cacheHits }. A token the relay no longer knows is 'bad-key'. */
export async function fetchMe(fetchImpl, token) {
  const { status, body } = await cloudRequest(fetchImpl, '/v1/me', { token });
  if (status === 401) throw new ApiError('bad-key', detailOf(status, body), status);
  if (status < 200 || status >= 300) throw new ApiError('request-failed', detailOf(status, body), status);
  return { plan: cleanPlan(body?.plan), allowance: cleanAllowance(body?.allowance), cacheHits: Number(body?.cacheHits) || 0 };
}

/** A licence key as the owner issues them: svl- and three groups of four. */
export const validLicenseKey = (key) => typeof key === 'string' && /^svl-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(key.trim());

/** Attach a Plus or organisation licence to this token: { plan, allowance }. An unknown key is 'not-found'. */
export async function activateLicense(fetchImpl, token, licenseKey) {
  const { status, body } = await cloudRequest(fetchImpl, '/v1/licenses/activate', { method: 'POST', token, body: { licenseKey: String(licenseKey || '').trim() } });
  if (status === 404) throw new ApiError('not-found', detailOf(status, body), status);
  if (status === 401) throw new ApiError('bad-key', detailOf(status, body), status);
  if (status === 409) throw new ApiError('license-full', detailOf(status, body), status);
  if (status < 200 || status >= 300) throw new ApiError('request-failed', detailOf(status, body), status);
  return { plan: cleanPlan(body?.plan), allowance: cleanAllowance(body?.allowance) };
}

/** Fields of a description that every listener may see. `revised` and anything else about this computer stay behind. */
const CUE_FIELDS = ['start', 'gap', 'kind', 'priority', 'onScreenText', 'confidence', 'brief', 'standard', 'detailed'];

const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj?.[f] !== undefined).map((f) => [f, obj[f]]));

/**
 * The part of a finished script that goes to the shared cache: the text and
 * what it took, nothing about who made it or what they marked as wrong.
 * Null for a script that is not complete (the relay keeps only those).
 */
export function shareableScript(script) {
  if (!script || !script.complete || !Array.isArray(script.cues)) return null;
  return {
    version: SCRIPT_VERSION,
    videoId: script.videoId,
    lang: script.lang,
    duration: script.duration,
    cues: script.cues.map((c) => pick(c, CUE_FIELDS)),
    characters: Array.isArray(script.characters) ? script.characters.map((c) => pick(c, ['label', 'description'])) : [],
    videoType: typeof script.videoType === 'string' ? script.videoType : '',
    model: typeof script.model === 'string' ? script.model : '',
    usage: script.usage && typeof script.usage === 'object' ? pick(script.usage, ['input', 'output', 'thinking', 'requests']) : undefined,
    completedUntil: script.duration,
    complete: true,
  };
}

/** Longest script taken from the cache, as JSON: a day of dense description is well under this. */
const MAX_SHARED_BYTES = 2 * 1024 * 1024;

/**
 * Whether a script from the shared cache is one SceneVoice can play for this
 * video: the right video and language, this version, complete, with cues of
 * the saved shape. Anything else is ignored rather than trusted.
 */
export function cloudScriptOk(script, { videoId, lang, duration }) {
  if (!script || typeof script !== 'object' || Array.isArray(script)) return false;
  if (script.version !== SCRIPT_VERSION || script.videoId !== videoId || script.lang !== lang || script.complete !== true) return false;
  if (!Array.isArray(script.cues) || !script.cues.every((c) => c && typeof c === 'object' && Number.isFinite(c.start) && typeof c.standard === 'string')) return false;
  if (!Number.isFinite(script.duration) || script.duration <= 0) return false;
  // The length the tab sees and the one the script was made for should agree to within a few seconds.
  if (Number.isFinite(duration) && duration > 0 && Math.abs(script.duration - duration) > 5) return false;
  try {
    return JSON.stringify(script).length <= MAX_SHARED_BYTES;
  } catch {
    return false;
  }
}

/**
 * A cached script, as this computer saves it: the fields SceneVoice plays
 * from, and 'cloud' as where it came from. Whatever else the relay sent is dropped.
 */
export function adoptCloudScript(script) {
  const own = shareableScript(script);
  return { ...own, provider: 'cloud', source: 'cloud', createdAt: Date.now() };
}

/** Minutes of a seconds allowance, rounded, for the listener. */
export const allowanceMinutes = (seconds) => String(Math.max(0, Math.round((Number(seconds) || 0) / 60)));
