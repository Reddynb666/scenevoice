// SceneVoice Cloud relay: a metered proxy in front of Gemini (and DashScope for
// mainland China) so the extension can describe video without the user making
// an API key. No accounts: an installation gets an anonymous token, a daily
// allowance in seconds of video, and a shared cache of finished descriptions.
//
// Protocol v1 is written out in ../README.md; the extension implements the
// same document. Error bodies keep the upstream shapes (Google's on /v1beta/*
// and the relay's own /v1/*, OpenAI's on /compatible-mode/*) because the
// extension's classifiers read them.
//
// What the relay never does: log or store a request body (frames go through
// untouched), store pictures or questions, or put the upstream key anywhere
// but the request header to the upstream. The one look inside a model request
// is the top-level `model` of a free device's DashScope call, because that API
// names the model in the body; nothing read there is kept.

import * as store from './store.js';
import {
  corsHeaders,
  errorBody,
  jsonResponse,
  licenceKeyForSession,
  nextUtcMidnight,
  normaliseLicenceKey,
  originAllowed,
  parseAllowedOrigins,
  randomHex,
  sha256Hex,
  timingSafeEqual,
  utcDay,
} from './util.js';
import { verifyStripeSignature } from './stripe.js';

export const PROTOCOL_VERSION = 1;

const DEFAULT_GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_DASHSCOPE_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/**
 * Model names a free device may use: the flash and flash-lite text/vision
 * families, with a dated preview or a numbered snapshot. Anchored at both ends
 * so gemini-2.5-flash-image, -preview-tts, -live and -native-audio stay out.
 */
export const DEFAULT_FREE_MODELS = '^gemini-\\d(\\.\\d)?-flash(-lite)?(-preview(-\\d{2}-\\d{2,4})?|-\\d{3})?$';
/** Whatever FREE_MODELS says, a free device never gets a model that makes pictures or sound. */
const NEVER_FREE = /(image|tts|audio|live|native|embedding)/i;
/** DashScope model names a free device may use: the Qwen vision-language plus and flash lines. */
export const DEFAULT_QWEN_FREE_MODELS = '^qwen\\d(\\.\\d)?-vl-(plus|flash)$';
/** About this many prompt tokens per second of video at low resolution; pictures and text are charged the same way. */
const TOKENS_PER_SECOND = 100;
/** One output or thinking token costs about this many input tokens (the flash output/input price ratio). */
const DEFAULT_OUTPUT_TOKEN_WEIGHT = 5;
/** Request bodies carry base64 frames: 6 pictures at 640 px are well under this. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 512 * 1024;
const MAX_SMALL_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 300_000;
const PLANS = ['free', 'plus', 'org'];
const TOKEN_RE = /^svd_[0-9a-f]{32}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,128}$/;

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A regular expression from a var, or the default when the var is missing or does not compile. */
function patternFrom(value, fallback) {
  try {
    return new RegExp(value || fallback);
  } catch {
    return new RegExp(fallback);
  }
}

/** Settings from wrangler vars, with the defaults the README documents. */
export function readConfig(env) {
  const plus = positiveInt(env.PLUS_SECONDS_PER_DAY, 21600);
  return {
    geminiBase: String(env.GEMINI_API_BASE || DEFAULT_GEMINI_API_BASE).replace(/\/+$/, ''),
    dashscopeBase: String(env.DASHSCOPE_API_BASE || DEFAULT_DASHSCOPE_API_BASE).replace(/\/+$/, ''),
    secondsPerDay: {
      free: positiveInt(env.FREE_SECONDS_PER_DAY, 3600),
      plus,
      org: positiveInt(env.ORG_SECONDS_PER_DAY, plus),
    },
    freeModels: patternFrom(env.FREE_MODELS, DEFAULT_FREE_MODELS),
    qwenFreeModels: patternFrom(env.QWEN_FREE_MODELS, DEFAULT_QWEN_FREE_MODELS),
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    devicesPerIpPerDay: positiveInt(env.DEVICES_PER_IP_PER_DAY, 20),
    // Charged when an upstream answer carries no token count (it should always
    // carry one), so a response the relay cannot meter is never free.
    unmeteredSeconds: positiveInt(env.UNMETERED_RESPONSE_SECONDS, 120),
    outputTokenWeight: positiveInt(env.OUTPUT_TOKEN_WEIGHT, DEFAULT_OUTPUT_TOKEN_WEIGHT),
    // Model calls one token may start per minute: the allowance is charged after
    // the answer, so without this a burst of requests would all pass the check.
    requestsPerMinute: positiveInt(env.REQUESTS_PER_MINUTE, 60),
    // Shared scripts one token may upload per UTC day.
    scriptPutsPerDay: positiveInt(env.SCRIPT_PUTS_PER_DAY, 20),
  };
}

