// Tests for lib/media.mjs against small files made on the spot with ffmpeg:
// every frame carries its own number as a grey level, so "which picture did we
// get for this time" can be read back from the pixels. Run: npm test

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { MediaError, audioPcm, encodeJpeg, extractSubtitles, frameAt, frames, probe, readJpeg, sceneScores, writeJpeg } from '../lib/media.mjs';

const FPS = 24;
const FRAMES = 72;
/** Frame number where the grey level jumps: a hard cut for the scene score. */
const CUT = 36;

let dir;
/** Video starts 0.5 s after the audio, everything 5 s after zero. */
let lateVideo;
/** Audio starts 0.5 s after the video. */
let lateAudio;

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed making a test file: ${result.stderr}`);
}

function makeFile(path, { videoStart, audioStart, subtitleShift }) {
  const srt = join(dir, 'cue.srt');
  writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n');
  // Luma 16 + 2N before the cut, 235 - 2(N - CUT) after it; chroma stays grey.
  const luma = `if(lt(N\\,${CUT})\\,16+2*N\\,235-2*(N-${CUT}))`;
  ffmpeg([
    '-itsoffset', String(videoStart), '-f', 'lavfi', '-i', `color=c=gray:s=64x48:r=${FPS}:d=${FRAMES / FPS},format=yuv420p,geq=lum='${luma}':cb=128:cr=128`,
    '-itsoffset', String(audioStart), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-itsoffset', String(subtitleShift), '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=eng',
    path,
  ]);
}

/** The frame number a grey level stands for. */
function frameNumber(rgb) {
  const luma = 16 + (rgb[0] * 219) / 255;
  return luma < 125 ? Math.round((luma - 16) / 2) : CUT + Math.round((235 - luma) / 2);
}

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected} ± ${tolerance}`);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'film-tools-test-'));
  lateVideo = join(dir, 'late-video.mkv');
  lateAudio = join(dir, 'late-audio.mkv');
  makeFile(lateVideo, { videoStart: 5.5, audioStart: 5, subtitleShift: 5 });
  makeFile(lateAudio, { videoStart: 5, audioStart: 5.5, subtitleShift: 5 });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('probe reads the streams and both start times', async () => {
  const info = await probe(lateVideo);
  near(info.startTime, 5, 0.002, 'file start time');
  near(info.video.startTime, 5.5, 0.002, 'video start time');
  // A trap worth pinning: Matroska stores the last timestamp as its duration,
  // so a file that starts at 5 s and plays for 3.5 s reports 8.5.
  near(info.duration, 8.5, 0.05, 'duration as the container states it');
  near(info.endTime, 8.5, 0.05, 'end time');
  assert.equal(info.video.codec, 'ffv1');
  assert.equal(info.video.width, 64);
  assert.equal(info.video.height, 48);
  near(info.video.fps, FPS, 0.001, 'frame rate');
  assert.deepEqual(info.audio.map((a) => [a.codec, a.channels, a.language]), [['pcm_s16le', 1, 'eng']]);
  assert.deepEqual(info.subtitles.map((s) => [s.codec, s.language, s.text]), [['subrip', 'eng', true]]);
});

test('the first sampled frame carries the stream start time and is the first picture', async () => {
  const got = [];
  for await (const frame of frames(lateVideo, { fps: 2, width: 64 })) got.push({ t: frame.t, n: frameNumber(frame.rgb), w: frame.width, h: frame.height, bytes: frame.rgb.length });
  assert.ok(got.length >= 6, `expected at least 6 frames at 2 fps, got ${got.length}`);
  near(got[0].t, 5.5, 0.002, 'first frame t');
  assert.equal(got[0].n, 0, 'first frame is picture 0');
  assert.deepEqual([got[0].w, got[0].h, got[0].bytes], [64, 48, 64 * 48 * 3]);
  // Sample k is the picture at 5.5 + k / 2: picture 12k.
  for (let k = 0; k < 6; k += 1) {
    near(got[k].t, 5.5 + k / 2, 0.002, `t of sample ${k}`);
    assert.equal(got[k].n, 12 * k, `sample ${k} is picture ${12 * k}`);
  }
});

test('sampling at the source rate returns every picture once, in order', async () => {
  const numbers = [];
  for await (const frame of frames(lateVideo, { fps: FPS, width: 64 })) {
    near(frame.t, 5.5 + frame.index / FPS, 0.002, `t of frame ${frame.index}`);
    numbers.push(frameNumber(frame.rgb));
  }
  assert.deepEqual(numbers.slice(0, FRAMES), Array.from({ length: FRAMES }, (_, n) => n));
});

test('a sample shows the last picture at or before its time', async () => {
  // 5 fps does not divide 24: sample k is at k / 5 s, picture floor(24k / 5).
  const numbers = [];
  for await (const frame of frames(lateVideo, { fps: 5, width: 64 })) numbers.push(frameNumber(frame.rgb));
  assert.deepEqual(numbers.slice(0, 8), [0, 4, 9, 14, 19, 24, 28, 33]);
});

