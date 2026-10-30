// Descriptions the user marked as wrong, and their corrections.
// No browser APIs here, so everything is unit-testable.
//
// A cue has no id: it is found by its start, kind and standard text, which is
// what the YouTube tab sends when the user marks it. The same reference is kept
// with each correction, so a correction can be applied again to a script that
// was saved without it (a generation job still running holds its own copy and
// saves it after every section).

import { applyConfidence } from './script.js';

/** What identifies a cue in a saved script. */
export function cueRef(cue) {
  return { start: Number(cue?.start), kind: cue?.kind === 'text' ? 'text' : 'visual', standard: String(cue?.standard ?? '') };
}

/** Index of the cue a reference points at, or -1. Playback may have moved a cue a little; the text must match. */
export function findCueIndex(cues, ref) {
  if (!Array.isArray(cues) || !ref || !Number.isFinite(Number(ref.start))) return -1;
  const start = Number(ref.start);
  return cues.findIndex((c) => c && Math.abs(c.start - start) <= 0.15 && c.kind === ref.kind && c.standard === ref.standard);
}

/** The script with one cue replaced, or removed when replacement is null. Unchanged if the cue is not there. */
export function replaceCue(script, ref, replacement) {
  const i = findCueIndex(script?.cues, ref);
  if (i < 0) return script;
  const cues = [...script.cues];
  if (replacement) cues[i] = replacement;
  else cues.splice(i, 1);
  return { ...script, cues: cues.sort((a, b) => a.start - b.start), updatedAt: Date.now() };
}

/**
 * Apply saved corrections, oldest first. A correction whose cue is no longer
 * there (already corrected, or the video was described again) changes nothing,
 * so this can run on every save.
 * @param {Array<{start: number, kind: string, standard: string, status: string, replacement?: object|null}>} records
 */
export function applyCorrections(script, records) {
  if (!script?.cues || !Array.isArray(records)) return script;
  let out = script;
  for (const r of records) {
    if (r?.status === 'revised' && r.replacement) out = replaceCue(out, r, r.replacement);
    else if (r?.status === 'removed') out = replaceCue(out, r, null);
  }
  return out;
}

const sameText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The corrected cue for a description marked as wrong, from what Gemini wrote
 * on looking again: the cue nearest the marked moment, at the old cue's time
 * and pause (only the words were wrong). null when Gemini found nothing there
 * worth describing. If Gemini says the same thing again, it is kept but said
 * to be uncertain: the viewer has already said it is wrong.
 */
export function correctedCue(old, cues, lang) {
  if (!Array.isArray(cues) || !cues.length) return null;
  const best = cues.reduce((a, b) => (Math.abs(b.start - old.start) < Math.abs(a.start - old.start) ? b : a));
  let cue = { ...best, start: old.start, gap: old.gap, revised: true };
  if (sameText(cue.standard, old.standard) && cue.confidence !== 'low') cue = applyConfidence({ ...cue, confidence: 'low' }, lang);
  return cue;
}
