// The script of a film (src/film/filmscript.js): cleaning a model's section,
// merging, remapping, a person's edits, the player's shape, clip fingerprints.
import { describe, expect, it } from 'vitest';
import { SCRIPT_VERSION } from '../src/shared/constants.js';
import { chooseUtterance, estimateSeconds, passesDensity } from '../src/shared/script.js';
import { renderScript } from '../src/film/namegate.js';
import { buildSlots } from '../src/film/timeline.js';
import { tokensIn } from '../src/film/types.js';
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

/** Frozen all the way down: a function that changed its argument would throw. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const pad = (n, width) => String(n).padStart(width, '0');
const slot = (n, start, end, extra = {}) => ({
  id: `g_${pad(n, 4)}`,
  start,
  end,
  room: end - start,
  budget: { units: 'chars', brief: 6, standard: 12, detailed: 18 },
  src: 'subs',
  ...extra,
});
const SLOTS = deepFreeze([slot(1, 10, 14), slot(2, 20, 26), slot(3, 40, 43), slot(4, 70, 75)]);
const options = (extra = {}) => ({ slots: SLOTS, window: { start: 0, end: 60 }, legendIds: ['P1', 'P2', 'P3'], lang: 'zh-CN', nextNumber: 1, ...extra });
const section = (cues, extra = {}) => ({ cues, sceneStarts: [], appearances: [], ...extra });
/** One cue of the model through normalizeSection. */
const one = (cue, extra) => normalizeSection(section([cue]), options(extra));
const types = (problems) => problems.map((p) => p.type);

const ZH = { brief: '{P1}开门。', standard: '{P1}推开门走进来。', detailed: '{P1}推开沉重的木门，走进昏暗的走廊。' };
const EN = { brief: '{P1} opens the door.', standard: '{P1} opens the door and steps inside.', detailed: '{P1} opens the heavy front door and steps into the dim hallway.' };

/** A cue as the script stores it: with the times of its slot when it starts with it, as normalizeSection gives them. */
const filmCue = (n, start, extra = {}) => ({
  id: `q_${pad(n, 6)}`,
  slot: `g_${pad(n, 4)}`,
  start,
  end: SLOTS.find((s) => s.id === `g_${pad(n, 4)}` && s.start === start)?.end ?? start + 4,
  kind: 'visual',
  priority: 2,
  ...ZH,
  people: [{ char: 'P1' }],
  status: 'ai',
  by: 'ai',
  ...extra,
});
const film = (cues = [], extra = {}) => ({ ...createFilmScript({ filmId: 'film-1', lang: 'zh-CN', duration: 100 }), slots: SLOTS, cues, ...extra });

/** A cue as the name gate hands it on: every token filled. */
const rendered = (n, start, extra = {}) => ({
  id: `q_${pad(n, 6)}`,
  start,
  end: start + 4,
  room: 4,
  kind: 'visual',
  priority: 2,
  brief: '马修开门。',
  standard: '马修推开门走进来。',
  detailed: '马修推开沉重的木门，走进昏暗的走廊。',
  people: ['P1'],
  forms: { P1: 'name' },
  ...extra,
});

describe('createFilmScript', () => {
  it('makes an empty version-3 script', () => {
    expect(createFilmScript({ filmId: 'film-1', lang: 'zh-CN', duration: 5400 })).toEqual({
      v: 3,
      filmId: 'film-1',
      lang: 'zh-CN',
      duration: 5400,
      slots: [],
      cues: [],
      scenes: [],
    });
  });

  it('starts from safe values when something is missing or is not what it should be', () => {
    expect(createFilmScript()).toEqual({ v: 3, filmId: '', lang: '', duration: 0, slots: [], cues: [], scenes: [] });
    expect(createFilmScript({ filmId: 7, lang: null, duration: -3 })).toMatchObject({ filmId: '', lang: '', duration: 0 });
    expect(createFilmScript({ filmId: 'a', lang: 'en', duration: NaN }).duration).toBe(0);
  });

  it('gives each script its own lists', () => {
    const a = createFilmScript({ filmId: 'a', lang: 'en', duration: 1 });
    const b = createFilmScript({ filmId: 'b', lang: 'en', duration: 1 });
    expect(a.cues).not.toBe(b.cues);
    expect(a.slots).not.toBe(b.slots);
    expect(a.scenes).not.toBe(b.scenes);
  });

  it('is accepted by validateFilmScript', () => {
    const script = createFilmScript({ filmId: 'film-1', lang: 'en', duration: 60 });
    expect(validateFilmScript(script)).toEqual(script);
  });
});

