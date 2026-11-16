// The film engine end to end (src/film), with no network: a tiny film goes from
// a subtitle file to what a blind listener hears. The modules have their own
// tests; this one proves what they are for when put together. The listener
// hears "马修" where a model left to itself says "一个女人" again and again; a
// name is spoken only once a person has confirmed it; and a correction (a
// confirmation, a new name, two characters that turn out to be one) is a new
// rendering of the same script, with no model asked again.
// The model is a canned reply written the way a model writes: tokens, one cue
// for a person who is not in the picture, one with a name written out, one with
// full-width braces, one generic "a woman", an outfit. The last step plays the
// result through the web player's real Playback against a fake player.
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/shared/errors.js';
import { languageName } from '../src/shared/gemini.js';
import { SCRIPT_VERSION } from '../src/shared/constants.js';
import { estimateSeconds } from '../src/shared/script.js';
import {
  addCharacter,
  addEvidence,
  confirmName,
  createCast,
  exportCast,
  getCharacter,
  mergeCharacters,
  neverName,
  rejectName,
  setAppearance,
  updateCharacter,
  validateCast,
} from '../src/film/cast.js';
import {
  createFilmScript,
  editCue,
  mergeSection,
  nextCueNumber,
  normalizeSection,
  remapTokens,
  staleClips,
  textHash,
  toPlayerScript,
  validateFilmScript,
} from '../src/film/filmscript.js';
import { groundTruthIdentity, promptBankIdentity } from '../src/film/identity.js';
import { MARK_COLOURS, assignMarks, drawMarks, legendText, tagTextColour } from '../src/film/marks.js';
import { MODELS } from '../src/film/models/catalog.js';
import { check } from '../src/film/models/json.js';
import { route } from '../src/film/models/routing.js';
import { buildRequest, readJson } from '../src/film/models/wire.js';
import { castIntro, renderScript, unlocked, whoIsOnScreen } from '../src/film/namegate.js';
import { BINDING_SCHEMA, NAMES_SCHEMA, SECTION_SCHEMA, SECTION_SHAPE, bindingPrompt, frameLabel, namesPrompt, sectionPrompt } from '../src/film/prompts.js';
import { parseSubtitle } from '../src/film/subs.js';
import { buildSlots, slotAt, slotsBetween, speechFromLines } from '../src/film/timeline.js';
import { DEFAULT_POLICY, LEVEL, tokensIn } from '../src/film/types.js';
import { verifyScript } from '../src/film/verify.js';
import { Playback, STATE } from '../src/web/playback.js';

/** Frozen all the way down: a function that changed its argument would throw. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// ---- The film ----

/** Seventy-two seconds, six lines of dialogue, seven pauses. */
const DURATION = 72;
const WINDOW = Object.freeze({ start: 0, end: DURATION });
/** When each line of dialogue is spoken; the words are in the language tables below. */
const LINE_TIMES = Object.freeze([[10, 12], [18, 20.5], [28, 30], [38, 40], [48, 50], [58, 60]]);
/** The pauses those lines leave: 0.1 s after a line ends, 0.3 s before the next begins. */
const SLOT_TIMES = Object.freeze([[0, 9.7], [12.1, 17.7], [20.6, 27.7], [30.1, 37.7], [40.1, 47.7], [50.1, 57.7], [60.1, 72]]);

/** The sampled frames are 160 by 90 pixels, grey. */
const FRAME = Object.freeze({ w: 160, h: 90 });
const GREY = 96;
const FRAME_TIMES = Object.freeze([2, 13, 22, 32, 42, 52, 62]);
const BOX = Object.freeze({ P1: [20, 20, 64, 64], P2: [112, 30, 30, 30], P3: [90, 12, 64, 64] });

/**
 * Who is in the picture when, as a person labelled it (each label holds for a
 * second either side). P1 is the woman the film is about; P2 the man who comes
 * in; P3 is the same man seen later from behind, taken for a third person
 * until somebody merges the two. P1 is not there between 16 and 31 seconds.
 */
const SIGHTINGS = Object.freeze({
  P1: [2, 4, 6, 13, 15, 32, 34, 36, 42, 44, 52, 54],
  P2: [13, 15, 22, 24],
  P3: [52, 54],
});
const labelsFrom = (sightings) => Object.entries(sightings).flatMap(([characterId, times]) => times.map((t) => ({ t, box: BOX[characterId], characterId })));

/** The cues of the film by what happens in them, as the script will number them. */
const Q = Object.freeze({ window: 'q_000001', enters: 'q_000002', tea: 'q_000003', sits: 'q_000004', door: 'q_000005', phone: 'q_000006', sign: 'q_000007' });

