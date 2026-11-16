// Builds the packages of the test shell that go to testers, into desktop/dist
// (git-ignored), and then checks what is in them (scripts/check-dist.mjs):
//
//   npm run dist:win   Windows x64: a zip holding one folder with the build, and an NSIS installer
//   npm run dist:mac   macOS arm64: a zip of the .app
//
// Both can be built on a Mac; the Windows ones need neither Windows nor Wine.
// The targets and their options are in package.json ("build"). The Windows zip
// is made here (scripts/zip.mjs), not by electron-builder, whose zip has no
// folder in it: "extract here" would scatter twenty files.
//
// The sample clip is NOT in a build unless `--with-sample` is given: whether
// the 40 seconds of film may be passed on with their music is an open question
// for the owner (THIRD-PARTY-NOTICES.md). Without the clip the shell reads the
// same ten descriptions over any film the tester opens. `--no-sample` is still
// accepted and means the default.
//
// Before the build the application icon is made from the extension's artwork
// (scripts/make-icon.mjs). Afterwards dist/ holds the packages and the unpacked
// builds they were made from; electron-builder's by-products (its debug file,
// which names folders of this machine, and block maps for an updater the shell
// does not have) are deleted.
//
// The packages are unsigned on purpose: this round has no certificate, and how
// a tester gets past SmartScreen and antivirus software is itself step 0 of
// the K3 test. So that a certificate in the builder's keychain or environment
// is never picked up by accident, signing is switched off for the run.
//
// electron-builder downloads Electron for the target platform and its NSIS
// tools once. Where GitHub is slow:
//   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
//   ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeIcons } from './make-icon.mjs';
import { zipFolder } from './zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const SAMPLE = path.join(DESKTOP, 'renderer', 'sample', 'sample.mp4');
const BUILDER = path.join(DESKTOP, 'node_modules', 'electron-builder', 'cli.js');
const DIST = path.join(DESKTOP, 'dist');
/** The pattern in build.files of package.json that keeps the sample clip out of a build. */
export const SAMPLE_EXCLUDED = '!renderer/sample/sample.mp4';
/** The unpacked Windows build electron-builder leaves in dist/. */
export const WIN_UNPACKED = 'win-unpacked';

/** electron-builder's arguments for each platform. `--publish never`: nothing is ever uploaded. */
export const TARGETS = Object.freeze({
  win: Object.freeze(['--win', '--x64', '--publish', 'never']),
  mac: Object.freeze(['--mac', '--arm64', '--publish', 'never']),
});

/** Variables that would make electron-builder sign: taken out of the build's environment. */
export const SIGNING_VARIABLES = Object.freeze(['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY']);

/** The environment of the build: the caller's, without signing. */
export function buildEnvironment(env) {
  const out = { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const name of SIGNING_VARIABLES) delete out[name];
  return out;
}

/**
 * Whether a build is to carry the sample clip: only when asked for.
 * @param {string[]} args  the command line
 */
export function wantsSample(args) {
  return args.includes('--with-sample') && !args.includes('--no-sample');
}

/**
 * Arguments that put the sample clip into a build. electron-builder adds the
 * patterns given on the command line to those of package.json (it joins the
 * two lists and drops repeats; a single pattern would replace the whole list,
 * hence two), and a later pattern that names the file overrides the earlier
 * one that excludes it. So: one pattern the list already has, and the clip.
 * Tried with electron-builder 26.18; check-dist looks for the clip afterwards,
 * so a version that combines the lists differently fails the build there
 * instead of quietly leaving the clip out.
 * @param {string[]} files  build.files of package.json
 */
export function withSample(files) {
  if (!files.includes(SAMPLE_EXCLUDED)) throw new Error(`package.json no longer excludes the sample clip (${SAMPLE_EXCLUDED})`);
  const repeated = files.find((pattern) => !pattern.startsWith('!'));
  return [repeated, SAMPLE_EXCLUDED.slice(1)].map((pattern) => `-c.files=${pattern}`);
}

/**
 * The Windows zip: its file name, and the one folder it holds (the same name
 * without ".zip", so every unpacking tool ends up with the same folder).
 * @param {string} version  of package.json
 */
export function winZip(version) {
  const folder = `SceneVoice-K3-Test-${version}-win-x64`;
  return { file: `${folder}.zip`, folder };
}

/** The by-products of a build among the names in dist/: not for testers, not kept. */
export function leftovers(names) {
  return names.filter((name) => name === 'builder-debug.yml' || name === 'builder-effective-config.yaml' || /\.blockmap$/i.test(name) || /\.nsis\.7z$/i.test(name));
}

function run(file, args, env) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: DESKTOP, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => Object.hasOwn(TARGETS, a));
  const sample = wantsSample(args);
  if (!platform) {
    console.error('Usage: node scripts/dist.mjs win|mac [--with-sample]');
    process.exit(2);
  }
  if (!existsSync(BUILDER)) {
    console.error('electron-builder is not installed: run npm install in desktop/ first.');
    process.exit(1);
  }
  if (sample && !existsSync(SAMPLE)) {
    console.error('The sample clip is missing: run npm run make-sample first, or build without --with-sample.');
    process.exit(1);
  }
  console.log(sample ? 'Building WITH the sample clip: see the open question at the top of THIRD-PARTY-NOTICES.md before giving this build to anyone.' : 'Building without the sample clip (the default; --with-sample puts it in).');
  for (const file of makeIcons()) console.log(`icon: ${path.relative(DESKTOP, file)}`);
  const pkg = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  const env = buildEnvironment(process.env);
  const extra = sample ? withSample(pkg.build.files) : [];
  const built = run(BUILDER, [...TARGETS[platform], ...extra], env);
  if (existsSync(DIST)) {
    for (const name of leftovers(readdirSync(DIST))) rmSync(path.join(DIST, name), { force: true });
  }
  if (built !== 0) {
    console.error(`electron-builder failed (exit ${built}).`);
    process.exit(built);
  }
  if (platform === 'win') {
    const zip = winZip(pkg.version);
    const made = zipFolder(path.join(DIST, WIN_UNPACKED), path.join(DIST, zip.file), zip.folder);
    console.log(`zip: ${zip.file}, ${made.files} files in the folder ${zip.folder}`);
  }
  process.exit(run(path.join(HERE, 'check-dist.mjs'), [platform, ...(sample ? ['--with-sample'] : [])], env));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
