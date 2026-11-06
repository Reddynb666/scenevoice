// How the Gemini models have behaved just now, so the next choice skips one
// that is overloaded or slow instead of always taking the newest. Kept in
// memory for one sitting: the offscreen worker (extension) or the page (web
// player). Nothing is stored or sent anywhere.
//
// A model is marked
//   overloaded  when it answered 503 ("high demand") or did not begin to
//               answer before the first-answer deadline;
//   slow        when a section took longer than SLOW_RATIO of the video it
//               covers: playback would catch up with the descriptions.
// Marks fade after HEALTH_MEMORY_MS, so a model gets another chance later.

/** How long an overload or slowness counts against a model. */
export const HEALTH_MEMORY_MS = 15 * 60 * 1000;
/** A section is slow when it takes more than this share of the video it describes (and at least SLOW_MIN_MS). */
export const SLOW_RATIO = 0.6;
export const SLOW_MIN_MS = 30000;

export class ModelHealth {
  constructor(now = () => Date.now()) {
    this.now = now;
    /** @type {Map<string, {overloadedAt?: number, slowAt?: number, msPerSecond?: number}>} */
    this.byModel = new Map();
  }

  entry(model) {
    if (!this.byModel.has(model)) this.byModel.set(model, {});
    return this.byModel.get(model);
  }

  noteOverloaded(model) {
    if (model) this.entry(model).overloadedAt = this.now();
  }

  /**
   * A section came back after `ms` for `videoSeconds` of video. Returns whether
   * that was slow (and marks the model so); a fast section clears a slow mark.
   */
  noteSection(model, { ms, videoSeconds }) {
    if (!model || !Number.isFinite(ms) || !(videoSeconds > 0)) return false;
    const e = this.entry(model);
    e.msPerSecond = ms / videoSeconds;
    const slow = ms > Math.max(SLOW_MIN_MS, SLOW_RATIO * videoSeconds * 1000);
    if (slow) e.slowAt = this.now();
    else delete e.slowAt;
    return slow;
  }

  /** 2 = overloaded just now, 1 = slow just now, 0 = nothing against it. */
  penalty(model) {
    const e = this.byModel.get(model);
    if (!e) return 0;
    const recent = (at) => Number.isFinite(at) && this.now() - at < HEALTH_MEMORY_MS;
    if (recent(e.overloadedAt)) return 2;
    if (recent(e.slowAt)) return 1;
    return 0;
  }

  /** Measured milliseconds per second of video, or undefined when this model has not finished a section yet. */
  speed(model) {
    return this.byModel.get(model)?.msPerSecond;
  }

  clear() {
    this.byModel.clear();
  }
}

/** The one record for this JavaScript context (the offscreen worker, or the web player page). */
export const modelHealth = new ModelHealth();
