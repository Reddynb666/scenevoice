// @vitest-environment jsdom
// Description languages for everyone: a browser in any real language gets
// descriptions in that language (not English because it is not in a list),
// the prompts show the model how to hedge in that language, and the text on
// the page says which language it is in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEDGE_WORDS, LANGUAGES, RTL_LANGUAGES, UNCERTAIN_LEAD } from '../src/shared/constants.js';
import { isDescriptionLanguage, resolveLanguage } from '../src/shared/storage.js';
import { buildAskRequest, cannotTellExample, hedgeExamples, languageName, scriptInstructions } from '../src/shared/gemini.js';
import { framesAskPrompt, framesRevisionPrompt } from '../src/shared/frames.js';
import { fakeChrome } from './fake-chrome.js';

const TABLE_CODES = LANGUAGES.map((l) => l.code);

describe('resolveLanguage follows any browser language the model can write', () => {
  it('returns the languages with tables of their own', () => {
    for (const code of ['it', 'nl', 'pl', 'tr', 'vi', 'th', 'id', 'bn', 'ur', 'fa', 'uk', 'sw']) {
      expect(TABLE_CODES, code).toContain(code);
      expect(resolveLanguage('auto', code)).toBe(code);
      expect(resolveLanguage('auto', `${code}-XX`), `${code}-XX`).toBe(code);
    }
    expect(resolveLanguage('auto', 'it-IT')).toBe('it');
    expect(resolveLanguage('auto', 'pt-BR')).toBe('pt');
    expect(resolveLanguage('auto', 'id_ID')).toBe('id');
  });

  it('returns any other real language by its base code', () => {
    const regions = { ms: 'ms-MY', ta: 'ta-IN', te: 'te-IN', mr: 'mr-IN', fil: 'fil-PH', sv: 'sv-SE', da: 'da-DK', fi: 'fi-FI', no: 'no', cs: 'cs-CZ', hu: 'hu-HU', ro: 'ro-RO', el: 'el-GR', he: 'he-IL' };
    for (const [code, tag] of Object.entries(regions)) {
      expect(TABLE_CODES, code).not.toContain(code);
      expect(resolveLanguage('auto', tag), tag).toBe(code);
      expect(resolveLanguage('auto', code), code).toBe(code);
    }
    // Three-letter codes and script subtags.
    expect(resolveLanguage('auto', 'yue-Hant-HK')).toBe('yue');
    expect(resolveLanguage('auto', 'sr-Latn-RS')).toBe('sr');
  });

  it('maps the old names Chrome may still give', () => {
    expect(resolveLanguage('auto', 'iw')).toBe('he');
    expect(resolveLanguage('auto', 'in-ID')).toBe('id');
    expect(resolveLanguage('auto', 'tl')).toBe('fil');
  });

  it('falls back to English only for a tag that names no language', () => {
    for (const tag of ['und', 'zxx', 'mul', 'mis', 'art', 'xx', 'qaa', 'x-private', 'i-klingon', '', null, undefined, '123', 'abcd']) {
      expect(resolveLanguage('auto', tag), String(tag)).toBe('en');
    }
  });

  it('keeps the Chinese and Bilibili rules, and a chosen language', () => {
    expect(resolveLanguage('auto', 'zh')).toBe('zh-CN');
    expect(resolveLanguage('auto', 'ZH_cn')).toBe('zh-CN');
    expect(resolveLanguage('auto', 'zh-Hant-HK')).toBe('zh-TW');
    expect(resolveLanguage('auto', 'zh-MO')).toBe('zh-TW');
    expect(resolveLanguage('auto', 'sv-SE', 'bilibili')).toBe('zh-CN');
    expect(resolveLanguage('auto', 'zh-TW', 'bilibili')).toBe('zh-TW');
    expect(resolveLanguage('sv', 'zh-CN', 'bilibili')).toBe('sv');
    expect(resolveLanguage('ja', 'sv-SE')).toBe('ja');
  });

  it('tells the service worker which languages a tab may ask for', () => {
    for (const code of [...TABLE_CODES, 'sv', 'fil', 'he', 'yue']) expect(isDescriptionLanguage(code), code).toBe(true);
    for (const code of ['xx', 'und', 'zxx', '', 'auto', 'en-US', 'EN', 42, null, undefined, '__proto__']) {
      expect(isDescriptionLanguage(code), String(code)).toBe(false);
    }
  });
});

