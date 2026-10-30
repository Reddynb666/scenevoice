// When to say how far generation has got: at each quarter of the work, at most
// once every PROGRESS_GAP_MS, counting the other generation messages (started,
// first minutes ready) as said. A quarter passed while it was too soon is said
// late, once, as the highest one reached; the end has its own message.

import { PROGRESS_GAP_MS, PROGRESS_MILESTONES } from './constants.js';

/**
 * The milestone to announce now, or null.
 * @param {object} p
 * @param {number} p.fraction  work done, 0..1
 * @param {number} p.said      the last milestone announced (0 before any)
 * @param {number} p.saidAt    when a generation message was last spoken (ms)
 * @param {number} p.now       current time (ms)
 */
export function progressMilestone({ fraction, said = 0, saidAt = 0, now, gapMs = PROGRESS_GAP_MS }) {
  if (!(fraction > 0) || fraction >= 1) return null;
  const reached = PROGRESS_MILESTONES.filter((m) => fraction >= m).pop();
  if (reached == null || reached <= said) return null;
  if (now - saidAt < gapMs) return null;
  return reached;
}