/**
 * Handles one request. `deps` lets tests inject fetch, the clock and the log;
 * the Worker export below passes none.
 */
export async function handle(request, env, ctx, deps = {}) {
  const c = {
    request,
    env,
    ctx,
    url: new URL(request.url),
    cfg: readConfig(env),
    now: deps.now ? deps.now() : Date.now(),
    fetch: deps.fetch || ((...args) => fetch(...args)),
    log: deps.log || ((line) => console.log(line)),
    token: '',
    device: null,
    seconds: 0,
    routeName: '',
  };
  c.style = c.url.pathname.startsWith('/compatible-mode/') ? 'openai' : 'gemini';
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin);

  let res;
  if (!originAllowed(origin, c.cfg.allowedOrigins)) {
    res = fail(c, 403, 'This origin may not use the SceneVoice relay', { reason: 'SCENEVOICE_ORIGIN' });
  } else if (request.method === 'OPTIONS') {
    res = new Response(null, { status: 204 });
  } else {
    try {
      res = await route(c);
    } catch (err) {
      // Never put err.message in the response: it could name an internal detail.
      c.log(JSON.stringify({ route: c.routeName, error: String(err?.name || 'Error') }));
      res = fail(c, 500, 'The SceneVoice relay hit an internal error');
    }
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');
  res.headers.set('x-content-type-options', 'nosniff');
  // Route template, status, token prefix and seconds charged: nothing else.
  c.log(JSON.stringify({ route: c.routeName || `${request.method} ?`, status: res.status, token: c.token ? c.token.slice(0, 8) : '', seconds: c.seconds }));
  return res;
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};

// ---------------------------------------------------------------------------
// Routing