/** SubRip time: 10 -> "00:00:10,000". */
const stamp = (seconds, comma) => {
  const ms = Math.round(seconds * 1000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${comma}${pad(ms % 1000, 3)}`;
};
/** A subtitle file as found in the wild: the Chinese one with a byte order mark and CRLF, the English one with full stops. */
const srtOf = (words, { bom = false, eol = '\n', comma = ',' } = {}) =>
  (bom ? '\ufeff' : '') + words.map((text, i) => [String(i + 1), `${stamp(LINE_TIMES[i][0], comma)} --> ${stamp(LINE_TIMES[i][1], comma)}`, text, ''].join(eol)).join(eol);

/**
 * Everything that depends on the description language: the dialogue, the names,
 * the outfits, what the model answers and what the listener is to hear.
 */
const WORDS = deepFreeze({
  'zh-CN': {
    preset: 'cn',
    wire: 'openai',
    title: '长街',
    srt: srtOf(['马修，过来。', '<i>我马上就来。</i>', '你看见老陈了吗？', '没有。', '他回来了。', '走吧。'], { bom: true, eol: '\r\n' }),
    spoken: ['马修，过来。', '我马上就来。', '你看见老陈了吗？', '没有。', '他回来了。', '走吧。'],
    units: 'chars',
    name: '马修',
    label: '长发女人',
    renamed: '玛莎',
    second: '老陈',
    outfits: { P1: '红裙子', P2: '灰大衣', P9: '黑帽子' },
    notice: 'AI 生成的口述影像。',
    signText: '马修面包店',
    model: {
      window: { brief: '{P1}走到窗边。', standard: '{P1}走到窗边，向外望去。', detailed: '清晨的客厅里，{P1}走到窗边，拉开窗帘向外望去。' },
      // Typed with a Chinese input method: the braces are full-width.
      enters: { brief: '｛P2｝进门。', standard: '｛P2｝推门进来，{P1}转过身。', detailed: '｛P2｝推门进来，摘下帽子，{P1}转过身看着他。' },
      // P1 left the room: the picture shows only P2 here.
      tea: { brief: '{P1}倒茶。', standard: '{P1}倒了一杯茶。', detailed: '{P1}走到桌边，倒了一杯茶。' },
      // The relapse the film engine exists for: the marked woman described as someone new.
      sits: { brief: '一个女人坐下。', standard: '一个女人坐到桌边。', detailed: '一个女人坐到桌边，翻开一本书。' },
      // The name from the dialogue, written out.
      door: { brief: '马修开门。', standard: '马修打开门。', detailed: '马修打开门，走进院子。' },
      phone: { brief: '{P3}拿起电话。', standard: '{P3}拿起电话，递给{P1}。', detailed: '{P3}拿起桌上的电话，递给{P1}。' },
      sign: { brief: '招牌：马修面包店。', standard: '招牌：马修面包店。', detailed: '招牌：马修面包店。' },
      curtains: { brief: '白色窗帘。', standard: '窗帘是白色的。', detailed: '窗帘是白色的，垂到地上。' },
      tree: { brief: '一棵树。', standard: '窗外有一棵树。', detailed: '窗外有一棵树，叶子落尽。' },
      repaired: { brief: '{P1}开门。', standard: '{P1}打开门。', detailed: '{P1}打开门，走进院子。' },
    },
    legend: {
      P1: 'P1（橙框）：长发女人；当前着装：红裙子',
      P2: 'P2（天蓝框）：戴眼镜的男人',
      P3: 'P3（红框）：灰大衣男人',
      named: 'P1（橙框）：长发女人；当前着装：红裙子；已确认名：马修',
    },
    // What the listener hears while the name is one clue from the dialogue.
    labels: {
      window: '长发女人，穿着红裙子，走到窗边，向外望去。',
      enters: '戴眼镜的男人，穿着灰大衣，推门进来，长发女人转过身。',
      tea: '长发女人倒了一杯茶。',
      sits: '长发女人坐到桌边。',
      phone: '灰大衣男人拿起电话，递给长发女人。',
      sign: '招牌：马修面包店。',
    },
    // And once a person has confirmed it.
    named: {
      window: '马修，长发女人，穿着红裙子，走到窗边，向外望去。',
      enters: '戴眼镜的男人，穿着灰大衣，推门进来，马修转过身。',
      tea: '长发女人倒了一杯茶。',
      sits: '马修坐到桌边。',
      phone: '灰大衣男人拿起电话，递给马修。',
      sign: '招牌：马修面包店。',
    },
    intro: '马修，长发女人，穿着红裙子，',
    door: '马修打开门。',
    merged: { phone: '戴眼镜的男人拿起电话，递给马修。' },
    both: { enters: '老陈，戴眼镜的男人，穿着灰大衣，推门进来，马修转过身。', phone: '老陈拿起电话，递给马修。' },
    unchecked: { tea: '马修倒了一杯茶。', sits: '一个女人坐到桌边。' },
    edited: { tea: '戴眼镜的男人倒了一杯茶。' },
    // With nobody able to say who is in the picture: the bare label for everyone, and the generic person left as written.
    bare: {
      window: '长发女人走到窗边，向外望去。',
      enters: '戴眼镜的男人推门进来，长发女人转过身。',
      tea: '长发女人倒了一杯茶。',
      sits: '一个女人坐到桌边。',
      phone: '灰大衣男人拿起电话，递给长发女人。',
      sign: '招牌：马修面包店。',
    },
    // Under "on reveal" the name waits for the line of dialogue that gives it, at 10 seconds. The brief version of
    // the cue the man comes in leaves her out, so she is not introduced there: a listener on brief would never
    // hear it. The introduction is made in the next cue all three versions mention her in.
    reveal: {
      heard: { window: '长发女人，穿着红裙子，走到窗边，向外望去。', enters: '戴眼镜的男人，穿着灰大衣，推门进来，长发女人转过身。', sits: '长发女人，马修，坐到桌边。' },
      introducedIn: 'sits',
      deferred: ['enters'],
    },
    // At half the speaking rate: the introduction still fits the opening; the man's coat does not fit the pause he comes in.
    slow: {
      introduced: true,
      heard: ['马修，长发女人，穿着红裙子，走到窗边，向外望去。', '戴眼镜的男人进门。', '长发女人倒了一杯茶。', '马修坐到桌边。', '灰大衣男人拿起电话，递给马修。', '招牌：马修面包店。'],
    },
    castIntro: { one: '主要人物：马修，长发女人。', two: '主要人物：马修，长发女人；老陈，戴眼镜的男人。' },
    onScreen: {
      before: '画面里：长发女人；戴眼镜的男人。',
      after: '画面里：马修；戴眼镜的男人。',
      nobody: '画面里没有认出的人物。',
      cannotTell: '本模式不核对画面。最近一条口述提到的人物：长发女人；戴眼镜的男人。',
      cannotTellNamed: '本模式不核对画面。最近一条口述提到的人物：马修；戴眼镜的男人。',
    },
  },
  en: {
    preset: 'global',
    wire: 'gemini',
    title: 'The Long Street',
    srt: srtOf(['Matthew, come here.', '<i>I\'ll be right there.</i>', 'Have you seen Chen?', 'No.', 'He is back.', 'Let\'s go.'], { comma: '.' }),
    spoken: ['Matthew, come here.', 'I\'ll be right there.', 'Have you seen Chen?', 'No.', 'He is back.', 'Let\'s go.'],
    units: 'words',
    name: 'Matthew',
    label: 'woman with long hair',
    renamed: 'Martha',
    second: 'Chen',
    outfits: { P1: 'a red dress', P2: 'a grey coat', P9: 'a black hat' },
    notice: 'AI-generated audio description follows.',
    signText: 'Matthew\'s Bakery',
    model: {
      window: { brief: '{P1} walks to the window.', standard: '{P1} walks to the window and looks out.', detailed: 'In a living room at dawn, {P1} walks to the window and opens the curtains.' },
      enters: { brief: '｛P2｝ comes in.', standard: '｛P2｝ comes in. {P1} turns round.', detailed: '｛P2｝ comes in and takes off his hat; {P1} turns round.' },
      tea: { brief: '{P1} pours tea.', standard: '{P1} pours a cup of tea.', detailed: '{P1} goes to the table and pours a cup of tea.' },
      sits: { brief: 'A woman sits down.', standard: 'A woman sits down at the table.', detailed: 'A woman sits down at the table and opens a book.' },
      door: { brief: 'Matthew opens the door.', standard: 'Matthew opens the door.', detailed: 'Matthew opens the door and steps into the yard.' },
      phone: { brief: '{P3} picks up the phone.', standard: '{P3} picks up the phone and hands it to {P1}.', detailed: '{P3} picks up the phone from the table and hands it to {P1}.' },
      sign: { brief: 'Sign: Matthew\'s Bakery.', standard: 'Sign: Matthew\'s Bakery.', detailed: 'Sign: Matthew\'s Bakery.' },
      curtains: { brief: 'White curtains.', standard: 'The curtains are white.', detailed: 'The curtains are white and reach the floor.' },
      tree: { brief: 'A tree.', standard: 'A tree stands outside.', detailed: 'A bare tree stands outside the window.' },
      repaired: { brief: '{P1} opens the door.', standard: '{P1} opens the door.', detailed: '{P1} opens the door and steps into the yard.' },
    },
    legend: {
      P1: 'P1 (orange box): woman with long hair; wearing: a red dress',
      P2: 'P2 (sky blue box): man with glasses',
      P3: 'P3 (red box): man in the grey coat',
      named: 'P1 (orange box): woman with long hair; wearing: a red dress; confirmed name: Matthew',
    },
    labels: {
      window: 'The woman with long hair, in a red dress, walks to the window and looks out.',
      enters: 'The man with glasses, in a grey coat, comes in. The woman with long hair turns round.',
      tea: 'The woman with long hair pours a cup of tea.',
      sits: 'The woman with long hair sits down at the table.',
      phone: 'The man in the grey coat picks up the phone and hands it to the woman with long hair.',
      sign: 'Sign: Matthew\'s Bakery.',
    },
    named: {
      window: 'Matthew, a woman with long hair in a red dress, walks to the window and looks out.',
      enters: 'The man with glasses, in a grey coat, comes in. Matthew turns round.',
      tea: 'The woman with long hair pours a cup of tea.',
      sits: 'Matthew sits down at the table.',
      phone: 'The man in the grey coat picks up the phone and hands it to Matthew.',
      sign: 'Sign: Matthew\'s Bakery.',
    },
    intro: 'Matthew, a woman with long hair in a red dress,',
    door: 'Matthew opens the door.',
    merged: { phone: 'The man with glasses picks up the phone and hands it to Matthew.' },
    both: { enters: 'Chen, a man with glasses in a grey coat, comes in. Matthew turns round.', phone: 'Chen picks up the phone and hands it to Matthew.' },
    unchecked: { tea: 'Matthew pours a cup of tea.', sits: 'A woman sits down at the table.' },
    edited: { tea: 'The man with glasses pours a cup of tea.' },
    bare: {
      window: 'The woman with long hair walks to the window and looks out.',
      enters: 'The man with glasses comes in. The woman with long hair turns round.',
      tea: 'The woman with long hair pours a cup of tea.',
      sits: 'A woman sits down at the table.',
      phone: 'The man in the grey coat picks up the phone and hands it to the woman with long hair.',
      sign: 'Sign: Matthew\'s Bakery.',
    },
    // In English the pause the man comes in has no room for "the woman with long hair, Matthew,": it waits for the next one.
    reveal: {
      heard: {
        window: 'The woman with long hair, in a red dress, walks to the window and looks out.',
        enters: 'The man with glasses, in a grey coat, comes in. The woman with long hair turns round.',
        sits: 'The woman with long hair, Matthew, sits down at the table.',
      },
      introducedIn: 'sits',
      deferred: ['enters'],
    },
    // At half the speaking rate no pause of this film has room for the English introduction: she keeps her label throughout.
    slow: {
      introduced: false,
      heard: [
        'The woman with long hair walks to the window and looks out.',
        'The man with glasses comes in.',
        'The woman with long hair pours tea.',
        'The woman with long hair sits down at the table.',
        'The man in the grey coat picks up the phone.',
        'Sign: Matthew\'s Bakery.',
      ],
    },
    castIntro: { one: 'Main characters: Matthew, a woman with long hair.', two: 'Main characters: Matthew, a woman with long hair; Chen, a man with glasses.' },
    onScreen: {
      before: 'On screen: the woman with long hair; the man with glasses.',
      after: 'On screen: Matthew; the man with glasses.',
      nobody: 'Nobody on screen is recognised.',
      cannotTell: 'This mode does not check the picture. The people last described: the woman with long hair; the man with glasses.',
      cannotTellNamed: 'This mode does not check the picture. The people last described: Matthew; the man with glasses.',
    },
  },
});

/**
 * What the model answers for the section, as a model writes it: seven cues that
 * can be used, with the mistakes listed at the top of this file, and four
 * things to throw away (a second cue for a slot, a slot that was not listed, an
 * outfit for someone who is not in the legend, a scene outside the section).
 */
function answerOf(W) {
  const cue = (slot, kind, priority, texts, extra = {}) => ({ slot, kind, priority, onScreenText: '', confidence: 'high', ...texts, ...extra });
  return {
    cues: [
      // A time of its own, that of the frame: the slot decides when a cue is spoken, not the model.
      cue('g_0001', 'visual', 1, W.model.window, { start: 2 }),
      cue('g_0002', 'visual', 2, W.model.enters),
      // The id in capitals, and not sure of what it sees.
      cue('G_0003', 'visual', 2, W.model.tea, { confidence: 'medium' }),
      cue('g_0004', 'visual', 2, W.model.sits),
      cue('g_0005', 'visual', 1, W.model.door),
      // No slot id, but a time: the slot that holds 0:52 is meant.
      cue('', 'visual', 2, W.model.phone, { start: '0:52' }),
      cue('g_0007', 'text', 1, W.model.sign, { onScreenText: W.signText }),
      cue('g_0001', 'visual', 3, W.model.curtains),
      cue('g_0042', 'visual', 3, W.model.tree),
    ],
    sceneStarts: [0, 30.5, 500],
    appearances: [
      // The first frame that shows the coat is the one at 13 seconds.
      { char: 'P2', outfit: W.outfits.P2, from: 13 },
      { char: 'P9', outfit: W.outfits.P9, from: 13 },
    ],
  };
}

/** A model that is never on a network: it counts what it is asked and answers what it was given. */
function cannedModel() {
  const model = {
    asked: [],
    ask(request, reply) {
      model.asked.push(request);
      // In a code fence, as models like to.
      return `\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``;
    },
  };
  return model;
}

