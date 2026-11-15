import { describe, expect, it } from 'vitest';
import { decodeSubtitle, parseAss, parseSrt, parseSubtitle, parseVtt } from '../src/film/subs.js';

const file = (...lines) => lines.join('\n');

describe('parseSrt', () => {
  it('reads cues with their times in seconds and their text', () => {
    const srt = file(
      '1',
      '00:00:01,000 --> 00:00:03,500',
      'Hello there.',
      '',
      '2',
      '00:01:02,345 --> 00:01:04,000',
      'How are you?',
      '',
    );
    expect(parseSrt(srt)).toEqual([
      { start: 1, end: 3.5, text: 'Hello there.' },
      { start: 62.345, end: 64, text: 'How are you?' },
    ]);
  });

  it('counts hours, minutes, seconds and milliseconds', () => {
    expect(parseSrt('1\n01:02:03,004 --> 10:00:00,250\nx')).toEqual([{ start: 3723.004, end: 36000.25, text: 'x' }]);
  });

  it('accepts a full stop before the milliseconds', () => {
    expect(parseSrt('1\n00:01:02.345 --> 00:01:03.5\nHi')).toEqual([{ start: 62.345, end: 63.5, text: 'Hi' }]);
  });

  it('ignores a byte order mark and reads CRLF and bare CR line ends', () => {
    const crlf = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nFirst\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\n';
    const expected = [
      { start: 1, end: 2, text: 'First' },
      { start: 3, end: 4, text: 'Second' },
    ];
    expect(parseSrt(crlf)).toEqual(expected);
    expect(parseSrt(crlf.replace(/\r\n/g, '\r'))).toEqual(expected);
  });

  it('reads cues that have no index line', () => {
    const srt = file('00:00:01,000 --> 00:00:02,000', 'One', '', '00:00:03,000 --> 00:00:04,000', 'Two');
    expect(parseSrt(srt).map((l) => l.text)).toEqual(['One', 'Two']);
  });

  it('reads cues with no blank line between them, taking the bare number as the next index', () => {
    const srt = file('1', '00:00:01,000 --> 00:00:02,000', 'One', '2', '00:00:03,000 --> 00:00:04,000', 'Two');
    expect(parseSrt(srt)).toEqual([
      { start: 1, end: 2, text: 'One' },
      { start: 3, end: 4, text: 'Two' },
    ]);
  });

  it('keeps a line of text that is a number', () => {
    const srt = file('1', '00:00:01,000 --> 00:00:02,000', '42', '', '2', '00:00:03,000 --> 00:00:04,000', 'Really?');
    expect(parseSrt(srt).map((l) => l.text)).toEqual(['42', 'Really?']);
  });

  it('joins the lines of a cue with a space', () => {
    const srt = file('1', '00:00:01,000 --> 00:00:04,000', '- Where is he?', '- Gone.', '', '2', '00:00:05,000 --> 00:00:06,000', '你在哪儿？', '我在这儿。');
    expect(parseSrt(srt).map((l) => l.text)).toEqual(['- Where is he? - Gone.', '你在哪儿？ 我在这儿。']);
  });

  it('removes tags and position blocks and keeps the words', () => {
    const srt = file(
      '1',
      '00:00:01,000 --> 00:00:02,000',
      '<i>Italic</i> and <b>bold</b> and <u>under</u>',
      '',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      '<font color="#ffff00" size="12">Yellow</font> words',
      '',
      '3',
      '00:00:05,000 --> 00:00:06,000',
      '{\\an8}At the top',
      '',
      '4',
      '00:00:07,000 --> 00:00:08,000',
      '{\\pos(192,40)}<i>他来了</i>',
      '',
      '5',
      '00:00:09,000 --> 00:00:10,000',
      'One<br>two<br/>three',
    );
    expect(parseSrt(srt).map((l) => l.text)).toEqual(['Italic and bold and under', 'Yellow words', 'At the top', '他来了', 'One two three']);
  });

  it('leaves a less-than sign that is not a tag alone', () => {
    expect(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n3 < 5 and I <3 you')[0].text).toBe('3 < 5 and I <3 you');
  });

  it('drops cues with no words left', () => {
    const srt = file(
      '1',
      '00:00:01,000 --> 00:00:02,000',
      '',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      '<i></i>',
      '',
      '3',
      '00:00:05,000 --> 00:00:06,000',
      '{\\an8}',
      '',
      '4',
      '00:00:07,000 --> 00:00:08,000',
      'Words',
    );
    expect(parseSrt(srt)).toEqual([{ start: 7, end: 8, text: 'Words' }]);
  });

  it('drops cues that do not end after they start', () => {
    const srt = file('1', '00:00:05,000 --> 00:00:05,000', 'No length', '', '2', '00:00:09,000 --> 00:00:07,000', 'Backwards', '', '3', '00:00:10,000 --> 00:00:11,000', 'Fine');
    expect(parseSrt(srt)).toEqual([{ start: 10, end: 11, text: 'Fine' }]);
  });

  it('sorts by start, keeping the file order of cues that start together', () => {
    const srt = file(
      '1',
      '00:00:10,000 --> 00:00:11,000',
      'Third',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,000',
      'First A',
      '',
      '3',
      '00:00:01,000 --> 00:00:03,000',
      'First B',
      '',
      '4',
      '00:00:05,000 --> 00:00:06,000',
      'Second',
    );
    expect(parseSrt(srt).map((l) => l.text)).toEqual(['First A', 'First B', 'Second', 'Third']);
  });

  it('ignores whatever follows the end time', () => {
    expect(parseSrt('1\n00:00:01,000 --> 00:00:02,000 X1:100 X2:200 Y1:300 Y2:400\nPlaced')).toEqual([{ start: 1, end: 2, text: 'Placed' }]);
  });

  it('accepts the arrow without spaces around it and spaces around the times', () => {
    expect(parseSrt('1\n  00:00:01,000-->00:00:02,000\nTight')).toEqual([{ start: 1, end: 2, text: 'Tight' }]);
    expect(parseSrt('1\n\t00:00:01,000  -->  00:00:02,000  \nLoose')).toEqual([{ start: 1, end: 2, text: 'Loose' }]);
  });

  it('reads times with no fraction, a short one or a long one', () => {
    expect(parseSrt('1\n00:00:01 --> 00:00:02\nWhole seconds')).toEqual([{ start: 1, end: 2, text: 'Whole seconds' }]);
    expect(parseSrt('1\n0:00:01,5 --> 0:00:02,25\nTenths')).toEqual([{ start: 1.5, end: 2.25, text: 'Tenths' }]);
    expect(parseSrt('1\n00:00:01.123456 --> 00:00:02.999\nMicroseconds')).toEqual([{ start: 1.123, end: 2.999, text: 'Microseconds' }]);
  });

  it('does not attach stray text after the blank line that closes a cue', () => {
    const srt = file('1', '00:00:01,000 --> 00:00:02,000', 'Spoken', '', 'left over', '', '2', '00:00:03,000 --> 00:00:04,000', 'Next');
    expect(parseSrt(srt).map((l) => l.text)).toEqual(['Spoken', 'Next']);
  });

  it('returns nothing for empty, missing or unrelated input', () => {
    expect(parseSrt('')).toEqual([]);
    expect(parseSrt(undefined)).toEqual([]);
    expect(parseSrt(null)).toEqual([]);
    expect(parseSrt('just some words\nand more words')).toEqual([]);
    expect(parseSrt('1\n00:00:01 -> 00:00:02\nwrong arrow')).toEqual([]);
    expect(parseSrt('1\nabc --> def\nno times')).toEqual([]);
  });
});

describe('parseAss', () => {
  const header = [
    '[Script Info]',
    'Title: A film',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,20,&H00FFFFFF,0,0,2,10,10,10,1',
    '',
    '[Events]',
  ];
  const format = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

  it('reads Dialogue lines with times in hundredths of a second', () => {
    const ass = file(...header, format, 'Dialogue: 0,0:01:02.34,0:01:04.00,Default,,0,0,0,,Hello there.', 'Dialogue: 0,1:00:00.50,1:00:02.05,Default,,0,0,0,,一小时以后');
    expect(parseAss(ass)).toEqual([
      { start: 62.34, end: 64, text: 'Hello there.' },
      { start: 3600.5, end: 3602.05, text: '一小时以后' },
    ]);
  });

  it('keeps the commas of the text: the text is everything after the ninth comma', () => {
    const ass = file(...header, format, 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Well, yes, of course, sir.', 'Dialogue: 0,0:00:04.00,0:00:05.00,Default,Anna,0,0,0,,好, 走吧,快点');
    expect(parseAss(ass).map((l) => l.text)).toEqual(['Well, yes, of course, sir.', '好, 走吧,快点']);
  });

  it('skips Comment lines and every other kind of event', () => {
    const ass = file(
      ...header,
      format,
      'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a note for the translator',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Spoken',
      'Picture: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,logo.png',
    );
    expect(parseAss(ass)).toEqual([{ start: 3, end: 4, text: 'Spoken' }]);
  });

  it('does not mistake the Format line of the styles for that of the events', () => {
    // No Format line under [Events]: the usual order holds, not the one of [V4+ Styles].
    const ass = file(...header, 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Still read');
    expect(parseAss(ass)).toEqual([{ start: 1, end: 2, text: 'Still read' }]);
  });

  it('uses the usual order when there is no Format line, or no header at all', () => {
    expect(parseAss('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Bare line, with a comma')).toEqual([{ start: 1, end: 2.5, text: 'Bare line, with a comma' }]);
    expect(parseAss('[Events]\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Under a header')).toEqual([{ start: 1, end: 2.5, text: 'Under a header' }]);
  });

  it('honours the field order of the Format line of [Events]', () => {
    const short = file('[Events]', 'Format: Start, End, Style, Text', 'Dialogue: 0:00:01.00,0:00:02.00,Default,Hello, there');
    expect(parseAss(short)).toEqual([{ start: 1, end: 2, text: 'Hello, there' }]);

    const moved = file('[Events]', 'Format: Layer, Style, Name, End, Start, MarginL, MarginR, MarginV, Effect, Text', 'Dialogue: 0,Default,Anna,0:00:06.00,0:00:05.00,0,0,0,,你好，世界, 再见');
    expect(parseAss(moved)).toEqual([{ start: 5, end: 6, text: '你好，世界, 再见' }]);
  });

  it('reads the Format line whatever its spacing and letter case', () => {
    const ass = file('[events]', 'format:start,END,  Text', 'dialogue:0:00:01.00,0:00:02.00,Close, together');
    expect(parseAss(ass)).toEqual([{ start: 1, end: 2, text: 'Close, together' }]);
  });

  it('ignores a Format line that does not name start, end and text', () => {
    const ass = file('[Events]', 'Format: Layer, Style', 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Usual order');
    expect(parseAss(ass)).toEqual([{ start: 1, end: 2, text: 'Usual order' }]);
  });

  it('reads the older SSA layout', () => {
    const ssa = file(
      '[Script Info]',
      'ScriptType: v4.00',
      '',
      '[V4 Styles]',
      'Format: Name, Fontname, Fontsize',
      '',
      '[Events]',
      'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,NTP,0000,0000,0000,,Hello, old format',
    );
    expect(parseAss(ssa)).toEqual([{ start: 1, end: 2, text: 'Hello, old format' }]);
  });

  it('removes override blocks and notes in braces', () => {
    const ass = file(
      ...header,
      format,
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Italic{\\i0} words',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an8\\fad(200,200)}Top{\\b1}Bold',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\pos(320,40)}他来了',
      'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,Shown{not shown}',
    );
    expect(parseAss(ass).map((l) => l.text)).toEqual(['Italic words', 'TopBold', '他来了', 'Shown']);
  });

  it('turns \\N, \\n and \\h into a space, so the text is on one line', () => {
    const ass = file(...header, format, 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,First line\\NSecond line', 'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,soft\\nbreak and hard\\hspace', 'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,你好\\N世界');
    expect(parseAss(ass).map((l) => l.text)).toEqual(['First line Second line', 'soft break and hard space', '你好 世界']);
  });

  it('skips lines that draw a shape, and keeps lines whose tags only look like \\p', () => {
    const ass = file(
      ...header,
      format,
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an7\\pos(0,0)\\p4\\c&H000000&}m 0 0 l 8 0 8 8',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\pos(10,10)}Positioned words',
      'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\pbo-20}Baseline words',
      'Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,{\\p0}Drawing off',
    );
    expect(parseAss(ass).map((l) => l.text)).toEqual(['Positioned words', 'Baseline words', 'Drawing off']);
  });

  it('drops lines with no words, lines that do not end after they start, and broken lines', () => {
    const ass = file(
      ...header,
      format,
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}',
      'Dialogue: 0,0:00:03.00,0:00:03.00,Default,,0,0,0,,No length',
      'Dialogue: 0,0:00:06.00,0:00:05.00,Default,,0,0,0,,Backwards',
      'Dialogue: 0,soon,later,Default,,0,0,0,,No times',
      'Dialogue: too, few, fields',
      'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,Kept',
    );
    expect(parseAss(ass)).toEqual([{ start: 7, end: 8, text: 'Kept' }]);
  });

  it('sorts by start and reads a byte order mark and CRLF', () => {
    const ass = `\uFEFF${[...header, format, 'Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,Later', 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Sooner'].join('\r\n')}\r\n`;
    expect(parseAss(ass)).toEqual([
      { start: 1, end: 2, text: 'Sooner' },
      { start: 9, end: 10, text: 'Later' },
    ]);
  });

  it('returns nothing for empty, missing or unrelated input', () => {
    expect(parseAss('')).toEqual([]);
    expect(parseAss(undefined)).toEqual([]);
    expect(parseAss('1\n00:00:01,000 --> 00:00:02,000\nAn SRT cue')).toEqual([]);
  });
});

describe('parseVtt', () => {
  it('reads cues and passes over the header, comments, styles, regions, identifiers and settings', () => {
    const vtt = file(
      'WEBVTT - Subtitles of the film',
      'Kind: captions',
      'Language: en',
      '',
      'NOTE',
      'Made by hand.',
      'Two lines of comment.',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      'REGION',
      'id:top',
      'width:40%',
      '',
      'intro',
      '00:00:01.000 --> 00:00:04.500 line:0 position:20% align:start',
      'Hello there.',
      '',
      'NOTE a comment on one line',
      '',
      '2',
      '00:00:05.000 --> 00:00:07.250',
      'Second cue',
      '',
    );
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 4.5, text: 'Hello there.' },
      { start: 5, end: 7.25, text: 'Second cue' },
    ]);
  });

  it('reads a bare header and a header with no blank line after it', () => {
    expect(parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nHi')).toEqual([{ start: 1, end: 2, text: 'Hi' }]);
    expect(parseVtt('WEBVTT\n00:01.000 --> 00:02.000\nHi')).toEqual([{ start: 1, end: 2, text: 'Hi' }]);
  });

  it('reads times without hours', () => {
    const vtt = file('WEBVTT', '', '01:02.345 --> 01:05.000', 'No hours', '', '59:59.900 --> 01:00:01.000', 'Across the hour');
    expect(parseVtt(vtt)).toEqual([
      { start: 62.345, end: 65, text: 'No hours' },
      { start: 3599.9, end: 3601, text: 'Across the hour' },
    ]);
  });

  it('does not read a line of times quoted inside a comment', () => {
    const vtt = file('WEBVTT', '', 'NOTE', '00:00:01.000 --> 00:00:02.000', 'not a cue', '', '00:00:03.000 --> 00:00:04.000', 'A cue');
    expect(parseVtt(vtt)).toEqual([{ start: 3, end: 4, text: 'A cue' }]);
  });

  it('removes class, voice, language and timestamp tags', () => {
    const vtt = file(
      'WEBVTT',
      '',
      '00:01.000 --> 00:02.000',
      '<v Roger Bingham>Hello <c.yellow.bg_blue>there</c></v>',
      '',
      '00:03.000 --> 00:04.000',
      'Never<00:00:03.500> drink<00:00:03.800> <c>liquid</c> nitrogen',
      '',
      '00:05.000 --> 00:06.000',
      '<v 小明>你好</v> <i>世界</i> <lang en>hello</lang>',
    );
    expect(parseVtt(vtt).map((l) => l.text)).toEqual(['Hello there', 'Never drink liquid nitrogen', '你好 世界 hello']);
  });

  it('reads the character references of the format once', () => {
    const vtt = file('WEBVTT', '', '00:01.000 --> 00:02.000', 'Tom &amp; Jerry &lt;3&nbsp;you &gt; me&lrm;', '', '00:03.000 --> 00:04.000', '&amp;lt; and &lt;i&gt;');
    expect(parseVtt(vtt).map((l) => l.text)).toEqual(['Tom & Jerry <3 you > me', '&lt; and <i>']);
  });

  it('joins the lines of a cue with a space and drops cues with no words', () => {
    const vtt = file('WEBVTT', '', '00:01.000 --> 00:03.000', '- 你去哪儿？', '- 回家。', '', '00:04.000 --> 00:05.000', '<i></i>', '', '00:06.000 --> 00:07.000', '', '00:08.000 --> 00:09.000', 'Words');
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 3, text: '- 你去哪儿？ - 回家。' },
      { start: 8, end: 9, text: 'Words' },
    ]);
  });

  it('sorts by start, drops cues that do not end after they start, and reads a byte order mark and CRLF', () => {
    const vtt = '\uFEFFWEBVTT\r\n\r\n00:09.000 --> 00:10.000\r\nLater\r\n\r\n00:05.000 --> 00:04.000\r\nBackwards\r\n\r\n00:01.000 --> 00:02.000\r\nSooner\r\n';
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 2, text: 'Sooner' },
      { start: 9, end: 10, text: 'Later' },
    ]);
  });

  it('returns nothing for a header alone, or for empty or missing input', () => {
    expect(parseVtt('WEBVTT')).toEqual([]);
    expect(parseVtt('WEBVTT\n\nNOTE nothing else\n')).toEqual([]);
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt(undefined)).toEqual([]);
  });
});

