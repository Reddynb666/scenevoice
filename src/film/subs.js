// Subtitle files of a film: SubRip (.srt), SubStation Alpha (.ass, .ssa) and
// WebVTT (.vtt) read into lines of dialogue with times in seconds, and the bytes
// of such a file read into text. The lines say when someone speaks, which is
// where a description has no room (timeline.js), and what is said, which is
// where the names of the characters are heard.
// Nothing here opens a file: the caller reads the bytes.

/**
 * One line of dialogue: times in seconds, the words on one line without markup.
 * @typedef {{start: number, end: number, text: string}} SubtitleLine
 */

const BOM = /^﻿/;

/** The lines of a text file, whatever its line endings, without the byte order mark. */
function linesOf(text) {
  return String(text ?? '').replace(BOM, '').split(/\r\n|\r|\n/);
}

/**
 * "1:02:03,456", "0:01:02.34" or "02:03.456" (no hours) as seconds; NaN when it
 * is not a time. The digits after the comma or full stop are a decimal fraction,
 * so the centiseconds of ASS and the milliseconds of SRT read the same way.
 */
function clockSeconds(value) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/.exec(String(value).trim());
  if (!m) return NaN;
  // Counted in whole milliseconds: "00:01:02,345" comes out as the number 62.345,
  // not as 62 + 0.345 with the tail a sum of fractions leaves.
  const ms = m[4] ? Math.round(Number(`0.${m[4]}`) * 1000) : 0;
  return (((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms) / 1000;
}

const CLOCK = '(?:\\d+:)?\\d{1,2}:\\d{1,2}(?:[.,]\\d+)?';
/** "start --> end" of SRT and WebVTT; whatever follows the end time (cue settings, coordinates) is not read. */
const TIMING = new RegExp(`^\\s*(${CLOCK})\\s*-->\\s*(${CLOCK})(?=\\s|$)`);

/**
 * The cues of a SubRip or WebVTT text, each with its lines of text as written.
 * Both formats are "a line of times, then text until a blank line", so one walk
 * reads both, and it goes line by line rather than block by block because files
 * in the wild leave out index lines and, now and then, the blank line too.
 * Whatever stands outside a cue (an index, a cue identifier, the WEBVTT header
 * and its metadata) is passed over.
 * @param {string} text
 * @param {{vtt?: boolean}} [options]  vtt: NOTE, STYLE and REGION blocks are skipped whole
 */
function readCues(text, { vtt = false } = {}) {
  const cues = [];
  let open = null; // the cue whose text is being read
  let skipping = false; // inside a NOTE, STYLE or REGION block
  for (const line of linesOf(text)) {
    const trimmed = line.trim();
    if (!trimmed) {
      open = null;
      skipping = false;
      continue;
    }
    if (skipping) continue;
    const times = TIMING.exec(line);
    if (times) {
      // No blank line before these times: a bare number on the line above is this
      // cue's index, not the last words of the cue before.
      if (open && /^\d+$/.test(open.text[open.text.length - 1] || '')) open.text.pop();
      open = { start: clockSeconds(times[1]), end: clockSeconds(times[2]), text: [] };
      cues.push(open);
    } else if (open) {
      open.text.push(trimmed);
    } else if (vtt && /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(trimmed)) {
      // A comment may quote a line of times; it is still a comment.
      skipping = true;
    }
  }
  return cues;
}

/**
 * `strip` applied to a text up to its last `closer`, the rest left as it is.
 * Nothing after the last ">" or "}" can be a closed tag, so the result is the
 * same; but a pattern such as <[^>]*> tried from every opener that never
 * closes runs to the end of the text each time, and a damaged file with tens of
 * thousands of them would take time that grows with the square of its length.
 */
function upToLast(text, closer, strip) {
  const at = text.lastIndexOf(closer) + 1;
  return strip(text.slice(0, at)) + text.slice(at);
}

/**
 * Markup a player would not show as words: <i>, <b>, <font …>, the <c.class>,
 * <v Name> and <00:01.000> of WebVTT, and position blocks such as {\an8} that
 * SubRip files borrow from ASS. A <br> is a line break.
 */
function withoutMarkup(text) {
  const tags = upToLast(text, '>', (head) => head.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-z][^>]*>|<\d[\d:.]*>/gi, ''));
  return upToLast(tags, '}', (head) => head.replace(/\{\\[^}]*\}/g, ''));
}