test('seeking: start and end are container times', async () => {
  const got = [];
  for await (const frame of frames(lateVideo, { fps: 2, width: 64, start: 6, end: 7.2 })) got.push({ t: frame.t, n: frameNumber(frame.rgb) });
  near(got[0].t, 6, 0.002, 'first frame t after seeking');
  assert.equal(got[0].n, 12, 'picture at 6.0 s is number 12');
  assert.equal(got[1].n, 24, 'picture at 6.5 s is number 24');
  assert.ok(got.length <= 4, `end stops the reader, got ${got.length} frames`);

  const one = await frameAt(lateVideo, 7.0, { width: 64 });
  assert.equal(frameNumber(one.rgb), 36, 'frameAt(7.0) is picture 36');
});

test('stopping early ends ffmpeg without an error', async () => {
  let count = 0;
  for await (const frame of frames(lateVideo, { fps: FPS, width: 64 })) {
    count += 1;
    if (frame.index === 3) break;
  }
  assert.equal(count, 4);
});

test('scene scores: one per picture, in container time, with the cut on top', async () => {
  const scores = await sceneScores(lateVideo);
  assert.equal(scores.length, FRAMES);
  near(scores[0].t, 5.5, 0.002, 'first score t');
  const top = scores.reduce((best, s) => (s.score > best.score ? s : best));
  near(top.t, 5.5 + CUT / FPS, 0.002, 'time of the highest score');
  assert.ok(top.score > 0.5, `the cut scores high, got ${top.score}`);
  const others = scores.filter((s) => s !== top);
  assert.ok(others.every((s) => s.score < 0.1), 'no other picture scores as a cut');
});

test('audio: WAV sample 0 is the file start, a late track is padded with silence', async () => {
  const out = join(dir, 'late-audio.wav');
  const wav = await audioPcm(lateAudio, { out, rate: 16000 });
  assert.equal(wav.rate, 16000);
  near(wav.startTime, 5, 0.002, 'WAV start in container time');
  near(wav.duration, 3.5, 0.05, 'WAV duration: 0.5 s of silence and 3 s of tone');
  const bytes = readFileSync(out);
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt16LE(22), 1, 'mono');
  assert.equal(bytes.readUInt32LE(24), 16000, 'sample rate');
  assert.equal(bytes.readUInt16LE(34), 16, 'bits per sample');
  const data = bytes.indexOf('data', 12, 'latin1') + 8;
  const rms = (from, to) => {
    let sum = 0;
    for (let i = Math.round(from * 16000); i < Math.round(to * 16000); i += 1) sum += bytes.readInt16LE(data + i * 2) ** 2;
    return Math.sqrt(sum / ((to - from) * 16000));
  };
  assert.ok(rms(0.05, 0.45) < 10, `silence before the track starts, rms ${rms(0.05, 0.45)}`);
  assert.ok(rms(0.6, 3.4) > 1000, `tone after it starts, rms ${rms(0.6, 3.4)}`);

  const early = await audioPcm(lateVideo, { out: join(dir, 'late-video.wav') });
  near(early.duration, 3, 0.05, 'no padding when the audio starts the file');
});

test('subtitles come out as SRT in container time', async () => {
  const tracks = await extractSubtitles(lateVideo);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].language, 'eng');
  assert.match(tracks[0].srt, /00:00:06,000 --> 00:00:07,000\r?\nHello/);
});

test('JPEG out and back in', async () => {
  const width = 64;
  const height = 48;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rgb.set([x * 4, y * 5, 128], (y * width + x) * 3);
    }
  }
  const jpeg = await encodeJpeg(rgb, width, height, { quality: 95 });
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);
  const path = join(dir, 'gradient.jpg');
  await writeJpeg(path, rgb, width, height, { quality: 95 });
  const back = await readJpeg(path);
  assert.deepEqual([back.width, back.height, back.rgb.length], [width, height, rgb.length]);
  let difference = 0;
  for (let i = 0; i < rgb.length; i += 1) difference += Math.abs(rgb[i] - back.rgb[i]);
  assert.ok(difference / rgb.length < 4, `mean difference after a round trip: ${difference / rgb.length}`);
  await assert.rejects(encodeJpeg(rgb, width + 1, height), RangeError);
});

test('errors carry what ffmpeg said', async () => {
  await assert.rejects(probe(join(dir, 'missing.mov')), (error) => {
    assert.ok(error instanceof MediaError);
    assert.match(error.message, /No such file or directory/);
    return true;
  });
  const broken = join(dir, 'broken.mkv');
  writeFileSync(broken, 'this is not a film');
  await assert.rejects(async () => {
    for await (const frame of frames(broken, { info: { startTime: 0, video: { startTime: 0, displayWidth: 64, displayHeight: 48 } } })) assert.fail(`got a frame: ${frame.index}`);
  }, (error) => error instanceof MediaError && error.stderr.length > 0);
});
