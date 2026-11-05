// Usage accounting: what an answer cost, a day's counter on this computer, the
// daily limit, and the rough price shown to the listener.

import { describe, expect, it } from 'vitest';
import { DAILY_BUDGETS, DEFAULT_SETTINGS, MODEL_PRICES } from '../src/shared/constants.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { mergeFramesChunk, newFramesScript } from '../src/shared/coverage.js';
import {
  COUNTED_PROVIDERS,
  addUsage,
  budgetLabelKey,
  budgetReached,
  cleanBudget,
  costText,
  countedUsage,
  emptyDay,
  estimateCost,
  formatAmount,
  formatTokens,
  localDay,
  priceFor,
  recordUsage,
  secondsFromTokens,
  todaysUsage,
  totalSeconds,
} from '../src/shared/usage.js';

const t = (key, ...subs) => ({ money_cny: '$1 元' })[key]?.replace('$1', subs[0]) ?? key;
const noon = new Date(2026, 10, 4, 12, 0, 0);

describe('what an answer cost', () => {
  it('counts whatever the reply gave, and nothing for what it did not', () => {
    expect(countedUsage({ input: 1234, output: 56, thinking: 7 })).toEqual({ input: 1234, output: 56, thinking: 7, requests: 1 });
    expect(countedUsage({ input: 'x', output: -3 })).toEqual({ input: 0, output: 0, thinking: 0, requests: 1 });
    expect(countedUsage()).toEqual({ input: 0, output: 0, thinking: 0, requests: 1 });
  });

  it('adds usages, old scripts without one included', () => {
    const a = { input: 100, output: 10, thinking: 1, requests: 1 };
    expect(addUsage(a, a)).toEqual({ input: 200, output: 20, thinking: 2, requests: 2 });
    expect(addUsage(undefined, a)).toEqual(a);
    expect(addUsage(a, null)).toEqual(a);
    expect(addUsage('junk', { input: NaN })).toEqual({ input: 0, output: 0, thinking: 0, requests: 0 });
  });

  it('keeps a running total in a script made from frames', () => {
    const chunk = (usage) => ({ cues: [], characters: [], videoType: '', usage });
    let sc = newFramesScript({ videoId: 'bili:BV1', lang: 'zh-CN', duration: 30, platform: 'bilibili', provider: 'qwen' });
    sc = mergeFramesChunk(sc, chunk({ input: 3000, output: 200, thinking: 0, requests: 1 }), { start: 0, end: 12, duration: 30 });
    sc = mergeFramesChunk(sc, chunk(), { start: 12, end: 24, duration: 30, usage: { input: 3100, output: 150, thinking: 0, requests: 1 } });
    expect(sc.usage).toEqual({ input: 6100, output: 350, thinking: 0, requests: 2 });
    expect(sc.cues).toEqual([]);
  });
});

