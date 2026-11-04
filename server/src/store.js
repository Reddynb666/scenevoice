// Everything the relay remembers, behind small functions, so the owner can move
// from Workers KV to D1 (or anything else) by rewriting this file only.
//
// KV is eventually consistent and has no atomic increment: two requests that
// charge the same device in the same second can both read the old total. For a
// daily allowance measured in seconds that is acceptable; for exact billing it
// is not, which is the first reason to move to D1 or a Durable Object.
//
// Nothing here stores who a device is: a token record has a plan and dates,
// a usage record has a number, a script record has text. Client IPs are hashed
// before they become a key and the key lives one day.

const DAY_SECONDS = 86400;
const SCRIPT_TTL_SECONDS = 180 * DAY_SECONDS;
/** Usage records outlive their day a little so a request around midnight still finds them. */
const USAGE_TTL_SECONDS = 2 * DAY_SECONDS;

/** Devices: token -> { plan, created, licence } */
export async function getDevice(env, token) {
  return (await env.DEVICES.get(token, 'json')) || null;
}

export async function putDevice(env, token, record) {
  await env.DEVICES.put(token, JSON.stringify(record));
}

/** Usage: token:day -> seconds charged that UTC day. */
export async function getUsedSeconds(env, token, day) {
  const raw = await env.USAGE.get(`${token}:${day}`);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Adds seconds to a device's total for the day and returns the new total. */
export async function addUsedSeconds(env, token, day, seconds) {
  const total = (await getUsedSeconds(env, token, day)) + seconds;
  await env.USAGE.put(`${token}:${day}`, String(total), { expirationTtl: USAGE_TTL_SECONDS });
  return total;
}

/** How many times the shared cache answered for this device (shown in GET /v1/me). */
export async function getCacheHits(env, token) {
  const n = Number(await env.USAGE.get(`hits:${token}`));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function addCacheHit(env, token) {
  const total = (await getCacheHits(env, token)) + 1;
  await env.USAGE.put(`hits:${token}`, String(total));
  return total;
}

/** One more on a counter key, with a TTL; returns the count including this call. */
async function bump(env, key, ttl) {
  const n = Number(await env.USAGE.get(key)) || 0;
  const total = n + 1;
  await env.USAGE.put(key, String(total), { expirationTtl: ttl });
  return total;
}

/**
 * Device registrations from one network address today. The address itself is
 * never stored: the caller passes a hash. Returns the count including this call.
 */
export function countRegistration(env, ipHash, day) {
  return bump(env, `ip:${ipHash}:${day}`, DAY_SECONDS);
}

/** Model calls one device started in a minute (minute = floor(ms / 60000)), including this one. */
export function countRequest(env, token, minute) {
  return bump(env, `rpm:${token}:${minute}`, 120);
}

/** Shared scripts one device uploaded today, including this one. */
export function countScriptPut(env, token, day) {
  return bump(env, `puts:${token}:${day}`, USAGE_TTL_SECONDS);
}

/** Shared scripts: videoId:lang:version -> script JSON (text only). */
export async function getScript(env, videoId, lang, version) {
  return (await env.SCRIPTS.get(`${videoId}:${lang}:${version}`, 'json')) || null;
}

export async function putScript(env, videoId, lang, version, script) {
  await env.SCRIPTS.put(`${videoId}:${lang}:${version}`, JSON.stringify(script), { expirationTtl: SCRIPT_TTL_SECONDS });
}

/**
 * Stores a script only when none is there yet; returns whether it was stored.
 * KV has no compare-and-set, so two first uploads in the same moment can both
 * land (the later write stays); for a text cache that is acceptable.
 */
export async function putScriptIfAbsent(env, videoId, lang, version, script) {
  if (await getScript(env, videoId, lang, version)) return false;
  await putScript(env, videoId, lang, version, script);
  return true;
}

/** Licences: key -> { plan, seats, used, created, session }; session:<id> -> key. */
export async function getLicence(env, key) {
  return (await env.LICENSES.get(key, 'json')) || null;
}

export async function putLicence(env, key, record) {
  await env.LICENSES.put(key, JSON.stringify(record));
}

export async function getLicenceKeyForSession(env, sessionId) {
  return (await env.LICENSES.get(`session:${sessionId}`)) || null;
}

export async function putLicenceKeyForSession(env, sessionId, key) {
  await env.LICENSES.put(`session:${sessionId}`, key);
}
