#!/usr/bin/env node
// A sanity check of the detector and the recogniser on a real film, with no
// labels needed:
//
//   same person       a face and the face overlapping it in the next sampled
//                     frame of the same shot (no cut in between);
//   different people  two faces in one frame.
//
// Prints the cosine similarities of both groups, and writes pictures for a
// person to look at: frames with the boxes and landmarks drawn, and the aligned
// 112x112 crops of the least alike "same" pairs and the most alike "different"
// pairs, which is where a mistake in the alignment or in the pairing would show.
//
// Usage: node check-faces.mjs <file> [--fps 2] [--width 960] [--start s] [--limit s]
//          [--tiles] [--ep cpu | --ep detector=coreml,recogniser=cpu] [--out dir]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { clock, drawFaces, drawText, paste } from './lib/draw.mjs';
import { FACE_SIZE, SFACE_SAME_PERSON_COSINE, alignedFaceRgb, cosine, createFaces } from './lib/faces.mjs';
import { probe, sceneScores, writeJpeg } from './lib/media.mjs';
import { MIN_FACE_PIXELS, cutsFromScores, facePass, outputName, overlap, parseProviders, summary } from './lib/prepass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fps: { type: 'string', default: '2' },
    width: { type: 'string', default: '960' },
    start: { type: 'string' },
    limit: { type: 'string' },
    tiles: { type: 'boolean', default: false },
    ep: { type: 'string' },
    out: { type: 'string' },
    frames: { type: 'string', default: '12' },
  },
});

/** Rows of [crop A | crop B | cosine in hundredths, time A, time B]. */
function pairSheet(pairs) {
  const rowHeight = FACE_SIZE + 4;
  const width = FACE_SIZE * 2 + 4 + 110;
  const height = Math.max(1, pairs.length) * rowHeight;
  const sheet = new Uint8Array(width * height * 3).fill(32);
  pairs.forEach((pair, row) => {
    const y = row * rowHeight;
    paste(sheet, width, height, pair.a.crop, FACE_SIZE, FACE_SIZE, 0, y);
    paste(sheet, width, height, pair.b.crop, FACE_SIZE, FACE_SIZE, FACE_SIZE + 4, y);
    const x = FACE_SIZE * 2 + 10;
    drawText(sheet, width, height, (pair.cosine < 0 ? '-' : '') + String(Math.round(Math.abs(pair.cosine) * 100)), x, y + 8, { scale: 3 });
    drawText(sheet, width, height, clock(pair.a.t), x, y + 44, { scale: 2 });
    drawText(sheet, width, height, clock(pair.b.t), x, y + 68, { scale: 2 });
  });
  return { rgb: sheet, width, height };
}

function describe(pair) {
  const box = (face) => face.box.map((value) => Math.round(value));
  return { cosine: Math.round(pair.cosine * 1000) / 1000, a: { t: pair.a.t, box: box(pair.a) }, b: { t: pair.b.t, box: box(pair.b) } };
}

