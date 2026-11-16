// The models the film engine can call, as one table: what each one accepts
// (pictures, how many, which kind of JSON answer), where it lives, what it costs
// and whether it has passed the character test (K1). routing.js picks from the
// table and wire.js builds requests from it, so no other module names a provider.
//
// UNVERIFIED. Every entry comes from desk research dated 2026-11-15 (the
// providers' documentation and price pages), not from a request that ran: ids,
// limits, JSON modes and prices may all be wrong until a real key has run the
// model. Only then may an entry say `verified: true`, and only a K1 report fills
// in `k1`. Until that day no model is given the character lock (routing.js).

import { ApiError } from '../../shared/errors.js';

/**
 * @typedef {object} Price
 * @property {string} from      first day this price applies, 'YYYY-MM-DD'
 * @property {'CNY'|'USD'} currency
 * @property {number} input     per million input tokens
 * @property {number} output    per million output tokens
 *
 * @typedef {object} Model
 * @property {string} id                    the id the provider's API takes
 * @property {string} provider              'qwen', 'doubao', 'deepseek', 'gemini', or 'custom'
 * @property {'openai'|'gemini'} wire       the protocol: chat completions, or generateContent
 * @property {string} base                  the address the model lives at, without a trailing slash
 * @property {Array<'cn'|'global'>} regions where it can be reached from
 * @property {Array<'text'|'image'>} input  what a request may carry
 * @property {'schema'|'object'|'prompt'} json  the strongest JSON answer it can be held to: a schema,
 *   any JSON object, or nothing but the words of the prompt
 * @property {number} maxImages             pictures in one request (0 for a text model)
 * @property {string} maxTokensField        the name of the output limit in a request
 * @property {{above: number, inputX?: number, outputX?: number}} [longContext]  a request with more
 *   input tokens than `above` is billed at the list price times these factors
 * @property {Array<'triage'|'narrate'|'names'>} tasks  what the research suggests it for
 * @property {Price[]} prices               list prices; [] when unknown
 * @property {boolean} verified             a real key has run it and the entry held
 * @property {null|{date: string, wrongPer100: number, pass: boolean}} k1  its K1 result; null = not run
 */

/** The day of the research every entry below comes from. A price with no known start counts from here. */
export const CATALOG_DATE = '2026-11-15';

/**
 * What a model can be asked for: 'triage' sorts frames that need a description
 * from frames that do not, 'narrate' writes the descriptions, 'names' reads the
 * dialogue for the names it gives people (text only).
 */
export const TASKS = Object.freeze(['triage', 'narrate', 'names']);

const WIRES = ['openai', 'gemini'];
const JSON_MODES = ['schema', 'object', 'prompt'];

/** Frozen all the way down: the table is shared by every caller, and a caller must not be able to edit it. */
function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

const cny = (input, output, from = CATALOG_DATE) => ({ from, currency: 'CNY', input, output });
const usd = (input, output, from = CATALOG_DATE) => ({ from, currency: 'USD', input, output });

// What the models of one provider have in common. Spread into each row, then frozen with it.
const QWEN = {
  provider: 'qwen',
  wire: 'openai',
  base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  regions: ['cn', 'global'],
  input: ['text', 'image'],
  json: 'object',
  maxImages: 60,
  maxTokensField: 'max_tokens',
};
const DOUBAO = {
  provider: 'doubao',
  wire: 'openai',
  base: 'https://ark.cn-beijing.volces.com/api/v3',
  regions: ['cn'],
  input: ['text', 'image'],
  json: 'schema',
  maxImages: 60,
  maxTokensField: 'max_tokens',
};
// GeminiClient (src/shared) adds "/v1beta" itself: build it from clientBase(model) in wire.js, not from `base`.
const GEMINI = {
  provider: 'gemini',
  wire: 'gemini',
  base: 'https://generativelanguage.googleapis.com/v1beta',
  regions: ['global'],
  input: ['text', 'image'],
  json: 'schema',
  maxImages: 60,
  maxTokensField: 'maxOutputTokens',
};
/** No entry has been run with a real key, and none has a K1 result. */
const UNVERIFIED = { verified: false, k1: null };

