// Stripe webhook signature check, done with Web Crypto so the Worker needs no
// npm dependency. Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 and
// sends "Stripe-Signature: t=<timestamp>,v1=<hex>[,v1=<hex>]". See
// https://docs.stripe.com/webhooks#verify-manually (checked 2026-11-04).

import { timingSafeEqual } from './util.js';

const encoder = new TextEncoder();
/** How old a signed timestamp may be, in seconds. Stripe's own libraries use 300. */
const TOLERANCE_SECONDS = 300;

export function parseStripeSignature(header) {
  const out = { t: 0, v1: [] };
  for (const part of String(header || '').split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k === 't') out.t = parseInt(v, 10) || 0;
    else if (k === 'v1' && v) out.v1.push(v.toLowerCase());
  }
  return out;
}

export async function hmacSha256Hex(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * True when the body was signed by Stripe with this endpoint's secret and the
 * timestamp is recent. `nowMs` is injectable for tests.
 */
export async function verifyStripeSignature(rawBody, header, secret, nowMs = Date.now()) {
  if (!secret) return false;
  const { t, v1 } = parseStripeSignature(header);
  if (!t || !v1.length) return false;
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_SECONDS) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return v1.some((candidate) => timingSafeEqual(candidate, expected));
}

/** Builds the header value Stripe would send: used by the tests and the README's curl example. */
export async function signForStripe(rawBody, secret, timestampSeconds) {
  return `t=${timestampSeconds},v1=${await hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`;
}
