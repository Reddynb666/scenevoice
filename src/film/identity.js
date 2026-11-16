// Who is on screen, and where. A description never gets its people from the model:
// identity comes from this layer, and there are three ways to have it. Labels made
// by hand (experiments and tests: proof that naming works before any face model is
// trusted), face tracks clustered on this computer, or nothing at all (the mode
// without faces, which cannot tell who is visible and says so instead of guessing).
// All three answer the same questions, so the marks, the verifier and the cast do
// not care which one they were given. One of the questions is how many people are
// in the picture, and there a face nobody has placed counts too: it is never
// named, but "the only person on screen" must not overlook it. Input is taken as
// it comes from a file: an entry that makes no sense is left out, never thrown on.

import { isCharacterId } from './types.js';

/** 'P12' → 12. */
const numberOf = (id) => Number(id.slice(1));

/** Orders character ids by number, so P2 comes before P10. */
const byNumber = (a, b) => numberOf(a) - numberOf(b);

/** A time on the film's axis: a finite number of seconds, not before the start. */
const isTime = (t) => typeof t === 'number' && Number.isFinite(t) && t >= 0;

/** A box a mark can be drawn from: [x, y, width, height], all finite, with some area. */
const isBox = (box) => Array.isArray(box)
  && box.length === 4
  && box.every((v) => typeof v === 'number' && Number.isFinite(v))
  && box[2] > 0
  && box[3] > 0;

/**
 * Slack for comparing a time with a label's time plus or minus the hold: 0.7 + 0.2
 * is a hair under 0.9 in floating point, and a label exactly `hold` away counts.
 */
const EPSILON = 1e-9;

/** A moment a caller may ask about: any number, the ends of time included (a span may be open). */
const isMoment = (t) => typeof t === 'number' && !Number.isNaN(t);

/**
 * The span a caller asks about, earlier end first. null when an end is not a
 * number: the answer is then "nobody", the side on which a name is not spoken.
 */
function querySpan(t0, t1) {
  if (!isMoment(t0) || !isMoment(t1)) return null;
  return t0 <= t1 ? [t0, t1] : [t1, t0];
}

/** Seconds covered by a list of [from, to] spans, a stretch two of them share counted once; to the millisecond. */
function unionSeconds(spans) {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return Math.round(total * 1000) / 1000;
}

/** { P1: seconds, P2: … } from the spans of each character, in order of character number. */
function secondsPerCharacter(spansOf) {
  const out = {};
  for (const id of [...spansOf.keys()].sort(byNumber)) out[id] = unionSeconds(spansOf.get(id));
  return out;
}

/** Adds a span to a character's list. */
function addSpan(spansOf, id, span) {
  if (!spansOf.has(id)) spansOf.set(id, []);
  spansOf.get(id).push(span);
}

/**
 * Identity from labels made by hand: the reference the experiments are measured
 * against, and what the first milestones run on before any face model is trusted.
 * A person does not label every frame, so a label stands for `hold` seconds either
 * side of its time.
 * @param {Array<{t: number, box: number[], characterId: string, trackId?: string}>} labels
 *   box is [x, y, width, height] in pixels of the sampled frame
 * @param {{hold?: number}} [options]  seconds a label counts for before and after its time (1)
 * @returns {import('./types.js').IdentityProvider & {screenSeconds: () => Object<string, number>}}
 */
