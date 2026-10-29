import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DETAILS, MODES, MSG, READER_SPEEDS, TTS_RATE, VOICE_SAMPLES, LANGUAGES } from '../src/shared/constants.js';
import {
  markChoices,
  nearestReaderSpeed,
  nextValue,
  normalizeSettings,
  stepSpeed,
  voiceFor,
  voicePatch,
  voiceTestMessage,
} from '../src/shared/settings.js';
import { getSettings, resetSettings, setSettings, watchSettings } from '../src/shared/storage.js';
import { fakeChrome } from './fake-chrome.js';

describe('normalizeSettings', () => {
  it('fills in every default', () => {
    expect(normalizeSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS, ttsVoices: {} });
    expect(normalizeSettings({})).toEqual(normalizeSettings(null));
    expect(normalizeSettings([])).toEqual(normalizeSettings({}));
  });

  it('keeps valid values', () => {
    const s = normalizeSettings({
      mode: 'pause',
      detail: 'detailed',
      density: 'full',
      language: 'zh-CN',
      output: 'tts',
      ttsRate: 2.3,
      ttsPitch: 0.8,
      readerSpeed: 2.4,
      ttsVoices: { 'zh-CN': 'Tingting', en: '' },
      duckLevel: 0.5,
      enabled: false,
    });
    expect(s).toMatchObject({ mode: 'pause', detail: 'detailed', density: 'full', language: 'zh-CN', output: 'tts', ttsRate: 2.3, ttsPitch: 0.8, readerSpeed: 2.4, duckLevel: 0.5, enabled: false });
    expect(s.ttsVoices).toEqual({ 'zh-CN': 'Tingting', en: '' });
  });

  it('replaces unknown choices and wrong types with the default', () => {
    const s = normalizeSettings({ mode: 'loud', detail: 7, output: 'speakers', language: 'xx', enabled: 'yes', showText: 1, ttsVoice: 42 });
    expect(s.mode).toBe(DEFAULT_SETTINGS.mode);
    expect(s.detail).toBe(DEFAULT_SETTINGS.detail);
    expect(s.output).toBe(DEFAULT_SETTINGS.output);
    expect(s.language).toBe('auto');
    expect(s.enabled).toBe(true);
    expect(s.showText).toBe(false);
    expect(s.ttsVoice).toBe('');
  });

  it('clamps numbers into the range the controls offer', () => {
    expect(normalizeSettings({ ttsRate: 9 }).ttsRate).toBe(TTS_RATE.max);
    expect(normalizeSettings({ ttsRate: 0.1 }).ttsRate).toBe(TTS_RATE.min);
    expect(normalizeSettings({ ttsRate: 'fast' }).ttsRate).toBe(DEFAULT_SETTINGS.ttsRate);
    expect(normalizeSettings({ ttsRate: '1.5' }).ttsRate).toBe(1.5);
    expect(normalizeSettings({ ttsRate: Infinity }).ttsRate).toBe(DEFAULT_SETTINGS.ttsRate);
    expect(normalizeSettings({ ttsPitch: 5 }).ttsPitch).toBe(1.5);
    expect(normalizeSettings({ ttsPitch: -1 }).ttsPitch).toBe(0.5);
    expect(normalizeSettings({ duckLevel: 2 }).duckLevel).toBe(0.9);
    expect(normalizeSettings({ ttsRate: 1.2000000000000002 }).ttsRate).toBe(1.2);
  });

  it('snaps the screen reader speed to a listed choice, so the list always shows one', () => {
    expect(normalizeSettings({ readerSpeed: 2 }).readerSpeed).toBe(1.6);
    expect(normalizeSettings({ readerSpeed: 99 }).readerSpeed).toBe(3.2);
    expect(normalizeSettings({ readerSpeed: 'x' }).readerSpeed).toBe(DEFAULT_SETTINGS.readerSpeed);
    for (const s of READER_SPEEDS) expect(nearestReaderSpeed(s)).toBe(s);
  });

  it('keeps only voices for known languages, as strings', () => {
    const s = normalizeSettings({ ttsVoices: { 'zh-CN': 'Tingting', klingon: 'Worf', en: 5, fr: 'x'.repeat(500) } });
    expect(s.ttsVoices).toEqual({ 'zh-CN': 'Tingting' });
    expect(normalizeSettings({ ttsVoices: ['a'] }).ttsVoices).toEqual({});
  });

  it('never returns the frozen defaults object for voices', () => {
    const s = normalizeSettings({});
    expect(Object.isFrozen(s.ttsVoices)).toBe(false);
  });
});

