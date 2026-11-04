import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { VISUAL_WAIT, fitCuesToDialogue, isNonSpeech, parseTimedText, speechIntervals } from '../src/shared/dialogue.js';
import { chooseUtterance } from '../src/shared/script.js';
import { extractCaptionTracks, pickCaptionTrack, timedTextUrl } from '../src/content/youtube.js';

const cue = (start, gap, extra = {}) => ({
  start,
  gap,
  kind: 'visual',
  priority: 1,
  brief: 'A door opens.',
  standard: 'A tall man opens the front door and steps inside.',
  detailed: 'A tall man in a grey raincoat opens the heavy front door, shakes off his umbrella and steps into the dim hallway.',
  ...extra,
});

describe('parseTimedText', () => {
  it('reads json3 subtitles', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello there.' }] },
        { tStartMs: 3500, dDurationMs: 1500 }, // window definition, no text
        { tStartMs: 6000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
        { tStartMs: 8000, dDurationMs: 1000, segs: [{ utf8: '[Music]' }] },
      ],
    });
    expect(parseTimedText(body)).toEqual([
      { start: 1, end: 3, text: 'Hello there.' },
      { start: 8, end: 9, text: '[Music]' },
    ]);
  });
  it('ends word-timed captions shortly after the last word', () => {
    const body = JSON.stringify({
      events: [{ tStartMs: 10000, dDurationMs: 6000, segs: [{ utf8: 'so' }, { utf8: ' anyway', tOffsetMs: 400 }, { utf8: ' yes', tOffsetMs: 900 }] }],
    });
    const [line] = parseTimedText(body);
    expect(line.start).toBe(10);
    expect(line.end).toBeCloseTo(11.9);
  });
  it('reads srv3 and srv1 XML', () => {
    expect(parseTimedText('<timedtext><body><p t="1500" d="2000">Tom &amp; Jerry<s>!</s></p></body></timedtext>')).toEqual([
      { start: 1.5, end: 3.5, text: 'Tom & Jerry!' },
    ]);
    expect(parseTimedText('<transcript><text start="4.2" dur="1.3">It&amp;#39;s fine</text></transcript>')).toEqual([
      { start: 4.2, end: 5.5, text: "It's fine" },
    ]);
  });
  it('returns nothing for empty or broken responses', () => {
    expect(parseTimedText('')).toEqual([]);
    expect(parseTimedText(undefined)).toEqual([]);
    expect(parseTimedText('{not json')).toEqual([]);
  });
});

describe('isNonSpeech', () => {
  it.each(['[Music]', '(applause)', '♪♪', '♪ ♪', '[音乐]', '（笑）', '>> [LAUGHTER]', ''])('%s is not speech', (t) => expect(isNonSpeech(t)).toBe(true));
  it.each(['Hello', '(laughs) I know', '♪ la la la ♪', '你好', '42'])('%s is speech', (t) => expect(isNonSpeech(t)).toBe(false));
});