export function groundTruthIdentity(labels, options) {
  const hold = options && Number.isFinite(options.hold) && options.hold >= 0 ? options.hold : 1;
  const sightings = [];
  // Boxes drawn around somebody without a character id: people, but nobody the cast knows.
  const strangers = [];
  (Array.isArray(labels) ? labels : []).forEach((label, index) => {
    if (!label || typeof label !== 'object') return;
    if (!isTime(label.t) || !isBox(label.box)) return;
    const trackId = typeof label.trackId === 'string' && label.trackId ? label.trackId : '';
    if (!isCharacterId(label.characterId)) {
      // Without a track id each box is taken for another person: counting one too many is the safe mistake.
      strangers.push({ key: trackId ? `track:${trackId}` : `label:${index}`, t: label.t });
      return;
    }
    const sighting = { characterId: label.characterId, t: label.t, box: [...label.box] };
    if (trackId) sighting.trackId = trackId;
    sightings.push(sighting);
  });
  // In time order, so that of two labels equally far from a moment the earlier one is kept.
  sightings.sort((a, b) => a.t - b.t);
  const held = (t, span) => t + hold >= span[0] - EPSILON && t - hold <= span[1] + EPSILON;

  return Object.freeze({
    mode: 'ground-truth',

    /** Everyone with a label within `hold` of t: one entry per character, from the label nearest in time. */
    visibleAt(t) {
      // null would count as time 0 in the arithmetic below: only a number is a time.
      if (!isMoment(t)) return [];
      const nearest = new Map();
      for (const sighting of sightings) {
        const gap = Math.abs(sighting.t - t);
        if (gap > hold + EPSILON) continue;
        const kept = nearest.get(sighting.characterId);
        if (!kept || gap < kept.gap) nearest.set(sighting.characterId, { gap, sighting });
      }
      return [...nearest.keys()].sort(byNumber).map((id) => {
        const { sighting } = nearest.get(id);
        // A person drew this box: there is no doubt to report.
        const visible = { characterId: id, box: [...sighting.box], conf: 1 };
        if (sighting.trackId) visible.trackId = sighting.trackId;
        return visible;
      });
    },

    /** The characters with a label whose held span meets [t0, t1], by character number. */
    visibleBetween(t0, t1) {
      const span = querySpan(t0, t1);
      if (!span) return [];
      const ids = new Set();
      for (const sighting of sightings) {
        if (held(sighting.t, span)) ids.add(sighting.characterId);
      }
      return [...ids].sort(byNumber);
    },

    /**
     * How many people have a label whose held span meets [t0, t1]: each character
     * once, and each box drawn around somebody without a character id.
     */
    peopleBetween(t0, t1) {
      const span = querySpan(t0, t1);
      if (!span) return 0;
      const who = new Set();
      for (const sighting of sightings) {
        if (held(sighting.t, span)) who.add(sighting.characterId);
      }
      for (const stranger of strangers) {
        if (held(stranger.t, span)) who.add(stranger.key);
      }
      return who.size;
    },

    /**
     * An estimate of the seconds each character is on screen: the stretches their
     * labels hold for, overlaps counted once. A label near the start of the film
     * does not count the part of its hold that falls before time 0.
     */
    screenSeconds() {
      const spansOf = new Map();
      for (const sighting of sightings) {
        addSpan(spansOf, sighting.characterId, [Math.max(0, sighting.t - hold), sighting.t + hold]);
      }
      return secondsPerCharacter(spansOf);
    },
  });
}

/** A detector's confidence as a number from 0 to 1. One that is missing counts as none, so it never wins over a real one. */
const confidence = (conf) => (typeof conf === 'number' && Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0);

/**
 * Identity from face tracks clustered on this computer. A track is one face followed
 * through a shot; a cluster is the tracks taken to be one face; the cast says which
 * character a cluster belongs to (a character may have several: ages, make-up).
 * A track counts as visible from its first to its last sample. A track whose cluster
 * no character owns is a face nobody has placed yet: it is never guessed, so
 * visibleAt, visibleBetween and screenSeconds leave it out, but it is a person on
 * screen and peopleBetween counts it.
 * @param {Array<{id: string, cluster: string|number, samples: Array<{t: number, box: number[], conf: number}>}>} tracks
 * @param {Object<string, string>} characterOfCluster  cluster id → character id
 * @returns {import('./types.js').IdentityProvider & {screenSeconds: () => Object<string, number>}}
 */
