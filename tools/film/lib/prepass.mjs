// The local pass over a film that the kill tests time and that face-tracks
// saves: sampled frames -> faces -> embeddings, with a stopwatch on every part.
// Also the small helpers both scripts share: shot cuts from scene scores,
// statistics over timings, a memory sampler, command-line parsing.

import { spawn } from 'node:child_process';
import { basename, extname } from 'node:path';

import { faceSize } from './faces.mjs';
import { frames } from './media.mjs';

/** Faces with a shorter side under this many pixels are found but not embedded. */
export const MIN_FACE_PIXELS = 40;

/**
 * The scene score at or above which a picture starts a new shot. 0.3 is the
 * value commonly used with ffmpeg's select filter; it has not been checked
 * against a hand-marked list of cuts for any film here.
 */
export const CUT_THRESHOLD = 0.3;
/** Two cuts closer than this are one (a flash, a strobe): the first is kept. */
export const CUT_MIN_GAP_SECONDS = 0.25;

/**
 * Sampled frames, the faces in each, and an embedding for every face large
 * enough. `onFrame(frame, faces)` is awaited for every frame (its time is not
 * counted in the stage).
 *
 * @param {string} file
 * @param {{
 *   faces: { detect: Function, embed: Function }, info: object, fps?: number, width?: number, start?: number, end?: number,
 *   minFace?: number, tiles?: boolean, scoreThreshold?: number, onFrame?: Function, markAt?: number,
 * }} options
 */
export async function facePass(file, { faces, info, fps = 2, width = 960, start, end, minFace = MIN_FACE_PIXELS, tiles = false, scoreThreshold = 0.6, onFrame, markAt }) {
  const records = [];
  const detectMs = [];
  const embedMs = [];
  let hookMs = 0;
  let waitMs = 0;
  let frameWidth = 0;
  let frameHeight = 0;
  let found = 0;
  let embedded = 0;
  let smallest = Infinity;
  let reachedMarkMs = null;
  const started = performance.now();
  let waitFrom = started;
  for await (const frame of frames(file, { fps, width, start, end, info })) {
    waitMs += performance.now() - waitFrom;
    frameWidth = frame.width;
    frameHeight = frame.height;
    if (markAt !== undefined && reachedMarkMs === null && frame.t >= markAt) reachedMarkMs = performance.now() - started - hookMs;

    const beforeDetect = performance.now();
    const detected = await faces.detect(frame.rgb, frame.width, frame.height, { scoreThreshold, tiles });
    detectMs.push(performance.now() - beforeDetect);

    const kept = [];
    for (const face of detected) {
      found += 1;
      const size = faceSize(face);
      smallest = Math.min(smallest, size);
      let embedding = null;
      if (size >= minFace) {
        const beforeEmbed = performance.now();
        embedding = await faces.embed(frame.rgb, frame.width, frame.height, face);
        embedMs.push(performance.now() - beforeEmbed);
        embedded += 1;
      }
      kept.push({ box: face.box, score: face.score, landmarks: face.landmarks, embedding });
    }
    records.push({ index: frame.index, t: frame.t, faces: kept });

    if (onFrame) {
      const beforeHook = performance.now();
      await onFrame(frame, kept);
      hookMs += performance.now() - beforeHook;
    }
    waitFrom = performance.now();
  }
  const wallMs = performance.now() - started - hookMs;
  return {
    frames: records,
    width: frameWidth,
    height: frameHeight,
    counts: {
      framesSampled: records.length,
      framesWithFaces: records.filter((record) => record.faces.length > 0).length,
      facesFound: found,
      facesEmbedded: embedded,
      smallestFacePixels: Number.isFinite(smallest) ? Math.round(smallest * 10) / 10 : null,
    },
    timing: { wallMs, waitForFramesMs: waitMs, detectMs, embedMs, reachedMarkMs },
  };
}

/**
 * Shot cuts from per-picture scene scores: every picture whose score reaches
 * the threshold starts a shot, unless a cut was already taken within the
 * minimum gap before it.
 *
 * @param {{ t: number, score: number }[]} scores
 * @returns {{ t: number, score: number }[]}
 */
export function cutsFromScores(scores, { threshold = CUT_THRESHOLD, minGap = CUT_MIN_GAP_SECONDS } = {}) {
  const cuts = [];
  for (const entry of scores) {
    if (entry.score < threshold) continue;
    if (cuts.length && entry.t - cuts[cuts.length - 1].t < minGap) continue;
    cuts.push({ t: entry.t, score: entry.score });
  }
  return cuts;
}

