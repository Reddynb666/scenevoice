// Looks into the packages `npm run dist:win` / `npm run dist:mac` left in
// desktop/dist and says what a tester would get:
//
//   npm run check-dist            every unpacked build found in dist/
//   npm run check-dist -- win     only the Windows one (or: mac)
//
// It lists the files of app.asar and of the resources folder, the artifacts
// with their sizes and SHA-256, and fails (exit 1) when the package holds
// something it should not (node_modules, source maps, a path of the machine it
// was built on, update or elevation helpers, the sample clip in a build that
// was not asked to carry it) or lacks something it must have (the app's
// folders, the licence files, the application icon, the one folder inside the
// Windows zip).
// `--with-sample` expects the sample clip to be there; without it the clip
// must not be (see the top of THIRD-PARTY-NOTICES.md).
//
// The checks themselves are pure functions (test/dist.test.js); only main()
// reads the disk.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WIN_UNPACKED, winZip } from './dist.mjs';
import { fileReader, zipEntries } from './zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const DIST = path.join(DESKTOP, 'dist');

/** The folders of desktop/ a build runs from (package.json: build.files). */
export const APP_FOLDERS = Object.freeze(['main', 'ipc', 'shared', 'locales', 'renderer']);
export const SAMPLE_IN_ASAR = 'renderer/sample/sample.mp4';
/** Next to app.asar in every build. */
export const OWN_RESOURCES = Object.freeze(['THIRD-PARTY-NOTICES.md', 'LICENSE.SceneVoice.txt']);
/** Electron's own licence files, as electron-builder names them in a build. */
export const ELECTRON_LICENCES = Object.freeze(['LICENSE.electron.txt', 'LICENSES.chromium.html']);
/** Files that would mean an updater, an elevation helper or unpacked code got in. */
const UNWANTED = [/(^|\/)app-update\.yml$/i, /(^|\/)elevate\.exe$/i, /(^|\/)app\.asar\.unpacked(\/|$)/i, /(^|\/)resources\/app(\/|$)/i, /\.blockmap$/i, /(^|\/)latest[^/]*\.yml$/i];

/**
 * The files of an asar archive, from its header.
 * @param {Buffer} buffer  the archive, or at least its header
 * @returns {{path: string, size: number, unpacked: boolean}[]}
 */
