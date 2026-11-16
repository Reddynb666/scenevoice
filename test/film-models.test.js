// The film engine's model layer (src/film/models): the catalog and its prices,
// routing by task, request bodies for both protocols, one call with a deadline
// and retries of its own, and the small JSON-schema checker. No network: fake
// clients, or the real QwenClient and GeminiClient over a fake fetch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_BASE, DEFAULT_QWEN_API_BASE } from '../src/shared/constants.js';
import { ApiError } from '../src/shared/errors.js';
import { GeminiClient, GeminiError, tuningFor } from '../src/shared/gemini.js';
import { QwenClient } from '../src/shared/qwen.js';
import { CATALOG_DATE, MODELS, PRESETS, TASKS, customModel, estimateCost, findModel, priceAt, supportsCharacterLock } from '../src/film/models/catalog.js';
import { check } from '../src/film/models/json.js';
import { route } from '../src/film/models/routing.js';
import { buildRequest, clientBase, complete, readJson } from '../src/film/models/wire.js';

/** Whether a value and everything inside it is frozen. */
function frozenDeep(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenDeep);
}

/** A deep-frozen copy: a function that changed its argument would throw on it. */
function frozenCopy(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = (v) => {
    if (v && typeof v === 'object') {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(copy);
}

/** The code of the ApiError a function throws, or what it threw instead. */
function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : err;
  }
  return 'did not throw';
}

const frames = [
  { time: 12, data: '/9j/AAA1', label: 'Frame at 0:12' },
  { time: 15, data: '/9j/AAA2', label: 'Frame at 0:15' },
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cues'],
  properties: {
    cues: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'kind', 'priority', 'brief'],
        properties: {
          slot: { type: 'string' },
          kind: { type: 'string', enum: ['visual', 'text'] },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
          brief: { type: 'string' },
          confidence: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const SYSTEM = 'Describe only what the frames show. Refer to people by their token.';
const SHAPE = 'Answer with JSON: {"cues": [{"slot", "kind", "priority", "brief"}]}';
const TEXT = '窗口 0:10–0:20。空隙 g_0001：2.4 秒，最多 10 个字。';

const sectionPrompt = (over = {}) => ({ kind: 'section', system: SYSTEM, jsonShape: SHAPE, frames, text: TEXT, maxTokens: 2048, temperature: 0.3, ...over });
const namesPrompt = (over = {}) => ({
  kind: 'names',
  system: 'List every name the dialogue gives a person.',
  jsonShape: 'Answer with JSON: {"names": [{"name", "kind", "t", "line"}]}',
  frames: [],
  text: '0:31 老陈，你来了。\n0:34 马修让我来的。',
  maxTokens: 512,
  temperature: 0,
  ...over,
});

const chatReply = (content, finish = 'stop', usage = { prompt_tokens: 1200, completion_tokens: 80 }) => ({
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  usage,
});
const geminiReply = (text, finish = 'STOP') => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: finish }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60, thoughtsTokenCount: 15 },
});

describe('catalog: the table of models', () => {
  it('gives every entry the fields the contract names, with values of the right kind', () => {
    expect(MODELS.length).toBe(8);
    for (const m of MODELS) {
      expect(typeof m.id === 'string' && m.id.length > 0, m.id).toBe(true);
      expect(typeof m.provider === 'string' && m.provider.length > 0, m.id).toBe(true);
      expect(['openai', 'gemini'], m.id).toContain(m.wire);
      expect(m.base, m.id).toMatch(/^https:\/\/\S+[^/\s]$/);
      expect(m.regions.length, m.id).toBeGreaterThan(0);
      expect(m.regions.every((r) => ['cn', 'global'].includes(r)), m.id).toBe(true);
      expect(m.input, m.id).toContain('text');
      expect(m.input.every((kind) => ['text', 'image'].includes(kind)), m.id).toBe(true);
      expect(['schema', 'object', 'prompt'], m.id).toContain(m.json);
      expect(Number.isInteger(m.maxImages) && m.maxImages >= 0, m.id).toBe(true);
      expect(typeof m.maxTokensField === 'string' && m.maxTokensField.length > 0, m.id).toBe(true);
      expect(m.tasks.length, m.id).toBeGreaterThan(0);
      expect(m.tasks.every((task) => TASKS.includes(task)), m.id).toBe(true);
      expect(Array.isArray(m.prices), m.id).toBe(true);
      for (const p of m.prices) {
        expect(p.from, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(['CNY', 'USD'], m.id).toContain(p.currency);
        expect(p.input, m.id).toBeGreaterThan(0);
        expect(p.output, m.id).toBeGreaterThan(0);
      }
      // In time order, one price per day: priceAt has one answer for any day.
      const starts = m.prices.map((p) => p.from);
      expect(starts, m.id).toEqual([...new Set(starts)].sort());
      if (m.longContext) expect(m.longContext.above, m.id).toBeGreaterThan(0);
    }
  });

  it('has one entry per id', () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks every entry unverified with no K1 result: nothing has been run with a real key', () => {
    for (const m of MODELS) {
      expect(m.verified, m.id).toBe(false);
      expect(m.k1, m.id).toBeNull();
      expect(supportsCharacterLock(m), m.id).toBe(false);
    }
  });

  it('is frozen all the way down', () => {
    expect(frozenDeep(MODELS)).toBe(true);
    expect(frozenDeep(PRESETS)).toBe(true);
    expect(Object.isFrozen(TASKS)).toBe(true);
    expect(() => {
      MODELS[0].k1 = { date: '2026-11-15', wrongPer100: 0, pass: true };
    }).toThrow(TypeError);
    expect(() => {
      MODELS[0].prices.push({ from: '2026-11-15', currency: 'CNY', input: 0, output: 0 });
    }).toThrow(TypeError);
    expect(() => {
      MODELS.push({});
    }).toThrow(TypeError);
    expect(() => {
      PRESETS.cn.narrate = 'gemini-3.8-flash';
    }).toThrow(TypeError);
  });

  it('holds the research of 2026-11-15: addresses, limits, tasks and prices', () => {
    expect(CATALOG_DATE).toBe('2026-11-15');
    const row = (m) => [
      m.provider,
      m.wire,
      m.base,
      m.regions.join('+'),
      m.input.join('+'),
      m.json,
      m.maxImages,
      m.tasks.join('+'),
      m.prices.map((p) => `${p.currency} ${p.input}/${p.output} from ${p.from}`).join('; '),
    ];
    const dashscope = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const ark = 'https://ark.cn-beijing.volces.com/api/v3';
    const google = 'https://generativelanguage.googleapis.com/v1beta';
    expect(Object.fromEntries(MODELS.map((m) => [m.id, row(m)]))).toEqual({
      'qwen3.7-plus': ['qwen', 'openai', dashscope, 'cn+global', 'text+image', 'object', 60, 'narrate', 'CNY 2/8 from 2026-11-15'],
      'qwen3-vl-plus': ['qwen', 'openai', dashscope, 'cn+global', 'text+image', 'object', 60, 'narrate', 'CNY 1/10 from 2026-11-15'],
      'qwen3.8-omni-flash': ['qwen', 'openai', dashscope, 'cn+global', 'text+image', 'object', 60, 'triage', 'CNY 0.8/2.7 from 2026-11-15'],
      'doubao-seed-2.1-pro': ['doubao', 'openai', ark, 'cn', 'text+image', 'schema', 60, 'narrate', 'CNY 6/30 from 2026-11-15'],
      'doubao-seed-2.1-lite': ['doubao', 'openai', ark, 'cn', 'text+image', 'schema', 60, 'triage', 'CNY 0.8/2.7 from 2026-11-15'],
      'deepseek-v4-pro': ['deepseek', 'openai', 'https://api.deepseek.com', 'cn+global', 'text', 'object', 0, 'names', ''],
      'gemini-3.8-flash': ['gemini', 'gemini', google, 'global', 'text+image', 'schema', 60, 'narrate', 'USD 0.75/3.75 from 2026-11-01; USD 1.5/7.5 from 2027-01-01'],
      'gemini-3.5-flash-lite': ['gemini', 'gemini', google, 'global', 'text+image', 'schema', 60, 'triage+names', 'USD 0.3/2.5 from 2026-11-15'],
    });
    expect(findModel('qwen3.7-plus').longContext).toEqual({ above: 256000 });
    expect(MODELS.filter((m) => m.longContext).map((m) => m.id)).toEqual(['qwen3.7-plus']);
  });

  it('names the output limit the way each protocol does', () => {
    for (const m of MODELS) expect(m.maxTokensField, m.id).toBe(m.wire === 'gemini' ? 'maxOutputTokens' : 'max_tokens');
  });

  it('lives at the addresses the shared clients already use', () => {
    expect(findModel('qwen3.7-plus').base).toBe(DEFAULT_QWEN_API_BASE);
    expect(clientBase(findModel('gemini-3.8-flash'))).toBe(DEFAULT_API_BASE);
  });

  it('sends pictures only to models that take them: a model with image input has room for some, a text model for none', () => {
    for (const m of MODELS) expect(m.input.includes('image'), m.id).toBe(m.maxImages > 0);
    for (const m of MODELS.filter((x) => x.tasks.includes('narrate') || x.tasks.includes('triage'))) {
      expect(m.input, m.id).toContain('image');
    }
  });

  it('has presets whose every id exists, does that task, and can be reached from that region', () => {
    expect(Object.keys(PRESETS)).toEqual(['cn', 'global']);
    for (const [region, preset] of Object.entries(PRESETS)) {
      expect(Object.keys(preset).sort()).toEqual([...TASKS].sort());
      for (const task of TASKS) {
        const model = findModel(preset[task]);
        expect(model, `${region}.${task}: ${preset[task]}`).toBeDefined();
        expect(model.tasks, `${region}.${task}`).toContain(task);
        expect(model.regions, `${region}.${task}`).toContain(region);
      }
    }
    expect(PRESETS).toEqual({
      cn: { triage: 'qwen3.8-omni-flash', narrate: 'qwen3.7-plus', names: 'deepseek-v4-pro' },
      global: { triage: 'gemini-3.5-flash-lite', narrate: 'gemini-3.8-flash', names: 'gemini-3.5-flash-lite' },
    });
  });

  it('never asks a names model for pictures: the names request is text, and a text model refuses frames', () => {
    const namesModels = MODELS.filter((m) => m.tasks.includes('names'));
    expect(namesModels.map((m) => m.id)).toEqual(['deepseek-v4-pro', 'gemini-3.5-flash-lite']);
    for (const model of namesModels) {
      const { body } = buildRequest(model, namesPrompt());
      const sent = JSON.stringify(body);
      expect(sent, model.id).not.toContain('image_url');
      expect(sent, model.id).not.toContain('inlineData');
      expect(sent, model.id).toContain('老陈，你来了。');
    }
    const cnNames = findModel(PRESETS.cn.names);
    expect(cnNames.input).toEqual(['text']);
    expect(cnNames.maxImages).toBe(0);
    expect(codeOf(() => buildRequest(cnNames, namesPrompt({ frames })))).toBe('provider-unsupported');
  });
});

