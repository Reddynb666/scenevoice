// Usage accounting: the tokens and requests one answer cost, a script's running
// total, the rolling daily counter kept on this computer, and the rough price
// shown to the listener. Pure functions only: the service worker and the
// extension pages read and write chrome.storage.local themselves.
//
// The counts come from the model's own reply (Gemini usageMetadata, Qwen
// usage), so they are what the provider bills, not a guess. The price is a
// guess in the other direction: list prices (constants.js MODEL_PRICES) times
// those counts, which a free-tier Gemini key is never charged.

import { DAILY_BUDGETS, MODEL_PRICES, PROVIDERS } from './constants.js';

/** Providers the daily counter keeps a row for: the two with keys, and the SceneVoice Cloud relay (once each). */
export const COUNTED_PROVIDERS = Object.freeze([...new Set([...PROVIDERS, 'cloud'])]);

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export const EMPTY_USAGE = Object.freeze({ input: 0, output: 0, thinking: 0, requests: 0 });

/** The usage of one answer, as { input, output, thinking, requests: 1 }, from whatever counts the reply gave. */
export function countedUsage({ input, output, thinking } = {}) {
  return { input: count(input), output: count(output), thinking: count(thinking), requests: 1 };
}

/** The sum of two usages; either may be missing or malformed (old scripts have none). */
export function addUsage(a, b) {
  const x = a && typeof a === 'object' ? a : {};
  const y = b && typeof b === 'object' ? b : {};
  return { input: count(x.input) + count(y.input), output: count(x.output) + count(y.output), thinking: count(x.thinking) + count(y.thinking), requests: count(x.requests) + count(y.requests) };
}

/** Today's date on this computer, as YYYY-MM-DD. The counter starts again at local midnight. */
export function localDay(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const emptyRow = () => ({ input: 0, output: 0, requests: 0, seconds: 0, cost: 0 });

/** An empty day's counter: one row per provider. */
export function emptyDay(day) {
  const out = { day };
  for (const p of COUNTED_PROVIDERS) out[p] = emptyRow();
  return out;
}

function cleanRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  const money = typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost > 0 ? r.cost : 0;
  return { input: count(r.input), output: count(r.output), requests: count(r.requests), seconds: count(r.seconds), cost: money };
}

/**
 * The stored counter as it stands today: its rows checked, and a fresh day when
 * the stored one is from another day (or from nowhere).
 */
export function todaysUsage(stored, now = new Date()) {
  const day = localDay(now);
  if (!stored || typeof stored !== 'object' || stored.day !== day) return emptyDay(day);
  const out = { day };
  for (const p of COUNTED_PROVIDERS) out[p] = cleanRow(stored[p]);
  return out;
}

/**
 * Seconds of video a request stands for when the caller does not know: about
 * a hundred input tokens per second is a rough middle between a video link
 * (Gemini counts about 300 a second) and a few small pictures (far fewer).
 */
export const secondsFromTokens = (usage) => Math.ceil(count(usage?.input) / 100);

/**
 * The counter with one more answer added to a provider's row. `seconds` is the
 * length of video the request described when known (a section, a stretch of
 * frames); otherwise it is estimated from the input tokens. `model` prices the
 * request; an unknown model adds tokens but no money. Thinking tokens are
 * billed as output, so they are counted there.
 */
export function recordUsage(stored, provider, usage, { model = '', seconds, now = new Date() } = {}) {
  const daily = todaysUsage(stored, now);
  if (!COUNTED_PROVIDERS.includes(provider) || !usage) return daily;
  const u = addUsage(EMPTY_USAGE, usage);
  const row = daily[provider];
  const length = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : secondsFromTokens(u);
  // The relay's own allowance is free to the listener: no money counted there.
  const cost = provider === 'cloud' ? null : estimateCost(model, u, now);
  daily[provider] = {
    input: row.input + u.input,
    output: row.output + u.output + u.thinking,
    requests: row.requests + u.requests,
    seconds: row.seconds + length,
    cost: row.cost + (cost ? cost.amount : 0),
  };
  return daily;
}

/** Seconds of video described today, every provider together. */
export function totalSeconds(daily) {
  return COUNTED_PROVIDERS.reduce((sum, p) => sum + count(daily?.[p]?.seconds), 0);
}

/** Whether today's counter has reached the daily limit (0 = no limit). */
export function budgetReached(daily, budgetSeconds) {
  const limit = Number(budgetSeconds);
  return Number.isFinite(limit) && limit > 0 && totalSeconds(daily) >= limit;
}

/** A valid daily limit setting, or the default (none). */
export function cleanBudget(value, fallback = 0) {
  const n = typeof value === 'string' ? Number(value) : value;
  return DAILY_BUDGETS.includes(n) ? n : fallback;
}

/** The locale key naming a daily limit: budget_none, budget_30m, budget_1h, budget_2h, budget_4h. */
export function budgetLabelKey(seconds) {
  const n = cleanBudget(seconds);
  if (!n) return 'budget_none';
  return n % 3600 === 0 ? `budget_${n / 3600}h` : `budget_${n / 60}m`;
}

const dateOf = (when) => (when instanceof Date ? when : new Date(when || Date.now()));

/** The price row for a model id: the longest matching prefix, with a price change applied once its day has come. */
export function priceFor(model, when = new Date()) {
  const id = String(model || '').toLowerCase();
  let best = null;
  for (const row of MODEL_PRICES) {
    if (id.startsWith(row.prefix) && (!best || row.prefix.length > best.prefix.length)) best = row;
  }
  if (!best) return null;
  if (best.after && localDay(dateOf(when)) >= best.after.on) return { ...best, input: best.after.input, output: best.after.output };
  return best;
}

/**
 * What a usage would cost at list price for that model, as { amount, currency }
 * ('USD' or 'CNY'), or null for a model with no row. Thinking tokens are billed
 * as output. A free-tier Gemini key pays nothing: callers say so.
 */
export function estimateCost(model, usage, when = new Date()) {
  const price = priceFor(model, when);
  if (!price) return null;
  const u = addUsage(EMPTY_USAGE, usage);
  const amount = (u.input * price.input + (u.output + u.thinking) * price.output) / 1e6;
  return { amount, currency: price.currency };
}

/**
 * An amount as a short number: two decimals for dollars, one for yuan, never
 * shown as zero when something was spent ("about $0.01").
 */
export function formatAmount({ amount, currency } = {}) {
  const n = Number.isFinite(amount) && amount > 0 ? amount : 0;
  if (currency === 'CNY') return (n > 0 ? Math.max(0.1, n) : 0).toFixed(1);
  return (n > 0 ? Math.max(0.01, n) : 0).toFixed(2);
}

/**
 * An amount in words for the interface: "$0.03", or "¥0.2" / "0.2 元" through
 * the money_cny string. `t` is the translator of the page that asks.
 */
export function costText(cost, t) {
  if (!cost) return '';
  const amount = formatAmount(cost);
  return cost.currency === 'CNY' ? t('money_cny', amount) : `$${amount}`;
}

/** A token count in words: thousands are rounded ("150k"), small numbers as they are. */
export function formatTokens(n) {
  const v = count(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}
