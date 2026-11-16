// The fake narration of the test shell: the ten timed descriptions of
// sample/narration.json, which description is due at which moment of the film,
// and the answer to "who is on screen". The shell analyses nothing: the same
// script is spoken over the sample and over any film the tester opens.
// Pure: no DOM, the film's time is passed in.

/** A jump in time larger than this between two looks at the clock is a seek, not playback. */
export const MAX_STEP_SECONDS = 1.5;

/**
 * The script in one language.
 * @param {object} data  the parsed narration.json
 * @param {'zh'|'en'} lang
 * @returns {{duration: number,
 *            cues: {id: string, t: number, text: string, names: string[]}[],
 *            who: {from: number, to: number, names: string[]}[], leadName: string}}
 */
export function prepareScript(data, lang) {
  const pick = (value) => (value && typeof value === 'object' ? String(value[lang] ?? value.en ?? '') : String(value ?? ''));
  const nameOf = (id) => pick(data.people[id]);
  const cues = data.cues
    .map((cue) => ({ id: String(cue.id), t: Number(cue.t), text: pick(cue), names: (cue.people || []).map(nameOf) }))
    .filter((cue) => Number.isFinite(cue.t) && cue.text)
    .sort((a, b) => a.t - b.t);
  const who = (data.who || [])
    .map((span) => ({ from: Number(span.from), to: Number(span.to), names: (span.people || []).map(nameOf) }))
    .sort((a, b) => a.from - b.from);
  return {
    duration: Number(data.clip.duration),
    cues,
    who,
    leadName: nameOf(data.clip.lead),
  };
}

/**
 * The cues that became due between two looks at the film's clock. Nothing is
 * due across a seek (a jump backwards, or forwards by more than a step).
 */
export function dueCues(cues, previous, time, maxStep = MAX_STEP_SECONDS) {
  if (!(time > previous) || time - previous > maxStep) return [];
  return cues.filter((cue) => cue.t > previous && cue.t <= time);
}

/** The description for this moment (D): the latest one at or before it, else the first. */
export function cueAt(cues, time) {
  let found = null;
  for (const cue of cues) {
    if (cue.t <= time + 0.25) found = cue;
    else break;
  }
  return found || cues[0] || null;
}

/** Who is on screen at this moment (W): names and labels from the fixed table. */
export function namesAt(script, time) {
  const span = script.who.find((s) => time >= s.from && time < s.to);
  return span ? span.names : [];
}

/** A film time as m:ss, or h:mm:ss from an hour on. */
export function clock(seconds) {
  const total = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Hours, minutes and seconds of a duration, for a spoken sentence. */
export function durationParts(seconds) {
  const total = Number.isFinite(Number(seconds)) ? Math.max(0, Math.round(Number(seconds))) : 0;
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}