/** The cast before anybody has a name: three characters, two of them main, each with a label in both languages. */
function castOf(W, identity) {
  let cast = createCast();
  ({ cast } = addCharacter(cast, { descriptor: { zh: '长发女人', en: 'woman with long hair' }, main: true }));
  ({ cast } = addCharacter(cast, { descriptor: { zh: '戴眼镜的男人', en: 'man with glasses' }, main: true }));
  ({ cast } = addCharacter(cast, { descriptor: { zh: '灰大衣男人', en: 'man in the grey coat' } }));
  for (const [id, screenSec] of Object.entries(identity.screenSeconds())) cast = updateCharacter(cast, id, { screenSec });
  // The person at the labelling desk noted what P1 wears; nobody noted the man's coat.
  return setAppearance(cast, { char: 'P1', from: 0, outfit: W.outfits.P1, src: 'human' });
}

/** One sampled frame with its marks drawn, and the legend of that moment. */
function frameAt(time, identity, cast, lang) {
  const marks = assignMarks(identity.visibleAt(time), { frame: FRAME });
  const blank = new Uint8Array(FRAME.w * FRAME.h * 3).fill(GREY);
  const rgb = drawMarks(blank, FRAME.w, FRAME.h, marks);
  // The app encodes a JPEG; the bytes of the marked picture stand in for it here.
  return { time, marks, blank, rgb, data: Buffer.from(rgb).toString('base64'), legend: legendText(marks, cast, time, { lang }) };
}

/** The legend of a section: one line for each person marked in any of its frames, in order of character number. */
function sectionLegend(frames) {
  const lines = new Map();
  for (const frame of frames) {
    for (const line of frame.legend.split('\n').filter(Boolean)) {
      const id = /^P\d+/.exec(line)[0];
      if (!lines.has(id)) lines.set(id, line);
    }
  }
  const ids = [...lines.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return { ids, text: ids.map((id) => lines.get(id)).join('\n') };
}

/** What the caller does with a cue the model did not put right: it stays in the script, still the model's, and is not spoken. */
const markNeedsCheck = (script, ids) => ({ ...script, cues: script.cues.map((cue) => (ids.includes(cue.id) ? { ...cue, status: 'needs-check' } : cue)) });

/**
 * The whole way from the subtitle file to a checked script, once per language.
 * Everything it returns is frozen: the corrections in the tests below must
 * leave it as it is.
 */
function produce(lang) {
  const W = WORDS[lang];
  const model = cannedModel();

  // 1. The dialogue, and the pauses in it.
  const lines = parseSubtitle(W.srt, 'film.srt');
  const speech = speechFromLines(lines);
  const slots = buildSlots(speech, DURATION, { lang });

  // 2. Who is on screen (labels made by hand), and the cast.
  const labels = labelsFrom(SIGHTINGS);
  const identity = groundTruthIdentity(labels);
  const unnamed = castOf(W, identity);

  // 3. The names the dialogue gives, and whom the first one belongs to: one clue for P1.
  const namesModel = route('names', { preset: W.preset }).model;
  const namesRequest = buildRequest(namesModel, namesPrompt({ lang, window: WINDOW, lines }));
  const names = readJson(model.ask(namesRequest, {
    names: [
      { name: W.name, kind: 'vocative', t: 10, line: W.spoken[0] },
      { name: W.second, kind: 'third-person', t: 28, line: W.spoken[2] },
    ],
  }));
  const around = [frameAt(13, identity, unnamed, lang)];
  const narrator = route('narrate', { preset: W.preset });
  const bindingRequest = buildRequest(narrator.model, bindingPrompt({ lang, frames: around, legend: around[0].legend, lines, name: names.names[0] }));
  const binding = readJson(model.ask(bindingRequest, { seen: W.spoken[0], mark: 'P1', role: 'addressed', confidence: 'high' }));
  const heard = names.names[0];
  const clued = addEvidence(unnamed, binding.mark, { t: heard.t, kind: heard.kind, name: heard.name, quote: heard.line });

  // 4. The frames of the section with their marks, the legend, the prompt, the request.
  const frames = FRAME_TIMES.map((time) => frameAt(time, identity, clued, lang));
  const legend = sectionLegend(frames);
  const prompt = sectionPrompt({ film: { title: W.title, year: 1998 }, lang, window: WINDOW, frames, legend: legend.text, dialogue: lines, slots: slotsBetween(slots, WINDOW.start, WINDOW.end), previous: [], synopsis: '' });
  const request = buildRequest(narrator.model, prompt);

  // 5. The answer: read, checked against the schema, cleaned, merged, verified against the picture.
  const answer = readJson(model.ask(request, answerOf(W)));
  const empty = { ...createFilmScript({ filmId: 'long-street', lang, duration: DURATION }), slots };
  const section = normalizeSection(answer, { slots, window: WINDOW, legendIds: legend.ids, lang, nextNumber: nextCueNumber(empty) });
  let cast = clued;
  for (const appearance of section.appearances) cast = setAppearance(cast, appearance);
  const merged = mergeSection(empty, section);
  const verified = verifyScript(merged, { cast, identity, legendIds: legend.ids });
  // The cues with something in them that must not be spoken would be asked for once more; here the
  // model is not asked again, so they are kept back.
  const toRepair = verified.results.filter((r) => r.status === 'needs-repair').map((r) => r.id);
  const script = markNeedsCheck(verified.script, toRepair);

  return deepFreeze({ lang, W, model, lines, speech, slots, labels, identity, unnamed, clued, cast, names, binding, namesRequest, bindingRequest, narrator, frames, legend, prompt, request, answer, section, merged, verified, toRepair, script });
}

const made = new Map();
/** The film in one language, made once. */
function film(lang) {
  if (!made.has(lang)) made.set(lang, produce(lang));
  return made.get(lang);
}

/** The cast once the listener has confirmed, by ear, what the dialogue said. */
const confirmed = (f) => confirmName(f.cast, 'P1', { name: f.W.name, by: 'ear', t: 12 });

/** Rendered cues by id. */
const byId = (cues) => Object.fromEntries(cues.map((cue) => [cue.id, cue]));
/** What the listener hears for each cue, by what happens in it (standard length); a cue that is not spoken is left out. */
function heardIn(rendered) {
  const cues = byId(rendered.cues);
  const out = {};
  for (const [what, id] of Object.entries(Q)) if (cues[id] && !cues[id].silent) out[what] = cues[id].standard;
  return out;
}
/** Every text a listener can be given, whatever length they chose. */
const everyText = (rendered) => rendered.cues.filter((cue) => !cue.silent).flatMap((cue) => [cue.brief, cue.standard, cue.detailed]);

/** The three colour values of one pixel. */
const pixel = (rgb, x, y) => [...rgb.subarray((y * FRAME.w + x) * 3, (y * FRAME.w + x) * 3 + 3)];

/** The parts of a request body, whichever protocol it is in. */
function partsOf({ wire, body }) {
  if (wire === 'openai') {
    const [system, user] = body.messages;
    const content = typeof user.content === 'string' ? [{ type: 'text', text: user.content }] : user.content;
    const texts = content.filter((part) => part.type === 'text').map((part) => part.text);
    return {
      system: system.content,
      images: content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url.replace(/^data:image\/jpeg;base64,/, '')),
      labels: texts.slice(0, -1),
      text: texts[texts.length - 1],
      plain: typeof user.content === 'string',
    };
  }
  const parts = body.contents[0].parts;
  const texts = parts.filter((part) => typeof part.text === 'string').map((part) => part.text);
  return {
    system: body.systemInstruction.parts[0].text,
    images: parts.filter((part) => part.inlineData).map((part) => part.inlineData.data),
    labels: texts.slice(0, -1),
    text: texts[texts.length - 1],
    plain: false,
  };
}

