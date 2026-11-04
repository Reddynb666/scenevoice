// Test doubles for the relay: an in-memory KV namespace, an env with the four
// bindings, and a fetch stub that records what reached the "upstream".

import { handle } from '../src/worker.js';

export const UPSTREAM_KEY = 'AIzaSy-UPSTREAM-SECRET-0000000000000000';
export const DASHSCOPE_KEY = 'sk-dashscope-upstream-secret-1111';

/** Enough of Workers KV for the relay: get(key, 'json'|undefined), put with expirationTtl, delete. */
export class MemoryKV {
  constructor() {
    this.map = new Map();
    this.ttls = new Map();
  }

  async get(key, type) {
    const v = this.map.has(key) ? this.map.get(key) : null;
    if (v === null) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }

  async put(key, value, opts = {}) {
    this.map.set(key, String(value));
    if (opts.expirationTtl) this.ttls.set(key, opts.expirationTtl);
  }

  async delete(key) {
    this.map.delete(key);
    this.ttls.delete(key);
  }
}

export function makeEnv(overrides = {}) {
  return {
    DEVICES: new MemoryKV(),
    USAGE: new MemoryKV(),
    SCRIPTS: new MemoryKV(),
    LICENSES: new MemoryKV(),
    GEMINI_API_KEY: UPSTREAM_KEY,
    DASHSCOPE_API_KEY: DASHSCOPE_KEY,
    ...overrides,
  };
}

/**
 * A fetch stub. `respond(url, init)` returns { status, body (object or string), headers }.
 * Every call is recorded in `calls` so tests can check what the upstream saw.
 */
export function makeFetch(respond) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const out = (await respond(String(url), init)) || { status: 200, body: {} };
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
    return new Response(text, {
      status: out.status || 200,
      headers: { 'content-type': 'application/json', ...(out.headers || {}) },
    });
  };
  fn.calls = calls;
  return fn;
}

/** A typical Gemini answer with a prompt token count. */
export const geminiAnswer = (promptTokenCount = 1234) => ({
  candidates: [{ content: { parts: [{ text: '{"cues":[]}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount, candidatesTokenCount: 10, totalTokenCount: promptTokenCount + 10 },
});

export const BASE = 'https://api.scenevoice.test';

/** Sends a request through the relay with injected fetch and clock. */
export function call(env, { method = 'GET', path = '/', headers = {}, body, fetch, now = Date.parse('2026-11-04T10:00:00Z'), ip = '203.0.113.7' }) {
  const init = { method, headers: { 'cf-connecting-ip': ip, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body : JSON.stringify(body);
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  const request = new Request(BASE + path, init);
  return handle(request, env, undefined, { fetch: fetch || makeFetch(() => ({ status: 500, body: { error: { message: 'no stub' } } })), now: () => now, log: () => {} });
}

/** Registers a device and returns its token. */
export async function register(env, opts = {}) {
  const res = await call(env, { method: 'POST', path: '/v1/devices', body: { client: 'extension', version: '1.1.0', locale: 'en' }, ...opts });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

export async function setPlan(env, token, plan) {
  const device = await env.DEVICES.get(token, 'json');
  await env.DEVICES.put(token, JSON.stringify({ ...device, plan }));
}