describe('video type settings', () => {
  it('adjusts to the video type by default, with nothing chosen by the user', () => {
    expect(normalizeSettings({})).toMatchObject({
      autoByType: true,
      modeChosen: false,
      detailChosen: false,
      entertainmentMode: 'gaps',
      entertainmentDetail: 'brief',
      tutorialMode: 'pause',
      tutorialDetail: 'detailed',
    });
  });

  it('keeps valid choices for each type and replaces bad ones', () => {
    expect(normalizeSettings({ tutorialMode: 'manual', entertainmentDetail: 'standard', autoByType: false })).toMatchObject({ tutorialMode: 'manual', entertainmentDetail: 'standard', autoByType: false });
    const bad = normalizeSettings({ tutorialMode: 'loud', tutorialDetail: 3, entertainmentMode: null, autoByType: 'no', modeChosen: 1 });
    expect(bad).toMatchObject({ tutorialMode: 'pause', tutorialDetail: 'detailed', entertainmentMode: 'gaps', autoByType: true, modeChosen: false });
  });

  it('treats a mode or detail saved before this version as chosen, unless it is the default', () => {
    expect(normalizeSettings({ mode: 'manual', detail: 'standard' })).toMatchObject({ modeChosen: true, detailChosen: false });
    expect(normalizeSettings({ mode: 'gaps', detail: 'detailed' })).toMatchObject({ modeChosen: false, detailChosen: true });
    expect(normalizeSettings({ mode: 'bogus' }).modeChosen).toBe(false);
    // Once the flags are saved they are taken as they are.
    expect(normalizeSettings({ mode: 'manual', modeChosen: false }).modeChosen).toBe(false);
    expect(normalizeSettings({ mode: 'gaps', modeChosen: true }).modeChosen).toBe(true);
  });

  it('marks a saved mode or detail as the user\'s own', () => {
    expect(markChoices({ mode: 'pause' })).toEqual({ mode: 'pause', modeChosen: true });
    expect(markChoices({ detail: 'brief', density: 'full' })).toEqual({ detail: 'brief', density: 'full', detailChosen: true });
    expect(markChoices({ density: 'full' })).toEqual({ density: 'full' });
    expect(markChoices({ tutorialMode: 'manual' })).toEqual({ tutorialMode: 'manual' });
    // "Let the video type decide again" clears the flags without choosing a value.
    expect(markChoices({ modeChosen: false, detailChosen: false })).toEqual({ modeChosen: false, detailChosen: false });
  });
});

describe('shortcut steps', () => {
  it('cycles through choices and wraps round', () => {
    expect(nextValue(DETAILS, 'brief')).toBe('standard');
    expect(nextValue(DETAILS, 'detailed')).toBe('brief');
    expect(nextValue(MODES, 'manual')).toBe('gaps');
    expect(nextValue(MODES, 'nonsense')).toBe('gaps');
  });

  it('changes the built-in voice rate one slider step at a time, within its range', () => {
    const tts = { ...DEFAULT_SETTINGS, output: 'tts', ttsRate: 1.2 };
    expect(stepSpeed(tts, 1)).toEqual({ key: 'ttsRate', value: 1.3, atLimit: false });
    expect(stepSpeed(tts, -1)).toEqual({ key: 'ttsRate', value: 1.1, atLimit: false });
    expect(stepSpeed({ ...tts, ttsRate: 3 }, 1)).toEqual({ key: 'ttsRate', value: 3, atLimit: true });
    expect(stepSpeed({ ...tts, ttsRate: 0.6 }, -1)).toEqual({ key: 'ttsRate', value: 0.6, atLimit: true });
    // Ten presses from 1.2 land exactly on 2.2, not 2.1999999.
    let s = tts;
    for (let i = 0; i < 10; i += 1) s = { ...s, ttsRate: stepSpeed(s, 1).value };
    expect(s.ttsRate).toBe(2.2);
  });

  it('moves the screen reader speed between the listed choices', () => {
    const sr = { ...DEFAULT_SETTINGS, output: 'screenreader', readerSpeed: 1.6 };
    expect(stepSpeed(sr, 1)).toEqual({ key: 'readerSpeed', value: 2.4, atLimit: false });
    expect(stepSpeed(sr, -1)).toEqual({ key: 'readerSpeed', value: 1, atLimit: false });
    expect(stepSpeed({ ...sr, readerSpeed: 3.2 }, 1)).toEqual({ key: 'readerSpeed', value: 3.2, atLimit: true });
    expect(stepSpeed({ ...sr, readerSpeed: 1 }, -1)).toEqual({ key: 'readerSpeed', value: 1, atLimit: true });
  });
});