describe('catalog: findModel', () => {
  it('finds an entry by id, in the table or in a list the caller gives', () => {
    expect(findModel('doubao-seed-2.1-pro').provider).toBe('doubao');
    const mine = customModel({ id: 'llava:13b', base: 'http://localhost:11434/v1' });
    expect(findModel('llava:13b')).toBeUndefined();
    expect(findModel('llava:13b', [...MODELS, mine])).toBe(mine);
  });

  it('is undefined for an id nobody has, a prefix of one, and things that are not ids', () => {
    expect(findModel('gpt-9')).toBeUndefined();
    expect(findModel('qwen3')).toBeUndefined();
    expect(findModel('')).toBeUndefined();
    expect(findModel(undefined)).toBeUndefined();
    expect(findModel(null)).toBeUndefined();
    expect(findModel(3)).toBeUndefined();
    expect(findModel('qwen3.7-plus', null)).toBeUndefined();
    expect(findModel('qwen3.7-plus', [null, undefined])).toBeUndefined();
  });
});

describe('catalog: priceAt', () => {
  const flash = findModel('gemini-3.8-flash');

  it('returns the price in force on the day: the latest one that has started', () => {
    expect(priceAt(flash, '2026-11-01')).toEqual({ from: '2026-11-01', currency: 'USD', input: 0.75, output: 3.75 });
    expect(priceAt(flash, '2026-11-15').input).toBe(0.75);
    expect(priceAt(flash, '2026-12-31').input).toBe(0.75);
    expect(priceAt(flash, '2027-01-01')).toEqual({ from: '2027-01-01', currency: 'USD', input: 1.5, output: 7.5 });
    expect(priceAt(flash, '2031-06-30').output).toBe(7.5);
  });

  it('is null before the first price started', () => {
    expect(priceAt(flash, '2026-10-31')).toBeNull();
    expect(priceAt(findModel('qwen3.7-plus'), '2026-11-14')).toBeNull();
    expect(priceAt(findModel('qwen3.7-plus'), '2026-11-15')).toEqual({ from: '2026-11-15', currency: 'CNY', input: 2, output: 8 });
  });

  it('is null for a model whose price is not known', () => {
    expect(priceAt(findModel('deepseek-v4-pro'), '2026-11-15')).toBeNull();
    expect(priceAt(customModel({ id: 'llava:13b', base: 'http://localhost:11434/v1' }), '2026-11-15')).toBeNull();
    expect(priceAt(undefined, '2026-11-15')).toBeNull();
    expect(priceAt({ id: 'x' }, '2026-11-15')).toBeNull();
  });

  it('takes the date part of an ISO date-time, and has no clock to fall back on', () => {
    expect(priceAt(flash, '2026-12-31T23:59:59Z').input).toBe(0.75);
    expect(priceAt(flash, '2027-01-01T00:00:00+08:00').input).toBe(1.5);
    expect(priceAt(flash, undefined)).toBeNull();
    expect(priceAt(flash, '')).toBeNull();
    expect(priceAt(flash, '15/11/2026')).toBeNull();
    expect(priceAt(flash, '2026-11-15abc')).toBeNull();
    expect(priceAt(flash, 20261115)).toBeNull();
    expect(priceAt(flash, new Date(Date.UTC(2026, 10, 15)))).toBeNull();
  });

  it('does not depend on the order the prices are listed in, and skips a malformed one', () => {
    const model = { id: 'x', prices: [{ from: '2027-01-01', currency: 'USD', input: 2, output: 4 }, null, { currency: 'USD', input: 9, output: 9 }, { from: '2026-01-01', currency: 'USD', input: 1, output: 2 }] };
    expect(priceAt(model, '2026-06-01').input).toBe(1);
    expect(priceAt(model, '2027-06-01').input).toBe(2);
  });
});

describe('catalog: estimateCost', () => {
  it('multiplies tokens by the price per million of that day', () => {
    expect(estimateCost(findModel('qwen3.7-plus'), { input: 1000000, output: 500000 }, '2026-11-15')).toEqual({ amount: 6, currency: 'CNY' });
    const flash = findModel('gemini-3.8-flash');
    expect(estimateCost(flash, { input: 200000, output: 20000 }, '2026-12-01')).toEqual({ amount: 0.225, currency: 'USD' });
    expect(estimateCost(flash, { input: 200000, output: 20000 }, '2027-01-01')).toEqual({ amount: 0.45, currency: 'USD' });
  });

  it('bills thinking tokens as output, as shared/usage.js counts them', () => {
    const lite = findModel('gemini-3.5-flash-lite');
    const cost = estimateCost(lite, { input: 0, output: 600000, thinking: 400000, requests: 3 }, '2026-11-20');
    expect(cost.currency).toBe('USD');
    expect(cost.amount).toBeCloseTo(2.5, 10);
  });

  it('is null when the price is not known, on that day or at all', () => {
    expect(estimateCost(findModel('deepseek-v4-pro'), { input: 1000, output: 1000 }, '2026-11-15')).toBeNull();
    expect(estimateCost(findModel('qwen3.7-plus'), { input: 1000, output: 1000 }, '2026-01-01')).toBeNull();
    expect(estimateCost(findModel('qwen3.7-plus'), { input: 1000, output: 1000 })).toBeNull();
    expect(estimateCost(undefined, { input: 1000, output: 1000 }, '2026-11-15')).toBeNull();
  });

  it('counts a missing or malformed usage as nothing spent', () => {
    const model = findModel('qwen3-vl-plus');
    expect(estimateCost(model, undefined, '2026-11-15')).toEqual({ amount: 0, currency: 'CNY' });
    expect(estimateCost(model, {}, '2026-11-15')).toEqual({ amount: 0, currency: 'CNY' });
    expect(estimateCost(model, { input: -5, output: NaN, thinking: 'many' }, '2026-11-15')).toEqual({ amount: 0, currency: 'CNY' });
  });

  it('applies the long-context factors to a request above the threshold, when the entry gives them', () => {
    const model = { id: 'long', longContext: { above: 200000, inputX: 2, outputX: 1.5 }, prices: [{ from: '2026-01-01', currency: 'USD', input: 1, output: 10 }] };
    // At the threshold the list price still applies; one token more and the whole request costs more.
    expect(estimateCost(model, { input: 200000, output: 100000 }, '2026-11-15').amount).toBeCloseTo(1.2, 10);
    expect(estimateCost(model, { input: 300000, output: 100000 }, '2026-11-15').amount).toBeCloseTo(0.6 + 1.5, 10);
    const inputOnly = { ...model, longContext: { above: 200000, inputX: 2 } };
    expect(estimateCost(inputOnly, { input: 300000, output: 100000 }, '2026-11-15').amount).toBeCloseTo(0.6 + 1, 10);
  });

  it('applies no factor when the entry has a threshold and no factors: qwen3.7-plus above 256k', () => {
    const cost = estimateCost(findModel('qwen3.7-plus'), { input: 300000, output: 0 }, '2026-11-15');
    expect(cost.amount).toBeCloseTo(0.6, 10);
  });

  it('does not change the usage it is given', () => {
    const usage = frozenCopy({ input: 10, output: 5, thinking: 1 });
    expect(() => estimateCost(findModel('qwen3.7-plus'), usage, '2026-11-15')).not.toThrow();
  });
});

describe('catalog: supportsCharacterLock', () => {
  it('is true only for a K1 result that passed', () => {
    expect(supportsCharacterLock({ id: 'x', k1: { date: '2026-12-01', wrongPer100: 1.5, pass: true } })).toBe(true);
    expect(supportsCharacterLock({ id: 'x', k1: { date: '2026-12-01', wrongPer100: 7, pass: false } })).toBe(false);
    expect(supportsCharacterLock({ id: 'x', k1: null })).toBe(false);
    expect(supportsCharacterLock({ id: 'x' })).toBe(false);
    // A report that is not a plain yes is a no.
    expect(supportsCharacterLock({ id: 'x', k1: { pass: 'yes' } })).toBe(false);
    expect(supportsCharacterLock({ id: 'x', k1: { pass: 1 } })).toBe(false);
    expect(supportsCharacterLock({ id: 'x', k1: { wrongPer100: 0 } })).toBe(false);
    expect(supportsCharacterLock({ id: 'x', verified: true, k1: null })).toBe(false);
    expect(supportsCharacterLock(undefined)).toBe(false);
    expect(supportsCharacterLock(null)).toBe(false);
  });
});