describe('validateFilmScript', () => {
  it('throws bad-film-script when raw is not an object or not version 3', () => {
    for (const raw of [null, undefined, 'x', 3, [], {}, { v: 2 }, { v: '3' }, { v: 4, cues: [] }]) {
      expect(() => validateFilmScript(raw)).toThrow('bad-film-script');
    }
  });

  it('keeps a good script as it is', () => {
    const script = film([filmCue(1, 10), filmCue(2, 20, { kind: 'text', onScreenText: '出口', confidence: 'high', scene: 2 })], { scenes: [0, 12.5] });
    expect(validateFilmScript(JSON.parse(JSON.stringify(script)))).toEqual(script);
  });

  it('drops unknown fields of the script, of a slot and of a cue', () => {
    const out = validateFilmScript({ ...film([filmCue(1, 10, { note: 'x' })]), slots: [slot(1, 10, 14, { junk: true })], owner: 'me' });
    expect(out).toEqual(film([filmCue(1, 10)], { slots: [slot(1, 10, 14)] }));
    expect(Object.keys(out)).toEqual(['v', 'filmId', 'lang', 'duration', 'slots', 'cues', 'scenes']);
  });

  it('repairs the head of the script', () => {
    const out = validateFilmScript({ v: 3, filmId: 7, duration: -5, slots: 'x', cues: null });
    expect(out).toEqual({ v: 3, filmId: '', lang: '', duration: 0, slots: [], cues: [], scenes: [] });
  });

  it('cleans slots: junk is dropped, the first of an id is kept, the rest is sorted and completed', () => {
    const out = validateFilmScript({
      ...film(),
      slots: [
        slot(2, 20, 26),
        slot(1, 10, 14),
        null,
        'g_0005',
        { id: '', start: 1, end: 2 },
        { id: 'g_0009', start: 5, end: 5 },
        { id: 'g_0010', start: 'x', end: 9 },
        { id: 'g_0011', start: -1, end: 9 },
        { id: 'g_0012', start: 3 },
        { id: 'g_0001', start: 50, end: 55 },
        { id: 'g_0003', start: 40, end: 43, room: 'x', budget: { units: 'bytes', brief: -1, standard: 7.9, detailed: 'x' }, src: 'guess' },
      ],
    });
    expect(out.slots).toEqual([
      slot(1, 10, 14),
      slot(2, 20, 26),
      { id: 'g_0003', start: 40, end: 43, room: 3, budget: { units: 'chars', brief: 0, standard: 7, detailed: 0 }, src: 'subs' },
    ]);
  });

  it('counts a slot without units in words unless the script is in a CJK language', () => {
    const raw = (lang) => ({ ...film(), lang, slots: [{ id: 'g_0001', start: 1, end: 3 }] });
    expect(validateFilmScript(raw('en')).slots[0].budget).toEqual({ units: 'words', brief: 0, standard: 0, detailed: 0 });
    expect(validateFilmScript(raw('ja')).slots[0].budget.units).toBe('chars');
    expect(validateFilmScript(raw('en')).slots[0].room).toBe(2);
  });

  it('gives a slot no more room than the pause it is, and no pause past the end of the film', () => {
    const slotOf = (raw, duration = 100) => validateFilmScript({ ...film(), duration, slots: [{ id: 'g_0001', ...raw }] }).slots[0];
    // A room larger than the pause is not a measured room.
    expect(slotOf({ start: 10, end: 12, room: 600 })).toMatchObject({ start: 10, end: 12, room: 2 });
    expect(slotOf({ start: 10, end: 12, room: 2.01 }).room).toBe(2);
    // A smaller one is kept: whoever measured it may have held something back.
    expect(slotOf({ start: 10, end: 12, room: 1.5 }).room).toBe(1.5);
    expect(slotOf({ start: 10, end: 12, room: 0 }).room).toBe(0);
    // A pause cannot run past the end of the film, and one that starts there is none.
    expect(slotOf({ start: 95, end: 5000 })).toMatchObject({ start: 95, end: 100, room: 5 });
    expect(slotOf({ start: 95, end: 5000, room: 4905 })).toMatchObject({ end: 100, room: 5 });
    expect(slotOf({ start: 100, end: 5000 })).toBeUndefined();
    expect(slotOf({ start: 300, end: 5000 })).toBeUndefined();
    // A film whose length is not known yet (0) has no end to cut at.
    expect(slotOf({ start: 95, end: 5000 }, 0)).toMatchObject({ start: 95, end: 5000, room: 4905 });
    expect(slotOf({ start: 95, end: 5000, room: 9999 }, 0).room).toBe(4905);
  });

  it('keeps the slots buildSlots makes bit for bit: their room is rounded to the millisecond', () => {
    const speech = Array.from({ length: 400 }, (_, i) => ({ start: 3.17 + i * 7.31, end: 6.4 + i * 7.31 + (i % 7) * 0.13 }));
    const slots = buildSlots(speech, 3000, { lang: 'zh-CN' });
    expect(slots.length).toBeGreaterThan(300);
    // The noise this is about: a room that is not end - start to the last bit.
    expect(slots.some((s) => s.room !== s.end - s.start)).toBe(true);
    expect(validateFilmScript({ ...film(), duration: 3000, slots }).slots).toEqual(slots);
  });

  it('binds each cue to its slot: the slot’s times, or no slot at all when the script has no such pause', () => {
    const cuesOf = (cues, extra = {}) => validateFilmScript({ ...film(cues), ...extra }).cues;
    // A cue that names a pause the script does not have: it keeps its start and has no room to claim.
    expect(cuesOf([{ ...filmCue(1, 10), slot: 'no-such-slot', end: 9999 }])).toEqual([{ ...filmCue(1, 10), slot: null, end: 10 }]);
    // A cue whose times are not its slot's takes the slot's.
    expect(cuesOf([{ ...filmCue(1, 10), start: 50, end: 52 }])).toEqual([filmCue(1, 10)]);
    expect(cuesOf([{ ...filmCue(2, 20), end: 2000 }])).toEqual([filmCue(2, 20)]);
    // The cues are in time order after that.
    expect(cuesOf([{ ...filmCue(3, 40), start: 1 }, { ...filmCue(1, 10), start: 90 }]).map((c) => [c.id, c.start, c.end])).toEqual([['q_000001', 10, 14], ['q_000003', 40, 43]]);
    // A slot that was cut at the end of the film gives its cue the cut time.
    expect(cuesOf([{ ...filmCue(1, 95), end: 5000 }], { slots: [slot(1, 95, 5000)] })).toEqual([{ ...filmCue(1, 95), end: 100 }]);
    // A cue with no slot (an extended description) keeps its own times.
    expect(cuesOf([filmCue(1, 33, { slot: null, kind: 'extended', end: 41 })])).toEqual([filmCue(1, 33, { slot: null, kind: 'extended', end: 41 })]);
  });

  it('never hands the player room a stored script made up: a long description is not spoken over the dialogue', () => {
    const long = 'The woman crosses the room slowly, picks up the letter from the table, reads it twice, folds it, and looks out at the rain that beats on the window.';
    const spoken = (raw) => {
      const script = validateFilmScript({ v: 3, filmId: 'f', lang: 'en', duration: 100, ...raw });
      const [cue] = toPlayerScript(renderScript(script, { characters: [] }).cues, { videoId: 'f', lang: 'en', duration: 100 }).cues;
      return { start: cue.start, gap: cue.gap, said: chooseUtterance(cue, { mode: 'gaps', detail: 'standard', rate: 1 }) };
    };
    const cue = { id: 'q_000001', slot: 'g_0001', start: 10, end: 12, standard: long };
    expect(estimateSeconds(long, 1)).toBeGreaterThan(9);
    // The control: a two-second pause has no room for it, and the player skips it.
    expect(spoken({ slots: [{ id: 'g_0001', start: 10, end: 12, room: 2 }], cues: [cue] })).toEqual({ start: 10, gap: 2, said: null });
    // A room of 600 seconds written into a two-second slot.
    expect(spoken({ slots: [{ id: 'g_0001', start: 10, end: 12, room: 600 }], cues: [cue] })).toEqual({ start: 10, gap: 2, said: null });
    // A slot that does not exist, and an end far away.
    expect(spoken({ slots: [], cues: [{ ...cue, slot: 'no-such-slot', end: 9999 }] })).toEqual({ start: 10, gap: 0, said: null });
    // A slot that runs far past the end of the film.
    expect(spoken({ slots: [{ id: 'g_0001', start: 95, end: 5000 }], cues: [{ ...cue, start: 95, end: 5000 }] })).toMatchObject({ start: 95, gap: 5, said: null });
    // A cue at another time than its slot is spoken in its slot, with the slot's room.
    expect(spoken({ slots: [{ id: 'g_0001', start: 10, end: 12 }], cues: [{ ...cue, start: 50, end: 80 }] })).toEqual({ start: 10, gap: 2, said: null });
  });

  it('cleans cues: junk is dropped, the first of an id is kept, the rest is sorted and repaired', () => {
    const out = validateFilmScript({
      ...film(),
      cues: [
        filmCue(3, 40),
        filmCue(1, 10),
        null,
        'x',
        { ...filmCue(5, 50), id: '' },
        { ...filmCue(6, 50), id: 6 },
        { ...filmCue(7, 50), start: 'soon' },
        { ...filmCue(8, 50), start: -5 },
        { ...filmCue(9, 50), brief: '', standard: '  ', detailed: '' },
        { ...filmCue(10, 50), brief: 1, standard: null, detailed: {} },
        filmCue(1, 60),
        { id: 'q_000011', start: 70, end: 60, kind: 'weird', priority: 9, standard: ' 只有标准版。 ', status: 'done', by: 'robot', slot: 5, people: 'x', onScreenText: '出口', confidence: 'sure', scene: 'x', clip: { file: '' } },
      ],
    });
    expect(out.cues).toEqual([
      filmCue(1, 10),
      filmCue(3, 40),
      { id: 'q_000011', slot: null, start: 70, end: 70, kind: 'visual', priority: 2, brief: '只有标准版。', standard: '只有标准版。', detailed: '只有标准版。', people: [], status: 'ai', by: 'ai' },
    ]);
  });

  it('keeps what is valid in a cue', () => {
    const cue = filmCue(1, 10, {
      slot: null,
      kind: 'extended',
      priority: 3,
      status: 'blind-ok',
      by: 'human',
      confidence: 'low',
      scene: 4,
      clip: { file: 'clips/q_000001.wav', dur: 2.5, voice: 'zh-voice', textHash: 'abcdef12', version: 'brief' },
    });
    expect(validateFilmScript(film([cue])).cues).toEqual([cue]);
    for (const kind of ['visual', 'text', 'intro', 'extended']) expect(validateFilmScript(film([filmCue(1, 10, { kind })])).cues[0].kind).toBe(kind);
    for (const status of ['ai', 'edited', 'reviewed', 'blind-ok', 'locked', 'needs-check']) expect(validateFilmScript(film([filmCue(1, 10, { status })])).cues[0].status).toBe(status);
  });

  it('requires a standard text and lets the other two fall back to it', () => {
    const only = (texts) => validateFilmScript(film([{ ...filmCue(1, 10), brief: '', standard: '', detailed: '', ...texts }])).cues[0];
    expect(only({ standard: '{P1}坐下。' })).toMatchObject({ brief: '{P1}坐下。', standard: '{P1}坐下。', detailed: '{P1}坐下。' });
    expect(only({ detailed: 'Long.' })).toMatchObject({ brief: 'Long.', standard: 'Long.', detailed: 'Long.' });
    expect(only({ brief: 'Short.' })).toMatchObject({ brief: 'Short.', standard: 'Short.', detailed: 'Short.' });
  });

  it('never cuts a stored text: a person may have written it', () => {
    const long = '雨'.repeat(300);
    expect(validateFilmScript(film([filmCue(1, 10, { standard: long })])).cues[0].standard).toBe(long);
  });

  it('rebuilds people from the tokens and keeps what was known about them', () => {
    const cue = filmCue(1, 10, {
      standard: '{P1}和{P4}握手。',
      people: [{ char: 'P1', tracks: ['t1', 5, ''], demoted: true, note: 1 }, { char: 'P2' }, 'P4', { char: 'P1', tracks: ['t9'] }, { char: 'bad' }, null],
    });
    expect(validateFilmScript(film([cue])).cues[0].people).toEqual([{ char: 'P1', tracks: ['t1'], demoted: true }, { char: 'P4' }]);
    expect(validateFilmScript(film([filmCue(1, 10, { people: undefined })])).cues[0].people).toEqual([{ char: 'P1' }]);
  });

  it('keeps a transcription only on a text cue', () => {
    const cues = validateFilmScript(film([filmCue(1, 10, { kind: 'text', onScreenText: ' 出口 ' }), filmCue(2, 20, { onScreenText: '出口' }), filmCue(3, 40, { kind: 'text', onScreenText: 7 })])).cues;
    expect(cues[0].onScreenText).toBe('出口');
    expect(cues[1]).not.toHaveProperty('onScreenText');
    expect(cues[2]).not.toHaveProperty('onScreenText');
  });

  it('cleans a clip and drops one that names no file or no hash', () => {
    const clipOf = (clip) => validateFilmScript(film([filmCue(1, 10, { clip })])).cues[0].clip;
    expect(clipOf({ file: 'a.wav', dur: 'x', voice: 5, textHash: 'abcdef12', version: 'long', extra: 1 })).toEqual({ file: 'a.wav', dur: 0, voice: '', textHash: 'abcdef12', version: 'standard' });
    expect(clipOf({ file: 'a.wav', dur: 1.5, voice: 'v', textHash: 'abcdef12', version: 'detailed' })).toEqual({ file: 'a.wav', dur: 1.5, voice: 'v', textHash: 'abcdef12', version: 'detailed' });
    expect(clipOf({ dur: 1, textHash: 'abcdef12' })).toBeUndefined();
    expect(clipOf({ file: 'a.wav' })).toBeUndefined();
    expect(clipOf('a.wav')).toBeUndefined();
  });

  it('cleans the scene starts: real times, to a tenth, each once, in order', () => {
    expect(validateFilmScript({ ...film(), scenes: [30, 5.26, 'x', -1, 5.3, null, 30, Infinity] }).scenes).toEqual([5.3, 30]);
    expect(validateFilmScript({ ...film(), scenes: 'x' }).scenes).toEqual([]);
  });

  it('does not change what it is given', () => {
    const raw = deepFreeze({ ...film([filmCue(2, 20), filmCue(1, 10, { people: [{ char: 'P1', tracks: ['t1'] }] })]), scenes: [3, 1] });
    const out = validateFilmScript(raw);
    expect(out.cues.map((c) => c.id)).toEqual(['q_000001', 'q_000002']);
    expect(raw.cues[0].id).toBe('q_000002');
  });
});