/** @type {ReadonlyArray<Model>} Research of 2026-11-15, unverified (see the top of this file). Prices per million tokens. */
export const MODELS = deepFreeze([
  // The price rises above 256k input tokens; by how much is not confirmed, so no factor is given
  // and estimateCost applies none.
  { id: 'qwen3.7-plus', ...QWEN, longContext: { above: 256000 }, tasks: ['narrate'], prices: [cny(2, 8)], ...UNVERIFIED },
  { id: 'qwen3-vl-plus', ...QWEN, tasks: ['narrate'], prices: [cny(1, 10)], ...UNVERIFIED },
  { id: 'qwen3.8-omni-flash', ...QWEN, tasks: ['triage'], prices: [cny(0.8, 2.7)], ...UNVERIFIED },
  { id: 'doubao-seed-2.1-pro', ...DOUBAO, tasks: ['narrate'], prices: [cny(6, 30)], ...UNVERIFIED },
  { id: 'doubao-seed-2.1-lite', ...DOUBAO, tasks: ['triage'], prices: [cny(0.8, 2.7)], ...UNVERIFIED },
  // Text only: it reads dialogue for names and is never sent a picture. Its price was not found.
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    wire: 'openai',
    base: 'https://api.deepseek.com',
    regions: ['cn', 'global'],
    input: ['text'],
    json: 'object',
    maxImages: 0,
    maxTokensField: 'max_tokens',
    tasks: ['names'],
    prices: [],
    ...UNVERIFIED,
  },
  // Doubles on 2027-01-01 (announced with the 3.8 launch).
  { id: 'gemini-3.8-flash', ...GEMINI, tasks: ['narrate'], prices: [usd(0.75, 3.75, '2026-11-01'), usd(1.5, 7.5, '2027-01-01')], ...UNVERIFIED },
  { id: 'gemini-3.5-flash-lite', ...GEMINI, tasks: ['triage', 'names'], prices: [usd(0.3, 2.5)], ...UNVERIFIED },
]);

/**
 * The model each task goes to, by where the listener is: 'cn' reaches every
 * model from mainland China, 'global' uses Gemini. Ids of MODELS.
 */
export const PRESETS = deepFreeze({
  cn: { triage: 'qwen3.8-omni-flash', narrate: 'qwen3.7-plus', names: 'deepseek-v4-pro' },
  global: { triage: 'gemini-3.5-flash-lite', narrate: 'gemini-3.8-flash', names: 'gemini-3.5-flash-lite' },
});

/**
 * The entry with this id, or undefined.
 * @param {string} id
 * @param {ReadonlyArray<Model>} [catalog]  MODELS, or MODELS with the listener's own endpoints added
 * @returns {Model|undefined}
 */
export function findModel(id, catalog = MODELS) {
  if (typeof id !== 'string' || !Array.isArray(catalog)) return undefined;
  return catalog.find((m) => m && m.id === id);
}

/**
 * An entry for an endpoint the listener enters: OpenRouter, a company gateway,
 * a local Ollama at http://localhost:11434/v1. Nothing is known about it, so it
 * starts from the weakest assumptions (the JSON shape in words only, 20
 * pictures) and, whatever the caller passes, it is unverified, has no K1 result
 * and no price: the character lock stays off for it like for any model not run.
 * @param {object} o
 * @param {string} o.id              the model id the endpoint takes
 * @param {string} o.base            the address; trailing slashes are dropped
 * @param {'openai'|'gemini'} [o.wire]
 * @param {'schema'|'object'|'prompt'} [o.json]  anything else counts as 'prompt'
 * @param {number} [o.maxImages]     0 for a model that takes text only
 * @param {string} [o.provider]      a name for the endpoint, 'custom' by default
 * @param {Array<'text'|'image'>} [o.input]  ['text'] makes it a text model whatever maxImages says
 * @param {string} [o.maxTokensField]  e.g. 'max_completion_tokens' for endpoints that renamed it
 * @param {string[]} [o.tasks]       every task it can take by default; a text model only finds names
 * @param {{above: number, inputX?: number, outputX?: number}} [o.longContext]
 * @returns {Model}  frozen, like the entries of MODELS
 * @throws {ApiError} 'no-model' without an id or an address, 'provider-unsupported' for an unknown wire
 */