describe('catalog: customModel, an endpoint the listener enters', () => {
  it('starts a local Ollama from the weakest assumptions', () => {
    expect(customModel({ id: 'llava:13b', base: 'http://localhost:11434/v1' })).toEqual({
      id: 'llava:13b',
      provider: 'custom',
      wire: 'openai',
      base: 'http://localhost:11434/v1',
      regions: ['cn', 'global'],
      input: ['text', 'image'],
      json: 'prompt',
      maxImages: 20,
      maxTokensField: 'max_tokens',
      tasks: ['triage', 'narrate', 'names'],
      prices: [],
      verified: false,
      k1: null,
    });
  });

  it('takes what the listener knows about the endpoint: OpenRouter with a schema and its own limit field', () => {
    const model = customModel({
      id: ' google/gemini-3.8-flash ',
      base: 'https://openrouter.ai/api/v1//',
      json: 'schema',
      maxImages: 40,
      provider: 'openrouter',
      maxTokensField: 'max_completion_tokens',
      tasks: ['narrate', 'dance', 'triage'],
      longContext: { above: 200000, inputX: 2, outputX: 1.5, note: 'dropped' },
    });
    expect(model).toMatchObject({
      id: 'google/gemini-3.8-flash',
      provider: 'openrouter',
      base: 'https://openrouter.ai/api/v1',
      json: 'schema',
      maxImages: 40,
      maxTokensField: 'max_completion_tokens',
      tasks: ['triage', 'narrate'],
      longContext: { above: 200000, inputX: 2, outputX: 1.5 },
    });
    expect(model.longContext).toEqual({ above: 200000, inputX: 2, outputX: 1.5 });
  });

  it('is unverified, without a K1 result or a price, whatever the caller passes', () => {
    const model = customModel({
      id: 'my-model',
      base: 'https://example.test/v1',
      verified: true,
      k1: { date: '2026-11-15', wrongPer100: 0, pass: true },
      prices: [{ from: '2026-01-01', currency: 'USD', input: 1, output: 1 }],
      regions: ['mars'],
    });
    expect(model.verified).toBe(false);
    expect(model.k1).toBeNull();
    expect(model.prices).toEqual([]);
    expect(model.regions).toEqual(['cn', 'global']);
    expect(supportsCharacterLock(model)).toBe(false);
  });

  it('makes a text model of an endpoint that takes no pictures: it only finds names', () => {
    for (const model of [
      customModel({ id: 'qwen-text', base: 'https://example.test/v1', maxImages: 0 }),
      customModel({ id: 'qwen-text', base: 'https://example.test/v1', input: ['text'] }),
    ]) {
      expect(model.input).toEqual(['text']);
      expect(model.maxImages).toBe(0);
      expect(model.tasks).toEqual(['names']);
    }
    expect(customModel({ id: 'm', base: 'https://example.test/v1', input: ['image', 'text'] }).input).toEqual(['text', 'image']);
  });

  it('reads a picture count typed into a form, and falls back to 20 for anything that is not a count', () => {
    const count = (maxImages) => customModel({ id: 'm', base: 'https://example.test/v1', maxImages }).maxImages;
    expect(count('30')).toBe(30);
    expect(count(12.7)).toBe(12);
    expect(count(-1)).toBe(20);
    expect(count(NaN)).toBe(20);
    expect(count('many')).toBe(20);
    expect(count('')).toBe(20);
    expect(count(null)).toBe(20);
    expect(count(undefined)).toBe(20);
  });

  it('falls back to the shape in words for a JSON mode it does not know', () => {
    const json = (mode) => customModel({ id: 'm', base: 'https://example.test/v1', json: mode }).json;
    expect(json('object')).toBe('object');
    expect(json('schema')).toBe('schema');
    expect(json('yaml')).toBe('prompt');
    expect(json(undefined)).toBe('prompt');
    expect(json(null)).toBe('prompt');
  });

  it('names the output limit by the protocol unless told otherwise', () => {
    expect(customModel({ id: 'm', base: 'https://example.test', wire: 'gemini' }).maxTokensField).toBe('maxOutputTokens');
    expect(customModel({ id: 'm', base: 'https://example.test/v1', wire: 'openai' }).maxTokensField).toBe('max_tokens');
  });

  it('throws no-model without an id or an address, and provider-unsupported for a protocol it does not speak', () => {
    expect(codeOf(() => customModel())).toBe('no-model');
    expect(codeOf(() => customModel({}))).toBe('no-model');
    expect(codeOf(() => customModel({ id: 'm' }))).toBe('no-model');
    expect(codeOf(() => customModel({ base: 'https://example.test/v1' }))).toBe('no-model');
    expect(codeOf(() => customModel({ id: '   ', base: 'https://example.test/v1' }))).toBe('no-model');
    expect(codeOf(() => customModel({ id: 'm', base: ' / ' }))).toBe('no-model');
    expect(codeOf(() => customModel({ id: 7, base: 'https://example.test/v1' }))).toBe('no-model');
    expect(codeOf(() => customModel({ id: 'm', base: 'https://example.test/v1', wire: 'anthropic' }))).toBe('provider-unsupported');
  });

  it('is frozen like the table, and leaves the caller’s own object as it was', () => {
    const fields = { id: 'm', base: 'https://example.test/v1/', tasks: ['names'], input: ['text', 'image'], longContext: { above: 1000 } };
    const before = JSON.stringify(fields);
    const model = customModel(fields);
    expect(frozenDeep(model)).toBe(true);
    expect(JSON.stringify(fields)).toBe(before);
    expect(Object.isFrozen(fields.tasks)).toBe(false);
    expect(Object.isFrozen(fields.input)).toBe(false);
    expect(Object.isFrozen(fields.longContext)).toBe(false);
    expect(model.tasks).not.toBe(fields.tasks);
  });
});

describe('routing: route', () => {
  const passed = { date: '2026-12-01', wrongPer100: 1, pass: true };
  const failed = { date: '2026-12-01', wrongPer100: 6, pass: false };
  /** The table with K1 results written in, as it will look once the test has been run. */
  const tested = (results) => MODELS.map((m) => (m.id in results ? { ...m, verified: true, k1: results[m.id] } : m));

  it('takes the model of the preset for each task, China by default', () => {
    expect(route('triage').model.id).toBe('qwen3.8-omni-flash');
    expect(route('narrate').model.id).toBe('qwen3.7-plus');
    expect(route('names').model.id).toBe('deepseek-v4-pro');
    expect(route('narrate', {}).model).toBe(findModel('qwen3.7-plus'));
    expect(route('triage', { preset: 'cn' }).model.id).toBe('qwen3.8-omni-flash');
    expect(route('triage', { preset: 'global' }).model.id).toBe('gemini-3.5-flash-lite');
    expect(route('narrate', { preset: 'global' }).model.id).toBe('gemini-3.8-flash');
    expect(route('names', { preset: 'global' }).model.id).toBe('gemini-3.5-flash-lite');
  });

  it('gives no model the character lock while none has run K1, and says why', () => {
    expect(route('narrate')).toEqual({ model: findModel('qwen3.7-plus'), characterLock: false, reason: 'k1-not-run' });
    expect(route('narrate', { preset: 'global', characterLock: true })).toEqual({ model: findModel('gemini-3.8-flash'), characterLock: false, reason: 'k1-not-run' });
    for (const m of MODELS) expect(route('narrate', { model: m.id }).characterLock, m.id).toBe(false);
  });

  it('locks characters for narration on a model whose K1 run passed', () => {
    const catalog = tested({ 'qwen3.7-plus': passed });
    const out = route('narrate', { catalog });
    expect(out.model.id).toBe('qwen3.7-plus');
    expect(out.characterLock).toBe(true);
    expect(out.reason).toBe('');
  });

  it('still returns a model whose K1 run failed, without the lock and with the reason', () => {
    const catalog = tested({ 'qwen3.7-plus': failed });
    expect(route('narrate', { catalog })).toEqual({ model: catalog.find((m) => m.id === 'qwen3.7-plus'), characterLock: false, reason: 'k1-failed' });
    // A report without a plain pass counts as failed, not as never run.
    const vague = tested({ 'qwen3.7-plus': { date: '2026-12-01', wrongPer100: 1 } });
    expect(route('narrate', { catalog: vague }).reason).toBe('k1-failed');
  });

  it('leaves the lock off, with no reason, when the caller did not ask for it', () => {
    const catalog = tested({ 'qwen3.7-plus': passed });
    expect(route('narrate', { catalog, characterLock: false })).toEqual({ model: catalog.find((m) => m.id === 'qwen3.7-plus'), characterLock: false, reason: '' });
    expect(route('narrate', { characterLock: false }).reason).toBe('');
  });

  it('never locks characters for triage or names, whatever the model has passed', () => {
    const catalog = tested({ 'qwen3.8-omni-flash': passed, 'deepseek-v4-pro': passed, 'gemini-3.5-flash-lite': failed });
    for (const task of ['triage', 'names']) {
      for (const preset of ['cn', 'global']) {
        const out = route(task, { catalog, preset, characterLock: true });
        expect(out.characterLock, `${preset}.${task}`).toBe(false);
        expect(out.reason, `${preset}.${task}`).toBe('');
      }
    }
  });

  it('lets an explicit model id override the preset', () => {
    expect(route('narrate', { model: 'doubao-seed-2.1-pro' }).model.id).toBe('doubao-seed-2.1-pro');
    expect(route('narrate', { preset: 'global', model: 'qwen3-vl-plus' }).model.id).toBe('qwen3-vl-plus');
    // The listener's choice stands even where the research suggests the model for something else.
    expect(route('names', { model: 'qwen3.7-plus' }).model.id).toBe('qwen3.7-plus');
    const catalog = tested({ 'doubao-seed-2.1-pro': passed });
    expect(route('narrate', { catalog, model: 'doubao-seed-2.1-pro' })).toMatchObject({ characterLock: true, reason: '' });
    // Nothing chosen: the preset again.
    expect(route('narrate', { model: '' }).model.id).toBe('qwen3.7-plus');
    expect(route('narrate', { model: null }).model.id).toBe('qwen3.7-plus');
    expect(route('narrate', { model: undefined }).model.id).toBe('qwen3.7-plus');
  });

  it('takes the listener’s own endpoint, by id from a longer catalog or as an entry, with labels only', () => {
    const mine = customModel({ id: 'llava:13b', base: 'http://localhost:11434/v1' });
    expect(route('narrate', { catalog: [...MODELS, mine], model: 'llava:13b' })).toEqual({ model: mine, characterLock: false, reason: 'k1-not-run' });
    expect(route('narrate', { model: mine })).toEqual({ model: mine, characterLock: false, reason: 'k1-not-run' });
    expect(route('triage', { model: mine })).toEqual({ model: mine, characterLock: false, reason: '' });
  });

  it('follows presets the caller gives', () => {
    const presets = { studio: { triage: 'doubao-seed-2.1-lite', narrate: 'doubao-seed-2.1-pro', names: 'deepseek-v4-pro' } };
    expect(route('narrate', { presets, preset: 'studio' }).model.id).toBe('doubao-seed-2.1-pro');
    expect(route('triage', { presets, preset: 'studio' }).model.id).toBe('doubao-seed-2.1-lite');
  });

  it('throws no-model for a task it does not know', () => {
    for (const task of ['translate', '', undefined, null, 'toString', 'NARRATE', 7]) {
      expect(codeOf(() => route(task)), String(task)).toBe('no-model');
      expect(codeOf(() => route(task, { model: 'qwen3.7-plus' })), String(task)).toBe('no-model');
    }
  });

  it('throws no-model for a model or a preset it cannot find', () => {
    expect(codeOf(() => route('narrate', { model: 'gpt-9' }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { model: 'llava:13b' }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { model: {} }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { model: 42 }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { preset: 'mars' }))).toBe('no-model');
    // Not something every object happens to have.
    expect(codeOf(() => route('narrate', { preset: 'constructor' }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { preset: '__proto__' }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { catalog: [] }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { presets: {} }))).toBe('no-model');
    expect(codeOf(() => route('narrate', { presets: { cn: { narrate: 'gone-model' } } }))).toBe('no-model');
    expect(codeOf(() => route('names', { presets: { cn: { narrate: 'qwen3.7-plus' } } }))).toBe('no-model');
  });

  it('changes nothing it is given', () => {
    const catalog = frozenCopy(MODELS);
    const presets = frozenCopy(PRESETS);
    const options = Object.freeze({ catalog, presets, preset: 'global', characterLock: true });
    expect(() => route('narrate', options)).not.toThrow();
    expect(route('narrate', options).model).toBe(catalog.find((m) => m.id === 'gemini-3.8-flash'));
  });
});