/**
 * Plays a player script through the web player's Playback. The film's clock
 * moves a quarter of a second per tick, as the page's does; the output takes as
 * long to say a text as estimateSeconds says at the listener's speaking rate,
 * and records what it said and when.
 */
async function play(playerScript, { notice, settings = {} }) {
  const chosen = { mode: 'gaps', detail: 'standard', density: 'standard', output: 'tts', readerSpeed: 1, ttsRate: 1, ...settings };
  const player = {
    time: 0,
    state: STATE.PLAYING,
    calls: [],
    getCurrentTime: () => player.time,
    getPlayerState: () => player.state,
    getPlaybackRate: () => 1,
    pauseVideo: () => {
      player.calls.push('pause');
      player.state = STATE.PAUSED;
    },
    playVideo: () => {
      player.calls.push('play');
      player.state = STATE.PLAYING;
    },
  };
  const spoken = [];
  let speaking = null; // { until, done } while the output speaks
  const finish = () => {
    if (!speaking) return;
    const { done } = speaking;
    speaking = null;
    done();
  };
  const output = {
    voiceOn: true,
    get speaking() {
      return speaking !== null;
    },
    say(text) {
      // A new utterance cuts off the one before it, as the real output does.
      finish();
      const entry = { text, at: player.time, until: player.time + estimateSeconds(text, chosen.ttsRate) };
      spoken.push(entry);
      return new Promise((done) => {
        speaking = { until: entry.until, done };
      });
    },
    stop: finish,
  };
  const playback = new Playback({ player: () => player, output, getSettings: () => chosen, aiNotice: () => notice });
  playback.setScript(playerScript);
  for (let tick = 0; tick <= playerScript.duration * 4; tick += 1) {
    player.time = tick / 4;
    if (speaking && player.time >= speaking.until) finish();
    // Playback learns that the speech ended in a microtask.
    await null;
    await null;
    playback.tick();
  }
  finish();
  return { spoken, player };
}

const LANGS = Object.keys(WORDS);

