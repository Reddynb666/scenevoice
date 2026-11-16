// Face detection (YuNet) and face embeddings (SFace) on onnxruntime-node, for
// raw RGB frames. Pre- and post-processing follow OpenCV's own code for these
// two models (modules/objdetect/src/face_detect.cpp and face_recognize.cpp,
// which the model zoo's yunet.py and sface.py call):
//
//   YuNet 2023mar  input "input", 1x3x640x640 float32, BGR, 0..255, no mean or
//                  scale. This ONNX file has a fixed input size (OpenCV reshapes
//                  it, onnxruntime does not), so the picture is scaled to fit
//                  640x640 from the top-left corner and the rest stays zero, as
//                  OpenCV pads. Outputs cls/obj/bbox/kps for strides 8, 16, 32;
//                  score = sqrt(cls * obj), centre = (cell + offset) * stride,
//                  size = exp(value) * stride, landmark = (cell + value) * stride.
//   SFace 2021dec  input "data", 1x3x112x112 float32, RGB, 0..255. The face is
//                  warped onto the 112x112 ArcFace template by the similarity
//                  transform of its five landmarks, sampled bilinearly, outside
//                  the picture black. Output "fc1", 128 numbers.
//
// Landmarks come in the order right eye, left eye, nose tip, right mouth corner,
// left mouth corner, named from the person's side: the first eye is the one on
// the left of the picture.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ort from 'onnxruntime-node';

import { sha256File } from './download.mjs';

const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');

/** Side of YuNet's fixed square input. */
export const DETECTOR_SIZE = 640;
const STRIDES = [8, 16, 32];
/** As OpenCV: keep at most this many candidates before suppression. */
const TOP_K = 5000;
/** Side of SFace's input. */
export const FACE_SIZE = 112;
/** Where the five landmarks sit in SFace's 112x112 input (the ArcFace template). */
export const FACE_TEMPLATE = Object.freeze([
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]);
/** The cosine similarity above which OpenCV's SFace demo calls two faces the same person. */
export const SFACE_SAME_PERSON_COSINE = 0.363;

/** Execution providers to try, in order, on this platform. */
export function defaultProviders(platform = process.platform) {
  if (platform === 'darwin') return ['coreml', 'cpu'];
  if (platform === 'win32') return ['dml', 'cpu'];
  return ['cpu'];
}

async function openSession(path, providers, inputShape) {
  const tried = [];
  for (const provider of providers) {
    try {
      const started = performance.now();
      // Severity 3: errors only (the SFace file makes onnxruntime print hundreds of harmless warnings).
      const session = await ort.InferenceSession.create(path, { executionProviders: [provider], logSeverityLevel: 3 });
      // A provider can accept the model and still fail on the first run: run once before trusting it.
      const size = inputShape.reduce((a, b) => a * b, 1);
      await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(size), inputShape) });
      tried.push({ provider, ok: true, loadMs: Math.round(performance.now() - started) });
      return { session, provider, tried };
    } catch (error) {
      tried.push({ provider, ok: false, error: String(error.message || error).split('\n')[0] });
    }
  }
  throw new Error(`no execution provider could load ${path}: ${tried.map((t) => `${t.provider}: ${t.error}`).join('; ')}`);
}

/**
 * Greedy non-maximum suppression: the best-scoring box stays, every box that
 * overlaps a kept one by more than `threshold` (intersection over union) goes.
 * @param {{ box: number[], score: number }[]} faces
 */
export function nms(faces, threshold, topK = TOP_K) {
  const sorted = [...faces].sort((a, b) => b.score - a.score).slice(0, topK);
  const kept = [];
  for (const face of sorted) {
    const [x, y, w, h] = face.box;
    let keep = true;
    for (const other of kept) {
      const [ox, oy, ow, oh] = other.box;
      const iw = Math.min(x + w, ox + ow) - Math.max(x, ox);
      const ih = Math.min(y + h, oy + oh) - Math.max(y, oy);
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      if (inter / (w * h + ow * oh - inter) > threshold) {
        keep = false;
        break;
      }
    }
    if (keep) kept.push(face);
  }
  return kept;
}

/**
 * Decode YuNet's raw outputs into faces, in the coordinates of its 640x640 input.
 * @param {Record<string, { data: Float32Array }>} outputs
 * @returns {{ box: number[], score: number, landmarks: number[][] }[]}
 */