/** Mean, median and tails of a list of numbers, rounded to hundredths. */
export function summary(values) {
  if (!values.length) return { n: 0, mean: null, min: null, p10: null, median: null, p90: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const round = (value) => Math.round(value * 100) / 100;
  return {
    n: sorted.length,
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    min: round(sorted[0]),
    p10: round(at(0.1)),
    median: round(at(0.5)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
  };
}

function psRows() {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-axo', 'ppid=,rss=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
    });
    child.once('error', () => resolve([]));
    child.once('close', () => {
      resolve(text.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((m) => ({ ppid: Number(m[1]), rssKb: Number(m[2]), command: m[3] })));
    });
  });
}

/**
 * Watch resident memory while work runs: this process (sampled, and the peak
 * the system kept) and its ffmpeg children (sampled through ps, where there is
 * one). stop() returns bytes.
 */
export function watchMemory({ everyMs = 250 } = {}) {
  let peakSelf = process.memoryUsage.rss();
  let peakChildren = 0;
  let samples = 0;
  let busy = false;
  const canPs = process.platform !== 'win32';
  const timer = setInterval(async () => {
    peakSelf = Math.max(peakSelf, process.memoryUsage.rss());
    if (!canPs || busy) return;
    busy = true;
    const rows = await psRows();
    const mine = rows.filter((row) => row.ppid === process.pid && /ffmpeg|ffprobe/.test(row.command));
    peakChildren = Math.max(peakChildren, mine.reduce((sum, row) => sum + row.rssKb * 1024, 0));
    samples += 1;
    busy = false;
  }, everyMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      peakSelf = Math.max(peakSelf, process.memoryUsage.rss());
      return { peakRssBytes: peakSelf, peakFfmpegRssBytes: canPs ? peakChildren : null, ffmpegSamples: samples };
    },
  };
}

/** A timer this late means the process did not run in between: the machine slept or stalled. */
export const STALL_LIMIT_MS = 2000;

/**
 * Notice when the machine stops under a measurement. A timer is due every
 * `everyMs`; when it fires more than `limitMs` late by the wall clock, this
 * process was not running in between (the lid was closed, the computer slept,
 * or it was stalled by swapping), and any stopwatch that was running then is
 * wrong. stop() returns the gaps found. Pure bookkeeping: `now` can be replaced
 * in tests.
 */
export function watchStalls({ everyMs = 250, limitMs = STALL_LIMIT_MS, now = Date.now } = {}) {
  let last = now();
  let longest = 0;
  const gaps = [];
  const look = () => {
    const at = now();
    const late = at - last - everyMs;
    longest = Math.max(longest, late);
    if (late > limitMs) gaps.push({ from: new Date(last).toISOString(), seconds: Math.round(late / 100) / 10 });
    last = at;
  };
  const timer = setInterval(look, everyMs);
  timer.unref();
  return {
    look,
    stop() {
      clearInterval(timer);
      // The time since the last tick counts too: a sleep can end in the same turn as the work.
      const late = now() - last - everyMs;
      longest = Math.max(longest, late);
      if (late > limitMs) gaps.push({ from: new Date(last).toISOString(), seconds: Math.round(late / 100) / 10 });
      return { longestGapMs: Math.max(0, Math.round(longest)), gaps };
    },
  };
}

/** A folder name for a film's outputs: the file name without its extension. */
export function outputName(file) {
  return basename(file, extname(file)).replace(/[^\w.-]+/g, '_');
}

/** An embedding as base64 of its little-endian float32 bytes. */
export function embeddingToBase64(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength).toString('base64');
}

/** The inverse of embeddingToBase64. */
export function embeddingFromBase64(text) {
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Intersection over union of two boxes [x, y, w, h]. */
export function overlap(a, b) {
  const iw = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

/**
 * The --ep option: "cpu" -> ['cpu'], a list to try in order for both models;
 * "detector=coreml,recogniser=cpu" -> one provider per model.
 */
export function parseProviders(text) {
  if (!text) return undefined;
  if (!text.includes('=')) return text.split(',').map((name) => name.trim()).filter(Boolean);
  const each = {};
  for (const part of text.split(',')) {
    const [model, provider] = part.split('=').map((piece) => piece.trim());
    if (model !== 'detector' && model !== 'recogniser') throw new Error(`--ep: unknown model "${model}" (detector or recogniser)`);
    each[model] = [provider];
  }
  return each;
}
