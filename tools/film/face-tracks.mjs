#!/usr/bin/env node
// Runs the face pass over a film and saves what later steps (clustering, the
// K2 labelling) start from, in out/<name>/ (git-ignored):
//
//   detections.json  per sampled frame: t, and for each face its box, score,
//                    landmarks and embedding (base64 of 128 float32, or null
//                    when the face is under 40 pixels)
//   shots.json       cut times from ffmpeg's scene scores, with the threshold
//   sheets/          one contact sheet per minute: every sampled frame with the
//                    boxes drawn, so a person can check the detector by eye.
//                    Green: embedded. Yellow: found but too small to embed.
//
// Face data of a film stays on this machine: out/ is never committed.
//
// Usage: node face-tracks.mjs <file> [--fps 2] [--width 960] [--limit seconds]
//          [--ep cpu | --ep detector=coreml,recogniser=cpu] [--tiles] [--out dir] [--no-sheets]

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { sha256File } from './lib/download.mjs';
import { GREEN, YELLOW, clock, drawBox, drawText, paste, shrink } from './lib/draw.mjs';
import { createFaces } from './lib/faces.mjs';
import { probe, sceneScores, writeJpeg } from './lib/media.mjs';
import { CUT_MIN_GAP_SECONDS, CUT_THRESHOLD, MIN_FACE_PIXELS, cutsFromScores, embeddingToBase64, facePass, outputName, parseProviders } from './lib/prepass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Contact sheets: thumbnails this wide, this many across. */
const THUMB_WIDTH = 480;
const SHEET_COLUMNS = 8;
const SHEET_GAP = 2;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fps: { type: 'string', default: '2' },
    width: { type: 'string', default: '960' },
    limit: { type: 'string' },
    ep: { type: 'string' },
    tiles: { type: 'boolean', default: false },
    out: { type: 'string' },
    'no-sheets': { type: 'boolean', default: false },
  },
});

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Builds one sheet per minute of film and writes each as soon as its minute is over. */
function contactSheets(dir, { fps, origin }) {
  const perMinute = Math.round(60 * fps);
  const rows = Math.ceil(perMinute / SHEET_COLUMNS);
  let sheet = null;
  let minute = -1;
  let thumbHeight = 0;
  const written = [];

  async function flush() {
    if (!sheet) return;
    const name = `sheet-${String(minute).padStart(3, '0')}.jpg`;
    const saved = await writeJpeg(join(dir, name), sheet.rgb, sheet.width, sheet.height, { quality: 82 });
    written.push({ file: `sheets/${name}`, minute, from: origin + minute * 60, frames: sheet.count, faces: sheet.faces, bytes: saved.bytes });
    sheet = null;
  }

  async function add(frame, faces) {
    const scale = THUMB_WIDTH / frame.width;
    thumbHeight = Math.round(frame.height * scale);
    const at = Math.floor((frame.t - origin + 1e-6) / 60);
    if (at !== minute) {
      await flush();
      minute = at;
      const width = SHEET_COLUMNS * (THUMB_WIDTH + SHEET_GAP) - SHEET_GAP;
      const height = rows * (thumbHeight + SHEET_GAP) - SHEET_GAP;
      sheet = { rgb: new Uint8Array(width * height * 3).fill(24), width, height, count: 0, faces: 0 };
    }
    const thumb = shrink(frame.rgb, frame.width, frame.height, THUMB_WIDTH, thumbHeight);
    for (const face of faces) {
      const box = face.box.map((value) => value * scale);
      // One pixel of margin so the line sits around the face, not on it.
      drawBox(thumb, THUMB_WIDTH, thumbHeight, [box[0] - 1, box[1] - 1, box[2] + 2, box[3] + 2], face.embedding ? GREEN : YELLOW, 1);
    }
    drawText(thumb, THUMB_WIDTH, thumbHeight, clock(frame.t), 0, 0, { scale: 2 });
    const slot = Math.min(perMinute - 1, Math.round((frame.t - origin - minute * 60) * fps));
    const x = (slot % SHEET_COLUMNS) * (THUMB_WIDTH + SHEET_GAP);
    const y = Math.floor(slot / SHEET_COLUMNS) * (thumbHeight + SHEET_GAP);
    paste(sheet.rgb, sheet.width, sheet.height, thumb, THUMB_WIDTH, thumbHeight, x, y);
    sheet.count += 1;
    sheet.faces += faces.length;
  }

  return { add, flush, written };
}