describe('wire: buildRequest for chat completions', () => {
  const dataUrl = (data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } });

  it('sends the instructions with the shape in words, each frame as a label and a data URL, then the text', () => {
    const model = findModel('qwen3.7-plus');
    expect(buildRequest(model, sectionPrompt())).toEqual({
      wire: 'openai',
      body: {
        model: 'qwen3.7-plus',
        messages: [
          { role: 'system', content: `${SYSTEM}\n\n${SHAPE}` },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Frame at 0:12' },
              dataUrl('/9j/AAA1'),
              { type: 'text', text: 'Frame at 0:15' },
              dataUrl('/9j/AAA2'),
              { type: 'text', text: TEXT },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      },
    });
  });

  it('asks a schema model for the schema under the name of the prompt’s kind, and not for strict mode', () => {
    const { body } = buildRequest(findModel('doubao-seed-2.1-pro'), sectionPrompt({ schema: SCHEMA }));
    expect(body.model).toBe('doubao-seed-2.1-pro');
    // Strict mode refuses a schema with optional properties or without additionalProperties: false, as the
    // film's schemas are; the schema guides the model and the caller checks the answer (json.js check).
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'section', schema: SCHEMA } });
    expect('strict' in body.response_format.json_schema).toBe(false);
    // The shape in words goes along in every case.
    expect(body.messages[0].content).toBe(`${SYSTEM}\n\n${SHAPE}`);
  });

  it('gives the schema a name the API accepts, whatever the kind', () => {
    const model = findModel('doubao-seed-2.1-pro');
    const name = (kind) => buildRequest(model, sectionPrompt({ schema: SCHEMA, kind })).body.response_format.json_schema.name;
    expect(name('names')).toBe('names');
    expect(name('film section/2')).toBe('film_section_2');
    expect(name(undefined)).toBe('answer');
    expect(name('')).toBe('answer');
  });

  it('asks a schema model for a JSON object when the prompt has no schema', () => {
    const model = findModel('doubao-seed-2.1-pro');
    expect(buildRequest(model, sectionPrompt()).body.response_format).toEqual({ type: 'json_object' });
    expect(buildRequest(model, sectionPrompt({ schema: null })).body.response_format).toEqual({ type: 'json_object' });
    expect(buildRequest(model, sectionPrompt({ schema: 'cues' })).body.response_format).toEqual({ type: 'json_object' });
  });

  it('asks an object model for a JSON object even when the prompt has a schema', () => {
    const { body } = buildRequest(findModel('qwen3.7-plus'), sectionPrompt({ schema: SCHEMA }));
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('sends no response_format to a model held by the prompt alone, and still the shape in words', () => {
    const model = customModel({ id: 'llava:13b', base: 'http://localhost:11434/v1' });
    const { wire, body } = buildRequest(model, sectionPrompt({ schema: SCHEMA }));
    expect(wire).toBe('openai');
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages[0]).toEqual({ role: 'system', content: `${SYSTEM}\n\n${SHAPE}` });
    expect(body.model).toBe('llava:13b');
  });

  it('puts the output limit under the field the model names', () => {
    const renamed = customModel({ id: 'o-model', base: 'https://example.test/v1', maxTokensField: 'max_completion_tokens' });
    const { body } = buildRequest(renamed, sectionPrompt());
    expect(body.max_completion_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
    // An entry that names none gets the usual one.
    const { maxTokensField: _, ...bare } = findModel('qwen3.7-plus');
    expect(buildRequest(bare, sectionPrompt()).body.max_tokens).toBe(2048);
  });

  it('sends a text request as a plain string, to a text model and to a vision model alike', () => {
    const { wire, body } = buildRequest(findModel('deepseek-v4-pro'), namesPrompt());
    expect(wire).toBe('openai');
    expect(body).toEqual({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'List every name the dialogue gives a person.\n\nAnswer with JSON: {"names": [{"name", "kind", "t", "line"}]}' },
        { role: 'user', content: '0:31 老陈，你来了。\n0:34 马修让我来的。' },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: 'json_object' },
    });
    expect(buildRequest(findModel('qwen3.7-plus'), namesPrompt()).body.messages[1].content).toBe('0:31 老陈，你来了。\n0:34 马修让我来的。');
    const { frames: _, ...noFrames } = namesPrompt();
    expect(buildRequest(findModel('deepseek-v4-pro'), noFrames).body.messages[1].content).toBe('0:31 老陈，你来了。\n0:34 马修让我来的。');
  });

  it('refuses frames for a model without image input: provider-unsupported', () => {
    expect(codeOf(() => buildRequest(findModel('deepseek-v4-pro'), sectionPrompt()))).toBe('provider-unsupported');
    const text = customModel({ id: 't', base: 'https://example.test/v1', maxImages: 0 });
    expect(codeOf(() => buildRequest(text, sectionPrompt({ frames: [frames[0]] })))).toBe('provider-unsupported');
    expect(codeOf(() => buildRequest({ id: 'no-input-listed', wire: 'openai' }, sectionPrompt()))).toBe('provider-unsupported');
  });

  it('refuses more frames than the model takes: too-long, and exactly the limit is fine', () => {
    const model = findModel('qwen3.7-plus');
    const many = (n) => Array.from({ length: n }, (_, i) => ({ time: i, data: `/9j/${i}`, label: `Frame ${i}` }));
    expect(buildRequest(model, sectionPrompt({ frames: many(60) })).body.messages[1].content).toHaveLength(121);
    expect(codeOf(() => buildRequest(model, sectionPrompt({ frames: many(61) })))).toBe('too-long');
    const small = customModel({ id: 'llava:13b', base: 'http://localhost:11434/v1' });
    expect(buildRequest(small, sectionPrompt({ frames: many(20) })).body.messages[1].content).toHaveLength(41);
    expect(codeOf(() => buildRequest(small, sectionPrompt({ frames: many(21) })))).toBe('too-long');
  });

  it('leaves out a frame without a picture and a label that is missing, rather than sending holes', () => {
    const { body } = buildRequest(findModel('qwen3.7-plus'), sectionPrompt({ frames: [{ time: 1, data: '', label: 'empty' }, null, { time: 2, data: '/9j/B' }, { time: 3, label: 'no data' }] }));
    expect(body.messages[1].content).toEqual([dataUrl('/9j/B'), { type: 'text', text: TEXT }]);
  });

  it('copes with a prompt that has only a text, and with none at all', () => {
    const model = findModel('qwen3.7-plus');
    expect(buildRequest(model, { text: 'hello' }).body).toEqual({ model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hello' }], response_format: { type: 'json_object' } });
    expect(buildRequest(model, { system: 'Only the system.', text: 'hi' }).body.messages[0]).toEqual({ role: 'system', content: 'Only the system.' });
    expect(buildRequest(model, { jsonShape: 'Only the shape.', text: 'hi' }).body.messages[0]).toEqual({ role: 'system', content: 'Only the shape.' });
    expect(buildRequest(model, undefined).body.messages).toEqual([{ role: 'user', content: '' }]);
  });

  it('throws no-model without a model, and provider-unsupported for a wire it does not know', () => {
    expect(codeOf(() => buildRequest(undefined, sectionPrompt()))).toBe('no-model');
    expect(codeOf(() => buildRequest(null, sectionPrompt()))).toBe('no-model');
    expect(codeOf(() => buildRequest({}, sectionPrompt()))).toBe('no-model');
    expect(codeOf(() => buildRequest('qwen3.7-plus', sectionPrompt()))).toBe('no-model');
    expect(codeOf(() => buildRequest({ ...findModel('qwen3.7-plus'), wire: 'anthropic' }, sectionPrompt()))).toBe('provider-unsupported');
    expect(codeOf(() => buildRequest({ id: 'x', input: ['text'] }, namesPrompt()))).toBe('provider-unsupported');
  });

  it('changes neither the model nor the prompt', () => {
    const prompt = frozenCopy(sectionPrompt({ schema: SCHEMA }));
    for (const model of MODELS.filter((m) => m.input.includes('image'))) {
      expect(() => buildRequest(model, prompt), model.id).not.toThrow();
    }
    expect(prompt).toEqual(sectionPrompt({ schema: SCHEMA }));
  });
});