describe('normalizeSection: binding a cue to its slot', () => {
  it('binds a cue to the slot it names and gives it the slot’s times, a fresh id, status ai and by ai', () => {
    const { cues, problems } = one({ slot: 'g_0002', start: 3, kind: 'visual', priority: 1, ...ZH });
    expect(problems).toEqual([]);
    expect(cues).toEqual([{ id: 'q_000001', slot: 'g_0002', start: 20, end: 26, kind: 'visual', priority: 1, ...ZH, people: [{ char: 'P1' }], status: 'ai', by: 'ai' }]);
  });

  it('does the same for an English cue', () => {
    const { cues, problems } = one({ slot: 'g_0001', kind: 'visual', priority: 2, ...EN }, { lang: 'en' });
    expect(problems).toEqual([]);
    expect(cues).toEqual([{ id: 'q_000001', slot: 'g_0001', start: 10, end: 14, kind: 'visual', priority: 2, ...EN, people: [{ char: 'P1' }], status: 'ai', by: 'ai' }]);
  });

  it('reads a slot id whatever its case and the spaces round it; the slot wins over the start', () => {
    expect(one({ slot: ' G_0002 ', ...ZH }).cues[0].slot).toBe('g_0002');
    expect(one({ slot: 'g_0003', start: 11, ...ZH }).cues[0]).toMatchObject({ slot: 'g_0003', start: 40, end: 43 });
  });

  it('takes the slot that contains its start when it names no valid slot', () => {
    expect(one({ start: 22, ...ZH }).cues[0]).toMatchObject({ slot: 'g_0002', start: 20, end: 26 });
    expect(one({ slot: 'g_9999', start: 41.5, ...ZH }).cues[0].slot).toBe('g_0003');
    expect(one({ slot: 7, start: 10, ...ZH }).cues[0].slot).toBe('g_0001');
    expect(one({ slot: null, start: 14, ...ZH }).cues[0].slot).toBe('g_0001');
    expect(one({ start: '0:21', ...ZH }).cues[0].slot).toBe('g_0002');
  });

  it('else takes the nearest slot that starts within a second of its start', () => {
    expect(one({ start: 19.3, ...ZH }).cues[0]).toMatchObject({ slot: 'g_0002', start: 20 });
    expect(one({ start: 19, ...ZH }).cues[0].slot).toBe('g_0002');
    const close = [slot(1, 30, 30.4), slot(2, 31.2, 33)];
    expect(one({ start: 30.8, ...ZH }, { slots: close }).cues[0].slot).toBe('g_0002');
    expect(one({ start: 30.5, ...ZH }, { slots: close }).cues[0].slot).toBe('g_0001');
  });

  it('else drops the cue with a no-slot problem', () => {
    for (const cue of [{ start: 18.9 }, { start: 14.5 }, {}, { slot: 'g_9999' }, { start: 'soon' }, { slot: 'g_9999', start: 500 }]) {
      const out = one({ ...cue, ...ZH });
      expect(out.cues).toEqual([]);
      expect(types(out.problems)).toEqual(['no-slot']);
    }
    const none = normalizeSection(section([{ slot: 'g_0001', ...ZH }]));
    expect(none.cues).toEqual([]);
    expect(types(none.problems)).toEqual(['no-slot']);
  });

  it('refuses a slot outside the window, named or found by its start', () => {
    const named = one({ slot: 'g_0004', ...ZH });
    expect(named.cues).toEqual([]);
    expect(types(named.problems)).toEqual(['outside-window']);
    expect(named.problems[0].detail).toContain('g_0004');
    expect(types(one({ start: 72, ...ZH }).problems)).toEqual(['outside-window']);
    expect(types(one({ slot: 'g_0001', ...ZH }, { window: { start: 20, end: 60 } }).problems)).toEqual(['outside-window']);
  });

  it('goes by the start of the slot, the moment the cue is spoken: inside the window, both ends included', () => {
    // Starts in the window and runs past its end.
    expect(one({ slot: 'g_0002', ...ZH }, { window: { start: 0, end: 22 } }).cues[0]).toMatchObject({ slot: 'g_0002', start: 20, end: 26 });
    // Starts exactly at the window's start, and exactly at its end.
    expect(one({ slot: 'g_0001', ...ZH }, { window: { start: 10, end: 60 } }).cues).toHaveLength(1);
    expect(one({ slot: 'g_0003', ...ZH }, { window: { start: 0, end: 40 } }).cues).toHaveLength(1);
    // Began before the window and reaches into it: it belongs to the section before.
    expect(types(one({ slot: 'g_0001', ...ZH }, { window: { start: 12, end: 60 } }).problems)).toEqual(['outside-window']);
    expect(types(one({ start: 13, ...ZH }, { window: { start: 12, end: 60 } }).problems)).toEqual(['outside-window']);
    // Starts just after the window.
    expect(types(one({ slot: 'g_0003', ...ZH }, { window: { start: 0, end: 39.9 } }).problems)).toEqual(['outside-window']);
  });

  it('takes the whole film as the window when none is given', () => {
    expect(one({ slot: 'g_0004', ...ZH }, { window: undefined }).cues[0]).toMatchObject({ slot: 'g_0004', start: 70, end: 75 });
  });

  it('ignores slots that are not usable', () => {
    const out = one({ slot: 'g_0001', ...ZH }, { slots: [null, { id: 'g_0001' }, { id: 'g_0001', start: 'x', end: 4 }] });
    expect(types(out.problems)).toEqual(['no-slot']);
  });
});

describe('normalizeSection: ids and one cue per slot', () => {
  it('numbers the cues that stay from nextNumber, in time order, with six digits', () => {
    const out = normalizeSection(section([{ slot: 'g_0003', ...ZH }, { slot: 'g_9999', ...ZH }, { slot: 'g_0001', ...ZH }, { slot: 'g_0002', ...ZH }]), options({ nextNumber: 41 }));
    expect(out.cues.map((c) => [c.id, c.slot, c.start])).toEqual([
      ['q_000041', 'g_0001', 10],
      ['q_000042', 'g_0002', 20],
      ['q_000043', 'g_0003', 40],
    ]);
    expect(one({ slot: 'g_0001', ...ZH }, { nextNumber: 1234567 }).cues[0].id).toBe('q_1234567');
  });

  it('starts at 1 when nextNumber is missing or is not a positive whole number', () => {
    for (const nextNumber of [undefined, 0, -4, 2.5, '7', NaN]) expect(one({ slot: 'g_0001', ...ZH }, { nextNumber }).cues[0].id).toBe('q_000001');
  });

  it('keeps one cue per slot: the more important wins, whichever comes first', () => {
    const minor = { slot: 'g_0001', priority: 2, standard: '{P1}看了看表。' };
    const major = { slot: 'g_0001', priority: 1, standard: '{P2}掏出一把枪。' };
    for (const cues of [[minor, major], [major, minor]]) {
      const out = normalizeSection(section(cues), options());
      expect(out.cues).toHaveLength(1);
      expect(out.cues[0]).toMatchObject({ id: 'q_000001', standard: '{P2}掏出一把枪。', priority: 1 });
      expect(types(out.problems)).toEqual(['duplicate-slot']);
      expect(out.problems[0].detail).toContain(`cues[${cues.indexOf(minor)}]`);
    }
  });

  it('keeps the first of two equally important cues for a slot', () => {
    const out = normalizeSection(section([{ slot: 'g_0001', standard: 'First.' }, { start: 11, standard: 'Second.' }]), options({ lang: 'en' }));
    expect(out.cues.map((c) => c.standard)).toEqual(['First.']);
    expect(types(out.problems)).toEqual(['duplicate-slot']);
    expect(out.problems[0].detail).toContain('cues[1]');
  });
});

describe('normalizeSection: tokens and people', () => {
  it('normalises full-width braces, lower case, inner spaces, leading zeros and full-width digits', () => {
    const { cues } = one({ slot: 'g_0001', brief: '｛p3｝点头。', standard: '｛p3｝和{ P12 }握手，{p03}笑了，｛Ｐ３｝点头。', detailed: '{ｐ2}看着｛ P3 ｝。' });
    expect(cues[0].brief).toBe('{P3}点头。');
    expect(cues[0].standard).toBe('{P3}和{P12}握手，{P3}笑了，{P3}点头。');
    expect(cues[0].detailed).toBe('{P2}看着{P3}。');
  });

  it('normalises tokens in English text too', () => {
    const { cues } = one({ slot: 'g_0001', standard: '{p1} hands { P2 } a letter.' }, { lang: 'en' });
    expect(cues[0].standard).toBe('{P1} hands {P2} a letter.');
    expect(cues[0].people).toEqual([{ char: 'P1' }, { char: 'P2' }]);
  });

  it('derives people from the tokens of all three texts, each once, and ignores the list the model wrote', () => {
    const { cues } = one({ slot: 'g_0001', people: [{ char: 'P9' }, 'P8'], brief: '{P2}点头。', standard: '{P3}和{P12}握手，{P3}笑了。', detailed: '{P3}和{P12}握手，{P1}在旁边看着。' });
    expect(cues[0].people).toEqual([{ char: 'P3' }, { char: 'P12' }, { char: 'P2' }, { char: 'P1' }]);
  });

  it('gives a cue without tokens an empty list of people, and never lists an id that cannot be a character', () => {
    expect(one({ slot: 'g_0001', standard: '窗外下着雨。' }).cues[0].people).toEqual([]);
    const zero = one({ slot: 'g_0001', standard: '{P0}走了。' }).cues[0];
    expect(zero.standard).toBe('{P0}走了。');
    expect(zero.people).toEqual([]);
  });
});

