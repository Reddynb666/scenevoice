// Thin wrappers over the ffprobe and ffmpeg found on PATH: probing, sampled
// frames as raw RGB, scene scores, audio as WAV, text subtitles as SRT, JPEG in
// and out. Every child is spawned with an argument array, never a shell string.
//
// Times: every `t` these functions return is in the file's own timestamps
// ("container time", what ffprobe prints). A player that rebases the file to
// start at zero shows `t - probe(file).startTime`. For a file that starts at
// zero, as most do, the two are the same.

import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
/** How much of ffmpeg's stderr an error carries. */
const STDERR_TAIL = 1500;
/** How far a stored timestamp may sit after the true one and still count as on time, in microseconds. */
const TIMESTAMP_SLACK_US = 1000;
/** Subtitle codecs that are text and can be written as SRT. */
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd', 'subviewer', 'sami']);

/** An ffmpeg or ffprobe run that failed; `stderr` is the tail of what it said. */
export class MediaError extends Error {
  constructor(message, { command, args, code = null, stderr = '' } = {}) {
    super(stderr ? `${message}\n${stderr}` : message);
    this.name = 'MediaError';
    this.command = command;
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

function tailOf(text) {
  return text.length > STDERR_TAIL ? text.slice(-STDERR_TAIL) : text;
}

function startChild(command, args, stdio) {
  const child = spawn(command, args, { stdio, windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    stderr = tailOf(stderr + text);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      const missing = error.code === 'ENOENT';
      reject(new MediaError(missing ? `${command} was not found on PATH` : `${command} could not start: ${error.message}`, { command, args }));
    });
    child.once('close', (code, signal) => resolve({ code, signal, stderr: stderr.trim() }));
  });
  // A caller that stops early must not leave an unhandled rejection behind.
  closed.catch(() => {});
  return { child, closed };
}

/**
 * Run a command to the end and collect its stdout.
 * @returns {Promise<{ stdout: Buffer, stderr: string }>}
 */
async function run(command, args, { input } = {}) {
  const { child, closed } = startChild(command, args, [input ? 'pipe' : 'ignore', 'pipe', 'pipe']);
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  if (input) {
    // ffmpeg may close its end early when it fails; the exit code tells the story.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
  const { code, signal, stderr } = await closed;
  if (code !== 0) {
    throw new MediaError(`${command} exited with ${signal || code}`, { command, args, code, stderr });
  }
  return { stdout: Buffer.concat(chunks), stderr };
}

function ratio(text) {
  if (!text) return null;
  const [a, b] = String(text).split(/[/:]/).map(Number);
  if (!Number.isFinite(a)) return null;
  if (b === undefined) return a;
  return b ? a / b : null;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * What is in a media file. `duration` is what the container states; `endTime`
 * is the container time of the end (see the note on Matroska below).
 *
 * @returns {Promise<{
 *   duration: number, startTime: number, endTime: number, format: string, bytes: number, tags: Record<string, string>,
 *   video: null | { index: number, codec: string, width: number, height: number, displayWidth: number,
 *     displayHeight: number, fps: number, startTime: number, frames: number | null, pixelFormat: string },
 *   audio: { index: number, codec: string, channels: number, sampleRate: number, language: string | null, startTime: number }[],
 *   subtitles: { index: number, codec: string, language: string | null, text: boolean }[],
 * }>}
 */
export async function probe(file) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
  const { stdout } = await run(FFPROBE, args);
  let data;
  try {
    data = JSON.parse(stdout.toString('utf8'));
  } catch {
    throw new MediaError('ffprobe did not print JSON', { command: FFPROBE, args });
  }
  const format = data.format || {};
  const streams = data.streams || [];
  const startTime = numberOr(format.start_time, 0);
  const language = (stream) => stream.tags?.language || stream.tags?.LANGUAGE || null;

  const picture = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  let video = null;
  if (picture) {
    const sar = ratio(picture.sample_aspect_ratio) || 1;
    const turned = Math.abs(numberOr(picture.side_data_list?.find((d) => d.rotation !== undefined)?.rotation, 0)) % 180 === 90;
    const wide = Math.round(picture.width * sar);
    video = {
      index: picture.index,
      codec: picture.codec_name,
      width: picture.width,
      height: picture.height,
      // What a player shows: square pixels, and upright if the file says it is turned.
      displayWidth: turned ? picture.height : wide,
      displayHeight: turned ? wide : picture.height,
      fps: ratio(picture.avg_frame_rate) || ratio(picture.r_frame_rate) || 0,
      startTime: numberOr(picture.start_time, startTime),
      frames: numberOr(picture.nb_frames, null),
      pixelFormat: picture.pix_fmt || '',
    };
  }
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => ({
    index: s.index,
    codec: s.codec_name,
    channels: numberOr(s.channels, 0),
    sampleRate: numberOr(s.sample_rate, 0),
    language: language(s),
    startTime: numberOr(s.start_time, startTime),
  }));
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({
    index: s.index,
    codec: s.codec_name,
    language: language(s),
    text: TEXT_SUBTITLES.has(s.codec_name),
  }));
  const duration = numberOr(format.duration, 0);
  // Matroska states the last timestamp as its duration; other containers state
  // the length. Either way the file cannot end before startTime.
  const matroska = /matroska|webm/.test(format.format_name || '');
  return {
    duration,
    startTime,
    endTime: matroska ? Math.max(duration, startTime) : startTime + duration,
    format: format.format_name || '',
    bytes: numberOr(format.size, 0),
    tags: format.tags || {},
    video,
    audio,
    subtitles,
  };
}

