// The pure parts of the main process: the native menu template, the codec
// names of a film, the diagnostic report and the shell's own log.

import { describe, expect, it } from 'vitest';

import { MAX_LINES, RingLog } from '../main/log.js';
import { actionItemId, buildMenuTemplate, commandItemId, itemsWithId } from '../main/menu.js';
import { matroskaCodecIds, mp4SampleFormats, sniffContainer, unplayableAudio } from '../main/probe.js';
import { formatReport, reportFileName } from '../main/report.js';
import { ACTIONS, MENU_COMMANDS } from '../shared/actions.js';
import { createT } from '../shared/i18n.js';

describe('buildMenuTemplate', () => {
  const build = (extra = {}) => buildMenuTemplate({ t: createT('zh_CN'), platform: 'win32', appName: 'SceneVoice', onCommand: () => {}, ...extra });

  it('has every listening action once, with its accelerator and a Chinese label', () => {
    const items = itemsWithId(build());
    for (const action of ACTIONS) {
      const found = items.filter((item) => item.id === actionItemId(action.id));
      expect(found, action.id).toHaveLength(1);
      expect(found[0].accelerator).toBe(action.accelerator);
      expect(/[一-鿿]/.test(found[0].label), found[0].label).toBe(true);
    }
  });

  it('gives no two items the same accelerator', () => {
    const accelerators = itemsWithId(build()).map((item) => item.accelerator).filter(Boolean);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });

  it('has the menu commands, among them "Save diagnostic report"', () => {
    const ids = itemsWithId(build()).map((item) => item.id);
    for (const name of MENU_COMMANDS) expect(ids).toContain(commandItemId(name));
    const report = itemsWithId(build()).find((item) => item.id === commandItemId('report'));
    expect(report.label).toBe('保存诊断报告…');
  });

  it('calls back with the item id', () => {
    const seen = [];
    const items = itemsWithId(build({ onCommand: (id) => seen.push(id) }));
    items.find((item) => item.id === 'action:who').click();
    items.find((item) => item.id === 'cmd:open').click();
    expect(seen).toEqual(['action:who', 'cmd:open']);
  });

  it('turns the listening items off while a dialog is open, and keeps the report', () => {
    const items = itemsWithId(build({ modal: true }));
    for (const action of ACTIONS) expect(items.find((item) => item.id === actionItemId(action.id)).enabled).toBe(false);
    expect(items.find((item) => item.id === 'cmd:report').enabled).toBe(true);
    expect(itemsWithId(build()).every((item) => item.enabled)).toBe(true);
  });

  it('ticks the checkbox when the screen reader reads descriptions', () => {
    const find = (template) => itemsWithId(template).find((item) => item.id === 'cmd:channel');
    expect(find(build({ channel: 'reader' }))).toMatchObject({ type: 'checkbox', checked: true });
    expect(find(build({ channel: 'app' })).checked).toBe(false);
  });

  it('adds access keys on Windows and the application menu on macOS', () => {
    expect(build()[0].label).toBe('文件(&F)');
    expect(build().map((top) => top.label)).toEqual(['文件(&F)', '收听(&L)', '视图(&V)', '帮助(&H)']);
    const mac = build({ platform: 'darwin' });
    expect(mac.map((top) => top.label)).toEqual(['SceneVoice', '文件', '收听', '视图', '帮助']);
    expect(mac[0].submenu.some((item) => item.role === 'quit')).toBe(true);
    expect(build().find((top) => top.label.startsWith('文件')).submenu.some((item) => item.role === 'quit')).toBe(true);
  });

  it('is in English for an English system', () => {
    const english = buildMenuTemplate({ t: createT('en'), platform: 'win32', appName: 'SceneVoice', onCommand: () => {} });
    expect(english.map((top) => top.label)).toEqual(['File(&F)', 'Listen(&L)', 'View(&V)', 'Help(&H)']);
    expect(itemsWithId(english).find((item) => item.id === 'action:who').label).toBe('Who is on screen');
  });

  it('shows the developer tools only when asked', () => {
    const roles = (template) => template.flatMap((top) => top.submenu.map((item) => item.role));
    expect(roles(build())).not.toContain('toggleDevTools');
    expect(roles(build({ devTools: true }))).toContain('toggleDevTools');
  });
});