describe('normalizeSection: texts', () => {
  it('removes markdown, wrapping quotes and stray whitespace', () => {
    const { cues } = one({ slot: 'g_0001', brief: '  {P1} waves.  ', standard: '**{P1}** walks  to the\n window.', detailed: '"{P2} sits down."' }, { lang: 'en' });
    expect(cues[0]).toMatchObject({ brief: '{P1} waves.', standard: '{P1} walks to the window.', detailed: '{P2} sits down.' });
  });

  it('cuts Chinese text at 30, 70 and 140 characters', () => {
    const { cues } = one({ slot: 'g_0001', brief: '雨'.repeat(100), standard: '雨'.repeat(100), detailed: '雨'.repeat(200) });
    expect(cues[0].brief).toBe(`${'雨'.repeat(29)}…`);
    expect(cues[0].standard).toBe(`${'雨'.repeat(69)}…`);
    expect(cues[0].detailed).toBe(`${'雨'.repeat(139)}…`);
    const exact = one({ slot: 'g_0001', brief: '雨'.repeat(30), standard: '雨'.repeat(70), detailed: '雨'.repeat(140) }).cues[0];
    expect([exact.brief.length, exact.standard.length, exact.detailed.length]).toEqual([30, 70, 140]);
    expect(exact.detailed.endsWith('…')).toBe(false);
  });

  it('cuts Japanese and Korean text at the same limits', () => {
    expect(one({ slot: 'g_0001', standard: 'あ'.repeat(100) }, { lang: 'ja' }).cues[0].standard).toHaveLength(70);
    expect(one({ slot: 'g_0001', standard: '가'.repeat(100) }, { lang: 'ko' }).cues[0].standard).toHaveLength(70);
  });

  it('cuts other text at 90, 230 and 500 characters', () => {
    const { cues } = one({ slot: 'g_0001', brief: 'w'.repeat(600), standard: 'w'.repeat(600), detailed: 'w'.repeat(600) }, { lang: 'en' });
    expect(cues[0].brief).toBe(`${'w'.repeat(89)}…`);
    expect(cues[0].standard).toBe(`${'w'.repeat(229)}…`);
    expect(cues[0].detailed).toBe(`${'w'.repeat(499)}…`);
    const exact = one({ slot: 'g_0001', brief: 'w'.repeat(90), standard: 'w'.repeat(230), detailed: 'w'.repeat(500) }, { lang: 'en' }).cues[0];
    expect([exact.brief.length, exact.standard.length, exact.detailed.length]).toEqual([90, 230, 500]);
    const words = one({ slot: 'g_0001', standard: 'word '.repeat(200) }, { lang: 'en' }).cues[0].standard;
    expect(words).toHaveLength(230);
    expect(words.endsWith('word…')).toBe(true);
  });

  it('cuts a text cue at 160, 360 and 800 characters in any language', () => {
    for (const [ch, lang] of [['字', 'zh-CN'], ['w', 'en']]) {
      const { cues } = one({ slot: 'g_0001', kind: 'text', brief: ch.repeat(1000), standard: ch.repeat(1000), detailed: ch.repeat(1000) }, { lang });
      expect(cues[0].brief).toBe(`${ch.repeat(159)}…`);
      expect(cues[0].standard).toBe(`${ch.repeat(359)}…`);
      expect(cues[0].detailed).toBe(`${ch.repeat(799)}…`);
      const exact = one({ slot: 'g_0001', kind: 'text', brief: ch.repeat(160), standard: ch.repeat(360), detailed: ch.repeat(800) }, { lang }).cues[0];
      expect([exact.brief.length, exact.standard.length, exact.detailed.length]).toEqual([160, 360, 800]);
    }
  });

  it('lets the text itself say how it is counted, tokens aside; the language decides only for a text without letters', () => {
    // English written although Chinese was asked for: the English limits.
    expect(one({ slot: 'g_0001', standard: 'w'.repeat(100) }, { lang: 'zh-CN' }).cues[0].standard).toHaveLength(100);
    // Chinese written although English was asked for: the Chinese limits.
    expect(one({ slot: 'g_0001', standard: '雨'.repeat(100) }, { lang: 'en' }).cues[0].standard).toHaveLength(70);
    // More than a third CJK counts as CJK, less does not.
    expect(one({ slot: 'g_0001', standard: `${'雨'.repeat(40)}${'w'.repeat(60)}` }).cues[0].standard).toHaveLength(70);
    expect(one({ slot: 'g_0001', standard: `${'雨'.repeat(20)}${'w'.repeat(80)}` }).cues[0].standard).toHaveLength(100);
    // Tokens are in neither language.
    expect(one({ slot: 'g_0001', standard: `${'{P1}'.repeat(15)}${'雨'.repeat(15)}` }).cues[0].standard).toBe(`${'{P1}'.repeat(15)}${'雨'.repeat(9)}…`);
    // Digits only.
    expect(one({ slot: 'g_0001', standard: '1'.repeat(100) }, { lang: 'zh-CN' }).cues[0].standard).toHaveLength(70);
    expect(one({ slot: 'g_0001', standard: '1'.repeat(100) }, { lang: 'en' }).cues[0].standard).toHaveLength(100);
  });

  it('cuts at a sentence end when one lies in the last 65% of the limit (Chinese)', () => {
    for (const stop of ['。', '！', '？']) {
      const text = `${'甲'.repeat(40)}${stop}${'乙'.repeat(60)}`;
      expect(one({ slot: 'g_0001', standard: text }).cues[0].standard).toBe(`${'甲'.repeat(40)}${stop}`);
    }
    // A closing quote stays with its sentence.
    expect(one({ slot: 'g_0001', standard: `${'甲'.repeat(40)}。”${'乙'.repeat(60)}` }).cues[0].standard).toBe(`${'甲'.repeat(40)}。”`);
    // A sentence that ends exactly at the limit is whole.
    expect(one({ slot: 'g_0001', standard: `${'甲'.repeat(69)}。${'乙'.repeat(30)}` }).cues[0].standard).toBe(`${'甲'.repeat(69)}。`);
  });

  it('cuts at a sentence end when one lies in the last 65% of the limit (English)', () => {
    for (const stop of ['.', '!', '?']) {
      const text = `${'a'.repeat(120)}${stop} ${'b'.repeat(200)}`;
      expect(one({ slot: 'g_0001', standard: text }, { lang: 'en' }).cues[0].standard).toBe(`${'a'.repeat(120)}${stop}`);
    }
    expect(one({ slot: 'g_0001', standard: `${'a'.repeat(120)}." ${'b'.repeat(200)}` }, { lang: 'en' }).cues[0].standard).toBe(`${'a'.repeat(120)}."`);
    expect(one({ slot: 'g_0001', standard: `${'a'.repeat(229)}. ${'b'.repeat(50)}` }, { lang: 'en' }).cues[0].standard).toBe(`${'a'.repeat(229)}.`);
  });

  it('cuts mid-sentence with an ellipsis when the only sentence end is in the first 35%', () => {
    const zh = one({ slot: 'g_0001', standard: `${'甲'.repeat(10)}。${'乙'.repeat(100)}` }).cues[0].standard;
    expect(zh).toBe(`${'甲'.repeat(10)}。${'乙'.repeat(58)}…`);
    const en = one({ slot: 'g_0001', standard: `${'a'.repeat(20)}. ${'b'.repeat(300)}` }, { lang: 'en' }).cues[0].standard;
    expect(en).toBe(`${'a'.repeat(20)}. ${'b'.repeat(207)}…`);
  });

  it('does not take the full stop of a number for a sentence end', () => {
    const text = one({ slot: 'g_0001', standard: `${'a'.repeat(100)} 3.5${'b'.repeat(200)}` }, { lang: 'en' }).cues[0].standard;
    expect(text).toHaveLength(230);
    expect(text.endsWith('…')).toBe(true);
  });

  it('never splits a token: a cut that falls inside one is made before it', () => {
    // The brief limit is 30, so the cut falls at index 29: inside {P12}, which starts at 27.
    const inside = one({ slot: 'g_0001', brief: `${'雨'.repeat(27)}{P12}${'走'.repeat(20)}`, standard: '{P12}走了。' }).cues[0];
    expect(inside.brief).toBe(`${'雨'.repeat(27)}…`);
    expect(inside.brief).not.toMatch(/[{}P]/);
    // A token that ends where the cut falls is whole and stays.
    const whole = one({ slot: 'g_0001', brief: `${'雨'.repeat(24)}{P12}${'走'.repeat(20)}`, standard: '{P12}走了。' }).cues[0];
    expect(whole.brief).toBe(`${'雨'.repeat(24)}{P12}…`);
    expect(tokensIn(whole.brief)).toEqual(['P12']);
    // A token that starts where the cut falls is left out.
    const after = one({ slot: 'g_0001', brief: `${'雨'.repeat(29)}{P12}${'走'.repeat(20)}`, standard: '{P12}走了。' }).cues[0];
    expect(after.brief).toBe(`${'雨'.repeat(29)}…`);
  });

  it('never splits a token in English either, and leaves no space or comma hanging before the ellipsis', () => {
    const en = one({ slot: 'g_0001', brief: `${'a'.repeat(86)} {P7} runs away from the house`, standard: '{P7} runs.' }, { lang: 'en' }).cues[0];
    expect(en.brief).toBe(`${'a'.repeat(86)}…`);
    const zh = one({ slot: 'g_0001', brief: `${'雨'.repeat(28)}，${'走'.repeat(30)}`, standard: '下雨。' }).cues[0];
    expect(zh.brief).toBe(`${'雨'.repeat(28)}…`);
  });

  it('holds for every place a token can lie across the cut', () => {
    for (let before = 20; before <= 32; before += 1) {
      const brief = one({ slot: 'g_0001', brief: `${'雨'.repeat(before)}{P123}${'走'.repeat(30)}`, standard: '下雨。' }).cues[0].brief;
      expect(brief.length).toBeLessThanOrEqual(30);
      expect(brief.replace('{P123}', '')).not.toMatch(/[{}P\d]/);
    }
  });

  it('does not cut a character outside the basic plane in half', () => {
    const brief = one({ slot: 'g_0001', brief: `${'雨'.repeat(28)}😀${'雨'.repeat(30)}`, standard: '下雨。' }).cues[0].brief;
    expect(brief).toBe(`${'雨'.repeat(28)}…`);
  });

  it('requires a standard text: it is taken from the detailed or the brief one when the model left it out', () => {
    expect(one({ slot: 'g_0001', standard: '{P1}坐下。' }).cues[0]).toMatchObject({ brief: '{P1}坐下。', standard: '{P1}坐下。', detailed: '{P1}坐下。' });
    expect(one({ slot: 'g_0001', brief: '{P1}坐下。' }).cues[0]).toMatchObject({ brief: '{P1}坐下。', standard: '{P1}坐下。', detailed: '{P1}坐下。' });
    const fromDetailed = one({ slot: 'g_0001', detailed: '雨'.repeat(100) }).cues[0];
    expect(fromDetailed.detailed).toBe('雨'.repeat(100));
    expect(fromDetailed.standard).toBe(`${'雨'.repeat(69)}…`);
    expect(fromDetailed.brief).toBe(fromDetailed.standard);
    expect(one({ slot: 'g_0001', brief: 'Short.', detailed: 'Long and detailed.' }, { lang: 'en' }).cues[0]).toMatchObject({ brief: 'Short.', standard: 'Long and detailed.', detailed: 'Long and detailed.' });
  });

  it('lets a text cue with nothing but a transcription say the transcription', () => {
    const cue = one({ slot: 'g_0001', kind: 'text', onScreenText: '三年后' }).cues[0];
    expect(cue).toMatchObject({ kind: 'text', brief: '三年后', standard: '三年后', detailed: '三年后', onScreenText: '三年后' });
  });

  it('drops a cue with no text, with an empty problem', () => {
    for (const cue of [{ slot: 'g_0001' }, { slot: 'g_0001', brief: '', standard: '   ', detailed: '' }, { slot: 'g_0001', standard: 42, brief: null, detailed: ['x'] }, { slot: 'g_0001', kind: 'visual', onScreenText: '出口' }]) {
      const out = one(cue);
      expect(out.cues).toEqual([]);
      expect(out.problems).toEqual([{ type: 'empty', detail: 'cues[0]' }]);
    }
  });

  it('makes a priority outside 1 to 3 a 2', () => {
    for (const priority of [0, 4, -1, 'high', undefined, null, NaN]) expect(one({ slot: 'g_0001', priority, ...ZH }).cues[0].priority).toBe(2);
    expect(one({ slot: 'g_0001', priority: 1, ...ZH }).cues[0].priority).toBe(1);
    expect(one({ slot: 'g_0001', priority: '3', ...ZH }).cues[0].priority).toBe(3);
  });

  it('makes the kind visual unless it is text, intro or extended', () => {
    for (const kind of ['text', 'intro', 'extended', 'visual']) expect(one({ slot: 'g_0001', kind, ...ZH }).cues[0].kind).toBe(kind);
    for (const kind of ['audio', 'TEXT', undefined, 3]) expect(one({ slot: 'g_0001', kind, ...ZH }).cues[0].kind).toBe('visual');
  });

  it('keeps a transcription only on a text cue, with line breaks as " / "', () => {
    expect(one({ slot: 'g_0001', kind: 'text', onScreenText: 'Line one\n  Line two ', standard: 'A sign reads: Line one, Line two.' }, { lang: 'en' }).cues[0].onScreenText).toBe('Line one / Line two');
    for (const kind of ['visual', 'intro', 'extended']) expect(one({ slot: 'g_0001', kind, onScreenText: '出口', ...ZH }).cues[0]).not.toHaveProperty('onScreenText');
    expect(one({ slot: 'g_0001', kind: 'text', onScreenText: '  ', ...ZH }).cues[0]).not.toHaveProperty('onScreenText');
  });

  it('keeps symbols in a text cue, where they are quoted from the screen', () => {
    expect(one({ slot: 'g_0001', kind: 'text', standard: '__init__ and #1' }, { lang: 'en' }).cues[0].standard).toBe('__init__ and #1');
    expect(one({ slot: 'g_0001', kind: 'visual', standard: '# A __bold__ title' }, { lang: 'en' }).cues[0].standard).toBe('A bold title');
  });

  it('keeps a confidence the model gave, as data, and never rewrites the text for it', () => {
    for (const confidence of ['high', 'medium', 'low']) {
      const cue = one({ slot: 'g_0001', confidence, priority: 2, ...ZH }).cues[0];
      expect(cue).toMatchObject({ confidence, priority: 2, ...ZH });
    }
    expect(one({ slot: 'g_0001', confidence: 'sure', ...ZH }).cues[0]).not.toHaveProperty('confidence');
    expect(one({ slot: 'g_0001', ...ZH }).cues[0]).not.toHaveProperty('confidence');
  });
});

