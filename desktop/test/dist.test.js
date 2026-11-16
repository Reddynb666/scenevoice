// The packaging scripts' pure parts: the environment a build runs in (never
// signing), the sample clip left out unless asked for, the Windows zip with
// its one folder, the application icon made from the extension's artwork,
// reading the file list of an asar archive, and what counts as a problem in a
// package (scripts/check-dist.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_FOLDERS, ELECTRON_LICENCES, OWN_RESOURCES, SAMPLE_IN_ASAR, asarFiles, asarHeaderBytes, asarProblems, findLocalPath, hasIcon, icoImages, packageProblems, sizeWords, zipProblems } from '../scripts/check-dist.mjs';
import { SAMPLE_EXCLUDED, SIGNING_VARIABLES, TARGETS, WIN_UNPACKED, buildEnvironment, leftovers, wantsSample, winZip, withSample } from '../scripts/dist.mjs';
import { ARTWORK_SIZES, ICNS_TYPES, ICO_SIZES, buildIcns, buildIco, decodePng, encodePng, makeIcons, pictureAt, resize } from '../scripts/make-icon.mjs';
import { crc32, dosTime, fileReader, filesUnder, zipEntries, zipEntryData, zipFolder } from '../scripts/zip.mjs';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scenevoice-dist-test-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** An asar archive with this header and no file data. */
function asarWith(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = Math.ceil(json.length / 4) * 4;
  const out = Buffer.alloc(16 + padded);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(8 + padded, 4);
  out.writeUInt32LE(4 + padded, 8);
  out.writeUInt32LE(json.length, 12);
  json.copy(out, 16);
  return out;
}

const GOOD = [
  'package.json',
  'main/index.js',
  'main/preload.cjs',
  'ipc/contract.js',
  'shared/actions.js',
  'locales/zh_CN.mjs',
  'renderer/index.html',
  'renderer/sample/narration.json',
].map((file) => ({ path: file, size: 1, unpacked: false }));
const WITH_SAMPLE = [...GOOD, { path: SAMPLE_IN_ASAR, size: 1, unpacked: false }];