describe('wire: buildRequest for Gemini', () => {
  const flash = findModel('gemini-3.8-flash');

  it('sends a system instruction, one user turn with inlineData parts, and a JSON answer by schema', () => {
    const { wire, body } = buildRequest(flash, sectionPrompt({ schema: SCHEMA }));
    expect(wire).toBe('gemini');
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: `${SYSTEM}\n\n${SHAPE}` }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Frame at 0:12' },
            { inlineData: { mimeType: 'image/jpeg', data: '/9j/AAA1' } },
            { text: 'Frame at 0:15' },
            { inlineData: { mimeType: 'image/jpeg', data: '/9j/AAA2' } },
            { text: TEXT },
          ],
        },
      ],
      generationConfig: {
        ...tuningFor('gemini-3.8-flash', 0.3),
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          required: ['cues'],
          propertyOrdering: ['cues'],
          properties: {
            cues: {
              type: 'ARRAY',
              maxItems: 3,
              items: {
                type: 'OBJECT',
                required: ['slot', 'kind', 'priority', 'brief'],
                propertyOrdering: ['slot', 'kind', 'priority', 'brief', 'confidence'],
                properties: {
                  slot: { type: 'STRING' },
                  kind: { type: 'STRING', enum: ['visual', 'text'] },
                  priority: { type: 'INTEGER', minimum: 1, maximum: 3 },
                  brief: { type: 'STRING' },
                  confidence: { type: 'STRING', nullable: true },
                },
              },
            },
          },
        },
      },
    });
    // No model id in the body (GeminiClient puts it in the address), and no key anywhere.
    expect(body).not.toHaveProperty('model');
  });

  it('writes the schema in Gemini’s dialect: no additionalProperties, a numeric enum as a range, required names that exist', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['mark', 'ghost'],
      properties: {
        mark: { type: ['string', 'null'], description: 'P3 or null' },
        role: { type: 'string', enum: ['addressed', 'speaker', 'unknown'] },
        confidence: { type: 'integer', enum: [1, 2, 3] },
        score: { type: 'number', enum: [0.5, 1], minimum: 0 },
        nothing: { type: 'null' },
        loose: {},
      },
    };
    const { responseSchema } = buildRequest(flash, sectionPrompt({ schema })).body.generationConfig;
    expect(responseSchema).toEqual({
      type: 'OBJECT',
      required: ['mark'],
      propertyOrdering: ['mark', 'role', 'confidence', 'score', 'nothing', 'loose'],
      properties: {
        mark: { type: 'STRING', nullable: true, description: 'P3 or null' },
        role: { type: 'STRING', enum: ['addressed', 'speaker', 'unknown'] },
        confidence: { type: 'INTEGER', minimum: 1, maximum: 3 },
        score: { type: 'NUMBER', minimum: 0, maximum: 1 },
        nothing: { type: 'NULL' },
        loose: {},
      },
    });
    expect(JSON.stringify(responseSchema)).not.toContain('additionalProperties');
    expect(JSON.stringify(responseSchema)).not.toContain('$schema');
  });

  it('keeps a schema already written for Gemini as it is', () => {
    const schema = { type: 'OBJECT', properties: { time: { type: 'NUMBER' }, answer: { type: 'STRING' } }, required: ['answer'], propertyOrdering: ['time', 'answer'] };
    expect(buildRequest(flash, sectionPrompt({ schema })).body.generationConfig.responseSchema).toEqual(schema);
  });

  it('asks for JSON without a schema when the prompt has none', () => {
    const { generationConfig } = buildRequest(flash, sectionPrompt()).body;
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect(generationConfig).not.toHaveProperty('responseSchema');
  });

  it('follows the extension’s tuning: a Gemini 3 model is not sent a temperature, another model on this wire is', () => {
    const gemini3 = buildRequest(flash, sectionPrompt()).body.generationConfig;
    expect(gemini3).not.toHaveProperty('temperature');
    expect(gemini3).toMatchObject(tuningFor('gemini-3.8-flash', 0.3));
    const gateway = customModel({ id: 'my-gateway-model', base: 'https://example.test', wire: 'gemini', json: 'schema' });
    const other = buildRequest(gateway, sectionPrompt({ schema: SCHEMA })).body.generationConfig;
    expect(other.temperature).toBe(0.3);
    expect(other.maxOutputTokens).toBe(2048);
    expect(other.responseSchema.type).toBe('OBJECT');
  });

  it('asks an endpoint held by the prompt alone for neither a JSON type nor a schema', () => {
    const plain = customModel({ id: 'my-gateway-model', base: 'https://example.test', wire: 'gemini' });
    const { body } = buildRequest(plain, sectionPrompt({ schema: SCHEMA }));
    expect(body.generationConfig).toEqual({ temperature: 0.3, maxOutputTokens: 2048 });
    expect(body.systemInstruction.parts[0].text).toContain(SHAPE);
  });

  it('builds a text-only request for the names task', () => {
    const { body } = buildRequest(findModel('gemini-3.5-flash-lite'), namesPrompt());
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '0:31 老陈，你来了。\n0:34 马修让我来的。' }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(512);
  });

  it('holds Gemini to the same limits: too many frames, and no system instruction when there is nothing to say', () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ time: i, data: `/9j/${i}`, label: `Frame ${i}` }));
    expect(codeOf(() => buildRequest(flash, sectionPrompt({ frames: many })))).toBe('too-long');
    expect(buildRequest(flash, { text: 'hello' }).body).not.toHaveProperty('systemInstruction');
  });
});

describe('wire: clientBase', () => {
  it('gives the address each shared client is built with', () => {
    expect(clientBase(findModel('qwen3.7-plus'))).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(clientBase(findModel('doubao-seed-2.1-pro'))).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(clientBase(findModel('deepseek-v4-pro'))).toBe('https://api.deepseek.com');
    // GeminiClient adds /v1beta itself.
    expect(clientBase(findModel('gemini-3.8-flash'))).toBe('https://generativelanguage.googleapis.com');
    expect(clientBase({ wire: 'gemini', base: 'https://proxy.example.test/google/v1beta/' })).toBe('https://proxy.example.test/google');
    expect(clientBase({ wire: 'gemini', base: 'https://proxy.example.test' })).toBe('https://proxy.example.test');
    expect(clientBase({ wire: 'openai', base: 'http://localhost:11434/v1/' })).toBe('http://localhost:11434/v1');
    expect(clientBase(undefined)).toBe('');
  });
});

/** A client whose chat answers with `answers` in turn (an Error is thrown) and records each call. */
function fakeChat(...answers) {
  const calls = [];
  return {
    calls,
    chat: vi.fn(async (body, signal, options) => {
      calls.push({ body, signal, options });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    }),
  };
}

/** The same for a Gemini client. */
function fakeGenerate(...answers) {
  const calls = [];
  return {
    calls,
    generate: vi.fn(async (body, signal, options) => {
      calls.push({ body, signal, options });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    }),
  };
}

/** A client that never answers and never looks at its signal. */
function deafClient() {
  const signals = [];
  return {
    signals,
    chat: vi.fn((body, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    }),
  };
}

/** A client that never answers, and fails the way the real ones do when its signal aborts. */
function hangingClient() {
  const signals = [];
  return {
    signals,
    chat: vi.fn(
      (body, signal) =>
        new Promise((_, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new ApiError('aborted')));
        }),
    ),
  };
}

/** Timers that fire only when the test says so. */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  };
}

/** A sleep that returns at once and remembers how long it was asked to wait. */
function fakeSleep() {
  const waits = [];
  const sleep = vi.fn(async (ms) => {
    waits.push(ms);
  });
  sleep.waits = waits;
  return sleep;
}

/** Lets every promise already settled run its course. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What a promise rejected with (or 'resolved'), without leaving the rejection unhandled meanwhile. */
const failure = (promise) => promise.then(() => 'resolved', (err) => err);