describe('a damaged file with thousands of tags that never close', () => {
  const HEAD = '1\n00:00:01,000 --> 00:00:02,000\n';
  const DIALOGUE = 'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,';
  const timed = (run) => {
    const started = performance.now();
    const out = run();
    return { out, ms: performance.now() - started };
  };

  it('is read in a moment: SRT and WebVTT with unclosed <tags and {\\blocks, ASS with unclosed {blocks', () => {
    // Each of these took five to ten seconds: every opener was scanned to the end of the text.
    const cases = [
      () => parseSrt(`${HEAD}${'<a'.repeat(80000)}`),
      () => parseSrt(`${HEAD}${'{\\a'.repeat(80000)}`),
      () => parseSrt(`${HEAD}${Array(50000).fill('<a').join('\n')}`),
      () => parseVtt(`WEBVTT\n\n${HEAD}${'<a'.repeat(80000)}`),
      () => parseVtt(`WEBVTT\n\n${HEAD}${'<br '.repeat(80000)}`),
      () => parseAss(`${DIALOGUE}${'{'.repeat(80000)}`),
      () => parseAss(`${DIALOGUE}${'{\\p1'.repeat(80000)}`),
      // A closer early in the text, or after every other opener, changes nothing about the time.
      () => parseSrt(`${HEAD}x>${'<a'.repeat(80000)}`),
      () => parseSrt(`${HEAD}${'<a>'.repeat(40000)}${'<a'.repeat(40000)}`),
      () => parseAss(`${DIALOGUE}{x}${'{'.repeat(80000)}`),
    ];
    for (const [index, run] of cases.entries()) {
      const { out, ms } = timed(run);
      expect(ms, `case ${index}`).toBeLessThan(1000);
      expect(out.length, `case ${index}`).toBeLessThanOrEqual(1);
    }
  }, 60000);

  it('reads what it read before: an opener that never closes stays as text, the rest goes', () => {
    const srt = (text) => parseSrt(`${HEAD}${text}`)[0]?.text;
    expect(srt('<a<a<a')).toBe('<a<a<a');
    expect(srt('Hi <i>there</i> <b')).toBe('Hi there <b');
    expect(srt('x<y, <i>z</i>')).toBe('xz');
    expect(srt('<a <b>c')).toBe('c');
    expect(srt('{\\an8 {\\i1}x')).toBe('x');
    expect(srt('{\\an8}Up {\\i1')).toBe('Up {\\i1');
    expect(srt('a<br>b<br')).toBe('a b<br');
    expect(srt('1 > 0 and <i>so on')).toBe('1 > 0 and so on');
    expect(parseVtt(`WEBVTT\n\n${HEAD}<v Anna>Hi &lt;there&gt; <c`)[0].text).toBe('Hi <there> <c');
    const ass = (text) => parseAss(`${DIALOGUE}${text}`)[0]?.text;
    expect(ass('{a{b}c')).toBe('c');
    expect(ass('{\\fad(1,2){c}}x')).toBe('}x');
    expect(ass('Hi {\\i1}there{\\i0} {note')).toBe('Hi there {note');
    expect(ass('{{{')).toBe('{{{');
    // A drawing is still a drawing when a brace opens after it and never closes.
    expect(ass('{\\p1}m 0 0 l 10 10 {')).toBeUndefined();
    expect(ass('{\\p1{x}m 0 0')).toBeUndefined();
    // And a \p1 in a block that never closes switches nothing on.
    expect(ass('words {\\p1')).toBe('words {\\p1');
  });
});