describe.each(LANGS)('a film from subtitles to speech (%s)', (lang) => {
  const W = WORDS[lang];

  it('reads the subtitle file and finds the pauses between the lines', () => {
    const f = film(lang);
    expect(f.lines).toEqual(LINE_TIMES.map(([start, end], i) => ({ start, end, text: W.spoken[i] })));
    expect(f.speech).toEqual(LINE_TIMES.map(([start, end]) => ({ start, end })));
    expect(f.slots.map((s) => [s.start, s.end])).toEqual(SLOT_TIMES);
    expect(f.slots.map((s) => s.id)).toEqual(['g_0001', 'g_0002', 'g_0003', 'g_0004', 'g_0005', 'g_0006', 'g_0007']);
    expect(f.slots.map((s) => s.room)).toEqual([9.7, 5.6, 7.1, 7.6, 7.6, 7.6, 11.9]);
    expect(f.slots.every((s) => s.budget.units === W.units && s.src === 'subs')).toBe(true);
    // No slot touches a line: while someone speaks there is no room.
    for (const line of f.lines) {
      expect(slotAt(f.slots, line.start)).toBeNull();
      expect(slotAt(f.slots, (line.start + line.end) / 2)).toBeNull();
      expect(slotAt(f.slots, line.end)).toBeNull();
    }
  });

  it('takes a name from the dialogue as one clue, which nobody hears yet', () => {
    const f = film(lang);
    // The names are read from text alone, and the model is not told which film it is.
    const asked = partsOf(f.namesRequest);
    expect(asked.images).toEqual([]);
    // A text model on the chat protocol gets a plain string, not a list of parts.
    expect(asked.plain).toBe(f.namesRequest.wire === 'openai');
    expect(asked.text).toContain(`[10.0] ${W.spoken[0]}`);
    expect(asked.text).not.toContain(W.title);
    expect(check(f.names, NAMES_SCHEMA)).toEqual([]);
    // Whom the name belongs to is asked with a marked frame, the line pointed at.
    const bound = partsOf(f.bindingRequest);
    expect(bound.images).toHaveLength(1);
    expect(bound.text).toContain(`Name: ${JSON.stringify(W.name)}`);
    expect(bound.text).toContain(`>> [10.0–12.0 s] ${W.spoken[0]}`);
    expect(bound.text).toContain(f.frames[1].legend.split('\n')[0]);
    expect(check(f.binding, BINDING_SCHEMA)).toEqual([]);

    const before = getCharacter(f.unnamed, 'P1');
    expect([before.name, before.level]).toEqual([null, LEVEL.LABEL]);
    const p1 = getCharacter(f.cast, 'P1');
    expect([p1.name, p1.level, p1.revealAt]).toEqual([W.name, LEVEL.CLUE, 10]);
    expect(p1.evidence).toEqual([{ t: 10, kind: 'vocative', name: W.name, quote: W.spoken[0] }]);
    // One clue is not a name anybody should hear, at any time in the film.
    expect(unlocked(p1, 0, f.cast.policy)).toBe(false);
    expect(unlocked(p1, DURATION, f.cast.policy)).toBe(false);
    expect(unlocked(p1, DURATION, { ...DEFAULT_POLICY, minLevel: LEVEL.CLUES })).toBe(false);
    // The name said about someone who is not addressed was bound to nobody.
    expect(f.cast.characters.map((c) => c.name)).toEqual([W.name, null, null]);
    expect(f.cast.characters.map((c) => c.screenSec)).toEqual([24, 8, 4]);
  });

  it('marks the people of a frame and draws the marks on a copy of the picture', () => {
    const f = film(lang);
    const frame = f.frames[1];
    expect(frame.time).toBe(13);
    expect(frame.marks).toEqual([
      { char: 'P1', colour: MARK_COLOURS[0], box: [20, 20, 64, 64], kind: 'face' },
      // A face too small to carry a mark: the person is boxed, down to the bottom of the frame.
      { char: 'P2', colour: MARK_COLOURS[1], box: [82, 30, 78, 60], kind: 'person' },
    ]);
    const orange = [...MARK_COLOURS[0].rgb];
    const skyBlue = [...MARK_COLOURS[1].rgb];
    const grey = [GREY, GREY, GREY];
    expect(frame.rgb).toBeInstanceOf(Uint8Array);
    expect(frame.rgb).toHaveLength(FRAME.w * FRAME.h * 3);
    // The picture handed in is left as it was.
    expect(frame.blank.every((v) => v === GREY)).toBe(true);
    // The outlines, in each mark's colour; the face inside is untouched.
    expect(pixel(frame.rgb, 20, 50)).toEqual(orange);
    expect(pixel(frame.rgb, 50, 20)).toEqual(orange);
    expect(pixel(frame.rgb, 50, 83)).toEqual(orange);
    expect(pixel(frame.rgb, 52, 52)).toEqual(grey);
    expect(pixel(frame.rgb, 159, 60)).toEqual(skyBlue);
    expect(pixel(frame.rgb, 120, 89)).toEqual(skyBlue);
    expect(pixel(frame.rgb, 120, 60)).toEqual(grey);
    // The tags sit on top of the boxes: the mark's colour, with the id in the ink that reads on it.
    expect(pixel(frame.rgb, 20, 2)).toEqual(orange);
    expect(pixel(frame.rgb, 22, 4)).toEqual(tagTextColour(orange));
    expect(pixel(frame.rgb, 82, 12)).toEqual(skyBlue);
    expect(pixel(frame.rgb, 84, 14)).toEqual(tagTextColour(skyBlue));
    expect(pixel(frame.rgb, 0, 0)).toEqual(grey);
    // Nobody is marked in the frame of the shop sign, and nothing is drawn on it.
    const sign = f.frames[6];
    expect(sign.marks).toEqual([]);
    expect(sign.legend).toBe('');
    expect(sign.rgb.every((v) => v === GREY)).toBe(true);
    // P3 has the third colour, the one the legend calls red.
    expect(f.frames[5].marks.map((m) => [m.char, m.colour.id])).toEqual([['P1', 'orange'], ['P3', 'vermilion']]);
  });

  it('writes a legend that says who each mark is and keeps an unconfirmed name back', () => {
    const f = film(lang);
    expect(f.legend.ids).toEqual(['P1', 'P2', 'P3']);
    expect(f.legend.text).toBe([W.legend.P1, W.legend.P2, W.legend.P3].join('\n'));
    expect(f.legend.text).not.toContain(W.name);
    expect(f.frames.map((frame) => frame.legend.split('\n').filter(Boolean).length)).toEqual([1, 2, 1, 1, 1, 2, 0]);
    // Once a person has confirmed the name, the legend tells the model whom the dialogue means.
    const frame = f.frames[0];
    expect(legendText(frame.marks, confirmed(f), frame.time, { lang })).toBe(W.legend.named);
    // And once the model has reported the coat, the next legend shows it.
    expect(legendText(f.frames[2].marks, f.cast, 22, { lang })).toContain(W.outfits.P2);
    expect(legendText(f.frames[2].marks, f.clued, 22, { lang })).not.toContain(W.outfits.P2);
  });

  it.each([['cn', 'openai'], ['global', 'gemini']])('builds the section request for the %s preset (%s wire) with the frames, the legend and the token rule', (preset, wire) => {
    const f = film(lang);
    const { model } = route('narrate', { preset });
    const request = buildRequest(model, f.prompt);
    expect(request.wire).toBe(wire);
    expect(model.wire).toBe(wire);
    const asked = partsOf(request);

    // The rules: a person is a token, never a name, never a box.
    expect(asked.system).toContain('Refer to a marked person ONLY by the token of their id: the id in curly braces, for example {P3}.');
    expect(asked.system).toContain('Never write a person\'s name, even when the legend or the dialogue gives it.');
    expect(asked.system).toContain('Never mention a box, the colour of a box, a tag, its number or an id in the text');
    expect(asked.system).toContain(SECTION_SHAPE);

    // The frames: every one, in time order, each behind its label, the marked picture itself.
    expect(asked.labels).toEqual(FRAME_TIMES.map(frameLabel));
    expect(asked.images).toHaveLength(FRAME_TIMES.length);
    expect(asked.images.every((data, i) => data === f.frames[i].data)).toBe(true);
    expect(Buffer.from(asked.images[1], 'base64').equals(Buffer.from(f.frames[1].rgb))).toBe(true);
    expect(Buffer.from(asked.images[1], 'base64').equals(Buffer.from(f.frames[1].blank))).toBe(false);

    // The request: the legend, the dialogue, every slot with its budget, the language.
    for (const line of f.legend.text.split('\n')) expect(asked.text).toContain(line);
    for (const line of f.lines) expect(asked.text).toContain(line.text);
    for (const slot of f.slots) expect(asked.text).toContain(`${slot.id} | ${slot.start.toFixed(1)}–${slot.end.toFixed(1)} s | brief `);
    expect(asked.text).toContain(`Film: ${W.title} (1998)`);
    expect(asked.text).toContain(`Write in ${languageName(lang)}.`);
    expect(asked.system).toContain(`Write every description and every outfit in ${languageName(lang)}.`);
    // The only place the unconfirmed name stands is the line of dialogue that says it.
    expect(asked.text.split(W.name)).toHaveLength(2);
    expect(asked.system).not.toContain(W.name);

    if (wire === 'openai') {
      expect(request.body.model).toBe(model.id);
      expect(request.body.response_format).toEqual({ type: 'json_object' });
      expect(request.body.max_tokens).toBe(8192);
      expect(request.body.temperature).toBe(0.3);
    } else {
      expect(request.body.generationConfig.responseMimeType).toBe('application/json');
      expect(request.body.generationConfig.responseSchema.type).toBe('OBJECT');
      expect(request.body.generationConfig.responseSchema.properties.cues.items.required).toEqual(SECTION_SCHEMA.properties.cues.items.required);
      expect(request.body.generationConfig.maxOutputTokens).toBe(8192);
    }
  });

  it('sends each task to the model of the preset, and gives no model the character lock before it has passed K1', () => {
    const f = film(lang);
    expect(f.narrator.model.wire).toBe(W.wire);
    expect(f.request.wire).toBe(W.wire);
    expect([f.narrator.characterLock, f.narrator.reason]).toEqual([false, 'k1-not-run']);
    const passed = MODELS.map((m) => (m.id === f.narrator.model.id ? { ...m, verified: true, k1: { date: '2026-11-15', wrongPer100: 0.4, pass: true } } : m));
    expect(route('narrate', { preset: W.preset, catalog: passed })).toMatchObject({ characterLock: true, reason: '' });
    // Three questions were put to a model for the whole film: the names, whose name, the section.
    expect(f.model.asked).toHaveLength(3);
    expect(f.model.asked[2]).toBe(f.request);
  });

  it('reads the answer, checks it against the schema and cleans it', () => {
    const f = film(lang);
    expect(check(f.answer, SECTION_SCHEMA)).toEqual([]);
    expect(f.answer.cues).toHaveLength(9);

    const { cues, sceneStarts, appearances, problems } = f.section;
    expect(cues.map((c) => c.id)).toEqual(Object.values(Q));
    // Every cue has the times of its slot, whatever the model wrote: the id in capitals, or only a time.
    expect(cues.map((c) => c.slot)).toEqual(f.slots.map((s) => s.id));
    expect(cues.map((c) => [c.start, c.end])).toEqual(SLOT_TIMES);
    expect(cues.every((c) => c.status === 'ai' && c.by === 'ai')).toBe(true);
    // Full-width braces are tokens like any other, and people follows the tokens.
    expect(cues[1].standard).toBe(W.model.enters.standard.replace('｛P2｝', '{P2}'));
    expect(cues[1].people).toEqual([{ char: 'P2' }, { char: 'P1' }]);
    expect(cues.map((c) => tokensIn(c.standard))).toEqual([['P1'], ['P2', 'P1'], ['P1'], [], [], ['P3', 'P1'], []]);
    expect(cues.every((c) => !/[｛｝]/.test(c.brief + c.standard + c.detailed))).toBe(true);
    // One cue per slot: the more important stays.
    expect(cues[0].standard).toBe(W.model.window.standard);
    expect(cues[0].priority).toBe(1);
    expect(cues[6]).toMatchObject({ kind: 'text', onScreenText: W.signText, standard: W.model.sign.standard });
    expect(cues[2].confidence).toBe('medium');

    expect(sceneStarts).toEqual([0, 30.5]);
    expect(appearances).toEqual([{ char: 'P2', outfit: W.outfits.P2, from: 13, src: 'model' }]);
    expect(problems.map((p) => p.type)).toEqual(['duplicate-slot', 'no-slot', 'outside-window', 'unknown-character']);

    expect(f.merged.cues).toEqual(cues);
    expect(f.merged.scenes).toEqual([0, 30.5]);
    expect(f.merged.slots).toBe(f.slots);
    expect(f.cast.appearances.map((a) => [a.char, a.from, a.outfit, a.src])).toEqual([['P1', 0, W.outfits.P1, 'human'], ['P2', 13, W.outfits.P2, 'model']]);
  });

  it('checks the script against the picture: one person demoted, one generic person given her token, one leak reported', () => {
    const f = film(lang);
    expect(f.verified.report).toEqual({ checked: 7, demoted: 1, needsRepair: 1, relapses: 0 });
    const results = byId(f.verified.results);
    const cues = byId(f.verified.script.cues);

    // The cue that names someone who is not in the picture: P1 is demoted, nothing else is wrong with it.
    expect(results[Q.tea]).toMatchObject({ status: 'demoted', demoted: ['P1'], violations: [], trackCheck: 'failed' });
    expect(cues[Q.tea].people).toEqual([{ char: 'P1', demoted: true }]);

    // "一个女人" / "A woman" while the one main character on screen is P1: the token takes its place.
    expect(results[Q.sits]).toMatchObject({ status: 'ok', repaired: true, relapse: false, trackCheck: 'ok' });
    expect(tokensIn(cues[Q.sits].brief + cues[Q.sits].standard + cues[Q.sits].detailed)).toEqual(['P1']);
    expect(cues[Q.sits].people).toEqual([{ char: 'P1' }]);

    // The name written out, in each of the three lengths.
    expect(results[Q.door].status).toBe('needs-repair');
    expect(results[Q.door].violations).toEqual(['brief', 'standard', 'detailed'].map((field) => ({ type: 'name-leak', detail: W.name, field })));
    expect(f.toRepair).toEqual([Q.door]);

    // The sign may carry the name: it is on-screen text, quoted.
    expect(results[Q.sign]).toMatchObject({ status: 'ok', violations: [] });
    for (const id of [Q.window, Q.enters, Q.phone]) expect(results[id]).toMatchObject({ status: 'ok', demoted: [], violations: [], trackCheck: 'ok' });

    // The cue kept back is still the model's (a later answer may replace it) and is marked for a person.
    expect(byId(f.script.cues)[Q.door]).toMatchObject({ status: 'needs-check', by: 'ai' });
    expect(f.script.cues.filter((c) => c.status === 'needs-check')).toHaveLength(1);
  });

  it('gives the listener the stable label while the name is only a clue', () => {
    const f = film(lang);
    const rendered = renderScript(f.script, f.cast, undefined, { lang });
    expect(heardIn(rendered)).toEqual(W.labels);
    expect(byId(rendered.cues)[Q.window].forms).toEqual({ P1: 'label-outfit' });
    expect(byId(rendered.cues)[Q.enters].forms).toEqual({ P2: 'label-outfit', P1: 'label' });
    expect(rendered.report).toEqual({ introducedAt: {}, deferred: [], silenced: [Q.door] });
    // The name is heard nowhere but on the shop sign.
    const named = everyText(rendered).filter((text) => text.includes(W.name));
    expect(new Set(named)).toEqual(new Set([W.labels.sign]));
    // Nor is anything of the machinery: no token, no id, no box.
    expect(everyText(rendered).some((text) => /[{}｛｝]|\bP\d/.test(text))).toBe(false);
  });

  it('introduces the confirmed name once, with the outfit, and says the name alone after that', () => {
    const f = film(lang);
    const cast = confirmed(f);
    expect(getCharacter(cast, 'P1')).toMatchObject({ name: W.name, level: LEVEL.CONFIRMED });
    const rendered = renderScript(f.script, cast, undefined, { lang });
    expect(heardIn(rendered)).toEqual(W.named);

    const cues = byId(rendered.cues);
    expect(cues[Q.window].standard.startsWith(W.intro)).toBe(true);
    expect(cues[Q.window].forms).toEqual({ P1: 'intro' });
    expect(cues[Q.enters].forms).toEqual({ P2: 'label-outfit', P1: 'name' });
    expect(cues[Q.sits].forms).toEqual({ P1: 'name' });
    expect(cues[Q.phone].forms).toEqual({ P3: 'label', P1: 'name' });
    expect(rendered.report).toEqual({ introducedAt: { P1: Q.window }, deferred: [], silenced: [Q.door] });
    // The introduction is made in every length of the first cue, and in no later cue.
    for (const version of ['brief', 'standard', 'detailed']) expect(cues[Q.window][version]).toContain(W.intro);
    const later = rendered.cues.filter((cue) => cue.id !== Q.window && !cue.silent);
    expect(later.some((cue) => [cue.brief, cue.standard, cue.detailed].some((text) => text.includes(W.intro)))).toBe(false);
    // The generic person the model fell back on is the name now.
    expect(cues[Q.sits].standard).toBe(W.named.sits);
    expect(cues[Q.sits].standard).toContain(W.name);
  });

  it('says the label, not the name, where the picture does not show the person the model named', () => {
    const f = film(lang);
    const rendered = renderScript(f.script, confirmed(f), undefined, { lang });
    const tea = byId(rendered.cues)[Q.tea];
    expect(tea.standard).toBe(W.named.tea);
    expect(tea.forms).toEqual({ P1: 'label' });
    expect([tea.brief, tea.standard, tea.detailed].some((text) => text.includes(W.name))).toBe(false);
    // Unchecked, the same cue would have put the name on someone who is not there.
    const unchecked = renderScript(f.merged, confirmed(f), undefined, { lang });
    expect(byId(unchecked.cues)[Q.tea].standard).toBe(W.unchecked.tea);
  });

  it('keeps a person\'s correction of that cue: checked against the picture, and never replaced by a later answer', () => {
    const f = film(lang);
    const cast = confirmed(f);
    // A sighted helper sees that it is the man who pours the tea, and puts his token there.
    const tea = byId(f.script.cues)[Q.tea];
    const his = (text) => text.replace('{P1}', '{P2}');
    const edited = editCue(f.script, Q.tea, { brief: his(tea.brief), standard: his(tea.standard), detailed: his(tea.detailed) });
    expect(byId(edited.cues)[Q.tea]).toMatchObject({ by: 'human', status: 'edited', people: [{ char: 'P2' }], slot: 'g_0003', start: 20.6 });
    const checked = verifyScript(edited, { cast, identity: f.identity, legendIds: f.legend.ids });
    expect(byId(checked.results)[Q.tea]).toMatchObject({ status: 'ok', demoted: [], trackCheck: 'ok' });
    expect(checked.report).toEqual({ checked: 7, demoted: 0, needsRepair: 1, relapses: 0 });
    const rendered = renderScript(checked.script, cast, undefined, { lang });
    expect(heardIn(rendered)).toEqual({ ...W.named, ...W.edited });

    // The model, asked about the section again, still writes the wrong person: the person's cue stays.
    const again = normalizeSection(
      { cues: [{ slot: 'g_0003', kind: 'visual', priority: 2, onScreenText: '', confidence: 'high', ...W.model.tea }], sceneStarts: [], appearances: [] },
      { slots: f.slots, window: WINDOW, legendIds: f.legend.ids, lang, nextNumber: nextCueNumber(checked.script) },
    );
    expect(again.cues).toHaveLength(1);
    expect(mergeSection(checked.script, again).cues).toEqual(checked.script.cues);
  });

  it('never speaks the cue with the leaked name, and takes a second answer for its slot', () => {
    const f = film(lang);
    const cast = confirmed(f);
    const rendered = renderScript(f.script, cast, undefined, { lang });
    const door = byId(rendered.cues)[Q.door];
    expect(door.silent).toBe(true);
    expect(door.standard).toBe(W.door);
    const playerScript = toPlayerScript(rendered.cues, { videoId: 'long-street', lang, duration: DURATION });
    expect(playerScript.cues.map((c) => c.id)).toEqual([Q.window, Q.enters, Q.tea, Q.sits, Q.phone, Q.sign]);
    expect(playerScript.cues.some((c) => c.standard === W.door)).toBe(false);

    // Asked once more, the model writes the token: the new cue takes the slot of the one kept back.
    const again = normalizeSection(
      { cues: [{ slot: 'g_0005', kind: 'visual', priority: 1, onScreenText: '', confidence: 'high', ...W.model.repaired }], sceneStarts: [], appearances: [] },
      { slots: f.slots, window: WINDOW, legendIds: f.legend.ids, lang, nextNumber: nextCueNumber(f.script) },
    );
    expect(again.problems).toEqual([]);
    const second = verifyScript(mergeSection(f.script, again), { cast, identity: f.identity, legendIds: f.legend.ids });
    expect(second.report).toEqual({ checked: 7, demoted: 1, needsRepair: 0, relapses: 0 });
    expect(second.script.cues.map((c) => c.id)).toEqual([Q.window, Q.enters, Q.tea, Q.sits, 'q_000008', Q.phone, Q.sign]);
    const repaired = renderScript(second.script, cast, undefined, { lang });
    expect(repaired.report.silenced).toEqual([]);
    expect(byId(repaired.cues).q_000008.standard).toBe(W.door);
    expect(byId(repaired.cues).q_000008.forms).toEqual({ P1: 'name' });
  });

  it('renames a character by rendering again: every cue follows, the script is untouched, no model is asked', () => {
    const f = film(lang);
    const asked = f.model.asked.length;
    const before = renderScript(f.script, confirmed(f), undefined, { lang });
    // The listener hears that the name was taken down wrong, and puts it right.
    const renamedCast = confirmName(confirmed(f), 'P1', { name: W.renamed, by: 'ear', t: 40 });
    const after = renderScript(f.script, renamedCast, undefined, { lang });

    const swap = (text) => text.split(W.name).join(W.renamed);
    for (const what of ['window', 'enters', 'sits', 'phone']) {
      const was = byId(before.cues)[Q[what]];
      const now = byId(after.cues)[Q[what]];
      for (const version of ['brief', 'standard', 'detailed']) expect(now[version]).toBe(swap(was[version]));
      expect(now.standard).not.toBe(was.standard);
      expect(now.standard).toContain(W.renamed);
    }
    // The old name is left only where the film itself shows it: on the sign.
    const old = everyText(after).filter((text) => text.includes(W.name));
    expect(new Set(old)).toEqual(new Set([W.named.sign]));
    expect(byId(after.cues)[Q.tea].standard).toBe(W.named.tea);
    expect(after.report.introducedAt).toEqual({ P1: Q.window });

    // Nothing else was needed: the same script (frozen), the same number of questions to a model.
    expect(f.model.asked).toHaveLength(asked);
    expect(f.script.cues.some((cue) => (cue.brief + cue.standard + cue.detailed).includes(W.renamed))).toBe(false);

    // Clips made from the old wording are the ones to make again.
    const withClips = {
      ...f.script,
      cues: f.script.cues.map((cue) => ({ ...cue, clip: { file: `${cue.id}.mp3`, dur: 3, voice: 'test', textHash: textHash(byId(before.cues)[cue.id].standard), version: 'standard' } })),
    };
    expect(staleClips(withClips, before.cues)).toEqual([]);
    expect(staleClips(withClips, after.cues)).toEqual([Q.window, Q.enters, Q.sits, Q.phone]);
  });

  it('takes a name back by rendering again: refused, or never to be said', () => {
    const f = film(lang);
    const cast = confirmed(f);
    // The person does not want her named: the labels are back, the outfit said once as before.
    const unnamed = renderScript(f.script, neverName(cast, 'P1'), undefined, { lang });
    expect(heardIn(unnamed)).toEqual(W.labels);
    expect(unnamed.report.introducedAt).toEqual({});
    // The name was wrong altogether: the clue from the dialogue goes with the confirmation.
    const refused = rejectName(cast, 'P1', W.name);
    expect(getCharacter(refused, 'P1')).toMatchObject({ name: null, level: LEVEL.LABEL });
    expect(heardIn(renderScript(f.script, refused, undefined, { lang }))).toEqual(W.labels);
    // And taken back again, she is named as before.
    expect(heardIn(renderScript(f.script, neverName(neverName(cast, 'P1'), 'P1', false), undefined, { lang }))).toEqual(W.named);
    expect(f.model.asked).toHaveLength(3);
  });

  it('merges two characters that are one person: the tokens are rewritten and the film follows', () => {
    const f = film(lang);
    const asked = f.model.asked.length;
    const { cast: merged, remap } = mergeCharacters(confirmed(f), 'P2', 'P3');
    expect(remap).toEqual({ P3: 'P2' });
    expect(merged.characters.map((c) => c.id)).toEqual(['P1', 'P2']);
    expect(getCharacter(merged, 'P2')).toMatchObject({ descriptor: { zh: '戴眼镜的男人', en: 'man with glasses' }, screenSec: 12, main: true });

    const script = remapTokens(f.script, remap);
    const phone = byId(script.cues)[Q.phone];
    expect(tokensIn(phone.brief + phone.standard + phone.detailed)).toEqual(['P2', 'P1']);
    expect(phone.people).toEqual([{ char: 'P2' }, { char: 'P1' }]);
    expect(script.cues.some((cue) => /\{P3\}/.test(cue.brief + cue.standard + cue.detailed))).toBe(false);
    // The cues that never mentioned P3 are the same objects.
    for (const id of [Q.window, Q.enters, Q.tea, Q.sits, Q.door, Q.sign]) expect(byId(script.cues)[id]).toBe(byId(f.script.cues)[id]);

    const rendered = renderScript(script, merged, undefined, { lang });
    expect(heardIn(rendered)).toEqual({ ...W.named, ...W.merged });
    // His coat was said when he came in; it is not said again.
    expect(byId(rendered.cues)[Q.phone].forms).toEqual({ P2: 'label', P1: 'name' });

    // The labels made by hand follow the merge too, and the picture still supports every token.
    const relabelled = groundTruthIdentity(f.labels.map((label) => ({ ...label, characterId: remap[label.characterId] || label.characterId })));
    const checked = verifyScript(script, { cast: merged, identity: relabelled, legendIds: ['P1', 'P2'] });
    expect(byId(checked.results)[Q.phone]).toMatchObject({ status: 'ok', demoted: [] });

    // Without the remap the old token belongs to nobody: the cue is kept silent rather than guessed at.
    const stale = renderScript(f.script, merged, undefined, { lang });
    expect(stale.report.silenced).toEqual([Q.door, Q.phone]);

    // With the man confirmed as well, both names are in the film, each introduced once.
    const both = confirmName(merged, 'P2', { name: W.second, by: 'sight', t: 30 });
    const full = renderScript(script, both, undefined, { lang });
    expect(heardIn(full)).toEqual({ ...W.named, ...W.both });
    expect(full.report.introducedAt).toEqual({ P1: Q.window, P2: Q.enters });
    expect(f.model.asked).toHaveLength(asked);
  });

  it('names nobody when no faces are tracked, unless names are allowed without tracks', () => {
    const f = film(lang);
    const cast = confirmed(f);
    const blind = verifyScript(f.merged, { cast, identity: promptBankIdentity(), legendIds: f.legend.ids });
    // Nobody can tell who is in the picture: every person is demoted, and the generic person stays.
    expect(blind.report).toEqual({ checked: 7, demoted: 4, needsRepair: 1, relapses: 1 });
    expect(blind.results.every((r) => r.trackCheck === 'n/a')).toBe(true);
    const kept = markNeedsCheck(blind.script, [Q.door]);
    const rendered = renderScript(kept, cast, undefined, { lang });
    expect(heardIn(rendered)).toEqual(W.bare);
    const names = everyText(rendered).filter((text) => text.includes(W.name));
    expect(new Set(names)).toEqual(new Set([W.labels.sign]));
    expect(rendered.report.introducedAt).toEqual({});
    expect(Object.values(byId(rendered.cues)[Q.enters].forms)).toEqual(['label', 'label']);

    // The listener's choice to hear names unchecked: they are spoken, a wrong one included.
    const trusting = verifyScript(f.merged, { cast, identity: promptBankIdentity(), legendIds: f.legend.ids, allowNamesWithoutTracks: true });
    expect(trusting.report).toEqual({ checked: 7, demoted: 0, needsRepair: 1, relapses: 1 });
    const spoken = heardIn(renderScript(markNeedsCheck(trusting.script, [Q.door]), cast, undefined, { lang }));
    expect(spoken).toEqual({ ...W.named, ...W.unchecked });
  });

  it('says who the main characters are before the film, and who is on screen when asked', () => {
    const f = film(lang);
    const cast = confirmed(f);
    // Nobody is introduced before a name is confirmed.
    expect(castIntro(f.cast, undefined, { lang })).toBe('');
    expect(castIntro(cast, undefined, { lang })).toBe(W.castIntro.one);
    const both = confirmName(cast, 'P2', { name: W.second, by: 'sight', t: 30 });
    expect(castIntro(both, undefined, { lang })).toBe(W.castIntro.two);
    expect(castIntro(both, { introBeforeFilm: false }, { lang })).toBe('');

    expect(whoIsOnScreen(f.identity.visibleAt(13), f.cast, undefined, 13, { lang })).toBe(W.onScreen.before);
    expect(whoIsOnScreen(f.identity.visibleAt(13), cast, undefined, 13, { lang })).toBe(W.onScreen.after);
    expect(whoIsOnScreen(f.identity.visibleBetween(12, 16), cast, undefined, 13, { lang })).toBe(W.onScreen.after);
    expect(whoIsOnScreen(f.identity.visibleAt(27), cast, undefined, 27, { lang })).toBe(W.onScreen.nobody);
    const noFaces = promptBankIdentity();
    // Nothing checked the picture: the people last described are given by label, as the descriptions give them,
    // unless the listener chose to hear names unchecked.
    expect(whoIsOnScreen(noFaces.visibleBetween(12, 16), cast, undefined, 13, { lang, recentIds: ['P1', 'P2'] })).toBe(W.onScreen.cannotTell);
    expect(whoIsOnScreen(noFaces.visibleBetween(12, 16), cast, undefined, 13, { lang, recentIds: ['P1', 'P2'], allowNamesWithoutTracks: true })).toBe(W.onScreen.cannotTellNamed);
  });

  it('waits for the film to give the name when the policy says so, and for a pause with room for it, again with no model asked', () => {
    const f = film(lang);
    const cast = confirmed(f);
    // The clue from the dialogue set the reveal point: the line at 10 seconds.
    expect(getCharacter(cast, 'P1').revealAt).toBe(10);
    const rendered = renderScript(f.script, cast, { naming: 'on-reveal' }, { lang });
    expect(heardIn(rendered)).toMatchObject(W.reveal.heard);
    expect(byId(rendered.cues)[Q.window].forms).toEqual({ P1: 'label-outfit' });
    const introduction = Q[W.reveal.introducedIn];
    expect(byId(rendered.cues)[introduction].forms.P1).toBe('intro');
    expect(rendered.report).toEqual({ introducedAt: { P1: introduction }, deferred: W.reveal.deferred.map((what) => Q[what]), silenced: [Q.door] });
    // Before the reveal nothing gives the name away; after the introduction it stands alone.
    expect(byId(rendered.cues)[Q.window].standard).not.toContain(W.name);
    expect(byId(rendered.cues)[Q.phone].standard).toBe(W.named.phone);
    // Whatever the wording, each text still fits its pause.
    for (const cue of rendered.cues.filter((c) => !c.silent)) expect(estimateSeconds(cue.brief, 1)).toBeLessThanOrEqual(cue.room);
    expect(f.model.asked).toHaveLength(3);
  });

  it('says the same film from what a package carries, and a package carries no line of dialogue', () => {
    const f = film(lang);
    const cast = confirmed(f);
    const carried = JSON.parse(JSON.stringify({ script: f.script, cast: exportCast(cast) }));
    // Names and labels travel; the evidence, with the line the name was heard in, stays on this computer.
    expect(JSON.stringify(carried.cast)).toContain(W.name);
    expect(JSON.stringify(carried.cast)).not.toContain(W.spoken[0]);
    expect(carried.cast.characters[0]).toMatchObject({ id: 'P1', name: W.name, level: LEVEL.CONFIRMED, confirmedBy: 'ear' });
    expect(carried.cast.characters[0]).not.toHaveProperty('evidence');

    const script = validateFilmScript(carried.script);
    expect(script).toEqual(carried.script);
    const there = renderScript(script, validateCast(carried.cast), undefined, { lang });
    const here = renderScript(f.script, cast, undefined, { lang });
    expect(there).toEqual(here);
    expect(heardIn(there)).toEqual(W.named);
  });

  it('hands the player a script in the shape the extension already plays', () => {
    const f = film(lang);
    const rendered = renderScript(f.script, confirmed(f), undefined, { lang });
    const playerScript = toPlayerScript(rendered.cues, { videoId: 'long-street', lang, duration: DURATION });
    expect(playerScript).toMatchObject({ version: SCRIPT_VERSION, videoId: 'long-street', lang, duration: DURATION, characters: [], completedUntil: DURATION, complete: true, model: 'film' });
    expect(playerScript.cues).toHaveLength(6);
    const first = playerScript.cues[0];
    expect(first).toEqual({ id: Q.window, start: 0, gap: 9.7, gapMeasured: true, kind: 'visual', priority: 1, brief: byId(rendered.cues)[Q.window].brief, standard: W.named.window, detailed: byId(rendered.cues)[Q.window].detailed });
    expect(playerScript.cues[5]).toMatchObject({ id: Q.sign, kind: 'text', start: 60.1, gap: 11.9 });
    // Every text fits the pause it was written for, at the listener's speaking rate.
    for (const cue of playerScript.cues) expect(estimateSeconds(cue.standard, 1)).toBeLessThanOrEqual(cue.gap);
  });

  it('plays through the web player: the introduction, then the bare name, and never over a line of dialogue', async () => {
    const f = film(lang);
    const rendered = renderScript(f.script, confirmed(f), undefined, { lang });
    const playerScript = toPlayerScript(rendered.cues, { videoId: 'long-street', lang, duration: DURATION });
    const { spoken, player } = await play(playerScript, { notice: W.notice });

    expect(spoken.map((s) => s.text)).toEqual([
      `${W.notice} ${W.named.window}`,
      W.named.enters,
      W.named.tea,
      W.named.sits,
      W.named.phone,
      W.named.sign,
    ]);
    // The introduction is heard first, and once; after it the name stands alone, without the label.
    const texts = spoken.map((s) => s.text);
    const introduced = texts.findIndex((text) => text.includes(W.intro));
    expect(introduced).toBe(0);
    expect(texts.filter((text) => text.includes(W.intro))).toHaveLength(1);
    for (const what of ['enters', 'sits', 'phone']) {
      const at = texts.indexOf(W.named[what]);
      expect(at).toBeGreaterThan(introduced);
      expect(texts[at]).toContain(W.name);
      expect(texts[at]).not.toContain(W.label);
    }
    // The one place her label is heard again is the cue the picture did not support.
    expect(texts.filter((text, i) => i > introduced && text.includes(W.label))).toEqual([W.named.tea]);
    // The cue with the leaked name was never said.
    expect(texts).not.toContain(W.door);
    expect(spoken.some((s) => slotAt(f.slots, s.at)?.id === 'g_0005')).toBe(false);

    // Every description starts inside a pause, each in a pause of its own, and is over before the next line.
    const slots = spoken.map((s) => slotAt(f.slots, s.at));
    expect(slots.map((s) => s?.id)).toEqual(['g_0001', 'g_0002', 'g_0003', 'g_0004', 'g_0006', 'g_0007']);
    for (const said of spoken) {
      expect(f.lines.some((line) => line.start <= said.at && said.at < line.end)).toBe(false);
      expect(f.lines.every((line) => line.end <= said.at || line.start >= said.until)).toBe(true);
    }
    // In gaps mode the film is never stopped for a description.
    expect(player.calls).toEqual([]);
  });

  it('never talks over a line at a slower speaking rate either: what does not fit is shortened, and a name that cannot be introduced is not used', async () => {
    const f = film(lang);
    const rate = 0.5;
    const rendered = renderScript(f.script, confirmed(f), undefined, { lang, rate });
    const playerScript = toPlayerScript(rendered.cues, { videoId: 'long-street', lang, duration: DURATION });
    // No notice here: the player does not count it against the pause.
    const { spoken, player } = await play(playerScript, { notice: '', settings: { ttsRate: rate } });
    const texts = spoken.map((s) => s.text.trim());
    expect(texts).toEqual(W.slow.heard);
    expect(rendered.report.introducedAt).toEqual(W.slow.introduced ? { P1: Q.window } : {});

    const cues = byId(playerScript.cues);
    for (const said of spoken) {
      const slot = slotAt(f.slots, said.at);
      expect(slot).not.toBeNull();
      // What is said is the standard or the brief wording of the cue of that pause, and it fits the pause.
      const cue = playerScript.cues.find((c) => c.start === slot.start);
      expect([cues[cue.id].standard, cues[cue.id].brief]).toContain(said.text.trim());
      expect(estimateSeconds(said.text.trim(), rate)).toBeLessThanOrEqual(slot.room);
      expect(f.lines.every((line) => line.end <= said.at || line.start >= said.until)).toBe(true);
    }
    // No bare name out of nowhere: the name is heard of her only after an introduction that was itself heard.
    const ofHer = texts.filter((text) => text.includes(W.name) && text !== W.named.sign);
    expect(ofHer.length > 0).toBe(W.slow.introduced);
    if (W.slow.introduced) expect(ofHer[0]).toContain(W.intro);
    expect(player.calls).toEqual([]);
  });

  it('plays with labels only before the name is confirmed', async () => {
    const f = film(lang);
    const rendered = renderScript(f.script, f.cast, undefined, { lang });
    const playerScript = toPlayerScript(rendered.cues, { videoId: 'long-street', lang, duration: DURATION });
    const { spoken } = await play(playerScript, { notice: W.notice });
    const texts = spoken.map((s) => s.text);
    expect(texts[0]).toBe(`${W.notice} ${W.labels.window}`);
    expect(texts.filter((text) => text.includes(W.name))).toEqual([W.labels.sign]);
    expect(texts).toHaveLength(6);
    for (const said of spoken) {
      expect(slotAt(f.slots, said.at)).not.toBeNull();
      expect(f.lines.every((line) => line.end <= said.at || line.start >= said.until)).toBe(true);
    }
  });
});