describe('the build environment', () => {
  it('never signs: discovery is off and every certificate variable is dropped', () => {
    const env = buildEnvironment({ PATH: '/bin', CSC_LINK: 'x', WIN_CSC_LINK: 'y', CSC_KEY_PASSWORD: 'z', ELECTRON_MIRROR: 'm' });
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    for (const name of SIGNING_VARIABLES) expect(Object.hasOwn(env, name), name).toBe(false);
    expect(env.PATH).toBe('/bin');
    expect(env.ELECTRON_MIRROR).toBe('m');
  });

  it('builds Windows x64 and macOS arm64 and never publishes', () => {
    expect(TARGETS.win).toEqual(['--win', '--x64', '--publish', 'never']);
    expect(TARGETS.mac).toEqual(['--mac', '--arm64', '--publish', 'never']);
  });

  it('leaves the sample clip out unless it is asked for', () => {
    // The default: the clip's licence question is open (THIRD-PARTY-NOTICES.md).
    expect(pkg.build.files).toContain(SAMPLE_EXCLUDED);
    expect(SAMPLE_EXCLUDED).toBe(`!${SAMPLE_IN_ASAR}`);
    expect(wantsSample([])).toBe(false);
    expect(wantsSample(['win'])).toBe(false);
    expect(wantsSample(['win', '--no-sample'])).toBe(false);
    expect(wantsSample(['win', '--with-sample'])).toBe(true);
    // Said both ways, the careful one wins.
    expect(wantsSample(['win', '--with-sample', '--no-sample'])).toBe(false);
  });

  it('puts the clip in by naming it after the pattern that excludes it', () => {
    // Two patterns, so that electron-builder adds them to the list of package.json instead of
    // replacing it: one the list already has (dropped as a repeat), and the clip itself, which
    // then comes after the exclusion and overrides it. (Seen with electron-builder 26.18 in an
    // unpacked build: 27 files, the clip among them; the same patterns without the exclusion,
    // which was the first attempt, left the clip out.)
    expect(withSample(['main/**', 'renderer/**', SAMPLE_EXCLUDED])).toEqual(['-c.files=main/**', `-c.files=${SAMPLE_IN_ASAR}`]);
    const args = withSample(pkg.build.files);
    expect(args).toHaveLength(2);
    expect(pkg.build.files).toContain(args[0].replace('-c.files=', ''));
    expect(args[1]).toBe('-c.files=renderer/sample/sample.mp4');
    // If package.json stopped excluding it, "with" and "without" would be the same build: say so.
    expect(() => withSample(['main/**'])).toThrow(/no longer excludes/);
  });

  it('names the Windows zip and the one folder inside it alike, in plain ASCII', () => {
    expect(winZip('0.0.1')).toEqual({ file: 'SceneVoice-K3-Test-0.0.1-win-x64.zip', folder: 'SceneVoice-K3-Test-0.0.1-win-x64' });
    expect(winZip(pkg.version).file).toBe(pkg.build.artifactName.replace('${version}', pkg.version).replace('${os}', 'win').replace('${arch}', 'x64').replace('${ext}', 'zip'));
    expect(WIN_UNPACKED).toBe('win-unpacked');
  });

  it('deletes the builder\'s by-products and keeps the packages', () => {
    const names = ['SceneVoice-K3-Test-0.0.1-win-x64.zip', 'SceneVoice-K3-Test-0.0.1-win-x64-setup.exe', 'SceneVoice-K3-Test-0.0.1-mac-arm64.zip', 'SceneVoice-K3-Test-0.0.1-mac-arm64.zip.blockmap', 'builder-debug.yml', 'scenevoice-desktop-0.0.1-x64.nsis.7z', 'win-unpacked', 'mac-arm64'];
    expect(leftovers(names)).toEqual(['SceneVoice-K3-Test-0.0.1-mac-arm64.zip.blockmap', 'builder-debug.yml', 'scenevoice-desktop-0.0.1-x64.nsis.7z']);
  });
});

describe('reading an asar archive', () => {
  it('lists the files of nested folders with their sizes', () => {
    const archive = asarWith({
      files: {
        'package.json': { size: 120, offset: '0' },
        renderer: { files: { 'index.html': { size: 10, offset: '120' }, sample: { files: { 'sample.mp4': { size: 3001063, offset: '130' } } } } },
        main: { files: { 'index.js': { size: 5, offset: '3001193', unpacked: true } } },
      },
    });
    expect(asarFiles(archive)).toEqual([
      { path: 'main/index.js', size: 5, unpacked: true },
      { path: 'package.json', size: 120, unpacked: false },
      { path: 'renderer/index.html', size: 10, unpacked: false },
      { path: 'renderer/sample/sample.mp4', size: 3001063, unpacked: false },
    ]);
    expect(asarHeaderBytes(archive.subarray(0, 16))).toBeLessThanOrEqual(archive.length);
  });

  it('refuses what is not an archive', () => {
    expect(() => asarFiles(Buffer.from('PK'))).toThrow(/too short/);
    expect(() => asarFiles(Buffer.alloc(32))).toThrow(/size pickle/);
    const cut = asarWith({ files: { a: { size: 1, offset: '0' } } }).subarray(0, 20);
    expect(() => asarFiles(cut)).toThrow(/past the end/);
  });
});