async function route(c) {
  const { method } = c.request;
  const p = c.url.pathname;
  const only = (allowed, name, fn) => {
    c.routeName = `${allowed} ${name}`;
    if (method !== allowed) return fail(c, 405, `Use ${allowed} for ${name}`);
    return fn();
  };

  if (p === '/' && method === 'GET') {
    c.routeName = 'GET /';
    return new Response('SceneVoice Cloud relay. Source and protocol: https://github.com/reddynb666/scenevoice/tree/main/server\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (p === '/healthz' && method === 'GET') {
    c.routeName = 'GET /healthz';
    return new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (p === '/v1/devices') return only('POST', '/v1/devices', () => createDevice(c));
  if (p === '/v1/me') return only('GET', '/v1/me', () => me(c));
  if (p === '/v1beta/models') return only('GET', '/v1beta/models', () => listModels(c));
  let m = p.match(/^\/v1beta\/models\/([^/]+):generateContent$/);
  if (m) return only('POST', '/v1beta/models/:model:generateContent', () => generateGemini(c, decodeURIComponent(m[1])));
  if (p === '/compatible-mode/v1/chat/completions') return only('POST', '/compatible-mode/v1/chat/completions', () => chatQwen(c));
  m = p.match(/^\/v1\/scripts\/([^/]+)$/);
  if (m) {
    const videoId = decodeURIComponent(m[1]);
    if (method === 'GET') {
      c.routeName = 'GET /v1/scripts/:videoId';
      return getScript(c, videoId);
    }
    if (method === 'PUT') {
      c.routeName = 'PUT /v1/scripts/:videoId';
      return putScript(c, videoId);
    }
    c.routeName = `${method} /v1/scripts/:videoId`;
    return fail(c, 405, 'Use GET or PUT for /v1/scripts/{videoId}');
  }
  if (p === '/v1/licenses/activate') return only('POST', '/v1/licenses/activate', () => activateLicence(c));
  if (p === '/webhooks/stripe') return only('POST', '/webhooks/stripe', () => stripeWebhook(c));
  m = p.match(/^\/admin\/licenses\/([^/]+)$/);
  if (m) return only('GET', '/admin/licenses/:session', () => adminLicence(c, decodeURIComponent(m[1])));
  c.routeName = `${method} (unknown)`;
  return fail(c, 404, 'No such route on the SceneVoice relay');
}

// ---------------------------------------------------------------------------
// Errors, auth and allowance

/** An error response in the style of the route, with optional reason details. */
function fail(c, status, message, { reason, fields, headers } = {}) {
  let body;
  if (c.style === 'openai') {
    body = errorBody('openai', status, message, {
      type: reason ? `scenevoice_${reason.replace(/^SCENEVOICE_/, '').toLowerCase()}` : 'scenevoice_error',
      code: String(status),
      fields,
    });
  } else {
    body = errorBody('gemini', status, message, reason ? { details: [{ reason, ...(fields || {}) }] } : {});
  }
  return jsonResponse(body, status, headers);
}

/** The device token from either header the two clients use. */
function bearerToken(request) {
  const g = request.headers.get('x-goog-api-key');
  if (g) return g.trim();
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/** Loads the device for the request's token, or returns the 401 to send. */
async function authenticate(c) {
  const token = bearerToken(c.request);
  if (!TOKEN_RE.test(token)) {
    return fail(c, 401, 'Missing or malformed SceneVoice device token. Register with POST /v1/devices.', { reason: 'SCENEVOICE_DEVICE_UNKNOWN' });
  }
  const device = await store.getDevice(c.env, token);
  if (!device) {
    return fail(c, 401, 'Unknown SceneVoice device token. Register again with POST /v1/devices.', { reason: 'SCENEVOICE_DEVICE_UNKNOWN' });
  }
  c.token = token;
  c.device = await followLicence(c, device);
  return null;
}

/**
 * The plan comes from the licence record, not from the copy on the device: a
 * licence the owner deleted (refund, cancelled subscription) or edited takes
 * effect on the device's next request. One extra KV read, for licensed devices only.
 */
async function followLicence(c, device) {
  if (typeof device.licence !== 'string' || !device.licence) return device;
  const licence = await store.getLicence(c.env, device.licence);
  if (!licence) {
    const downgraded = { ...device, plan: 'free', licence: null, revoked: new Date(c.now).toISOString() };
    await store.putDevice(c.env, c.token, downgraded);
    return downgraded;
  }
  const plan = PLANS.includes(licence.plan) ? licence.plan : 'plus';
  if (plan === device.plan) return device;
  const changed = { ...device, plan };
  await store.putDevice(c.env, c.token, changed);
  return changed;
}

async function allowanceOf(c) {
  const plan = PLANS.includes(c.device?.plan) ? c.device.plan : 'free';
  const day = utcDay(c.now);
  const usedToday = c.token ? await store.getUsedSeconds(c.env, c.token, day) : 0;
  return { plan, day, usedToday, secondsPerDay: c.cfg.secondsPerDay[plan], resetsAt: nextUtcMidnight(c.now) };
}

function allowanceJson(a) {
  return { secondsPerDay: a.secondsPerDay, usedToday: a.usedToday, resetsAt: a.resetsAt };
}

function allowanceHeaders(a) {
  return {
    'x-scenevoice-plan': a.plan,
    'x-scenevoice-used-today': String(a.usedToday),
    'x-scenevoice-seconds-per-day': String(a.secondsPerDay),
    'x-scenevoice-resets-at': a.resetsAt,
  };
}

function allowanceExhausted(c, a) {
  const message = 'SceneVoice allowance for today is used up';
  const headers = allowanceHeaders(a);
  if (c.style === 'openai') {
    return jsonResponse({ error: { message, type: 'scenevoice_allowance', code: 'allowance', resetsAt: a.resetsAt } }, 429, headers);
  }
  return jsonResponse(
    { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message, details: [{ reason: 'SCENEVOICE_ALLOWANCE', resetsAt: a.resetsAt, plan: a.plan }] } },
    429,
    headers,
  );
}

/**
 * Seconds to charge for an upstream answer, from its token counts: the prompt
 * tokens, plus the output and thinking tokens weighted by their price. An
 * answer without a prompt count is charged the flat unmetered amount.
 */
export function secondsFor({ input, output } = {}, cfg) {
  if (!Number.isFinite(input) || input < 0) return cfg.unmeteredSeconds;
  const out = Number.isFinite(output) && output > 0 ? output : 0;
  return Math.ceil((input + cfg.outputTokenWeight * out) / TOKENS_PER_SECOND);
}

const tokenCount = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** Token counts of a Gemini answer: output includes the thinking tokens, which Google bills as output. */
function geminiUsage(json) {
  const u = json?.usageMetadata;
  if (!u || !Number.isFinite(u.promptTokenCount)) return {};
  return { input: u.promptTokenCount, output: tokenCount(u.candidatesTokenCount) + tokenCount(u.thoughtsTokenCount) };
}

/** Token counts of an OpenAI-style answer: DashScope already counts reasoning inside completion_tokens. */
function openaiUsage(json) {
  const u = json?.usage;
  if (!u || !Number.isFinite(u.prompt_tokens)) return {};
  return { input: u.prompt_tokens, output: tokenCount(u.completion_tokens) };
}

/** The per-minute 429, with the wait the extension's retry already understands. */
function rateLimited(c, a) {
  const message = 'Too many SceneVoice requests this minute. Wait a moment and try again.';
  const headers = { ...allowanceHeaders(a), 'retry-after': '60' };
  if (c.style === 'openai') {
    return jsonResponse({ error: { message, type: 'scenevoice_rate_limit', code: '429' } }, 429, headers);
  }
  return jsonResponse(
    {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message,
        details: [{ reason: 'SCENEVOICE_RATE_LIMIT' }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '60s' }],
      },
    },
    429,
    headers,
  );
}