describe('parseSubtitle', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nFrom an SRT';
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFrom a &amp; VTT';
  const ass = '[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,From an{\\i1} ASS';

  it('picks the parser by the extension of the file name', () => {
    expect(parseSubtitle(srt, 'film.srt')).toEqual([{ start: 1, end: 2, text: 'From an SRT' }]);
    expect(parseSubtitle(vtt, 'film.vtt')).toEqual([{ start: 1, end: 2, text: 'From a & VTT' }]);
    expect(parseSubtitle(ass, 'film.ass')).toEqual([{ start: 1, end: 2, text: 'From an ASS' }]);
    expect(parseSubtitle(ass, 'film.ssa')).toEqual([{ start: 1, end: 2, text: 'From an ASS' }]);
  });

  it('reads the extension whatever its case, and from a path with other full stops', () => {
    expect(parseSubtitle(ass, 'FILM.ASS')).toHaveLength(1);
    expect(parseSubtitle(srt, 'C:\\films\\我的电影.2019.zh.SRT')).toHaveLength(1);
    expect(parseSubtitle(vtt, '/home/me/films/a.b.c.Vtt')).toEqual([{ start: 1, end: 2, text: 'From a & VTT' }]);
  });

  it('lets the extension decide over what the text looks like', () => {
    // A line of an SRT that begins with "Dialogue:" would be taken for ASS by its looks.
    const tricky = '1\n00:00:01,000 --> 00:00:02,000\nDialogue: the art of talking';
    expect(parseSubtitle(tricky, 'film.srt')).toEqual([{ start: 1, end: 2, text: 'Dialogue: the art of talking' }]);
    // Only the VTT parser reads character references.
    const amp = '1\n00:00:01,000 --> 00:00:02,000\nTom &amp; Jerry';
    expect(parseSubtitle(amp, 'film.srt')[0].text).toBe('Tom &amp; Jerry');
    expect(parseSubtitle(amp, 'film.vtt')[0].text).toBe('Tom & Jerry');
  });

  it('goes by the text when there is no name or the extension says nothing', () => {
    for (const name of [undefined, '', 'film', 'film.txt', 'film.sub']) {
      expect(parseSubtitle(srt, name)).toEqual([{ start: 1, end: 2, text: 'From an SRT' }]);
      expect(parseSubtitle(vtt, name)).toEqual([{ start: 1, end: 2, text: 'From a & VTT' }]);
      expect(parseSubtitle(ass, name)).toEqual([{ start: 1, end: 2, text: 'From an ASS' }]);
    }
  });

  it('takes "WEBVTT" at the start for WebVTT, behind a byte order mark and blank lines too', () => {
    expect(parseSubtitle(`\uFEFF\n${vtt}`)[0].text).toBe('From a & VTT');
  });

  it('takes a "Dialogue:" line for ASS when there is no [Script Info]', () => {
    expect(parseSubtitle('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Bare{\\b1} line')).toEqual([{ start: 1, end: 2, text: 'Bare line' }]);
  });

  it('tries the other formats when the first choice finds nothing', () => {
    // Renamed, not converted.
    expect(parseSubtitle(ass, 'film.srt')).toEqual([{ start: 1, end: 2, text: 'From an ASS' }]);
    expect(parseSubtitle(srt, 'film.ass')).toEqual([{ start: 1, end: 2, text: 'From an SRT' }]);
    // By its looks this is ASS; it is an SRT.
    expect(parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nDialogue: the art of talking')).toEqual([{ start: 1, end: 2, text: 'Dialogue: the art of talking' }]);
  });

  it('returns nothing for empty, missing or unrelated input, whatever the name', () => {
    expect(parseSubtitle('')).toEqual([]);
    expect(parseSubtitle(undefined, 'film.srt')).toEqual([]);
    expect(parseSubtitle(null)).toEqual([]);
    expect(parseSubtitle('Once upon a time.\nThe end.', 'film.ass')).toEqual([]);
    expect(parseSubtitle(srt, 'film.constructor')).toHaveLength(1);
  });

  it('returns lines sorted by start, each ending after it starts, for every format', () => {
    const mixedSrt = '1\n00:00:09,000 --> 00:00:10,000\nB\n\n2\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:05,000 --> 00:00:05,000\nNone';
    const mixedVtt = 'WEBVTT\n\n00:09.000 --> 00:10.000\nB\n\n00:01.000 --> 00:02.000\nA\n\n00:05.000 --> 00:05.000\nNone';
    const mixedAss = 'Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,B\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,A\nDialogue: 0,0:00:05.00,0:00:05.00,Default,,0,0,0,,None';
    for (const text of [mixedSrt, mixedVtt, mixedAss]) {
      const lines = parseSubtitle(text);
      expect(lines.map((l) => l.text)).toEqual(['A', 'B']);
      expect(lines.every((l) => l.end > l.start)).toBe(true);
    }
  });
});