/** An MP4 box: 4 bytes size, 4 bytes type, then the payload. */
function box(type, ...payload) {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function stsd(...formats) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(formats.length, 4);
  return box('stsd', head, ...formats.map((format) => box(format, Buffer.alloc(20))));
}

const track = (...formats) => box('trak', box('tkhd', Buffer.alloc(12)), box('mdia', box('minf', box('stbl', stsd(...formats)))));

describe('codec names', () => {
  it('recognises containers by their first bytes', () => {
    const ftyp = (brand) => Buffer.concat([box('ftyp', Buffer.from(brand, 'latin1'), Buffer.alloc(8)), Buffer.alloc(8)]);
    expect(sniffContainer(ftyp('isom'))).toEqual({ family: 'mp4', name: 'MP4 (isom)' });
    expect(sniffContainer(ftyp('qt  '))).toEqual({ family: 'mp4', name: 'QuickTime (qt)' });
    const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88]), Buffer.from('matroska'), Buffer.alloc(16)]);
    expect(sniffContainer(mkv)).toEqual({ family: 'matroska', name: 'Matroska' });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(16)]);
    expect(sniffContainer(webm).name).toBe('WebM');
    expect(sniffContainer(Buffer.concat([Buffer.from('RIFF\0\0\0\0AVI '), Buffer.alloc(8)])).name).toBe('AVI');
    expect(sniffContainer(Buffer.alloc(64)).family).toBe('unknown');
    expect(sniffContainer(Buffer.alloc(4)).family).toBe('unknown');
    expect(sniffContainer(null).family).toBe('unknown');
  });

  it('reads the sample formats of every track of an MP4', () => {
    const moov = Buffer.concat([box('mvhd', Buffer.alloc(16)), track('avc1'), track('mp4a'), track('ac-3'), track('tx3g')]);
    expect(mp4SampleFormats(moov)).toEqual(['avc1', 'mp4a', 'ac-3', 'tx3g']);
  });

  it('survives a truncated or nonsensical moov', () => {
    const moov = Buffer.concat([track('hvc1'), track('mp4a')]);
    expect(mp4SampleFormats(moov.subarray(0, moov.length - 30))).toEqual(['hvc1']);
    expect(mp4SampleFormats(Buffer.alloc(40))).toEqual([]);
    expect(mp4SampleFormats(Buffer.from([0, 0, 0, 3, 1, 2, 3, 4, 5]))).toEqual([]);
  });

  it('finds the codec ids of a Matroska file and ignores look-alikes', () => {
    const element = (id) => Buffer.concat([Buffer.from([0x86, 0x80 | id.length]), Buffer.from(id, 'latin1')]);
    const data = Buffer.concat([
      Buffer.alloc(10, 0x86),
      element('V_MPEGH/ISO/HEVC'),
      Buffer.from('junk A_FAKE without the element header'),
      element('A_DTS'),
      element('S_TEXT/UTF8'),
      element('nonsense'),
    ]);
    expect(matroskaCodecIds(data)).toEqual(['V_MPEGH/ISO/HEVC', 'A_DTS', 'S_TEXT/UTF8']);
  });

  it('warns about sound the player cannot play only when there is no sound it can', () => {
    expect(unplayableAudio(['H.264 (avc1)', 'AC-3 (ac-3)'])).toBe('AC-3');
    expect(unplayableAudio(['HEVC (V_MPEGH/ISO/HEVC)', 'DTS (A_DTS)'])).toBe('DTS');
    expect(unplayableAudio(['H.264 (avc1)', 'AAC (mp4a)', 'AC-3 (ac-3)'])).toBeNull();
    expect(unplayableAudio(['H.264 (avc1)', 'AAC (mp4a)'])).toBeNull();
    expect(unplayableAudio([])).toBeNull();
  });
});

