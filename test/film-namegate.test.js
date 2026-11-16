// The name gate of the film engine (src/film/namegate.js): when a name may be
// spoken, which words each character token becomes (label, introduction,
// re-anchoring, name) in Chinese and English, how the forms sit in a sentence,
// what waits for a longer pause, what is never spoken, and the two texts
// outside the script: the introduction before the film and "who is on screen".
import { describe, expect, it } from 'vitest';
import { addCharacter, addEvidence, confirmName, createCast, neverName, rejectName, setAppearance, updateCharacter } from '../src/film/cast.js';
import { castIntro, hasResidue, renderScript, unlocked, whoIsOnScreen } from '../src/film/namegate.js';
import { DEFAULT_POLICY } from '../src/film/types.js';
import { toPlayerScript } from '../src/film/filmscript.js';
import { chooseUtterance, estimateSeconds } from '../src/shared/script.js';

const MATTHEW = { name: '马修', level: 3, descriptor: { zh: '长发女人', en: 'woman with long hair' }, main: true, screenSec: 900 };
const CHEN = { name: '老陈', level: 3, descriptor: { zh: '戴眼镜的男人', en: 'man with glasses' }, main: true, screenSec: 600 };
const STRANGER = { descriptor: { zh: '灰大衣男人', en: 'man in the grey coat' } };
const MATTHEW_EN = { ...MATTHEW, name: 'Matthew' };
const CHEN_EN = { ...CHEN, name: 'Chen' };

/** A cast with one character per entry (P1, P2, …) and outfits as [id, from, outfit]. */
function castWith(people, { policy, outfits = [] } = {}) {
  let cast = createCast({ policy });
  for (const fields of people) ({ cast } = addCharacter(cast, fields));
  for (const [char, from, outfit] of outfits) cast = setAppearance(cast, { char, from, outfit, src: 'model' });
  return cast;
}

/** A cue as filmscript.js stores it. One text stands for all three versions. No slot: no room to measure. */
function cue(id, start, text, extra = {}) {
  const versions = typeof text === 'string' ? { brief: text, standard: text, detailed: text } : text;
  return { id, slot: null, start, end: start + 3, kind: 'visual', priority: 2, ...versions, people: [], status: 'ai', by: 'ai', ...extra };
}

const film = (lang, cues, slots = []) => ({ v: 3, filmId: 'film', lang, duration: 7200, slots, cues, scenes: [] });

/** Render lines given as [start, text, extra?]; the cues are q1, q2, … in the order given. */
function say(cast, lang, lines, policy, options) {
  return renderScript(film(lang, lines.map(([start, text, extra], i) => cue(`q${i + 1}`, start, text, extra))), cast, policy, options);
}

const standards = (result) => result.cues.map((c) => c.standard);
const forms = (result) => result.cues.map((c) => c.forms);