describe('what is wrong with an app.asar', () => {
  it('accepts the folders the app runs from, without the sample clip', () => {
    expect(asarProblems(GOOD)).toEqual([]);
    expect(APP_FOLDERS).toEqual(['main', 'ipc', 'shared', 'locales', 'renderer']);
  });

  it('names node_modules, source maps, stray files and unpacked files', () => {
    const bad = [
      ...GOOD,
      { path: 'node_modules/axe-core/axe.js', size: 1 },
      { path: 'renderer/app.js.map', size: 1 },
      { path: 'test/keys.test.js', size: 1 },
      { path: 'main/native.node', size: 1, unpacked: true },
    ];
    const problems = asarProblems(bad).join('\n');
    expect(problems).toMatch(/node_modules: node_modules\/axe-core\/axe\.js/);
    expect(problems).toMatch(/source map: renderer\/app\.js\.map/);
    expect(problems).toMatch(/outside the app's folders: test\/keys\.test\.js/);
    expect(problems).toMatch(/unpacked: main\/native\.node/);
  });

  it('refuses the sample clip in a build that was not asked to carry it, and misses it in one that was', () => {
    expect(asarProblems(WITH_SAMPLE).join('\n')).toMatch(/holds the sample clip .* only with --with-sample/);
    expect(asarProblems(WITH_SAMPLE, { sample: true })).toEqual([]);
    expect(asarProblems(GOOD, { sample: true }).join('\n')).toMatch(/lacks the sample clip/);
  });

  it('misses a folder or the package.json', () => {
    expect(asarProblems(GOOD.filter((f) => !f.path.startsWith('ipc/'))).join('\n')).toMatch(/lacks the ipc\/ folder/);
    expect(asarProblems(GOOD.filter((f) => f.path !== 'package.json')).join('\n')).toMatch(/no package\.json/);
  });
});

describe('what is wrong around app.asar', () => {
  const windows = { resources: 'resources', licences: [...ELECTRON_LICENCES] };
  const good = ['SceneVoiceK3Test.exe', 'ffmpeg.dll', ...ELECTRON_LICENCES, 'resources/app.asar', ...OWN_RESOURCES.map((name) => `resources/${name}`), 'locales/zh-CN.pak'];

  it('accepts a build with its licences and notices', () => {
    expect(packageProblems(good, windows)).toEqual([]);
  });

  it('wants the licences, the notices and the archive', () => {
    const problems = packageProblems(['SceneVoiceK3Test.exe'], windows).join('\n');
    expect(problems).toMatch(/no resources\/app\.asar/);
    expect(problems).toMatch(/no resources\/THIRD-PARTY-NOTICES\.md/);
    expect(problems).toMatch(/no resources\/LICENSE\.SceneVoice\.txt/);
    expect(problems).toMatch(/no LICENSE\.electron\.txt/);
    expect(problems).toMatch(/no LICENSES\.chromium\.html/);
  });

  it('rejects update files, the elevation helper, unpacked code and source maps', () => {
    const bad = [...good, 'resources/app-update.yml', 'resources/elevate.exe', 'resources/app.asar.unpacked/x.node', 'resources/app/main/index.js', 'resources/x.js.map', 'resources/node_modules/a/index.js'];
    const problems = packageProblems(bad, windows).join('\n');
    for (const name of ['app-update.yml', 'elevate.exe', 'app.asar.unpacked/x.node', 'resources/app/main/index.js', 'x.js.map', 'node_modules/a/index.js']) {
      expect(problems.includes(name), name).toBe(true);
    }
  });

  it('looks for the macOS licences inside the .app', () => {
    const mac = { resources: 'Contents/Resources', licences: ELECTRON_LICENCES.map((name) => `Contents/Resources/${name}`) };
    const files = ['Contents/Resources/app.asar', ...OWN_RESOURCES.map((name) => `Contents/Resources/${name}`)];
    expect(packageProblems(files, mac).join('\n')).toMatch(/no Contents\/Resources\/LICENSE\.electron\.txt/);
    expect(packageProblems([...files, ...mac.licences], mac)).toEqual([]);
  });
});

describe('paths of the build machine', () => {
  it('are found as UTF-8 and as UTF-16', () => {
    const home = '/Users/someone';
    expect(findLocalPath(Buffer.from(`//# sourceMappingURL=${home}/x.map`, 'utf8'), [home])).toBe(home);
    expect(findLocalPath(Buffer.from(`C:${home}`, 'utf16le'), [home])).toBe(home);
    expect(findLocalPath(Buffer.from('nothing here', 'utf8'), [home, ''])).toBe(null);
  });

  it('sizes are given in megabytes and in bytes', () => {
    expect(sizeWords(3001063)).toBe('2.9 MB (3001063 bytes)');
    expect(sizeWords(150 * 1024 * 1024)).toBe('150 MB (157286400 bytes)');
  });
});

describe('the Windows zip', () => {
  const tree = path.join(scratch, 'win-unpacked');
  fs.mkdirSync(path.join(tree, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'locales'), { recursive: true });
  const contents = {
    'SceneVoiceK3Test.exe': Buffer.alloc(70_000, 'MZ program '),
    'LICENSE.electron.txt': Buffer.from('licence\n'),
    // Bytes that do not shrink: such a file is stored as it is.
    'resources/app.asar': zlib.deflateRawSync(Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919 + (i >> 3) * 104729) % 251)), { level: 9 }),
    'resources/empty.txt': Buffer.alloc(0),
    'locales/zh-CN.pak': Buffer.from('语言包'),
  };
  for (const [name, data] of Object.entries(contents)) fs.writeFileSync(path.join(tree, name), data);
  const zip = path.join(scratch, 'out.zip');
  const made = zipFolder(tree, zip, 'SceneVoice-K3-Test-0.0.1-win-x64');
  const read = fileReader(zip);
  const entries = zipEntries(read, fs.statSync(zip).size);

  it('holds one folder, and in it every file of the build, byte for byte', () => {
    expect(made).toEqual({ files: 5, bytes: fs.statSync(zip).size });
    expect(filesUnder(tree)).toEqual(Object.keys(contents).sort());
    expect(new Set(entries.map((entry) => entry.name.split('/')[0]))).toEqual(new Set(['SceneVoice-K3-Test-0.0.1-win-x64']));
    for (const [name, data] of Object.entries(contents)) {
      const entry = entries.find((e) => e.name === `SceneVoice-K3-Test-0.0.1-win-x64/${name}`);
      expect(entry, name).toBeTruthy();
      expect(entry.size).toBe(data.length);
      expect(zipEntryData(read, entry).equals(data), name).toBe(true);
    }
    // The folders are entries too, the top one first.
    expect(entries[0]).toMatchObject({ name: 'SceneVoice-K3-Test-0.0.1-win-x64/', size: 0 });
    expect(entries.filter((entry) => entry.name.endsWith('/')).map((entry) => entry.name)).toEqual([
      'SceneVoice-K3-Test-0.0.1-win-x64/',
      'SceneVoice-K3-Test-0.0.1-win-x64/locales/',
      'SceneVoice-K3-Test-0.0.1-win-x64/resources/',
    ]);
    // Text shrinks; what does not shrink is stored as it is.
    expect(entries.find((e) => e.name.endsWith('.exe'))).toMatchObject({ method: 8 });
    expect(entries.find((e) => e.name.endsWith('.exe')).compressed).toBeLessThan(2000);
    expect(entries.find((e) => e.name.endsWith('empty.txt'))).toMatchObject({ method: 0, compressed: 0 });
  });

  it('passes the layout check, which names what is wrong with other layouts', () => {
    const files = Object.entries(contents).map(([name, data]) => ({ name, size: data.length }));
    expect(zipProblems(entries, 'SceneVoice-K3-Test-0.0.1-win-x64', files)).toEqual([]);
    // What electron-builder's own zip looks like: the files at the top.
    const flat = files.map((file) => ({ name: file.name, size: file.size }));
    const problems = zipProblems(flat, 'SceneVoice-K3-Test-0.0.1-win-x64', files).join('\n');
    expect(problems).toMatch(/should hold the one folder/);
    expect(problems).toMatch(/a file at the top of the zip: SceneVoiceK3Test\.exe/);
    expect(problems).toMatch(/the zip lacks SceneVoice-K3-Test-0\.0\.1-win-x64\/resources\/app\.asar/);
    const extra = [...entries, { name: 'SceneVoice-K3-Test-0.0.1-win-x64/stray.dll', size: 1 }, { name: 'SceneVoice-K3-Test-0.0.1-win-x64/../up.txt', size: 1 }];
    const more = zipProblems(extra, 'SceneVoice-K3-Test-0.0.1-win-x64', files.map((file) => (file.name.endsWith('.exe') ? { ...file, size: 1 } : file))).join('\n');
    expect(more).toMatch(/a file the build does not have: .*stray\.dll/);
    expect(more).toMatch(/unpacks elsewhere/);
    expect(more).toMatch(/SceneVoiceK3Test\.exe has another size in the zip/);
  });

  it('refuses a folder name that is not plain, a link, and what is not a zip', () => {
    expect(() => zipFolder(tree, path.join(scratch, 'bad.zip'), '../up')).toThrow(/not a plain folder name/);
    expect(() => zipFolder(tree, path.join(scratch, 'bad.zip'), '影院版')).toThrow(/not a plain folder name/);
    const linked = path.join(scratch, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(tree, 'LICENSE.electron.txt'), path.join(linked, 'link.txt'));
    expect(() => zipFolder(linked, path.join(scratch, 'bad.zip'), 'x')).toThrow(/a link cannot go into the zip/);
    expect(() => zipEntries((offset, length) => Buffer.alloc(length), 100)).toThrow(/no end record/);
  });

  it('computes the checksum and the date the way the format wants them', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('123456789'), { builtin: null })).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0), { builtin: null })).toBe(0);
    expect(dosTime(new Date(2026, 10, 16, 8, 30, 58))).toEqual({ time: (8 << 11) | (30 << 5) | 29, date: ((2026 - 1980) << 9) | (11 << 5) | 16 });
    expect(dosTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe('the application icon', () => {
  /** A square RGBA picture: opaque `colour` inside a transparent one-pixel edge. */
  function square(size, colour) {
    const data = Buffer.alloc(size * size * 4);
    for (let y = 1; y < size - 1; y += 1) for (let x = 1; x < size - 1; x += 1) data.set(colour, (y * size + x) * 4);
    return { width: size, height: size, data };
  }

  it('reads back the PNG it writes, and reads the extension\'s artwork', () => {
    const picture = square(16, [18, 31, 61, 255]);
    const again = decodePng(encodePng(picture));
    expect(again.width).toBe(16);
    expect(again.data.equals(picture.data)).toBe(true);
    for (const size of ARTWORK_SIZES) {
      const art = decodePng(fs.readFileSync(path.join(DESKTOP, '..', 'static', 'icons', `icon${size}.png`)));
      expect([art.width, art.height]).toEqual([size, size]);
      // The corners of the rounded square are transparent, its middle is not.
      expect(art.data[3]).toBe(0);
      expect(art.data[(Math.floor(size / 2) * size + 2) * 4 + 3]).toBe(255);
    }
    expect(() => decodePng(Buffer.from('not a picture'))).toThrow(/not a PNG/);
  });

  it('scales without darkening the edge and without changing a flat colour', () => {
    const picture = square(128, [18, 31, 61, 255]);
    for (const size of [24, 64, 256]) {
      const scaled = resize(picture, size);
      expect([scaled.width, scaled.height, scaled.data.length]).toEqual([size, size, size * size * 4]);
      const middle = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
      expect([...scaled.data.subarray(middle, middle + 4)]).toEqual([18, 31, 61, 255]);
      // On the half-transparent edge the colour is still the picture's own, not mixed with black.
      for (let i = 0; i < scaled.data.length; i += 4) {
        if (scaled.data[i + 3] > 0) expect([scaled.data[i], scaled.data[i + 1], scaled.data[i + 2]]).toEqual([18, 31, 61]);
      }
    }
    expect(resize(picture, 128)).toBe(picture);
  });

  it('takes the artwork\'s own picture where there is one', () => {
    const artwork = new Map([[16, square(16, [1, 2, 3, 255])], [128, square(128, [9, 9, 9, 255])]]);
    expect(pictureAt(artwork, 16)).toBe(artwork.get(16));
    expect(pictureAt(artwork, 256).width).toBe(256);
    expect(pictureAt(artwork, 256).data[(128 * 256 + 128) * 4]).toBe(9);
  });

  it('builds an .ico with every size Windows asks for, and an .icns for macOS', () => {
    const out = path.join(scratch, 'icons');
    const [icoFile, icnsFile] = makeIcons({ out });
    const ico = fs.readFileSync(icoFile);
    const images = icoImages(ico);
    expect(images.map((image) => image.size)).toEqual([...ICO_SIZES]);
    expect(ICO_SIZES).toContain(256);
    // 256 px as a PNG, the smaller ones as bitmaps with their header.
    const large = images.find((image) => image.size === 256).data;
    expect(decodePng(large).width).toBe(256);
    for (const image of images.filter((i) => i.size < 256)) {
      expect(image.data.readUInt32LE(0)).toBe(40);
      expect(image.data.readInt32LE(4)).toBe(image.size);
      expect(image.data.readInt32LE(8)).toBe(image.size * 2);
      expect(image.data.readUInt16LE(14)).toBe(32);
    }
    // The 32 px picture is the artwork's own, turned upside down and into BGRA: its last row is the artwork's first.
    const art = decodePng(fs.readFileSync(path.join(DESKTOP, '..', 'static', 'icons', 'icon32.png')));
    const bitmap = images.find((image) => image.size === 32).data.subarray(40);
    const artMiddle = (16 * 32 + 16) * 4;
    const bitmapMiddle = ((32 - 1 - 16) * 32 + 16) * 4;
    expect([bitmap[bitmapMiddle + 2], bitmap[bitmapMiddle + 1], bitmap[bitmapMiddle], bitmap[bitmapMiddle + 3]]).toEqual([...art.data.subarray(artMiddle, artMiddle + 4)]);

    const icns = fs.readFileSync(icnsFile);
    expect(icns.toString('latin1', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const types = [];
    for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) {
      types.push([icns.toString('latin1', at, at + 4), decodePng(icns.subarray(at + 8, at + icns.readUInt32BE(at + 4))).width]);
    }
    expect(types).toEqual(ICNS_TYPES.map(([type, size]) => [type, size]));
    expect(buildIcns([]).length).toBe(8);
    expect(icoImages(buildIco([square(16, [0, 0, 0, 255])]))).toHaveLength(1);
  });

  it('is found in a program file by its largest picture, and missed when the program has another icon', () => {
    const ico = buildIco([square(16, [18, 31, 61, 255]), square(256, [18, 31, 61, 255])]);
    const large = icoImages(ico).find((image) => image.size === 256).data;
    expect(hasIcon(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500), large, Buffer.alloc(100)]), ico)).toBe(true);
    expect(hasIcon(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500), icoImages(ico)[0].data]), ico)).toBe(false);
    expect(() => icoImages(Buffer.from('PK'))).toThrow(/not an \.ico/);
  });

  it('is what the builds are told to use, and is not kept in the repository', () => {
    expect(pkg.build.win.icon).toBe('build/icon.ico');
    expect(pkg.build.mac.icon).toBe('build/icon.icns');
    expect(pkg.scripts['make-icon']).toBe('node scripts/make-icon.mjs');
    const ignored = fs.readFileSync(path.join(DESKTOP, '.gitignore'), 'utf8').split('\n');
    expect(ignored).toContain('build/icon.ico');
    expect(ignored).toContain('build/icon.icns');
    const dist = fs.readFileSync(path.join(DESKTOP, 'scripts', 'dist.mjs'), 'utf8');
    expect(dist.indexOf('makeIcons()')).toBeGreaterThan(0);
    expect(dist.indexOf('makeIcons()')).toBeLessThan(dist.indexOf('run(BUILDER'));
  });
});