describe('decodeSubtitle', () => {
  const utf8 = (text) => new TextEncoder().encode(text);
  const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
  /** UTF-16 with its byte order mark. */
  function utf16(text, bigEndian) {
    const out = bigEndian ? [0xfe, 0xff] : [0xff, 0xfe];
    for (let i = 0; i < text.length; i += 1) {
      const unit = text.charCodeAt(i);
      out.push(...(bigEndian ? [unit >> 8, unit & 0xff] : [unit & 0xff, unit >> 8]));
    }
    return new Uint8Array(out);
  }
  /** "你好" in GBK, the bytes a Chinese subtitle file not in UTF-8 has. */
  const NI_HAO_GBK = [0xc4, 0xe3, 0xba, 0xc3];

  it('reads UTF-8, Chinese included', () => {
    expect(decodeSubtitle(utf8('Hello'))).toBe('Hello');
    expect(decodeSubtitle(utf8('你好，世界'))).toBe('你好，世界');
    expect(decodeSubtitle(utf8('1\n00:00:01,000 --> 00:00:02,000\n早上好\n'))).toBe('1\n00:00:01,000 --> 00:00:02,000\n早上好\n');
  });

  it('removes the UTF-8 byte order mark', () => {
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('你好')]))).toBe('你好');
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe('');
  });

  it('reads UTF-16 of either byte order by its byte order mark', () => {
    const text = '1\r\n00:00:01,000 --> 00:00:02,000\r\n你好, 𠮷野家 and café\r\n';
    expect(decodeSubtitle(utf16(text, false))).toBe(text);
    expect(decodeSubtitle(utf16(text, true))).toBe(text);
  });

  it('reads GBK bytes that are not valid UTF-8 as GB18030', () => {
    expect(decodeSubtitle(new Uint8Array(NI_HAO_GBK))).toBe('你好');
  });

  it('reads a whole GBK subtitle file into lines', () => {
    const bytes = new Uint8Array([...ascii('1\r\n00:00:01,000 --> 00:00:02,500\r\n'), ...NI_HAO_GBK, ...ascii('\r\n')]);
    expect(parseSubtitle(decodeSubtitle(bytes), '电影.srt')).toEqual([{ start: 1, end: 2.5, text: '你好' }]);
  });

  it('accepts an ArrayBuffer, a view into a larger buffer and other typed arrays', () => {
    expect(decodeSubtitle(new Uint8Array(NI_HAO_GBK).buffer)).toBe('你好');
    expect(decodeSubtitle(utf8('你好').buffer)).toBe('你好');
    const padded = new Uint8Array([0x41, 0x42, ...NI_HAO_GBK, 0x43]);
    expect(decodeSubtitle(new Uint8Array(padded.buffer, 2, 4))).toBe('你好');
    expect(decodeSubtitle(padded.subarray(0, 2))).toBe('AB');
    expect(decodeSubtitle(new DataView(padded.buffer, 2, 4))).toBe('你好');
  });

  it('returns an empty string for no bytes or no input', () => {
    expect(decodeSubtitle(new Uint8Array(0))).toBe('');
    expect(decodeSubtitle(new ArrayBuffer(0))).toBe('');
    expect(decodeSubtitle(undefined)).toBe('');
    expect(decodeSubtitle(null)).toBe('');
    expect(decodeSubtitle(42)).toBe('');
  });

  it('passes text that is already decoded through, without its byte order mark', () => {
    expect(decodeSubtitle('\uFEFF你好')).toBe('你好');
  });

  it('leaves the bytes it was given unchanged', () => {
    const big = utf16('你好', true);
    const gbk = new Uint8Array(NI_HAO_GBK);
    const bigBefore = [...big];
    decodeSubtitle(big);
    decodeSubtitle(gbk);
    expect([...big]).toEqual(bigBefore);
    expect([...gbk]).toEqual(NI_HAO_GBK);
  });

  it('gives text every parser reads, whatever the encoding of the file', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\n你好\n';
    const expected = [{ start: 1, end: 2, text: '你好' }];
    expect(parseSubtitle(decodeSubtitle(utf8(vtt)))).toEqual(expected);
    expect(parseSubtitle(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(vtt)])))).toEqual(expected);
    expect(parseSubtitle(decodeSubtitle(utf16(vtt, false)))).toEqual(expected);
    expect(parseSubtitle(decodeSubtitle(utf16(vtt, true)))).toEqual(expected);
  });
});