let hwaccelList = null;

/** The hardware decoders this ffmpeg build lists (`ffmpeg -hwaccels`). */
export async function hwaccels() {
  if (!hwaccelList) {
    hwaccelList = run(FFMPEG, ['-hide_banner', '-hwaccels'])
      .then(({ stdout }) => stdout.toString('utf8').split('\n').slice(1).map((line) => line.trim()).filter(Boolean))
      .catch(() => []);
  }
  return hwaccelList;
}

/**
 * The hardware decoder a call will use: `undefined` picks VideoToolbox on macOS
 * when this ffmpeg has it; `false` or 'none' decodes in software. Returns null
 * for software decoding.
 */
export async function chooseHwaccel(wanted) {
  if (wanted === false || wanted === 'none') return null;
  const have = await hwaccels();
  if (wanted) return have.includes(wanted) ? wanted : null;
  return process.platform === 'darwin' && have.includes('videotoolbox') ? 'videotoolbox' : null;
}

/** Output size for a wanted width: never larger than the picture, square pixels, even numbers. */
export function scaledSize(video, width) {
  const outWidth = Math.max(2, Math.floor(Math.min(width, video.displayWidth) / 2) * 2);
  const outHeight = Math.max(2, Math.round((outWidth * video.displayHeight) / video.displayWidth / 2) * 2);
  return { width: outWidth, height: outHeight };
}

/** Arguments that open `file` at `start` and stop at `end` (container time). */
function inputArgs(info, { start, end, hwaccel }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (hwaccel) args.push('-hwaccel', hwaccel);
  // ffmpeg counts -ss from the file's start time, not from zero.
  const offset = start === undefined ? 0 : Math.max(0, start - info.startTime);
  if (offset > 0) args.push('-ss', offset.toFixed(6));
  if (end !== undefined) args.push('-t', Math.max(0, end - info.startTime - offset).toFixed(6));
  return args;
}

/**
 * Frames sampled at a fixed rate, as raw RGB.
 *
 * Frame `index` is the last picture shown at or before `t = first + index / fps`,
 * where `first` is the time of the first picture read (the video stream's own
 * start time, or `start` when seeking). `t` is computed, not read back from
 * ffmpeg, so it can be off by less than one source frame after a seek.
 *
 * @param {string} file
 * @param {{ fps?: number, width?: number, hwaccel?: string | false, start?: number, end?: number, info?: object }} [options]
 * @returns {AsyncGenerator<{ index: number, t: number, width: number, height: number, rgb: Uint8Array }>}
 */
