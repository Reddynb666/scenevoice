// Decides which cues to fire as playback time advances.
// Handles seeking, looping (Shorts) and playback-rate changes.

export class CueScheduler {
  /** @param {Array<{start:number}>} cues sorted by start */
  constructor(cues = []) {
    this.setCues(cues);
  }

  setCues(cues) {
    this.cues = [...cues].sort((a, b) => a.start - b.start);
    this.last = null;
    this.fired = new Set();
  }

  /** Forget position; the next tick only records time and fires nothing. */
  reset(t = null) {
    this.last = t;
    this.fired.clear();
  }

  /**
   * Advance to time t. Returns the cues whose start lies in (last, t].
   * A backward jump or a forward jump of more than maxStep seconds is a seek:
   * nothing fires, so the user is not flooded with stale descriptions.
   */
  tick(t, maxStep = 2.5) {
    if (!Number.isFinite(t)) return [];
    let last = this.last;
    this.last = t;
    // Starting (or looping back) near 0:00 should still fire cues placed at the very start.
    const nearStart = t < 1;
    if (last === null) {
      if (!nearStart) return [];
      last = -0.001;
    } else if (t < last - 0.25 || t - last > maxStep) {
      this.fired.clear();
      if (!nearStart) return [];
      last = -0.001;
    }
    if (t <= last) return [];
    const out = [];
    for (let i = 0; i < this.cues.length; i += 1) {
      const c = this.cues[i];
      if (c.start > t) break;
      if (c.start > last && !this.fired.has(i)) {
        this.fired.add(i);
        out.push(c);
      }
    }
    return out;
  }
}

/**
 * When several cues fire in one tick (e.g. the tab was throttled), keep the most
 * important; among equals keep the latest, since it matches what is on screen now.
 */
export function pickOne(cues) {
  if (!cues.length) return null;
  return cues.reduce((best, c) => (c.priority < best.priority || (c.priority === best.priority && c.start >= best.start) ? c : best));
}
