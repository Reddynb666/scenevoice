#!/usr/bin/env node
// Downloads the test film for the kill tests, Tears of Steel (720p), with its
// English and Chinese subtitle files and the copyright notice that sits next to
// it on download.blender.org, into fixtures/ (git-ignored), and writes
// fixtures/SOURCE.json: where it came from, its SHA-256, and the licence exactly
// as copyright.txt words it. Nothing is assumed about the licence: what the
// notice says it covers is recorded, and so is what it does not say.
//
// The notice turned out to name only the soundtrack. The film states its own
// licence in its end credits, which a script cannot read: a person who has
// looked at them can record what they say with --credits-licence and
// --credits-at, and SOURCE.json keeps it marked as read by eye.
//
// Usage: node fetch-fixture.mjs [--fetched-at 2026-11-15T12:00:00Z] [--dir fixtures]
//          [--credits-licence "text as shown on screen" --credits-at 703]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { download, fetchText, progressLine, sha256File } from './lib/download.mjs';
import { probe } from './lib/media.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://download.blender.org/demo/movies/ToS/';
const FILM = 'tears_of_steel_720p.mov';
/** The size the server announced when this script was written; a different size stops the run. */
const FILM_BYTES_EXPECTED = 372178639;
/** English and Chinese (simplified and traditional) subtitle files, by the names used in the folder. */
const SUBTITLE_PATTERN = /^TOS-(en|CH[\w-]*)\.srt$/i;

const { values: options } = parseArgs({
  options: {
    'fetched-at': { type: 'string' },
    'credits-licence': { type: 'string' },
    'credits-at': { type: 'string' },
    dir: { type: 'string', default: join(HERE, 'fixtures') },
  },
});

/** The licence as the notice states it: its name, what it says it covers, and the credit line it asks for. */
function readNotice(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const filled = lines.filter(Boolean);
  const scope = filled.find((line) => /^This licen[cs]e applies to/i.test(line)) || null;
  const creditAt = lines.findIndex((line) => /^You must attribute the work as/i.test(line));
  const credit = creditAt < 0 ? null : lines.slice(creditAt + 1).find(Boolean) || null;
  const link = /https?:\/\/creativecommons\.org\/\S+/i.exec(text)?.[0] || null;
  return { name: filled[0] || null, scope, credit, link };
}

async function main() {
  const dir = resolve(options.dir);
  await mkdir(dir, { recursive: true });

  const notice = await fetchText(`${BASE}copyright.txt`);
  await writeFile(join(dir, 'copyright.txt'), notice.text);
  const stated = readNotice(notice.text);
  if (!stated.name || !/creative commons/i.test(stated.name)) {
    throw new Error(`copyright.txt does not open with a Creative Commons licence name any more: "${stated.name}". Read it before using the film.`);
  }

  const listing = await fetchText(`${BASE}subtitles/`);
  const names = [...listing.text.matchAll(/href="([^"]+\.srt)"/gi)].map((match) => decodeURIComponent(match[1]));
  const wanted = names.filter((name) => SUBTITLE_PATTERN.test(name));
  if (!wanted.some((name) => /-en\./i.test(name))) throw new Error(`no English subtitle file in ${BASE}subtitles/ (found: ${names.join(', ')})`);
  const subtitles = [];
  for (const name of wanted) {
    const got = await download(`${BASE}subtitles/${name}`, join(dir, 'subtitles', name), { maxBytes: 1024 * 1024 });
    subtitles.push({ file: `subtitles/${name}`, url: `${BASE}subtitles/${name}`, bytes: got.bytes, sha256: got.sha256 });
  }

  const film = await download(`${BASE}${FILM}`, join(dir, FILM), { bytes: FILM_BYTES_EXPECTED, onProgress: progressLine(FILM) });
  const info = await probe(film.path);

  // Keep the first fetch date when the film was already here and no date was passed in.
  let earlier = null;
  try {
    earlier = JSON.parse(await readFile(join(dir, 'SOURCE.json'), 'utf8'));
  } catch {
    // First run.
  }
  const headerDate = film.date || notice.headers.get('date');
  const fetchedAt = options['fetched-at']
    || (film.alreadyThere && earlier?.sha256 === film.sha256 && earlier.fetchedAt)
    || (headerDate ? new Date(headerDate).toISOString() : null);
  if (!fetchedAt) throw new Error('no fetch date: the server sent no Date header; pass --fetched-at');

  // What a person read off the end credits; kept from an earlier run of the same file.
  let credits = earlier?.sha256 === film.sha256 ? earlier.licenceInFilmCredits || null : null;
  if (options['credits-licence']) {
    const at = Number(options['credits-at']);
    if (!Number.isFinite(at)) throw new Error('--credits-licence needs --credits-at, the time in seconds where the text is on screen');
    credits = { text: options['credits-licence'], atSeconds: at, how: 'read by eye from a frame of this file; not checked by a script' };
  }

  const source = {
    title: 'Tears of Steel (720p)',
    url: `${BASE}${FILM}`,
    file: FILM,
    // Word for word, the notice published next to the film.
    licence: notice.text.trim(),
    licenceName: stated.name,
    licenceScopeAsStated: stated.scope,
    attributionAsStated: stated.credit,
    licenceLink: stated.link,
    licenceSource: `${BASE}copyright.txt`,
    licenceNote: stated.scope && /soundtrack/i.test(stated.scope)
      ? 'copyright.txt names only the Original Soundtrack files. It does not state a licence for the picture; that is in the film\'s own end credits (licenceInFilmCredits, once a person has read them). Mind both before anything made from this film leaves this machine.'
      : null,
    licenceInFilmCredits: credits,
    sha256: film.sha256,
    bytes: film.bytes,
    fetchedAt,
    container: { format: info.format, duration: info.duration, video: info.video, audio: info.audio, tags: info.tags },
    subtitles,
    copyrightFile: { file: 'copyright.txt', bytes: Buffer.byteLength(notice.text), sha256: await sha256File(join(dir, 'copyright.txt')) },
  };
  await writeFile(join(dir, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);

  console.log(`${FILM}: ${film.bytes} bytes, sha256 ${film.sha256}${film.alreadyThere ? ' (already here)' : ''}`);
  for (const subtitle of subtitles) console.log(`${subtitle.file}: ${subtitle.bytes} bytes`);
  console.log(`licence, as copyright.txt states it: ${stated.name}`);
  if (stated.scope) console.log(`  ${stated.scope}`);
  if (stated.credit) console.log(`  credit: ${stated.credit}`);
  if (source.licenceNote) console.log(`  note: ${source.licenceNote}`);
  console.log(credits ? `licence in the end credits (read by eye at ${credits.atSeconds} s): ${credits.text}` : 'licence in the end credits: not recorded yet (see --credits-licence)');
  console.log(`wrote ${join(dir, 'SOURCE.json')}`);
}

main().catch((error) => {
  console.error(`fetch-fixture failed: ${error.message}`);
  process.exitCode = 1;
});