export async function* frames(file, { fps = 2, width = 960, hwaccel, start, end, info } = {}) {
  const meta = info || (await probe(file));
  if (!meta.video) throw new MediaError(`${file} has no video stream`);
  const size = scaledSize(meta.video, width);
  const accel = await chooseHwaccel(hwaccel);
  const first = start === undefined || start <= meta.video.startTime ? meta.video.startTime : start;
  const args = [
    ...inputArgs(meta, { start, end, hwaccel: accel }),
    '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    // round=up: a slot shows the last picture at or before its time (the default,
    // nearest, would show one from up to half a period later). Timestamps are
    // first put in microseconds and moved 1 ms earlier, because Matroska stores
    // whole milliseconds: a picture written as 0.042 s belongs to 1/24 s.
    '-vf', `settb=AVTB,setpts=PTS-STARTPTS-${TIMESTAMP_SLACK_US},fps=fps=${fps}:round=up,scale=${size.width}:${size.height}:flags=bilinear,setsar=1`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ];
  const { child, closed } = startChild(FFMPEG, args, ['ignore', 'pipe', 'pipe']);
  const frameBytes = size.width * size.height * 3;
  let finished = false;
  try {
    let frame = new Uint8Array(frameBytes);
    let filled = 0;
    let index = 0;
    for await (const chunk of child.stdout) {
      let at = 0;
      while (at < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - at);
        frame.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === frameBytes) {
          yield { index, t: first + index / fps, width: size.width, height: size.height, rgb: frame };
          index += 1;
          frame = new Uint8Array(frameBytes);
          filled = 0;
        }
      }
    }
    const { code, signal, stderr } = await closed;
    finished = true;
    if (code !== 0) throw new MediaError(`ffmpeg exited with ${signal || code} while decoding ${file}`, { command: FFMPEG, args, code, stderr });
    if (filled !== 0) throw new MediaError(`ffmpeg ended in the middle of a frame of ${file}`, { command: FFMPEG, args, code, stderr });
  } finally {
    // The consumer stopped early (break, return or an exception): stop decoding.
    if (!finished) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed.catch(() => {});
    }
  }
}

/** One frame: the picture shown at time `t`. */
export async function frameAt(file, t, { width = 960, hwaccel, info } = {}) {
  const meta = info || (await probe(file));
  const fps = meta.video?.fps || 25;
  for await (const frame of frames(file, { fps, width, hwaccel, start: t, end: t + 2 / fps, info: meta })) {
    return frame;
  }
  throw new MediaError(`no frame at ${t} s in ${file}`);
}

/**
 * ffmpeg's scene-change score (0 to 1) of every picture against the one before
 * it, computed on a small copy of the picture. A high score at `t` means a new
 * shot starts with the picture at `t`.
 *
 * @returns {Promise<{ t: number, score: number }[]>}
 */
export async function sceneScores(file, { width = 320, hwaccel, start, end, info } = {}) {
  const meta = info || (await probe(file));
  if (!meta.video) throw new MediaError(`${file} has no video stream`);
  const size = scaledSize(meta.video, width);
  const accel = await chooseHwaccel(hwaccel);
  const args = [
    ...inputArgs(meta, { start, end, hwaccel: accel }),
    // Keep the file's timestamps so the printed times are container time.
    '-copyts',
    '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-fps_mode', 'passthrough',
    '-vf', `scale=${size.width}:${size.height}:flags=fast_bilinear,select='gte(scene,0)',metadata=print:file=-`,
    '-f', 'null', '-',
  ];
  const { child, closed } = startChild(FFMPEG, args, ['ignore', 'pipe', 'pipe']);
  const scores = [];
  let pending = '';
  let time = null;
  const take = (line) => {
    const head = /pts_time:(-?[\d.]+)/.exec(line);
    if (head) {
      time = Number(head[1]);
      return;
    }
    const score = /^lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score && time !== null) {
      scores.push({ t: time, score: Number(score[1]) });
      time = null;
    }
  };
  child.stdout.setEncoding('utf8');
  for await (const text of child.stdout) {
    const lines = (pending + text).split('\n');
    pending = lines.pop();
    for (const line of lines) take(line);
  }
  if (pending) take(pending);
  const { code, signal, stderr } = await closed;
  if (code !== 0) throw new MediaError(`ffmpeg exited with ${signal || code} while scoring scenes of ${file}`, { command: FFMPEG, args, code, stderr });
  return scores;
}

/**
 * Write one audio track as a mono 16-bit WAV. Sample 0 of the WAV is the file's
 * start time (silence is added if the track itself starts later), so WAV time
 * `x` is container time `startTime + x`.
 *
 * @param {string} file
 * @param {{ out: string, rate?: number, track?: number, info?: object }} options
 * @returns {Promise<{ path: string, rate: number, bytes: number, samples: number, duration: number, startTime: number }>}
 */