export function asarFiles(buffer) {
  if (buffer.length < 16) throw new Error('not an asar archive: too short');
  // Two pickles: [4][header size] and [payload size][string length][JSON].
  if (buffer.readUInt32LE(0) !== 4) throw new Error('not an asar archive: bad size pickle');
  const length = buffer.readUInt32LE(12);
  if (16 + length > buffer.length) throw new Error('not an asar archive: header runs past the end');
  const header = JSON.parse(buffer.subarray(16, 16 + length).toString('utf8'));
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const here = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, here);
      else out.push({ path: here, size: Number(entry.size) || 0, unpacked: entry.unpacked === true });
    }
  };
  walk(header, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** How many bytes the header of an asar archive takes (what asarFiles needs to read). */
export function asarHeaderBytes(firstSixteen) {
  return 16 + firstSixteen.readUInt32LE(12);
}

/**
 * What is wrong with the contents of an app.asar.
 * @param {{path: string, unpacked?: boolean}[]} files
 * @param {{sample?: boolean}} [o]  sample: the build was asked to carry the clip (default: it was
 *   not, and then the clip must not be there)
 * @returns {string[]} problems, empty when it is as it should be
 */
export function asarProblems(files, { sample = false } = {}) {
  const problems = [];
  const names = files.map((f) => f.path);
  for (const name of names) {
    const top = name.split('/')[0];
    if (name !== 'package.json' && !APP_FOLDERS.includes(top)) problems.push(`app.asar holds a file outside the app's folders: ${name}`);
    if (/(^|\/)node_modules(\/|$)/.test(name)) problems.push(`app.asar holds node_modules: ${name}`);
    if (/\.map$/i.test(name)) problems.push(`app.asar holds a source map: ${name}`);
  }
  for (const file of files) if (file.unpacked) problems.push(`app.asar leaves a file unpacked: ${file.path}`);
  if (!names.includes('package.json')) problems.push('app.asar has no package.json');
  for (const folder of APP_FOLDERS) {
    if (!names.some((name) => name.startsWith(`${folder}/`))) problems.push(`app.asar lacks the ${folder}/ folder`);
  }
  if (sample && !names.includes(SAMPLE_IN_ASAR)) problems.push(`app.asar lacks the sample clip (${SAMPLE_IN_ASAR}); run npm run make-sample, or build without --with-sample`);
  if (!sample && names.includes(SAMPLE_IN_ASAR)) problems.push(`app.asar holds the sample clip (${SAMPLE_IN_ASAR}), which goes into a build only with --with-sample: see the top of THIRD-PARTY-NOTICES.md`);
  return [...new Set(problems)];
}

/**
 * What is wrong with the layout of the Windows zip: it has to hold one folder,
 * named like the zip, with exactly the files of the unpacked build in it.
 * @param {{name: string, size: number}[]} entries  of the zip
 * @param {string} folder                            the folder it should hold
 * @param {{name: string, size: number}[]} files     the unpacked build, relative paths
 * @returns {string[]}
 */
export function zipProblems(entries, folder, files) {
  const problems = [];
  const tops = [...new Set(entries.map((entry) => entry.name.split('/')[0]))];
  if (tops.length !== 1 || tops[0] !== folder) problems.push(`the zip should hold the one folder ${folder}, and holds at its top: ${tops.join(', ') || 'nothing'}`);
  for (const entry of entries) {
    if (!entry.name.includes('/')) problems.push(`a file at the top of the zip: ${entry.name}`);
    if (entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..')) problems.push(`a path in the zip that unpacks elsewhere: ${entry.name}`);
  }
  const inZip = new Map(entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => [entry.name, entry.size]));
  for (const file of files) {
    const name = `${folder}/${file.name}`;
    if (!inZip.has(name)) problems.push(`the zip lacks ${name}`);
    else if (inZip.get(name) !== file.size) problems.push(`${name} has another size in the zip`);
    inZip.delete(name);
  }
  for (const name of inZip.keys()) problems.push(`the zip holds a file the build does not have: ${name}`);
  return [...new Set(problems)];
}

/**
 * The pictures of a Windows .ico, as the bytes that go into a program's resources unchanged.
 * @returns {{size: number, data: Buffer}[]}
 */
export function icoImages(ico) {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('not an .ico file');
  const out = [];
  for (let i = 0; i < ico.readUInt16LE(4); i += 1) {
    const at = 6 + i * 16;
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    if (offset + length > ico.length) throw new Error('not an .ico file: a picture runs past the end');
    out.push({ size: ico[at] || 256, data: ico.subarray(offset, offset + length) });
  }
  return out;
}

/**
 * Whether a program file carries our icon and not Electron's: the largest
 * picture of build/icon.ico has to be in it, byte for byte.
 */
export function hasIcon(program, ico) {
  const images = icoImages(ico).sort((a, b) => b.size - a.size);
  return images.length > 0 && program.includes(images[0].data);
}

/**
 * What is wrong with the files around app.asar.
 * @param {string[]} files      every file of the build, relative, with forward slashes
 * @param {object} o
 * @param {string} o.resources  the resources folder, relative ('resources' on Windows)
 * @param {string[]} o.licences where Electron's licence files have to be, relative
 * @returns {string[]}
 */
export function packageProblems(files, { resources, licences }) {
  const problems = [];
  const has = (name) => files.includes(name);
  if (!has(`${resources}/app.asar`)) problems.push(`no ${resources}/app.asar`);
  for (const name of OWN_RESOURCES) if (!has(`${resources}/${name}`)) problems.push(`no ${resources}/${name}`);
  for (const name of licences) if (!has(name)) problems.push(`no ${name}`);
  for (const file of files) {
    if (UNWANTED.some((pattern) => pattern.test(file))) problems.push(`unwanted file: ${file}`);
    if (/(^|\/)node_modules(\/|$)/.test(file)) problems.push(`node_modules outside app.asar: ${file}`);
    if (/\.map$/i.test(file)) problems.push(`source map: ${file}`);
  }
  return [...new Set(problems)];
}

/**
 * Whether a file's bytes hold one of the given strings, as UTF-8 or as the
 * UTF-16 that Windows resources use.
 * @returns {string|null} the string found
 */
export function findLocalPath(bytes, needles) {
  for (const needle of needles) {
    if (!needle) continue;
    if (bytes.includes(Buffer.from(needle, 'utf8')) || bytes.includes(Buffer.from(needle, 'utf16le'))) return needle;
  }
  return null;
}

/** "3.0 MB (3001063 bytes)" */
export function sizeWords(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB (${bytes} bytes)`;
}

function listFiles(root, relative = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const here = relative ? `${relative}/${entry.name}` : entry.name;
    // A link (the macOS frameworks have several) is listed, not followed.
    if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...listFiles(root, here));
    else out.push(here);
  }
  return out;
}

function sha256(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (let read = fs.readSync(fd, chunk); read > 0; read = fs.readSync(fd, chunk)) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** The unpacked builds in dist/: {name, root (what a tester gets), resources, licences}. */
function findBuilds(only) {
  const builds = [];
  if (!fs.existsSync(DIST)) return builds;
  for (const entry of fs.readdirSync(DIST, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(DIST, entry.name);
    if (entry.name === WIN_UNPACKED && only !== 'mac') {
      builds.push({ platform: 'win', name: `Windows (${entry.name})`, root: folder, resources: 'resources', licences: [...ELECTRON_LICENCES] });
    } else if (entry.name.startsWith('mac') && only !== 'win') {
      const app = fs.readdirSync(folder).find((name) => name.endsWith('.app'));
      if (!app) continue;
      // The zip holds the .app alone: Electron's licence files have to be inside it.
      builds.push({
        platform: 'mac',
        name: `macOS (${entry.name}/${app})`,
        root: path.join(folder, app),
        resources: 'Contents/Resources',
        licences: ELECTRON_LICENCES.map((name) => `Contents/Resources/${name}`),
      });
    }
  }
  return builds;
}

function checkBuild(build, { sample }) {
  const problems = [];
  const files = listFiles(build.root).sort();
  console.log(`\n== ${build.name}: ${files.length} files`);
  problems.push(...packageProblems(files, build));

  const resources = files.filter((file) => file.startsWith(`${build.resources}/`) && !/\.(lproj|pak)(\/|$)/.test(file));
  console.log(`-- ${build.resources}/ (${resources.length} files, locale folders left out):`);
  for (const file of resources) console.log(`   ${file}  ${fs.lstatSync(path.join(build.root, file)).size}`);

  const asarPath = path.join(build.root, build.resources, 'app.asar');
  if (fs.existsSync(asarPath)) {
    const inside = asarFiles(fs.readFileSync(asarPath));
    console.log(`-- app.asar (${inside.length} files):`);
    for (const file of inside) console.log(`   ${file.path}  ${file.size}`);
    problems.push(...asarProblems(inside, { sample }));
  }

  // Nothing in the package may name a folder of the machine it was built on.
  const needles = [os.homedir(), path.dirname(DESKTOP), os.tmpdir(), process.env.ELECTRON_CACHE, process.env.ELECTRON_BUILDER_CACHE].filter((s) => s && s.length > 4);
  let scanned = 0;
  for (const file of files) {
    const full = path.join(build.root, file);
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) continue;
    scanned += 1;
    const found = findLocalPath(fs.readFileSync(full), needles);
    if (found) problems.push(`${file} holds a path of this machine (${found})`);
  }
  console.log(`-- searched ${scanned} files for paths of this machine`);
  problems.push(...(build.platform === 'win' ? checkWindowsExtras(build, files) : checkMacExtras(build)));
  return problems;
}

/** The application icon in the program and the installer, and the layout of the zip. */
function checkWindowsExtras(build, files) {
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  const icoFile = path.join(DESKTOP, pkg.build.win.icon);
  const ico = fs.existsSync(icoFile) ? fs.readFileSync(icoFile) : null;
  if (!ico) problems.push(`no ${pkg.build.win.icon}: run npm run make-icon`);
  const programs = [path.join(build.root, `${pkg.build.win.executableName}.exe`), ...fs.readdirSync(DIST).filter((name) => /-setup\.exe$/i.test(name)).map((name) => path.join(DIST, name))];
  for (const program of programs) {
    const name = path.basename(program);
    if (!fs.existsSync(program)) problems.push(`no ${name}`);
    else if (ico && !hasIcon(fs.readFileSync(program), ico)) problems.push(`${name} does not carry the application icon`);
    else console.log(`-- ${name} carries the application icon`);
  }
  const zip = winZip(pkg.version);
  const zipFile = path.join(DIST, zip.file);
  if (!fs.existsSync(zipFile)) {
    problems.push(`no ${zip.file}`);
  } else {
    const entries = zipEntries(fileReader(zipFile), fs.statSync(zipFile).size);
    const unpacked = files.map((file) => ({ name: file, size: fs.statSync(path.join(build.root, file)).size }));
    const found = zipProblems(entries, zip.folder, unpacked);
    problems.push(...found);
    if (!found.length) console.log(`-- ${zip.file} holds the one folder ${zip.folder} with the ${unpacked.length} files of the build`);
  }
  return problems;
}

/** The application icon of the .app, and the sentence macOS shows when the microphone is asked for. */
function checkMacExtras(build) {
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  const icnsFile = path.join(DESKTOP, pkg.build.mac.icon);
  const inApp = path.join(build.root, 'Contents', 'Resources', 'icon.icns');
  if (!fs.existsSync(icnsFile)) problems.push(`no ${pkg.build.mac.icon}: run npm run make-icon`);
  else if (!fs.existsSync(inApp) || !fs.readFileSync(inApp).equals(fs.readFileSync(icnsFile))) problems.push('the .app does not carry the application icon');
  else console.log('-- the .app carries the application icon');
  const plist = fs.readFileSync(path.join(build.root, 'Contents', 'Info.plist'));
  if (!plist.includes('NSMicrophoneUsageDescription')) problems.push('Info.plist has no NSMicrophoneUsageDescription: macOS would stop the app at "Test the microphone"');
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a === 'win' || a === 'mac') || '';
  const sample = args.includes('--with-sample');
  const builds = findBuilds(only);
  if (!builds.length) {
    console.error(`No unpacked build in ${DIST}. Run npm run dist:win or npm run dist:mac first.`);
    process.exit(1);
  }
  const problems = [];
  for (const build of builds) problems.push(...checkBuild(build, { sample }).map((p) => `${build.name}: ${p}`));

  const artifacts = fs
    .readdirSync(DIST, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(zip|exe|dmg)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  console.log('\n== Artifacts in dist/');
  for (const name of artifacts) {
    const file = path.join(DIST, name);
    console.log(`   ${name}  ${sizeWords(fs.statSync(file).size)}  sha256 ${sha256(file)}`);
  }
  if (!artifacts.length) console.log('   none');

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`   ${problem}`);
    process.exit(1);
  }
  console.log('\nNo problem found.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
