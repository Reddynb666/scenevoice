// The film engine's verifier (src/film/verify.js): a description refers to people
// by token only, a token stands only when the picture shows its character, and a
// generic "a woman" becomes the token of the one main character it can only mean.
import { describe, expect, it } from 'vitest';
import { addCharacter, addEvidence, confirmName, createCast, rejectName } from '../src/film/cast.js';
import { faceClusterIdentity } from '../src/film/identity.js';
import { hasResidue, renderScript } from '../src/film/namegate.js';
import { normalizeTokens, repairGeneric, verifyCue, verifyScript, violations } from '../src/film/verify.js';

const character = (id, fields = {}) => ({
  id,
  name: null,
  level: 0,
  aliases: [],
  descriptor: {},
  revealAt: null,
  spoilerLock: false,
  neverName: false,
  main: false,
  screenSec: 0,
  evidence: [],
  clusters: [],
  ...fields,
});

const castOf = (...characters) => ({
  v: 1,
  policy: { naming: 'first-appearance', minLevel: 3, introBeforeFilm: true, reanchorAfterSec: 1200, independentGapSec: 90 },
  characters,
  appearances: [],
  constraints: { mustLink: [], cannotLink: [] },
  events: [],
});

/** The cast most tests use: two main characters, and names chosen to be awkward. */
const cast = castOf(
  character('P1', { name: '老陈', level: 3, main: true, descriptor: { zh: '戴眼镜的男人', en: 'man with glasses' } }),
  character('P3', {
    name: '马修',
    level: 3,
    main: true,
    aliases: [{ text: 'Matthew', lang: 'en' }, { text: '修' }],
    descriptor: { zh: '长发女人', en: 'woman with long hair' },
  }),
  character('P5', { name: '小雨', level: 2 }),
  character('P6', { name: '陈', level: 1 }),
  character('P7', { name: 'Rose', level: 3, aliases: ['Dr. Lee', 'J'] }),
  character('P8'),
);

/** A cue whose three versions all say the same thing. */
const cue = (text, extra = {}) => ({
  id: 'q_000001',
  slot: 'g_0001',
  start: 10,
  end: 14,
  kind: 'visual',
  priority: 2,
  brief: text,
  standard: text,
  detailed: text,
  people: [],
  status: 'ai',
  by: 'ai',
  ...extra,
});

/** A cue with one version only, so a violation is reported once. */
const one = (text, extra = {}) => cue('', { standard: text, ...extra });

const types = (list) => list.map((v) => v.type);
const details = (list, type) => list.filter((v) => v.type === type).map((v) => v.detail);

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

describe('normalizeTokens', () => {
  it.each([
    ['full-width braces', '｛P3｝走到窗边', '{P3}走到窗边'],
    ['spaces inside the braces', '{ P3 } walks in', '{P3} walks in'],
    ['a space after the letter', '{P 3} walks in', '{P3} walks in'],
    ['an ideographic space inside', '{　P3　}走到窗边', '{P3}走到窗边'],
    ['lower case', '{p3} walks in', '{P3} walks in'],
    ['full-width letter and digit', '{Ｐ３}走到窗边', '{P3}走到窗边'],
    ['everything at once', '｛ ｐ１２ ｝坐下', '{P12}坐下'],
    ['one brace of each width', '{P3｝和｛P4}', '{P3}和{P4}'],
    ['leading zeros', '{P03} sits', '{P3} sits'],
  ])('%s becomes {P3}', (_, text, expected) => {
    expect(normalizeTokens(text)).toBe(expected);
  });

  it('normalises every token of a text', () => {
    expect(normalizeTokens('｛P1｝把信递给{ p3 }，{P1}转身。')).toBe('{P1}把信递给{P3}，{P1}转身。');
  });

  it('leaves a well-formed token and plain text as they are', () => {
    expect(normalizeTokens('{P3} walks to the window.')).toBe('{P3} walks to the window.');
    expect(normalizeTokens('门开了。')).toBe('门开了。');
  });

  it.each(['{x}', '{ }', '{Bob}', '{P}', '{PX}', 'function () {}', '｛笑｝', '{3}', '{P1234567}'])('leaves other braces alone: %s', (text) => {
    expect(normalizeTokens(text)).toBe(text);
  });

  it('does not put braces around a bare id', () => {
    expect(normalizeTokens('P3 走到窗边')).toBe('P3 走到窗边');
  });

  it('returns an empty string for no text, and a string for anything else', () => {
    expect(normalizeTokens('')).toBe('');
    expect(normalizeTokens(null)).toBe('');
    expect(normalizeTokens(undefined)).toBe('');
    expect(normalizeTokens(42)).toBe('42');
  });
});

describe('violations: unknown tokens', () => {
  it('finds nothing in a clean cue, in Chinese and in English', () => {
    expect(violations(cue('{P3} 走到窗边，{P1} 抬头看她。'), cast)).toEqual([]);
    expect(violations(cue('{P3} walks to the window. {P1} looks up.'), cast)).toEqual([]);
  });

  it('reports a token whose id is not in the cast', () => {
    expect(violations(one('{P99} 走到窗边。'), cast)).toEqual([{ type: 'unknown-token', detail: 'P99', field: 'standard' }]);
    expect(violations(one('{P99} walks in.'), cast)).toEqual([{ type: 'unknown-token', detail: 'P99', field: 'standard' }]);
  });

  it('reports a token that is in the cast but not in the legend of the section', () => {
    expect(violations(one('{P3} 走到窗边，{P1} 抬头。'), cast, { legendIds: ['P1'] })).toEqual([
      { type: 'unknown-token', detail: 'P3', field: 'standard' },
    ]);
    expect(violations(one('{P3} 走到窗边。'), cast, { legendIds: new Set(['P1', 'P3']) })).toEqual([]);
    expect(violations(one('{P3} 走到窗边。'), cast, { legendIds: [] })).toEqual([{ type: 'unknown-token', detail: 'P3', field: 'standard' }]);
  });

  it('checks the cast only when no legend is given', () => {
    expect(violations(one('{P8} 走到窗边。'), cast)).toEqual([]);
    expect(violations(one('{P8} 走到窗边。'), cast, {})).toEqual([]);
    expect(violations(one('{P8} 走到窗边。'), cast, null)).toEqual([]);
    expect(violations(one('{P8} 走到窗边。'), cast, { legendIds: null })).toEqual([]);
  });

  it('checks brief, standard and detailed, and names the field', () => {
    const found = violations(cue('{P99} 坐下。'), cast);
    expect(found).toEqual([
      { type: 'unknown-token', detail: 'P99', field: 'brief' },
      { type: 'unknown-token', detail: 'P99', field: 'standard' },
      { type: 'unknown-token', detail: 'P99', field: 'detailed' },
    ]);
    expect(violations(cue('{P3} 坐下。', { detailed: '{P3} 在 {P42} 身边坐下。' }), cast)).toEqual([
      { type: 'unknown-token', detail: 'P42', field: 'detailed' },
    ]);
  });

  it('reports an id once per field however often it is written', () => {
    expect(violations(one('{P99} 看着 {P99} 的影子，{P98} 走开。'), cast)).toEqual([
      { type: 'unknown-token', detail: 'P99', field: 'standard' },
      { type: 'unknown-token', detail: 'P98', field: 'standard' },
    ]);
  });

  it('reads a full-width or spaced token as a token', () => {
    expect(violations(one('｛P3｝走到窗边，{ p1 }抬头。'), cast)).toEqual([]);
    expect(violations(one('｛Ｐ９９｝走到窗边。'), cast)).toEqual([{ type: 'unknown-token', detail: 'P99', field: 'standard' }]);
  });

  it('reports {P0} and a token checked against no cast at all', () => {
    expect(violations(one('{P0} 走到窗边。'), cast)).toEqual([{ type: 'unknown-token', detail: 'P0', field: 'standard' }]);
    expect(violations(one('{P3} 走到窗边。'), undefined)).toEqual([{ type: 'unknown-token', detail: 'P3', field: 'standard' }]);
    expect(violations(one('{P3} 走到窗边。'), { characters: 'none' })).toEqual([{ type: 'unknown-token', detail: 'P3', field: 'standard' }]);
  });

  it('reports a brace that is not a token: the name gate would not speak it', () => {
    expect(violations(one('{Bob} waves.'), cast)).toEqual([{ type: 'unknown-token', detail: '{Bob}', field: 'standard' }]);
    expect(violations(one('{P} 走到窗边。'), cast)).toEqual([{ type: 'unknown-token', detail: '{P}', field: 'standard' }]);
    expect(types(violations(one('{P3 走到窗边。'), cast))).toEqual(['unknown-token', 'bare-id']);
  });

  it('reports a brace of any width that is not a token: the name gate silences it all the same', () => {
    const stray = (text) => violations(one(text), cast);
    expect(stray('｛长发女人｝走到窗边。')).toEqual([{ type: 'unknown-token', detail: '｛长发女人｝', field: 'standard' }]);
    expect(stray('｛P｝ 走到窗边。')).toEqual([{ type: 'unknown-token', detail: '｛P｝', field: 'standard' }]);
    expect(stray('｛P 1 2｝走到窗边。')).toEqual([{ type: 'unknown-token', detail: '｛P 1 2｝', field: 'standard' }]);
    expect(stray('走到窗边｝。')).toEqual([{ type: 'unknown-token', detail: '｝', field: 'standard' }]);
    expect(stray('｛走到窗边。')).toEqual([{ type: 'unknown-token', detail: '｛', field: 'standard' }]);
    expect(stray('{长发女人｝走到窗边。')).toEqual([{ type: 'unknown-token', detail: '{长发女人｝', field: 'standard' }]);
    // The small and the vertical forms fold to braces too (NFKC), so the name gate would not speak them.
    for (const text of ['｛长发女人｝走到窗边。', '﹛笑﹜走到窗边。', '︷笑︸走到窗边。', '走到窗边﹜。', '︷走到窗边。']) {
      expect(hasResidue(text), text).toBe(true);
      expect(types(stray(text)), text).toEqual(['unknown-token']);
    }
    expect(stray('﹛笑﹜走到窗边。')[0].detail).toBe('﹛笑﹜');
    // A real token in full-width braces is still a token.
    expect(stray('｛P3｝走到窗边。')).toEqual([]);
  });

  it('lets braces stand in quoted on-screen text', () => {
    expect(violations(one('屏幕上显示「if (x) { return; }」。'), cast)).toEqual([]);
    expect(violations(one('if (x) { return; }', { kind: 'text', onScreenText: 'if (x) { return; }' }), cast)).toEqual([]);
  });

  it('checks a token even inside a quotation: it is filled in wherever it stands', () => {
    expect(violations(one('牌子上写着「{P99}」。'), cast)).toEqual([{ type: 'unknown-token', detail: 'P99', field: 'standard' }]);
  });
});