describe('the prompts name the language and show how to hedge in it', () => {
  it('names a language without a table by its English name', () => {
    expect(languageName('zh-CN')).toBe('Simplified Chinese');
    expect(languageName('sw')).toBe('Swahili');
    expect(languageName('sv')).toBe('Swedish');
    expect(languageName('fil')).toBe('Filipino');
    expect(languageName('he')).toBe('Hebrew');
    expect(languageName('xx')).toBe('xx');
  });

  it('gives English examples, and the description language’s own from its hedging words', () => {
    expect(hedgeExamples('en')).toBe('"appears to", "possibly", "hard to see"');
    expect(hedgeExamples('fr')).toBe('"appears to", "possibly", "hard to see" (in French "semble", "peut-être", "probablement")');
    expect(hedgeExamples('zh-CN')).toBe('"appears to", "possibly", "hard to see" (in Simplified Chinese "可能", "看起来", "看不清")');
    // A language without a table: English only, never Chinese.
    expect(hedgeExamples('sv')).toBe('"appears to", "possibly", "hard to see"');
    expect(hedgeExamples(undefined)).toBe('"appears to", "possibly", "hard to see"');
    for (const code of TABLE_CODES) {
      const text = hedgeExamples(code);
      for (const w of HEDGE_WORDS[code].slice(0, 3)) expect(text, code).toContain(`"${w}"`);
    }
  });

  it('gives the "cannot tell" example in English and the description language', () => {
    expect(cannotTellExample('en')).toBe('for example "I can\'t tell from the picture"');
    expect(cannotTellExample('zh-CN')).toBe('for example "I can\'t tell from the picture", or in Simplified Chinese "不太确定。"');
    expect(cannotTellExample('fr')).toBe('for example "I can\'t tell from the picture", or in French "Ce n\'est pas sûr."');
    expect(cannotTellExample('th')).toBe('for example "I can\'t tell from the picture", or in Thai "ไม่แน่ใจ"');
    expect(cannotTellExample('sv')).toBe('for example "I can\'t tell from the picture"');
    for (const code of TABLE_CODES.filter((c) => c !== 'en')) expect(cannotTellExample(code), code).toContain(`"${UNCERTAIN_LEAD[code].trim()}"`);
  });

  it('puts them in the description, question and correction prompts', () => {
    const fr = scriptInstructions('fr');
    expect(fr).toContain('Write every description in French.');
    expect(fr).toContain('(in French "semble", "peut-être", "probablement")');
    // The hedging examples no longer come in Chinese for every language (other examples still do).
    expect(fr).not.toContain('(in Chinese "可能"');
    const en = scriptInstructions('en');
    expect(en).toContain('"appears to", "possibly", "hard to see". Leave out');
    expect(en).not.toContain('(in Chinese "可能"');
    const sv = scriptInstructions('sv');
    expect(sv).toContain('Write every description in Swedish.');
    expect(sv).not.toContain('(in ');

    const ask = buildAskRequest({ videoId: 'abcdefghijk', meta: {}, time: 30, duration: 100, question: 'What is on the table?', lang: 'de', model: 'm' });
    expect(ask.systemInstruction.parts[0].text).toContain('or in German "Nicht sicher."');
    const framesAsk = framesAskPrompt({ meta: {}, time: 30, duration: 100, question: 'Who is there?', lang: 'ja', frames: [] });
    expect(framesAsk.system).toContain('or in Japanese "はっきりしません。"');
    const revision = framesRevisionPrompt({ meta: {}, duration: 100, cue: { start: 12, standard: 'A dog.' }, lang: 'ar', frames: [] });
    expect(revision.text).toContain('(in Arabic "ربما", "يبدو", "غير واضح")');
  });
});

describe('right-to-left languages', () => {
  it('are all real languages', () => {
    expect(RTL_LANGUAGES).toEqual(['ar', 'fa', 'he', 'ur']);
    for (const code of RTL_LANGUAGES) expect(isDescriptionLanguage(code), code).toBe(true);
  });
});

describe('the page carries the description language', () => {
  let settings;

  beforeEach(() => {
    globalThis.chrome = fakeChrome().chrome;
    document.body.innerHTML = '';
    settings = { output: 'screenreader', readerSpeed: 1.6, interrupt: false, announceStatus: true, ttsRate: 1.2, ttsPitch: 1 };
    vi.resetModules();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('marks each description written to a live region with it, and status text with the interface language', async () => {
    vi.useFakeTimers();
    try {
      const { Announcer } = await import('../src/content/announcer.js');
      const a = new Announcer(() => settings);
      const filled = () => [...document.querySelectorAll('[data-scenevoice="live"]')].filter((el) => el.textContent);
      a.lang = 'ar';
      expect(a.lang).toBe('ar');
      a.say('امرأة تدخل.');
      vi.advanceTimersByTime(40);
      expect(filled().map((el) => el.getAttribute('lang'))).toEqual(['ar']);
      a.status('Descriptions loaded.');
      vi.advanceTimersByTime(100);
      expect(filled().map((el) => el.getAttribute('lang'))).toEqual(['en']);
      a.lang = '';
      expect(a.lang).toBe('en');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the text overlay and the answer to a question, with direction by content', async () => {
    // jsdom has no dialog.showModal yet.
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
    const { PageUI } = await import('../src/content/ui.js');
    const platform = { getPlayer: () => document.body, rightControls: () => null, progressPlacement: () => ({}), buttonClass: 'b' };
    const ui = new PageUI({ onToggle() {}, platform });
    expect(ui.overlay.getAttribute('dir')).toBe('auto');
    expect(ui.overlay.hasAttribute('lang')).toBe(false);
    ui.lang = 'fa';
    expect(ui.overlay.getAttribute('lang')).toBe('fa');
    ui.openAsk({ onSubmit: async () => ({ text: 'x', time: null }), onClose() {} });
    const answer = ui.root.querySelector('.answer');
    expect(answer.getAttribute('lang')).toBe('fa');
    expect(answer.getAttribute('dir')).toBe('auto');
    // The rest of the dialog stays in the interface language.
    expect(ui.root.querySelector('#sv-ask-title').hasAttribute('lang')).toBe(false);
    ui.lang = 'en';
    expect(answer.getAttribute('lang')).toBe('en');
    expect(ui.overlay.getAttribute('lang')).toBe('en');
  });
});