export function faceClusterIdentity(tracks, characterOfCluster) {
  const characterOf = characterOfCluster && typeof characterOfCluster === 'object' ? characterOfCluster : {};
  const known = [];
  // Faces nobody has placed: counted as people, never named.
  const strangers = [];
  (Array.isArray(tracks) ? tracks : []).forEach((track, index) => {
    if (!track || typeof track !== 'object') return;
    const samples = [];
    for (const sample of Array.isArray(track.samples) ? track.samples : []) {
      if (!sample || typeof sample !== 'object' || !isTime(sample.t) || !isBox(sample.box)) continue;
      samples.push({ t: sample.t, box: [...sample.box], conf: confidence(sample.conf) });
    }
    if (!samples.length) return;
    samples.sort((a, b) => a.t - b.t);
    const from = samples[0].t;
    const to = samples[samples.length - 1].t;
    const clustered = typeof track.cluster === 'string' || typeof track.cluster === 'number';
    const characterId = clustered ? characterOf[track.cluster] : undefined;
    if (!isCharacterId(characterId)) {
      // The tracks of one unplaced cluster are one person; a track without a cluster is a face of its own.
      strangers.push({ key: clustered ? `cluster:${track.cluster}` : `track:${index}`, from, to });
      return;
    }
    const entry = { characterId, samples, from, to };
    if (typeof track.id === 'string' && track.id) entry.trackId = track.id;
    else if (typeof track.id === 'number' && Number.isFinite(track.id)) entry.trackId = String(track.id);
    known.push(entry);
  });

  return Object.freeze({
    mode: 'face-cluster',

    /**
     * Everyone with a track running at t, from the sample of that track nearest in
     * time. A character two tracks show at once (a mirror, a detector that split
     * one face) appears once, with the more confident sample.
     */
    visibleAt(t) {
      if (!isMoment(t)) return [];
      const best = new Map();
      for (const track of known) {
        if (t < track.from || t > track.to) continue;
        let sample = track.samples[0];
        for (const candidate of track.samples) {
          if (Math.abs(candidate.t - t) < Math.abs(sample.t - t)) sample = candidate;
        }
        const gap = Math.abs(sample.t - t);
        const kept = best.get(track.characterId);
        if (!kept || sample.conf > kept.sample.conf || (sample.conf === kept.sample.conf && gap < kept.gap)) {
          best.set(track.characterId, { track, sample, gap });
        }
      }
      return [...best.keys()].sort(byNumber).map((id) => {
        const { track, sample } = best.get(id);
        const visible = { characterId: id, box: [...sample.box], conf: sample.conf };
        if (track.trackId) visible.trackId = track.trackId;
        return visible;
      });
    },

    /** The characters with a track that runs during some part of [t0, t1], by character number. */
    visibleBetween(t0, t1) {
      const span = querySpan(t0, t1);
      if (!span) return [];
      const ids = new Set();
      for (const track of known) {
        if (track.to >= span[0] && track.from <= span[1]) ids.add(track.characterId);
      }
      return [...ids].sort(byNumber);
    },

    /**
     * How many people have a track that runs during some part of [t0, t1]: a
     * character once however many tracks it has (a track ends at every cut), and
     * the faces nobody has placed, each unplaced cluster once.
     */
    peopleBetween(t0, t1) {
      const span = querySpan(t0, t1);
      if (!span) return 0;
      const who = new Set();
      for (const track of known) {
        if (track.to >= span[0] && track.from <= span[1]) who.add(track.characterId);
      }
      for (const track of strangers) {
        if (track.to >= span[0] && track.from <= span[1]) who.add(track.key);
      }
      return who.size;
    },

    /** The seconds each character's tracks cover, a moment two tracks share counted once. */
    screenSeconds() {
      const spansOf = new Map();
      for (const track of known) addSpan(spansOf, track.characterId, [track.from, track.to]);
      return secondsPerCharacter(spansOf);
    },
  });
}

/**
 * Identity for the mode without faces (animation, dark films, a person who does not
 * turn face clustering on): people are a text list carried with each section, and
 * nothing is known about who is in the picture. visibleAt() is empty, and
 * visibleBetween() and peopleBetween() answer null, which means "cannot tell",
 * not "nobody": the verifier must not read it as a check that passed.
 * @returns {import('./types.js').IdentityProvider & {screenSeconds: () => Object<string, number>}}
 */
export function promptBankIdentity() {
  return Object.freeze({
    mode: 'prompt-bank',
    visibleAt: () => [],
    visibleBetween: () => null,
    peopleBetween: () => null,
    screenSeconds: () => ({}),
  });
}