export function decodeYunet(outputs, scoreThreshold, size = DETECTOR_SIZE) {
  const faces = [];
  for (const stride of STRIDES) {
    const cols = size / stride;
    const rows = size / stride;
    const cls = outputs[`cls_${stride}`].data;
    const obj = outputs[`obj_${stride}`].data;
    const bbox = outputs[`bbox_${stride}`].data;
    const kps = outputs[`kps_${stride}`].data;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c;
        const clsScore = Math.min(1, Math.max(0, cls[idx]));
        const objScore = Math.min(1, Math.max(0, obj[idx]));
        const score = Math.sqrt(clsScore * objScore);
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[idx * 4]) * stride;
        const cy = (r + bbox[idx * 4 + 1]) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]) * stride;
        const landmarks = [];
        for (let n = 0; n < 5; n += 1) {
          landmarks.push([(kps[idx * 10 + 2 * n] + c) * stride, (kps[idx * 10 + 2 * n + 1] + r) * stride]);
        }
        faces.push({ box: [cx - w / 2, cy - h / 2, w, h], score, landmarks });
      }
    }
  }
  return faces;
}

/** Average k x k blocks of a region: the first step of shrinking by more than two. */
function shrinkBlocks(rgb, width, region, k) {
  const outW = Math.floor(region.w / k);
  const outH = Math.floor(region.h / k);
  const out = new Uint8Array(outW * outH * 3);
  const area = k * k;
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < k; dy += 1) {
        let at = ((region.y + y * k + dy) * width + region.x + x * k) * 3;
        for (let dx = 0; dx < k; dx += 1) {
          r += rgb[at];
          g += rgb[at + 1];
          b += rgb[at + 2];
          at += 3;
        }
      }
      const to = (y * outW + x) * 3;
      out[to] = r / area;
      out[to + 1] = g / area;
      out[to + 2] = b / area;
    }
  }
  return { rgb: out, width: outW, height: outH };
}

/**
 * Fill YuNet's input with one region of a frame: scaled to fit from the top-left
 * corner, BGR planes, 0..255, zero elsewhere. Returns the scales used
 * (input pixels per frame pixel, across and down).
 */
export function fillDetectorInput(input, rgb, width, region, maxScale = 1) {
  const size = DETECTOR_SIZE;
  const plane = size * size;
  input.fill(0);
  const scale = Math.min(maxScale, size / region.w, size / region.h);
  // Shrinking by more than two: average whole blocks first, so no pixel is skipped.
  let src = { rgb, width, x: region.x, y: region.y, w: region.w, h: region.h };
  const k = Math.floor(1 / scale);
  if (k >= 2) {
    const small = shrinkBlocks(rgb, width, region, k);
    src = { rgb: small.rgb, width: small.width, x: 0, y: 0, w: small.width, h: small.height };
  }
  const outW = Math.min(size, Math.round(region.w * scale));
  const outH = Math.min(size, Math.round(region.h * scale));
  const stepX = src.w / outW;
  const stepY = src.h / outH;
  const xs = new Int32Array(outW);
  const fx = new Float32Array(outW);
  for (let x = 0; x < outW; x += 1) {
    const sx = Math.min(src.w - 1, Math.max(0, (x + 0.5) * stepX - 0.5));
    xs[x] = Math.max(0, Math.min(src.w - 2, Math.floor(sx)));
    fx[x] = sx - xs[x];
  }
  const data = src.rgb;
  const rowBytes = src.width * 3;
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.min(src.h - 1, Math.max(0, (y + 0.5) * stepY - 0.5));
    const y0 = Math.max(0, Math.min(src.h - 2, Math.floor(sy)));
    const fy = sy - y0;
    const top = (src.y + y0) * rowBytes + src.x * 3;
    const bottom = top + rowBytes;
    let to = y * size;
    for (let x = 0; x < outW; x += 1) {
      const a = top + xs[x] * 3;
      const b = bottom + xs[x] * 3;
      const wx = fx[x];
      const w00 = (1 - wx) * (1 - fy);
      const w01 = wx * (1 - fy);
      const w10 = (1 - wx) * fy;
      const w11 = wx * fy;
      // Planes in BGR order: the frame is RGB.
      input[to + 2 * plane] = data[a] * w00 + data[a + 3] * w01 + data[b] * w10 + data[b + 3] * w11;
      input[to + plane] = data[a + 1] * w00 + data[a + 4] * w01 + data[b + 1] * w10 + data[b + 4] * w11;
      input[to] = data[a + 2] * w00 + data[a + 5] * w01 + data[b + 2] * w10 + data[b + 5] * w11;
      to += 1;
    }
  }
  return { sx: outW / region.w, sy: outH / region.h };
}

/**
 * The similarity transform (rotation, one scale, shift; no mirror) that best
 * moves `from` onto `to` in the least-squares sense: [a, b, tx, ty] with
 * u = a x - b y + tx and v = b x + a y + ty. Same result as the Umeyama
 * solution in OpenCV's FaceRecognizerSF for any face that is not mirrored.
 */