async function main() {
  const file = positionals[0];
  if (!file) throw new Error('usage: node face-tracks.mjs <file> [--fps 2] [--width 960] [--limit seconds] [--ep cpu] [--tiles] [--out dir] [--no-sheets]');
  const fps = Number(options.fps);
  const info = await probe(file);
  if (!info.video) throw new Error(`${file} has no video stream`);
  const end = options.limit === undefined ? undefined : info.startTime + Number(options.limit);
  const out = resolve(options.out || join(HERE, 'out', outputName(file)));
  await mkdir(join(out, 'sheets'), { recursive: true });

  const faces = await createFaces({ providers: parseProviders(options.ep) });
  const sheets = options['no-sheets'] ? null : contactSheets(join(out, 'sheets'), { fps, origin: info.video.startTime });
  const started = performance.now();
  const pass = await facePass(file, {
    faces,
    info,
    fps,
    width: Number(options.width),
    end,
    tiles: options.tiles,
    onFrame: sheets ? (frame, found) => sheets.add(frame, found) : undefined,
  });
  if (sheets) await sheets.flush();

  const scores = await sceneScores(file, { info, end });
  const cuts = cutsFromScores(scores);
  const last = end ?? info.endTime;
  const starts = [info.video.startTime, ...cuts.map((cut) => cut.t).filter((t) => t > info.video.startTime)];
  const shots = starts.map((start, index) => ({ start: round(start, 3), end: round(index + 1 < starts.length ? starts[index + 1] : last, 3) }));
  const atThreshold = (threshold) => cutsFromScores(scores, { threshold }).length;

  const sha256 = await sha256File(file);
  const common = { file: basename(file), sha256, time: 'seconds in the file\'s own timestamps (container time); the file starts at ' + info.startTime };
  const detections = {
    ...common,
    sampled: { fps, width: pass.width, height: pass.height, from: info.video.startTime, to: last, tiles: options.tiles },
    models: { detector: faces.models.detector.file, recogniser: faces.models.recogniser.file },
    providers: faces.providers,
    box: '[x, y, width, height] in pixels of the sampled frame',
    landmarks: 'right eye, left eye, nose tip, right mouth corner, left mouth corner (the person\'s right and left), [x, y] each',
    embedding: `base64 of 128 little-endian float32 at unit length; null when the shorter side of the box is under ${MIN_FACE_PIXELS} px`,
    counts: pass.counts,
    frames: pass.frames.map((record) => ({
      t: round(record.t, 3),
      faces: record.faces.map((face) => ({
        box: face.box.map((value) => round(value, 1)),
        score: round(face.score, 3),
        landmarks: face.landmarks.map(([x, y]) => [round(x, 1), round(y, 1)]),
        embedding: face.embedding ? embeddingToBase64(face.embedding) : null,
      })),
    })),
  };
  await writeFile(join(out, 'detections.json'), `${JSON.stringify(detections)}\n`);

  const shotList = {
    ...common,
    how: `ffmpeg's scene score (select filter, 0 to 1) of every picture against the one before it, on a 320-pixel-wide copy; a picture scoring ${CUT_THRESHOLD} or more starts a shot, unless a cut was taken less than ${CUT_MIN_GAP_SECONDS} s before it`,
    threshold: CUT_THRESHOLD,
    minGapSeconds: CUT_MIN_GAP_SECONDS,
    checked: 'not compared with a hand-marked list of cuts; slow dissolves and fades score low and are missed',
    picturesScored: scores.length,
    cutsAtOtherThresholds: { 0.1: atThreshold(0.1), 0.2: atThreshold(0.2), 0.3: atThreshold(0.3), 0.4: atThreshold(0.4), 0.5: atThreshold(0.5) },
    cuts: cuts.map((cut) => ({ t: round(cut.t, 3), score: round(cut.score, 3) })),
    shots,
  };
  await writeFile(join(out, 'shots.json'), `${JSON.stringify(shotList, null, 1)}\n`);

  const sizes = pass.frames.flatMap((record) => record.faces.map((face) => Math.min(face.box[2], face.box[3]))).sort((a, b) => a - b);
  const pick = (q) => (sizes.length ? round(sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))], 1) : null);
  console.log(`${pass.counts.framesSampled} frames at ${fps} fps (${pass.width}x${pass.height}), ${pass.counts.framesWithFaces} with faces`);
  console.log(`${pass.counts.facesFound} faces found, ${pass.counts.facesEmbedded} embedded (>= ${MIN_FACE_PIXELS} px); shorter side: smallest ${pick(0)}, median ${pick(0.5)}, largest ${pick(1)} px`);
  console.log(`${cuts.length} cuts at ${CUT_THRESHOLD} -> ${shots.length} shots`);
  console.log(`providers: detector ${faces.providers.detector}, recogniser ${faces.providers.recogniser}; ${round((performance.now() - started) / 1000, 1)} s in all`);
  console.log(`wrote ${join(out, 'detections.json')}, shots.json${sheets ? ` and ${sheets.written.length} contact sheets in sheets/` : ''}`);
}

main().catch((error) => {
  console.error(`face-tracks failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