/** The character references WebVTT defines. Read once, after the tags: "&lt;i&gt;" is the text "<i>", not a tag. */
const VTT_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '' });
const withoutEntities = (text) => text.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (whole, name) => VTT_ENTITIES[name]);

/** Text on one line: every run of spaces and line breaks is one space. */
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * What every parser returns: the lines that have words and a length, sorted by
 * start. Lines that start together keep the order of the file.
 * @param {SubtitleLine[]} lines
 * @returns {SubtitleLine[]}
 */
function inOrder(lines) {
  return lines
    .filter((l) => l.text && Number.isFinite(l.start) && Number.isFinite(l.end) && l.start >= 0 && l.end > l.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * Read a SubRip (.srt) file.
 * Accepted as found in the wild: a byte order mark, CRLF line ends, a comma or a
 * full stop before the milliseconds, missing index lines, a missing blank line
 * between cues. The lines of a cue are joined with a space; tags (<i>, <b>,
 * <font …>) and {\an8}-style blocks are removed; a cue with no words left, or
 * that ends before it starts, is dropped.
 * @param {string} text
 * @returns {SubtitleLine[]} sorted by start
 */
export function parseSrt(text) {
  return inOrder(readCues(text).map((cue) => ({ start: cue.start, end: cue.end, text: oneLine(withoutMarkup(cue.text.join(' '))) })));
}

/**
 * Read a WebVTT (.vtt) file.
 * The header (with any text after "WEBVTT" and its metadata lines), NOTE, STYLE
 * and REGION blocks, cue identifiers and the settings after the times are passed
 * over; hours are optional ("01:02.345"); tags (<c.x>, <v Name>, <i>, inline
 * timestamps) are removed and the format's character references (&amp; …) read.
 * @param {string} text
 * @returns {SubtitleLine[]} sorted by start
 */
export function parseVtt(text) {
  return inOrder(
    readCues(text, { vtt: true }).map((cue) => ({ start: cue.start, end: cue.end, text: oneLine(withoutEntities(withoutMarkup(cue.text.join(' ')))) })),
  );
}

/** The fields of a Dialogue line when the file gives no Format line (ASS v4+; SSA v4 has "Marked" for "Layer"). */
const ASS_FIELDS = Object.freeze(['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']);

/**
 * The fields of an event line. Only the first `count - 1` commas separate
 * fields: the last field is the text, and its own commas belong to it.
 */
function splitFields(body, count) {
  const parts = [];
  let rest = body;
  while (parts.length < count - 1) {
    const at = rest.indexOf(',');
    if (at < 0) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}

/**
 * Read a SubStation Alpha file (.ass, .ssa).
 * Only Dialogue lines count (not Comment, not the styles). The Format line of
 * [Events] says where the start, the end and the text are; without one the usual
 * order holds, the text being everything after the ninth comma. Blocks in braces
 * ({\i1}, {\pos(…)}, and notes a renderer does not show) are removed; \N, \n and
 * \h become a space, so the text is on one line like that of the other formats;
 * a line that draws a shape ({\p1} …) has no words and is skipped.
 * Times are "0:01:02.34", hundredths of a second.
 * @param {string} text
 * @returns {SubtitleLine[]} sorted by start
 */
export function parseAss(text) {
  let fields = ASS_FIELDS;
  let section = ''; // '' until the first [Section] line: a fragment with no headers is read as events
  const lines = [];
  for (const raw of linesOf(text)) {
    const line = raw.trim();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      continue;
    }
    const format = /^Format\s*:(.*)$/i.exec(line);
    if (format) {
      // The styles have a Format line of their own; only the one of [Events]
      // names the fields of a Dialogue line.
      const named = format[1].split(',').map((f) => f.trim().toLowerCase());
      if ((section === 'events' || section === '') && ['start', 'end', 'text'].every((f) => named.includes(f))) fields = named;
      continue;
    }
    const dialogue = /^Dialogue\s*:(.*)$/i.exec(line);
    if (!dialogue) continue;
    const parts = splitFields(dialogue[1], fields.length);
    if (parts.length < fields.length) continue;
    const written = parts[fields.indexOf('text')];
    // \p1 to \p9 switch drawing on: what follows is the outline of a shape (a
    // sign, a mask), not something anyone says. Blocks end at the last "}" (see upToLast).
    const blocks = written.slice(0, written.lastIndexOf('}') + 1).match(/\{[^}]*\}/g) || [];
    if (blocks.some((block) => /\\p[1-9]/.test(block))) continue;
    lines.push({
      start: clockSeconds(parts[fields.indexOf('start')]),
      end: clockSeconds(parts[fields.indexOf('end')]),
      text: oneLine(upToLast(written, '}', (head) => head.replace(/\{[^}]*\}/g, '')).replace(/\\[Nnh]/g, ' ')),
    });
  }
  return inOrder(lines);
}