export function similarityTransform(from, to) {
  const n = from.length;
  let mx = 0;
  let my = 0;
  let mu = 0;
  let mv = 0;
  for (let i = 0; i < n; i += 1) {
    mx += from[i][0] / n;
    my += from[i][1] / n;
    mu += to[i][0] / n;
    mv += to[i][1] / n;
  }
  let dot = 0;
  let cross = 0;
  let spread = 0;
  for (let i = 0; i < n; i += 1) {
    const x = from[i][0] - mx;
    const y = from[i][1] - my;
    const u = to[i][0] - mu;
    const v = to[i][1] - mv;
    dot += x * u + y * v;
    cross += x * v - y * u;
    spread += x * x + y * y;
  }
  if (!(spread > 0)) throw new RangeError('similarityTransform: the points are all in one place');
  const a = dot / spread;
  const b = cross / spread;
  return [a, b, mu - (a * mx - b * my), mv - (b * mx + a * my)];
}

/**
 * Warp a face onto SFace's 112x112 template and write it into `input` as RGB
 * planes, 0..255. Bilinear sampling; outside the frame is black.
 */
export function fillFaceInput(input, rgb, width, height, landmarks) {
  const [a, b, tx, ty] = similarityTransform(landmarks, FACE_TEMPLATE);
  const det = a * a + b * b;
  const plane = FACE_SIZE * FACE_SIZE;
  for (let v = 0; v < FACE_SIZE; v += 1) {
    for (let u = 0; u < FACE_SIZE; u += 1) {
      // Inverse of the transform: where in the frame this template pixel comes from.
      const du = u - tx;
      const dv = v - ty;
      const x = (a * du + b * dv) / det;
      const y = (-b * du + a * dv) / det;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let j = 0; j < 2; j += 1) {
        const yy = y0 + j;
        if (yy < 0 || yy >= height) continue;
        const wy = j ? fy : 1 - fy;
        for (let i = 0; i < 2; i += 1) {
          const xx = x0 + i;
          if (xx < 0 || xx >= width) continue;
          const w = wy * (i ? fx : 1 - fx);
          const at = (yy * width + xx) * 3;
          r += rgb[at] * w;
          g += rgb[at + 1] * w;
          bl += rgb[at + 2] * w;
        }
      }
      const to = v * FACE_SIZE + u;
      input[to] = r;
      input[to + plane] = g;
      input[to + 2 * plane] = bl;
    }
  }
}

/** The aligned 112x112 face as RGB bytes, for looking at what the recogniser sees. */
export function alignedFaceRgb(rgb, width, height, landmarks) {
  const input = new Float32Array(3 * FACE_SIZE * FACE_SIZE);
  fillFaceInput(input, rgb, width, height, landmarks);
  const plane = FACE_SIZE * FACE_SIZE;
  const out = new Uint8Array(plane * 3);
  for (let i = 0; i < plane; i += 1) {
    out[i * 3] = input[i];
    out[i * 3 + 1] = input[i + plane];
    out[i * 3 + 2] = input[i + 2 * plane];
  }
  return out;
}

/** Cosine similarity of two embeddings. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/** The shorter side of a face box, the size the 40-pixel rule looks at. */
export function faceSize(face) {
  return Math.min(face.box[2], face.box[3]);
}

/** Four overlapping regions, each 5/8 of the frame in both directions. */
export function tileRegions(width, height) {
  const w = Math.ceil(width * 0.625);
  const h = Math.ceil(height * 0.625);
  return [
    { x: 0, y: 0, w, h },
    { x: width - w, y: 0, w, h },
    { x: 0, y: height - h, w, h },
    { x: width - w, y: height - h, w, h },
  ];
}

/**
 * Load both models. `providers` is a list to try in order, or one list per
 * model: { detector: [...], recogniser: [...] }.
 *
 * @param {{ dir?: string, providers?: string[] | { detector?: string[], recogniser?: string[] }, verify?: boolean }} [options]
 */