describe('normalizeSection: scene starts, appearances, bad input', () => {
  it('keeps the scene starts inside the window: to a tenth, each once, in order', () => {
    const out = normalizeSection(section([], { sceneStarts: [42.26, 5, '0:30', 5.04, 61, -3, 'x', null, 60, 0] }), options());
    expect(out.sceneStarts).toEqual([0, 5, 30, 42.3, 60]);
    expect(types(out.problems)).toEqual(['outside-window', 'outside-window', 'malformed', 'malformed']);
    expect(out.problems[0].detail).toContain('sceneStarts[4]');
    expect(normalizeSection(section([], { sceneStarts: [5, 30] }), options({ window: { start: 10, end: 60 } })).sceneStarts).toEqual([30]);
  });

  it('keeps only appearances of characters in the legend with an outfit, inside the window', () => {
    const out = normalizeSection(
      section([], {
        appearances: [
          { char: 'P1', outfit: '红裙子', from: 12.04 },
          { char: '{p2}', outfit: ' a grey  coat ', from: '0:21' },
          { char: 'P9', outfit: '蓝衬衫', from: 12 },
          { char: 'P3', outfit: '  ', from: 12 },
          { char: 'P3', outfit: '黑西装' },
          { char: 'P1', outfit: '白衬衫', from: 90 },
          { char: 'P1', outfit: '白衬衫', from: 2 },
          null,
          { outfit: '白衬衫', from: 12 },
        ],
      }),
      options({ window: { start: 5, end: 60 } }),
    );
    expect(out.appearances).toEqual([
      { char: 'P3', outfit: '黑西装', from: 5, src: 'model' },
      { char: 'P1', outfit: '红裙子', from: 12, src: 'model' },
      { char: 'P2', outfit: 'a grey coat', from: 21, src: 'model' },
    ]);
    expect(types(out.problems)).toEqual(['unknown-character', 'empty', 'outside-window', 'outside-window', 'malformed', 'unknown-character']);
  });

  it('keeps no outfit that holds a brace or a character id: the name gate would say it word for word', () => {
    const out = normalizeSection(
      section([], {
        appearances: [
          { char: 'P1', outfit: "{P2}'s grey coat", from: 12 },
          { char: 'P1', outfit: 'the coat of P2', from: 13 },
          { char: 'P1', outfit: '｛P2｝的灰大衣', from: 14 },
          { char: 'P1', outfit: 'ｐ２的灰大衣', from: 15 },
          { char: 'P1', outfit: 'a {grey} coat', from: 16 },
          { char: 'P1', outfit: 'a coat with a ﹛ on it', from: 17 },
          { char: 'P2', outfit: 'a grey coat', from: 18 },
          { char: 'P3', outfit: 'an MP3 player on a lanyard', from: 19 },
        ],
      }),
      options(),
    );
    expect(out.appearances).toEqual([
      { char: 'P2', outfit: 'a grey coat', from: 18, src: 'model' },
      { char: 'P3', outfit: 'an MP3 player on a lanyard', from: 19, src: 'model' },
    ]);
    expect(out.problems).toEqual([0, 1, 2, 3, 4, 5].map((i) => ({ type: 'malformed', detail: `appearances[${i}]: outfit` })));
  });

  it('keeps no appearance when there is no legend', () => {
    const out = normalizeSection(section([], { appearances: [{ char: 'P1', outfit: '红裙子', from: 12 }] }), options({ legendIds: undefined }));
    expect(out.appearances).toEqual([]);
    expect(types(out.problems)).toEqual(['unknown-character']);
  });

  it('answers with empty lists and a problem when the answer is not an object', () => {
    for (const raw of [null, undefined, 'text', 7]) {
      expect(normalizeSection(raw, options())).toEqual({ cues: [], sceneStarts: [], appearances: [], problems: [{ type: 'malformed', detail: 'section' }] });
    }
  });

  it('answers with empty lists when the lists are missing or are not lists', () => {
    const empty = { cues: [], sceneStarts: [], appearances: [], problems: [] };
    expect(normalizeSection({}, options())).toEqual(empty);
    expect(normalizeSection({ cues: 'x', sceneStarts: 4, appearances: {} }, options())).toEqual(empty);
    expect(normalizeSection(section([]), options())).toEqual(empty);
  });

  it('takes a bare list as the cues', () => {
    const out = normalizeSection([{ slot: 'g_0001', ...ZH }], options());
    expect(out.cues).toHaveLength(1);
    expect(out.problems).toEqual([]);
  });

  it('skips entries that are not cues and says so', () => {
    const out = normalizeSection(section([null, 'x', 4, [], { slot: 'g_0001', ...ZH }]), options());
    expect(out.cues).toHaveLength(1);
    expect(out.problems).toEqual([
      { type: 'malformed', detail: 'cues[0]' },
      { type: 'malformed', detail: 'cues[1]' },
      { type: 'malformed', detail: 'cues[2]' },
      { type: 'malformed', detail: 'cues[3]' },
    ]);
  });

  it('reports every problem as a type and a detail, both words', () => {
    const out = normalizeSection(
      section([null, {}, { ...ZH }, { slot: 'g_0004', ...ZH }, { slot: 'g_0001', ...ZH }, { slot: 'g_0001', ...ZH }], { sceneStarts: [99, 'x'], appearances: [{ char: 'P9', outfit: 'x' }] }),
      options(),
    );
    expect(types(out.problems)).toEqual(['malformed', 'empty', 'no-slot', 'outside-window', 'duplicate-slot', 'outside-window', 'malformed', 'unknown-character']);
    for (const problem of out.problems) {
      expect(Object.keys(problem)).toEqual(['type', 'detail']);
      expect(typeof problem.type).toBe('string');
      expect(typeof problem.detail).toBe('string');
      expect(problem.detail).not.toBe('');
    }
  });

  it('does not change what it is given', () => {
    const raw = deepFreeze(section([{ slot: 'g_0003', people: [{ char: 'P1' }], ...ZH }, { slot: 'g_0001', ...ZH }], { sceneStarts: [30, 5], appearances: [{ char: 'P1', outfit: '红裙子', from: 12 }] }));
    const given = deepFreeze(options());
    const out = normalizeSection(raw, given);
    expect(out.cues).toHaveLength(2);
    expect(raw.cues[0].slot).toBe('g_0003');
    expect(SLOTS[0]).toEqual(slot(1, 10, 14));
  });
});

describe('nextCueNumber', () => {
  it('is one more than the highest cue number in use', () => {
    expect(nextCueNumber(createFilmScript({ filmId: 'a', lang: 'en', duration: 1 }))).toBe(1);
    expect(nextCueNumber(film([filmCue(7, 10), filmCue(3, 20), { ...filmCue(9, 30), id: 'custom' }]))).toBe(8);
    expect(nextCueNumber(undefined)).toBe(1);
    expect(nextCueNumber({ cues: [null, { id: 5 }] })).toBe(1);
  });
});

describe('mergeSection', () => {
  it('adds the cues of a section and keeps all cues sorted by start', () => {
    const first = normalizeSection(section([{ slot: 'g_0003', ...ZH }]), options());
    let script = mergeSection(film(), first);
    const second = normalizeSection(section([{ slot: 'g_0002', ...ZH }, { slot: 'g_0001', ...ZH }]), options({ nextNumber: nextCueNumber(script) }));
    script = mergeSection(script, second);
    expect(script.cues.map((c) => [c.id, c.start])).toEqual([
      ['q_000002', 10],
      ['q_000003', 20],
      ['q_000001', 40],
    ]);
    expect(script).toMatchObject({ v: 3, filmId: 'film-1', lang: 'zh-CN', duration: 100, slots: SLOTS });
    expect(validateFilmScript(script)).toEqual(script);
  });

  it('replaces the cue of a slot when the existing one is by ai', () => {
    const script = film([filmCue(1, 10), filmCue(2, 20)]);
    const again = normalizeSection(section([{ slot: 'g_0001', standard: '{P2}关上门。' }]), options({ nextNumber: 3 }));
    const merged = mergeSection(script, again);
    expect(merged.cues.map((c) => c.id)).toEqual(['q_000003', 'q_000002']);
    expect(merged.cues[0]).toMatchObject({ slot: 'g_0001', standard: '{P2}关上门。', by: 'ai' });
  });

  it('replaces an ai cue whatever its status', () => {
    const merged = mergeSection(film([filmCue(1, 10, { status: 'needs-check' })]), { cues: [filmCue(5, 10, { slot: 'g_0001', standard: '{P2}关上门。' })] });
    expect(merged.cues.map((c) => c.id)).toEqual(['q_000005']);
  });

  it('never replaces a cue a person wrote or looked at', () => {
    const edited = editCue(film([filmCue(1, 10), filmCue(2, 20)]), 'q_000001', { standard: '{P1}慢慢推开门。' });
    const again = normalizeSection(section([{ slot: 'g_0001', standard: '{P2}关上门。' }, { slot: 'g_0003', standard: '{P2}离开。' }]), options({ nextNumber: 3 }));
    const merged = mergeSection(edited, again);
    expect(merged.cues.map((c) => [c.id, c.standard])).toEqual([
      ['q_000001', '{P1}慢慢推开门。'],
      ['q_000002', ZH.standard],
      ['q_000004', '{P2}离开。'],
    ]);
    const reviewed = mergeSection(film([filmCue(1, 10, { by: 'human', status: 'reviewed' })]), { cues: [filmCue(5, 10, { slot: 'g_0001' })] });
    expect(reviewed.cues.map((c) => c.id)).toEqual(['q_000001']);
  });

  it('leaves a cue without a slot alone', () => {
    const extended = filmCue(1, 10, { slot: null, kind: 'extended', by: 'human' });
    const merged = mergeSection(film([extended]), { cues: [filmCue(2, 10, { slot: 'g_0001' })] });
    expect(merged.cues.map((c) => c.id)).toEqual(['q_000001', 'q_000002']);
  });

  it('never lets a cue without a slot replace, or be dropped for, another cue without a slot', () => {
    const extended = (n, start, extra = {}) => filmCue(n, start, { slot: null, kind: 'extended', ...extra });
    const both = mergeSection(mergeSection(film(), { cues: [extended(1, 10)] }), { cues: [extended(2, 50)] });
    expect(both.cues.map((c) => c.id)).toEqual(['q_000001', 'q_000002']);
    const afterHuman = mergeSection(film([extended(1, 10, { by: 'human' })]), { cues: [extended(2, 50)] });
    expect(afterHuman.cues.map((c) => c.id)).toEqual(['q_000001', 'q_000002']);
  });

  it('unites the scene starts: sorted, each once, to a tenth of a second', () => {
    const merged = mergeSection(film([], { scenes: [10, 30.04] }), { cues: [], sceneStarts: [30, 5.26, 10, 'x', -1] });
    expect(merged.scenes).toEqual([5.3, 10, 30]);
    expect(mergeSection(film([], { scenes: [3] }), {}).scenes).toEqual([3]);
  });

  it('gives a new cue the next free id when its id is taken', () => {
    const a = normalizeSection(section([{ slot: 'g_0001', ...ZH }]), options());
    const b = normalizeSection(section([{ slot: 'g_0002', ...ZH }]), options());
    expect(b.cues[0].id).toBe(a.cues[0].id);
    const merged = mergeSection(mergeSection(film(), a), b);
    expect(merged.cues.map((c) => [c.id, c.slot])).toEqual([
      ['q_000001', 'g_0001'],
      ['q_000002', 'g_0002'],
    ]);
  });

  it('keeps one cue when the same section is merged twice', () => {
    const part = normalizeSection(section([{ slot: 'g_0001', ...ZH }]), options());
    const merged = mergeSection(mergeSection(film(), part), part);
    expect(merged.cues).toEqual(part.cues);
  });

  it('skips entries that are not cues and takes a section with nothing in it', () => {
    const script = film([filmCue(1, 10)]);
    expect(mergeSection(script, { cues: [null, 'x', { id: 7, start: 1 }, { id: 'q_000009' }] }).cues).toEqual(script.cues);
    expect(mergeSection(script, undefined)).toEqual(script);
    expect(mergeSection(script, { cues: [], sceneStarts: [] })).toEqual(script);
  });

  it('returns a new script and does not change what it is given', () => {
    const script = deepFreeze(film([filmCue(2, 20), filmCue(1, 10)], { scenes: [3] }));
    const part = deepFreeze(normalizeSection(section([{ slot: 'g_0003', ...ZH }], { sceneStarts: [1] }), options({ nextNumber: 3 })));
    const merged = mergeSection(script, part);
    expect(merged).not.toBe(script);
    expect(merged.cues.map((c) => c.id)).toEqual(['q_000001', 'q_000002', 'q_000003']);
    expect(script.cues.map((c) => c.id)).toEqual(['q_000002', 'q_000001']);
    expect(script.scenes).toEqual([3]);
  });
});