describe('violations: an id or a mark named in the open', () => {
  it.each([
    ['P3 走到窗边。', 'P3'],
    ['P3 walks to the window.', 'P3'],
    ['（P3）走到窗边。', 'P3'],
    ['【P3】站在门口。', 'P3'],
    ['[P12] sits down.', 'P12'],
    ['Ｐ３走到窗边。', 'Ｐ３'],
    ['p3 walks in.', 'p3'],
    ['3 号人物走到窗边。', '3 号人物'],
    ['3号框里的人转身。', '3号框'],
    ['三号人物坐下。', '三号人物'],
    ['十二号角色离开。', '十二号角色'],
    ['２号标记旁的人挥手。', '２号标记'],
    ['3号男子走向门口。', '3号男子'],
    ['人物 3 走到窗边。', '人物 3'],
    ['她脸上有一个红色的框。', '红色的框'],
    ['红框走到窗边。', '红框'],
    ['红色框中的女人坐下。', '红色框'],
    ['蓝框里的人挥手。', '蓝框'],
    ['天蓝色的方框里是一个孩子。', '蓝色的方框'],
    ['黑框里的男人转身。', '黑框'],
    ['方框里的人转过身。', '框里的人'],
    ['The red box walks to the window.', 'red box'],
    ['The person in the sky blue box waves.', 'blue box'],
    ['The woman in the green bounding box sits.', 'green bounding box'],
    ['The bounding box follows him.', 'bounding box'],
    ['Box 2 opens the door.', 'Box 2'],
    ['Then person 2 turns around.', 'person 2'],
    ['Person #2 turns around.', 'Person #2'],
    ['Person number 4 leaves.', 'Person number 4'],
    ['Next to her, mark B sits down.', 'mark B'],
    ['The man boxed in red leaves.', 'boxed in red'],
    ['The red boxes move closer.', 'red boxes'],
    ['The yellow rectangle is on the left.', 'yellow rectangle'],
    ['The grey-coloured box leaves.', 'grey-coloured box'],
    ['A red box surrounds her face.', 'A red box'],
    ['A woman with a blue box around her face smiles.', 'a blue box'],
    ['A man, a green box drawn over him, waits.', 'a green box'],
  ])('reports %s', (text, detail) => {
    const found = violations(one(text), cast);
    expect(found).toContainEqual({ type: 'bare-id', detail, field: 'standard' });
    expect(types(found).every((type) => type === 'bare-id')).toBe(true);
  });

  it.each([
    '3 号线列车进站。',
    '{P1} 和 {P3} 走进 3 号楼。',
    '7 号球员带球突破。',
    '日历翻到 5 月 3 号。',
    '{P3} 戴着黑框眼镜。',
    '{P3} 摘下黑色框架眼镜。',
    '{P3} 戴上黑色边框的眼镜。',
    '相框里的女人在微笑。',
    '门框里的人影一闪而过。',
    '红色的门框上贴着春联。',
    '白色画框挂在墙上。',
    '画面中有人物3个。',
    '她打开 MP3 播放器。',
    '{P3} opens a small red box.',
    '{P3} hands {P1} a blue box.',
    'An orange box sits on the shelf.',
    '{P3} marks a spot on the map.',
    'They mark a spot on the map.',
    'The person I saw leaves.',
    'Two people carry a box.',
    'A boxer enters the ring.',
    'Three persons wait.',
  ])('does not report ordinary text: %s', (text) => {
    expect(violations(one(text), cast)).toEqual([]);
  });

  it('reports each form once per field, in every field that has it', () => {
    expect(violations(cue('P3 看着 P3 的倒影。'), cast)).toEqual([
      { type: 'bare-id', detail: 'P3', field: 'brief' },
      { type: 'bare-id', detail: 'P3', field: 'standard' },
      { type: 'bare-id', detail: 'P3', field: 'detailed' },
    ]);
  });

  it('does not mistake a token for a bare id', () => {
    expect(violations(one('{P3}走到窗边，{P1}抬头。'), cast)).toEqual([]);
    expect(violations(one('{P3} P1 走到窗边。'), cast)).toEqual([{ type: 'bare-id', detail: 'P1', field: 'standard' }]);
  });

  describe('a parking sign that says P3', () => {
    it('is a bare id when the description says it in its own voice', () => {
      expect(violations(one('{P1} 把车停进 P3 停车场。'), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
      expect(violations(one('{P1} parks at P3.'), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
    });

    it.each([
      '{P1} 把车停在「P3 停车场」的牌子下。',
      '{P1} 把车停在『P3 停车场』的牌子下。',
      '{P1} 把车停在“P3 停车场”的牌子下。',
      '{P1} 把车停在"P3 停车场"的牌子下。',
      "{P1} 把车停在'P3 停车场'的牌子下。",
      '{P1} 把车停在‘P3’的牌子下。',
      'A sign reads "P3 Parking".',
      "A sign reads 'P3 Parking' above the ramp.",
      'A sign reads “P3 Parking”.',
    ])('is legitimate inside quotation marks: %s', (text) => {
      expect(violations(one(text), cast)).toEqual([]);
    });

    it('is legitimate where the text repeats the on-screen text of the cue', () => {
      const sign = { kind: 'text', onScreenText: 'P3 停车场' };
      expect(violations(cue('标牌：P3 停车场', sign), cast)).toEqual([]);
      expect(violations(one('{P1} 把车停进 P3 停车场。', { onScreenText: 'P3 停车场' }), cast)).toEqual([]);
      // The spacing and the case of the transcription may differ from the sentence.
      expect(violations(one('标牌：p3停车场', sign), cast)).toEqual([]);
    });

    it('is legitimate when the text repeats one line of the on-screen text, or is a piece of it', () => {
      const sign = { kind: 'text', onScreenText: 'P3 停车场 / 入口 Entrance' };
      expect(violations(one('指示牌写着 P3 停车场，箭头指向入口 Entrance。', sign), cast)).toEqual([]);
      expect(violations(one('P3', { kind: 'text', onScreenText: 'P3 停车场 请按顺序停放' }), cast)).toEqual([]);
      // A transcription that kept its line breaks.
      expect(violations(one('标牌：P3 停车场', { kind: 'text', onScreenText: 'P3\n停车场' }), cast)).toEqual([]);
      expect(violations(one('箭头指向入口', { kind: 'text', onScreenText: 'P3 停车场\n入口' }), cast)).toEqual([]);
    });

    it('is not excused by on-screen text the sentence does not repeat', () => {
      expect(violations(one('P3 走到出口 Exit 旁。', { onScreenText: '出口 Exit' }), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
      expect(violations(one('P3 走进停车场。', { onScreenText: 'P3 停车场 / 入口' }), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
      expect(violations(one('P3 走到窗边。', { onScreenText: '' }), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
      expect(violations(one('P3 走到窗边。', { onScreenText: 42 }), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
    });

    it('is still a bare id outside the quotation, and when the quotation never closes', () => {
      expect(violations(one('P3 站在「P3 停车场」的牌子下。'), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
      expect(violations(one('牌子上写着「P3 停车场。'), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
      expect(violations(one('标牌：P3 停车场', { kind: 'text' }), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
    });

    it('is not excused by on-screen text of a single character', () => {
      expect(violations(one('P3 走到窗边。', { onScreenText: 'P' }), cast)).toEqual([{ type: 'bare-id', detail: 'P3', field: 'standard' }]);
    });
  });
});

describe('violations: names', () => {
  it('reports a cast name written in a visual cue', () => {
    expect(violations(one('马修走到窗边。'), cast)).toEqual([{ type: 'name-leak', detail: '马修', field: 'standard' }]);
    expect(violations(one('{P1} 把信递给老陈。'), cast)).toEqual([{ type: 'name-leak', detail: '老陈', field: 'standard' }]);
  });

  it('reports an alias, as an object or as a plain string', () => {
    expect(violations(one('Matthew walks to the window.'), cast)).toEqual([{ type: 'name-leak', detail: 'Matthew', field: 'standard' }]);
    expect(violations(one('Dr. Lee walks in.'), cast)).toEqual([{ type: 'name-leak', detail: 'Dr. Lee', field: 'standard' }]);
  });

  it('names the field, once per field', () => {
    expect(violations(cue('{P3} 坐下。', { detailed: '马修在马修的椅子上坐下。' }), cast)).toEqual([
      { type: 'name-leak', detail: '马修', field: 'detailed' },
    ]);
    expect(violations(cue('马修坐下。'), cast).map((v) => v.field)).toEqual(['brief', 'standard', 'detailed']);
  });

  it('does not check a name or alias of one character or one letter', () => {
    // 陈 is P6's name and 修 an alias of P3: both are in too many words.
    expect(violations(one('陈旧的木门打开，工人在修路。'), cast)).toEqual([]);
    expect(violations(one('J walks past a J-shaped hook.'), cast)).toEqual([]);
  });

  it('reports a name that is also a common word: 小雨 in "下着小雨" (the documented cost)', () => {
    expect(violations(one('外面下着小雨。'), cast)).toEqual([{ type: 'name-leak', detail: '小雨', field: 'standard' }]);
  });

  it('matches a Latin name as a whole word only', () => {
    expect(violations(one('Matthews Road is empty.'), cast)).toEqual([]);
    expect(violations(one('A sign for StMatthew hangs there.'), cast)).toEqual([]);
    expect(types(violations(one("Matthew's coat hangs by the door."), cast))).toEqual(['name-leak']);
    expect(types(violations(one('The coat is Matthew’s.'), cast))).toEqual(['name-leak']);
    expect(types(violations(one('Matthew走到窗边。'), cast))).toEqual(['name-leak']);
    expect(types(violations(one('走到窗边的是Matthew。'), cast))).toEqual(['name-leak']);
  });

  it('matches a Latin name written as a name: a capital, or all capitals', () => {
    expect(types(violations(one('Rose smiles.'), cast))).toEqual(['name-leak']);
    expect(types(violations(one('ROSE smiles.'), cast))).toEqual(['name-leak']);
    expect(violations(one('A rose lies on the table.'), cast)).toEqual([]);
    expect(violations(one('The sun rose over the hill.'), cast)).toEqual([]);
  });

  it('matches in any case a name the cast writes without a capital', () => {
    const lower = castOf(character('P1', { name: 'van der Berg' }));
    expect(types(violations(one('Van der Berg sits down.'), lower))).toEqual(['name-leak']);
    expect(types(violations(one('Then van  der berg sits down.'), lower))).toEqual(['name-leak']);
  });

  it('matches a Chinese name anywhere', () => {
    expect(types(violations(one('{P1} 看见了马修的背影。'), cast))).toEqual(['name-leak']);
    expect(details(violations(one('老陈和马修一起走。'), cast), 'name-leak')).toEqual(['老陈', '马修']);
  });

  it('reports a name a person rejected: it is still what the dialogue says', () => {
    let people = addCharacter(createCast(), { descriptor: { en: 'woman with long hair' } }).cast;
    people = addEvidence(people, 'P1', { t: 10, kind: 'vocative', name: 'Matthew' });
    const leak = [{ type: 'name-leak', detail: 'Matthew', field: 'standard' }];
    expect(violations(one('Matthew walks in.'), people)).toEqual(leak);
    const refused = rejectName(people, 'P1', 'Matthew');
    expect(refused.characters[0]).toMatchObject({ name: null, level: 0 });
    expect(violations(one('Matthew walks in.'), refused)).toEqual(leak);
    // A name carried without evidence and then refused is kept in the refusal.
    const carried = rejectName(addCharacter(createCast(), { name: '马修', level: 2 }).cast, 'P1', '马修');
    expect(carried.characters[0].name).toBeNull();
    expect(violations(one('马修走进来。'), carried)).toEqual([{ type: 'name-leak', detail: '马修', field: 'standard' }]);
  });

  it('reports a clue name that is not the one that stands', () => {
    let people = addCharacter(createCast(), {}).cast;
    for (const [t, name] of [[10, 'Matthew'], [200, 'Matthew'], [300, 'Mark']]) people = addEvidence(people, 'P1', { t, kind: 'vocative', name });
    expect(people.characters[0]).toMatchObject({ name: 'Matthew', level: 2 });
    expect(details(violations(one('Mark sits.'), people), 'name-leak')).toEqual(['Mark']);
    expect(details(violations(one('Matthew sits.'), people), 'name-leak')).toEqual(['Matthew']);
    // Two spellings of one name are one name: reported once.
    const spelled = addEvidence(people, 'P1', { t: 7000, kind: 'credits', name: 'MATTHEW' });
    expect(violations(one('Matthew sits.'), spelled)).toEqual([{ type: 'name-leak', detail: 'Matthew', field: 'standard' }]);
    // Evidence that is not a list of clues says nothing.
    expect(violations(one('Mark sits.'), castOf(character('P1', { evidence: 'Mark' }), character('P2', { evidence: [null, 'Mark', { name: 7 }, {}] })))).toEqual([]);
  });

  it('reports one word of a longer name: "Mary" of "Aunt Mary", "Lee" of "Mr. Lee"', () => {
    let locked = addCharacter(createCast(), { descriptor: { en: 'old woman' }, spoilerLock: true }).cast;
    locked = confirmName(locked, 'P1', { name: 'Aunt Mary', by: 'ear' });
    expect(violations(one('Mary walks in.'), locked)).toEqual([{ type: 'name-leak', detail: 'Mary', field: 'standard' }]);
    // The whole name is reported once, not once more for its part.
    expect(violations(one('Aunt Mary walks in.'), locked)).toEqual([{ type: 'name-leak', detail: 'Aunt Mary', field: 'standard' }]);
    expect(details(violations(one('Aunt Mary walks in. Mary sits.'), locked), 'name-leak')).toEqual(['Aunt Mary', 'Mary']);
    // What the gate keeps back for the token, it must not let through as a word.
    const spoken = (text) => renderScript({ lang: 'en', cues: [{ id: 'q', start: 5, end: 9, standard: text }] }, locked).cues[0].standard;
    expect(spoken('{P1} walks in.')).toBe('The old woman walks in.');

    const hushed = castOf(character('P1', { name: 'Mr. Lee', level: 3, neverName: true }), character('P2', { name: 'Old Tom', level: 3 }), character('P3', { name: '玛丽·安', level: 3 }), character('P4', { aliases: ['Doctor Emily Stone'] }));
    expect(details(violations(one('Lee opens the door.'), hushed), 'name-leak')).toEqual(['Lee']);
    expect(details(violations(one('Mr. Lee opens the door.'), hushed), 'name-leak')).toEqual(['Mr. Lee']);
    expect(details(violations(one('Tom waits.'), hushed), 'name-leak')).toEqual(['Tom']);
    expect(details(violations(one('玛丽走进来。'), hushed), 'name-leak')).toEqual(['玛丽']);
    expect(details(violations(one('Emily and Stone wait.'), hushed), 'name-leak')).toEqual(['Emily', 'Stone']);
    // A part is a whole word written as a name, like any name.
    expect(violations(one('A stone wall. The valley lies in the lee of the hill. Leeward, Tommy waits.'), hushed)).toEqual([]);
    // One character of a name is in too many words: 安 of 玛丽·安.
    expect(violations(one('安静的房间。'), hushed)).toEqual([]);
  });

  it('does not take a title, an article or a particle of a longer name for a name', () => {
    const titled = castOf(
      character('P1', { name: 'Aunt Mary' }),
      character('P2', { name: 'Old Tom' }),
      character('P3', { name: 'Alexander the Great' }),
      character('P4', { name: 'Maria de la Cruz' }),
      character('P5', { name: 'The Dude' }),
      character('P6', { name: 'Dr. Van Helsing' }),
      character('P7', { name: 'Mr. Lee' }),
    );
    for (const text of [
      'A man opens the door.',
      'The door opens. Old furniture fills the room.',
      'Aunt and uncle wait by the car.',
      'Doctor and nurse walk past. Mr. and Mrs. Smith wave.',
      'The great hall is empty; de la is not a word.',
      'Van after van drives by.',
    ]) {
      expect(violations(one(text), titled), text).toEqual([]);
    }
    expect(details(violations(one('Cruz opens the door. Helsing, Alexander and Dude wait.'), titled), 'name-leak')).toEqual(['Alexander', 'Cruz', 'Dude', 'Helsing']);
    // The same word as the last one of a name is the name.
    const surnames = castOf(character('P1', { name: 'Mr. Young' }), character('P2', { name: 'Stephen King' }), character('P3', { name: 'Old Tom' }));
    expect(details(violations(one('Then Young opens the door and King nods.'), surnames), 'name-leak')).toEqual(['Young', 'King']);
    expect(violations(one('A young man bows to the king. Old Stephen is not there.'), surnames).map((v) => v.detail)).toEqual(['Stephen']);
  });

  it('checks a kind text cue too: only a name its own on-screen text carries may stand there', () => {
    // The sign itself, transcribed.
    expect(violations(cue('马修面包店', { kind: 'text', onScreenText: '马修面包店' }), cast)).toEqual([]);
    expect(violations(cue('Matthew Bakery', { kind: 'text', onScreenText: 'Matthew Bakery' }), cast)).toEqual([]);
    expect(violations(one('Sign: Matthew’s Bakery.', { kind: 'text', onScreenText: "Matthew's Bakery" }), cast)).toEqual([]);
    // The short version says a part of a long sign that carries the name.
    expect(violations(one('Letter: Dear Matthew, I am leaving tonight.', { kind: 'text', onScreenText: 'Dear Matthew, I am leaving tonight. Do not look for me.' }), cast)).toEqual([]);
    // Quoted, the name is quoted, with or without a transcription.
    expect(violations(one('招牌：「马修面包店」', { kind: 'text' }), cast)).toEqual([]);
    // A name in the cue's own words, which no on-screen text carries: the kind does not excuse it.
    expect(violations(one('马修走进来。', { kind: 'text', onScreenText: '出口' }), cast)).toEqual([{ type: 'name-leak', detail: '马修', field: 'standard' }]);
    expect(violations(one('Matthew walks in.', { kind: 'text', onScreenText: 'EXIT' }), cast)).toEqual([{ type: 'name-leak', detail: 'Matthew', field: 'standard' }]);
    expect(violations(cue('马修面包店', { kind: 'text' }), cast).map((v) => v.type)).toEqual(['name-leak', 'name-leak', 'name-leak']);
    expect(types(violations(one('Matthew Bakery', { kind: 'text' }), cast))).toEqual(['name-leak']);
    expect(types(violations(one("Rose's phone: Call me now", { kind: 'text', onScreenText: 'Call me now' }), cast))).toEqual(['name-leak']);
    // A name on the screen excuses that name, not another.
    expect(details(violations(one('老陈看着马修面包店的招牌。', { kind: 'text', onScreenText: '马修面包店' }), cast), 'name-leak')).toEqual(['老陈']);
  });

  it('does not let a spoiler-locked name through a text cue to the listener', () => {
    let locked = addCharacter(createCast(), { descriptor: { en: 'old woman' }, spoilerLock: true }).cast;
    locked = confirmName(locked, 'P1', { name: 'Aunt Mary', by: 'ear' });
    const leaked = cue('Aunt Mary walks in.', { kind: 'text', onScreenText: 'EXIT' });
    expect(violations(leaked, locked).map((v) => v.type)).toEqual(['name-leak', 'name-leak', 'name-leak']);
    expect(verifyCue(leaked, { cast: locked }).status).toBe('needs-repair');
  });

  it.each(['visual', 'intro', 'extended'])('checks a kind %s cue', (kind) => {
    expect(types(violations(one('马修走到窗边。', { kind }), cast))).toEqual(['name-leak']);
  });

  it.each([
    '{P3} 走进「马修面包店」。',
    '{P3} 走进『马修面包店』。',
    '{P3} 走进“马修面包店”。',
    '{P3} 走进"马修面包店"。',
    "{P3} 走进'马修面包店'。",
    '{P3} 走进‘马修面包店’。',
    '海报上是《马修传》。',
    '{P3} walks into "Matthew Bakery".',
    "{P3} walks into 'Matthew Bakery'.",
    '{P3} walks into “Matthew Bakery”.',
    '{P3} walks into ‘Matthew’s Bakery’.',
  ])('does not report a name inside quotation marks: %s', (text) => {
    expect(violations(one(text), cast)).toEqual([]);
  });

  it('does not report a name inside the on-screen text of the cue: the shop sign 马修面包店', () => {
    const sign = { onScreenText: '马修面包店' };
    expect(violations(cue('{P3} 走进马修面包店。', sign), cast)).toEqual([]);
    expect(violations(one('{P3} 走进「马修面包店」，店里亮着灯。', sign), cast)).toEqual([]);
    expect(violations(one('{P3} walks into Matthew Bakery.', { onScreenText: 'MATTHEW BAKERY' }), cast)).toEqual([]);
  });

  it('still reports the name outside the on-screen text and outside the quotation', () => {
    expect(violations(one('马修走进马修面包店。', { onScreenText: '马修面包店' }), cast)).toEqual([
      { type: 'name-leak', detail: '马修', field: 'standard' },
    ]);
    expect(violations(one('马修走进「马修面包店」。'), cast)).toEqual([{ type: 'name-leak', detail: '马修', field: 'standard' }]);
    expect(violations(one('Matthew walks into "Matthew Bakery".'), cast)).toEqual([{ type: 'name-leak', detail: 'Matthew', field: 'standard' }]);
  });

  it('does not take an apostrophe for a quotation mark', () => {
    expect(types(violations(one("The man's hat lies by Matthew, near the girls' bags."), cast))).toEqual(['name-leak']);
    expect(types(violations(one("It's Matthew's turn; she's ready."), cast))).toEqual(['name-leak']);
  });

  it("does not take the apostrophe that opens a word ('em, 'til, '90s) for an opening quotation mark", () => {
    for (const text of [
      "{P1} waves 'em over. Matthew takes the girls' bags.",
      "A '90s sedan pulls up and Matthew gets out with the boys' coats.",
      "{P1} waits 'til Matthew picks up the boys' coats.",
      "A '67 Mustang stops; Matthew reads the sign 'Exit'.",
      "{P1} tells 'em. Matthew grabs the 'Exit' sign.",
      "'Til dawn Matthew holds the girls' bags.",
      "Rock 'n' roll plays; Matthew dances by the girls' table.",
      "'Cause of the rain, Matthew waits under the boys' umbrella.",
    ]) {
      expect(details(violations(one(text), cast), 'name-leak'), text).toEqual(['Matthew']);
    }
    // A real quotation that begins like one of these words is still a quotation.
    expect(violations(one("{P1} reads the note: 'Emily and Matthew'."), cast)).toEqual([]);
    expect(violations(one("{P1} points at the sign 'Roundabout Matthew'."), cast)).toEqual([]);
  });

  it('does not let a quotation that never closes hide a name', () => {
    expect(types(violations(one('“马修走到窗边。'), cast))).toEqual(['name-leak']);
    expect(types(violations(one('"Matthew walks in.'), cast))).toEqual(['name-leak']);
  });

  it('does not take a description wrapped in quotation marks from end to end for a quotation', () => {
    expect(types(violations(one('“马修走到窗边。”'), cast))).toEqual(['name-leak']);
    expect(types(violations(one('「马修走到窗边」。'), cast))).toEqual(['name-leak']);
    expect(types(violations(one('"Matthew walks in."'), cast))).toEqual(['name-leak']);
    expect(types(violations(one(" 'Matthew walks in.' "), cast))).toEqual(['name-leak']);
    expect(types(violations(one('「P3 走到窗边」'), cast))).toEqual(['bare-id']);
    // Two quotations are not one wrapping.
    expect(violations(one('"Matthew Bakery" and "P3 Parking"'), cast)).toEqual([]);
    // A text cue may be one quotation: the sign itself.
    expect(violations(one('「P3 停车场」', { kind: 'text' }), cast)).toEqual([]);
  });

  it('ignores characters without a name, and a cast that is missing', () => {
    expect(violations(one('门开了，风吹进来。'), castOf(character('P1'), character('P2', { name: '' }), null))).toEqual([]);
    expect(violations(one('马修走到窗边。'), null)).toEqual([]);
    expect(violations(one('马修走到窗边。'), {})).toEqual([]);
  });

  it('reports every kind of violation of one text', () => {
    const found = violations(one('{P99} 和马修站在红框旁边。'), cast);
    expect(found).toEqual([
      { type: 'unknown-token', detail: 'P99', field: 'standard' },
      { type: 'bare-id', detail: '红框', field: 'standard' },
      { type: 'name-leak', detail: '马修', field: 'standard' },
    ]);
  });
});

describe('violations: a text too long to read', () => {
  const quotes = "'a ".repeat(13000);
  const words = 'ab '.repeat(8000);

  it('reports a text of more than 2000 characters as too-long and reads none of it', () => {
    expect(violations(one(words), cast)).toEqual([{ type: 'too-long', detail: '24000', field: 'standard' }]);
    expect(violations(one(`${'雨'.repeat(2000)}。`), cast)).toEqual([{ type: 'too-long', detail: '2001', field: 'standard' }]);
    // The other versions are read as always.
    expect(violations(cue('马修走进来。', { detailed: `马修${'雨'.repeat(3000)}` }), cast)).toEqual([
      { type: 'name-leak', detail: '马修', field: 'brief' },
      { type: 'name-leak', detail: '马修', field: 'standard' },
      { type: 'too-long', detail: '3002', field: 'detailed' },
    ]);
    // 2000 characters are still read.
    expect(violations(one('雨'.repeat(2000)), cast)).toEqual([]);
    expect(types(violations(one(`马修${'雨'.repeat(1998)}`), cast))).toEqual(['name-leak']);
  });

  it('does not build a pattern out of an oversized text or transcription', () => {
    // Either of these threw "Invalid regular expression" when the pattern was first used.
    expect(violations(one(words, { kind: 'text', onScreenText: 'ab / cd' }), cast)).toEqual([{ type: 'too-long', detail: '24000', field: 'standard' }]);
    expect(violations(one('a'.repeat(60000), { kind: 'text', onScreenText: 'ab / cd' }), cast)).toEqual([{ type: 'too-long', detail: '60000', field: 'standard' }]);
    expect(violations(one('hello there', { onScreenText: words }), cast)).toEqual([]);
    // An oversized transcription excuses nothing.
    expect(types(violations(one('P3 walks in.', { onScreenText: `P3 walks in. ${words}` }), cast))).toEqual(['bare-id']);
    expect(types(violations(one('Matthew Bakery', { kind: 'text', onScreenText: `Matthew Bakery ${words}` }), cast))).toEqual(['name-leak']);
  });

  it('answers at once for texts that used to take seconds, in every entry point', () => {
    const started = performance.now();
    const film = { v: 3, filmId: 'f', lang: 'en', duration: 100, slots: [], cues: [cue('{P3} walks in.', { id: 'q_000001' }), cue('', { id: 'q_000002', standard: quotes })] };
    const checked = verifyScript(film, { cast, identity: { visibleBetween: () => ['P3'], peopleBetween: () => 1 } });
    expect(checked.results.map((r) => r.status)).toEqual(['ok', 'needs-repair']);
    expect(checked.results[1].violations).toEqual([{ type: 'too-long', detail: '39000', field: 'standard' }]);
    // The text is kept as it was, and its tokens are not read.
    expect(checked.script.cues[1].standard).toBe(quotes);
    const tokens = verifyCue(cue('', { standard: `{P3}{P99}${'雨'.repeat(2500)}` }), { cast, visible: () => [] });
    expect(tokens.cue.people).toEqual([]);
    expect(tokens.status).toBe('needs-repair');
    expect(tokens.violations).toEqual([{ type: 'too-long', detail: '2509', field: 'standard' }]);
    for (const text of ['a man '.repeat(20000), '一'.repeat(40000), '「a'.repeat(40000), quotes]) {
      const before = cue('', { standard: text });
      expect(repairGeneric(before, { cast, visibleIds: ['P3'], peopleCount: 1 })).toEqual({ cue: before, repaired: false, relapse: false });
      expect(types(violations(before, cast))).toEqual(['too-long']);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('violations: input', () => {
  it('finds nothing in a cue without text, or in no cue', () => {
    expect(violations({}, cast)).toEqual([]);
    expect(violations(null, cast)).toEqual([]);
    expect(violations(cue(''), cast)).toEqual([]);
    expect(violations({ brief: null, standard: undefined, detailed: 7 }, cast)).toEqual([]);
  });

  it('does not change the cue or the cast', () => {
    const frozenCue = deepFreeze(cue('马修和 ｛P99｝ 站在红框旁边。', { onScreenText: '出口' }));
    const frozenCast = deepFreeze(castOf(character('P3', { name: '马修', aliases: [{ text: 'Matthew' }] })));
    expect(violations(frozenCue, frozenCast, { legendIds: deepFreeze(['P3']) })).toHaveLength(9);
  });
});

describe('verifyCue', () => {
  const everyone = () => ['P1', 'P3', 'P5'];

  it('passes a cue whose people are all on screen', () => {
    const result = verifyCue(cue('{P3} 走到窗边，{P1} 抬头。'), { cast, visible: everyone });
    expect(result.status).toBe('ok');
    expect(result.demoted).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.trackCheck).toBe('ok');
    expect(result.cue.people).toEqual([{ char: 'P3' }, { char: 'P1' }]);
  });

  it('looks from 3 seconds before the cue to 1 second after it', () => {
    const calls = [];
    verifyCue(cue('{P3} 走到窗边。', { start: 10, end: 14 }), { cast, visible: (t0, t1) => { calls.push([t0, t1]); return ['P3']; } });
    expect(calls).toEqual([[7, 15]]);
  });

  it('takes another window', () => {
    const calls = [];
    const visible = (t0, t1) => { calls.push([t0, t1]); return ['P3']; };
    verifyCue(cue('{P3} 走到窗边。', { start: 10, end: 14 }), { cast, visible, window: { before: 0.5, after: 2 } });
    verifyCue(cue('{P3} 走到窗边。', { start: 1, end: 2 }), { cast, visible, window: { before: 3, after: 1 } });
    // A cue without an end is looked at around its start.
    verifyCue(cue('{P3} 走到窗边。', { start: 20, end: undefined }), { cast, visible });
    // Half a window: the other half keeps its default.
    verifyCue(cue('{P3} 走到窗边。', { start: 10, end: 14 }), { cast, visible, window: { before: 5 } });
    verifyCue(cue('{P3} 走到窗边。', { start: 10, end: 14 }), { cast, visible, window: { before: 0, after: 0 } });
    expect(calls).toEqual([[9.5, 16], [-2, 3], [17, 21], [5, 15], [10, 14]]);
  });

  it('demotes a token whose character is not seen in the window', () => {
    const result = verifyCue(cue('{P3} 走到窗边，{P1} 抬头。'), { cast, visible: () => ['P1'] });
    expect(result.status).toBe('demoted');
    expect(result.demoted).toEqual(['P3']);
    expect(result.trackCheck).toBe('failed');
    expect(result.cue.people).toEqual([{ char: 'P3', demoted: true }, { char: 'P1' }]);
    expect(result.violations).toEqual([]);
  });

  it('demotes everyone when nobody is on screen', () => {
    const result = verifyCue(cue('{P3} walks in. {P1} looks up.'), { cast, visible: () => [] });
    expect(result.demoted).toEqual(['P3', 'P1']);
    expect(result.cue.people).toEqual([{ char: 'P3', demoted: true }, { char: 'P1', demoted: true }]);
    expect(result.status).toBe('demoted');
  });

  it('takes a Set, an array, or the entries of an identity provider', () => {
    expect(verifyCue(cue('{P3} 走到窗边。'), { cast, visible: () => new Set(['P3']) }).status).toBe('ok');
    expect(verifyCue(cue('{P3} 走到窗边。'), { cast, visible: () => new Set(['P1']) }).status).toBe('demoted');
    expect(verifyCue(cue('{P3} 走到窗边。'), { cast, visible: () => [{ characterId: 'P3', box: [0, 0, 10, 10], conf: 0.9 }] }).status).toBe('ok');
  });

  describe('when the identity mode cannot tell who is on screen', () => {
    it('does no track check and demotes every person', () => {
      const result = verifyCue(cue('{P3} 走到窗边，{P1} 抬头。'), { cast, visible: () => null });
      expect(result.trackCheck).toBe('n/a');
      expect(result.demoted).toEqual(['P3', 'P1']);
      expect(result.status).toBe('demoted');
      expect(result.cue.people).toEqual([{ char: 'P3', demoted: true }, { char: 'P1', demoted: true }]);
    });

    it('demotes nobody when names are allowed without tracks', () => {
      const result = verifyCue(cue('{P3} 走到窗边，{P1} 抬头。'), { cast, visible: () => null, allowNamesWithoutTracks: true });
      expect(result.trackCheck).toBe('n/a');
      expect(result.demoted).toEqual([]);
      expect(result.status).toBe('ok');
      expect(result.cue.people).toEqual([{ char: 'P3' }, { char: 'P1' }]);
    });

    it('treats a missing visible() the same way', () => {
      expect(verifyCue(cue('{P3} 走到窗边。'), { cast }).trackCheck).toBe('n/a');
      expect(verifyCue(cue('{P3} 走到窗边。'), { cast }).demoted).toEqual(['P3']);
      expect(verifyCue(cue('{P3} 走到窗边。'), { cast, allowNamesWithoutTracks: true }).status).toBe('ok');
    });

    it('does not let allowNamesWithoutTracks excuse a character the tracks say is absent', () => {
      const result = verifyCue(cue('{P3} 走到窗边。'), { cast, visible: () => [], allowNamesWithoutTracks: true });
      expect(result.trackCheck).toBe('failed');
      expect(result.demoted).toEqual(['P3']);
    });
  });

  it('rebuilds people from the tokens of the three texts, in order of first mention', () => {
    const result = verifyCue(
      cue('', { brief: '{P3} 坐下。', standard: '{P3} 在 {P1} 身边坐下。', detailed: '{P5} 看着 {P3} 在 {P1} 身边坐下。' }),
      { cast, visible: everyone },
    );
    expect(result.cue.people).toEqual([{ char: 'P3' }, { char: 'P1' }, { char: 'P5' }]);
  });

  it('keeps the tracks of people who are still in the text and drops the others', () => {
    const before = cue('{P3} 走到窗边。', {
      people: [{ char: 'P1', tracks: ['t9'] }, { char: 'P3', tracks: ['t1', 't4'], demoted: true }],
    });
    const result = verifyCue(before, { cast, visible: everyone });
    expect(result.cue.people).toEqual([{ char: 'P3', tracks: ['t1', 't4'] }]);
    expect(result.cue.people[0].tracks).not.toBe(before.people[1].tracks);
  });

  it('sets demoted afresh: a person seen now is no longer demoted', () => {
    const before = cue('{P3} 走到窗边。', { people: [{ char: 'P3', demoted: true }] });
    expect(verifyCue(before, { cast, visible: () => ['P3'] }).cue.people).toEqual([{ char: 'P3' }]);
    expect(verifyCue(before, { cast, visible: () => [] }).cue.people).toEqual([{ char: 'P3', demoted: true }]);
  });

  it('has no people for a cue without tokens', () => {
    const result = verifyCue(cue('门开了，风吹进来。', { people: [{ char: 'P3' }] }), { cast, visible: () => [] });
    expect(result.cue.people).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.trackCheck).toBe('ok');
  });

  it('normalises the tokens of the cue it returns', () => {
    const result = verifyCue(cue('｛P3｝走到窗边，{ p1 }抬头。'), { cast, visible: everyone });
    expect(result.cue.brief).toBe('{P3}走到窗边，{P1}抬头。');
    expect(result.cue.standard).toBe('{P3}走到窗边，{P1}抬头。');
    expect(result.cue.detailed).toBe('{P3}走到窗边，{P1}抬头。');
    expect(result.cue.people).toEqual([{ char: 'P3' }, { char: 'P1' }]);
    expect(result.status).toBe('ok');
  });

  it('needs repair when the text has violations, whoever is on screen', () => {
    const leak = verifyCue(cue('马修走到窗边。'), { cast, visible: everyone });
    expect(leak.status).toBe('needs-repair');
    expect(leak.violations).toEqual([
      { type: 'name-leak', detail: '马修', field: 'brief' },
      { type: 'name-leak', detail: '马修', field: 'standard' },
      { type: 'name-leak', detail: '马修', field: 'detailed' },
    ]);
    const unknown = verifyCue(one('{P99} walks in.'), { cast, visible: everyone });
    expect(unknown.status).toBe('needs-repair');
    expect(unknown.demoted).toEqual(['P99']);
    expect(unknown.cue.people).toEqual([{ char: 'P99', demoted: true }]);
    expect(verifyCue(one('The red box walks in.'), { cast, visible: everyone }).status).toBe('needs-repair');
  });

  it('checks the legend of the section', () => {
    const result = verifyCue(one('{P3} 走到窗边。'), { cast, visible: everyone, legendIds: ['P1'] });
    expect(result.status).toBe('needs-repair');
    expect(result.violations).toEqual([{ type: 'unknown-token', detail: 'P3', field: 'standard' }]);
    expect(verifyCue(one('{P3} 走到窗边。'), { cast, visible: everyone, legendIds: ['P1', 'P3'] }).status).toBe('ok');
  });

  it('puts needs-repair before demoted', () => {
    const result = verifyCue(one('{P3} 和马修走到窗边。'), { cast, visible: () => [] });
    expect(result.status).toBe('needs-repair');
    expect(result.demoted).toEqual(['P3']);
  });

  it('returns a new cue, keeps its other fields and changes nothing it was given', () => {
    const before = deepFreeze(cue('｛P3｝走到窗边。', {
      people: [{ char: 'P3', tracks: ['t1'] }],
      onScreenText: '出口',
      confidence: 'high',
      scene: 4,
      clip: { file: 'a.wav', dur: 2, voice: 'v', textHash: '00000000', version: 'standard' },
    }));
    const frozenCast = deepFreeze(castOf(character('P3', { name: '马修' })));
    const result = verifyCue(before, { cast: frozenCast, visible: () => deepFreeze(['P3']), window: deepFreeze({ before: 3, after: 1 }), legendIds: deepFreeze(['P3']) });
    expect(result.cue).not.toBe(before);
    expect(result.cue).toEqual({ ...before, brief: '{P3}走到窗边。', standard: '{P3}走到窗边。', detailed: '{P3}走到窗边。' });
    expect(before.brief).toBe('｛P3｝走到窗边。');
    expect(result.cue.status).toBe('ai');
  });

  it('works without options', () => {
    const result = verifyCue(cue('门开了。'));
    expect(result).toEqual({ cue: cue('门开了。'), status: 'ok', demoted: [], violations: [], trackCheck: 'n/a' });
    expect(verifyCue(cue('门开了。'), null)).toEqual(result);
    // No cast: every token is unknown.
    expect(verifyCue(one('{P3} 走到窗边。'), { visible: () => ['P3'] }).status).toBe('needs-repair');
  });

  it('gives a cue without text no people', () => {
    const result = verifyCue({ id: 'q_000009', start: 5, end: 6, kind: 'visual' }, { cast, visible: () => [] });
    expect(result).toEqual({
      cue: { id: 'q_000009', start: 5, end: 6, kind: 'visual', people: [] },
      status: 'ok',
      demoted: [],
      violations: [],
      trackCheck: 'ok',
    });
  });

  it('ignores entries of people that are not people', () => {
    const before = cue('{P3} 走到窗边。', { people: [null, 'P3', { tracks: ['t0'] }, { char: 'P3', tracks: ['t1'] }, { char: 'P3', tracks: ['t2'] }] });
    expect(verifyCue(before, { cast, visible: () => ['P3'] }).cue.people).toEqual([{ char: 'P3', tracks: ['t1'] }]);
    expect(verifyCue(cue('{P3} 走到窗边。', { people: 'P3' }), { cast, visible: () => ['P3'] }).cue.people).toEqual([{ char: 'P3' }]);
  });
});

describe('repairGeneric', () => {
  // One person has a track in the cue's window, and it is the main character.
  const her = { cast, visibleIds: ['P3'], peopleCount: 1 };
  const him = { cast, visibleIds: ['P1'], peopleCount: 1 };

  it.each([
    ['一个女人走进来。', her, '{P3}走进来。'],
    ['一名女子走进来。', her, '{P3}走进来。'],
    ['一位女士走进来。', her, '{P3}走进来。'],
    ['一个男人走进来。', him, '{P1}走进来。'],
    ['一名男子走进来。', him, '{P1}走进来。'],
    ['一位男士走进来。', him, '{P1}走进来。'],
    ['有人敲门。', her, '{P3}敲门。'],
    ['某人站在窗边。', him, '{P1}站在窗边。'],
    ['门口站着一个女人。', her, '门口站着{P3}。'],
    ['灯亮了，有人走下楼梯。', him, '灯亮了，{P1}走下楼梯。'],
    ['信交到了某人手里。', her, '信交到了{P3}手里。'],
  ])('gives a generic person in Chinese the token of the one main character on screen: %s', (text, options, expected) => {
    const result = repairGeneric(cue(text), { ...options, lang: 'zh-CN' });
    expect(result.repaired).toBe(true);
    expect(result.relapse).toBe(false);
    expect(result.cue.brief).toBe(expected);
    expect(result.cue.standard).toBe(expected);
    expect(result.cue.detailed).toBe(expected);
  });

  it.each([
    ['A man walks in.', him, '{P1} walks in.'],
    ['A woman walks in.', her, '{P3} walks in.'],
    ['Someone knocks at the door.', her, '{P3} knocks at the door.'],
    ['A person waits by the door.', him, '{P1} waits by the door.'],
    ['Somebody waves from the window.', her, '{P3} waves from the window.'],
    ['In the kitchen, a woman chops onions.', her, 'In the kitchen, {P3} chops onions.'],
    ['The letter is handed to a man.', him, 'The letter is handed to {P1}.'],
  ])('gives a generic person in English the token of the one main character on screen: %s', (text, options, expected) => {
    const result = repairGeneric(cue(text), { ...options, lang: 'en' });
    expect(result.repaired).toBe(true);
    expect(result.relapse).toBe(false);
    expect(result.cue.standard).toBe(expected);
  });

  it('repairs each of the three versions', () => {
    const result = repairGeneric(
      cue('', { brief: '一个女人进门。', standard: '一个女人推门走进来。', detailed: '有一个女人推开门，走进昏暗的走廊。' }),
      { ...her, lang: 'zh' },
    );
    expect(result.cue.brief).toBe('{P3}进门。');
    expect(result.cue.standard).toBe('{P3}推门走进来。');
    expect(result.cue.detailed).toBe('{P3}推开门，走进昏暗的走廊。');
  });

  it('keeps the 有 that is the verb of the sentence', () => {
    expect(repairGeneric(cue('门口有一个女人。'), her).cue.standard).toBe('门口有{P3}。');
    expect(repairGeneric(cue('有一个女人。'), her).cue.standard).toBe('有{P3}。');
  });

  it('adds the character to people, once, and keeps who was there', () => {
    expect(repairGeneric(cue('一个女人走进来。'), her).cue.people).toEqual([{ char: 'P3' }]);
    const withPeople = cue('一个女人走进来。', { people: [{ char: 'P1', tracks: ['t2'] }] });
    expect(repairGeneric(withPeople, her).cue.people).toEqual([{ char: 'P1', tracks: ['t2'] }, { char: 'P3' }]);
    const stale = cue('一个女人走进来。', { people: [{ char: 'P3', tracks: ['t1'] }] });
    expect(repairGeneric(stale, her).cue.people).toEqual([{ char: 'P3', tracks: ['t1'] }]);
  });

  it('repairs only when the main character is the only person in the window: anyone else there stops it', () => {
    for (const text of ['一个女人走进来。', 'A woman walks in.', '有人敲门。', 'Someone knocks.']) {
      const before = cue(text);
      // Others the cast knows, main or not.
      expect(repairGeneric(before, { cast, visibleIds: ['P3', 'P5', 'P8'], peopleCount: 3 })).toEqual({ cue: before, repaired: false, relapse: true });
      expect(repairGeneric(before, { cast, visibleIds: ['P3', 'P5'], peopleCount: 2 })).toEqual({ cue: before, repaired: false, relapse: true });
      // A face nobody has placed: the identity layer leaves it out of the ids and counts it.
      expect(repairGeneric(before, { cast, visibleIds: ['P3'], peopleCount: 2 })).toEqual({ cue: before, repaired: false, relapse: true });
      // The two answers must agree on one person.
      expect(repairGeneric(before, { cast, visibleIds: ['P3', 'P5'], peopleCount: 1 })).toEqual({ cue: before, repaired: false, relapse: true });
      expect(repairGeneric(before, { cast, visibleIds: ['P3'], peopleCount: 1 }).repaired).toBe(true);
    }
  });

  it.each([
    ['nobody was counted', 0],
    ['the identity mode cannot count', null],
    ['no count is given', undefined],
    ['the count is not a number', '1'],
    ['the count is not whole', 1.5],
  ])('leaves the text alone and reports a relapse when %s', (_, peopleCount) => {
    for (const text of ['一个女人走进来。', 'A woman walks in.']) {
      const before = cue(text);
      expect(repairGeneric(before, { cast, visibleIds: ['P3'], peopleCount })).toEqual({ cue: before, repaired: false, relapse: true });
    }
    const before = cue('A woman walks in.');
    expect(repairGeneric(before, { cast, visibleIds: ['P3'] })).toEqual({ cue: before, repaired: false, relapse: true });
  });

  it('takes the visible ids as a Set', () => {
    expect(repairGeneric(cue('A woman walks in.'), { cast, visibleIds: new Set(['P3']), peopleCount: 1 }).cue.standard).toBe('{P3} walks in.');
  });

  it.each([
    ['no one is visible', [], 0],
    ['nothing is known about who is visible', undefined, null],
    ['two main characters are visible', ['P1', 'P3'], 2],
    ['only a character who is not main is visible', ['P5'], 1],
    ['only an id the cast does not know is visible', ['P42'], 1],
  ])('leaves the text alone and reports a relapse when %s', (_, visibleIds, peopleCount) => {
    for (const text of ['一个女人走进来。', 'A woman walks in.', '有人敲门。', 'Someone knocks.']) {
      const before = cue(text);
      const result = repairGeneric(before, { cast, visibleIds, peopleCount });
      expect(result).toEqual({ cue: before, repaired: false, relapse: true });
    }
  });

  it('reports nothing when there is no generic person', () => {
    for (const text of ['{P3} 走到窗边。', '门开了。', '{P3} walks to the window.', '']) {
      const before = cue(text);
      expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: false });
    }
  });

  it.each([
    'A manager walks in.',
    'A mango falls from the tree.',
    'A man-made lake fills the valley.',
    'A woman-shaped shadow crosses the wall.',
    'Rain falls on a manor.',
    'She is dressed as a man.',
    'A statue of a woman stands in the square.',
    '没有人说话。',
    '所有人都站起来。',
    '没有一个女人回头。',
    '另一个女人走进来。',
    '二十一个男人列队走过。',
    '每一个男人都低着头。',
    '她打扮得像一个男人。',
    '有人的地方就有灯光。',
  ])('matches the whole phrase only, and only where it points at a person: %s', (text) => {
    const before = cue(text);
    expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: false });
    expect(repairGeneric(before, him)).toEqual({ cue: before, repaired: false, relapse: false });
  });

  it.each([
    'Someone else walks in.',
    '屋里有人。',
    '这时有人敲门。',
    '屋里还有人在说话。',
  ])('leaves a generic person a token cannot stand for, as a relapse: %s', (text) => {
    const before = cue(text);
    expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: true });
  });

  it.each([
    // A pronoun already stands for whoever is on screen: the generic person is somebody else.
    ['She hands the letter to a woman behind the counter.', her],
    ['He waves at someone across the street.', him],
    ['They watch a man enter.', him],
    ['Her hand rests on the door. A woman waits outside.', her],
    ['她把信交给一个女人。', her],
    ['她回头，有人走进来。', her],
    ['他们看着一个男人走进来。', him],
    // What is named belongs to the person and need not be the person.
    ["A woman's voice comes from the radio.", her],
    ["A man's hand rests on the table.", him],
    ['A man’s coat hangs by the door.', him],
    ['墙上挂着一个女人的照片。', her],
    ['一个女人的声音从收音机里传来。', her],
    ['某人的大衣挂在门边。', him],
    // A picture or a broadcast: who is in it need not be who is in the room.
    ['A photograph on the wall shows a woman holding a child.', her],
    ['The mural depicts a man on a horse.', him],
    ['In the photograph, a woman holds a child.', her],
    ['On the television, a man reads the news.', him],
    ['照片里有一个女人。', her],
    ['电视上，一个男人正在讲话。', him],
  ])('leaves a generic person who need not be the one on screen, as a relapse: %s', (text, options) => {
    const before = cue(text);
    expect(repairGeneric(before, options)).toEqual({ cue: before, repaired: false, relapse: true });
  });

  it('still repairs after another sentence, a guitar or "其他" that only look like these', () => {
    expect(repairGeneric(cue('A photograph hangs on the wall. A woman walks in.'), her).cue.standard).toBe('A photograph hangs on the wall. {P3} walks in.');
    expect(repairGeneric(cue('墙上挂着照片。一个女人走进来。'), her).cue.standard).toBe('墙上挂着照片。{P3}走进来。');
    expect(repairGeneric(cue('其他座位都空着，一个女人走进来。'), her).cue.standard).toBe('其他座位都空着，{P3}走进来。');
    expect(repairGeneric(cue('角落里放着一把吉他，一个男人走进来。'), him).cue.standard).toBe('角落里放着一把吉他，{P1}走进来。');
    expect(repairGeneric(cue('A woman takes off her coat.'), her).cue.standard).toBe('{P3} takes off her coat.');
    expect(repairGeneric(cue('一个女人脱下她的大衣。'), her).cue.standard).toBe('{P3}脱下她的大衣。');
  });

  it.each([
    ['A woman in a red dress walks in.', her],
    ['A woman with long hair walks in.', her],
    ['A woman, in a red dress, walks in.', her],
    ['A woman wearing a blue coat walks in.', her],
    ['Someone in a red dress walks in.', her],
    ['A man dressed in black waits.', him],
    ['A man who limps crosses the room.', him],
    ['A man with a beard in a black suit walks in.', him],
    ['一个女人穿着红裙子走进来。', her],
    ['一个女人身穿蓝色外套走进来。', her],
    ['一个女人，穿着红裙子，走进来。', her],
    ['一个女人留着长发，走进来。', her],
    ['一个男人戴着帽子站在门口。', him],
    ['一个男人头戴礼帽走进来。', him],
    ['有人披着斗篷走进来。', him],
    ['某人身着制服站在门口。', him],
  ])('leaves a generic person who carries a description of their own, as a relapse: %s', (text, options) => {
    // With a token there the name gate would say the label and the outfit of the cast beside the model's own.
    const before = cue(text);
    expect(repairGeneric(before, options)).toEqual({ cue: before, repaired: false, relapse: true });
  });

  it('does not take crossing a road or putting on a hat for a description', () => {
    expect(repairGeneric(cue('一个女人穿过马路。'), her).cue.standard).toBe('{P3}穿过马路。');
    expect(repairGeneric(cue('一个男人戴上帽子。'), him).cue.standard).toBe('{P1}戴上帽子。');
    expect(repairGeneric(cue('A man inside the car waves.'), him).cue.standard).toBe('{P1} inside the car waves.');
    expect(repairGeneric(cue('A woman withdraws her hand.'), her).cue.standard).toBe('{P3} withdraws her hand.');
  });

  it('never touches a kind text cue', () => {
    for (const text of ['有人敲门。', 'A man walks in.', '一个女人']) {
      const before = cue(text, { kind: 'text', onScreenText: text });
      expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: false });
      expect(repairGeneric(cue(text, { kind: 'text' }), him)).toEqual({ cue: cue(text, { kind: 'text' }), repaired: false, relapse: false });
    }
  });

  it('never touches quoted text', () => {
    for (const text of ['门上写着「有人」。', '纸条上写着“一个女人来过”。', 'The note says "someone is watching".', "The note says 'a man was here'."]) {
      const before = cue(text);
      expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: false });
    }
  });

  it('repairs a description that is wrapped in quotation marks from end to end', () => {
    expect(repairGeneric(cue('"A man walks in."'), him).cue.standard).toBe('"{P1} walks in."');
    expect(repairGeneric(cue('“一个女人走进来。”'), her).cue.standard).toBe('“{P3}走进来。”');
  });

  it('repairs the text around a quotation and leaves the quotation', () => {
    expect(repairGeneric(cue('一个女人指着「某人」的名牌。'), her).cue.standard).toBe('{P3}指着「某人」的名牌。');
    expect(repairGeneric(cue('A woman points at the words "a man".'), her).cue.standard).toBe('{P3} points at the words "a man".');
  });

  it('leaves the on-screen text of the cue', () => {
    const before = cue('屏幕上显示：有人敲门', { onScreenText: '有人敲门' });
    expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: false });
  });

  it('does not give a woman the token of a man, or a man the token of a woman', () => {
    for (const [text, options] of [['一个女人走进来。', him], ['A woman walks in.', him], ['一名男子走进来。', her], ['A man walks in.', her]]) {
      const before = cue(text);
      expect(repairGeneric(before, options)).toEqual({ cue: before, repaired: false, relapse: true });
    }
  });

  it('repairs when the label of the character does not say man or woman', () => {
    const plain = castOf(character('P9', { main: true, descriptor: { zh: '戴帽子的人', en: 'person in a hat' } }), character('P2', { main: true }));
    expect(repairGeneric(cue('一个女人走进来。'), { cast: plain, visibleIds: ['P9'], peopleCount: 1 }).cue.standard).toBe('{P9}走进来。');
    expect(repairGeneric(cue('A man walks in.'), { cast: plain, visibleIds: ['P2'], peopleCount: 1 }).cue.standard).toBe('{P2} walks in.');
  });

  it('leaves two generic people in one version: only one of them can be the character', () => {
    for (const text of ['A man and a woman walk in.', '一个男人和一个女人走进来。', 'Someone hands a person a letter.']) {
      const before = cue(text);
      expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: true });
    }
  });

  it('leaves the generic person when the character is already in the cue: it is someone else', () => {
    for (const text of ['{P3} 把信交给一个女人。', '｛P3｝ 把信交给一个女人。', '{P3} hands a woman the letter.']) {
      const before = cue(text);
      expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: true });
    }
    const split = cue('', { brief: '一个女人进门。', standard: '{P3} 开门，一个女人进门。', detailed: '一个女人进门。' });
    expect(repairGeneric(split, her)).toEqual({ cue: split, repaired: false, relapse: true });
  });

  it('leaves the generic person when the cue holds the token of anyone else: a second person the tracks do not show', () => {
    // Only the main character has a track in the window, yet the text has two people: one of them is
    // unaccounted for, and nothing says the generic one is the one on screen.
    for (const [text, options] of [
      ['{P1} 把信交给某人。', her],
      ['{P1} 看着一个女人走进来。', her],
      ['{P3} hands the letter to a man.', him],
      ['{P5} opens the door to a man.', him],
      ['A woman opens the door to {P8}.', her],
    ]) {
      const before = cue(text);
      expect(repairGeneric(before, options), text).toEqual({ cue: before, repaired: false, relapse: true });
    }
    const split = cue('', { brief: 'A woman enters.', standard: '{P1} looks up as a woman enters.', detailed: 'A woman enters.' });
    expect(repairGeneric(split, her)).toEqual({ cue: split, repaired: false, relapse: true });
  });

  it('repairs the three versions together or not at all', () => {
    const before = cue('', { brief: 'A woman enters.', standard: 'A man and a woman enter.', detailed: 'A woman enters.' });
    expect(repairGeneric(before, her)).toEqual({ cue: before, repaired: false, relapse: true });
  });

  it('does not write a token the legend of the section does not have', () => {
    const before = cue('一个女人走进来。');
    expect(repairGeneric(before, { ...her, legendIds: ['P1'] })).toEqual({ cue: before, repaired: false, relapse: true });
    expect(repairGeneric(before, { ...her, legendIds: [] })).toEqual({ cue: before, repaired: false, relapse: true });
    expect(repairGeneric(before, { ...her, legendIds: new Set(['P1', 'P3']) }).cue.standard).toBe('{P3}走进来。');
    // The legend does not narrow who is on screen: two main characters are still two.
    expect(repairGeneric(before, { cast, visibleIds: ['P1', 'P3'], peopleCount: 2, legendIds: ['P3'] })).toEqual({ cue: before, repaired: false, relapse: true });
  });

  it('uses the word list of the description language, and both without one', () => {
    expect(repairGeneric(cue('有人敲门。'), { ...her, lang: 'en' })).toEqual({ cue: cue('有人敲门。'), repaired: false, relapse: false });
    expect(repairGeneric(cue('A man walks in.'), { ...him, lang: 'zh-CN' })).toEqual({ cue: cue('A man walks in.'), repaired: false, relapse: false });
    expect(repairGeneric(cue('有人敲门。'), her).repaired).toBe(true);
    expect(repairGeneric(cue('A man walks in.'), him).repaired).toBe(true);
    expect(repairGeneric(cue('A man walks in.'), { ...him, lang: 'fr' }).repaired).toBe(true);
  });

  it('returns a new cue and changes nothing it was given', () => {
    const before = deepFreeze(cue('一个女人走进来。', { people: [{ char: 'P1', tracks: ['t2'] }] }));
    const frozenCast = deepFreeze(castOf(character('P3', { main: true, descriptor: { zh: '长发女人' } })));
    const result = repairGeneric(before, { cast: frozenCast, visibleIds: deepFreeze(['P3']), peopleCount: 1, lang: 'zh' });
    expect(result.cue).not.toBe(before);
    expect(result.cue).toEqual({ ...before, brief: '{P3}走进来。', standard: '{P3}走进来。', detailed: '{P3}走进来。', people: [{ char: 'P1', tracks: ['t2'] }, { char: 'P3' }] });
    expect(before.standard).toBe('一个女人走进来。');
    const untouched = repairGeneric(before, { cast: frozenCast, visibleIds: [], peopleCount: 0 });
    expect(untouched.cue).not.toBe(before);
    expect(untouched.cue).toEqual(before);
  });

  it('works without options or a cast', () => {
    expect(repairGeneric(cue('有人敲门。'))).toEqual({ cue: cue('有人敲门。'), repaired: false, relapse: true });
    expect(repairGeneric(cue('有人敲门。'), null)).toEqual({ cue: cue('有人敲门。'), repaired: false, relapse: true });
    expect(repairGeneric(cue('有人敲门。'), { visibleIds: ['P3'], peopleCount: 1 })).toEqual({ cue: cue('有人敲门。'), repaired: false, relapse: true });
  });
});

describe('verifyScript', () => {
  /** P3 is seen in three stretches of the film; P1 never. */
  const seenP3 = [[5, 20], [68, 75], [108, 115]];
  const identity = (calls = []) => ({
    mode: 'ground-truth',
    visibleAt: () => [],
    visibleBetween(t0, t1) {
      calls.push([t0, t1]);
      return seenP3.some(([from, to]) => from <= t1 && to >= t0) ? ['P3'] : [];
    },
    // P3 is the only person the film ever shows.
    peopleBetween: (t0, t1) => (seenP3.some(([from, to]) => from <= t1 && to >= t0) ? 1 : 0),
  });
  const at = (id, start, end, text, extra = {}) => cue(text, { id, start, end, ...extra });
  const script = (cues, lang = 'zh-CN') => ({ v: 3, filmId: 'f1', lang, duration: 200, slots: [], cues, scenes: [0] });

  const film = script([
    at('q_000001', 10, 14, '{P3} 走到窗边。'),
    at('q_000002', 30, 33, '{P1} 坐下。'),
    at('q_000003', 50, 52, '马修转身离开。'),
    at('q_000004', 70, 73, '一个女人走进来。'),
    at('q_000005', 90, 93, '一个男人走进来。'),
    at('q_000006', 110, 113, '有人敲门。', { by: 'human', status: 'edited' }),
  ]);

  it('checks every cue and counts what it found', () => {
    const { report } = verifyScript(film, { cast, identity: identity() });
    expect(report).toEqual({ checked: 6, demoted: 1, needsRepair: 1, relapses: 1 });
  });

  it('returns the script with the checked cues', () => {
    const result = verifyScript(film, { cast, identity: identity() });
    expect(result.script).toEqual({
      ...film,
      cues: [
        { ...film.cues[0], people: [{ char: 'P3' }] },
        { ...film.cues[1], people: [{ char: 'P1', demoted: true }] },
        film.cues[2],
        { ...film.cues[3], brief: '{P3}走进来。', standard: '{P3}走进来。', detailed: '{P3}走进来。', people: [{ char: 'P3' }] },
        film.cues[4],
        film.cues[5],
      ],
    });
    expect(result.script).not.toBe(film);
    expect(result.script.cues).not.toBe(film.cues);
  });

  it('says what happened to each cue, so the caller knows which to ask for again', () => {
    const { results } = verifyScript(film, { cast, identity: identity() });
    expect(results.map((r) => [r.id, r.status, r.trackCheck, r.repaired, r.relapse])).toEqual([
      ['q_000001', 'ok', 'ok', false, false],
      ['q_000002', 'demoted', 'failed', false, false],
      ['q_000003', 'needs-repair', 'ok', false, false],
      ['q_000004', 'ok', 'ok', true, false],
      ['q_000005', 'ok', 'ok', false, true],
      ['q_000006', 'ok', 'ok', false, false],
    ]);
    expect(results[1].demoted).toEqual(['P1']);
    expect(results[2].violations.map((v) => v.type)).toEqual(['name-leak', 'name-leak', 'name-leak']);
  });

  it('does not rewrite what a person wrote, and does not count it as a relapse', () => {
    const human = script([at('q_000001', 110, 113, '有人敲门。', { by: 'human' }), at('q_000002', 110, 113, '有人敲门。')]);
    const result = verifyScript(human, { cast, identity: identity() });
    expect(result.script.cues.map((c) => c.standard)).toEqual(['有人敲门。', '{P3}敲门。']);
    expect(result.report.relapses).toBe(0);
    expect(result.results.map((r) => r.repaired)).toEqual([false, true]);
  });

  it('does not put the main character\'s token on a stranger whose face nobody has placed', () => {
    let people = addCharacter(createCast(), { descriptor: { en: 'man in a grey coat', zh: '灰大衣男人' }, main: true }).cast;
    people = confirmName(people, 'P1', { name: 'Matthew', by: 'ear', t: 1 });
    const track = (id, cluster, from) => ({ id, cluster, samples: [{ t: from, box: [0, 0, 80, 80], conf: 0.9 }, { t: from + 30, box: [0, 0, 80, 80], conf: 0.9 }] });
    // Cluster c9 is on screen for the whole window and belongs to no character.
    const faces = faceClusterIdentity([track('t1', 'c1', 5), track('t2', 'c9', 5)], { c1: 'P1' });
    expect(faces.visibleBetween(7, 15)).toEqual(['P1']);
    expect(faces.peopleBetween(7, 15)).toBe(2);
    for (const [lang, text] of [['en', 'A man with a beard walks in.'], ['en', 'A man walks in.'], ['zh-CN', '一个男人走进来。']]) {
      const result = verifyScript(script([at('q_000001', 10, 14, text)], lang), { cast: people, identity: faces });
      expect(result.script.cues[0].standard, text).toBe(text);
      expect(result.results[0], text).toMatchObject({ status: 'ok', repaired: false, relapse: true });
      expect(result.report.relapses).toBe(1);
      expect(renderScript(result.script, people).cues[0].standard, text).toBe(text);
    }
    // Alone in the window he is the man.
    const alone = verifyScript(script([at('q_000001', 10, 14, 'A man walks in.')], 'en'), { cast: people, identity: faceClusterIdentity([track('t1', 'c1', 5)], { c1: 'P1' }) });
    expect(alone.script.cues[0].standard).toBe('{P1} walks in.');
    expect(alone.report.relapses).toBe(0);
  });

  it('does not put the main character\'s token on another character who is on screen', () => {
    let people = addCharacter(createCast(), { descriptor: { en: 'man in a grey coat' }, main: true }).cast;
    people = addCharacter(people, { descriptor: { en: 'man in a black suit' } }).cast;
    people = confirmName(people, 'P1', { name: 'Matthew', by: 'ear', t: 1 });
    const both = { visibleBetween: () => ['P1', 'P2'], peopleBetween: () => 2 };
    const result = verifyScript(script([at('q_000001', 10, 14, 'A man in a black suit walks in.')], 'en'), { cast: people, identity: both });
    expect(result.script.cues[0].standard).toBe('A man in a black suit walks in.');
    expect(result.results[0]).toMatchObject({ repaired: false, relapse: true });
  });

  it('repairs nothing for an identity provider that cannot count the people', () => {
    const noCount = { visibleBetween: () => ['P3'] };
    const result = verifyScript(script([at('q_000001', 70, 73, '一个女人走进来。')]), { cast, identity: noCount });
    expect(result.script.cues[0].standard).toBe('一个女人走进来。');
    expect(result.results[0]).toMatchObject({ status: 'ok', repaired: false, relapse: true });
    const cannotTell = { visibleBetween: () => ['P3'], peopleBetween: () => null };
    expect(verifyScript(script([at('q_000001', 70, 73, '一个女人走进来。')]), { cast, identity: cannotTell }).results[0].relapse).toBe(true);
  });

  it('counts a wrong name as nothing less than a relapse: a pronoun, a possessive, a picture', () => {
    let people = addCharacter(createCast(), { descriptor: { en: 'woman with long hair', zh: '长发女人' }, main: true }).cast;
    people = confirmName(people, 'P1', { name: 'Matthew', by: 'ear', t: 1 });
    const only = { visibleBetween: () => ['P1'], peopleBetween: () => 1 };
    for (const [lang, text] of [
      ['en', 'She hands the letter to a woman behind the counter.'],
      ['en', 'A photograph on the wall shows a woman holding a child.'],
      ['en', "A woman's voice comes from the radio."],
      ['zh-CN', '墙上挂着一个女人的照片。'],
      ['zh-CN', '她把信交给一个女人。'],
    ]) {
      const result = verifyScript(script([at('q_000001', 10, 14, text)], lang), { cast: people, identity: only });
      expect(result.results[0], text).toMatchObject({ status: 'ok', repaired: false, relapse: true });
      expect(JSON.stringify(renderScript(result.script, people).cues), text).not.toContain('Matthew');
    }
  });

  it('still verifies what a person wrote', () => {
    const human = script([at('q_000001', 30, 33, '马修和 {P3} 坐下。', { by: 'human' })]);
    const result = verifyScript(human, { cast, identity: identity() });
    expect(result.report).toEqual({ checked: 1, demoted: 1, needsRepair: 1, relapses: 0 });
    expect(result.script.cues[0].people).toEqual([{ char: 'P3', demoted: true }]);
  });

  it('asks the identity provider once per cue, for the window around it', () => {
    const calls = [];
    verifyScript(film, { cast, identity: identity(calls) });
    expect(calls).toEqual([[7, 15], [27, 34], [47, 53], [67, 74], [87, 94], [107, 114]]);
    const tight = [];
    verifyScript(film, { cast, identity: identity(tight), window: { before: 0, after: 0 } });
    expect(tight).toEqual([[10, 14], [30, 33], [50, 52], [70, 73], [90, 93], [110, 113]]);
  });

  it('uses the window for the verdict', () => {
    // P3 is last seen at 20: a cue at 22 is inside the default window and outside a tight one.
    const late = script([at('q_000001', 22, 24, '{P3} 走到窗边。')]);
    expect(verifyScript(late, { cast, identity: identity() }).report.demoted).toBe(0);
    expect(verifyScript(late, { cast, identity: identity(), window: { before: 1, after: 1 } }).report.demoted).toBe(1);
  });

  it('demotes every person when the identity mode cannot tell, unless names are allowed without tracks', () => {
    const promptBank = { mode: 'prompt-bank', visibleAt: () => [], visibleBetween: () => null };
    const strict = verifyScript(film, { cast, identity: promptBank });
    expect(strict.report).toEqual({ checked: 6, demoted: 2, needsRepair: 1, relapses: 2 });
    expect(strict.results.map((r) => r.trackCheck)).toEqual(['n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a']);
    expect(strict.script.cues[0].people).toEqual([{ char: 'P3', demoted: true }]);
    // Nobody is known to be on screen, so the generic woman is not repaired.
    expect(strict.script.cues[3].standard).toBe('一个女人走进来。');

    const lenient = verifyScript(film, { cast, identity: promptBank, allowNamesWithoutTracks: true });
    expect(lenient.report).toEqual({ checked: 6, demoted: 0, needsRepair: 1, relapses: 2 });
    expect(lenient.script.cues[0].people).toEqual([{ char: 'P3' }]);
  });

  it('treats a missing identity provider as one that cannot tell', () => {
    const result = verifyScript(film, { cast });
    expect(result.report).toEqual({ checked: 6, demoted: 2, needsRepair: 1, relapses: 2 });
    expect(result.results[0].trackCheck).toBe('n/a');
  });

  it('checks the legend when one is given', () => {
    const result = verifyScript(film, { cast, identity: identity(), legendIds: ['P1'] });
    // {P3} in the first cue is not in the legend; the third cue leaks a name.
    expect(result.report.needsRepair).toBe(2);
    expect(result.results[0].violations[0]).toEqual({ type: 'unknown-token', detail: 'P3', field: 'brief' });
    expect(verifyScript(film, { cast, identity: identity(), legendIds: new Set(['P1', 'P3']) }).report.needsRepair).toBe(1);
  });

  it('does not repair a generic person into a character outside the legend: that token would be a violation', () => {
    const result = verifyScript(film, { cast, identity: identity(), legendIds: ['P1'] });
    expect(result.script.cues[3].standard).toBe('一个女人走进来。');
    expect(result.results[3]).toEqual({ id: 'q_000004', status: 'ok', demoted: [], violations: [], trackCheck: 'ok', repaired: false, relapse: true });
    expect(result.report.relapses).toBe(2);
    expect(verifyScript(film, { cast, identity: identity(), legendIds: ['P3'] }).script.cues[3].standard).toBe('{P3}走进来。');
  });

  it('uses the language of the script for the generic repair, or the one given', () => {
    const english = script([at('q_000001', 10, 14, 'A woman walks in.')], 'en');
    expect(verifyScript(english, { cast, identity: identity() }).script.cues[0].standard).toBe('{P3} walks in.');
    expect(verifyScript(english, { cast, identity: identity(), lang: 'zh-CN' }).script.cues[0].standard).toBe('A woman walks in.');
  });

  it('normalises the tokens of every cue', () => {
    const wide = script([at('q_000001', 10, 14, '｛P3｝走到窗边。')]);
    const result = verifyScript(wide, { cast, identity: identity() });
    expect(result.script.cues[0].standard).toBe('{P3}走到窗边。');
    expect(result.report).toEqual({ checked: 1, demoted: 0, needsRepair: 0, relapses: 0 });
  });

  it('passes over an entry that is not a cue', () => {
    const odd = script([null, at('q_000002', 10, 14, '{P3} 走到窗边。'), 'cue']);
    const result = verifyScript(odd, { cast, identity: identity() });
    expect(result.report.checked).toBe(1);
    expect(result.script.cues).toEqual([null, { ...odd.cues[1], people: [{ char: 'P3' }] }, 'cue']);
    expect(result.results.map((r) => r.id)).toEqual(['q_000002']);
  });

  it('handles a script without cues', () => {
    expect(verifyScript(script([]), { cast, identity: identity() })).toEqual({
      script: script([]),
      report: { checked: 0, demoted: 0, needsRepair: 0, relapses: 0 },
      results: [],
    });
    expect(verifyScript({ v: 3, lang: 'en' }).script).toEqual({ v: 3, lang: 'en', cues: [] });
    expect(verifyScript(null).report).toEqual({ checked: 0, demoted: 0, needsRepair: 0, relapses: 0 });
  });

  it('changes nothing it was given', () => {
    const frozen = deepFreeze(script([
      at('q_000001', 10, 14, '｛P3｝走到窗边。', { people: [{ char: 'P3', tracks: ['t1'] }] }),
      at('q_000002', 70, 73, '一个女人走进来。'),
    ]));
    const frozenCast = deepFreeze(castOf(character('P3', { name: '马修', main: true })));
    const result = verifyScript(frozen, { cast: frozenCast, identity: deepFreeze(identity()), window: deepFreeze({ before: 3, after: 1 }), legendIds: deepFreeze(['P3']) });
    expect(result.report).toEqual({ checked: 2, demoted: 0, needsRepair: 0, relapses: 0 });
    expect(frozen.cues[0].standard).toBe('｛P3｝走到窗边。');
    expect(frozen.cues[1].standard).toBe('一个女人走进来。');
    expect(result.script.cues[1].standard).toBe('{P3}走进来。');
  });
});