describe('speechIntervals', () => {
  it('merges close lines and ignores sound labels', () => {
    const lines = [
      { start: 5, end: 6, text: 'B' },
      { start: 1, end: 2, text: 'A' },
      { start: 2.1, end: 3, text: 'A2' },
      { start: 3, end: 5, text: '[Music]' },
      { start: 5.5, end: 7, text: 'C' },
    ];
    expect(speechIntervals(lines)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
  });
});

describe('fitCuesToDialogue', () => {
  const speech = [
    { start: 2, end: 4 },
    { start: 10, end: 20 },
    { start: 25, end: 26 },
  ];
  it('leaves cues alone without dialogue timing', () => {
    const cues = [cue(1, 3)];
    expect(fitCuesToDialogue(cues, [])).toBe(cues);
    expect(fitCuesToDialogue(cues, null)).toBe(cues);
  });
  it('shrinks a gap the model overestimated', () => {
    const [c] = fitCuesToDialogue([cue(5, 8)], speech);
    expect(c).toMatchObject({ start: 5, gap: 4.7, gapMeasured: true });
  });
  it('never grows a gap beyond the model estimate', () => {
    const [c] = fitCuesToDialogue([cue(5, 2)], speech);
    expect(c.gap).toBe(2);
  });
  it('moves a cue that starts just before speech ends to the end of the speech', () => {
    const [c] = fitCuesToDialogue([cue(3.2, 6)], speech);
    expect(c).toMatchObject({ start: 4, gap: 5.7 });
  });
  it('gives no room to a cue in the middle of long speech', () => {
    const [c] = fitCuesToDialogue([cue(12, 6)], speech);
    expect(c).toMatchObject({ start: 12, gap: 0 });
  });
  it('keeps the model estimate after the last caption', () => {
    const [c] = fitCuesToDialogue([cue(30, 7)], speech);
    expect(c.gap).toBe(7);
  });
  it('keeps cues sorted after moving them', () => {
    const out = fitCuesToDialogue([cue(3.5, 5), cue(3.8, 5, { kind: 'text' })], speech);
    expect(out.map((c) => c.start)).toEqual([4, 4]);
  });
  it('end to end: a cue the model thought fits is skipped when captions show speech', () => {
    // The model claimed 8 s of silence at 9 s, but someone speaks at 10 s.
    const [c] = fitCuesToDialogue([cue(9, 8)], speech);
    expect(chooseUtterance(c, { mode: 'gaps', detail: 'standard', rate: 1, onScreenText: true })).toBeNull();
    expect(chooseUtterance(c, { mode: 'pause', detail: 'standard', rate: 1, onScreenText: true }).needsPause).toBe(true);
  });

  describe('a priority-1 visual cue that lands on speech', () => {
    // A talking head: speech from 10 to 14, a 1.5 s pause, speech from 15.5 to 20, then a long pause.
    // A cue at 11 is 3 s from the end of the speech: too far to be moved there by fitOne alone.
    const talk = [
      { start: 10, end: 14 },
      { start: 15.5, end: 20 },
    ];
    /** About 0.6 s at rate 1; "A door opens." takes about 1.3 s. */
    const short = (start, gap, extra = {}) => cue(start, gap, { priority: 1, brief: 'Nods.', ...extra });
    const gaps = { mode: 'gaps', detail: 'standard', rate: 1, onScreenText: true };
    const pause = { ...gaps, mode: 'pause' };

    it('waits for the first pause within VISUAL_WAIT seconds that fits its brief version', () => {
      expect(VISUAL_WAIT).toBe(5);
      const [c] = fitCuesToDialogue([short(11, 6)], talk);
      expect(c).toMatchObject({ start: 14, gap: 1.2, gapMeasured: true });
      expect(chooseUtterance(c, gaps)).toEqual({ text: 'Nods.', needsPause: false });
    });
    it('is left with no room (skipped, or paused for) when no pause in reach is long enough', () => {
      // The pause at 14 has 1.2 s after the margin, too short for "A door opens."; the one after 20 is 9 s away.
      const [c] = fitCuesToDialogue([cue(11, 6, { priority: 1 })], talk);
      expect(c).toMatchObject({ start: 11, gap: 0 });
      expect(chooseUtterance(c, gaps)).toBeNull();
      expect(chooseUtterance(c, pause).needsPause).toBe(true);
      // Allowed to wait longer, it reaches the pause after 20 (the captions end there: the model's estimate stands).
      expect(fitCuesToDialogue([cue(11, 6, { priority: 1 })], talk, { visualWait: 10 })[0]).toMatchObject({ start: 20, gap: 6 });
    });
    it("measures the room at the listener's reading speed and the playback rate", () => {
      // A fast reader (2.5x) says "A door opens." in about 0.7 s: the pause at 14 will do.
      expect(fitCuesToDialogue([cue(11, 6, { priority: 1 })], talk, { rate: 2.5 })[0]).toMatchObject({ start: 14, gap: 1.2 });
      // At 2x playback the same pause lasts half as long in real time.
      expect(fitCuesToDialogue([cue(11, 6, { priority: 1 })], talk, { rate: 2.5, playbackRate: 2 })[0]).toMatchObject({ start: 11, gap: 0 });
    });
    it('leaves less important visual cues where they are: they are skipped, not moved', () => {
      expect(fitCuesToDialogue([short(11, 6, { priority: 2 })], talk)[0]).toMatchObject({ start: 11, gap: 0 });
    });
    it('frames mode: a cue with gap 0 (no pause known) is still said in a measured pause', () => {
      // The model could not tell whether anyone speaks; the captions can.
      const [c] = fitCuesToDialogue([short(11, 0)], talk);
      expect(c).toMatchObject({ start: 14, gap: 1.2, gapMeasured: true });
      // Without captions there is nothing to measure: skipped in "keep playing" mode, a pause in pause mode.
      const raw = cue(11, 0, { priority: 1 });
      expect(chooseUtterance(raw, { mode: 'gaps', detail: 'brief', rate: 3, onScreenText: true })).toBeNull();
      expect(chooseUtterance(raw, { mode: 'pause', detail: 'brief', rate: 1, onScreenText: true }).needsPause).toBe(true);
    });
  });
});

describe('caption tracks', () => {
  const html = `<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[
    {"baseUrl":"https://www.youtube.com/api/timedtext?v=abc\\u0026lang=en","name":{"simpleText":"English [auto] ]"},"languageCode":"en","kind":"asr"},
    {"baseUrl":"/api/timedtext?v=abc\\u0026lang=fr","languageCode":"fr"},
    {"baseUrl":"/api/timedtext?v=abc\\u0026lang=en\\u0026name=CC","languageCode":"en"}
  ],"audioTracks":[]}}};</script>`;

  it('extracts the track list from a watch page', () => {
    const tracks = extractCaptionTracks(html);
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toEqual({ baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', languageCode: 'en', kind: 'asr' });
    expect(extractCaptionTracks('<html>no captions</html>')).toEqual([]);
    expect(extractCaptionTracks(null)).toEqual([]);
  });
  it('prefers subtitles in the spoken language, then auto captions', () => {
    const tracks = extractCaptionTracks(html);
    expect(pickCaptionTrack(tracks).baseUrl).toContain('name=CC');
    expect(pickCaptionTrack(tracks.slice(0, 2)).kind).toBe('asr');
    expect(pickCaptionTrack(tracks.slice(1, 2)).languageCode).toBe('fr');
    expect(pickCaptionTrack([])).toBeNull();
  });
  it('builds json3 URLs only for the timedtext API', () => {
    expect(timedTextUrl('/api/timedtext?v=abc&lang=en&fmt=srv3', 'https://www.youtube.com')).toBe(
      'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3',
    );
    expect(timedTextUrl('https://evil.example/api/timedtext?v=abc', 'https://www.youtube.com')).toBeNull();
    expect(timedTextUrl('/watch?v=abc', 'https://www.youtube.com')).toBeNull();
  });
});

describe('defaults', () => {
  it('lowers the video volume while describing, and keeps playing by default', () => {
    expect(DEFAULT_SETTINGS.duck).toBe(true);
    expect(DEFAULT_SETTINGS.duckLevel).toBeLessThan(1);
    expect(DEFAULT_SETTINGS.mode).toBe('gaps');
  });
});