describe('remapTokens', () => {
  const script = () =>
    film([
      filmCue(1, 10, {
        brief: '{P7}走来。',
        standard: '{P7}走向{P3}，{P70}看着。',
        detailed: '{P7}穿过大厅走向{P3}，{P70}在楼梯上看着。',
        people: [{ char: 'P7', tracks: ['t1'] }, { char: 'P3', tracks: ['t2'], demoted: true }, { char: 'P70' }],
      }),
      filmCue(2, 20, { kind: 'text', onScreenText: '{P7}', standard: '{P2} reads a note.', brief: '{P2} reads.', detailed: '{P2} reads a short note.', people: [{ char: 'P2' }] }),
    ]);

  it('turns the dropped character’s token into the kept one’s in every text and in people', () => {
    const out = remapTokens(script(), { P7: 'P3' });
    expect(out.cues[0]).toMatchObject({
      brief: '{P3}走来。',
      standard: '{P3}走向{P3}，{P70}看着。',
      detailed: '{P3}穿过大厅走向{P3}，{P70}在楼梯上看着。',
    });
    expect(out.cues[0].people).toEqual([{ char: 'P3', tracks: ['t1', 't2'] }, { char: 'P70' }]);
  });

  it('keeps a merged person demoted only when both were', () => {
    const both = film([filmCue(1, 10, { standard: '{P7}和{P3}。', people: [{ char: 'P7', demoted: true }, { char: 'P3', demoted: true }] })]);
    expect(remapTokens(both, { P7: 'P3' }).cues[0].people).toEqual([{ char: 'P3', demoted: true }]);
    const one7 = film([filmCue(1, 10, { standard: '{P7}和{P3}。', people: [{ char: 'P7', demoted: true }, { char: 'P3' }] })]);
    expect(remapTokens(one7, { P7: 'P3' }).cues[0].people).toEqual([{ char: 'P3' }]);
  });

  it('renames a person who was alone, with what was known kept', () => {
    const alone = film([filmCue(1, 10, { brief: '{P7}。', standard: '{P7}走了。', detailed: '{P7}走了。', people: [{ char: 'P7', tracks: ['t1'], demoted: true }] })]);
    expect(remapTokens(alone, { P7: 'P3' }).cues[0].people).toEqual([{ char: 'P3', tracks: ['t1'], demoted: true }]);
  });

  it('leaves other cues, other tokens and the transcription alone', () => {
    const before = script();
    const out = remapTokens(before, { P7: 'P3' });
    expect(out.cues[1]).toBe(before.cues[1]);
    expect(out.cues[1].onScreenText).toBe('{P7}');
    expect(out.cues[0].standard).toContain('{P70}');
    expect(out.cues[0]).toMatchObject({ id: 'q_000001', status: 'ai', by: 'ai', start: 10 });
  });

  it('works on English text', () => {
    const out = remapTokens(script(), { P2: 'P1' });
    expect(out.cues[1]).toMatchObject({ brief: '{P1} reads.', standard: '{P1} reads a note.', detailed: '{P1} reads a short note.', people: [{ char: 'P1' }] });
  });

  it('follows a chain of merges to its end and does not hang on a loop', () => {
    expect(remapTokens(script(), { P7: 'P3', P3: 'P1' }).cues[0].standard).toBe('{P1}走向{P1}，{P70}看着。');
    expect(remapTokens(script(), { P7: 'P3', P3: 'P1' }).cues[0].people).toEqual([{ char: 'P1', tracks: ['t1', 't2'] }, { char: 'P70' }]);
    const looped = remapTokens(script(), { P7: 'P3', P3: 'P7' });
    expect(tokensIn(looped.cues[0].standard).sort()).toEqual(['P3', 'P7', 'P70']);
  });

  it('changes nothing for a map that is empty or is not a map of character ids', () => {
    const before = script();
    for (const remap of [{}, null, undefined, 'P7', { P7: 'P7' }, { x: 'P3' }, { P7: 'someone' }, { P9: 'P3' }]) {
      const out = remapTokens(before, remap);
      expect(out).toEqual(before);
      expect(out.cues[0]).toBe(before.cues[0]);
    }
  });

  it('survives a cue whose people or texts are not what they should be', () => {
    const odd = film([filmCue(1, 10, { brief: undefined, standard: '{P7}走了。', people: [null, 'P7', { char: 'P7' }] }), filmCue(2, 20, { standard: '{P7}。', people: 'x' })]);
    const out = remapTokens(odd, { P7: 'P3' });
    expect(out.cues[0]).toMatchObject({ standard: '{P3}走了。', people: [{ char: 'P3' }] });
    expect(out.cues[0].brief).toBeUndefined();
    expect(out.cues[1]).toMatchObject({ standard: '{P3}。', people: [] });
  });

  it('returns a new script and does not change what it is given', () => {
    const before = deepFreeze(script());
    const out = remapTokens(before, deepFreeze({ P7: 'P3' }));
    expect(out).not.toBe(before);
    expect(before.cues[0].standard).toBe('{P7}走向{P3}，{P70}看着。');
    expect(before.cues[0].people).toHaveLength(3);
  });
});