/** Freeze a value all the way down: a function that changes its argument then throws. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

describe('unlocked', () => {
  const sure = { id: 'P1', name: '马修', level: 3, revealAt: null, spoilerLock: false, neverName: false };

  it('lets a confirmed name through under the default policy', () => {
    expect(unlocked(sure, 0, DEFAULT_POLICY)).toBe(true);
    expect(unlocked(sure, 5000, DEFAULT_POLICY)).toBe(true);
  });

  it('is false without a name', () => {
    expect(unlocked({ ...sure, name: null }, 0, DEFAULT_POLICY)).toBe(false);
    expect(unlocked({ ...sure, name: '' }, 0, DEFAULT_POLICY)).toBe(false);
    expect(unlocked({ ...sure, name: '   ' }, 0, DEFAULT_POLICY)).toBe(false);
  });

  it('is false below the level the policy asks for', () => {
    expect(unlocked({ ...sure, level: 2 }, 0, DEFAULT_POLICY)).toBe(false);
    expect(unlocked({ ...sure, level: 2 }, 0, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(true);
    expect(unlocked({ ...sure, level: 1 }, 0, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(false);
    expect(unlocked({ ...sure, level: 0 }, 0, { ...DEFAULT_POLICY, minLevel: 2 })).toBe(false);
    expect(unlocked({ ...sure, level: undefined }, 0, DEFAULT_POLICY)).toBe(false);
  });

  it('never accepts a level below two clues, whatever the policy says', () => {
    expect(unlocked({ ...sure, level: 1 }, 0, { ...DEFAULT_POLICY, minLevel: 1 })).toBe(false);
    expect(unlocked({ ...sure, level: 2 }, 0, { ...DEFAULT_POLICY, minLevel: 0 })).toBe(false);
  });

  it('is false for a character a person asked never to name', () => {
    expect(unlocked({ ...sure, neverName: true }, 0, DEFAULT_POLICY)).toBe(false);
  });

  it('is false when the picture did not confirm the character in the cue', () => {
    expect(unlocked(sure, 0, DEFAULT_POLICY, { demoted: true })).toBe(false);
    expect(unlocked(sure, 0, DEFAULT_POLICY, { demoted: false })).toBe(true);
    expect(unlocked(sure, 0, DEFAULT_POLICY, {})).toBe(true);
  });

  it('keeps a plot secret until its reveal point, and for ever when it has none', () => {
    expect(unlocked({ ...sure, spoilerLock: true }, 9999, DEFAULT_POLICY)).toBe(false);
    const secret = { ...sure, spoilerLock: true, revealAt: 100 };
    expect(unlocked(secret, 99.9, DEFAULT_POLICY)).toBe(false);
    expect(unlocked(secret, 100, DEFAULT_POLICY)).toBe(true);
    expect(unlocked(secret, 101, DEFAULT_POLICY)).toBe(true);
  });

  it('waits for the reveal point under on-reveal, and only when there is one', () => {
    const onReveal = { ...DEFAULT_POLICY, naming: 'on-reveal' };
    expect(unlocked({ ...sure, revealAt: 100 }, 99, onReveal)).toBe(false);
    expect(unlocked({ ...sure, revealAt: 100 }, 100, onReveal)).toBe(true);
    expect(unlocked(sure, 0, onReveal)).toBe(true);
  });

  it('does not wait for the reveal point under first-appearance', () => {
    expect(unlocked({ ...sure, revealAt: 100 }, 0, DEFAULT_POLICY)).toBe(true);
  });

  it('takes the default policy for what the given one lacks', () => {
    expect(unlocked(sure, 0)).toBe(true);
    expect(unlocked({ ...sure, level: 2 }, 0)).toBe(false);
    expect(unlocked({ ...sure, level: 2 }, 0, { minLevel: 2 })).toBe(true);
    expect(unlocked({ ...sure, revealAt: 100 }, 0, { naming: 'on-reveal' })).toBe(false);
    expect(unlocked({ ...sure, revealAt: 100 }, 0, { naming: 'whenever' })).toBe(true);
  });

  it('unlocks nothing without a character or a time', () => {
    expect(unlocked(null, 0, DEFAULT_POLICY)).toBe(false);
    expect(unlocked(undefined, 0, DEFAULT_POLICY)).toBe(false);
    expect(unlocked('P1', 0, DEFAULT_POLICY)).toBe(false);
    expect(unlocked(sure, undefined, DEFAULT_POLICY)).toBe(false);
    expect(unlocked(sure, NaN, DEFAULT_POLICY)).toBe(false);
    expect(unlocked(sure, '10', DEFAULT_POLICY)).toBe(false);
  });

  it('does not change its arguments', () => {
    expect(unlocked(deepFreeze({ ...sure }), 0, deepFreeze({ ...DEFAULT_POLICY }), deepFreeze({ demoted: false }))).toBe(true);
  });
});

describe('renderScript: the forms in Chinese', () => {
  it('introduces at the first appearance with name, label and outfit, then uses the name', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [20, '{P1}坐下。']]);
    expect(standards(out)).toEqual(['马修，长发女人，穿着红裙子，走到窗边。', '马修坐下。']);
    expect(forms(out)).toEqual([{ P1: 'intro' }, { P1: 'name' }]);
    expect(out.report).toEqual({ introducedAt: { P1: 'q1' }, deferred: [], silenced: [] });
  });

  it('introduces without an outfit part when no appearance is current at the cue', () => {
    const none = say(castWith([MATTHEW]), 'zh-CN', [[10, '{P1}走到窗边。']]);
    expect(standards(none)).toEqual(['马修，长发女人，走到窗边。']);
    // An outfit that starts later, or one that already ended, is not current.
    const later = say(castWith([MATTHEW], { outfits: [['P1', 50, '红裙子']] }), 'zh-CN', [[10, '{P1}走到窗边。']]);
    expect(standards(later)).toEqual(['马修，长发女人，走到窗边。']);
  });

  it('uses the label for a character without a name', () => {
    const out = say(castWith([MATTHEW, CHEN, STRANGER]), 'zh-CN', [[10, '{P3}走进来。'], [20, '门开了，{P3}站在门口。']]);
    expect(standards(out)).toEqual(['灰大衣男人走进来。', '门开了，灰大衣男人站在门口。']);
    expect(forms(out)).toEqual([{ P3: 'label' }, { P3: 'label' }]);
    expect(out.report.introducedAt).toEqual({});
  });

  it('says the outfit with the label once, and again only when it changed', () => {
    const cast = castWith([STRANGER], { outfits: [['P1', 0, '黑帽子'], ['P1', 300, '白衬衫']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走进来。'], [20, '{P1}坐下。'], [310, '{P1}站起来。'], [320, '{P1}离开。']]);
    expect(standards(out)).toEqual(['灰大衣男人，穿着黑帽子，走进来。', '灰大衣男人坐下。', '灰大衣男人，穿着白衬衫，站起来。', '灰大衣男人离开。']);
    expect(forms(out)).toEqual([{ P1: 'label-outfit' }, { P1: 'label' }, { P1: 'label-outfit' }, { P1: 'label' }]);
  });

  it('on-reveal: label until the reveal point, then label and name once, then the name', () => {
    const cast = castWith([{ ...MATTHEW, revealAt: 100 }], { policy: { naming: 'on-reveal' }, outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [50, '{P1}坐下。'], [120, '{P1}站起来。'], [130, '{P1}离开。']]);
    expect(standards(out)).toEqual(['长发女人，穿着红裙子，走到窗边。', '长发女人坐下。', '长发女人，马修，站起来。', '马修离开。']);
    expect(forms(out)).toEqual([{ P1: 'label-outfit' }, { P1: 'label' }, { P1: 'intro' }, { P1: 'name' }]);
    expect(out.report.introducedAt).toEqual({ P1: 'q3' });
  });

  it('on-reveal without a reveal point introduces at the first mention, label first', () => {
    const out = say(castWith([MATTHEW], { policy: { naming: 'on-reveal' } }), 'zh-CN', [[10, '{P1}走到窗边。'], [20, '{P1}坐下。']]);
    expect(standards(out)).toEqual(['长发女人，马修，走到窗边。', '马修坐下。']);
    expect(forms(out)).toEqual([{ P1: 'intro' }, { P1: 'name' }]);
  });

  it('on-reveal says an outfit in the introduction only when the listener has not heard it', () => {
    const cast = castWith([MATTHEW], { policy: { naming: 'on-reveal' }, outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [20, '{P1}坐下。']]);
    expect(standards(out)).toEqual(['长发女人，穿着红裙子，马修，走到窗边。', '马修坐下。']);
  });

  it('re-anchors with the new outfit after a change of clothes', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子'], ['P1', 500, '灰大衣']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [600, '{P1}走出门。'], [610, '{P1}上车。']]);
    expect(standards(out)).toEqual(['马修，长发女人，穿着红裙子，走到窗边。', '马修，换了灰大衣，走出门。', '马修上车。']);
    expect(forms(out)).toEqual([{ P1: 'intro' }, { P1: 'reanchor' }, { P1: 'name' }]);
  });

  it('re-anchors with the label after a long absence', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [1210, '{P1}回来了。'], [1220, '{P1}坐下。']]);
    expect(standards(out)).toEqual(['马修，长发女人，穿着红裙子，走到窗边。', '马修，长发女人，回来了。', '马修坐下。']);
    expect(forms(out)).toEqual([{ P1: 'intro' }, { P1: 'reanchor' }, { P1: 'name' }]);
  });

  it('counts the absence from the last mention, and reanchorAfterSec is the boundary', () => {
    const cast = castWith([MATTHEW]);
    const justShort = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [1209.9, '{P1}回来了。']]);
    expect(standards(justShort)[1]).toBe('马修回来了。');
    // Mentioned at 700, so 1300 is only 600 seconds later.
    const between = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [700, '{P1}经过。'], [1300, '{P1}回来了。']]);
    expect(standards(between)[2]).toBe('马修回来了。');
    const shorter = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [400, '{P1}回来了。']], { reanchorAfterSec: 300 });
    expect(standards(shorter)[1]).toBe('马修，长发女人，回来了。');
    const off = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [5000, '{P1}回来了。']], { reanchorAfterSec: 0 });
    expect(standards(off)[1]).toBe('马修回来了。');
  });

  it('says both the label and the new outfit when a character is back after long in other clothes', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子'], ['P1', 900, '灰大衣']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [2000, '{P1}回来了。']]);
    expect(standards(out)[1]).toBe('马修，长发女人，换了灰大衣，回来了。');
    expect(out.cues[1].forms).toEqual({ P1: 'reanchor' });
  });

  it('does not call an outfit a change when none was said before', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 500, '灰大衣']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [600, '{P1}走出门。'], [610, '{P1}上车。']]);
    expect(standards(out)).toEqual(['马修，长发女人，走到窗边。', '马修，穿着灰大衣，走出门。', '马修上车。']);
    expect(out.cues[1].forms).toEqual({ P1: 'reanchor' });
  });

  it('keeps the outfit last said while none is current: the same outfit coming back is not news', () => {
    let cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    // The red dress ends at 100 and nothing is known until 500.
    cast = { ...cast, appearances: [{ ...cast.appearances[0], to: 100 }, { char: 'P1', from: 500, to: null, outfit: '红裙子', src: 'model' }] };
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [200, '{P1}坐下。'], [600, '{P1}站起来。']]);
    expect(standards(out)).toEqual(['马修，长发女人，穿着红裙子，走到窗边。', '马修坐下。', '马修站起来。']);
  });

  it('compares outfits without regard to case, width and spacing, and drops a verb a model put in front', () => {
    let cast = castWith([STRANGER], { outfits: [['P1', 0, '穿着黑帽子。']] });
    cast = { ...cast, appearances: [{ ...cast.appearances[0], to: 100 }, { char: 'P1', from: 100, to: null, outfit: ' 黑帽子 ', src: 'human' }] };
    const out = say(cast, 'zh-CN', [[10, '{P1}走进来。'], [200, '{P1}坐下。']]);
    expect(standards(out)).toEqual(['灰大衣男人，穿着黑帽子，走进来。', '灰大衣男人坐下。']);

    const english = { v: 1, policy: { ...DEFAULT_POLICY }, characters: [{ id: 'P1', name: null, level: 0, descriptor: { en: 'man in the grey coat' } }], appearances: [
      { char: 'P1', from: 0, to: 100, outfit: 'Wearing a  Black Hat.', src: 'model' },
      { char: 'P1', from: 100, to: 200, outfit: 'a black hat', src: 'model' },
      { char: 'P1', from: 200, to: 300, outfit: 'ａ ｂｌａｃｋ ｈａｔ', src: 'model' },
      { char: 'P1', from: 300, to: null, outfit: 'in a white shirt', src: 'model' },
    ] };
    const en = say(english, 'en', [[10, 'Then {P1} enters.'], [150, 'Then {P1} sits.'], [250, 'Then {P1} waits.'], [350, 'Then {P1} stands.']]);
    expect(standards(en)).toEqual(['Then the man in the grey coat, in a Black Hat, enters.', 'Then the man in the grey coat sits.', 'Then the man in the grey coat waits.', 'Then the man in the grey coat, in a white shirt, stands.']);
  });
});

describe('renderScript: labels and outfits as they were stored', () => {
  // The cast stores a label or an outfit as it was written; the forms bring their own verb, article and punctuation.
  const stored = (lang, descriptor, outfit, text) => {
    const cast = { v: 1, policy: { ...DEFAULT_POLICY }, characters: [{ id: 'P1', name: null, level: 0, descriptor }], appearances: outfit ? [{ char: 'P1', from: 0, to: null, outfit, src: 'model' }] : [] };
    return standards(say(cast, lang, [[10, text]]))[0];
  };

  it('drops a bare 穿, 穿了 or 穿上 a model wrote in front of an outfit, and not the 穿 of a noun', () => {
    expect(stored('zh-CN', { zh: '长发女人' }, '穿红裙子', '{P1}在等。')).toBe('长发女人，穿着红裙子，在等。');
    expect(stored('zh-CN', { zh: '长发女人' }, '穿了红裙子。', '{P1}在等。')).toBe('长发女人，穿着红裙子，在等。');
    expect(stored('zh-CN', { zh: '长发女人' }, '穿上红裙子', '{P1}在等。')).toBe('长发女人，穿着红裙子，在等。');
    expect(stored('zh-CN', { zh: '长发女人' }, '身穿红裙子，', '{P1}在等。')).toBe('长发女人，穿着红裙子，在等。');
    expect(stored('zh-CN', { zh: '长发女人' }, '穿山甲图案的T恤', '{P1}在等。')).toBe('长发女人，穿着穿山甲图案的T恤，在等。');
    expect(stored('zh-CN', { zh: '长发女人' }, '穿孔皮鞋', '{P1}在等。')).toBe('长发女人，穿着穿孔皮鞋，在等。');
  });

  it('writes the article of an English outfit in lower case, and leaves a proper noun alone', () => {
    expect(stored('en', { en: 'woman with long hair' }, 'A red dress', '{P1} waits.')).toBe('The woman with long hair, in a red dress, waits.');
    expect(stored('en', { en: 'woman with long hair' }, 'Wearing An orange scarf.', '{P1} waits.')).toBe('The woman with long hair, in an orange scarf, waits.');
    expect(stored('en', { en: 'woman with long hair' }, 'The same red dress', '{P1} waits.')).toBe('The woman with long hair, in the same red dress, waits.');
    expect(stored('en', { en: 'woman with long hair' }, 'Adidas tracksuit', '{P1} waits.')).toBe('The woman with long hair, in Adidas tracksuit, waits.');
    expect(stored('en', { en: 'woman with long hair' }, 'Armani suit', '{P1} waits.')).toBe('The woman with long hair, in Armani suit, waits.');
  });

  it('drops punctuation a label ends in: the form or the sentence has its own', () => {
    expect(stored('en', { en: 'woman with long hair.' }, 'a red dress', 'A dog runs to {P1}.')).toBe('A dog runs to the woman with long hair, in a red dress.');
    expect(stored('en', { en: 'woman with long hair.' }, '', 'A dog runs to {P1}.')).toBe('A dog runs to the woman with long hair.');
    expect(stored('en', { en: 'The woman with long hair, ' }, '', '{P1} waits.')).toBe('The woman with long hair waits.');
    expect(stored('zh-CN', { zh: '长发女人。' }, '红裙子', '狗跑向{P1}。')).toBe('狗跑向长发女人，穿着红裙子。');
    expect(stored('zh-CN', { zh: '长发女人。' }, '', '狗跑向{P1}。')).toBe('狗跑向长发女人。');
    expect(stored('zh-CN', { zh: '长发女人，' }, '', '{P1}在等。')).toBe('长发女人在等。');
    // In the other texts made from a label too.
    const cast = { characters: [{ id: 'P1', name: 'Matthew', level: 3, main: true, descriptor: { en: 'woman with long hair.', zh: '长发女人。' } }, { id: 'P2', descriptor: { en: 'man in the grey coat.', zh: '灰大衣男人。' } }] };
    expect(castIntro(cast, undefined, { lang: 'en' })).toBe('Main characters: Matthew, a woman with long hair.');
    expect(castIntro(cast, undefined, { lang: 'zh' })).toBe('主要人物：Matthew，长发女人。');
    expect(whoIsOnScreen(['P2'], cast, undefined, 5, { lang: 'en' })).toBe('On screen: the man in the grey coat.');
    expect(whoIsOnScreen(['P2'], cast, undefined, 5, { lang: 'zh' })).toBe('画面里：灰大衣男人。');
  });
});

describe('renderScript: an outfit that must not be said', () => {
  const lines = [[10, '{P1} sits.'], [20, '{P1} stands.'], [30, '{P1} leaves.']];

  it('does not say an outfit that holds a cast name, whatever the level of the name', () => {
    let cast = castWith([{ descriptor: { zh: '长发女人' } }, { descriptor: { zh: '戴眼镜的男人' } }]);
    cast = addEvidence(cast, 'P2', { t: 5, kind: 'vocative', name: '老陈' });
    cast = setAppearance(cast, { char: 'P1', from: 0, outfit: '老陈的灰大衣', src: 'model' });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [20, '{P1}坐下。']]);
    expect(standards(out)).toEqual(['长发女人走到窗边。', '长发女人坐下。']);
    expect(forms(out)).toEqual([{ P1: 'label' }, { P1: 'label' }]);
    expect(JSON.stringify(out)).not.toContain('老陈');
    // A name learned after the outfit was stored, and one a person refused, are names all the same.
    let later = castWith([{ descriptor: { en: 'woman with long hair' } }, { descriptor: { en: 'man with glasses' } }]);
    later = setAppearance(later, { char: 'P1', from: 0, outfit: "Chen's grey coat", src: 'model' });
    expect(standards(say(later, 'en', lines))[0]).toBe("The woman with long hair, in Chen's grey coat, sits.");
    later = addEvidence(later, 'P2', { t: 5, kind: 'vocative', name: 'Chen' });
    expect(standards(say(later, 'en', lines))).toEqual(['The woman with long hair sits.', 'The woman with long hair stands.', 'The woman with long hair leaves.']);
    expect(standards(say(rejectName(later, 'P2', 'Chen'), 'en', lines))[0]).toBe('The woman with long hair sits.');
  });

  it('does not say an outfit that holds an id, a brace or a mark, and does not silence the character for it', () => {
    for (const outfit of ["P2's grey coat", 'the coat of p2', 'a {grey} coat', 'the red box', '2号人物的大衣']) {
      const cast = { v: 1, policy: { ...DEFAULT_POLICY }, characters: [{ id: 'P1', name: null, level: 0, descriptor: { en: 'woman with long hair' } }, { id: 'P2', name: null, level: 0, descriptor: { en: 'man with glasses' } }], appearances: [{ char: 'P1', from: 0, to: null, outfit, src: 'model' }] };
      const out = say(cast, 'en', lines);
      expect(standards(out), outfit).toEqual(['The woman with long hair sits.', 'The woman with long hair stands.', 'The woman with long hair leaves.']);
      expect(out.report.silenced, outfit).toEqual([]);
      expect(out.cues.every((c) => c.silent === undefined), outfit).toBe(true);
    }
  });

  it('goes without the outfit in an introduction and in a re-anchoring too, and still says a good one', () => {
    let cast = castWith([MATTHEW_EN, CHEN_EN], { outfits: [['P1', 0, "Chen's grey coat"], ['P1', 500, 'a red dress']] });
    const out = say(cast, 'en', [[10, '{P1} sits.'], [20, '{P1} stands.'], [600, '{P1} leaves.']]);
    expect(standards(out)).toEqual(['Matthew, a woman with long hair, sits.', 'Matthew stands.', 'Matthew, in a red dress, leaves.']);
    cast = castWith([MATTHEW_EN, CHEN_EN], { outfits: [['P1', 0, 'a red dress'], ['P1', 500, "Chen's grey coat"]] });
    expect(standards(say(cast, 'en', [[10, '{P1} sits.'], [600, '{P1} leaves.']]))).toEqual(['Matthew, a woman with long hair in a red dress, sits.', 'Matthew leaves.']);
  });
});

describe('renderScript: the forms in English', () => {
  it('introduces at the first appearance with name, label with "a" and outfit, then uses the name', () => {
    const cast = castWith([MATTHEW_EN], { outfits: [['P1', 0, 'a red dress']] });
    const out = say(cast, 'en', [[10, '{P1} walks to the window.'], [20, '{P1} sits down.']]);
    expect(standards(out)).toEqual(['Matthew, a woman with long hair in a red dress, walks to the window.', 'Matthew sits down.']);
    expect(forms(out)).toEqual([{ P1: 'intro' }, { P1: 'name' }]);
    expect(out.report.introducedAt).toEqual({ P1: 'q1' });
  });

  it('introduces without an outfit part when none is known', () => {
    const out = say(castWith([MATTHEW_EN]), 'en', [[10, '{P1} walks to the window.']]);
    expect(standards(out)).toEqual(['Matthew, a woman with long hair, walks to the window.']);
  });

  it('writes "an" before a vowel', () => {
    const cast = castWith([
      { name: 'Arthur', level: 3, descriptor: { en: 'old man with a cane' } },
      { name: 'Edith', level: 3, descriptor: { en: 'elderly woman' } },
      { name: 'Ian', level: 3, descriptor: { en: 'usher' } },
      { name: 'Hugh', level: 3, descriptor: { en: 'tall boy' } },
    ]);
    const out = say(cast, 'en', [[10, '{P1} waves.'], [20, '{P2} nods.'], [30, '{P3} bows.'], [40, '{P4} runs.']]);
    expect(standards(out)).toEqual(['Arthur, an old man with a cane, waves.', 'Edith, an elderly woman, nods.', 'Ian, an usher, bows.', 'Hugh, a tall boy, runs.']);
  });

  it('chooses "a" or "an" by the sound the label begins with, not by its first letter', () => {
    const article = (en) => {
      const cast = { characters: [{ id: 'P1', name: 'Lee', level: 3, main: true, descriptor: { en } }] };
      const said = standards(say(cast, 'en', [[10, '{P1} waits.']]))[0];
      expect(castIntro(cast, null, { lang: 'en' })).toBe(`Main characters: ${said.slice(0, -' waits.'.length - 1)}.`);
      return /^Lee, (an?) /.exec(said)[1];
    };
    for (const en of ['uniformed officer', 'one-eyed man', 'once-famous actor', 'European tourist', 'user of a wheelchair', 'university student', 'Ukrainian soldier', 'US marine', 'UN official', 'U-shaped scar', 'utility worker', 'Utah ranger', 'unicorn costume', 'tall boy', 'hooded figure', '110-pound boxer', '180cm man', '1950s housewife', '12-year-old girl']) {
      expect(article(en), en).toBe('a');
    }
    for (const en of ['honest-looking clerk', 'hour-long queue', 'heir to the throne', 'honourable judge', '8-year-old boy', '80-year-old woman', '11-year-old girl', '18-year-old soldier', '1800s farmer', 'unidentified man', 'unimpressed woman', 'uninjured man', 'usher', 'ugly dog', 'umbrella seller', 'old man', 'elderly woman', 'onlooker', 'officer']) {
      expect(article(en), en).toBe('an');
    }
  });

  it('uses the label with "the" for a character without a name', () => {
    const out = say(castWith([MATTHEW_EN, CHEN_EN, STRANGER]), 'en', [[10, 'The door opens and {P3} enters.']]);
    expect(standards(out)).toEqual(['The door opens and the man in the grey coat enters.']);
    expect(forms(out)).toEqual([{ P3: 'label' }]);
  });

  it('says the outfit with the label once, and again only when it changed', () => {
    const cast = castWith([STRANGER], { outfits: [['P1', 0, 'a black hat'], ['P1', 300, 'a white shirt']] });
    const out = say(cast, 'en', [[10, 'Then {P1} enters.'], [20, 'Now {P1} sits.'], [310, 'Later {P1} stands.'], [320, 'Then {P1} leaves.']]);
    expect(standards(out)).toEqual([
      'Then the man in the grey coat, in a black hat, enters.',
      'Now the man in the grey coat sits.',
      'Later the man in the grey coat, in a white shirt, stands.',
      'Then the man in the grey coat leaves.',
    ]);
    expect(forms(out)).toEqual([{ P1: 'label-outfit' }, { P1: 'label' }, { P1: 'label-outfit' }, { P1: 'label' }]);
  });

  it('on-reveal: label until the reveal point, then label and name once, then the name', () => {
    const cast = castWith([{ ...MATTHEW_EN, revealAt: 100 }], { policy: { naming: 'on-reveal' }, outfits: [['P1', 0, 'a red dress']] });
    const out = say(cast, 'en', [[10, 'Slowly {P1} walks in.'], [50, 'Then {P1} sits.'], [120, 'Now {P1} stands up.'], [130, 'Then {P1} leaves.']]);
    expect(standards(out)).toEqual([
      'Slowly the woman with long hair, in a red dress, walks in.',
      'Then the woman with long hair sits.',
      'Now the woman with long hair, Matthew, stands up.',
      'Then Matthew leaves.',
    ]);
    expect(forms(out)).toEqual([{ P1: 'label-outfit' }, { P1: 'label' }, { P1: 'intro' }, { P1: 'name' }]);
    expect(out.report.introducedAt).toEqual({ P1: 'q3' });
  });

  it('on-reveal says an outfit in the introduction only when the listener has not heard it', () => {
    const cast = castWith([MATTHEW_EN], { policy: { naming: 'on-reveal' }, outfits: [['P1', 0, 'a red dress']] });
    const out = say(cast, 'en', [[10, 'Now {P1} stands up.']]);
    expect(standards(out)).toEqual(['Now the woman with long hair, in a red dress, Matthew, stands up.']);
  });

  it('re-anchors after a change of clothes and after a long absence', () => {
    const changed = castWith([MATTHEW_EN], { outfits: [['P1', 0, 'a red dress'], ['P1', 500, 'a grey coat']] });
    const a = say(changed, 'en', [[10, '{P1} walks in.'], [600, '{P1} leaves.'], [610, '{P1} drives off.']]);
    expect(standards(a)).toEqual(['Matthew, a woman with long hair in a red dress, walks in.', 'Matthew, now in a grey coat, leaves.', 'Matthew drives off.']);
    expect(forms(a)).toEqual([{ P1: 'intro' }, { P1: 'reanchor' }, { P1: 'name' }]);

    const away = castWith([MATTHEW_EN], { outfits: [['P1', 0, 'a red dress']] });
    const b = say(away, 'en', [[10, '{P1} walks in.'], [1500, '{P1} returns.']]);
    expect(standards(b)[1]).toBe('Matthew, the woman with long hair, returns.');
    expect(b.cues[1].forms).toEqual({ P1: 'reanchor' });

    const both = say(changed, 'en', [[10, '{P1} walks in.'], [2000, '{P1} returns.']]);
    expect(standards(both)[1]).toBe('Matthew, the woman with long hair, now in a grey coat, returns.');

    const first = castWith([MATTHEW_EN], { outfits: [['P1', 500, 'a grey coat']] });
    const c = say(first, 'en', [[10, '{P1} walks in.'], [600, '{P1} leaves.']]);
    expect(standards(c)).toEqual(['Matthew, a woman with long hair, walks in.', 'Matthew, in a grey coat, leaves.']);
  });

  it('starts a sentence with a capital, at the start of the text and after . ! ? and a space', () => {
    const cast = castWith([MATTHEW_EN, CHEN_EN, STRANGER]);
    const out = say(cast, 'en', [
      [10, '{P3} enters.'],
      [20, 'The door opens. {P3} enters.'],
      [30, 'A bang! {P3} turns.'],
      [40, 'Who is there? {P3} looks up.'],
      [50, 'The door opens and {P3} enters, then {P3} sits.'],
      [60, 'It costs 3.{P3}'],
    ]);
    expect(standards(out)).toEqual([
      'The man in the grey coat enters.',
      'The door opens. The man in the grey coat enters.',
      'A bang! The man in the grey coat turns.',
      'Who is there? The man in the grey coat looks up.',
      'The door opens and the man in the grey coat enters, then the man in the grey coat sits.',
      'It costs 3.the man in the grey coat',
    ]);
    // An opening quote or bracket before the token does not hide the start of the sentence.
    const quoted = say(cast, 'en', [[10, '"{P3} enters."'], [20, 'The door opens. ({P3} enters.)'], [30, 'A sign: "{P3} only".']]);
    expect(standards(quoted)).toEqual(['"The man in the grey coat enters."', 'The door opens. (The man in the grey coat enters.)', 'A sign: "the man in the grey coat only".']);
  });

  it('keeps a possessive on the last word of the form', () => {
    const cast = castWith([MATTHEW_EN, CHEN_EN, STRANGER], { outfits: [['P1', 0, 'a red dress']] });
    const out = say(cast, 'en', [
      [10, 'The camera follows {P1}’s hand.'],
      [20, "{P1}'s hand trembles."],
      [30, "{P3}'s hat falls."],
      [40, "The hat is {P3}'s."],
    ]);
    // In mid-sentence a long form cannot carry the possessive (the dress has no hand): the label does,
    // and the introduction waits for the next mention.
    expect(standards(out)).toEqual([
      'The camera follows the woman with long hair’s hand.',
      "Matthew, the woman with long hair, in a red dress. Matthew's hand trembles.",
      "The man in the grey coat's hat falls.",
      "The hat is the man in the grey coat's.",
    ]);
    expect(forms(out)[0]).toEqual({ P1: 'label' });
    expect(out.report).toEqual({ introducedAt: { P1: 'q2' }, deferred: ['q1'], silenced: [] });
  });

  it('holds a long form back from a possessive in mid-sentence, and says it at the next mention', () => {
    const cast = castWith([{ descriptor: { en: 'woman with long hair' } }, { descriptor: { en: 'man with glasses' } }], { outfits: [['P1', 0, 'a red dress'], ['P2', 0, 'a grey coat']] });
    const out = say(cast, 'en', [[10, "{P1} takes {P2}'s hand."], [20, "A tear runs down {P2}'s cheek."], [30, '{P2} turns away.']]);
    expect(standards(out)).toEqual([
      "The woman with long hair, in a red dress, takes the man with glasses's hand.",
      "A tear runs down the man with glasses's cheek.",
      'The man with glasses, in a grey coat, turns away.',
    ]);
    expect(forms(out)).toEqual([{ P1: 'label-outfit', P2: 'label' }, { P2: 'label' }, { P2: 'label-outfit' }]);
    expect(out.report.deferred).toEqual(['q1', 'q2']);
    // Held in every version when one of them has the possessive.
    const mixed = say(cast, 'en', [[10, { brief: '{P2} cries.', standard: "A tear runs down {P2}'s cheek.", detailed: '{P2} cries quietly.' }]]);
    expect(mixed.cues[0]).toMatchObject({ brief: 'The man with glasses cries.', standard: "A tear runs down the man with glasses's cheek.", detailed: 'The man with glasses cries quietly.', forms: { P2: 'label' } });
    // An introduction that is the name alone carries a possessive well, and counts.
    const bare = say(castWith([{ name: 'Matthew', level: 3 }]), 'en', [[10, "The camera follows {P1}'s hand."], [20, '{P1} sits.']]);
    expect(standards(bare)).toEqual(["The camera follows Matthew's hand.", 'Matthew sits.']);
    expect(bare.report).toEqual({ introducedAt: { P1: 'q1' }, deferred: [], silenced: [] });
    // Only the first token of the character takes the long form: a possessive on a later one holds nothing back.
    const later = say(cast, 'en', [[10, "{P2} looks down; a tear runs down {P2}'s cheek."]]);
    expect(standards(later)).toEqual(["The man with glasses, in a grey coat, looks down; a tear runs down the man with glasses's cheek."]);
  });

  it('makes a long form a sentence of its own when a possessive opens the sentence', () => {
    const cast = castWith([MATTHEW_EN, STRANGER], { outfits: [['P1', 0, 'a red dress'], ['P2', 0, 'a black hat']] });
    const out = say(cast, 'en', [[10, "{P1}'s hand trembles."], [20, "A pause. {P2}'s hat falls."]]);
    expect(standards(out)).toEqual([
      "Matthew, a woman with long hair in a red dress. Matthew's hand trembles.",
      "A pause. The man in the grey coat, in a black hat. The man in the grey coat's hat falls.",
    ]);
    expect(standards(say(cast, 'en', [[10, '{P1}’s hand trembles.']]))).toEqual(['Matthew, a woman with long hair in a red dress. Matthew’s hand trembles.']);
    // "'s" must end there: "{P1}'so" is not a possessive.
    expect(standards(say(cast, 'en', [[10, "{P1}'so"]]))).toEqual(["Matthew, a woman with long hair in a red dress'so"]);
  });

  it('follows a form that ends in a comma with one space', () => {
    const cast = castWith([MATTHEW_EN]);
    expect(standards(say(cast, 'en', [[10, '{P1}walks in.']]))).toEqual(['Matthew, a woman with long hair, walks in.']);
    expect(standards(say(cast, 'en', [[10, '{P1} walks in.']]))).toEqual(['Matthew, a woman with long hair, walks in.']);
  });
});

describe('renderScript: an outfit first on record while the cue lasts', () => {
  // A cue has the times of its pause (here 12.1 to 17.7); an outfit is on record
  // from the frame that first showed it, which lies inside the pause.
  const pause = { end: 17.7 };
  const comesIn = (cast, lang = 'zh-CN', text = '{P1}推门进来。', extra = pause) => say(cast, lang, [[12.1, text, extra], [20.6, lang === 'en' ? '{P1} sits down.' : '{P1}坐下。']]);

  it('says the outfit a person comes in with, in the introduction and with the label, and takes it as said', () => {
    const named = comesIn(castWith([MATTHEW], { outfits: [['P1', 13, '红裙子']] }));
    expect(standards(named)).toEqual(['马修，长发女人，穿着红裙子，推门进来。', '马修坐下。']);
    expect(forms(named)).toEqual([{ P1: 'intro' }, { P1: 'name' }]);
    const unnamed = comesIn(castWith([STRANGER], { outfits: [['P1', 13, '黑帽子']] }));
    expect(standards(unnamed)).toEqual(['灰大衣男人，穿着黑帽子，推门进来。', '灰大衣男人坐下。']);
    expect(forms(unnamed)).toEqual([{ P1: 'label-outfit' }, { P1: 'label' }]);
    const english = comesIn(castWith([MATTHEW_EN], { outfits: [['P1', 13, 'a red dress']] }), 'en', '{P1} comes in.');
    expect(standards(english)).toEqual(['Matthew, a woman with long hair in a red dress, comes in.', 'Matthew sits down.']);
    const revealed = comesIn(castWith([MATTHEW_EN], { policy: { naming: 'on-reveal' }, outfits: [['P1', 13, 'a red dress']] }), 'en', '{P1} comes in.');
    expect(standards(revealed)).toEqual(['The woman with long hair, in a red dress, Matthew, comes in.', 'Matthew sits down.']);
  });

  it('looks no further than the end of the cue, the end itself included', () => {
    const first = (from) => standards(comesIn(castWith([MATTHEW], { outfits: [['P1', from, '红裙子']] })))[0];
    expect(first(12.1)).toBe('马修，长发女人，穿着红裙子，推门进来。');
    expect(first(12.2)).toBe('马修，长发女人，穿着红裙子，推门进来。');
    expect(first(17.7)).toBe('马修，长发女人，穿着红裙子，推门进来。');
    expect(first(17.8)).toBe('马修，长发女人，推门进来。');
    // Seen only after the pause, the outfit is news at the next mention.
    expect(standards(comesIn(castWith([MATTHEW], { outfits: [['P1', 17.8, '红裙子']] })))[1]).toBe('马修，穿着红裙子，坐下。');
  });

  it('keeps the outfit current at the start: a change during the cue is said at the next mention', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子'], ['P1', 14, '灰大衣']] });
    expect(standards(comesIn(cast))).toEqual(['马修，长发女人，穿着红裙子，推门进来。', '马修，换了灰大衣，坐下。']);
  });

  it('takes the first of several outfits that begin during the cue', () => {
    const cast = castWith([STRANGER], { outfits: [['P1', 16, '白衬衫'], ['P1', 13, '黑帽子']] });
    expect(standards(comesIn(cast))).toEqual(['灰大衣男人，穿着黑帽子，推门进来。', '灰大衣男人，穿着白衬衫，坐下。']);
  });

  it('takes nobody else\'s outfit', () => {
    const cast = castWith([MATTHEW, STRANGER], { outfits: [['P2', 13, '黑帽子']] });
    expect(standards(comesIn(cast))[0]).toBe('马修，长发女人，推门进来。');
  });

  it('does not look ahead for a cue without a length', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 13, '红裙子']] });
    for (const end of [12.1, 5, undefined, null, NaN, Infinity, '17.7']) {
      expect(standards(comesIn(cast, 'zh-CN', '{P1}推门进来。', { end }))[0]).toBe('马修，长发女人，推门进来。');
    }
  });

  it('gives a person the picture did not confirm no outfit this way either', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 13, '红裙子']] });
    const out = comesIn(cast, 'zh-CN', '{P1}推门进来。', { ...pause, people: [{ char: 'P1', demoted: true }] });
    expect(standards(out)).toEqual(['长发女人推门进来。', '马修，长发女人，穿着红裙子，坐下。']);
  });

  it('does not change the cast', () => {
    const cast = deepFreeze(castWith([MATTHEW], { outfits: [['P1', 13, '红裙子']] }));
    expect(standards(comesIn(cast))[0]).toBe('马修，长发女人，穿着红裙子，推门进来。');
  });
});

describe('renderScript: which language', () => {
  const cast = castWith([STRANGER]);
  const lines = [[10, '{P1}']];

  it('words the forms in Chinese for zh, yue and cmn, in English otherwise', () => {
    for (const lang of ['zh', 'zh-CN', 'zh_CN', 'zh-Hant-TW', 'ZH-cn', 'yue', 'cmn-Hans']) {
      expect(standards(say(cast, lang, lines)), lang).toEqual(['灰大衣男人']);
    }
    for (const lang of ['en', 'en-GB', 'fr', 'ja', 'ko', 'zhx', '', undefined]) {
      expect(standards(say(cast, lang, lines)), String(lang)).toEqual(['The man in the grey coat']);
    }
  });

  it('takes the language from the script unless the options name one', () => {
    expect(standards(say(cast, 'en', lines, undefined, { lang: 'zh-CN' }))).toEqual(['灰大衣男人']);
    expect(standards(say(cast, 'zh-CN', lines, undefined, { lang: 'en' }))).toEqual(['The man in the grey coat']);
    expect(standards(say(cast, 'zh-CN', lines, undefined, {}))).toEqual(['灰大衣男人']);
  });

  it('falls back to the other language for a missing label, then to "某人" / "someone"', () => {
    const onlyEn = castWith([{ descriptor: { en: 'woman with long hair' } }]);
    expect(standards(say(onlyEn, 'zh-CN', [[10, '{P1}走到窗边。']]))).toEqual(['woman with long hair走到窗边。']);
    const onlyZh = castWith([{ descriptor: { zh: '长发女人' } }]);
    expect(standards(say(onlyZh, 'en', [[10, 'Then {P1} walks in.']]))).toEqual(['Then 长发女人 walks in.']);
    const none = castWith([{}]);
    expect(standards(say(none, 'zh-CN', [[10, '{P1}走到窗边。']]))).toEqual(['某人走到窗边。']);
    expect(standards(say(none, 'en', [[10, '{P1} walks in. Then {P1} sits.']]))).toEqual(['Someone walks in. Then someone sits.']);
  });

  it('gives a label of the other language no English article in an introduction', () => {
    const onlyZh = castWith([{ name: 'Matthew', level: 3, descriptor: { zh: '长发女人' } }]);
    expect(standards(say(onlyZh, 'en', [[10, '{P1} walks in.']]))).toEqual(['Matthew, 长发女人, walks in.']);
  });

  it('introduces by the name alone, or by name and outfit, when there is no label at all', () => {
    const bare = castWith([{ name: '马修', level: 3 }]);
    const a = say(bare, 'zh-CN', [[10, '{P1}走到窗边。'], [20, '{P1}坐下。']]);
    expect(standards(a)).toEqual(['马修走到窗边。', '马修坐下。']);
    expect(forms(a)).toEqual([{ P1: 'intro' }, { P1: 'name' }]);
    expect(a.report.introducedAt).toEqual({ P1: 'q1' });

    const dressed = castWith([{ name: '马修', level: 3 }], { outfits: [['P1', 0, '红裙子']] });
    expect(standards(say(dressed, 'zh-CN', [[10, '{P1}走到窗边。']]))).toEqual(['马修，穿着红裙子，走到窗边。']);
    const dressedEn = castWith([{ name: 'Matthew', level: 3 }], { outfits: [['P1', 0, 'a red dress']] });
    expect(standards(say(dressedEn, 'en', [[10, '{P1} walks in.']]))).toEqual(['Matthew, in a red dress, walks in.']);
    const stranger = castWith([{}], { outfits: [['P1', 0, 'a red dress']] });
    expect(standards(say(stranger, 'en', [[10, '{P1} walks in.']]))).toEqual(['Someone in a red dress walks in.']);

    const bareEn = castWith([{ name: 'Matthew', level: 3 }]);
    expect(standards(say(bareEn, 'en', [[10, '{P1} walks in.']]))).toEqual(['Matthew walks in.']);
    const onReveal = { naming: 'on-reveal' };
    expect(standards(say(bare, 'zh-CN', [[10, '{P1}走到窗边。']], onReveal))).toEqual(['马修走到窗边。']);
    expect(standards(say(bareEn, 'en', [[10, '{P1} walks in.']], onReveal))).toEqual(['Matthew walks in.']);
    // With no label there is nothing to put before the name: the name comes first, as at a first appearance.
    expect(standards(say(dressed, 'zh-CN', [[10, '{P1}走到窗边。']], onReveal))).toEqual(['马修，穿着红裙子，走到窗边。']);
    expect(standards(say(dressedEn, 'en', [[10, '{P1} walks in.']], onReveal))).toEqual(['Matthew, in a red dress, walks in.']);

    // Nothing to anchor a long absence with: the name alone.
    const away = say(bare, 'zh-CN', [[10, '{P1}走到窗边。'], [3000, '{P1}回来了。']]);
    expect(standards(away)[1]).toBe('马修回来了。');
    expect(away.cues[1].forms).toEqual({ P1: 'name' });
  });

  it('words a character without a label so that the sentence still reads, wherever the token stands', () => {
    const stranger = castWith([{}], { outfits: [['P1', 0, 'a blue shirt']] });
    const one = (cast, lang, text, policy) => standards(say(cast, lang, [[10, text]], policy))[0];
    expect(one(stranger, 'en', '{P1} walks in.')).toBe('Someone in a blue shirt walks in.');
    expect(one(stranger, 'en', 'A dog runs to {P1} and barks.')).toBe('A dog runs to someone in a blue shirt and barks.');
    expect(one(stranger, 'en', 'A dog runs to {P1}.')).toBe('A dog runs to someone in a blue shirt.');
    expect(one(stranger, 'en', 'The door opens, and {P1}, tired, sits.')).toBe('The door opens, and someone in a blue shirt, tired, sits.');
    const twice = say(stranger, 'en', [[10, '{P1} walks in.'], [20, '{P1} sits.']]);
    expect(standards(twice)).toEqual(['Someone in a blue shirt walks in.', 'Someone sits.']);
    expect(forms(twice)).toEqual([{ P1: 'label-outfit' }, { P1: 'label' }]);
    // In Chinese the form is an apposition with both its commas, as before.
    const zhStranger = castWith([{}], { outfits: [['P1', 0, '蓝衬衫']] });
    expect(one(zhStranger, 'zh-CN', '{P1}走进来。')).toBe('某人，穿着蓝衬衫，走进来。');

    const onReveal = { naming: 'on-reveal' };
    const rose = castWith([{ name: 'Rose', level: 3 }], { outfits: [['P1', 0, 'a blue shirt']] });
    expect(one(rose, 'en', 'A dog runs to {P1}.', onReveal)).toBe('A dog runs to Rose, in a blue shirt.');
    expect(one(rose, 'en', '{P1} walks in.', onReveal)).toBe('Rose, in a blue shirt, walks in.');
    const luosi = castWith([{ name: '罗丝', level: 3 }], { outfits: [['P1', 0, '蓝衬衫']] });
    expect(one(luosi, 'zh-CN', '一只狗跑向{P1}。', onReveal)).toBe('一只狗跑向罗丝，穿着蓝衬衫。');
    expect(one(luosi, 'zh-CN', '{P1}走进来。', onReveal)).toBe('罗丝，穿着蓝衬衫，走进来。');
    // With a label the reveal keeps its order: what the listener knows, then the name.
    const labelled = castWith([{ name: 'Rose', level: 3, descriptor: { en: 'woman with long hair' } }], { outfits: [['P1', 0, 'a blue shirt']] });
    expect(one(labelled, 'en', '{P1} walks in.', onReveal)).toBe('The woman with long hair, in a blue shirt, Rose, walks in.');
  });

  it('removes an article that slipped into an English label', () => {
    const cast = { v: 1, policy: { ...DEFAULT_POLICY }, characters: [{ id: 'P1', name: 'Matthew', level: 3, descriptor: { en: 'The woman with long hair' } }], appearances: [] };
    expect(standards(say(cast, 'en', [[10, '{P1} walks in.']]))).toEqual(['Matthew, a woman with long hair, walks in.']);
  });
});

describe('renderScript: who may be named', () => {
  const lines = [[10, '{P1}走到窗边。'], [20, '{P1}坐下。']];

  it('speaks a name with two clues only when the policy allows automatic names', () => {
    const cast = castWith([{ ...CHEN, level: 2 }]);
    expect(standards(say(cast, 'zh-CN', lines))).toEqual(['戴眼镜的男人走到窗边。', '戴眼镜的男人坐下。']);
    expect(standards(say(cast, 'zh-CN', lines, { minLevel: 2 }))).toEqual(['老陈，戴眼镜的男人，走到窗边。', '老陈坐下。']);
    const one = castWith([{ ...CHEN, level: 1 }]);
    expect(standards(say(one, 'zh-CN', lines, { minLevel: 2 }))).toEqual(['戴眼镜的男人走到窗边。', '戴眼镜的男人坐下。']);
  });

  it('keeps a plot secret without a reveal point behind the label for the whole film', () => {
    const cast = castWith([{ ...MATTHEW, spoilerLock: true }]);
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [7000, '{P1}坐下。']]);
    expect(standards(out)).toEqual(['长发女人走到窗边。', '长发女人坐下。']);
    expect(out.report.introducedAt).toEqual({});
  });

  it('introduces a plot secret at its reveal point, in the form of the policy', () => {
    const secret = { ...MATTHEW, spoilerLock: true, revealAt: 100 };
    const three = [[10, '{P1}走到窗边。'], [99, '{P1}坐下。'], [100, '{P1}站起来。'], [110, '{P1}离开。']];
    const first = say(castWith([secret]), 'zh-CN', three);
    expect(standards(first)).toEqual(['长发女人走到窗边。', '长发女人坐下。', '马修，长发女人，站起来。', '马修离开。']);
    expect(first.report.introducedAt).toEqual({ P1: 'q3' });
    const onReveal = say(castWith([secret]), 'zh-CN', three, { naming: 'on-reveal' });
    expect(standards(onReveal)).toEqual(['长发女人走到窗边。', '长发女人坐下。', '长发女人，马修，站起来。', '马修离开。']);
  });

  it('gives the full introduction at the reveal under first-appearance, the outfit included though it was said', () => {
    const cast = castWith([{ ...MATTHEW, spoilerLock: true, revealAt: 100 }], { outfits: [['P1', 0, '红裙子']] });
    const lines = [[10, '{P1}走到窗边。'], [100, '{P1}站起来。'], [110, '{P1}离开。']];
    expect(standards(say(cast, 'zh-CN', lines))).toEqual(['长发女人，穿着红裙子，走到窗边。', '马修，长发女人，穿着红裙子，站起来。', '马修离开。']);
    expect(standards(say(cast, 'zh-CN', lines, { naming: 'on-reveal' }))).toEqual(['长发女人，穿着红裙子，走到窗边。', '长发女人，马修，站起来。', '马修离开。']);
  });

  it('keeps a plot secret past a clue for a name that was refused or did not win', () => {
    const at150 = (cast, policy) => renderScript({ lang: 'en', cues: [{ id: 'q1', start: 150, end: 154, standard: '{P1} sits.' }, { id: 'q2', start: 4100, end: 4104, standard: '{P1} stands.' }] }, cast, policy).cues.map((c) => c.standard);
    let cast = castWith([{ descriptor: { en: 'masked man' }, spoilerLock: true }]);
    cast = addEvidence(cast, 'P1', { t: 100, kind: 'vocative', name: 'Bob' });
    cast = rejectName(cast, 'P1', 'Bob');
    cast = addEvidence(cast, 'P1', { t: 4000, kind: 'self-intro', name: 'Vader' });
    cast = confirmName(cast, 'P1', { name: 'Vader', by: 'sight' });
    expect(at150(cast)).toEqual(['The masked man sits.', 'Vader, the masked man, stands.']);
    // The same under on-reveal, with no lock and no refusal.
    let open = castWith([{ descriptor: { en: 'masked man' } }]);
    open = addEvidence(addEvidence(open, 'P1', { t: 100, kind: 'vocative', name: 'Bob' }), 'P1', { t: 4000, kind: 'self-intro', name: 'Vader' });
    open = confirmName(open, 'P1', { name: 'Vader', by: 'sight' });
    expect(at150(open, { naming: 'on-reveal' })).toEqual(['The masked man sits.', 'The masked man, Vader, stands.']);
  });

  it('names from the first appearance a character whose reveal point is no secret', () => {
    const cast = castWith([{ ...MATTHEW, revealAt: 100 }]);
    expect(standards(say(cast, 'zh-CN', lines))).toEqual(['马修，长发女人，走到窗边。', '马修坐下。']);
  });

  it('never names a character a person asked not to name', () => {
    const cast = neverName(castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] }), 'P1');
    const out = say(cast, 'zh-CN', lines);
    expect(standards(out)).toEqual(['长发女人，穿着红裙子，走到窗边。', '长发女人坐下。']);
    expect(forms(out)).toEqual([{ P1: 'label-outfit' }, { P1: 'label' }]);
    expect(out.report.introducedAt).toEqual({});
    expect(JSON.stringify(out)).not.toContain('马修');
  });

  it('uses the cast policy when none is given, and the given one over it', () => {
    const cast = castWith([MATTHEW], { policy: { naming: 'on-reveal' } });
    expect(standards(say(cast, 'zh-CN', lines))[0]).toBe('长发女人，马修，走到窗边。');
    expect(standards(say(cast, 'zh-CN', lines, { naming: 'first-appearance' }))[0]).toBe('马修，长发女人，走到窗边。');
    // A policy that only sets the level keeps the cast's naming rule.
    expect(standards(say(cast, 'zh-CN', lines, { minLevel: 2 }))[0]).toBe('长发女人，马修，走到窗边。');
    // So does a policy whose values are not valid ones.
    expect(standards(say(cast, 'zh-CN', lines, { naming: 'whenever', minLevel: 9 }))[0]).toBe('长发女人，马修，走到窗边。');
    // A cast without a policy gets the default one.
    const plain = { characters: cast.characters, appearances: [] };
    expect(standards(say(plain, 'zh-CN', lines))[0]).toBe('马修，长发女人，走到窗边。');
  });
});

describe('renderScript: a character the picture did not confirm', () => {
  const demotedP1 = { people: [{ char: 'P1', demoted: true }] };

  it('gets the label in that cue only, and the cue is not its introduction', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。', demotedP1], [20, '{P1}坐下。'], [30, '{P1}站起来。']]);
    expect(standards(out)).toEqual(['长发女人走到窗边。', '马修，长发女人，穿着红裙子，坐下。', '马修站起来。']);
    expect(forms(out)).toEqual([{ P1: 'label' }, { P1: 'intro' }, { P1: 'name' }]);
    expect(out.report.introducedAt).toEqual({ P1: 'q2' });
  });

  it('gets the label after it was introduced, and the name again in the next cue', () => {
    const out = say(castWith([MATTHEW_EN]), 'en', [[10, '{P1} walks in.'], [20, '{P1} sits. {P1} waits.', demotedP1], [30, '{P1} stands.']]);
    expect(standards(out)).toEqual(['Matthew, a woman with long hair, walks in.', 'The woman with long hair sits. The woman with long hair waits.', 'Matthew stands.']);
    expect(forms(out)).toEqual([{ P1: 'intro' }, { P1: 'label' }, { P1: 'name' }]);
  });

  it('gets no outfit and moves no state: the outfit and the absence are still to be said', () => {
    const cast = castWith([MATTHEW, STRANGER], { outfits: [['P2', 0, '黑帽子']] });
    const stranger = say(cast, 'zh-CN', [[10, '{P2}走进来。', { people: [{ char: 'P2', demoted: true }] }], [20, '{P2}坐下。']]);
    expect(standards(stranger)).toEqual(['灰大衣男人走进来。', '灰大衣男人，穿着黑帽子，坐下。']);
    const away = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [1300, '{P1}经过。', demotedP1], [1310, '{P1}回来了。']]);
    expect(standards(away)).toEqual(['马修，长发女人，走到窗边。', '长发女人经过。', '马修，长发女人，回来了。']);
  });

  it('demotes only the person marked, not the others in the cue', () => {
    const out = say(castWith([MATTHEW, CHEN]), 'zh-CN', [[10, '{P1}和{P2}握手。', { people: [{ char: 'P1' }, { char: 'P2', demoted: true }] }]]);
    expect(standards(out)).toEqual(['马修，长发女人，和戴眼镜的男人握手。']);
    expect(forms(out)).toEqual([{ P1: 'intro', P2: 'label' }]);
    expect(out.report.introducedAt).toEqual({ P1: 'q1' });
  });

  it('takes only demoted: true as a demotion', () => {
    const out = say(castWith([MATTHEW]), 'zh-CN', [[10, '{P1}走到窗边。', { people: [{ char: 'P1', demoted: false }, 'P1', null] }]]);
    expect(standards(out)).toEqual(['马修，长发女人，走到窗边。']);
  });
});

describe('renderScript: state across versions, tokens and people', () => {
  it('words the three versions of a cue from the same state, and moves the state once per cue', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [
      [10, { brief: '{P1}进门。', standard: '{P1}走进房间。', detailed: '{P1}推开门，走进房间。' }],
      [20, { brief: '{P1}坐下。', standard: '{P1}在桌边坐下。', detailed: '{P1}在桌边坐下，放下包。' }],
    ]);
    expect(out.cues[0]).toMatchObject({
      brief: '马修，长发女人，穿着红裙子，进门。',
      standard: '马修，长发女人，穿着红裙子，走进房间。',
      detailed: '马修，长发女人，穿着红裙子，推开门，走进房间。',
      forms: { P1: 'intro' },
    });
    expect(out.cues[1]).toMatchObject({ brief: '马修坐下。', standard: '马修在桌边坐下。', detailed: '马修在桌边坐下，放下包。', forms: { P1: 'name' } });
    expect(out.report.introducedAt).toEqual({ P1: 'q1' });
  });

  it('gives a second token of the same character in a cue the short form', () => {
    const named = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    expect(standards(say(named, 'zh-CN', [[10, '{P1}走到窗边，{P1}拉开窗帘，{P1}向外看。']]))).toEqual(['马修，长发女人，穿着红裙子，走到窗边，马修拉开窗帘，马修向外看。']);
    const unnamed = castWith([STRANGER], { outfits: [['P1', 0, '黑帽子']] });
    expect(standards(say(unnamed, 'zh-CN', [[10, '{P1}走进来，{P1}摘下帽子。']]))).toEqual(['灰大衣男人，穿着黑帽子，走进来，灰大衣男人摘下帽子。']);
    const english = castWith([MATTHEW_EN], { outfits: [['P1', 0, 'a red dress']] });
    expect(standards(say(english, 'en', [[10, '{P1} walks in. {P1} sits.']]))).toEqual(['Matthew, a woman with long hair in a red dress, walks in. Matthew sits.']);
    const reveal = castWith([MATTHEW_EN], { policy: { naming: 'on-reveal' } });
    expect(standards(say(reveal, 'en', [[10, 'Now {P1} walks in and {P1} sits.']]))).toEqual(['Now the woman with long hair, Matthew, walks in and Matthew sits.']);
  });

  it('counts first and later tokens within each version on its own', () => {
    const out = say(castWith([MATTHEW]), 'zh-CN', [[10, { brief: '{P1}进门。', standard: '{P1}进门，{P1}坐下。', detailed: '门开了，{P1}进来，{P1}坐下。' }]]);
    expect(out.cues[0]).toMatchObject({ brief: '马修，长发女人，进门。', standard: '马修，长发女人，进门，马修坐下。', detailed: '门开了，马修，长发女人，进来，马修坐下。' });
  });

  it('words two characters in one cue each by its own state', () => {
    const cast = castWith([MATTHEW, CHEN, STRANGER], { outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}和{P2}握手，{P3}在一旁看着。'], [20, '{P2}对{P1}点头，{P3}转身。']]);
    expect(standards(out)).toEqual(['马修，长发女人，穿着红裙子，和老陈，戴眼镜的男人，握手，灰大衣男人在一旁看着。', '老陈对马修点头，灰大衣男人转身。']);
    expect(forms(out)).toEqual([{ P1: 'intro', P2: 'intro', P3: 'label' }, { P2: 'name', P1: 'name', P3: 'label' }]);
    expect(out.report.introducedAt).toEqual({ P1: 'q1', P2: 'q1' });
    expect(out.cues.map((c) => c.people)).toEqual([['P1', 'P2', 'P3'], ['P2', 'P1', 'P3']]);

    const english = castWith([MATTHEW_EN, CHEN_EN]);
    expect(standards(say(english, 'en', [[10, '{P1} and {P2} shake hands.']]))).toEqual(['Matthew, a woman with long hair, and Chen, a man with glasses, shake hands.']);
  });

  it('reads the people from all three versions, the standard one first', () => {
    const cast = castWith([MATTHEW, CHEN, STRANGER]);
    const out = say(cast, 'zh-CN', [[10, { brief: '{P2}进门。', standard: '{P1}进门。', detailed: '{P1}和{P3}进门。' }], [20, '{P1}、{P2}、{P3}坐下。']]);
    // Nobody is in all three versions, so nobody is introduced here: a listener hears one version only.
    expect(out.cues[0]).toMatchObject({
      brief: '戴眼镜的男人进门。',
      standard: '长发女人进门。',
      detailed: '长发女人和灰大衣男人进门。',
      people: ['P1', 'P2', 'P3'],
      forms: { P1: 'label', P2: 'label', P3: 'label' },
    });
    expect(out.cues[0].silent).toBeUndefined();
    expect(out.cues[1].standard).toBe('马修，长发女人，老陈，戴眼镜的男人，灰大衣男人坐下。');
    expect(out.report).toEqual({ introducedAt: { P1: 'q2', P2: 'q2' }, deferred: ['q1'], silenced: [] });
  });

  it('introduces a character where it is first mentioned, however late', () => {
    const out = say(castWith([MATTHEW, CHEN]), 'zh-CN', [[10, '{P1}走到窗边。'], [20, '{P1}坐下。'], [900, '{P2}走进来，{P1}抬头。']]);
    expect(standards(out)[2]).toBe('老陈，戴眼镜的男人，走进来，马修抬头。');
    expect(out.report.introducedAt).toEqual({ P1: 'q1', P2: 'q3' });
  });

  it('walks the cues in time order whatever their order in the script', () => {
    const cues = [cue('late', 20, '{P1}坐下。'), cue('early', 10, '{P1}走到窗边。'), cue('same', 20, '{P1}站起来。')];
    const out = renderScript(film('zh-CN', cues), castWith([MATTHEW]));
    expect(out.cues.map((c) => c.id)).toEqual(['early', 'late', 'same']);
    expect(standards(out)).toEqual(['马修，长发女人，走到窗边。', '马修坐下。', '马修站起来。']);
    expect(out.report.introducedAt).toEqual({ P1: 'early' });
  });

  it('accepts tokens typed with full-width braces, spaces, lower case or leading zeros', () => {
    const out = say(castWith([MATTHEW]), 'zh-CN', [[10, '｛P1｝走到窗边，{ p1 }坐下，{P01}笑了。']]);
    expect(standards(out)).toEqual(['马修，长发女人，走到窗边，马修坐下，马修笑了。']);
    expect(out.cues[0].silent).toBeUndefined();
  });

  it('leaves a text without tokens as it is', () => {
    const out = say(castWith([MATTHEW]), 'zh-CN', [[10, '窗外下着雨。', { kind: 'text', priority: 1 }]]);
    expect(out.cues[0]).toMatchObject({ brief: '窗外下着雨。', standard: '窗外下着雨。', detailed: '窗外下着雨。', people: [], forms: {}, kind: 'text', priority: 1 });
  });
});

describe('renderScript: a long form that does not fit waits', () => {
  // "马修，长发女人，穿着红裙子，走到窗边。" is 15 characters: 15 / 4.5 + 0.25 = 3.58 s.
  // "长发女人走到窗边。" is 8: 2.03 s.
  const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });

  it('checks the arithmetic the cases below rely on', () => {
    expect(estimateSeconds('马修，长发女人，穿着红裙子，走到窗边。')).toBeCloseTo(3.583, 2);
    expect(estimateSeconds('长发女人走到窗边。')).toBeCloseTo(2.028, 2);
  });

  it('words the cue with the label, lists it as deferred, and introduces in the next cue', () => {
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。', { room: 2.5 }], [20, '{P1}坐下。', { room: 6 }], [30, '{P1}站起来。', { room: 2 }]]);
    expect(standards(out)).toEqual(['长发女人走到窗边。', '马修，长发女人，穿着红裙子，坐下。', '马修站起来。']);
    expect(forms(out)).toEqual([{ P1: 'label' }, { P1: 'intro' }, { P1: 'name' }]);
    expect(out.report).toEqual({ introducedAt: { P1: 'q2' }, deferred: ['q1'], silenced: [] });
    expect(out.cues.map((c) => c.room)).toEqual([2.5, 6, 2]);
  });

  it('keeps waiting through every cue that is too short', () => {
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。', { room: 2.5 }], [20, '{P1}坐下。', { room: 1.5 }], [30, '{P1}站起来。', { room: 3.4 }]]);
    expect(standards(out)).toEqual(['长发女人走到窗边。', '长发女人坐下。', '马修，长发女人，穿着红裙子，站起来。']);
    expect(out.report).toEqual({ introducedAt: { P1: 'q3' }, deferred: ['q1', 'q2'], silenced: [] });
  });

  it('decides by the brief version: a long form that fits there is said in all three', () => {
    const versions = { brief: '{P1}进门。', standard: '{P1}走进房间，环顾四周。', detailed: '{P1}推开门，走进房间，环顾四周，然后停下。' };
    // Brief with the introduction: 13 characters, 3.14 s. Standard would need 4.9 s.
    const out = say(cast, 'zh-CN', [[10, versions, { room: 3.2 }]]);
    expect(out.cues[0]).toMatchObject({ brief: '马修，长发女人，穿着红裙子，进门。', standard: '马修，长发女人，穿着红裙子，走进房间，环顾四周。', forms: { P1: 'intro' } });
    expect(out.report.deferred).toEqual([]);
    const tight = say(cast, 'zh-CN', [[10, versions, { room: 3.1 }]]);
    expect(tight.cues[0]).toMatchObject({ brief: '长发女人进门。', standard: '长发女人走进房间，环顾四周。', detailed: '长发女人推开门，走进房间，环顾四周，然后停下。', forms: { P1: 'label' } });
    expect(tight.report.deferred).toEqual(['q1']);
  });

  it('takes no long form in a cue whose brief version leaves the character out, however much room there is', () => {
    const versions = { brief: '门开了。', standard: '{P1}推门进来。', detailed: '{P1}推门进来。' };
    for (const room of [2, 4, 60, 0]) {
      const out = say(cast, 'zh-CN', [[10, versions, { room }], [20, '{P1}坐下。']]);
      expect(out.cues[0], String(room)).toMatchObject({ brief: '门开了。', standard: '长发女人推门进来。', detailed: '长发女人推门进来。', forms: { P1: 'label' } });
      // The introduction is made where every version carries it.
      expect(out.cues[1], String(room)).toMatchObject({ brief: '马修，长发女人，穿着红裙子，坐下。', forms: { P1: 'intro' } });
      expect(out.report, String(room)).toEqual({ introducedAt: { P1: 'q2' }, deferred: ['q1'], silenced: [] });
    }
    // The same when it is the standard or the detailed version that leaves the character out.
    for (const lacking of [{ brief: '{P1}进门。', standard: '门开了。', detailed: '{P1}推门进来。' }, { brief: '{P1}进门。', standard: '{P1}推门进来。', detailed: '门开了，风吹进来。' }]) {
      const out = say(cast, 'zh-CN', [[10, lacking]]);
      expect(out.cues[0].forms).toEqual({ P1: 'label' });
      expect(out.report).toEqual({ introducedAt: {}, deferred: ['q1'], silenced: [] });
    }
  });

  it('still says a name that is its own introduction in whichever version mentions the character', () => {
    // No label and no outfit: the introduction is the name alone, and a version without it misses nothing.
    const bare = castWith([{ name: '马修', level: 3 }]);
    const out = say(bare, 'zh-CN', [[10, { brief: '门开了。', standard: '{P1}推门进来。', detailed: '{P1}推门进来。' }, { room: 4 }], [20, '{P1}坐下。']]);
    expect(out.cues.map((c) => [c.brief, c.standard])).toEqual([['门开了。', '马修推门进来。'], ['马修坐下。', '马修坐下。']]);
    expect(out.report).toEqual({ introducedAt: { P1: 'q1' }, deferred: [], silenced: [] });
  });

  it('never lets the brief track say a bare name the listener was not introduced to', () => {
    const slots = [{ id: 'g1', start: 10, end: 18, room: 8 }, { id: 'g2', start: 30, end: 36, room: 6 }, { id: 'g3', start: 50, end: 56, room: 6 }];
    const script = film('en', [
      cue('q1', 10, { brief: '{P1} offers tea.', standard: '{P1} hands {P2} a cup.', detailed: '{P1} hands {P2} a cup.' }, { slot: 'g1', end: 18 }),
      cue('q2', 30, '{P2} drinks.', { slot: 'g2', end: 36 }),
      cue('q3', 50, '{P2} smiles.', { slot: 'g3', end: 56 }),
    ], slots);
    const cast = castWith([{ descriptor: { en: 'woman with long hair' } }, CHEN_EN]);
    const out = renderScript(script, cast);
    expect(out.cues.map((c) => c.forms)).toEqual([{ P1: 'label', P2: 'label' }, { P2: 'intro' }, { P2: 'name' }]);
    expect(out.report).toEqual({ introducedAt: { P2: 'q2' }, deferred: ['q1'], silenced: [] });
    expect(out.cues.map((c) => c.brief)).toEqual(['The woman with long hair offers tea.', 'Chen, the man with glasses, drinks.', 'Chen smiles.']);
    expect(out.cues.map((c) => c.standard)).toEqual(['The woman with long hair hands the man with glasses a cup.', 'Chen, the man with glasses, drinks.', 'Chen smiles.']);
    // What the player actually speaks, at every detail setting and at a rate that makes it fall back to brief.
    const player = toPlayerScript(out.cues, { videoId: 'film', lang: 'en', duration: 7200 });
    for (const [detail, rate] of [['brief', 1], ['standard', 1], ['standard', 0.5], ['detailed', 1], ['detailed', 0.5]]) {
      const spoken = player.cues.map((c) => chooseUtterance(c, { mode: 'gaps', detail, rate })?.text).filter(Boolean);
      const introduced = spoken.findIndex((text) => text.includes('Chen, the man with glasses,'));
      const named = spoken.findIndex((text) => text.includes('Chen'));
      expect(named, `${detail} ${rate}`).toBe(introduced);
    }
    // The same with no slot to measure against, and in Chinese.
    const loose = renderScript(film('en', script.cues.map(({ slot, ...c }) => ({ ...c, slot: null }))), cast);
    expect(loose.cues.map((c) => c.brief)).toEqual(out.cues.map((c) => c.brief));
    const zh = say(castWith([{ descriptor: { zh: '长发女人' } }, CHEN]), 'zh-CN', [[10, { brief: '{P1}端茶。', standard: '{P1}递给{P2}一杯茶。', detailed: '{P1}递给{P2}一杯茶。' }], [30, '{P2}喝茶。']]);
    expect(zh.cues.map((c) => c.brief)).toEqual(['长发女人端茶。', '老陈，戴眼镜的男人，喝茶。']);
    expect(zh.report.introducedAt).toEqual({ P2: 'q2' });
  });

  it('takes every long form where there is no room to measure', () => {
    const lines = [[10, '{P1}走到窗边。']];
    expect(standards(say(cast, 'zh-CN', lines))).toEqual(['马修，长发女人，穿着红裙子，走到窗边。']);
    const zero = say(cast, 'zh-CN', [[10, '{P1}走到窗边。', { room: 0 }]]);
    expect(standards(zero)).toEqual(['马修，长发女人，穿着红裙子，走到窗边。']);
    expect(zero.cues[0].room).toBe(0);
    expect(zero.report.deferred).toEqual([]);
    const called = [];
    say(cast, 'zh-CN', lines, undefined, { fits: (...args) => called.push(args) && false });
    expect(called).toEqual([]);
  });

  it('reads the room from the slot of the cue, or from the length of its pause', () => {
    const slots = [{ id: 'g_0001', start: 10, end: 12.5, room: 2.5, budget: { units: 'chars', brief: 3, standard: 6, detailed: 10 }, src: 'subs' }, { id: 'g_0002', start: 20, end: 26, room: 6, budget: { units: 'chars', brief: 8, standard: 17, detailed: 25 }, src: 'subs' }];
    const cues = [cue('q1', 10, '{P1}走到窗边。', { slot: 'g_0001', end: 12.5 }), cue('q2', 20, '{P1}坐下。', { slot: 'g_0002', end: 26 })];
    const out = renderScript(film('zh-CN', cues, slots), cast);
    expect(standards(out)).toEqual(['长发女人走到窗边。', '马修，长发女人，穿着红裙子，坐下。']);
    expect(out.cues.map((c) => c.room)).toEqual([2.5, 6]);
    expect(out.report.deferred).toEqual(['q1']);

    // The slot is not in the script: the cue's own start and end are the pause.
    const loose = renderScript(film('zh-CN', cues), cast);
    expect(loose.cues.map((c) => c.room)).toEqual([2.5, 6]);
    expect(standards(loose)).toEqual(standards(out));

    // A slot without a room field: its length.
    const bare = renderScript(film('zh-CN', cues, slots.map(({ room, ...slot }) => slot)), cast);
    expect(bare.cues.map((c) => c.room)).toEqual([2.5, 6]);

    // The slot's own room comes before its length, the slot before the cue's times, the cue's own room before all.
    const odd = [{ id: 'g_0001', start: 10, end: 30, room: 7 }, { id: 'g_0002', start: 20, end: 29 }];
    const stale = [cue('q1', 10, '{P1}走到窗边。', { slot: 'g_0001', end: 11 }), cue('q2', 20, '{P1}坐下。', { slot: 'g_0002', end: 21 }), cue('q3', 40, '{P1}笑了。', { slot: 'g_0002', end: 41, room: 3 })];
    expect(renderScript(film('zh-CN', stale, odd), cast).cues.map((c) => c.room)).toEqual([7, 9, 3]);
  });

  it('asks the given fits function, with the worded text and the room', () => {
    const calls = [];
    const fits = (text, room) => {
      calls.push([text, room]);
      return [...text].length <= room;
    };
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。', { room: 10 }], [20, '{P1}坐下。', { room: 30 }]], undefined, { fits });
    expect(standards(out)).toEqual(['长发女人走到窗边。', '马修，长发女人，穿着红裙子，坐下。']);
    expect(calls).toEqual([['马修，长发女人，穿着红裙子，走到窗边。', 10], ['马修，长发女人，穿着红裙子，坐下。', 30]]);
  });

  it('measures at the speaking rate given', () => {
    const lines = [[10, '{P1}走到窗边。', { room: 2.5 }]];
    expect(standards(say(cast, 'zh-CN', lines, undefined, { rate: 2 }))).toEqual(['马修，长发女人，穿着红裙子，走到窗边。']);
    expect(standards(say(cast, 'zh-CN', lines, undefined, { rate: 1 }))).toEqual(['长发女人走到窗边。']);
    expect(standards(say(cast, 'zh-CN', lines, undefined, { rate: 'fast' }))).toEqual(['长发女人走到窗边。']);
  });

  it('defers in English too', () => {
    const english = castWith([MATTHEW_EN], { outfits: [['P1', 0, 'a red dress']] });
    // 14 words with the introduction: 5.25 s. 9 words with the label: 3.46 s.
    const out = say(english, 'en', [[10, '{P1} walks to the window.', { room: 4 }], [20, '{P1} sits.', { room: 6 }]]);
    // The listener has heard "the woman with long hair": the introduction says "the", not "a" (another woman).
    expect(standards(out)).toEqual(['The woman with long hair walks to the window.', 'Matthew, the woman with long hair, in a red dress, sits.']);
    expect(out.report).toEqual({ introducedAt: { P1: 'q2' }, deferred: ['q1'], silenced: [] });
  });

  it('introduces with "the" in English whenever the label was already heard, and with "a" when it was not', () => {
    const plain = castWith([MATTHEW_EN]);
    const first = [10, '{P1} walks to the window.'];
    const then = [100, '{P1} sits down.'];
    // A deferred introduction.
    expect(standards(say(plain, 'en', [[10, '{P1} walks to the window.', { room: 2 }], [20, '{P1} sits down.', { room: 6 }]]))).toEqual(['The woman with long hair walks to the window.', 'Matthew, the woman with long hair, sits down.']);
    // A first mention the picture did not confirm.
    expect(standards(say(plain, 'en', [[10, '{P1} walks to the window.', { people: [{ char: 'P1', demoted: true }] }], then]))).toEqual(['The woman with long hair walks to the window.', 'Matthew, the woman with long hair, sits down.']);
    // A secret kept to its reveal.
    const secret = castWith([{ ...MATTHEW_EN, spoilerLock: true, revealAt: 50 }], { outfits: [['P1', 0, 'a red dress']] });
    expect(standards(say(secret, 'en', [first, then, [110, '{P1} smiles.']]))).toEqual(['The woman with long hair, in a red dress, walks to the window.', 'Matthew, the woman with long hair, in a red dress, sits down.', 'Matthew smiles.']);
    // A label heard long ago still counts, through other mentions.
    expect(standards(say(plain, 'en', [[10, '{P1} waits.', { people: [{ char: 'P1', demoted: true }] }], [20, '{P1} waits.', { people: [{ char: 'P1', demoted: true }] }], then]))[2]).toBe('Matthew, the woman with long hair, sits down.');
    // Nothing heard before: "a". A silent cue was not heard, and a cue the walk skipped was not either.
    expect(standards(say(plain, 'en', [first, then]))).toEqual(['Matthew, a woman with long hair, walks to the window.', 'Matthew sits down.']);
    expect(standards(say(plain, 'en', [[10, '{P1} looks at P2.'], then]))[1]).toBe('Matthew, a woman with long hair, sits down.');
    expect(standards(say(plain, 'en', [[10, '{P1} waits.', { status: 'needs-check' }], then]))[1]).toBe('Matthew, a woman with long hair, sits down.');
    // A demoted mention after a long absence does not forget the absence, or the outfit.
    const away = say(secret, 'en', [[60, '{P1} walks in.'], [2000, '{P1} passes.', { people: [{ char: 'P1', demoted: true }] }], [2010, '{P1} returns.']]);
    expect(standards(away)).toEqual(['Matthew, a woman with long hair in a red dress, walks in.', 'The woman with long hair passes.', 'Matthew, the woman with long hair, returns.']);
    // Chinese has no article: its introduction is what it was.
    expect(standards(say(castWith([MATTHEW]), 'zh-CN', [[10, '{P1}走到窗边。', { room: 2 }], [20, '{P1}坐下。', { room: 6 }]]))).toEqual(['长发女人走到窗边。', '马修，长发女人，坐下。']);
  });

  it('holds back an outfit said with a label, and says it in the next cue', () => {
    const unnamed = castWith([STRANGER], { outfits: [['P1', 0, '黑帽子']] });
    const out = say(unnamed, 'zh-CN', [[10, '{P1}走进来。', { room: 2 }], [20, '{P1}坐下。', { room: 5 }]]);
    expect(standards(out)).toEqual(['灰大衣男人走进来。', '灰大衣男人，穿着黑帽子，坐下。']);
    expect(forms(out)).toEqual([{ P1: 'label' }, { P1: 'label-outfit' }]);
    expect(out.report.deferred).toEqual(['q1']);
  });

  it('holds back a re-anchoring with the name, and the absence is not forgotten', () => {
    const changed = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子'], ['P1', 500, '灰大衣']] });
    const a = say(changed, 'zh-CN', [[10, '{P1}走到窗边。'], [600, '{P1}走出门。', { room: 1.5 }], [610, '{P1}上车。', { room: 5 }]]);
    expect(standards(a)).toEqual(['马修，长发女人，穿着红裙子，走到窗边。', '马修走出门。', '马修，换了灰大衣，上车。']);
    expect(forms(a)).toEqual([{ P1: 'intro' }, { P1: 'name' }, { P1: 'reanchor' }]);
    expect(a.report.deferred).toEqual(['q2']);

    const b = say(castWith([MATTHEW]), 'zh-CN', [[10, '{P1}走到窗边。'], [1300, '{P1}回来了。', { room: 1.5 }], [1310, '{P1}坐下。', { room: 5 }], [1320, '{P1}笑了。', { room: 5 }]]);
    expect(standards(b)).toEqual(['马修，长发女人，走到窗边。', '马修回来了。', '马修，长发女人，坐下。', '马修笑了。']);
    expect(b.report.deferred).toEqual(['q2']);
  });

  it('says the long forms that fit when not all of them do, in order of first mention', () => {
    // With one introduction: 20 characters, 4.69 s. With both: 22 characters, 5.14 s.
    const two = castWith([MATTHEW, CHEN], { outfits: [['P1', 0, '红裙子']] });
    const out = say(two, 'zh-CN', [[10, '{P1}和{P2}握手。', { room: 5 }], [20, '{P2}点头，{P1}笑了。', { room: 6 }]]);
    expect(standards(out)).toEqual(['马修，长发女人，穿着红裙子，和戴眼镜的男人握手。', '老陈，戴眼镜的男人，点头，马修笑了。']);
    expect(forms(out)).toEqual([{ P1: 'intro', P2: 'label' }, { P2: 'intro', P1: 'name' }]);
    expect(out.report).toEqual({ introducedAt: { P1: 'q1', P2: 'q2' }, deferred: ['q1'], silenced: [] });

    // The first does not fit (33 characters, 7.58 s), the second with the first one's label does (28, 6.47 s).
    const wordy = castWith([{ ...MATTHEW, descriptor: { zh: '留着很长很长的黑色头发的高个子女人' } }, CHEN], { outfits: [['P1', 0, '红裙子']] });
    const second = say(wordy, 'zh-CN', [[10, '{P1}和{P2}握手。', { room: 6.5 }]]);
    expect(standards(second)).toEqual(['留着很长很长的黑色头发的高个子女人和老陈，戴眼镜的男人，握手。']);
    expect(second.cues[0].forms).toEqual({ P1: 'label', P2: 'intro' });
    expect(second.report).toEqual({ introducedAt: { P2: 'q1' }, deferred: ['q1'], silenced: [] });
  });
});

describe('renderScript: include', () => {
  const cast = castWith([MATTHEW]);
  const cues = [cue('q1', 10, '{P1}走到窗边。', { priority: 3 }), cue('q2', 20, '{P1}坐下。', { priority: 1 }), cue('q3', 30, '{P1}站起来。', { priority: 2 })];

  it('skips the cues it refuses: the introduction lands on the first one spoken', () => {
    const out = renderScript(film('zh-CN', cues), cast, undefined, { include: (c) => c.priority <= 2 });
    expect(out.cues.map((c) => c.id)).toEqual(['q2', 'q3']);
    expect(standards(out)).toEqual(['马修，长发女人，坐下。', '马修站起来。']);
    expect(out.report.introducedAt).toEqual({ P1: 'q2' });
  });

  it('is handed each cue of the script as it is, and takes all by default', () => {
    const seen = [];
    const out = renderScript(film('zh-CN', cues), cast, undefined, { include: (c) => seen.push(c) > 0 });
    expect(seen).toEqual(cues);
    expect(seen[0]).toBe(cues[0]);
    expect(out.cues).toHaveLength(3);
    expect(renderScript(film('zh-CN', cues), cast).cues).toHaveLength(3);
    expect(renderScript(film('zh-CN', cues), cast, undefined, { include: () => false })).toEqual({ cues: [], report: { introducedAt: {}, deferred: [], silenced: [] } });
  });
});

describe('renderScript: what is never spoken', () => {
  const cast = castWith([MATTHEW, CHEN]);

  it('silences a cue that still holds a token, and the introduction is made in the next cue', () => {
    const out = say(cast, 'zh-CN', [[10, '{P1}和{P9}说话。'], [20, '{P1}坐下。']]);
    expect(out.cues[0]).toMatchObject({ standard: '马修，长发女人，和{P9}说话。', silent: true, people: ['P1', 'P9'], forms: { P1: 'intro' } });
    expect(out.cues[1].silent).toBeUndefined();
    expect('silent' in out.cues[1]).toBe(false);
    expect(standards(out)[1]).toBe('马修，长发女人，坐下。');
    expect(out.report).toEqual({ introducedAt: { P1: 'q2' }, deferred: [], silenced: ['q1'] });
  });

  it('silences a cue with an id in the open, a stray brace or a token that is none', () => {
    const out = say(cast, 'zh-CN', [[10, 'P1走到窗边。'], [20, '{P1}走到{窗边。'], [30, '{P0}走到窗边。'], [40, '{Bob}走到窗边。'], [50, '{P1}走到窗边。']]);
    expect(out.cues.map((c) => Boolean(c.silent))).toEqual([true, true, true, true, false]);
    expect(out.report.silenced).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(out.report.introducedAt).toEqual({ P1: 'q5' });
  });

  it('silences the whole cue when only one version holds residue', () => {
    const out = say(cast, 'en', [[10, { brief: 'A door.', standard: 'A door opens.', detailed: 'A door opens and P2 enters.' }]]);
    expect(out.cues[0].silent).toBe(true);
    expect(out.report.silenced).toEqual(['q1']);
  });

  it('silences a cue of a character the cast does not know', () => {
    const out = say(createCast(), 'en', [[10, '{P1} walks in.']]);
    expect(out.cues[0]).toMatchObject({ standard: '{P1} walks in.', silent: true, people: ['P1'], forms: {} });
  });

  it('fills the tokens it knows around one it does not', () => {
    const out = say(cast, 'zh-CN', [[10, '{P9}和{P1}说话，{P0}看着{P2}。']]);
    expect(out.cues[0]).toMatchObject({ standard: '{P9}和马修，长发女人，说话，{P0}看着老陈，戴眼镜的男人。', silent: true, forms: { P1: 'intro', P2: 'intro' } });
    // P0 is no character id.
    expect(out.cues[0].people).toEqual(['P9', 'P1', 'P2']);
  });

  it('does not list a silent cue as deferred, and a long form in it is not taken as said', () => {
    const dressed = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    const out = say(dressed, 'zh-CN', [[10, '{P1}看着P2。', { room: 1 }], [20, '{P1}坐下。']]);
    expect(out.report).toEqual({ introducedAt: { P1: 'q2' }, deferred: [], silenced: ['q1'] });
    expect(standards(out)[1]).toBe('马修，长发女人，穿着红裙子，坐下。');
  });

  it('silences a cue a person still has to check, with its tokens filled for the person to read', () => {
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。', { status: 'needs-check' }], [20, '{P1}坐下。', { status: 'edited' }]]);
    expect(out.cues[0]).toMatchObject({ standard: '马修，长发女人，走到窗边。', silent: true });
    expect(out.cues[1]).toMatchObject({ standard: '马修，长发女人，坐下。' });
    expect(out.cues[1].silent).toBeUndefined();
    expect(out.report).toEqual({ introducedAt: { P1: 'q2' }, deferred: [], silenced: ['q1'] });
  });

  it('a silent cue does not count as a mention', () => {
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。'], [1300, '{P1}看着P2。'], [1310, '{P1}回来了。']]);
    expect(standards(out)[2]).toBe('马修，长发女人，回来了。');
  });
});

describe('renderScript: renaming needs no model', () => {
  const script = film('zh-CN', [
    cue('q1', 10, { brief: '{P1}进门。', standard: '{P1}走进房间。', detailed: '{P1}推开门，走进房间，{P1}环顾四周。' }),
    cue('q2', 20, '{P1}和{P2}握手。'),
    cue('q3', 1500, '{P1}回来了，{P2}抬头。'),
  ]);
  const render = (cast) => renderScript(script, cast, undefined, { lang: 'zh-CN' });
  const allText = (out) => out.cues.map((c) => `${c.brief}${c.standard}${c.detailed}`).join('');

  it('gives the new name everywhere with the same call on the same script', () => {
    const before = castWith([MATTHEW, CHEN], { outfits: [['P1', 0, '红裙子']] });
    const old = render(before);
    expect(allText(old)).toContain('马修');
    const after = confirmName(before, 'P1', { name: '马秀', by: 'sight', t: 30 });
    const now = render(after);
    expect(allText(now)).not.toContain('马修');
    expect(now.cues.map((c) => [c.brief, c.standard, c.detailed])).toEqual(old.cues.map((c) => [c.brief, c.standard, c.detailed].map((text) => text.replaceAll('马修', '马秀'))));
    expect(now.cues[0].standard).toBe('马秀，长发女人，穿着红裙子，走进房间。');
    expect(now.cues[2].standard).toBe('马秀，长发女人，回来了，老陈，戴眼镜的男人，抬头。');
    expect(now.report).toEqual(old.report);
    // The first render is what it was: nothing is kept between calls.
    expect(render(before)).toEqual(old);
  });

  it('gives a name to a label, a new label or an outfit the same way', () => {
    const unnamed = castWith([{ descriptor: MATTHEW.descriptor }, CHEN]);
    expect(render(unnamed).cues[0].standard).toBe('长发女人走进房间。');
    const named = confirmName(unnamed, 'P1', { name: '马修', by: 'ear', t: 5 });
    expect(render(named).cues[0].standard).toBe('马修，长发女人，走进房间。');
    const relabelled = updateCharacter(named, 'P1', { descriptor: { zh: '短发女人' } });
    expect(render(relabelled).cues[0].standard).toBe('马修，短发女人，走进房间。');
    const dressed = setAppearance(relabelled, { char: 'P1', from: 0, outfit: '蓝衬衫', src: 'human' });
    expect(render(dressed).cues[0].standard).toBe('马修，短发女人，穿着蓝衬衫，走进房间。');
    const hushed = neverName(dressed, 'P1');
    expect(allText(render(hushed))).not.toContain('马修');
  });

  it('gives the same result for the same input every time', () => {
    const cast = castWith([MATTHEW, CHEN], { outfits: [['P1', 0, '红裙子']] });
    expect(render(cast)).toEqual(render(cast));
  });
});

describe('renderScript: punctuation and spacing', () => {
  it('drops the comma of a form before a comma, a stop, a bracket or the end of the text', () => {
    const cast = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    const one = (text) => standards(say(cast, 'zh-CN', [[10, text]]))[0];
    expect(one('{P1}，走到窗边。')).toBe('马修，长发女人，穿着红裙子，走到窗边。');
    expect(one('门开了，是{P1}。')).toBe('门开了，是马修，长发女人，穿着红裙子。');
    expect(one('走进来的是{P1}')).toBe('走进来的是马修，长发女人，穿着红裙子');
    // A list mark after the form would tie the outfit to the next item: the form keeps its own comma.
    expect(one('{P1}、一条狗和一只猫。')).toBe('马修，长发女人，穿着红裙子，一条狗和一只猫。');
    expect(one('{P1}、')).toBe('马修，长发女人，穿着红裙子');
    expect(one('来的是{P1}、。')).toBe('来的是马修，长发女人，穿着红裙子。');
    expect(one('是{P1}！')).toBe('是马修，长发女人，穿着红裙子！');
    expect(one('是{P1}？')).toBe('是马修，长发女人，穿着红裙子？');
    expect(one('一个人（{P1}）走过。')).toBe('一个人（马修，长发女人，穿着红裙子）走过。');
    expect(one('{P1}……')).toBe('马修，长发女人，穿着红裙子……');
    expect(one('{P1}  ')).toBe('马修，长发女人，穿着红裙子');
  });

  it('does the same in English', () => {
    const cast = castWith([MATTHEW_EN], { outfits: [['P1', 0, 'a red dress']] });
    const one = (text) => standards(say(cast, 'en', [[10, text]]))[0];
    expect(one('{P1}, tired, sits.')).toBe('Matthew, a woman with long hair in a red dress, tired, sits.');
    expect(one('The door closes behind {P1}.')).toBe('The door closes behind Matthew, a woman with long hair in a red dress.');
    expect(one('It is {P1}')).toBe('It is Matthew, a woman with long hair in a red dress');
    expect(one('It is {P1}!')).toBe('It is Matthew, a woman with long hair in a red dress!');
    expect(one('Someone ({P1}) passes.')).toBe('Someone (Matthew, a woman with long hair in a red dress) passes.');
    expect(one('Is it {P1}? Yes.')).toBe('Is it Matthew, a woman with long hair in a red dress? Yes.');
    expect(one('There: {P1}; then nothing.')).toBe('There: Matthew, a woman with long hair in a red dress; then nothing.');
    // A straight quote right after the token closes a quotation; after a space it opens the next one.
    expect(one('The card reads "{P1}".')).toBe('The card reads "Matthew, a woman with long hair in a red dress".');
    expect(one('Then {P1} "waves".')).toBe('Then Matthew, a woman with long hair in a red dress, "waves".');
  });

  it('puts no spaces around a form in Chinese', () => {
    const cast = castWith([MATTHEW, CHEN], { outfits: [['P1', 0, '红裙子']] });
    const one = (text) => standards(say(cast, 'zh-CN', [[10, text]]))[0];
    expect(one('{P1} 走到窗边。')).toBe('马修，长发女人，穿着红裙子，走到窗边。');
    expect(one('门开了， {P1} 走进来， {P1} 坐下。')).toBe('门开了，马修，长发女人，穿着红裙子，走进来，马修坐下。');
    expect(one('{P1} ， {P2} 。')).toBe('马修，长发女人，穿着红裙子，老陈，戴眼镜的男人。');
    // Two tokens with only a space between them are a list.
    expect(one('{P1} {P2}走进来。')).toBe('马修，长发女人，穿着红裙子，老陈，戴眼镜的男人，走进来。');
  });

  it('does not let a list mark tie an outfit or a label to the next person', () => {
    const cast = castWith([{ descriptor: { zh: '长发女人' } }, { descriptor: { zh: '戴眼镜的男人' } }], { outfits: [['P1', 0, '红裙子'], ['P2', 0, '灰大衣']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}、{P2}在吃饭。'], [20, '{P1}、{P2}在吃饭。']]);
    // First mention: each apposition closes with its own comma. Afterwards the list reads as a list.
    expect(standards(out)).toEqual(['长发女人，穿着红裙子，戴眼镜的男人，穿着灰大衣，在吃饭。', '长发女人、戴眼镜的男人在吃饭。']);
    const one = (text) => standards(say(cast, 'zh-CN', [[10, text]]))[0];
    expect(one('{P1} {P2}在吃饭。')).toBe('长发女人，穿着红裙子，戴眼镜的男人，穿着灰大衣，在吃饭。');
    expect(one('{P1} 、 {P2}在吃饭。')).toBe('长发女人，穿着红裙子，戴眼镜的男人，穿着灰大衣，在吃饭。');
    expect(one('{P1}、一条狗在吃饭。')).toBe('长发女人，穿着红裙子，一条狗在吃饭。');
    expect(one('{P2}、{P1}')).toBe('戴眼镜的男人，穿着灰大衣，长发女人，穿着红裙子');
    // A list with full commas is what it was.
    expect(one('{P1}，{P2}在吃饭。')).toBe('长发女人，穿着红裙子，戴眼镜的男人，穿着灰大衣，在吃饭。');
  });

  it('keeps "的" on the last word, and makes a long form a sentence of its own when it opens the sentence', () => {
    const cast = castWith([MATTHEW, STRANGER], { outfits: [['P1', 0, '红裙子']] });
    const out = say(cast, 'zh-CN', [[10, '镜头对准{P1}的手。'], [20, '{P1}的手在颤抖。'], [30, '{P2}的帽子掉了。']]);
    // In mid-sentence "穿着红裙子的手" would dress the hand: the label carries the 的 and the introduction waits.
    expect(standards(out)).toEqual(['镜头对准长发女人的手。', '马修，长发女人，穿着红裙子。马修的手在颤抖。', '灰大衣男人的帽子掉了。']);
    expect(out.report).toEqual({ introducedAt: { P1: 'q2' }, deferred: ['q1'], silenced: [] });
    const opening = say(cast, 'zh-CN', [[10, '{P1}的手在颤抖。'], [20, '灯灭了。{P1}的手松开。']]);
    expect(standards(opening)).toEqual(['马修，长发女人，穿着红裙子。马修的手在颤抖。', '灯灭了。马修的手松开。']);
    for (const stop of ['。', '！', '？', '……', '。”']) {
      expect(standards(say(cast, 'zh-CN', [[10, `灯灭了${stop}{P1}的手松开。`]])), stop).toEqual([`灯灭了${stop}马修，长发女人，穿着红裙子。马修的手松开。`]);
    }
    expect(standards(say(cast, 'zh-CN', [[10, '灯灭了，{P1}的手松开。']]))).toEqual(['灯灭了，长发女人的手松开。']);
  });

  it('never says an outfit or a label of whatever a person owns: 的 in mid-sentence holds the long form back', () => {
    const cast = castWith([{ descriptor: { zh: '长发女人' } }, { descriptor: { zh: '戴眼镜的男人' } }], { outfits: [['P1', 0, '红裙子'], ['P2', 0, '灰大衣']] });
    const out = say(cast, 'zh-CN', [[10, '{P1}跟{P2}的妹妹握手。'], [20, '一滴泪从{P2}的脸上滑落。'], [30, '{P2}转过身。']]);
    expect(standards(out)).toEqual(['长发女人，穿着红裙子，跟戴眼镜的男人的妹妹握手。', '一滴泪从戴眼镜的男人的脸上滑落。', '戴眼镜的男人，穿着灰大衣，转过身。']);
    expect(forms(out)).toEqual([{ P1: 'label-outfit', P2: 'label' }, { P2: 'label' }, { P2: 'label-outfit' }]);
    expect(out.report.deferred).toEqual(['q1', 'q2']);
    // A re-anchoring waits the same way, and the absence is not forgotten.
    const named = castWith([MATTHEW, { descriptor: { zh: '戴眼镜的男人' } }]);
    const away = say(named, 'zh-CN', [[10, '{P1}走到窗边。'], [2000, '{P2}握住{P1}的手。'], [2010, '{P1}笑了。']]);
    expect(standards(away)).toEqual(['马修，长发女人，走到窗边。', '戴眼镜的男人握住马修的手。', '马修，长发女人，笑了。']);
    expect(away.report.deferred).toEqual(['q2']);
  });

  it('never doubles punctuation, whatever the form and wherever the token stands', () => {
    const zhTemplates = ['{P1}走到窗边。', '{P1}，走到窗边。', '门开了，是{P1}。', '走进来的是{P1}', '{P1}、{P2}握手。', '{P1}和{P2}握手，{P1}笑了。', '（{P1}）', '{P1}！', '是{P1}？', '{P1}；{P2}。', '{P1} ， {P2} 。', '{P1}的手。', '看着{P1}的手。', '{P1} {P2}', '“{P1}”', '{P1}……', '{P1}——{P2}', '{P1}：{P2}', '{P2}，{P1}。'];
    const enTemplates = ['{P1} walks to the window.', '{P1}, tired, sits.', 'The door closes behind {P1}.', 'It is {P1}', '{P1}, {P2} and the dog wait.', '{P1} and {P2} shake hands. {P1} smiles.', '({P1})', '{P1}!', 'Who is it? {P1}.', '{P1}; {P2}.', "{P1}'s hand trembles.", "The camera follows {P1}'s hand.", '{P1}walks.', '{P1} — {P2}', '{P1}...', '{P1}: {P2}', '{P2}, {P1}.'];
    const zhBad = /[，、]\s*[，、。！？；：）”」…—]|[，、]\s*$|，的|\s|[{}]|,/;
    const enBad = /,\s*[,.!?;:)…—]|,\s*$|\s{2,}|,['’]s|[{}]|，/;

    // Each scenario brings the two characters to another form by the time of the last cue.
    const scenarios = (zh) => {
      const [a, b] = zh ? [MATTHEW, CHEN] : [MATTHEW_EN, CHEN_EN];
      const [red, grey, hat, shirt] = zh ? ['红裙子', '灰大衣', '黑帽子', '白衬衫'] : ['a red dress', 'a grey coat', 'a black hat', 'a white shirt'];
      const opening = zh ? '{P1}和{P2}走进来。' : '{P1} and {P2} walk in.';
      const start = [['P1', 0, red], ['P2', 0, hat]];
      const change = [...start, ['P1', 500, grey], ['P2', 500, shirt]];
      return [
        { form: 'intro', cast: castWith([a, b], { outfits: start }), at: 10 },
        { form: 'intro', cast: castWith([a, b]), at: 10 },
        { form: 'intro', cast: castWith([a, b], { outfits: start, policy: { naming: 'on-reveal' } }), at: 10 },
        { form: 'intro', cast: castWith([a, b], { policy: { naming: 'on-reveal' } }), at: 10 },
        { form: 'label-outfit', cast: castWith([a, b], { outfits: start, policy: { minLevel: 3 } }), at: 10, never: true },
        { form: 'label', cast: castWith([a, b]), at: 10, never: true },
        { form: 'name', cast: castWith([a, b], { outfits: start }), at: 20, opening },
        { form: 'reanchor', cast: castWith([a, b], { outfits: change }), at: 600, opening },
        { form: 'reanchor', cast: castWith([a, b], { outfits: start }), at: 3000, opening },
        { form: 'reanchor', cast: castWith([a, b], { outfits: change }), at: 3000, opening },
      ].map((s) => (s.never ? { ...s, cast: neverName(neverName(s.cast, 'P1'), 'P2') } : s));
    };

    for (const zh of [true, false]) {
      const formsSeen = new Set();
      for (const scenario of scenarios(zh)) {
        for (const template of zh ? zhTemplates : enTemplates) {
          const lines = scenario.opening ? [[10, scenario.opening], [scenario.at, template]] : [[scenario.at, template]];
          const out = say(scenario.cast, zh ? 'zh-CN' : 'en', lines);
          const last = out.cues[out.cues.length - 1];
          // A possessive in mid-sentence holds a long form back: the short one stands there.
          const held = template === '看着{P1}的手。' || template === "The camera follows {P1}'s hand.";
          const expected = held ? { intro: 'label', 'label-outfit': 'label', reanchor: 'name' }[scenario.form] || scenario.form : scenario.form;
          expect(last.forms.P1, `${scenario.form}: ${template}`).toBe(expected);
          if (!held) formsSeen.add(last.forms.P1);
          for (const version of ['brief', 'standard', 'detailed']) {
            expect(last[version], `${scenario.form}: ${template}`).not.toMatch(zh ? zhBad : enBad);
          }
          expect(last.silent, `${scenario.form}: ${template}`).toBeUndefined();
        }
      }
      expect([...formsSeen].sort()).toEqual(['intro', 'label', 'label-outfit', 'name', 'reanchor']);
    }
  });
});

describe('renderScript: the cues it returns', () => {
  const cast = castWith([MATTHEW]);

  it('returns exactly the fields of a rendered cue', () => {
    const out = say(cast, 'zh-CN', [[10, '{P1}走到窗边。', { kind: 'extended', priority: 1, onScreenText: 'x', scene: 2, clip: { file: 'a.wav' } }], [20, '{P9}', {}]]);
    expect(out.cues[0]).toEqual({
      id: 'q1',
      start: 10,
      end: 13,
      room: 0,
      kind: 'extended',
      priority: 1,
      brief: '马修，长发女人，走到窗边。',
      standard: '马修，长发女人，走到窗边。',
      detailed: '马修，长发女人，走到窗边。',
      people: ['P1'],
      forms: { P1: 'intro' },
    });
    expect(Object.keys(out.cues[1])).toEqual(['id', 'start', 'end', 'room', 'kind', 'priority', 'brief', 'standard', 'detailed', 'people', 'forms', 'silent']);
  });

  it('fills in what a cue lacks: versions from the standard, kind, priority, end', () => {
    const out = renderScript({ lang: 'zh-CN', cues: [{ id: 'a', start: 5, standard: '{P1}进门。' }, { id: 'b', start: 6, detailed: '{P1}坐下。', kind: 'film', priority: 9 }] }, cast);
    expect(out.cues).toEqual([
      { id: 'a', start: 5, end: 5, room: 0, kind: 'visual', priority: 2, brief: '马修，长发女人，进门。', standard: '马修，长发女人，进门。', detailed: '马修，长发女人，进门。', people: ['P1'], forms: { P1: 'intro' } },
      { id: 'b', start: 6, end: 6, room: 0, kind: 'visual', priority: 2, brief: '马修坐下。', standard: '马修坐下。', detailed: '马修坐下。', people: ['P1'], forms: { P1: 'name' } },
    ]);
  });

  it('returns nothing for no script, no cues, or cues that say nothing', () => {
    const empty = { cues: [], report: { introducedAt: {}, deferred: [], silenced: [] } };
    expect(renderScript(undefined, undefined)).toEqual(empty);
    expect(renderScript(null, cast)).toEqual(empty);
    expect(renderScript({}, cast)).toEqual(empty);
    expect(renderScript(film('zh-CN', []), cast)).toEqual(empty);
    expect(renderScript(film('zh-CN', [null, 'cue', 7, { id: 'x', start: 1 }, { id: 'y', start: 2, brief: '  ', standard: '', detailed: null }]), cast)).toEqual(empty);
  });

  it('passes over what is not a usable cue or slot and goes on', () => {
    const script = film('zh-CN', [null, { id: 'empty', start: 1, standard: ' ' }, cue('q1', 10, '{P1}走到窗边。', { slot: 'g_0002' }), { start: 20, standard: '{P1}坐下。' }], [null, 'g_0001', {}, { id: 7 }, { id: 'g_0002', start: 10, end: 16, room: 6 }]);
    const out = renderScript(script, cast);
    expect(standards(out)).toEqual(['马修，长发女人，走到窗边。', '马修坐下。']);
    // A cue without an id of its own is given none.
    expect(out.cues.map((c) => c.id)).toEqual(['q1', '']);
    expect(out.cues.map((c) => c.room)).toEqual([6, 0]);
  });

  it('accepts a bare list of cues', () => {
    const out = renderScript([cue('q1', 10, '{P1}走到窗边。')], cast, undefined, { lang: 'zh-CN' });
    expect(standards(out)).toEqual(['马修，长发女人，走到窗边。']);
  });

  it('gives a cue without a time the label, and the walk does not count it', () => {
    const out = renderScript(film('zh-CN', [{ id: 'lost', standard: '{P1}进门。' }, cue('q1', 10, '{P1}走到窗边。')]), cast);
    expect(out.cues.map((c) => c.id)).toEqual(['q1', 'lost']);
    expect(standards(out)).toEqual(['马修，长发女人，走到窗边。', '长发女人进门。']);
  });

  it('works on characters given as plain data with fields missing', () => {
    const plain = { characters: [{ id: 'P1', name: '马修', level: 3 }, { id: 'P2' }, { id: 'P3', name: '老陈', level: 3, main: true, screenSec: 50, descriptor: null }, { id: 'P4', name: '小雨', level: 3, main: true }, { id: 'P5', name: '阿明', level: 3, main: true, screenSec: 80 }] };
    expect(standards(say(plain, 'zh-CN', [[10, '{P1}和{P2}握手。']]))).toEqual(['马修和某人握手。']);
    expect(whoIsOnScreen(['P1', 'P2', 'P3'], plain, undefined, 5, { lang: 'zh-CN' })).toBe('画面里：马修；某人；老陈。');
    // No screen time counts as none.
    expect(castIntro(plain, undefined, { lang: 'zh-CN' })).toBe('主要人物：阿明；老陈；小雨。');
  });

  it('works on a cast without characters or with none at all', () => {
    expect(standards(say({}, 'en', [[10, 'Rain falls.']]))).toEqual(['Rain falls.']);
    expect(say(undefined, 'en', [[10, '{P1} walks in.']]).cues[0].silent).toBe(true);
  });
});

describe('renderScript: arguments', () => {
  it('does not change the script, the cast, the policy or the options', () => {
    const build = () => ({
      script: film('zh-CN', [
        cue('q1', 10, { brief: '{P1}进门。', standard: '{P1} 走进房间。', detailed: '｛P1｝推开门，{P1}走进房间。' }, { slot: 'g_0001', people: [{ char: 'P1', tracks: ['t1'] }] }),
        cue('q2', 20, '{P1}和{P2}握手，{P9}。', { people: [{ char: 'P1' }, { char: 'P2', demoted: true }] }),
        cue('q3', 1500, '{P2}回来了。', { room: 1 }),
      ], [{ id: 'g_0001', start: 10, end: 13, room: 3, budget: { units: 'chars', brief: 4, standard: 8, detailed: 12 }, src: 'subs' }]),
      cast: castWith([MATTHEW, CHEN], { outfits: [['P1', 0, '红裙子'], ['P1', 500, '灰大衣']] }),
      policy: { naming: 'on-reveal', minLevel: 2, introBeforeFilm: true, reanchorAfterSec: 600, independentGapSec: 90 },
      options: { lang: 'zh-CN', rate: 1.2, include: (c) => c.id !== 'none', fits: (text, room) => estimateSeconds(text) <= room },
    });
    const loose = build();
    const frozen = deepFreeze(build());
    const expected = renderScript(loose.script, loose.cast, loose.policy, loose.options);
    const out = renderScript(frozen.script, frozen.cast, frozen.policy, frozen.options);
    expect(out).toEqual(expected);
    expect(out.cues).toHaveLength(3);
    // The untouched copy is still what it was built as.
    expect(JSON.stringify(loose.script)).toBe(JSON.stringify(build().script));
    expect(JSON.stringify(loose.cast)).toBe(JSON.stringify(build().cast));
  });

  it('returns new objects each time', () => {
    const script = film('zh-CN', [cue('q1', 10, '{P1}走到窗边。')]);
    const cast = castWith([MATTHEW]);
    const a = renderScript(script, cast);
    const b = renderScript(script, cast);
    expect(a).toEqual(b);
    expect(a.cues[0]).not.toBe(b.cues[0]);
    expect(a.cues[0]).not.toBe(script.cues[0]);
    expect(a.report).not.toBe(b.report);
  });
});

describe('hasResidue', () => {
  it('finds a brace', () => {
    expect(hasResidue('{P3}走到窗边')).toBe(true);
    expect(hasResidue('走到{窗边')).toBe(true);
    expect(hasResidue('走到窗边}')).toBe(true);
    expect(hasResidue('｛P3｝走到窗边')).toBe(true);
    expect(hasResidue('walks {in}')).toBe(true);
  });

  it('finds a bare character id as a whole word', () => {
    expect(hasResidue('P3')).toBe(true);
    expect(hasResidue('P3走到窗边。')).toBe(true);
    expect(hasResidue('她看着P3。')).toBe(true);
    expect(hasResidue('P12 walks in.')).toBe(true);
    expect(hasResidue('She looks at P3.')).toBe(true);
    expect(hasResidue("P3's hand")).toBe(true);
    expect(hasResidue('(P3)')).toBe(true);
    expect(hasResidue('p3 walks in')).toBe(true);
    expect(hasResidue('Ｐ３走到窗边')).toBe(true);
    expect(hasResidue('P0')).toBe(true);
  });

  it('does not take part of a word, or a P without digits, for an id', () => {
    expect(hasResidue('An MP3 player.')).toBe(false);
    expect(hasResidue('P3s')).toBe(false);
    expect(hasResidue('XP3')).toBe(false);
    expect(hasResidue('P3_final')).toBe(false);
    expect(hasResidue('P')).toBe(false);
    expect(hasResidue('Plan 9')).toBe(false);
    expect(hasResidue('P.3')).toBe(false);
    expect(hasResidue('P 3')).toBe(false);
    expect(hasResidue('Paul walks in at 3.')).toBe(false);
    expect(hasResidue('马修，长发女人，穿着红裙子，走到窗边。')).toBe(false);
    expect(hasResidue('Matthew, a woman with long hair in a red dress, walks in.')).toBe(false);
  });

  it('is false for no text', () => {
    expect(hasResidue('')).toBe(false);
    expect(hasResidue(undefined)).toBe(false);
    expect(hasResidue(null)).toBe(false);
    expect(hasResidue(3)).toBe(false);
  });
});

describe('castIntro', () => {
  const cast = castWith([CHEN, MATTHEW, STRANGER, { name: '小雨', level: 3, descriptor: { zh: '扎辫子的女孩', en: 'girl with braids' }, main: false, screenSec: 5000 }]);

  it('lists the main characters whose name may be said, the one longest on screen first', () => {
    expect(castIntro(cast, undefined, { lang: 'zh-CN' })).toBe('主要人物：马修，长发女人；老陈，戴眼镜的男人。');
    const english = castWith([CHEN_EN, MATTHEW_EN, STRANGER]);
    expect(castIntro(english, undefined, { lang: 'en' })).toBe('Main characters: Matthew, a woman with long hair; Chen, a man with glasses.');
  });

  it('keeps the order of the cast for equal screen time', () => {
    const even = castWith([{ ...CHEN, screenSec: 100 }, { ...MATTHEW, screenSec: 100 }]);
    expect(castIntro(even, undefined, { lang: 'zh-CN' })).toBe('主要人物：老陈，戴眼镜的男人；马修，长发女人。');
    const unknown = castWith([{ ...CHEN, screenSec: undefined }, MATTHEW]);
    expect(castIntro(unknown, undefined, { lang: 'zh-CN' })).toBe('主要人物：马修，长发女人；老陈，戴眼镜的男人。');
  });

  it('writes "an" before a vowel, and the name alone without a label', () => {
    const people = castWith([{ name: 'Arthur', level: 3, descriptor: { en: 'old man with a cane' }, main: true, screenSec: 9 }, { name: 'Zed', level: 3, main: true, screenSec: 1 }]);
    expect(castIntro(people, undefined, { lang: 'en' })).toBe('Main characters: Arthur, an old man with a cane; Zed.');
    expect(castIntro(people, undefined, { lang: 'zh' })).toBe('主要人物：Arthur，old man with a cane；Zed。');
  });

  it('leaves out plot secrets, names not sure enough, names never to be said and names not yet revealed', () => {
    const secret = castWith([{ ...MATTHEW, spoilerLock: true, revealAt: 0 }, CHEN]);
    expect(castIntro(secret, undefined, { lang: 'zh-CN' })).toBe('主要人物：老陈，戴眼镜的男人。');
    const unsure = castWith([{ ...MATTHEW, level: 2 }, CHEN]);
    expect(castIntro(unsure, undefined, { lang: 'zh-CN' })).toBe('主要人物：老陈，戴眼镜的男人。');
    expect(castIntro(unsure, { minLevel: 2 }, { lang: 'zh-CN' })).toBe('主要人物：马修，长发女人；老陈，戴眼镜的男人。');
    const hushed = neverName(castWith([MATTHEW, CHEN]), 'P1');
    expect(castIntro(hushed, undefined, { lang: 'zh-CN' })).toBe('主要人物：老陈，戴眼镜的男人。');
    const later = castWith([{ ...MATTHEW, revealAt: 100 }, { ...CHEN, revealAt: 0 }]);
    expect(castIntro(later, { naming: 'on-reveal' }, { lang: 'zh-CN' })).toBe('主要人物：老陈，戴眼镜的男人。');
    expect(castIntro(later, { naming: 'first-appearance' }, { lang: 'zh-CN' })).toBe('主要人物：马修，长发女人；老陈，戴眼镜的男人。');
  });

  it('is empty when the policy has no introduction or nobody qualifies', () => {
    expect(castIntro(cast, { introBeforeFilm: false }, { lang: 'zh-CN' })).toBe('');
    expect(castIntro(castWith([MATTHEW], { policy: { introBeforeFilm: false } }), undefined, { lang: 'zh-CN' })).toBe('');
    expect(castIntro(castWith([STRANGER, { ...MATTHEW, main: false }]), undefined, { lang: 'zh-CN' })).toBe('');
    expect(castIntro(createCast(), undefined, { lang: 'zh-CN' })).toBe('');
    expect(castIntro(undefined, undefined, undefined)).toBe('');
    expect(castIntro({}, null)).toBe('');
  });

  it('says no outfit', () => {
    const dressed = castWith([MATTHEW], { outfits: [['P1', 0, '红裙子']] });
    expect(castIntro(dressed, undefined, { lang: 'zh-CN' })).toBe('主要人物：马修，长发女人。');
  });

  it('is never longer than maxChars: whole entries are dropped from the end', () => {
    const many = castWith(Array.from({ length: 20 }, (_, i) => ({ name: `人物${i + 1}`, level: 3, descriptor: { zh: `第${i + 1}个穿深色衣服的高个子`, en: `tall person number ${i + 1}` }, main: true, screenSec: 1000 - i })));
    for (const lang of ['zh-CN', 'en']) {
      const [head, between, stop] = lang === 'en' ? ['Main characters: ', '; ', '.'] : ['主要人物：', '；', '。'];
      const full = castIntro(many, undefined, { lang, maxChars: 10000 });
      const entries = full.slice(head.length, -stop.length).split(between);
      expect(entries, lang).toHaveLength(20);
      expect(full.length, lang).toBeGreaterThan(250);
      const firstEntries = (count) => `${head}${entries.slice(0, count).join(between)}${stop}`;
      for (let maxChars = 1; maxChars <= full.length + 5; maxChars += 1) {
        const text = castIntro(many, undefined, { lang, maxChars });
        expect(text.length, `${lang} ${maxChars}`).toBeLessThanOrEqual(maxChars);
        // As many whole entries as fit, from the start; nothing when not even the first does.
        let count = entries.length;
        while (count > 0 && firstEntries(count).length > maxChars) count -= 1;
        expect(text, `${lang} ${maxChars}`).toBe(count ? firstEntries(count) : '');
      }
    }
    // 200 by default, also when maxChars is not a length.
    const byDefault = castIntro(many, undefined, { lang: 'zh-CN' });
    expect(byDefault).toBe(castIntro(many, undefined, { lang: 'zh-CN', maxChars: 200 }));
    expect(byDefault.length).toBeLessThanOrEqual(200);
    expect(byDefault.length).toBeGreaterThan(180);
    for (const maxChars of ['many', 0, -5, NaN, null]) {
      expect(castIntro(many, undefined, { lang: 'zh-CN', maxChars }), String(maxChars)).toBe(byDefault);
    }
  });

  it('drops the last entries one at a time, and returns nothing when not even one fits', () => {
    const two = castWith([MATTHEW, CHEN]);
    const both = '主要人物：马修，长发女人；老陈，戴眼镜的男人。';
    const one = '主要人物：马修，长发女人。';
    expect(castIntro(two, undefined, { lang: 'zh-CN', maxChars: both.length })).toBe(both);
    expect(castIntro(two, undefined, { lang: 'zh-CN', maxChars: both.length - 1 })).toBe(one);
    expect(castIntro(two, undefined, { lang: 'zh-CN', maxChars: one.length })).toBe(one);
    expect(castIntro(two, undefined, { lang: 'zh-CN', maxChars: one.length - 1 })).toBe('');
  });

  it('does not change its arguments', () => {
    const frozen = deepFreeze(castWith([CHEN, MATTHEW]));
    expect(castIntro(frozen, deepFreeze({ minLevel: 3 }), deepFreeze({ lang: 'zh-CN', maxChars: 100 }))).toBe('主要人物：马修，长发女人；老陈，戴眼镜的男人。');
  });
});

describe('whoIsOnScreen', () => {
  const cast = castWith([MATTHEW, CHEN, STRANGER]);
  const english = castWith([MATTHEW_EN, CHEN_EN, STRANGER]);

  it('gives names for the unlocked and labels for the others', () => {
    expect(whoIsOnScreen(['P1', 'P3'], cast, undefined, 60, { lang: 'zh-CN' })).toBe('画面里：马修；灰大衣男人。');
    expect(whoIsOnScreen(['P1', 'P3'], english, undefined, 60, { lang: 'en' })).toBe('On screen: Matthew; the man in the grey coat.');
    expect(whoIsOnScreen(['P3', 'P2', 'P1'], cast, undefined, 60, { lang: 'zh-CN' })).toBe('画面里：灰大衣男人；老陈；马修。');
    expect(whoIsOnScreen(['P2'], english, undefined, 60, { lang: 'en' })).toBe('On screen: Chen.');
  });

  it('follows the policy and the time', () => {
    expect(whoIsOnScreen(['P1'], castWith([{ ...MATTHEW, level: 2 }]), undefined, 60, { lang: 'zh-CN' })).toBe('画面里：长发女人。');
    expect(whoIsOnScreen(['P1'], castWith([{ ...MATTHEW, level: 2 }]), { minLevel: 2 }, 60, { lang: 'zh-CN' })).toBe('画面里：马修。');
    const secret = castWith([{ ...MATTHEW, spoilerLock: true, revealAt: 100 }]);
    expect(whoIsOnScreen(['P1'], secret, undefined, 99, { lang: 'zh-CN' })).toBe('画面里：长发女人。');
    expect(whoIsOnScreen(['P1'], secret, undefined, 100, { lang: 'zh-CN' })).toBe('画面里：马修。');
    const onReveal = castWith([{ ...MATTHEW_EN, revealAt: 100 }], { policy: { naming: 'on-reveal' } });
    expect(whoIsOnScreen(['P1'], onReveal, undefined, 50, { lang: 'en' })).toBe('On screen: the woman with long hair.');
    expect(whoIsOnScreen(['P1'], onReveal, undefined, 150, { lang: 'en' })).toBe('On screen: Matthew.');
    expect(whoIsOnScreen(['P1'], neverName(cast, 'P1'), undefined, 60, { lang: 'zh-CN' })).toBe('画面里：长发女人。');
    expect(whoIsOnScreen(['P1'], cast, undefined, undefined, { lang: 'zh-CN' })).toBe('画面里：长发女人。');
  });

  it('says so in a sentence when nobody is recognised', () => {
    expect(whoIsOnScreen([], cast, undefined, 60, { lang: 'zh-CN' })).toBe('画面里没有认出的人物。');
    expect(whoIsOnScreen([], english, undefined, 60, { lang: 'en' })).toBe('Nobody on screen is recognised.');
    // People the cast does not know are nobody it can speak of.
    expect(whoIsOnScreen(['P9', 'x', 7, null], cast, undefined, 60, { lang: 'zh-CN' })).toBe('画面里没有认出的人物。');
  });

  it('says that the mode does not check the picture when it cannot tell', () => {
    expect(whoIsOnScreen(null, cast, undefined, 60, { lang: 'zh-CN' })).toBe('本模式不核对画面。');
    expect(whoIsOnScreen(null, english, undefined, 60, { lang: 'en' })).toBe('This mode does not check the picture.');
    expect(whoIsOnScreen(undefined, english, undefined, 60, { lang: 'en' })).toBe('This mode does not check the picture.');
    expect(whoIsOnScreen(null, cast, undefined, 60, { lang: 'zh-CN', recentIds: [] })).toBe('本模式不核对画面。');
  });

  it('gives the people last described by their labels when the mode cannot tell: nothing checked them', () => {
    expect(whoIsOnScreen(null, cast, undefined, 60, { lang: 'zh-CN', recentIds: ['P1', 'P3'] })).toBe('本模式不核对画面。最近一条口述提到的人物：长发女人；灰大衣男人。');
    expect(whoIsOnScreen(null, english, undefined, 60, { lang: 'en', recentIds: ['P1', 'P3'] })).toBe('This mode does not check the picture. The people last described: the woman with long hair; the man in the grey coat.');
    expect(whoIsOnScreen(undefined, english, undefined, 60, { lang: 'en', recentIds: ['P2'], allowNamesWithoutTracks: false })).toBe('This mode does not check the picture. The people last described: the man with glasses.');
    // Only `true` allows names there, as in verify.js.
    expect(whoIsOnScreen(null, english, undefined, 60, { lang: 'en', recentIds: ['P1'], allowNamesWithoutTracks: 'yes' })).toBe('This mode does not check the picture. The people last described: the woman with long hair.');
    // recentIds is for that case only.
    expect(whoIsOnScreen(['P2'], cast, undefined, 60, { lang: 'zh-CN', recentIds: ['P1'] })).toBe('画面里：老陈。');
  });

  it('names the people last described when names are allowed without tracks, by the usual rules', () => {
    const trusting = { recentIds: ['P1', 'P3'], allowNamesWithoutTracks: true };
    expect(whoIsOnScreen(null, cast, undefined, 60, { lang: 'zh-CN', ...trusting })).toBe('本模式不核对画面。最近一条口述提到的人物：马修；灰大衣男人。');
    expect(whoIsOnScreen(null, english, undefined, 60, { lang: 'en', ...trusting })).toBe('This mode does not check the picture. The people last described: Matthew; the man in the grey coat.');
    expect(whoIsOnScreen(null, neverName(english, 'P1'), undefined, 60, { lang: 'en', ...trusting })).toBe('This mode does not check the picture. The people last described: the woman with long hair; the man in the grey coat.');
    // The option says nothing about people the identity layer did see.
    expect(whoIsOnScreen(['P1'], english, undefined, 60, { lang: 'en', allowNamesWithoutTracks: false })).toBe('On screen: Matthew.');
  });

  it('reads ids and the entries of an identity provider, each person once', () => {
    const visible = [{ characterId: 'P1', box: [0, 0, 10, 10], conf: 0.9 }, 'P3', { characterId: 'P1', box: [5, 5, 10, 10], conf: 0.4 }, 'P3'];
    expect(whoIsOnScreen(visible, cast, undefined, 60, { lang: 'zh-CN' })).toBe('画面里：马修；灰大衣男人。');
  });

  it('falls back for a missing label, and uses English for other languages', () => {
    const bare = castWith([{}, { descriptor: { zh: '长发女人' } }]);
    expect(whoIsOnScreen(['P1', 'P2'], bare, undefined, 60, { lang: 'zh-CN' })).toBe('画面里：某人；长发女人。');
    expect(whoIsOnScreen(['P1', 'P2'], bare, undefined, 60, { lang: 'en' })).toBe('On screen: someone; 长发女人.');
    expect(whoIsOnScreen(['P3'], english, undefined, 60, { lang: 'fr' })).toBe('On screen: the man in the grey coat.');
    expect(whoIsOnScreen(['P3'], english, undefined, 60)).toBe('On screen: the man in the grey coat.');
  });

  it('does not change its arguments', () => {
    const frozen = deepFreeze(castWith([MATTHEW, STRANGER]));
    const ids = deepFreeze(['P1', 'P2']);
    expect(whoIsOnScreen(ids, frozen, deepFreeze({ minLevel: 3 }), 60, deepFreeze({ lang: 'zh-CN', recentIds: ['P1'] }))).toBe('画面里：马修；灰大衣男人。');
    expect(whoIsOnScreen(null, frozen, undefined, 60, deepFreeze({ lang: 'zh-CN', recentIds: ['P2'] }))).toBe('本模式不核对画面。最近一条口述提到的人物：灰大衣男人。');
  });
});