async function main() {
  const file = positionals[0];
  if (!file) throw new Error('usage: node check-faces.mjs <file> [--fps 2] [--width 960] [--start s] [--limit s] [--tiles] [--ep cpu] [--out dir]');
  const fps = Number(options.fps);
  const info = await probe(file);
  const start = options.start === undefined ? undefined : Number(options.start);
  const end = options.limit === undefined ? undefined : (start ?? info.startTime) + Number(options.limit);
  const out = resolve(options.out || join(HERE, 'out', outputName(file), 'check'));
  await mkdir(out, { recursive: true });

  const faces = await createFaces({ providers: parseProviders(options.ep) });
  console.log(`providers: detector ${faces.providers.detector}, recogniser ${faces.providers.recogniser}`);

  const cuts = cutsFromScores(await sceneScores(file, { info, start, end }));
  const wantedFrames = Number(options.frames);
  const span = (end ?? info.endTime) - (start ?? info.startTime);
  let nextPicture = start ?? info.startTime;
  const pictures = [];

  const pass = await facePass(file, {
    faces,
    info,
    fps,
    width: Number(options.width),
    start,
    end,
    tiles: options.tiles,
    async onFrame(frame, found) {
      for (const face of found) {
        face.t = frame.t;
        if (face.embedding) face.crop = alignedFaceRgb(frame.rgb, frame.width, frame.height, face.landmarks);
      }
      // A spread of frames that have faces, with everything the detector said drawn on them.
      if (found.length && frame.t >= nextPicture && pictures.length < wantedFrames) {
        nextPicture = frame.t + span / wantedFrames;
        const copy = drawFaces(frame.rgb.slice(), frame.width, frame.height, found);
        drawText(copy, frame.width, frame.height, clock(frame.t), 4, frame.height - 22, { scale: 2 });
        const name = `frame-${String(Math.round(frame.t * 10)).padStart(5, '0')}.jpg`;
        await writeJpeg(join(out, name), copy, frame.width, frame.height, { quality: 88 });
        pictures.push({ file: name, t: frame.t, faces: found.length });
      }
    },
  });

  const same = [];
  const different = [];
  const cutBetween = (from, to) => cuts.some((cut) => cut.t > from + 1e-6 && cut.t <= to + 1e-6);
  for (let i = 0; i < pass.frames.length; i += 1) {
    const now = pass.frames[i].faces.filter((face) => face.embedding);
    for (let a = 0; a < now.length; a += 1) {
      for (let b = a + 1; b < now.length; b += 1) different.push({ a: now[a], b: now[b], cosine: cosine(now[a].embedding, now[b].embedding) });
    }
    if (i === 0) continue;
    const before = pass.frames[i - 1];
    if (pass.frames[i].t - before.t > 1.5 / fps || cutBetween(before.t, pass.frames[i].t)) continue;
    const earlier = before.faces.filter((face) => face.embedding);
    for (const face of now) {
      const matches = earlier.filter((other) => overlap(face.box, other.box) >= 0.5);
      if (matches.length !== 1) continue;
      // The match must be mutual: the earlier face overlaps only this one.
      if (now.filter((other) => overlap(other.box, matches[0].box) >= 0.5).length !== 1) continue;
      same.push({ a: matches[0], b: face, cosine: cosine(matches[0].embedding, face.embedding) });
    }
  }

  same.sort((x, y) => x.cosine - y.cosine);
  different.sort((x, y) => y.cosine - x.cosine);
  const share = (list, test) => (list.length ? Math.round((list.filter(test).length / list.length) * 1000) / 1000 : null);
  const middle = (list, count) => list.slice(Math.max(0, Math.floor(list.length / 2) - Math.floor(count / 2))).slice(0, count);
  const sheets = [
    ['same-least-alike.jpg', same.slice(0, 12)],
    ['same-typical.jpg', middle(same, 8)],
    ['different-most-alike.jpg', different.slice(0, 12)],
    ['different-typical.jpg', middle(different, 8)],
  ];
  for (const [name, pairs] of sheets) {
    if (!pairs.length) continue;
    const sheet = pairSheet(pairs);
    await writeJpeg(join(out, name), sheet.rgb, sheet.width, sheet.height, { quality: 92 });
  }

  const report = {
    file,
    sampled: { fps, width: pass.width, height: pass.height, from: start ?? info.startTime, to: end ?? info.endTime, tiles: options.tiles },
    providers: faces.providers,
    models: { detector: faces.models.detector.file, recogniser: faces.models.recogniser.file },
    counts: pass.counts,
    cuts: cuts.length,
    minFacePixels: MIN_FACE_PIXELS,
    samePerson: {
      how: `a face and the one overlapping it (IoU >= 0.5, mutual, one of each) in the next sampled frame, ${1 / fps} s later, with no cut between`,
      cosine: summary(same.map((pair) => pair.cosine)),
      shareAbove05: share(same, (pair) => pair.cosine > 0.5),
      shareAboveOpenCvThreshold: share(same, (pair) => pair.cosine >= SFACE_SAME_PERSON_COSINE),
      leastAlike: same.slice(0, 12).map(describe),
    },
    differentPeople: {
      how: 'two faces in the same frame',
      cosine: summary(different.map((pair) => pair.cosine)),
      shareBelowOpenCvThreshold: share(different, (pair) => pair.cosine < SFACE_SAME_PERSON_COSINE),
      shareAbove05: share(different, (pair) => pair.cosine > 0.5),
      mostAlike: different.slice(0, 12).map(describe),
    },
    openCvSamePersonCosine: SFACE_SAME_PERSON_COSINE,
    pictures,
  };
  await writeFile(join(out, 'check.json'), `${JSON.stringify(report, null, 2)}\n`);

  const line = (label, s) => `${label}: n=${s.n} min=${s.min} p10=${s.p10} median=${s.median} mean=${s.mean} p90=${s.p90} max=${s.max}`;
  console.log(`frames ${pass.counts.framesSampled}, faces found ${pass.counts.facesFound}, embedded (>= ${MIN_FACE_PIXELS} px) ${pass.counts.facesEmbedded}, cuts ${cuts.length}`);
  console.log(line('same person, next frame   cosine', report.samePerson.cosine));
  console.log(`  above 0.5: ${report.samePerson.shareAbove05}, at or above ${SFACE_SAME_PERSON_COSINE}: ${report.samePerson.shareAboveOpenCvThreshold}`);
  console.log(line('different people, 1 frame cosine', report.differentPeople.cosine));
  console.log(`  below ${SFACE_SAME_PERSON_COSINE}: ${report.differentPeople.shareBelowOpenCvThreshold}, above 0.5: ${report.differentPeople.shareAbove05}`);
  console.log(`pictures and check.json in ${out}`);
}

main().catch((error) => {
  console.error(`check-faces failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