export async function audioPcm(file, { out, rate = 16000, track = 0, info } = {}) {
  if (!out) throw new TypeError('audioPcm needs options.out, the path of the WAV to write');
  const meta = info || (await probe(file));
  if (!meta.audio[track]) throw new MediaError(`${file} has no audio track ${track}`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', file,
    '-map', `0:a:${track}`, '-vn', '-sn', '-dn',
    '-af', `aresample=${rate}:async=1:first_pts=0`,
    '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', out,
  ];
  await run(FFMPEG, args);
  const bytes = (await stat(out)).size;
  // A plain WAV header from ffmpeg is 44 bytes; with a LIST chunk it is a little more.
  const header = await wavDataOffset(out);
  const samples = Math.floor((bytes - header) / 2);
  return { path: out, rate, bytes, samples, duration: samples / rate, startTime: meta.startTime };
}

async function wavDataOffset(path) {
  const head = (await readFile(path)).subarray(0, 4096);
  const at = head.indexOf('data', 12, 'latin1');
  return at < 0 ? 44 : at + 8;
}

/**
 * Every text subtitle track as an SRT string, in container time. Picture
 * subtitles (PGS, DVD) are listed by probe() but cannot be turned into text here.
 *
 * @returns {Promise<{ index: number, track: number, language: string | null, codec: string, srt: string }[]>}
 */
export async function extractSubtitles(file, { info } = {}) {
  const meta = info || (await probe(file));
  const tracks = [];
  for (let track = 0; track < meta.subtitles.length; track += 1) {
    const subtitle = meta.subtitles[track];
    if (!subtitle.text) continue;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-copyts',
      '-i', file,
      '-map', `0:s:${track}`, '-c:s', 'srt', '-f', 'srt', 'pipe:1',
    ];
    const { stdout } = await run(FFMPEG, args);
    tracks.push({ index: subtitle.index, track, language: subtitle.language, codec: subtitle.codec, srt: stdout.toString('utf8') });
  }
  return tracks;
}

/** JPEG quality 1–100 as ffmpeg's -q:v for MJPEG (2 best … 31 worst). */
function jpegQscale(quality) {
  const q = Math.min(100, Math.max(1, quality));
  return Math.round(2 + ((100 - q) * 29) / 99);
}

/**
 * Encode raw RGB as a JPEG, through an ffmpeg pipe.
 * @returns {Promise<Buffer>}
 */
export async function encodeJpeg(rgb, width, height, { quality = 85 } = {}) {
  if (rgb.length !== width * height * 3) throw new RangeError(`encodeJpeg: ${rgb.length} bytes is not ${width}x${height} RGB`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${width}x${height}`, '-i', 'pipe:0',
    '-frames:v', '1',
    // Full-range 4:2:0, the usual JPEG layout.
    '-vf', 'scale=out_range=pc,format=yuvj420p',
    '-c:v', 'mjpeg', '-q:v', String(jpegQscale(quality)),
    '-f', 'image2pipe', 'pipe:1',
  ];
  const { stdout } = await run(FFMPEG, args, { input: Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength) });
  if (stdout.length < 4 || stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new MediaError('ffmpeg did not write a JPEG', { command: FFMPEG, args });
  return stdout;
}

/** Encode raw RGB and write it as a JPEG file. */
export async function writeJpeg(path, rgb, width, height, options) {
  const jpeg = await encodeJpeg(rgb, width, height, options);
  await writeFile(path, jpeg);
  return { path, bytes: jpeg.length };
}

/**
 * Read a picture file (JPEG, PNG, anything ffmpeg decodes) as raw RGB.
 * @returns {Promise<{ width: number, height: number, rgb: Uint8Array }>}
 */
export async function readJpeg(path) {
  // PPM is a three-line header and then the RGB bytes: one child, sizes included.
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-frames:v', '1', '-c:v', 'ppm', '-pix_fmt', 'rgb24', '-f', 'image2pipe', 'pipe:1'];
  const { stdout } = await run(FFMPEG, args);
  const header = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(stdout.subarray(0, 64).toString('latin1'));
  if (!header) throw new MediaError(`ffmpeg did not decode ${path}`, { command: FFMPEG, args });
  const width = Number(header[1]);
  const height = Number(header[2]);
  const rgb = new Uint8Array(stdout.buffer, stdout.byteOffset + header[0].length, width * height * 3).slice();
  return { width, height, rgb };
}

/** Which ffmpeg this is: the first line of `ffmpeg -version`. */
export async function ffmpegVersion() {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-version']);
  return stdout.toString('utf8').split('\n')[0].trim();
}
