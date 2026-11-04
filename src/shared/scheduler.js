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

/** -1 when cue a goes before cue b: the more important, then on-screen text before a visual description. */
function compareImportance(a, b) {
  if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
  const ta = a.kind === 'text' ? 0 : 1;
  const tb = b.kind === 'text' ? 0 : 1;
  return ta - tb;
}

/**
 * When several cues fire in one tick (e.g. the tab was throttled), keep the most
 * important; among equals on-screen text, then the latest, since it matches
 * what is on screen now.
 */
export function pickOne(cues) {
  if (!cues.length) return null;
  return cues.reduce((best, c) => {
    const order = compareImportance(c, best);
    return order < 0 || (order === 0 && c.start >= best.start) ? c : best;
  });
}

/**
 * Whether a cue that comes due may cut off the one being spoken. Only a more
 * important cue may (priority 1 is the highest): a description cut off
 * half-way is worse than one heard a few seconds late, and in a talking-head
 * video the cues come close enough that cutting off on equals would leave
 * most of them unfinished. On-screen text keeps its old protection (a visual
 * description that is no more important never cuts it off) and gains the
 * same against other text. What the user asked for (describe now, repeat,
 * an answer) is passed as {kind: 'manual', priority: 0}: nothing scheduled
 * outranks it. The cue held back waits for the next pause or is dropped (see
 * the content script).
 * @param {{kind: string, priority: number} | null} speaking  the cue being spoken, if any
 */
export function mayInterrupt(speaking, next) {
  if (!speaking) return true;
  return next.priority < speaking.priority;
}
