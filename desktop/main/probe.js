// Names the container and the codecs of a film file, for the diagnostic report
// and for one warning ("this film's sound is AC-3"). It reads a few headers of
// the file and nothing else: no ffmpeg, no picture, no sound, no metadata such
// as titles. The buffer parsers are pure; probeFile is the part that reads.

import fs from 'node:fs';

/** A moov box larger than this is read only up to here. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** How much of a Matroska file is searched for codec ids. */
const MATROSKA_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 4096;

const MP4_NAMES = Object.freeze({
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'HEVC',
  hev1: 'HEVC',
  dvh1: 'Dolby Vision HEVC',
  dvhe: 'Dolby Vision HEVC',
  av01: 'AV1',
  vp09: 'VP9',
  mp4v: 'MPEG-4 Part 2',
  mp4a: 'AAC',
  'ac-3': 'AC-3',
  'ec-3': 'E-AC-3',
  dtsc: 'DTS',
  dtsh: 'DTS',
  dtsl: 'DTS',
  dtse: 'DTS',
  mlpa: 'TrueHD',
  Opus: 'Opus',
  fLaC: 'FLAC',
  '.mp3': 'MP3',
  alac: 'ALAC',
  tx3g: 'text',
  text: 'text',
  wvtt: 'WebVTT',
  stpp: 'TTML',
  tmcd: 'timecode',
});

const MATROSKA_NAMES = Object.freeze({
  'V_MPEG4/ISO/AVC': 'H.264',
  'V_MPEGH/ISO/HEVC': 'HEVC',
  V_AV1: 'AV1',
  V_VP9: 'VP9',
  V_VP8: 'VP8',
  V_MPEG2: 'MPEG-2',
  'V_MPEG4/ISO/ASP': 'MPEG-4 Part 2',
  A_AAC: 'AAC',
  A_AC3: 'AC-3',
  A_EAC3: 'E-AC-3',
  A_DTS: 'DTS',
  A_TRUEHD: 'TrueHD',
  A_OPUS: 'Opus',
  A_VORBIS: 'Vorbis',
  A_FLAC: 'FLAC',
  'A_MPEG/L3': 'MP3',
  'S_TEXT/UTF8': 'SRT subtitles',
  'S_TEXT/ASS': 'ASS subtitles',
  'S_TEXT/SSA': 'SSA subtitles',
  'S_TEXT/WEBVTT': 'WebVTT subtitles',
  'S_HDMV/PGS': 'PGS picture subtitles',
  S_VOBSUB: 'VobSub picture subtitles',
});

/** Audio the Chromium in Electron plays, and audio it does not. */
const PLAYABLE_AUDIO = new Set(['AAC', 'MP3', 'Opus', 'Vorbis', 'FLAC']);
const UNPLAYABLE_AUDIO = new Set(['AC-3', 'E-AC-3', 'DTS', 'TrueHD']);

const ascii = (buf, start, end) => buf.toString('latin1', start, end);
const printable = (s) => s.replace(/[^\x20-\x7e]/g, '?');

/**
 * The container, from the first bytes of the file.
 * @param {Buffer} head  the first kilobytes
 * @returns {{family: 'mp4'|'matroska'|'other'|'unknown', name: string}}
 */
export function sniffContainer(head) {
  if (!head || head.length < 12) return { family: 'unknown', name: 'unknown' };
  const type = ascii(head, 4, 8);
  if (type === 'ftyp') {
    const brand = printable(ascii(head, 8, 12)).trim();
    return { family: 'mp4', name: brand === 'qt' ? 'QuickTime (qt)' : `MP4 (${brand})` };
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(type)) return { family: 'mp4', name: 'QuickTime' };
  if (head.readUInt32BE(0) === 0x1a45dfa3) {
    const start = ascii(head, 0, Math.min(head.length, 96));
    return { family: 'matroska', name: start.includes('webm') ? 'WebM' : 'Matroska' };
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'AVI ') return { family: 'other', name: 'AVI' };
  if (ascii(head, 0, 4) === 'OggS') return { family: 'other', name: 'Ogg' };
  if (ascii(head, 0, 3) === 'FLV') return { family: 'other', name: 'FLV' };
  if (ascii(head, 0, 4) === '.RMF') return { family: 'other', name: 'RealMedia' };
  if (head.readUInt32BE(0) === 0x000001ba) return { family: 'other', name: 'MPEG-PS' };
  if (head.readUInt32BE(0) === 0x3026b275) return { family: 'other', name: 'ASF / WMV' };
  if (head[0] === 0x47 && head.length > 188 && head[188] === 0x47) return { family: 'other', name: 'MPEG-TS' };
  return { family: 'unknown', name: 'unknown' };
}