const PARSERS = Object.freeze({ srt: parseSrt, ass: parseAss, vtt: parseVtt });
const FORMAT_OF_EXTENSION = new Map([['srt', 'srt'], ['ass', 'ass'], ['ssa', 'ass'], ['vtt', 'vtt']]);

/** The format a file name's extension stands for, or '' when it says nothing. */
function formatOfName(fileName) {
  const m = /\.([a-z0-9]+)\s*$/i.exec(String(fileName || ''));
  return (m && FORMAT_OF_EXTENSION.get(m[1].toLowerCase())) || '';
}

/** The format a text looks like: "WEBVTT" at the start, "[Script Info]" or a "Dialogue:" line, otherwise SubRip. */
function formatOfText(text) {
  const src = text.replace(BOM, '').trimStart();
  if (/^WEBVTT(?:\s|$)/.test(src)) return 'vtt';
  if (/^\s*\[Script Info\]/im.test(src) || /^\s*Dialogue\s*:/im.test(src)) return 'ass';
  return 'srt';
}

/**
 * Read a subtitle file of any of the three formats.
 * The extension of `fileName` decides (.srt, .ass, .ssa, .vtt); without a name,
 * or with another extension, what the text looks like decides. A file that turns
 * out empty that way is tried as the other formats before it is given up: files
 * are renamed without being converted, and a line of an SRT may begin with
 * "Dialogue:".
 * @param {string} text  the file's text (see decodeSubtitle for bytes)
 * @param {string} [fileName]  a name or a path; only its extension is read
 * @returns {SubtitleLine[]} sorted by start; [] when nothing in the text is a line of dialogue
 */
export function parseSubtitle(text, fileName) {
  const src = String(text ?? '');
  const order = [formatOfName(fileName), formatOfText(src), 'srt', 'ass'].filter(Boolean);
  for (const format of new Set(order)) {
    const lines = PARSERS[format](src);
    if (lines.length) return lines;
  }
  return [];
}

/** The bytes behind a typed array, a Node Buffer, a DataView or an ArrayBuffer, without copying. */
function bytesOf(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // By tag rather than instanceof: a buffer handed over from another window or worker is still a buffer.
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
  return new Uint8Array(0);
}

/** A copy with every pair of bytes swapped: big-endian UTF-16 as little-endian, which every runtime decodes. */
function swappedPairs(data) {
  const out = new Uint8Array(data.length - (data.length % 2));
  for (let i = 0; i < out.length; i += 2) {
    out[i] = data[i + 1];
    out[i + 1] = data[i];
  }
  return out;
}

/**
 * The text of a subtitle file from its bytes.
 * A byte order mark decides when there is one (UTF-8, UTF-16 little or big
 * endian). Without one the bytes are read as UTF-8 if they are valid UTF-8, and
 * as GB18030 otherwise: the encoding (with GBK and GB2312 inside it) that
 * Chinese subtitle files not in UTF-8 are almost always in. Text in GB18030 is
 * practically never valid UTF-8 by accident, so the strict test tells them apart.
 * @param {Uint8Array|ArrayBuffer} bytes  left unchanged
 * @returns {string} without the byte order mark; '' for no bytes
 */
export function decodeSubtitle(bytes) {
  if (typeof bytes === 'string') return bytes.replace(BOM, '');
  const data = bytesOf(bytes);
  if (!data.length) return '';
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder('utf-8').decode(data.subarray(3));
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16le').decode(swappedPairs(data.subarray(2)));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    // Not UTF-8: an older Chinese encoding, below.
  }
  try {
    return new TextDecoder('gb18030').decode(data);
  } catch {
    // A runtime built without the GB18030 table: text with gaps beats no text.
    return new TextDecoder('utf-8').decode(data);
  }
}