export function customModel({ id, base, wire = 'openai', json = 'prompt', maxImages = 20, provider = 'custom', input, maxTokensField, tasks, longContext } = {}) {
  const name = typeof id === 'string' ? id.trim() : '';
  const address = typeof base === 'string' ? base.trim().replace(/\/+$/, '') : '';
  if (!name || !address) throw new ApiError('no-model');
  // The protocol cannot be guessed: a request in the wrong one fails in ways nobody can read.
  if (!WIRES.includes(wire)) throw new ApiError('provider-unsupported', `unknown wire: ${wire}`);
  // A count typed into a form arrives as a string; anything that is not a count is the default.
  const count = typeof maxImages === 'string' && maxImages.trim() ? Number(maxImages) : maxImages;
  const images = typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 20;
  const sees = images > 0 && (!Array.isArray(input) || input.includes('image'));
  const wanted = Array.isArray(tasks) ? TASKS.filter((task) => tasks.includes(task)) : null;
  const model = {
    id: name,
    provider: typeof provider === 'string' && provider.trim() ? provider.trim() : 'custom',
    wire,
    base: address,
    regions: ['cn', 'global'],
    input: sees ? ['text', 'image'] : ['text'],
    json: JSON_MODES.includes(json) ? json : 'prompt',
    maxImages: sees ? images : 0,
    maxTokensField: typeof maxTokensField === 'string' && maxTokensField ? maxTokensField : wire === 'gemini' ? 'maxOutputTokens' : 'max_tokens',
  };
  if (longContext && Number.isFinite(longContext.above) && longContext.above > 0) {
    model.longContext = { above: longContext.above };
    if (Number.isFinite(longContext.inputX)) model.longContext.inputX = longContext.inputX;
    if (Number.isFinite(longContext.outputX)) model.longContext.outputX = longContext.outputX;
  }
  model.tasks = wanted || (sees ? [...TASKS] : ['names']);
  model.prices = [];
  return deepFreeze({ ...model, ...UNVERIFIED });
}

/** The day of an ISO date or date-time ('2026-11-15', '2026-11-15T08:00:00Z'), or '' when it is neither. */
function dayOf(isoDate) {
  return typeof isoDate === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(isoDate) ? isoDate.slice(0, 10) : '';
}

/**
 * The price in force on a day: the entry with the latest `from` that is not
 * after it. null when the model has no price, the day is before the first one,
 * or the date is not an ISO date (there is no clock here to fall back on).
 * @param {Model} model
 * @param {string} isoDate  'YYYY-MM-DD', or an ISO date-time whose date part is used
 * @returns {Price|null}
 */
export function priceAt(model, isoDate) {
  const day = dayOf(isoDate);
  if (!day || !Array.isArray(model?.prices)) return null;
  let best = null;
  for (const price of model.prices) {
    if (!price || typeof price.from !== 'string' || price.from > day) continue;
    if (!best || price.from >= best.from) best = price;
  }
  return best;
}

const tokens = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const factor = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1);

/**
 * What a usage costs at the list price of that day, or null when the price is
 * not known. Thinking tokens, when the usage counts them apart (shared/usage.js
 * does), are billed as output. A request above the model's long-context
 * threshold is billed whole at the long-context factors, where the entry gives
 * them; an entry with a threshold and no factors is priced as usual.
 * @param {Model} model
 * @param {{input?: number, output?: number, thinking?: number}} usage  tokens
 * @param {string} isoDate
 * @returns {{amount: number, currency: 'CNY'|'USD'}|null}
 */
export function estimateCost(model, usage, isoDate) {
  const price = priceAt(model, isoDate);
  if (!price) return null;
  const input = tokens(usage?.input);
  const output = tokens(usage?.output) + tokens(usage?.thinking);
  const long = model.longContext && input > model.longContext.above ? model.longContext : null;
  const amount = (input * price.input * factor(long?.inputX) + output * price.output * factor(long?.outputX)) / 1e6;
  return { amount, currency: price.currency };
}

/**
 * Whether descriptions with people in them may be written by this model: only
 * when its K1 run passed. A model never run (k1 null) does not qualify, however
 * good its reputation.
 * @param {Model} model
 * @returns {boolean}
 */
export function supportsCharacterLock(model) {
  return model?.k1?.pass === true;
}