describe("the day's counter", () => {
  it('names the day in local time', () => {
    expect(localDay(noon)).toBe('2026-11-04');
    expect(localDay(new Date(2026, 0, 9, 0, 0, 1))).toBe('2026-01-09');
    expect(localDay('not a date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('starts fresh on a new day, and keeps the rows of the same day', () => {
    const fresh = emptyDay('2026-11-04');
    expect(Object.keys(fresh)).toEqual(['day', ...COUNTED_PROVIDERS]);
    expect(fresh.gemini).toEqual({ input: 0, output: 0, requests: 0, seconds: 0, cost: 0 });
    expect(todaysUsage(undefined, noon)).toEqual(fresh);
    expect(todaysUsage({ day: '2026-11-03', gemini: { input: 9, requests: 1, seconds: 5 } }, noon)).toEqual(fresh);
    const today = todaysUsage({ day: '2026-11-04', gemini: { input: 9, output: 'x', requests: 1, seconds: 5, cost: 0.02 }, extra: 1 }, noon);
    expect(today.gemini).toEqual({ input: 9, output: 0, requests: 1, seconds: 5, cost: 0.02 });
    expect(today.qwen).toEqual(fresh.qwen);
    expect(today).not.toHaveProperty('extra');
  });

  it('adds an answer to its provider: tokens, requests, seconds and money', () => {
    const usage = { input: 90000, output: 2000, thinking: 500, requests: 1 };
    // A section of a YouTube video: its length is known.
    let daily = recordUsage(undefined, 'gemini', usage, { model: 'gemini-2.5-flash', seconds: 300, now: noon });
    expect(daily.day).toBe('2026-11-04');
    expect(daily.gemini).toEqual({ input: 90000, output: 2500, requests: 1, seconds: 300, cost: expect.closeTo(0.03325, 6) });
    // A question: the length is estimated from the input tokens, about a hundred a second.
    daily = recordUsage(daily, 'gemini', { input: 2450, output: 50, thinking: 0, requests: 1 }, { model: 'gemini-2.5-flash', now: noon });
    expect(daily.gemini).toMatchObject({ requests: 2, seconds: 325, input: 92450 });
    expect(secondsFromTokens({ input: 2450 })).toBe(25);
    // Qwen, in yuan; an unknown model adds tokens but no money; the Cloud relay's allowance is free.
    daily = recordUsage(daily, 'qwen', { input: 3300, output: 240, thinking: 0, requests: 1 }, { model: 'qwen3-vl-plus', seconds: 12, now: noon });
    expect(daily.qwen).toEqual({ input: 3300, output: 240, requests: 1, seconds: 12, cost: expect.closeTo(0.0057, 6) });
    daily = recordUsage(daily, 'qwen', { input: 3300, output: 240, thinking: 0, requests: 1 }, { model: 'qwen-vl-max', seconds: 12, now: noon });
    expect(daily.qwen).toMatchObject({ requests: 2, cost: expect.closeTo(0.0057, 6) });
    daily = recordUsage(daily, 'cloud', usage, { model: 'gemini-3.8-flash', seconds: 300, now: noon });
    expect(daily.cloud).toEqual({ input: 90000, output: 2500, requests: 1, seconds: 300, cost: 0 });
    expect(totalSeconds(daily)).toBe(325 + 24 + 300);
    // Yesterday's counter does not carry into today, and nothing is counted for an unknown provider.
    expect(recordUsage(daily, 'gemini', usage, { now: new Date(2026, 10, 5, 8) }).gemini.requests).toBe(1);
    expect(recordUsage(daily, 'other', usage, { now: noon })).toEqual(daily);
    expect(recordUsage(daily, 'gemini', null, { now: noon })).toEqual(daily);
  });
});

describe('the daily limit', () => {
  it('is reached when the seconds described today meet it; none means never', () => {
    const daily = recordUsage(undefined, 'gemini', { input: 1, output: 1, thinking: 0, requests: 1 }, { seconds: 1800, now: noon });
    expect(budgetReached(daily, 1800)).toBe(true);
    expect(budgetReached(daily, 3600)).toBe(false);
    expect(budgetReached(daily, 0)).toBe(false);
    expect(budgetReached(daily, 'x')).toBe(false);
    expect(budgetReached(undefined, 1800)).toBe(false);
  });

  it('is a synced setting with a few choices, none by default', () => {
    expect(DEFAULT_SETTINGS.dailyBudgetSeconds).toBe(0);
    expect(DAILY_BUDGETS).toEqual([0, 1800, 3600, 7200, 14400]);
    expect(cleanBudget(3600)).toBe(3600);
    expect(cleanBudget('7200')).toBe(7200);
    expect(cleanBudget(1234)).toBe(0);
    expect(normalizeSettings({ dailyBudgetSeconds: 14400 }).dailyBudgetSeconds).toBe(14400);
    expect(normalizeSettings({ dailyBudgetSeconds: -5 }).dailyBudgetSeconds).toBe(0);
    expect(normalizeSettings({}).dailyBudgetSeconds).toBe(0);
  });

  it('names each choice', () => {
    expect(DAILY_BUDGETS.map(budgetLabelKey)).toEqual(['budget_none', 'budget_30m', 'budget_1h', 'budget_2h', 'budget_4h']);
    expect(budgetLabelKey(99)).toBe('budget_none');
  });
});

describe('the price estimate', () => {
  it('matches a model to its family by the longest prefix, and knows none for the rest', () => {
    expect(priceFor('gemini-2.5-flash-lite-preview-06-17', noon)).toMatchObject({ prefix: 'gemini-2.5-flash-lite', input: 0.1, output: 0.4 });
    expect(priceFor('gemini-2.5-flash-001', noon)).toMatchObject({ prefix: 'gemini-2.5-flash', input: 0.3 });
    expect(priceFor('gemini-3.5-flash-lite', noon)).toMatchObject({ input: 0.3, output: 2.5, currency: 'USD' });
    expect(priceFor('gemini-3.1-flash-lite', noon)).toMatchObject({ input: 0.25, output: 1.5 });
    expect(priceFor('qwen3-vl-plus', noon)).toMatchObject({ input: 1, output: 10, currency: 'CNY' });
    expect(priceFor('gemini-2.5-pro', noon)).toBeNull();
    expect(priceFor('qwen-vl-max', noon)).toBeNull();
    expect(priceFor('', noon)).toBeNull();
  });

  it('doubles Gemini 3.8 Flash from 2027-01-01', () => {
    expect(priceFor('gemini-3.8-flash', noon)).toMatchObject({ input: 0.75, output: 3.75 });
    expect(priceFor('gemini-3.8-flash', new Date(2026, 11, 31, 23, 59))).toMatchObject({ input: 0.75, output: 3.75 });
    expect(priceFor('gemini-3.8-flash', new Date(2027, 0, 1, 0, 0))).toMatchObject({ input: 1.5, output: 7.5 });
    expect(MODEL_PRICES.find((p) => p.prefix === 'gemini-3.8-flash').after).toEqual({ on: '2027-01-01', input: 1.5, output: 7.5 });
  });

  it('prices input and output, thinking as output, in the row’s currency', () => {
    const usage = { input: 1_000_000, output: 100_000, thinking: 100_000, requests: 3 };
    expect(estimateCost('gemini-3.8-flash', usage, noon)).toEqual({ amount: expect.closeTo(0.75 + 0.75, 6), currency: 'USD' });
    expect(estimateCost('qwen3-vl-plus', usage, noon)).toEqual({ amount: expect.closeTo(1 + 2, 6), currency: 'CNY' });
    expect(estimateCost('gemini-2.5-pro', usage, noon)).toBeNull();
    expect(estimateCost('gemini-2.5-flash', undefined, noon)).toEqual({ amount: 0, currency: 'USD' });
  });

  it('puts an amount into words, never as nothing when something was spent', () => {
    expect(formatAmount({ amount: 0.03325, currency: 'USD' })).toBe('0.03');
    expect(formatAmount({ amount: 0.0001, currency: 'USD' })).toBe('0.01');
    expect(formatAmount({ amount: 0, currency: 'USD' })).toBe('0.00');
    expect(formatAmount({ amount: 0.17, currency: 'CNY' })).toBe('0.2');
    expect(formatAmount({ amount: 0.0057, currency: 'CNY' })).toBe('0.1');
    expect(costText({ amount: 0.03325, currency: 'USD' }, t)).toBe('$0.03');
    expect(costText({ amount: 0.17, currency: 'CNY' }, t)).toBe('0.2 元');
    expect(costText(null, t)).toBe('');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(92450)).toBe('92k');
    expect(formatTokens(2_340_000)).toBe('2.3M');
  });
});
