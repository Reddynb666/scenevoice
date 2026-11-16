// Tests for lib/faces.mjs and lib/prepass.mjs: the arithmetic (decoding,
// suppression, alignment) on made-up numbers, and, when the models and the test
// film have been fetched, the two models on real frames. Run: npm test

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DETECTOR_SIZE, FACE_SIZE, FACE_TEMPLATE, cosine, createFaces, decodeYunet, defaultProviders, faceSize, fillDetectorInput,
  fillFaceInput, nms, similarityTransform, tileRegions,
} from '../lib/faces.mjs';
import { frameAt, probe } from '../lib/media.mjs';
import { cutsFromScores, embeddingFromBase64, embeddingToBase64, overlap, parseProviders, summary, watchStalls } from '../lib/prepass.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILM = join(ROOT, 'fixtures', 'tears_of_steel_720p.mov');
const fetched = existsSync(FILM) && existsSync(join(ROOT, 'models', 'manifest.json'));

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected} ± ${tolerance}`);
}

/** Empty YuNet outputs for a 640x640 input, with one cell switched on. */
function yunetOutputs(cells) {
  const outputs = {};
  for (const stride of [8, 16, 32]) {
    const count = (DETECTOR_SIZE / stride) ** 2;
    outputs[`cls_${stride}`] = { data: new Float32Array(count) };
    outputs[`obj_${stride}`] = { data: new Float32Array(count) };
    outputs[`bbox_${stride}`] = { data: new Float32Array(count * 4) };
    outputs[`kps_${stride}`] = { data: new Float32Array(count * 10) };
  }
  for (const { stride, row, col, cls, obj, bbox, kps } of cells) {
    const idx = row * (DETECTOR_SIZE / stride) + col;
    outputs[`cls_${stride}`].data[idx] = cls;
    outputs[`obj_${stride}`].data[idx] = obj;
    outputs[`bbox_${stride}`].data.set(bbox, idx * 4);
    outputs[`kps_${stride}`].data.set(kps, idx * 10);
  }
  return outputs;
}

test('YuNet decoding: score, centre, size and landmarks as OpenCV computes them', () => {
  const outputs = yunetOutputs([
    { stride: 16, row: 3, col: 5, cls: 0.81, obj: 1.4, bbox: [0.5, 0.25, Math.log(2), Math.log(3)], kps: [0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1] },
    { stride: 8, row: 1, col: 1, cls: 0.2, obj: 0.2, bbox: [0, 0, 0, 0], kps: new Array(10).fill(0) },
  ]);
  const faces = decodeYunet(outputs, 0.6);
  assert.equal(faces.length, 1, 'the weak cell is dropped');
  const [face] = faces;
  // obj is clamped to 1: sqrt(0.81 * 1) = 0.9.
  near(face.score, 0.9, 1e-6, 'score');
  // centre (5.5, 3.25) * 16 = (88, 52); size (2, 3) * 16 = (32, 48).
  const expected = [88 - 16, 52 - 24, 32, 48];
  face.box.forEach((value, i) => near(value, expected[i], 1e-4, `box[${i}]`));
  assert.deepEqual(face.landmarks.map(([x, y]) => [Math.round(x), Math.round(y)]), [[80, 48], [96, 48], [88, 56], [80, 64], [96, 64]]);
});

test('suppression keeps the best of overlapping boxes and everything apart', () => {
  const faces = [
    { box: [0, 0, 100, 100], score: 0.7 },
    { box: [10, 10, 100, 100], score: 0.9 },
    { box: [300, 300, 50, 50], score: 0.65 },
    { box: [90, 90, 100, 100], score: 0.8 },
  ];
  const kept = nms(faces, 0.3);
  assert.deepEqual(kept.map((face) => face.score), [0.9, 0.8, 0.65]);
  near(overlap([0, 0, 100, 100], [10, 10, 100, 100]), 8100 / 11900, 1e-9, 'intersection over union');
  assert.equal(overlap([0, 0, 10, 10], [20, 20, 10, 10]), 0);
});

test('the detector input: scaled from the top-left corner, BGR planes, zero padding', () => {
  // A 1280x640 picture: left half pure red, right half pure blue.
  const width = 1280;
  const height = 640;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgb[(y * width + x) * 3 + (x < width / 2 ? 0 : 2)] = 255;
  }
  const input = new Float32Array(3 * DETECTOR_SIZE * DETECTOR_SIZE).fill(7);
  const { sx, sy } = fillDetectorInput(input, rgb, width, { x: 0, y: 0, w: width, h: height });
  near(sx, 0.5, 1e-9, 'scale across');
  near(sy, 0.5, 1e-9, 'scale down');
  const plane = DETECTOR_SIZE * DETECTOR_SIZE;
  const at = (x, y) => [input[y * DETECTOR_SIZE + x], input[plane + y * DETECTOR_SIZE + x], input[2 * plane + y * DETECTOR_SIZE + x]];
  assert.deepEqual(at(100, 100), [0, 0, 255], 'red lands in the third plane (B, G, R)');
  assert.deepEqual(at(500, 100), [255, 0, 0], 'blue lands in the first plane');
  assert.deepEqual(at(100, 319), [0, 0, 255], 'last row of the picture');
  assert.deepEqual(at(100, 320), [0, 0, 0], 'below the picture is zero');
  // A picture smaller than the input is not enlarged in the whole-frame pass.
  const small = fillDetectorInput(input, rgb, width, { x: 0, y: 0, w: 320, h: 200 });
  assert.deepEqual([small.sx, small.sy], [1, 1]);
  assert.deepEqual(at(319, 199), [0, 0, 255]);
  assert.deepEqual(at(320, 199), [0, 0, 0]);
});

test('the similarity transform recovers a known turn, scale and shift', () => {
  const [a, b, tx, ty] = [1.5 * Math.cos(0.3), 1.5 * Math.sin(0.3), 40, -12];
  const from = [[10, 20], [60, 25], [35, 50], [15, 80], [55, 85]];
  const to = from.map(([x, y]) => [a * x - b * y + tx, b * x + a * y + ty]);
  const found = similarityTransform(from, to);
  [a, b, tx, ty].forEach((value, i) => near(found[i], value, 1e-9, `coefficient ${i}`));
  const same = similarityTransform(FACE_TEMPLATE, FACE_TEMPLATE);
  [1, 0, 0, 0].forEach((value, i) => near(same[i], value, 1e-9, `identity ${i}`));
  assert.throws(() => similarityTransform([[1, 1], [1, 1]], [[0, 0], [1, 1]]), RangeError);
});

test('alignment puts the landmarks on the template, in RGB planes', () => {
  // A face twice the template's size, turned a little and moved: a bright dot at each landmark.
  const width = 400;
  const height = 400;
  const [a, b, tx, ty] = [2 * Math.cos(0.2), 2 * Math.sin(0.2), 120, 60];
  const landmarks = FACE_TEMPLATE.map(([u, v]) => [a * u - b * v + tx, b * u + a * v + ty]);
  const rgb = new Uint8Array(width * height * 3);
  landmarks.forEach(([x, y], n) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) rgb[((Math.round(y) + dy) * width + Math.round(x) + dx) * 3 + (n % 3)] = 255;
    }
  });
  const input = new Float32Array(3 * FACE_SIZE * FACE_SIZE);
  fillFaceInput(input, rgb, width, height, landmarks);
  const plane = FACE_SIZE * FACE_SIZE;
  FACE_TEMPLATE.forEach(([u, v], n) => {
    const at = Math.round(v) * FACE_SIZE + Math.round(u);
    assert.ok(input[(n % 3) * plane + at] > 200, `landmark ${n} is bright in plane ${n % 3} at the template position`);
    assert.equal(input[((n + 1) % 3) * plane + at], 0, `and dark in the next plane`);
  });
  // Outside the picture is black, not an error.
  fillFaceInput(input, rgb, width, height, FACE_TEMPLATE.map(([u, v]) => [u - 300, v - 300]));
  assert.ok(input.every((value) => value === 0));
});

test('small helpers', () => {
  near(cosine([1, 0], [0, 1]), 0, 1e-12, 'right angle');
  near(cosine([3, 4], [6, 8]), 1, 1e-12, 'same direction');
  assert.equal(faceSize({ box: [0, 0, 38, 51] }), 38);
  const tiles = tileRegions(960, 400);
  assert.deepEqual(tiles, [{ x: 0, y: 0, w: 600, h: 250 }, { x: 360, y: 0, w: 600, h: 250 }, { x: 0, y: 150, w: 600, h: 250 }, { x: 360, y: 150, w: 600, h: 250 }]);
  assert.deepEqual(defaultProviders('darwin'), ['coreml', 'cpu']);
  assert.deepEqual(defaultProviders('win32'), ['dml', 'cpu']);
  assert.deepEqual(defaultProviders('linux'), ['cpu']);
  assert.deepEqual(parseProviders('cpu'), ['cpu']);
  assert.deepEqual(parseProviders('detector=coreml,recogniser=cpu'), { detector: ['coreml'], recogniser: ['cpu'] });
  assert.equal(parseProviders(undefined), undefined);
  assert.throws(() => parseProviders('faces=cpu'));
  const embedding = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i));
  assert.deepEqual(embeddingFromBase64(embeddingToBase64(embedding)), embedding);
  assert.deepEqual(summary([4, 1, 3, 2, 5]), { n: 5, mean: 3, min: 1, p10: 1, median: 3, p90: 5, p95: 5, max: 5 });
  assert.equal(summary([]).n, 0);
});

test('cuts from scene scores: the threshold, and one cut per flash', () => {
  const scores = [
    { t: 0, score: 0 }, { t: 1, score: 0.29 }, { t: 2, score: 0.3 }, { t: 2.04, score: 0.9 }, { t: 2.2, score: 0.5 },
    { t: 2.3, score: 0.6 }, { t: 5, score: 0.05 }, { t: 6, score: 1 },
  ];
  assert.deepEqual(cutsFromScores(scores).map((cut) => cut.t), [2, 2.3, 6]);
  assert.deepEqual(cutsFromScores(scores, { threshold: 0.8 }).map((cut) => cut.t), [2.04, 6]);
});

test('a machine that stops under the stopwatch is noticed', () => {
  let clock = 1_700_000_000_000;
  const watch = watchStalls({ everyMs: 250, limitMs: 2000, now: () => clock });
  clock += 250;
  watch.look(); // on time
  clock += 250 + 1000;
  watch.look(); // a second late: a busy machine, under the limit
  clock += 250 + 3_600_000;
  watch.look(); // an hour late: the lid was closed
  clock += 250;
  const seen = watch.stop();
  assert.equal(seen.longestGapMs, 3_600_000);
  assert.deepEqual(seen.gaps.map((gap) => gap.seconds), [3600]);
  assert.match(seen.gaps[0].from, /^\d{4}-\d\d-\d\dT/);

  // A stop that ends together with the work is seen by stop() itself.
  const late = watchStalls({ everyMs: 250, limitMs: 2000, now: () => clock });
  clock += 250 + 5000;
  assert.deepEqual(late.stop().gaps.map((gap) => gap.seconds), [5]);
  const calm = watchStalls({ everyMs: 250, limitMs: 2000, now: () => clock });
  clock += 100;
  assert.deepEqual(calm.stop(), { longestGapMs: 0, gaps: [] });
});

test('on the test film: three faces at 4:10, boxes on the faces, same person alike, different people not', { skip: fetched ? false : 'run fetch-fixture.mjs and fetch-models.mjs first' }, async () => {
  const faces = await createFaces();
  const info = await probe(FILM);
  // 4:10: three people in a row, looked at by eye when this test was written.
  const frame = await frameAt(FILM, 250, { width: 960, info });
  const found = (await faces.detect(frame.rgb, frame.width, frame.height)).sort((x, y) => x.box[0] - y.box[0]);
  assert.equal(found.length, 3);
  const centres = found.map((face) => [Math.round(face.box[0] + face.box[2] / 2), Math.round(face.box[1] + face.box[3] / 2)]);
  [[239, 161], [430, 164], [781, 250]].forEach(([x, y], i) => {
    near(centres[i][0], x, 15, `face ${i} centre x`);
    near(centres[i][1], y, 15, `face ${i} centre y`);
  });
  for (const face of found) {
    assert.ok(face.score > 0.8, `score ${face.score}`);
    const [right, left, nose] = face.landmarks;
    assert.ok(right[0] < left[0], 'the person\'s right eye is on the left of the picture');
    assert.ok(nose[1] > Math.min(right[1], left[1]), 'the nose is below the eyes');
  }
  const now = await Promise.all(found.map(async (face) => Array.from(await faces.embed(frame.rgb, frame.width, frame.height, face))));
  near(Math.hypot(...now[0]), 1, 1e-4, 'embeddings have unit length');
  assert.equal(now[0].length, 128);

  // Half a second later, same shot: each person against themselves and against the others.
  const next = await frameAt(FILM, 250.5, { width: 960, info });
  const again = (await faces.detect(next.rgb, next.width, next.height)).sort((x, y) => x.box[0] - y.box[0]);
  assert.equal(again.length, 3);
  const later = await Promise.all(again.map(async (face) => Array.from(await faces.embed(next.rgb, next.width, next.height, face))));
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const value = cosine(now[i], later[j]);
      if (i === j) assert.ok(value > 0.5, `same person ${i}: cosine ${value}`);
      else assert.ok(value < 0.363, `different people ${i} and ${j}: cosine ${value}`);
    }
  }

  // Tiles find at least what the whole frame finds.
  const tiled = await faces.detect(frame.rgb, frame.width, frame.height, { tiles: true });
  assert.ok(tiled.length >= 3);
});