describe('editCue', () => {
  const script = () =>
    film([
      filmCue(1, 10, { people: [{ char: 'P1', tracks: ['t1'] }] }),
      filmCue(2, 20, { kind: 'text', onScreenText: '出口', brief: '出口。', standard: '门上写着：出口。', detailed: '门上的牌子写着：出口。', people: [] }),
    ]);
  const cueOf = (s, id) => s.cues.find((c) => c.id === id);

  it('changes a text, makes the cue a person’s and marks it edited', () => {
    const before = script();
    const out = editCue(before, 'q_000001', { standard: '{P1}慢慢推开门。' });
    expect(cueOf(out, 'q_000001')).toEqual({ ...before.cues[0], standard: '{P1}慢慢推开门。', status: 'edited', by: 'human' });
    expect(out.cues[1]).toBe(before.cues[1]);
    expect(out).toMatchObject({ v: 3, filmId: 'film-1', slots: SLOTS });
  });

  it('changes each whitelisted field', () => {
    const out = editCue(script(), 'q_000001', { brief: '{P1} in.', standard: '{P1} walks in.', detailed: '{P1} walks in slowly.', kind: 'text', priority: 1, status: 'reviewed', onScreenText: 'EXIT' });
    expect(cueOf(out, 'q_000001')).toMatchObject({
      brief: '{P1} in.',
      standard: '{P1} walks in.',
      detailed: '{P1} walks in slowly.',
      kind: 'text',
      priority: 1,
      status: 'reviewed',
      onScreenText: 'EXIT',
      by: 'human',
    });
  });

  it('returns the script unchanged for an unknown id', () => {
    const before = script();
    expect(editCue(before, 'q_999999', { standard: 'x' })).toBe(before);
    expect(editCue(before, undefined, { standard: 'x' })).toBe(before);
  });

  it('ignores every field that is not whitelisted', () => {
    const before = script();
    const locked = { id: 'q_000042', start: 99, end: 100, slot: 'g_0009', by: 'ai', people: [{ char: 'P9' }], clip: { file: 'x.wav', textHash: 'abcdef12' }, confidence: 'low', scene: 3 };
    expect(editCue(before, 'q_000001', locked)).toBe(before);
    const out = editCue(before, 'q_000001', { ...locked, priority: 1 });
    expect(cueOf(out, 'q_000001')).toEqual({ ...before.cues[0], priority: 1, status: 'edited', by: 'human' });
  });

  it('ignores values that are not valid, and a patch that is not an object', () => {
    const before = script();
    expect(editCue(before, 'q_000001', { kind: 'weird', priority: 7, status: 'done', standard: 42, brief: null })).toBe(before);
    for (const patch of [null, undefined, 'x', [], {}]) expect(editCue(before, 'q_000001', patch)).toBe(before);
  });

  it('normalises tokens a person typed and tidies the whitespace, without cutting the text', () => {
    const out = editCue(script(), 'q_000001', { standard: ' ｛p1｝ 和 { P2 }  握手。\n', detailed: '雨'.repeat(300) });
    expect(cueOf(out, 'q_000001').standard).toBe('{P1} 和 {P2} 握手。');
    expect(cueOf(out, 'q_000001').detailed).toBe('雨'.repeat(300));
    expect(cueOf(editCue(script(), 'q_000001', { standard: ' {p1}  walks \n in. ' }), 'q_000001').standard).toBe('{P1} walks in.');
  });

  it('rebuilds people from the edited texts and keeps what was known about those who stay', () => {
    const out = editCue(script(), 'q_000001', { standard: '{P2}和{P1}握手。' });
    expect(cueOf(out, 'q_000001').people).toEqual([{ char: 'P2' }, { char: 'P1', tracks: ['t1'] }]);
    const gone = editCue(script(), 'q_000001', { brief: '有人开门。', standard: '有人推开门走进来。', detailed: '有人推开沉重的木门。' });
    expect(cueOf(gone, 'q_000001').people).toEqual([]);
    const untouched = editCue(script(), 'q_000001', { priority: 3 });
    expect(cueOf(untouched, 'q_000001').people).toEqual([{ char: 'P1', tracks: ['t1'] }]);
  });

  it('ignores an empty standard text; an empty brief or detailed text takes the standard one', () => {
    const before = script();
    expect(editCue(before, 'q_000001', { standard: '   ' })).toBe(before);
    const out = editCue(before, 'q_000001', { standard: '', brief: '{P1}进来。' });
    expect(cueOf(out, 'q_000001')).toMatchObject({ brief: '{P1}进来。', standard: ZH.standard, by: 'human' });
    const fallen = editCue(before, 'q_000001', { brief: '', detailed: ' ' });
    expect(cueOf(fallen, 'q_000001')).toMatchObject({ brief: ZH.standard, standard: ZH.standard, detailed: ZH.standard });
  });

  it('keeps a transcription only on a text cue', () => {
    const before = script();
    // Typed for a visual cue: not kept, and nothing else was changed.
    expect(editCue(before, 'q_000001', { onScreenText: 'EXIT' })).toBe(before);
    // The cue becomes a text cue in the same edit.
    expect(cueOf(editCue(before, 'q_000001', { kind: 'text', onScreenText: 'EXIT\nONLY' }), 'q_000001')).toMatchObject({ kind: 'text', onScreenText: 'EXIT / ONLY' });
    // A text cue that becomes visual loses it.
    const visual = cueOf(editCue(before, 'q_000002', { kind: 'visual' }), 'q_000002');
    expect(visual.kind).toBe('visual');
    expect(visual).not.toHaveProperty('onScreenText');
    // Emptied by hand.
    expect(cueOf(editCue(before, 'q_000002', { onScreenText: '' }), 'q_000002')).not.toHaveProperty('onScreenText');
    // Left alone by another edit.
    expect(cueOf(editCue(before, 'q_000002', { priority: 1 }), 'q_000002').onScreenText).toBe('出口');
  });

  it('accepts each kind and each status', () => {
    for (const kind of ['visual', 'text', 'intro', 'extended']) expect(cueOf(editCue(script(), 'q_000001', { kind }), 'q_000001').kind).toBe(kind);
    for (const status of ['ai', 'edited', 'reviewed', 'blind-ok', 'locked', 'needs-check']) {
      expect(cueOf(editCue(script(), 'q_000001', { status }), 'q_000001')).toMatchObject({ status, by: 'human' });
    }
  });

  it('marks an ai cue edited, and leaves a status a person set', () => {
    const withStatus = (status) => film([filmCue(1, 10, { status })]);
    expect(cueOf(editCue(withStatus('ai'), 'q_000001', { priority: 1 }), 'q_000001').status).toBe('edited');
    for (const status of ['reviewed', 'blind-ok', 'locked', 'edited']) {
      expect(cueOf(editCue(withStatus(status), 'q_000001', { standard: '{P1}进来。' }), 'q_000001').status).toBe(status);
    }
  });

  it('lifts needs-check only when all three versions were rewritten: none that was refused is spoken unread', () => {
    const refused = { brief: 'Matthew sits.', standard: 'Matthew sits down at the table.', detailed: 'Matthew sits down and sighs.' };
    const flagged = film([filmCue(1, 10, { ...refused, status: 'needs-check' })]);
    const edit = (patch) => cueOf(editCue(flagged, 'q_000001', patch), 'q_000001');
    expect(edit({ priority: 1 })).toMatchObject({ status: 'needs-check', by: 'human' });
    // One or two versions rewritten: the others still hold what was refused, and the cue stays unspoken.
    expect(edit({ standard: '{P1} sits down at the table.' })).toMatchObject({ ...refused, standard: '{P1} sits down at the table.', status: 'needs-check', by: 'human' });
    expect(edit({ brief: '{P1} sits.' })).toMatchObject({ status: 'needs-check', standard: refused.standard });
    expect(edit({ detailed: '{P1} sits down and sighs.' })).toMatchObject({ status: 'needs-check', standard: refused.standard });
    expect(edit({ brief: '{P1} sits.', standard: '{P1} sits down.' })).toMatchObject({ status: 'needs-check', detailed: refused.detailed });
    // All three keys, but an empty standard is ignored: the refused one is still there.
    expect(edit({ standard: '', brief: '{P1} sits.', detailed: '{P1} sighs.' })).toMatchObject({ status: 'needs-check', standard: refused.standard });
    // All three rewritten, in words or by "the same as standard".
    expect(edit({ brief: '{P1} sits.', standard: '{P1} sits down.', detailed: '{P1} sits down and sighs.' })).toMatchObject({ status: 'edited', by: 'human' });
    expect(edit({ standard: '{P1} sits down.', brief: '', detailed: '' })).toMatchObject({ brief: '{P1} sits down.', standard: '{P1} sits down.', detailed: '{P1} sits down.', status: 'edited' });
    // A person who has read the other versions says so.
    expect(edit({ standard: '{P1} sits down at the table.', status: 'reviewed' }).status).toBe('reviewed');
    expect(edit({ status: 'edited' }).status).toBe('edited');
    // Until then the name gate keeps every version from the player.
    const half = editCue(flagged, 'q_000001', { standard: '{P1} sits down at the table.' });
    const rendered = renderScript(half, { characters: [{ id: 'P1', name: null, level: 0, descriptor: { en: 'woman with long hair' } }] }, undefined, { lang: 'en' });
    expect(rendered.cues[0].silent).toBe(true);
    expect(toPlayerScript(rendered.cues, { videoId: 'f', lang: 'en', duration: 100 }).cues).toEqual([]);
  });

  it('makes the cue safe from a later answer of the model', () => {
    const edited = editCue(script(), 'q_000001', { status: 'reviewed' });
    const merged = mergeSection(edited, { cues: [filmCue(8, 10, { slot: 'g_0001', standard: '{P2}关上门。' })] });
    expect(cueOf(merged, 'q_000001').standard).toBe(ZH.standard);
    expect(cueOf(merged, 'q_000008')).toBeUndefined();
  });

  it('returns a new script and does not change what it is given', () => {
    const before = deepFreeze(script());
    const out = editCue(before, 'q_000002', deepFreeze({ standard: '{P3}看着出口的牌子。', kind: 'visual' }));
    expect(out).not.toBe(before);
    expect(before.cues[1]).toMatchObject({ kind: 'text', onScreenText: '出口', standard: '门上写着：出口。', by: 'ai' });
    expect(cueOf(out, 'q_000002')).toMatchObject({ kind: 'visual', standard: '{P3}看着出口的牌子。', people: [{ char: 'P3' }], by: 'human' });
  });
});