/** The sample formats (four-character codes) in the contents of a moov box, in track order. */
export function mp4SampleFormats(moov) {
  const containers = new Set(['trak', 'mdia', 'minf', 'stbl']);
  const out = [];
  const walk = (start, end) => {
    let o = start;
    while (o + 8 <= end) {
      let size = moov.readUInt32BE(o);
      const type = ascii(moov, o + 4, o + 8);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) return;
        size = Number(moov.readBigUInt64BE(o + 8));
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header) return;
      const boxEnd = Math.min(o + size, end);
      if (containers.has(type)) {
        walk(o + header, boxEnd);
      } else if (type === 'stsd' && o + header + 8 <= boxEnd) {
        const count = moov.readUInt32BE(o + header + 4);
        let e = o + header + 8;
        for (let i = 0; i < count && e + 8 <= boxEnd; i += 1) {
          const entrySize = moov.readUInt32BE(e);
          out.push(ascii(moov, e + 4, e + 8));
          if (entrySize < 8) break;
          e += entrySize;
        }
      }
      o += size;
    }
  };
  walk(0, moov.length);
  return out;
}

/** Codec ids (the CodecID element, 0x86) found in the start of a Matroska file. */
export function matroskaCodecIds(buf) {
  const out = [];
  for (let i = 0; i + 2 < buf.length; i += 1) {
    if (buf[i] !== 0x86) continue;
    const length = buf[i + 1] & 0x7f;
    if ((buf[i + 1] & 0x80) === 0 || length < 4 || length > 40 || i + 2 + length > buf.length) continue;
    const id = ascii(buf, i + 2, i + 2 + length);
    if (/^[AVS]_[A-Z0-9]+(?:\/[A-Z0-9]+){0,3}$/.test(id)) out.push(id);
  }
  return out;
}

function named(codes, names) {
  const seen = new Set();
  const out = [];
  for (const code of codes) {
    const clean = printable(code).trim();
    const label = names[code] ? `${names[code]} (${clean})` : clean;
    if (!clean || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * The audio format to warn about: one the player cannot play, when the file
 * has no audio it can. Null otherwise.
 * @param {string[]} codecs  as returned by probeFile
 */
export function unplayableAudio(codecs) {
  const base = (codecs || []).map((c) => String(c).replace(/ \(.*\)$/, ''));
  if (base.some((c) => PLAYABLE_AUDIO.has(c))) return null;
  return base.find((c) => UNPLAYABLE_AUDIO.has(c)) || null;
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

async function readMoov(handle, size) {
  let offset = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset + 8 <= size; i += 1) {
    const head = await readAt(handle, offset, 16);
    if (head.length < 8) return null;
    let boxSize = head.readUInt32BE(0);
    let header = 8;
    if (boxSize === 1) {
      if (head.length < 16) return null;
      boxSize = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset;
    }
    if (boxSize < header) return null;
    if (ascii(head, 4, 8) === 'moov') return readAt(handle, offset + header, Math.min(boxSize - header, MAX_MOOV_BYTES));
    offset += boxSize;
  }
  return null;
}

/**
 * @param {string} file
 * @returns {Promise<{container: string, codecs: string[]}>} names only
 */
export async function probeFile(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const container = sniffContainer(await readAt(handle, 0, Math.min(size, 4096)));
    let codecs = [];
    if (container.family === 'mp4') {
      const moov = await readMoov(handle, size);
      codecs = moov ? named(mp4SampleFormats(moov), MP4_NAMES) : [];
    } else if (container.family === 'matroska') {
      codecs = named(matroskaCodecIds(await readAt(handle, 0, Math.min(size, MATROSKA_SCAN_BYTES))), MATROSKA_NAMES);
    }
    return { container: container.name, codecs };
  } finally {
    await handle.close();
  }
}