describe('wire: complete', () => {
  const qwen = findModel('qwen3.7-plus');
  const flash = findModel('gemini-3.8-flash');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('openai: one chat call with the body and the model id, a signal of its own, and the client’s retries off', async () => {
    const client = fakeChat(chatReply('{"cues":[]}'));
    const sleep = fakeSleep();
    const out = await complete(client, qwen, sectionPrompt(), { sleep });
    expect(out).toEqual({ text: '{"cues":[]}', usage: { input: 1200, output: 80, thinking: 0, requests: 1 }, finishReason: 'stop' });
    expect(client.chat).toHaveBeenCalledTimes(1);
    const { body, signal, options } = client.calls[0];
    expect(body).toEqual(buildRequest(qwen, sectionPrompt()).body);
    expect(body.model).toBe('qwen3.7-plus');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(options).toEqual({ retries: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gemini: one generate call with the body, a signal of its own, and the client’s retries and deadline off', async () => {
    const client = fakeGenerate(geminiReply('{"cues":[]}'));
    const out = await complete(client, flash, sectionPrompt({ schema: SCHEMA }), { sleep: fakeSleep() });
    expect(out).toEqual({ text: '{"cues":[]}', usage: { input: 900, output: 60, thinking: 15, requests: 1 }, finishReason: 'STOP' });
    expect(client.generate).toHaveBeenCalledTimes(1);
    const { body, signal, options } = client.calls[0];
    expect(body).toEqual(buildRequest(flash, sectionPrompt({ schema: SCHEMA })).body);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(options).toEqual({ retries: 0, timeoutMs: 0 });
  });

  it('reads usage and the finish reason with the shared helpers: reasoning apart, a cut answer as MAX_TOKENS', async () => {
    const reply = chatReply('{"cues":[', 'length', { prompt_tokens: 5000, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 200 } });
    const out = await complete(fakeChat(reply), qwen, sectionPrompt(), { sleep: fakeSleep() });
    expect(out).toEqual({ text: '{"cues":[', usage: { input: 5000, output: 500, thinking: 200, requests: 1 }, finishReason: 'MAX_TOKENS' });
    const cut = await complete(fakeGenerate(geminiReply('{"cues":[', 'MAX_TOKENS')), flash, sectionPrompt(), { sleep: fakeSleep() });
    expect(cut.finishReason).toBe('MAX_TOKENS');
  });

  it('tries again after a network error, after 2 seconds, with a new signal', async () => {
    const client = fakeChat(new ApiError('network', 'socket hang up'), chatReply('{"cues":[]}'));
    const sleep = fakeSleep();
    const out = await complete(client, qwen, sectionPrompt(), { sleep });
    expect(out.text).toBe('{"cues":[]}');
    expect(client.chat).toHaveBeenCalledTimes(2);
    expect(sleep.waits).toEqual([2000]);
    expect(client.calls[1].signal).not.toBe(client.calls[0].signal);
    expect(client.calls[1].body).toEqual(client.calls[0].body);
    expect(client.calls[1].options).toEqual({ retries: 0 });
  });

  it('tries again after a server error and after a timeout the server reported, waiting 2 then 4 seconds', async () => {
    const client = fakeGenerate(new GeminiError('server', 'overloaded', 503), new GeminiError('timeout', 'deadline exceeded', 504), geminiReply('{"cues":[]}'));
    const sleep = fakeSleep();
    const out = await complete(client, flash, sectionPrompt(), { sleep });
    expect(out.text).toBe('{"cues":[]}');
    expect(client.generate).toHaveBeenCalledTimes(3);
    expect(sleep.waits).toEqual([2000, 4000]);
  });

  it('gives up after `retries` more attempts and throws the last error as it came', async () => {
    const last = new ApiError('server', 'still down', 500);
    const client = fakeChat(new ApiError('network'), new ApiError('server', 'down', 502), last, chatReply('never reached'));
    const sleep = fakeSleep();
    const err = await failure(complete(client, qwen, sectionPrompt(), { sleep }));
    expect(err).toBe(last);
    expect(client.chat).toHaveBeenCalledTimes(3);
    expect(sleep.waits).toEqual([2000, 4000]);
  });

  it('follows the number of retries it is given: none, or more with the wait doubling', async () => {
    const none = fakeChat(new ApiError('network'));
    const sleep = fakeSleep();
    expect((await failure(complete(none, qwen, sectionPrompt(), { retries: 0, sleep }))).code).toBe('network');
    expect(none.chat).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    const four = fakeChat(new ApiError('network'), new ApiError('network'), new ApiError('network'), new ApiError('network'), chatReply('{"ok":true}'));
    const patient = fakeSleep();
    expect((await complete(four, qwen, sectionPrompt(), { retries: 4, sleep: patient })).text).toBe('{"ok":true}');
    expect(patient.waits).toEqual([2000, 4000, 8000, 16000]);

    // Not a count: one attempt.
    for (const retries of [-1, NaN, 'many']) {
      const client = fakeChat(new ApiError('network'));
      await failure(complete(client, qwen, sectionPrompt(), { retries, sleep: fakeSleep() }));
      expect(client.chat, String(retries)).toHaveBeenCalledTimes(1);
    }
  });

  it('does not try again after any other error, and throws it unchanged', async () => {
    const errors = [
      new ApiError('bad-key', 'invalid api key', 401),
      new ApiError('rate-limited', 'slow down', 429),
      new ApiError('quota', 'no credit', 403),
      new ApiError('model-not-found', '', 404),
      new ApiError('too-long', '', 400),
      new ApiError('request-failed', 'HTTP 418', 418),
      new GeminiError('region', 'location is not supported', 400),
      new Error('boom'),
      new TypeError('client.fetch is not a function'),
      // Has the look of one, but is not an ApiError: not ours to retry.
      Object.assign(new Error('socket'), { code: 'network' }),
    ];
    for (const thrown of errors) {
      const client = fakeChat(thrown, chatReply('never reached'));
      const sleep = fakeSleep();
      const err = await failure(complete(client, qwen, sectionPrompt(), { sleep }));
      expect(err, thrown.message).toBe(thrown);
      expect(client.chat, thrown.message).toHaveBeenCalledTimes(1);
      expect(sleep, thrown.message).not.toHaveBeenCalled();
    }
  });

  it('does not try again after a reply that is blocked, empty or cut before it said anything', async () => {
    const cases = [
      [fakeChat(chatReply('', 'content_filter')), qwen, 'blocked'],
      [fakeChat({ choices: [] }), qwen, 'empty-response'],
      [fakeChat(chatReply('   ', 'length')), qwen, 'truncated'],
      [fakeGenerate({ promptFeedback: { blockReason: 'SAFETY' } }), flash, 'blocked'],
      [fakeGenerate({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), flash, 'truncated'],
      [fakeGenerate({}), flash, 'empty-response'],
    ];
    for (const [client, model, code] of cases) {
      const sleep = fakeSleep();
      const err = await failure(complete(client, model, sectionPrompt(), { sleep }));
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe(code);
      expect((client.chat || client.generate).mock.calls.length, code).toBe(1);
      expect(sleep, code).not.toHaveBeenCalled();
    }
  });

  it('throws what buildRequest throws without calling the client', async () => {
    const client = fakeChat(chatReply('{}'));
    const err = await failure(complete(client, findModel('deepseek-v4-pro'), sectionPrompt(), { sleep: fakeSleep() }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('provider-unsupported');
    expect(client.chat).not.toHaveBeenCalled();
    expect((await failure(complete(client, undefined, sectionPrompt()))).code).toBe('no-model');
  });

  it('passes a client that throws before it returns a promise on as it is', async () => {
    const boom = new ApiError('no-model');
    const client = {
      chat: vi.fn(() => {
        throw boom;
      }),
    };
    const clock = fakeTimers();
    expect(await failure(complete(client, qwen, sectionPrompt(), { sleep: fakeSleep(), ...clock }))).toBe(boom);
    expect(clock.timers.every((timer) => timer.cleared)).toBe(true);
  });

  it('gives each attempt a deadline, 120 seconds by default, and clears it when the answer comes', async () => {
    const clock = fakeTimers();
    await complete(fakeChat(chatReply('{"cues":[]}')), qwen, sectionPrompt(), { sleep: fakeSleep(), ...clock });
    expect(clock.timers.map((timer) => timer.ms)).toEqual([120000]);
    expect(clock.timers[0].cleared).toBe(true);

    const retried = fakeTimers();
    await complete(fakeChat(new ApiError('server'), chatReply('{"cues":[]}')), qwen, sectionPrompt(), { timeoutMs: 45000, sleep: fakeSleep(), ...retried });
    expect(retried.timers.map((timer) => timer.ms)).toEqual([45000, 45000]);
    expect(retried.timers.every((timer) => timer.cleared)).toBe(true);
  });

  it('sets no deadline when timeoutMs is 0', async () => {
    const clock = fakeTimers();
    await complete(fakeChat(chatReply('{"cues":[]}')), qwen, sectionPrompt(), { timeoutMs: 0, sleep: fakeSleep(), ...clock });
    expect(clock.timers).toEqual([]);
  });

  it('a deadline that fires aborts that attempt and is tried again; the last one is thrown as a timeout', async () => {
    const client = deafClient();
    const clock = fakeTimers();
    const sleep = fakeSleep();
    const outcome = failure(complete(client, qwen, sectionPrompt(), { timeoutMs: 5000, retries: 1, sleep, ...clock }));
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0].ms).toBe(5000);
    expect(client.signals[0].aborted).toBe(false);

    clock.timers[0].fn();
    await settle();
    expect(client.signals[0].aborted).toBe(true);
    expect(sleep.waits).toEqual([2000]);
    expect(client.chat).toHaveBeenCalledTimes(2);
    expect(clock.timers).toHaveLength(2);
    // The second attempt has a controller of its own: the first deadline did not abort it.
    expect(client.signals[1]).not.toBe(client.signals[0]);
    expect(client.signals[1].aborted).toBe(false);

    clock.timers[1].fn();
    const err = await outcome;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('timeout');
    expect(err.clientDeadline).toBe(true);
    expect(err.detail).toContain('5000');
    expect(client.signals[1].aborted).toBe(true);
    expect(client.chat).toHaveBeenCalledTimes(2);
    expect(sleep.waits).toEqual([2000]);
    expect(clock.timers.every((timer) => timer.cleared)).toBe(true);
  });

  it('reports a deadline as a timeout even when the client answers the abort with its own "aborted"', async () => {
    const client = hangingClient();
    const clock = fakeTimers();
    const sleep = fakeSleep();
    const outcome = failure(complete(client, qwen, sectionPrompt(), { retries: 1, sleep, ...clock }));
    clock.timers[0].fn();
    await settle();
    expect(client.chat).toHaveBeenCalledTimes(2);
    clock.timers[1].fn();
    const err = await outcome;
    expect(err.code).toBe('timeout');
    expect(sleep.waits).toEqual([2000]);
  });

  it('answers after a deadline: the first attempt is cut, the second succeeds', async () => {
    let n = 0;
    const client = {
      chat: vi.fn(() => {
        n += 1;
        return n === 1 ? new Promise(() => {}) : Promise.resolve(chatReply('{"cues":[]}'));
      }),
    };
    const clock = fakeTimers();
    const sleep = fakeSleep();
    const run = complete(client, qwen, sectionPrompt(), { sleep, ...clock });
    clock.timers[0].fn();
    expect((await run).text).toBe('{"cues":[]}');
    expect(sleep.waits).toEqual([2000]);
    expect(clock.timers).toHaveLength(2);
    expect(clock.timers[1].cleared).toBe(true);
  });

  it('ignores a deadline that fires after the answer came', async () => {
    const client = fakeChat(chatReply('{"cues":[]}'));
    const clock = fakeTimers();
    const out = await complete(client, qwen, sectionPrompt(), { sleep: fakeSleep(), ...clock });
    clock.timers[0].fn();
    await settle();
    expect(out.text).toBe('{"cues":[]}');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('a caller abort during a request throws "aborted" at once: no retry, no wait', async () => {
    for (const client of [deafClient(), hangingClient()]) {
      const controller = new AbortController();
      const clock = fakeTimers();
      const sleep = fakeSleep();
      const outcome = failure(complete(client, qwen, sectionPrompt(), { signal: controller.signal, sleep, ...clock }));
      expect(client.chat).toHaveBeenCalledTimes(1);
      controller.abort();
      const err = await outcome;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('aborted');
      // The request itself was told to stop, and its deadline was dropped.
      expect(client.signals[0].aborted).toBe(true);
      expect(clock.timers[0].cleared).toBe(true);
      await settle();
      expect(client.chat).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('a caller who aborted before the call gets "aborted" and the client is never called', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fakeChat(chatReply('{}'));
    const clock = fakeTimers();
    const err = await failure(complete(client, qwen, sectionPrompt(), { signal: controller.signal, sleep: fakeSleep(), ...clock }));
    expect(err.code).toBe('aborted');
    expect(client.chat).not.toHaveBeenCalled();
    expect(clock.timers).toEqual([]);
  });

  it('a caller abort while waiting to retry throws "aborted" at once, whatever the sleep does', async () => {
    const controller = new AbortController();
    const client = fakeChat(new ApiError('network'), chatReply('never reached'));
    const waits = [];
    const sleep = vi.fn((ms, signal) => {
      waits.push([ms, signal]);
      return new Promise(() => {});
    });
    const outcome = failure(complete(client, qwen, sectionPrompt(), { signal: controller.signal, sleep }));
    await settle();
    expect(waits).toEqual([[2000, controller.signal]]);
    controller.abort();
    const err = await outcome;
    expect(err.code).toBe('aborted');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('a caller abort wins over the error the request ends with', async () => {
    const controller = new AbortController();
    const client = {
      chat: vi.fn(async () => {
        controller.abort();
        throw new ApiError('network', 'cut');
      }),
    };
    const sleep = fakeSleep();
    const err = await failure(complete(client, qwen, sectionPrompt(), { signal: controller.signal, sleep }));
    expect(err.code).toBe('aborted');
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('by default keeps time with setTimeout: 120 s for an attempt, 2 s before the next', async () => {
    vi.useFakeTimers();
    let n = 0;
    const client = {
      chat: vi.fn(() => {
        n += 1;
        return n === 1 ? new Promise(() => {}) : Promise.resolve(chatReply('{"cues":[]}'));
      }),
    };
    const run = complete(client, qwen, sectionPrompt());
    await vi.advanceTimersByTimeAsync(119999);
    expect(client.chat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    // The deadline has fired; the next attempt waits out its 2 seconds.
    expect(client.chat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.chat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.chat).toHaveBeenCalledTimes(2);
    expect((await run).text).toBe('{"cues":[]}');
    // The second attempt's deadline was cleared with its answer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('by default drops its retry timer when the caller aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const client = fakeChat(new ApiError('network'), chatReply('never reached'));
    const outcome = failure(complete(client, qwen, sectionPrompt(), { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect((await outcome).code).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
    expect(client.chat).toHaveBeenCalledTimes(1);
  });
});

/** A fetch that answers with `answers` in turn ({status, body}) and records each request. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  });
  fn.calls = calls;
  return fn;
}

/** A fetch that never answers and rejects when its signal aborts, as fetch does. */
function hangingFetch() {
  return vi.fn(
    (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
  );
}

describe('wire: complete with the shared clients as they are', () => {
  it('QwenClient: sends the body to the model’s address with the key in a header, and retries by this module’s rules', async () => {
    const model = findModel('qwen3.7-plus');
    const fetchImpl = fakeFetch({ status: 500, body: { error: { message: 'internal error' } } }, { status: 200, body: chatReply('{"cues":[]}') });
    const client = new QwenClient({ apiKey: 'sk-test-key', apiBase: clientBase(model), fetchImpl });
    const sleep = fakeSleep();
    const out = await complete(client, model, sectionPrompt(), { sleep });
    expect(out).toEqual({ text: '{"cues":[]}', usage: { input: 1200, output: 80, thinking: 0, requests: 1 }, finishReason: 'stop' });
    // The client's own retry (a real 2 s wait) is off: the wait was the injected one.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep.waits).toEqual([2000]);
    const first = fetchImpl.calls[0];
    expect(first.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(first.url).not.toContain('sk-test-key');
    expect(first.init.headers.authorization).toBe('Bearer sk-test-key');
    expect(first.body).toEqual(buildRequest(model, sectionPrompt()).body);
    expect(JSON.stringify(first.body)).not.toContain('sk-test-key');
  });

  it('QwenClient: a text model at another address, DeepSeek', async () => {
    const model = findModel('deepseek-v4-pro');
    const fetchImpl = fakeFetch({ status: 200, body: chatReply('{"names":[{"name":"老陈","kind":"vocative","t":31,"line":"老陈，你来了。"}]}') });
    const client = new QwenClient({ apiKey: 'sk-deepseek', apiBase: clientBase(model), fetchImpl });
    const out = await complete(client, model, namesPrompt(), { sleep: fakeSleep() });
    expect(fetchImpl.calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(fetchImpl.calls[0].body.model).toBe('deepseek-v4-pro');
    expect(readJson(out.text).names[0].name).toBe('老陈');
  });

  it('QwenClient: a deadline cuts the request, is tried again, and ends as a timeout rather than the client’s "aborted"', async () => {
    const model = findModel('qwen3.7-plus');
    const fetchImpl = hangingFetch();
    const client = new QwenClient({ apiKey: 'sk-test-key', apiBase: clientBase(model), fetchImpl });
    const clock = fakeTimers();
    const sleep = fakeSleep();
    const outcome = failure(complete(client, model, sectionPrompt(), { retries: 1, sleep, ...clock }));
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.timers[0].fn();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(false);
    clock.timers[1].fn();
    const err = await outcome;
    expect(err.code).toBe('timeout');
    expect(sleep.waits).toEqual([2000]);
  });

  it('QwenClient: an error that will not pass is thrown as the client classified it', async () => {
    const model = findModel('qwen3.7-plus');
    const fetchImpl = fakeFetch({ status: 401, body: { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } } });
    const client = new QwenClient({ apiKey: 'sk-wrong', apiBase: clientBase(model), fetchImpl });
    const sleep = fakeSleep();
    const err = await failure(complete(client, model, sectionPrompt(), { sleep }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('bad-key');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('GeminiClient: sends the body to generateContent with the key in a header, and retries by this module’s rules', async () => {
    const model = findModel('gemini-3.8-flash');
    const fetchImpl = fakeFetch({ status: 500, body: { error: { message: 'internal' } } }, { status: 200, body: geminiReply('{"cues":[]}') });
    const client = new GeminiClient({ apiKey: 'AIza-test-key', apiBase: clientBase(model), model: model.id, fetchImpl, stream: false });
    const sleep = fakeSleep();
    const out = await complete(client, model, sectionPrompt({ schema: SCHEMA }), { sleep });
    expect(out).toEqual({ text: '{"cues":[]}', usage: { input: 900, output: 60, thinking: 15, requests: 1 }, finishReason: 'STOP' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep.waits).toEqual([2000]);
    const first = fetchImpl.calls[0];
    expect(first.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(first.url).not.toContain('AIza-test-key');
    expect(first.init.headers['x-goog-api-key']).toBe('AIza-test-key');
    expect(first.body).toEqual(buildRequest(model, sectionPrompt({ schema: SCHEMA })).body);
  });

  it('GeminiClient: a caller abort stops the request and throws "aborted"', async () => {
    const model = findModel('gemini-3.8-flash');
    const fetchImpl = hangingFetch();
    const client = new GeminiClient({ apiKey: 'AIza-test-key', apiBase: clientBase(model), model: model.id, fetchImpl, stream: false });
    const controller = new AbortController();
    const sleep = fakeSleep();
    const outcome = failure(complete(client, model, sectionPrompt(), { signal: controller.signal, sleep, ...fakeTimers() }));
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.abort();
    const err = await outcome;
    expect(err.code).toBe('aborted');
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('wire: readJson', () => {
  it('reads JSON that is bare, fenced, or has words around it', () => {
    expect(readJson('{"cues": []}')).toEqual({ cues: [] });
    expect(readJson('```json\n{"cues": [{"brief": "{P3} 走到窗前"}]}\n```')).toEqual({ cues: [{ brief: '{P3} 走到窗前' }] });
    expect(readJson('```\n{"mark": "P3"}\n```')).toEqual({ mark: 'P3' });
    expect(readJson('Here is the answer:\n{"mark": null, "role": "unknown"}\nHope it helps.')).toEqual({ mark: null, role: 'unknown' });
    expect(readJson('  \n{"names": [{"name": "马修"}]}  ')).toEqual({ names: [{ name: '马修' }] });
  });

  it('returns an answer that is already parsed, and lets an array through for the checker to judge', () => {
    const parsed = { cues: [] };
    expect(readJson(parsed)).toBe(parsed);
    expect(readJson('[{"slot": "g_0001"}]')).toEqual([{ slot: 'g_0001' }]);
  });

  it('throws ApiError bad-json when there is no JSON, or only a bare value', () => {
    for (const text of ['', '   ', 'I cannot describe this scene.', '{"cues": [', '{cues: []}', '```json\n```', 'null', '42', '"cues"', 'true', undefined, null, 42]) {
      const err = codeOf(() => readJson(text));
      expect(err, String(text)).toBe('bad-json');
    }
  });
});

describe('json: check', () => {
  const cue = (over = {}) => ({ slot: 'g_0001', kind: 'visual', priority: 2, brief: '{P3} 走到窗前。', ...over });

  it('finds nothing wrong with an answer that fits, in Chinese or in English', () => {
    expect(check({ cues: [cue(), cue({ slot: 'g_0002', kind: 'text', priority: 1, brief: 'A sign reads "Closed".', confidence: 'high' }), cue({ confidence: null })] }, SCHEMA)).toEqual([]);
    expect(check({ cues: [] }, SCHEMA)).toEqual([]);
  });

  it('says where a wrong type is, with the path of the value', () => {
    const answer = { cues: [cue(), cue(), cue({ priority: 'high' })] };
    expect(check(answer, SCHEMA)).toEqual(['cues[2].priority: expected integer']);
  });

  it('knows each type', () => {
    const fits = (value, type) => check(value, { type }).length === 0;
    expect(fits('窗', 'string')).toBe(true);
    expect(fits('', 'string')).toBe(true);
    expect(fits(3, 'string')).toBe(false);
    expect(fits(null, 'string')).toBe(false);

    expect(fits(2.5, 'number')).toBe(true);
    expect(fits(-3, 'number')).toBe(true);
    expect(fits('2.5', 'number')).toBe(false);
    expect(fits(NaN, 'number')).toBe(false);
    expect(fits(Infinity, 'number')).toBe(false);

    expect(fits(2, 'integer')).toBe(true);
    expect(fits(2.0, 'integer')).toBe(true);
    expect(fits(2.5, 'integer')).toBe(false);
    expect(fits('2', 'integer')).toBe(false);

    expect(fits(false, 'boolean')).toBe(true);
    expect(fits(0, 'boolean')).toBe(false);
    expect(fits('true', 'boolean')).toBe(false);

    expect(fits([], 'array')).toBe(true);
    expect(fits({ length: 0 }, 'array')).toBe(false);

    expect(fits({}, 'object')).toBe(true);
    expect(fits([], 'object')).toBe(false);
    expect(fits(null, 'object')).toBe(false);

    expect(fits(null, 'null')).toBe(true);
    expect(fits(undefined, 'null')).toBe(false);
    expect(fits(0, 'null')).toBe(false);
    expect(fits('', 'null')).toBe(false);
  });

  it('names the type it expected', () => {
    expect(check(1, { type: 'string' })).toEqual(['$: expected string']);
    expect(check('1', { type: 'number' })).toEqual(['$: expected number']);
    expect(check(1.5, { type: 'integer' })).toEqual(['$: expected integer']);
    expect(check('no', { type: 'boolean' })).toEqual(['$: expected boolean']);
    expect(check({}, { type: 'array' })).toEqual(['$: expected array']);
    expect(check([], { type: 'object' })).toEqual(['$: expected object']);
    expect(check(0, { type: 'null' })).toEqual(['$: expected null']);
  });

  it('accepts any type of a list, and names them all when none fits', () => {
    const schema = { type: 'object', properties: { mark: { type: ['string', 'null'] }, t: { type: ['integer', 'string', 'null'] } } };
    expect(check({ mark: 'P3', t: 31 }, schema)).toEqual([]);
    expect(check({ mark: null, t: '0:31' }, schema)).toEqual([]);
    expect(check({ mark: 3, t: 1.5 }, schema)).toEqual(['mark: expected string or null', 't: expected integer, string or null']);
    expect(check(true, { type: ['number', 'string'] })).toEqual(['$: expected number or string']);
  });

  it('reads type names in upper case, as Gemini writes them', () => {
    const schema = { type: 'OBJECT', properties: { time: { type: 'NUMBER' }, answer: { type: 'STRING' } }, required: ['answer'] };
    expect(check({ time: 12, answer: '门开着。' }, schema)).toEqual([]);
    expect(check({ time: '12' }, schema)).toEqual(['answer: missing', 'time: expected number']);
    expect(check('x', { type: ['INTEGER', 'Null'] })).toEqual(['$: expected integer or null']);
  });

  it('reports a required property that is missing, and takes one that is there, even null, for the type to judge', () => {
    const schema = { type: 'object', required: ['name', 'kind', 't'], properties: { name: { type: 'string' }, kind: { type: 'string' }, t: { type: 'number' } } };
    expect(check({ name: '马修', kind: 'vocative', t: 31 }, schema)).toEqual([]);
    expect(check({ name: '马修' }, schema)).toEqual(['kind: missing', 't: missing']);
    expect(check({ name: '马修', kind: undefined, t: 31 }, schema)).toEqual(['kind: missing']);
    expect(check({ name: null, kind: 'vocative', t: 31 }, schema)).toEqual(['name: expected string']);
    expect(check({}, { required: ['cues'] })).toEqual(['cues: missing']);
    // Only what the value itself has counts, not what every object inherits.
    expect(check({}, { type: 'object', required: ['toString', 'constructor'] })).toEqual(['toString: missing', 'constructor: missing']);
  });

  it('does not ask an optional property to be there', () => {
    const schema = { type: 'object', properties: { confidence: { type: 'string' } } };
    expect(check({}, schema)).toEqual([]);
    expect(check({ confidence: undefined }, schema)).toEqual([]);
    expect(check({ confidence: 3 }, schema)).toEqual(['confidence: expected string']);
  });

  it('checks every item of an array and writes the index in the path, however deep', () => {
    expect(check(['a', 2, 'c', null], { type: 'array', items: { type: 'string' } })).toEqual(['[1]: expected string', '[3]: expected string']);
    const grid = { type: 'object', properties: { rows: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } } };
    expect(check({ rows: [[1, 2], ['x', 4], [5, 6.5]] }, grid)).toEqual(['rows[1][0]: expected integer', 'rows[2][1]: expected integer']);
    const people = { type: 'object', properties: { cues: { type: 'array', items: { type: 'object', properties: { people: { type: 'array', items: { type: 'object', required: ['char'], properties: { char: { type: 'string' } } } } } } } } };
    expect(check({ cues: [{ people: [{ char: 'P1' }, {}, { char: 7 }] }] }, people)).toEqual(['cues[0].people[1].char: missing', 'cues[0].people[2].char: expected string']);
  });

  it('writes a key that is not a plain word in brackets', () => {
    const schema = { type: 'object', required: ['片名'], properties: { 'on-screen text': { type: 'string' }, 片名: { type: 'string' }, inner: { type: 'object', properties: { 'a.b': { type: 'number' } } } } };
    expect(check({ 'on-screen text': 5, inner: { 'a.b': 'x' } }, schema)).toEqual(['["片名"]: missing', '["on-screen text"]: expected string', 'inner["a.b"]: expected number']);
  });

  it('holds a value to its enum, and quotes the choices', () => {
    expect(check({ cues: [cue({ kind: 'sound' })] }, SCHEMA)).toEqual(['cues[0].kind: expected one of "visual", "text"']);
    expect(check('旁白', { enum: ['画面', '字幕'] })).toEqual(['$: expected one of "画面", "字幕"']);
    expect(check('字幕', { enum: ['画面', '字幕'] })).toEqual([]);
    expect(check(4, { type: 'integer', enum: [1, 2, 3] })).toEqual(['$: expected one of 1, 2, 3']);
    expect(check(2, { type: 'integer', enum: [1, 2, 3] })).toEqual([]);
    expect(check(null, { enum: ['P1', null] })).toEqual([]);
    expect(check('P2', { enum: ['P1', null] })).toEqual(['$: expected one of "P1", null']);
    // "1" is not 1.
    expect(check('1', { enum: [1, 2, 3] })).toEqual(['$: expected one of 1, 2, 3']);
  });

  it('holds a number to its minimum and maximum, both included', () => {
    const schema = { type: 'object', properties: { priority: { type: 'integer', minimum: 1, maximum: 3 } } };
    expect(check({ priority: 1 }, schema)).toEqual([]);
    expect(check({ priority: 3 }, schema)).toEqual([]);
    expect(check({ priority: 0 }, schema)).toEqual(['priority: expected at least 1']);
    expect(check({ priority: 4 }, schema)).toEqual(['priority: expected at most 3']);
    expect(check(-0.01, { type: 'number', minimum: 0, maximum: 1 })).toEqual(['$: expected at least 0']);
    expect(check(1.01, { type: 'number', minimum: 0, maximum: 1 })).toEqual(['$: expected at most 1']);
    // A limit is about numbers: a string is not measured against it.
    expect(check('5', { minimum: 10 })).toEqual([]);
  });

  it('holds an array to maxItems, the limit itself included', () => {
    expect(check({ cues: [cue(), cue(), cue()] }, SCHEMA)).toEqual([]);
    expect(check({ cues: [cue(), cue(), cue(), cue()] }, SCHEMA)).toEqual(['cues: expected at most 3 items']);
    expect(check([1, 2], { type: 'array', maxItems: 0 })).toEqual(['$: expected at most 0 items']);
    expect(check([], { type: 'array', maxItems: 0 })).toEqual([]);
  });

  it('reports a property nobody asked for when additionalProperties is false, and only then', () => {
    expect(check({ cues: [cue({ colour: 'red' })], note: 'extra' }, SCHEMA)).toEqual(['cues[0].colour: not expected', 'note: not expected']);
    const open = { type: 'object', properties: { a: { type: 'string' } } };
    expect(check({ a: 'x', b: 1 }, open)).toEqual([]);
    expect(check({ a: 'x', b: 1 }, { ...open, additionalProperties: true })).toEqual([]);
    expect(check({ a: 'x', b: 1 }, { ...open, additionalProperties: { type: 'string' } })).toEqual([]);
    // With no properties named, everything is extra.
    expect(check({ a: 1 }, { type: 'object', additionalProperties: false })).toEqual(['a: not expected']);
    expect(check({}, { type: 'object', additionalProperties: false })).toEqual([]);
    // A name every object inherits is still not a property of the schema.
    expect(check({ constructor: 1 }, { type: 'object', additionalProperties: false, properties: {} })).toEqual(['constructor: not expected']);
  });

  it('says a wrong type once and nothing more about that value', () => {
    expect(check({ cues: 'none' }, SCHEMA)).toEqual(['cues: expected array']);
    expect(check({ cues: [null, 'x'] }, SCHEMA)).toEqual(['cues[0]: expected object', 'cues[1]: expected object']);
    expect(check('x', { type: 'integer', enum: [1, 2], minimum: 1 })).toEqual(['$: expected integer']);
  });

  it('lists every problem of an answer, in the order it meets them', () => {
    const answer = {
      cues: [
        cue({ priority: 5 }),
        { slot: 7, kind: 'visual', brief: '门开了。', mood: 'tense' },
        cue({ kind: 'Visual', confidence: 0.9 }),
        cue(),
      ],
      sceneStarts: [0],
    };
    expect(check(answer, SCHEMA)).toEqual([
      'cues: expected at most 3 items',
      'cues[0].priority: expected at most 3',
      'cues[1].priority: missing',
      'cues[1].slot: expected string',
      'cues[1].mood: not expected',
      'cues[2].kind: expected one of "visual", "text"',
      'cues[2].confidence: expected string or null',
      'sceneStarts: not expected',
    ]);
  });

  it('calls the answer itself "$"', () => {
    expect(check([], SCHEMA)).toEqual(['$: expected object']);
    expect(check(null, SCHEMA)).toEqual(['$: expected object']);
    expect(check('{"cues": []}', SCHEMA)).toEqual(['$: expected object']);
    expect(check(undefined, SCHEMA)).toEqual(['$: expected object']);
    expect(check({}, SCHEMA)).toEqual(['cues: missing']);
  });

  it('accepts everything without a schema, and ignores keywords it does not know', () => {
    expect(check({ anything: [1, 'two', null] }, undefined)).toEqual([]);
    expect(check(42, null)).toEqual([]);
    expect(check(42, {})).toEqual([]);
    expect(check(42, true)).toEqual([]);
    expect(check(42, 'object')).toEqual([]);
    expect(check('abc', { type: 'string', minLength: 10, pattern: '^\\d+$', format: 'date' })).toEqual([]);
    // A type name it does not know cannot be checked; one it knows beside it still is.
    expect(check('abc', { type: 'date' })).toEqual([]);
    expect(check(5, { type: ['date', 'string'] })).toEqual(['$: expected string']);
    // Rules for arrays and objects are not applied to other values.
    expect(check('abc', { items: { type: 'number' }, properties: { a: { type: 'number' } }, required: ['a'], maxItems: 1 })).toEqual([]);
    expect(check({ cues: [1] }, { properties: { cues: { items: 'integer' } } })).toEqual([]);
  });

  it('changes neither the value nor the schema', () => {
    const value = frozenCopy({ cues: [cue({ priority: 9, extra: true }), 'x'] });
    const schema = frozenCopy(SCHEMA);
    expect(() => check(value, schema)).not.toThrow();
    expect(check(value, schema)).toEqual(['cues[0].priority: expected at most 3', 'cues[0].extra: not expected', 'cues[1]: expected object']);
  });

  it('checks what readJson read from a reply', () => {
    const reply = '```json\n{"cues": [{"slot": "g_0001", "kind": "visual", "priority": "2", "brief": "{P1} 推开门。"}]}\n```';
    expect(check(readJson(reply), SCHEMA)).toEqual(['cues[0].priority: expected integer']);
  });
});