describe('toPlayerScript', () => {
  const FILM = { videoId: 'film-1', lang: 'zh-CN', duration: 5400 };

  it('has exactly the shape of the extension’s version-2 script', () => {
    const out = toPlayerScript([rendered(1, 10)], FILM);
    expect(out).toEqual({
      version: 2,
      videoId: 'film-1',
      lang: 'zh-CN',
      duration: 5400,
      cues: [{ id: 'q_000001', start: 10, gap: 4, gapMeasured: true, kind: 'visual', priority: 2, brief: '马修开门。', standard: '马修推开门走进来。', detailed: '马修推开沉重的木门，走进昏暗的走廊。' }],
      characters: [],
      completedUntil: 5400,
      complete: true,
      model: 'film',
    });
    expect(out.version).toBe(SCRIPT_VERSION);
    expect(Object.keys(out)).toEqual(['version', 'videoId', 'lang', 'duration', 'cues', 'characters', 'completedUntil', 'complete', 'model']);
    expect(Object.keys(out.cues[0])).toEqual(['id', 'start', 'gap', 'gapMeasured', 'kind', 'priority', 'brief', 'standard', 'detailed']);
  });

  it('sorts the cues by start and keeps their ids', () => {
    const out = toPlayerScript([rendered(3, 40), rendered(1, 10), rendered(2, 20)], FILM);
    expect(out.cues.map((c) => [c.id, c.start])).toEqual([
      ['q_000001', 10],
      ['q_000002', 20],
      ['q_000003', 40],
    ]);
  });

  it('leaves silent cues out', () => {
    const out = toPlayerScript([rendered(1, 10), rendered(2, 20, { silent: true, standard: '{P9}走了。' }), rendered(3, 40, { silent: false })], FILM);
    expect(out.cues.map((c) => c.id)).toEqual(['q_000001', 'q_000003']);
  });

  it('makes intro and extended cues visual and keeps text cues', () => {
    const out = toPlayerScript([rendered(1, 10, { kind: 'intro' }), rendered(2, 20, { kind: 'extended' }), rendered(3, 40, { kind: 'text' }), rendered(4, 50, { kind: 'visual' })], FILM);
    expect(out.cues.map((c) => c.kind)).toEqual(['visual', 'visual', 'text', 'visual']);
  });

  it('takes the room of the slot as the gap, measured', () => {
    const out = toPlayerScript([rendered(1, 10, { room: 2.5 }), rendered(2, 20, { room: undefined, end: 23 }), rendered(3, 40, { room: undefined, end: undefined })], FILM);
    expect(out.cues.map((c) => c.gap)).toEqual([2.5, 3, 0]);
    expect(out.cues.every((c) => c.gapMeasured === true)).toBe(true);
  });

  it('leaves out what cannot be played and repairs what can', () => {
    const out = toPlayerScript([null, 'x', rendered(1, 'soon'), rendered(2, 20, { standard: '' }), rendered(3, 40, { brief: '', detailed: undefined, priority: 9 })], FILM);
    expect(out.cues).toEqual([{ id: 'q_000003', start: 40, gap: 4, gapMeasured: true, kind: 'visual', priority: 2, brief: '马修推开门走进来。', standard: '马修推开门走进来。', detailed: '马修推开门走进来。' }]);
  });

  it('makes a complete, empty script from nothing', () => {
    expect(toPlayerScript([], FILM)).toMatchObject({ cues: [], complete: true, completedUntil: 5400 });
    expect(toPlayerScript(undefined)).toEqual({ version: SCRIPT_VERSION, videoId: '', lang: '', duration: 0, cues: [], characters: [], completedUntil: 0, complete: true, model: 'film' });
  });

  it('does not change what it is given', () => {
    const cues = deepFreeze([rendered(2, 20), rendered(1, 10)]);
    expect(toPlayerScript(cues, deepFreeze({ ...FILM })).cues.map((c) => c.id)).toEqual(['q_000001', 'q_000002']);
    expect(cues[0].id).toBe('q_000002');
  });

  it('is accepted by the existing player: a rendered Chinese cue is chosen in gaps mode', () => {
    const [cue] = toPlayerScript([rendered(1, 10)], FILM).cues;
    expect(passesDensity(cue, 'standard')).toBe(true);
    expect(passesDensity(cue, 'essential')).toBe(false);
    expect(chooseUtterance(cue, { mode: 'gaps', detail: 'brief', rate: 1 })).toEqual({ text: '马修开门。', needsPause: false });
    expect(chooseUtterance(cue, { mode: 'gaps', detail: 'standard', rate: 1 })).toEqual({ text: '马修推开门走进来。', needsPause: false });
    expect(chooseUtterance(cue, { mode: 'gaps', detail: 'detailed', rate: 1 })).toEqual({ text: '马修推开沉重的木门，走进昏暗的走廊。', needsPause: false });
  });

  it('is accepted by the existing player: a rendered English cue is chosen in gaps mode', () => {
    const english = rendered(1, 10, { brief: 'Matthew opens the door.', standard: 'Matthew opens the door and steps inside.', detailed: 'Matthew opens the heavy front door and steps into the dim hallway.', priority: 1 });
    const [cue] = toPlayerScript([english], { videoId: 'film-1', lang: 'en', duration: 5400 }).cues;
    expect(passesDensity(cue, 'essential')).toBe(true);
    expect(chooseUtterance(cue, { mode: 'gaps', detail: 'standard', rate: 1 })).toEqual({ text: 'Matthew opens the door and steps inside.', needsPause: false });
    // The detailed text needs more than the four seconds of the slot: the player falls back.
    expect(estimateSeconds(english.detailed, 1)).toBeGreaterThan(4);
    expect(chooseUtterance(cue, { mode: 'gaps', detail: 'detailed', rate: 1 })).toEqual({ text: 'Matthew opens the door and steps inside.', needsPause: false });
  });

  it('gives the player the whole room: a measured gap keeps no margin back', () => {
    const standard = '马修推开门走进来。';
    const room = estimateSeconds(standard, 1) + 0.1;
    const [cue] = toPlayerScript([rendered(1, 10, { room })], FILM).cues;
    expect(chooseUtterance(cue, { mode: 'gaps', detail: 'standard', rate: 1 })).toEqual({ text: standard, needsPause: false });
    // The same cue with a gap the model had guessed would lose half a second and fall back to the brief text.
    expect(chooseUtterance({ ...cue, gapMeasured: false }, { mode: 'gaps', detail: 'standard', rate: 1 })).toEqual({ text: '马修开门。', needsPause: false });
  });

  it('lets the player skip a cue that does not fit, pause for it, and read on-screen text only when asked', () => {
    const [tight] = toPlayerScript([rendered(1, 10, { room: 0.5 })], FILM).cues;
    expect(chooseUtterance(tight, { mode: 'gaps', detail: 'standard', rate: 1 })).toBeNull();
    expect(chooseUtterance(tight, { mode: 'pause', detail: 'standard', rate: 1 })).toEqual({ text: '马修推开门走进来。', needsPause: true });
    const [text] = toPlayerScript([rendered(1, 10, { kind: 'text', brief: '出口。', standard: '门上写着：出口。', detailed: '门上的牌子写着：出口。' })], FILM).cues;
    expect(chooseUtterance(text, { mode: 'gaps', detail: 'standard', rate: 1, onScreenText: false })).toBeNull();
    expect(chooseUtterance(text, { mode: 'gaps', detail: 'standard', rate: 1, onScreenText: true })).toEqual({ text: '门上写着：出口。', needsPause: false });
    expect(passesDensity(text, 'essential')).toBe(true);
  });

  it('carries a model’s answer all the way to what the player says', () => {
    const answer = {
      cues: [{ slot: 'g_0001', kind: 'visual', priority: 1, brief: '｛p1｝开门。', standard: '｛p1｝推开门走进来。', detailed: '｛p1｝推开沉重的木门，走进昏暗的走廊。' }],
      sceneStarts: [9.96],
      appearances: [{ char: 'P1', outfit: '红裙子', from: 10 }],
    };
    const part = normalizeSection(answer, options());
    expect(part.problems).toEqual([]);
    const script = mergeSection(film(), part);
    expect(script.scenes).toEqual([10]);
    // What the name gate does, reduced to one line: every token filled with a name.
    const fill = (text) => text.replaceAll('{P1}', '马修');
    const cues = script.cues.map((c) => ({ ...c, room: c.end - c.start, people: c.people.map((p) => p.char), forms: { P1: 'name' }, brief: fill(c.brief), standard: fill(c.standard), detailed: fill(c.detailed) }));
    const player = toPlayerScript(cues, FILM);
    expect(player.cues[0]).toMatchObject({ id: 'q_000001', start: 10, gap: 4, gapMeasured: true });
    expect(passesDensity(player.cues[0], 'essential')).toBe(true);
    expect(chooseUtterance(player.cues[0], { mode: 'gaps', detail: 'standard', rate: 1 })).toEqual({ text: '马修推开门走进来。', needsPause: false });
  });
});

describe('textHash', () => {
  /** FNV-1a over UTF-16 code units, written another way (whole numbers, no 32-bit tricks). */
  function reference(text) {
    let hash = 0x811c9dc5n;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * 0x01000193n) % 0x100000000n;
    }
    return hash.toString(16).padStart(8, '0');
  }

  it('has fixed values: the published FNV-1a results', () => {
    expect(textHash('')).toBe('811c9dc5');
    expect(textHash('a')).toBe('e40c292c');
    expect(textHash('foobar')).toBe('bf9cf968');
  });

  it('hashes UTF-16 code units, one step each', () => {
    for (const text of ['马修推开门走进来。', 'Matthew opens the door.', '长发女人，穿着红裙子，', '😀', 'a\u0000b', '雨'.repeat(500)]) {
      expect(textHash(text)).toBe(reference(text));
    }
  });

  it('is always eight lower-case hex digits', () => {
    for (const text of ['', 'a', '马修', 'x'.repeat(1000), '￿￿', 'costarring', 'liquid']) expect(textHash(text)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is the same for the same text and differs when the text changes', () => {
    expect(textHash('马修推开门。')).toBe(textHash('马修推开门。'));
    expect(textHash('马修推开门。')).not.toBe(textHash('老陈推开门。'));
    expect(textHash('Matthew opens the door.')).not.toBe(textHash('Matthew opens the door'));
    expect(textHash('ab')).not.toBe(textHash('ba'));
  });

  it('takes what is not a string as its text, and nothing as the empty text', () => {
    expect(textHash(undefined)).toBe('811c9dc5');
    expect(textHash(null)).toBe('811c9dc5');
    expect(textHash(12)).toBe(textHash('12'));
  });
});

describe('staleClips', () => {
  const clip = (text, version = 'standard') => ({ file: 'clips/x.wav', dur: 2, voice: 'v', textHash: textHash(text), version });

  it('lists the cues whose clip was made from another text than the one rendered now', () => {
    const script = film([
      filmCue(1, 10, { clip: clip('马修推开门走进来。') }),
      filmCue(2, 20, { clip: clip('长发女人推开门走进来。') }),
      filmCue(3, 40),
    ]);
    expect(staleClips(script, [rendered(1, 10), rendered(2, 20), rendered(3, 40)])).toEqual(['q_000002']);
  });

  it('compares the version the clip was made from', () => {
    const script = film([
      filmCue(1, 10, { clip: clip('马修开门。', 'brief') }),
      filmCue(2, 20, { clip: clip('马修开门。', 'detailed') }),
      filmCue(3, 40, { clip: { ...clip('马修推开门走进来。'), version: undefined } }),
      filmCue(4, 50, { clip: { ...clip('马修开门。'), version: 'long' } }),
    ]);
    expect(staleClips(script, [rendered(1, 10), rendered(2, 20), rendered(3, 40), rendered(4, 50)])).toEqual(['q_000002', 'q_000004']);
  });

  it('goes stale when a character is renamed, with no change to the script', () => {
    const script = film([filmCue(1, 10, { clip: clip('马修推开门走进来。') })]);
    expect(staleClips(script, [rendered(1, 10)])).toEqual([]);
    expect(staleClips(script, [rendered(1, 10, { standard: '马秀推开门走进来。' })])).toEqual(['q_000001']);
  });

  it('works on English text', () => {
    const script = film([filmCue(1, 10, { clip: clip('Matthew opens the door.') })]);
    expect(staleClips(script, [rendered(1, 10, { standard: 'Matthew opens the door.' })])).toEqual([]);
    expect(staleClips(script, [rendered(1, 10, { standard: 'The woman with long hair opens the door.' })])).toEqual(['q_000001']);
  });

  it('lists them in the script’s order', () => {
    const script = film([filmCue(1, 10, { clip: clip('a') }), filmCue(2, 20, { clip: clip('b') })]);
    expect(staleClips(script, [rendered(2, 20), rendered(1, 10)])).toEqual(['q_000001', 'q_000002']);
  });

  it('does not list a cue that was not rendered, or has no clip', () => {
    const script = film([filmCue(1, 10, { clip: clip('something else') }), filmCue(2, 20), filmCue(3, 40, { clip: 'x.wav' })]);
    expect(staleClips(script, [rendered(2, 20), rendered(3, 40)])).toEqual([]);
    expect(staleClips(script, [])).toEqual([]);
    expect(staleClips(script, undefined)).toEqual([]);
    expect(staleClips(undefined, [rendered(1, 10)])).toEqual([]);
  });

  it('lists a clip whose cue is now rendered without that text', () => {
    const script = film([filmCue(1, 10, { clip: clip('马修开门。', 'brief') })]);
    expect(staleClips(script, [rendered(1, 10, { brief: undefined })])).toEqual(['q_000001']);
  });

  it('does not change what it is given', () => {
    const script = deepFreeze(film([filmCue(1, 10, { clip: clip('x') })]));
    const cues = deepFreeze([rendered(1, 10)]);
    expect(staleClips(script, cues)).toEqual(['q_000001']);
  });
});