describe('a film from subtitles to speech: when things are missing or broken', () => {
  it('refuses a reply that is not JSON, and an empty or malformed answer leaves a silent film, not a broken one', async () => {
    expect(() => readJson('I cannot describe this film.')).toThrow(ApiError);
    expect(() => readJson('I cannot describe this film.')).toThrow('bad-json');

    const f = film('zh-CN');
    for (const raw of [{}, null, 'text', { cues: 'none' }, { cues: [null, 7, {}] }]) {
      const section = normalizeSection(raw, { slots: f.slots, window: WINDOW, legendIds: f.legend.ids, lang: 'zh-CN', nextNumber: 1 });
      expect(section.cues).toEqual([]);
      const script = mergeSection({ ...createFilmScript({ filmId: 'x', lang: 'zh-CN', duration: DURATION }), slots: f.slots }, section);
      const verified = verifyScript(script, { cast: f.cast, identity: f.identity });
      expect(verified.report).toEqual({ checked: 0, demoted: 0, needsRepair: 0, relapses: 0 });
      const rendered = renderScript(verified.script, f.cast, undefined, { lang: 'zh-CN' });
      expect(rendered).toEqual({ cues: [], report: { introducedAt: {}, deferred: [], silenced: [] } });
      const playerScript = toPlayerScript(rendered.cues, { videoId: 'x', lang: 'zh-CN', duration: DURATION });
      expect(playerScript.cues).toEqual([]);
    }
    const { spoken } = await play(toPlayerScript([], { videoId: 'x', lang: 'zh-CN', duration: DURATION }), { notice: 'AI' });
    expect(spoken).toEqual([]);
  });

  it('treats a film without subtitles as one long pause', () => {
    for (const lang of LANGS) {
      const lines = parseSubtitle('', 'film.srt');
      expect(lines).toEqual([]);
      const slots = buildSlots(speechFromLines(lines), DURATION, { lang });
      expect(slots).toHaveLength(1);
      expect(slots[0]).toMatchObject({ id: 'g_0001', start: 0, end: DURATION, room: DURATION });
    }
  });

  it('keeps a cue silent when its token belongs to nobody in the cast', () => {
    const f = film('en');
    const rendered = renderScript(f.script, createCast(), undefined, { lang: 'en' });
    // Only the sign has no token (the cue with the name written out is kept back anyway).
    expect(rendered.cues.filter((cue) => !cue.silent).map((cue) => cue.id)).toEqual([Q.sign]);
    expect(rendered.report.silenced).toEqual([Q.window, Q.enters, Q.tea, Q.sits, Q.door, Q.phone]);
    expect(toPlayerScript(rendered.cues, { videoId: 'x', lang: 'en', duration: DURATION }).cues.map((c) => c.id)).toEqual([Q.sign]);
  });
});
