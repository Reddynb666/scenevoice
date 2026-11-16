// Cuts the 40-second sample clip of the test shell from Tears of Steel
// (CC BY 3.0, (CC) Blender Foundation | mango.blender.org) and writes it to
// renderer/sample/sample.mp4: 640 px wide, H.264 + AAC, under 4 MB.
//
//   npm run make-sample
//
// The film is looked for in tools/film/fixtures/ (the film tools' fixture
// folder) and in desktop/.cache/; when it is in neither it is downloaded once
// into desktop/.cache/ (372 MB, git-ignored). Neither the film nor the clip is
// ever committed. Needs an ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg): it is a
// developer tool here and is not part of anything that ships.

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');

export const FILM_URL = 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov';
export const FILM_BYTES = 372178639;
/** Where the excerpt starts in the film, and how long it is, in seconds. */
export const CLIP_START = 23;
export const CLIP_SECONDS = 40;
export const MAX_BYTES = 4 * 1024 * 1024;

const FILM_NAME = 'tears_of_steel_720p.mov';
const CANDIDATES = [
  path.join(DESKTOP, '..', 'tools', 'film', 'fixtures', FILM_NAME),
  path.join(DESKTOP, '.cache', FILM_NAME),
];
const OUTPUT = path.join(DESKTOP, 'renderer', 'sample', 'sample.mp4');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function findFilm() {
  return CANDIDATES.find((file) => existsSync(file) && statSync(file).size === FILM_BYTES) || null;
}

async function downloadFilm() {
  const target = CANDIDATES[1];
  const partial = `${target}.part`;
  mkdirSync(path.dirname(target), { recursive: true });
  console.log(`Downloading ${FILM_URL}\n  to ${target} (372 MB, once)…`);
  const response = await fetch(FILM_URL);
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const size = statSync(partial).size;
  if (size !== FILM_BYTES) throw new Error(`Download is ${size} bytes, expected ${FILM_BYTES}. Delete ${partial} and try again.`);
  renameSync(partial, target);
  return target;
}

function ffmpeg(args) {
  const result = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot run ${FFMPEG}: ${result.error.message}. Install ffmpeg or set FFMPEG.`);
  return result;
}

/** The H.264 encoder to use: whichever this ffmpeg build has, the system's own first. */
function pickEncoder() {
  const listed = ffmpeg(['-hide_banner', '-encoders']).stdout || '';
  const wanted = process.platform === 'darwin'
    ? ['h264_videotoolbox', 'libx264', 'libopenh264']
    : process.platform === 'win32'
      ? ['h264_mf', 'libx264', 'libopenh264']
      : ['libx264', 'libopenh264'];
  const found = wanted.find((name) => new RegExp(`\\s${name}\\s`).test(listed));
  if (!found) throw new Error('This ffmpeg has no H.264 encoder (looked for h264_videotoolbox, h264_mf, libx264, libopenh264).');
  return found;
}

function encode(film, encoder, videoKbps) {
  const fadeOut = CLIP_SECONDS - 0.5;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(CLIP_START), '-t', String(CLIP_SECONDS), '-i', film,
    '-map', '0:v:0', '-map', '0:a:0',
    '-vf', 'scale=640:-2',
    '-c:v', encoder, '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.15)}k`, '-bufsize', `${videoKbps * 2}k`,
    '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-g', '48',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000',
    '-af', `afade=t=in:d=0.15,afade=t=out:st=${fadeOut}:d=0.5`,
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-metadata', 'title=Tears of Steel (excerpt)',
    '-metadata', 'copyright=(CC) Blender Foundation | mango.blender.org, CC BY 3.0. Music (C) Joram Letwory - www.tearsofsteel.org. Excerpt, scaled and re-encoded.',
    OUTPUT,
  ];
  const result = ffmpeg(args);
  if (result.status !== 0) throw new Error(`ffmpeg failed:\n${result.stderr}`);
  return statSync(OUTPUT).size;
}

async function main() {
  const film = findFilm() || (await downloadFilm());
  console.log(`Film: ${film}`);
  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const encoder = pickEncoder();
  // 4 MB over 40 s is 800 kbit/s in all; hardware encoders overshoot, so step down until it fits.
  let size = 0;
  for (const videoKbps of [620, 540, 460, 380]) {
    size = encode(film, encoder, videoKbps);
    console.log(`Encoded with ${encoder} at ${videoKbps} kbit/s video: ${size} bytes.`);
    if (size < MAX_BYTES) break;
  }
  if (size >= MAX_BYTES) throw new Error(`The clip is ${size} bytes: it must stay under ${MAX_BYTES}.`);
  console.log(`Wrote ${OUTPUT}`);
  console.log(`  ${CLIP_SECONDS} s from ${CLIP_START} s of Tears of Steel, (CC) Blender Foundation | mango.blender.org, CC BY 3.0.`);
  console.log('  Git-ignored. To make it again: npm run make-sample');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