export async function createFaces({ dir = MODEL_DIR, providers, verify = true } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`no models/manifest.json in ${dir}: run "node fetch-models.mjs" first`);
  }
  const entry = (id) => {
    const found = manifest.find((item) => item.id === id);
    if (!found) throw new Error(`models/manifest.json has no entry "${id}"`);
    return found;
  };
  const yunet = entry('yunet');
  const sface = entry('sface');
  if (verify) {
    // Only files the manifest lists, and only if they are the bytes it lists.
    for (const model of [yunet, sface]) {
      const sum = await sha256File(join(dir, model.file));
      if (sum !== model.sha256) throw new Error(`${model.file} does not match the SHA-256 in models/manifest.json`);
    }
  }
  const wanted = Array.isArray(providers) ? { detector: providers, recogniser: providers } : providers || {};
  const detector = await openSession(join(dir, yunet.file), wanted.detector || defaultProviders(), [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]);
  const recogniser = await openSession(join(dir, sface.file), wanted.recogniser || defaultProviders(), [1, 3, FACE_SIZE, FACE_SIZE]);

  const detectorInput = new Float32Array(3 * DETECTOR_SIZE * DETECTOR_SIZE);
  const faceInput = new Float32Array(3 * FACE_SIZE * FACE_SIZE);
  const detectorName = detector.session.inputNames[0];
  const faceName = recogniser.session.inputNames[0];
  const faceOutput = recogniser.session.outputNames[0];

  // Both models share one input buffer each, so calls run one after another
  // even when a caller starts several at once.
  let queue = Promise.resolve();
  const inTurn = (work) => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };

  /** One run of the detector over a region; faces come back in frame coordinates. */
  async function detectRegion(rgb, width, region, scoreThreshold, maxScale) {
    const { sx, sy } = fillDetectorInput(detectorInput, rgb, width, region, maxScale);
    const outputs = await detector.session.run({ [detectorName]: new ort.Tensor('float32', detectorInput, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]) });
    const faces = decodeYunet(outputs, scoreThreshold);
    // Input pixel centres back to frame pixel centres.
    const across = (value) => region.x + (value + 0.5) / sx - 0.5;
    const down = (value) => region.y + (value + 0.5) / sy - 0.5;
    for (const face of faces) {
      const [x, y, w, h] = face.box;
      face.box = [across(x), down(y), w / sx, h / sy];
      face.landmarks = face.landmarks.map(([px, py]) => [across(px), down(py)]);
    }
    return faces;
  }

  /**
   * Faces in a frame.
   *
   * @param {Uint8Array} rgb
   * @param {number} width
   * @param {number} height
   * @param {{ scoreThreshold?: number, nmsThreshold?: number, tiles?: boolean }} [options]
   *   `tiles`: also look at four overlapping quarters at a larger scale, for small faces.
   * @returns {Promise<{ box: [number, number, number, number], score: number, landmarks: number[][] }[]>}
   */
  function detect(rgb, width, height, options) {
    return inTurn(() => detectNow(rgb, width, height, options));
  }

  async function detectNow(rgb, width, height, { scoreThreshold = 0.6, nmsThreshold = 0.3, tiles = false } = {}) {
    if (rgb.length !== width * height * 3) throw new RangeError(`detect: ${rgb.length} bytes is not ${width}x${height} RGB`);
    const found = await detectRegion(rgb, width, { x: 0, y: 0, w: width, h: height }, scoreThreshold, 1);
    if (tiles) {
      for (const region of tileRegions(width, height)) {
        const inTile = await detectRegion(rgb, width, region, scoreThreshold, 2);
        for (const face of inTile) {
          const [x, y, w, h] = face.box;
          // A face cut by an inner tile edge is half a face: the next tile or the
          // whole-frame pass has all of it. Its box stops a little short of the
          // edge, so the margin grows with the box.
          const mx = Math.max(4, w * 0.08);
          const my = Math.max(4, h * 0.08);
          const cut = (region.x > 0 && x < region.x + mx)
            || (region.y > 0 && y < region.y + my)
            || (region.x + region.w < width && x + w > region.x + region.w - mx)
            || (region.y + region.h < height && y + h > region.y + region.h - my);
          if (!cut) found.push(face);
        }
      }
    }
    return nms(found, nmsThreshold);
  }

  /**
   * The 128-number embedding of one detected face, at unit length.
   * @param {{ landmarks: number[][] }} face  as returned by detect()
   * @returns {Promise<Float32Array>}
   */
  function embed(rgb, width, height, face) {
    return inTurn(() => embedNow(rgb, width, height, face));
  }

  async function embedNow(rgb, width, height, face) {
    fillFaceInput(faceInput, rgb, width, height, face.landmarks);
    const outputs = await recogniser.session.run({ [faceName]: new ort.Tensor('float32', faceInput, [1, 3, FACE_SIZE, FACE_SIZE]) });
    const raw = outputs[faceOutput].data;
    let norm = 0;
    for (let i = 0; i < raw.length; i += 1) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] / norm;
    return out;
  }

  return {
    detect,
    embed,
    providers: { detector: detector.provider, recogniser: recogniser.provider },
    tried: { detector: detector.tried, recogniser: recogniser.tried },
    models: { detector: yunet, recogniser: sface },
    runtime: `onnxruntime-node ${ort.env?.versions?.node || ''}`.trim(),
  };
}