// ---------------------------------------------------------------------------
// Request bodies

/** Reads a small JSON body, or returns the 4xx to send. Never used for model requests. */
async function readJson(c, maxBytes = MAX_SMALL_BODY_BYTES) {
  const declared = Number(c.request.headers.get('content-length'));
  if (declared > maxBytes) return { error: fail(c, 413, `Request body is larger than ${maxBytes} bytes`) };
  let text;
  try {
    text = await c.request.text();
  } catch {
    return { error: fail(c, 400, 'Could not read the request body') };
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) return { error: fail(c, 413, `Request body is larger than ${maxBytes} bytes`) };
  if (!text.trim()) return { value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: fail(c, 400, 'Request body must be a JSON object') };
    return { value, text };
  } catch {
    return { error: fail(c, 400, 'Request body is not valid JSON') };
  }
}

/**
 * Reads a model request body as bytes without looking inside it. A declared
 * length over the limit is refused outright; a body without one (chunked) is
 * read chunk by chunk and dropped the moment it passes the limit, so an
 * oversized upload never sits in memory next to other people's requests.
 */
async function readRawBody(c) {
  const declared = Number(c.request.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) return { error: fail(c, 413, 'Request body is larger than 20 MB') };
  if (!c.request.body) return { bytes: new Uint8Array(0) };
  const chunks = [];
  let total = 0;
  const reader = c.request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: fail(c, 413, 'Request body is larger than 20 MB') };
      }
      chunks.push(value);
    }
  } catch {
    return { error: fail(c, 400, 'Could not read the request body') };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

// ---------------------------------------------------------------------------
// Upstream

/** fetch with the upstream timeout. Returns { res } or { error: 'timeout' | 'network' }. */
async function upstream(c, url, init) {
  try {
    const res = await c.fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    return { res };
  } catch (err) {
    return { error: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

function upstreamFailure(c, error, headers) {
  if (error === 'timeout') return fail(c, 504, 'The model did not answer within 300 seconds', { reason: 'SCENEVOICE_UPSTREAM_TIMEOUT', headers });
  return fail(c, 502, 'The relay could not reach the model', { reason: 'SCENEVOICE_UPSTREAM_UNREACHABLE', headers });
}

/** The upstream answer, status and body unchanged, with the relay's headers added. */
function passThrough(res, text, headers) {
  const noBody = [204, 205, 304].includes(res.status);
  return new Response(noBody ? null : text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8', ...headers },
  });
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The allowance and per-minute checks every model call goes through first, or
 * null when the call may proceed. The minute is counted before the body is read.
 */
async function admitModelCall(c, a) {
  if (a.usedToday >= a.secondsPerDay) return allowanceExhausted(c, a);
  const minute = Math.floor(c.now / 60_000);
  const calls = await store.countRequest(c.env, c.token, minute);
  if (calls > c.cfg.requestsPerMinute) return rateLimited(c, a);
  return null;
}

/**
 * The shared part of the two model routes: forward the bytes, charge for the
 * tokens the upstream reports, pass the answer back unchanged. `usage(json)`
 * knows where each API puts the counts; `bytes` is the body when the route
 * already read it.
 */
async function proxyModelCall(c, { url, headers, usage, allowance, bytes }) {
  const a = allowance;
  if (!bytes) {
    const body = await readRawBody(c);
    if (body.error) return body.error;
    bytes = body.bytes;
  }
  const r = await upstream(c, url, {
    method: 'POST',
    headers: { 'content-type': c.request.headers.get('content-type') || 'application/json', ...headers },
    body: bytes,
  });
  if (r.error) return upstreamFailure(c, r.error, allowanceHeaders(a));
  const text = await r.res.text();
  if (r.res.ok) {
    const seconds = secondsFor(usage(tryJson(text)), c.cfg);
    if (seconds > 0) a.usedToday = await store.addUsedSeconds(c.env, c.token, a.day, seconds);
    c.seconds = seconds;
  }
  return passThrough(r.res, text, allowanceHeaders(a));
}

// ---------------------------------------------------------------------------
// Devices

async function createDevice(c) {
  const body = await readJson(c, 4096);
  if (body.error) return body.error;
  for (const field of ['client', 'version', 'locale']) {
    if (body.value[field] !== undefined && typeof body.value[field] !== 'string') return fail(c, 400, `${field} must be a string`);
  }
  const day = utcDay(c.now);
  // The address is hashed with the day, so one day's keys cannot be joined with the next.
  const ip = c.request.headers.get('cf-connecting-ip') || c.request.headers.get('x-forwarded-for') || 'unknown';
  const ipHash = (await sha256Hex(`${day}:${ip}`)).slice(0, 32);
  const count = await store.countRegistration(c.env, ipHash, day);
  if (count > c.cfg.devicesPerIpPerDay) {
    return fail(c, 429, 'Too many new SceneVoice devices from this network today. Try again tomorrow.', {
      reason: 'SCENEVOICE_DEVICE_LIMIT',
      fields: { resetsAt: nextUtcMidnight(c.now) },
    });
  }
  const token = `svd_${randomHex(16)}`;
  const record = { plan: 'free', created: new Date(c.now).toISOString(), licence: null };
  await store.putDevice(c.env, token, record);
  c.token = token;
  c.device = record;
  const a = { plan: 'free', day, usedToday: 0, secondsPerDay: c.cfg.secondsPerDay.free, resetsAt: nextUtcMidnight(c.now) };
  return jsonResponse({ token, plan: 'free', allowance: allowanceJson(a) }, 201, allowanceHeaders(a));
}

async function me(c) {
  const denied = await authenticate(c);
  if (denied) return denied;
  const a = await allowanceOf(c);
  const cacheHits = await store.getCacheHits(c.env, c.token);
  return jsonResponse({ plan: a.plan, allowance: allowanceJson(a), cacheHits }, 200, allowanceHeaders(a));
}

// ---------------------------------------------------------------------------
// Gemini-compatible routes

function geminiKeyMissing(c) {
  return c.env.GEMINI_API_KEY ? null : fail(c, 501, 'This relay has no Gemini key configured', { reason: 'SCENEVOICE_NOT_CONFIGURED' });
}

async function listModels(c) {
  const denied = await authenticate(c);
  if (denied) return denied;
  const missing = geminiKeyMissing(c);
  if (missing) return missing;
  const a = await allowanceOf(c);
  const url = new URL(`${c.cfg.geminiBase}/v1beta/models`);
  for (const param of ['pageSize', 'pageToken']) {
    const v = c.url.searchParams.get(param);
    if (v) url.searchParams.set(param, v);
  }
  const r = await upstream(c, url.toString(), { method: 'GET', headers: { 'x-goog-api-key': c.env.GEMINI_API_KEY } });
  if (r.error) return upstreamFailure(c, r.error, allowanceHeaders(a));
  const text = await r.res.text();
  const body = r.res.ok ? tryJson(text) : null;
  if (!body) return passThrough(r.res, text, allowanceHeaders(a));
  if (a.plan === 'free' && Array.isArray(body.models)) {
    body.models = body.models.filter((m) => freeGeminiModel(c, String(m?.name || '').replace(/^models\//, '')));
  }
  return jsonResponse(body, 200, allowanceHeaders(a));
}

/** Whether a free device may call this Gemini model: within FREE_MODELS and never a picture or sound model. */
const freeGeminiModel = (c, model) => c.cfg.freeModels.test(model) && !NEVER_FREE.test(model);

async function generateGemini(c, model) {
  const denied = await authenticate(c);
  if (denied) return denied;
  const missing = geminiKeyMissing(c);
  if (missing) return missing;
  if (!MODEL_RE.test(model)) return fail(c, 400, 'Malformed model name');
  const a = await allowanceOf(c);
  if (a.plan === 'free' && !freeGeminiModel(c, model)) {
    // 404 so the extension's existing handling (pick another model from the list) applies.
    return fail(c, 404, `Model ${model} is not available on the free plan`, { reason: 'SCENEVOICE_MODEL_NOT_ALLOWED', headers: allowanceHeaders(a) });
  }
  const refused = await admitModelCall(c, a);
  if (refused) return refused;
  return proxyModelCall(c, {
    url: `${c.cfg.geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'x-goog-api-key': c.env.GEMINI_API_KEY },
    usage: geminiUsage,
    allowance: a,
  });
}

// ---------------------------------------------------------------------------
// Qwen-compatible route (mainland China deployments)

/**
 * The top-level `model` of a chat-completions body, or '' when there is none.
 * The only field of any model request the relay reads; the bytes themselves
 * go upstream unchanged and nothing parsed here is kept or logged.
 */
function qwenModelOf(bytes) {
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return '';
  }
  const model = body && typeof body === 'object' && !Array.isArray(body) ? body.model : '';
  return typeof model === 'string' && MODEL_RE.test(model) ? model : '';
}

async function chatQwen(c) {
  const denied = await authenticate(c);
  if (denied) return denied;
  if (!c.env.DASHSCOPE_API_KEY) return fail(c, 501, 'This relay has no DashScope key configured', { reason: 'SCENEVOICE_NOT_CONFIGURED' });
  const a = await allowanceOf(c);
  const refused = await admitModelCall(c, a);
  if (refused) return refused;
  const body = await readRawBody(c);
  if (body.error) return body.error;
  if (a.plan === 'free') {
    // DashScope names the model in the body, so the free-plan gate has to read that one field.
    const model = qwenModelOf(body.bytes);
    if (!model) return fail(c, 400, 'Request body must be a JSON object naming a model', { headers: allowanceHeaders(a) });
    if (!c.cfg.qwenFreeModels.test(model)) {
      return fail(c, 404, `Model ${model} is not available on the free plan`, { reason: 'SCENEVOICE_MODEL_NOT_ALLOWED', headers: allowanceHeaders(a) });
    }
  }
  return proxyModelCall(c, {
    url: `${c.cfg.dashscopeBase}/chat/completions`,
    headers: { authorization: `Bearer ${c.env.DASHSCOPE_API_KEY}` },
    usage: openaiUsage,
    allowance: a,
    bytes: body.bytes,
  });
}

// ---------------------------------------------------------------------------
// Shared description cache (text only)

const MAX_CUES = 5000;
const MAX_TEXT = 2000;
const CUE_STRINGS = ['brief', 'standard', 'detailed', 'onScreenText'];

const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);
const shortString = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

/**
 * A script as the relay will store it: only known fields, every string capped
 * so nothing picture-sized fits, and complete. Returns { script } or { error }.
 */
export function validateScript(raw, videoId, lang) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Script must be a JSON object' };
  if (raw.complete !== true) return { error: 'Only complete scripts are shared' };
  if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > 99) return { error: 'Script version must be a small integer' };
  if (!Array.isArray(raw.cues)) return { error: 'Script cues must be an array' };
  if (raw.cues.length > MAX_CUES) return { error: `Script has more than ${MAX_CUES} cues` };
  if (raw.videoId !== undefined && raw.videoId !== videoId) return { error: 'Script videoId does not match the address' };
  if (raw.lang !== undefined && raw.lang !== lang) return { error: 'Script lang does not match the address' };

  const cues = [];
  for (const item of raw.cues) {
    if (!item || typeof item !== 'object') return { error: 'Each cue must be an object' };
    const start = finiteOrNull(item.start);
    if (start === null || start < 0) return { error: 'Each cue needs a non-negative start' };
    const cue = { start };
    const gap = finiteOrNull(item.gap);
    if (gap !== null) cue.gap = Math.min(Math.max(gap, 0), 60);
    cue.kind = item.kind === 'text' ? 'text' : 'visual';
    if ([1, 2, 3].includes(item.priority)) cue.priority = item.priority;
    for (const field of CUE_STRINGS) {
      if (item[field] === undefined) continue;
      const s = shortString(item[field], MAX_TEXT);
      if (s === null) return { error: `Cue ${field} must be a string of at most ${MAX_TEXT} characters` };
      cue[field] = s;
    }
    if (!cue.standard) return { error: 'Each cue needs a standard description' };
    if (item.confidence !== undefined) {
      const s = shortString(item.confidence, 16);
      if (s === null) return { error: 'Cue confidence must be a short string' };
      cue.confidence = s;
    }
    cues.push(cue);
  }

  const characters = [];
  if (raw.characters !== undefined) {
    if (!Array.isArray(raw.characters) || raw.characters.length > 100) return { error: 'Script characters must be a short array' };
    for (const ch of raw.characters) {
      if (!ch || typeof ch !== 'object') return { error: 'Each character must be an object' };
      const out = {};
      for (const [k, v] of Object.entries(ch)) {
        if (typeof v !== 'string' || v.length > 200 || k.length > 32) return { error: 'Character fields must be short strings' };
        out[k] = v;
      }
      if (!out.label) return { error: 'Each character needs a label' };
      characters.push(out);
    }
  }

  const script = { version: raw.version, videoId, lang, cues, characters, complete: true, source: 'cloud' };
  const duration = finiteOrNull(raw.duration);
  if (duration !== null && duration >= 0) script.duration = duration;
  const completedUntil = finiteOrNull(raw.completedUntil);
  if (completedUntil !== null && completedUntil >= 0) script.completedUntil = completedUntil;
  for (const [field, max] of [['videoType', 32], ['model', 128]]) {
    if (raw[field] === undefined) continue;
    const s = shortString(raw[field], max);
    if (s === null) return { error: `Script ${field} must be a short string` };
    script[field] = s;
  }
  for (const field of ['createdAt', 'updatedAt']) {
    const n = finiteOrNull(raw[field]);
    if (n !== null) script[field] = n;
  }
  return { script };
}

function scriptAddress(c, videoId, { needVersion }) {
  const lang = c.url.searchParams.get('lang') || '';
  const version = parseInt(c.url.searchParams.get('v'), 10);
  if (!VIDEO_ID_RE.test(videoId)) return { error: fail(c, 400, 'Malformed video id') };
  if (!LANG_RE.test(lang)) return { error: fail(c, 400, 'Missing or malformed lang') };
  if (needVersion && !(Number.isInteger(version) && version >= 1 && version <= 99)) return { error: fail(c, 400, 'Missing or malformed v') };
  return { lang, version };
}

async function getScript(c, videoId) {
  const addr = scriptAddress(c, videoId, { needVersion: true });
  if (addr.error) return addr.error;
  const script = await store.getScript(c.env, videoId, addr.lang, addr.version);
  if (!script) return fail(c, 404, 'No shared description for this video yet', { reason: 'SCENEVOICE_SCRIPT_NOT_FOUND' });
  // A token is optional here; with one, the hit is counted for GET /v1/me.
  const token = bearerToken(c.request);
  if (TOKEN_RE.test(token) && (await store.getDevice(c.env, token))) {
    c.token = token;
    const counting = store.addCacheHit(c.env, token);
    if (c.ctx?.waitUntil) c.ctx.waitUntil(counting);
    else await counting;
  }
  return jsonResponse({ ...script, source: 'cloud' }, 200, { 'cache-control': 'private, max-age=0' });
}

/**
 * Who may fill the shared cache, since every Cloud listener of a video hears
 * what is stored for it: a device that has actually had something described
 * through the relay (charged seconds today or yesterday, for a job that crosses
 * midnight), at most SCRIPT_PUTS_PER_DAY uploads a day, and never over a script
 * that is already there (first writer wins; the owner removes a bad one by
 * hand). Nothing about the uploader is stored with the script.
 */
async function putScript(c, videoId) {
  const denied = await authenticate(c);
  if (denied) return denied;
  const addr = scriptAddress(c, videoId, { needVersion: false });
  if (addr.error) return addr.error;
  const day = utcDay(c.now);
  const earned = (await store.getUsedSeconds(c.env, c.token, day)) + (await store.getUsedSeconds(c.env, c.token, utcDay(c.now - 86_400_000)));
  if (earned <= 0) {
    return fail(c, 403, 'Only a device that has had video described through SceneVoice Cloud can share descriptions', { reason: 'SCENEVOICE_SCRIPT_UNEARNED' });
  }
  const puts = await store.countScriptPut(c.env, c.token, day);
  if (puts > c.cfg.scriptPutsPerDay) {
    return fail(c, 429, 'This device has shared as many descriptions as it may today', { reason: 'SCENEVOICE_SHARE_LIMIT', fields: { resetsAt: nextUtcMidnight(c.now) } });
  }
  const body = await readJson(c, MAX_SCRIPT_BYTES);
  if (body.error) return body.error;
  const checked = validateScript(body.value, videoId, addr.lang);
  if (checked.error) return fail(c, 400, checked.error, { reason: 'SCENEVOICE_SCRIPT_INVALID' });
  const stored = await store.putScriptIfAbsent(c.env, videoId, addr.lang, checked.script.version, checked.script);
  // 204 either way: the extension has nothing to do when the cache already had one.
  return new Response(null, { status: 204, headers: { 'x-scenevoice-stored': stored ? '1' : '0' } });
}

// ---------------------------------------------------------------------------
// Licences

async function activateLicence(c) {
  const denied = await authenticate(c);
  if (denied) return denied;
  const body = await readJson(c, 4096);
  if (body.error) return body.error;
  const key = normaliseLicenceKey(body.value.licenseKey);
  const licence = key ? await store.getLicence(c.env, key) : null;
  if (!licence) return fail(c, 404, 'Licence key not found', { reason: 'SCENEVOICE_LICENCE_NOT_FOUND' });
  if (c.device.licence !== key) {
    if ((licence.used || 0) >= (licence.seats || 1)) {
      return fail(c, 409, 'All seats of this licence are in use', { reason: 'SCENEVOICE_LICENCE_FULL' });
    }
    licence.used = (licence.used || 0) + 1;
    await store.putLicence(c.env, key, licence);
  }
  const plan = PLANS.includes(licence.plan) ? licence.plan : 'plus';
  c.device = { ...c.device, plan, licence: key, activated: new Date(c.now).toISOString() };
  await store.putDevice(c.env, c.token, c.device);
  const a = await allowanceOf(c);
  return jsonResponse({ plan, allowance: allowanceJson(a) }, 200, allowanceHeaders(a));
}

// OWNER TO FINISH: this is the smallest webhook that turns a paid Checkout
// session into a licence key. The owner's Stripe setup must (1) create the
// Checkout session with metadata.plan ('plus' or 'org') and metadata.seats,
// (2) point the webhook at /webhooks/stripe with STRIPE_WEBHOOK_SECRET set, and
// (3) show the key after purchase: the success page calls the owner-only
// GET /admin/licenses/{session_id} (ADMIN_TOKEN) from the owner's own backend
// and emails or displays the key. Refunds and subscription cancellations are
// not handled here: revoke by deleting the licence record by hand; every device
// on it drops to free on its next request (see followLicence).
async function stripeWebhook(c) {
  if (!c.env.STRIPE_WEBHOOK_SECRET) return fail(c, 501, 'Stripe webhook is not configured', { reason: 'SCENEVOICE_NOT_CONFIGURED' });
  const body = await readJson(c, 1024 * 1024);
  if (body.error) return body.error;
  const ok = await verifyStripeSignature(body.text || '', c.request.headers.get('stripe-signature'), c.env.STRIPE_WEBHOOK_SECRET, c.now);
  if (!ok) return fail(c, 400, 'Invalid Stripe signature');
  const event = body.value;
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    return jsonResponse({ received: true });
  }
  const session = event.data?.object || {};
  const sessionId = typeof session.id === 'string' ? session.id : '';
  if (!sessionId) return fail(c, 400, 'Event has no session id');
  if (session.payment_status === 'unpaid') return jsonResponse({ received: true, pending: true });
  const existing = await store.getLicenceKeyForSession(c.env, sessionId);
  if (existing) return jsonResponse({ received: true, licenseKey: existing });
  // The key is a function of the session, so two deliveries that both miss the
  // index above (Stripe retries, completed and async_payment_succeeded arriving
  // together) converge on one record instead of minting two activatable keys.
  const key = await licenceKeyForSession(c.env.LICENSE_KEY_SECRET || c.env.STRIPE_WEBHOOK_SECRET, sessionId);
  const stored = await store.getLicence(c.env, key);
  if (stored) {
    // A late re-delivery after an activation: keep the seats already taken, just restore the index.
    await store.putLicenceKeyForSession(c.env, sessionId, key);
    return jsonResponse({ received: true, licenseKey: key, plan: stored.plan, seats: stored.seats });
  }
  const meta = session.metadata || {};
  const plan = meta.plan === 'org' ? 'org' : 'plus';
  const seatsRaw = parseInt(meta.seats, 10);
  const seats = Number.isInteger(seatsRaw) && seatsRaw > 0 && seatsRaw <= 10000 ? seatsRaw : 1;
  await store.putLicence(c.env, key, { plan, seats, used: 0, created: new Date(c.now).toISOString(), session: sessionId });
  await store.putLicenceKeyForSession(c.env, sessionId, key);
  return jsonResponse({ received: true, licenseKey: key, plan, seats });
}

async function adminLicence(c, sessionId) {
  if (!c.env.ADMIN_TOKEN) return fail(c, 501, 'ADMIN_TOKEN is not configured', { reason: 'SCENEVOICE_NOT_CONFIGURED' });
  const m = (c.request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !timingSafeEqual(m[1].trim(), c.env.ADMIN_TOKEN)) return fail(c, 401, 'Admin token required');
  const key = await store.getLicenceKeyForSession(c.env, sessionId);
  const licence = key ? await store.getLicence(c.env, key) : null;
  if (!licence) return fail(c, 404, 'No licence for this session');
  return jsonResponse({ licenseKey: key, plan: licence.plan, seats: licence.seats, used: licence.used || 0 });
}