describe('formatReport', () => {
  const data = {
    intro: '这份报告只包含版本信息。',
    generated: '2026-11-15T14:32:10.000Z',
    app: { name: 'scenevoice-desktop', version: '0.0.1', packaged: false },
    versions: { electron: '45.3.2', chrome: '156.0.0.0', node: '24.1.0', v8: '15.6' },
    os: { platform: 'win32', release: '10.0.22631', arch: 'x64', system: '10.0.22631' },
    language: { interface: 'zh_CN', system: 'zh-CN' },
    accessibility: true,
    channel: 'reader',
    gpu: { gpu_compositing: 'enabled', video_decode: 'disabled_software' },
    film: { container: 'Matroska', codecs: ['HEVC (V_MPEGH/ISO/HEVC)', 'AC-3 (A_AC3)'] },
    log: ['14:32:01.120 page: action who via key', '14:32:02.480 page: bus: answer #7 to the app voice (zh-CN)'],
  };

  it('holds the versions, the accessibility state, the GPU status and the log', () => {
    const text = formatReport(data);
    expect(text).toContain('Electron: 45.3.2');
    expect(text).toContain('Chromium: 156.0.0.0');
    expect(text).toContain('OS: win32 10.0.22631 x64');
    expect(text).toContain('Accessibility support enabled: yes');
    expect(text).toContain('Descriptions read by: the screen reader (live region)');
    expect(text).toContain('  gpu_compositing: enabled');
    expect(text).toContain('  video_decode: disabled_software');
    expect(text).toContain('Log (last 2 lines of the shell itself');
    expect(text).toContain('  14:32:01.120 page: action who via key');
    expect(text.split('\n')[1]).toBe('这份报告只包含版本信息。');
  });

  it('says about the film only its container and codec names', () => {
    const text = formatReport(data);
    expect(text).toContain('Opened film: container Matroska; codecs HEVC (V_MPEGH/ISO/HEVC), AC-3 (A_AC3)');
    expect(formatReport({ ...data, film: null })).toContain('Opened film: none');
    expect(formatReport({ ...data, film: { container: 'unknown', codecs: [] } })).toContain('codecs not recognised');
  });

  it('copes with a missing GPU status and an empty log', () => {
    const text = formatReport({ ...data, gpu: null, log: [], accessibility: false, channel: 'app' });
    expect(text).toContain('GPU feature status:\n  not available');
    expect(text).toContain('Accessibility support enabled: no');
    expect(text).toContain('Descriptions read by: the app voice');
  });

  it('names the file by date and time', () => {
    expect(reportFileName(new Date(2026, 10, 5, 9, 7))).toBe('scenevoice-diagnostic-20261105-0907.txt');
  });
});

describe('RingLog', () => {
  const at = () => new Date('2026-11-15T14:32:10.123Z');

  it('keeps the last 200 lines', () => {
    const log = new RingLog({ now: at });
    for (let i = 0; i < MAX_LINES + 50; i += 1) log.add(`line ${i}`);
    const lines = log.lines();
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('14:32:10.123 line 50');
    expect(lines[199]).toBe('14:32:10.123 line 249');
  });

  it('keeps every entry on one line and cuts long ones', () => {
    const log = new RingLog({ now: at });
    log.add('first\nsecond\tthird');
    log.add('x'.repeat(1000));
    log.add('   ');
    log.add(null);
    const lines = log.lines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('14:32:10.123 first second third');
    expect(lines[1].length).toBe('14:32:10.123 '.length + 300);
  });

  it('echoes each line when asked to, and returns a copy', () => {
    const echoed = [];
    const log = new RingLog({ now: at, echo: (line) => echoed.push(line) });
    log.add('hello');
    expect(echoed).toEqual(['14:32:10.123 hello']);
    log.lines().push('tampered');
    expect(log.lines()).toHaveLength(1);
  });
});