describe('voice for a description language', () => {
  it('uses the voice chosen for that language, as chosen', () => {
    const s = { ...DEFAULT_SETTINGS, ttsVoices: { 'zh-CN': 'Tingting', en: '' }, ttsVoice: 'Samantha' };
    expect(voiceFor(s, 'zh-CN')).toEqual({ voice: 'Tingting', voiceMustMatch: false });
    // "Automatic" chosen for English overrides the old single voice.
    expect(voiceFor(s, 'en')).toEqual({ voice: '', voiceMustMatch: false });
  });

  it('falls back to the old single voice only where it speaks the language', () => {
    const s = { ...DEFAULT_SETTINGS, ttsVoice: 'Samantha' };
    expect(voiceFor(s, 'fr')).toEqual({ voice: 'Samantha', voiceMustMatch: true });
    expect(voiceFor(DEFAULT_SETTINGS, 'fr')).toEqual({ voice: '', voiceMustMatch: false });
  });

  it('changes one language without touching the others', () => {
    const s = { ...DEFAULT_SETTINGS, ttsVoices: { en: 'Samantha' } };
    expect(voicePatch(s, 'zh-CN', 'Tingting')).toEqual({ ttsVoices: { en: 'Samantha', 'zh-CN': 'Tingting' } });
    expect(s.ttsVoices).toEqual({ en: 'Samantha' });
    expect(voicePatch(DEFAULT_SETTINGS, 'en', '')).toEqual({ ttsVoices: { en: '' } });
  });

  it('tests the voice with a sample in the description language, at the chosen rate and pitch', () => {
    const s = { ...DEFAULT_SETTINGS, ttsRate: 1.8, ttsPitch: 0.7, ttsVoices: { 'zh-CN': 'Tingting' } };
    expect(voiceTestMessage(s, 'zh-CN')).toEqual({
      type: MSG.SPEAK,
      text: '一位穿红色大衣的女人走过积雪的街道。',
      lang: 'zh-CN',
      rate: 1.8,
      pitch: 0.7,
      voice: 'Tingting',
      voiceMustMatch: false,
      id: 'test',
    });
    expect(voiceTestMessage(s, 'xx').text).toBe(VOICE_SAMPLES.en);
  });

  it('has a test sentence for every description language', () => {
    for (const { code } of LANGUAGES) expect(VOICE_SAMPLES[code], code).toBeTruthy();
  });
});

describe('settings storage', () => {
  let fake;

  beforeEach(() => {
    fake = fakeChrome({
      sync: { settings: { mode: 'pause', ttsRate: 2, futureOption: 'kept' } },
      local: { local: { apiKey: 'secret-key', model: 'gemini-2.5-flash' }, 'script:abcdefghijk:en': { cues: [] } },
    });
    globalThis.chrome = fake.chrome;
  });

  it('reads stored settings over the defaults', async () => {
    const s = await getSettings();
    expect(s.mode).toBe('pause');
    expect(s.ttsRate).toBe(2);
    expect(s.ttsPitch).toBe(1);
    expect(s).not.toHaveProperty('futureOption');
  });

  it('saves to sync storage only, keeps settings a newer version wrote, and never stores bad values', async () => {
    const next = await setSettings({ ttsPitch: 1.3, detail: 'bogus' });
    expect(next.ttsPitch).toBe(1.3);
    expect(next.detail).toBe('standard');
    expect(fake.areas.sync.settings).toMatchObject({ mode: 'pause', ttsPitch: 1.3, detail: 'standard', futureOption: 'kept' });
    expect(fake.areas.local.settings).toBeUndefined();
    expect(JSON.stringify(fake.areas.sync)).not.toContain('secret-key');
  });

  it('remembers that the user chose a mode or detail, until the type may decide again or defaults are restored', async () => {
    await setSettings({ density: 'full', tutorialMode: 'manual' });
    expect(fake.areas.sync.settings).toMatchObject({ modeChosen: true, detailChosen: false, tutorialMode: 'manual' });
    await setSettings({ detail: 'brief' });
    expect(fake.areas.sync.settings).toMatchObject({ modeChosen: true, detailChosen: true });
    await setSettings({ modeChosen: false, detailChosen: false });
    expect(fake.areas.sync.settings).toMatchObject({ mode: 'pause', detail: 'brief', modeChosen: false, detailChosen: false });
    await setSettings({ detail: 'standard' });
    expect(await resetSettings()).toMatchObject({ modeChosen: false, detailChosen: false, autoByType: true });
  });

  it('restores the defaults without touching the key, the model or saved descriptions', async () => {
    const before = JSON.stringify(fake.areas.local);
    const s = await resetSettings();
    expect(s).toEqual(normalizeSettings({}));
    expect(fake.areas.sync.settings).toBeUndefined();
    expect(JSON.stringify(fake.areas.local)).toBe(before);
    expect((await getSettings()).mode).toBe(DEFAULT_SETTINGS.mode);
  });

  it('tells watchers about a reset with complete default settings', async () => {
    const seen = [];
    watchSettings((s) => seen.push(s));
    await new Promise((r) => setTimeout(r, 5));
    await resetSettings();
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.at(0).mode).toBe('pause');
    expect(seen.at(-1)).toEqual(normalizeSettings({}));
  });

  it('cleans settings that arrive through a change event', async () => {
    const seen = [];
    watchSettings((s) => seen.push(s));
    await chrome.storage.sync.set({ settings: { ttsRate: 40, mode: 'gaps', ttsVoices: { en: 'Samantha', zz: 'x' } } });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.at(-1)).toMatchObject({ ttsRate: 3, mode: 'gaps', ttsVoices: { en: 'Samantha' } });
  });
});
