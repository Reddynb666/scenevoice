// Cut a release locally: node scripts/release.mjs <version>
//
// Checks the working tree is clean, moves CHANGELOG.md's "## Unreleased" into
// "## <version> — <today>", sets the version in package.json and
// package-lock.json, runs the unit tests and the build, then commits
// "Release <version>" and tags v<version>. It never pushes: the owner pushes
// the tag (git push --follow-tags), and .github/workflows/release.yml takes it
// from there.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutUnreleased } from './changelog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
}

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('usage: node scripts/release.mjs <major.minor.patch>');
if (git('status', '--porcelain')) fail('the working tree is not clean; commit or discard changes first');
if (git('tag', '--list', `v${version}`)) fail(`tag v${version} already exists`);

const today = new Date().toISOString().slice(0, 10);
const changelogPath = join(root, 'CHANGELOG.md');
let cut;
try {
  cut = cutUnreleased(readFileSync(changelogPath, 'utf8'), version, today);
} catch (e) {
  fail(e.message);
}

const pkg = readJson('package.json');
if (pkg.version === version) fail(`package.json is already at ${version}`);
pkg.version = version;
const lock = readJson('package-lock.json');
lock.version = version;
if (lock.packages && lock.packages['']) lock.packages[''].version = version;

writeFileSync(changelogPath, cut.text);
writeJson('package.json', pkg);
writeJson('package-lock.json', lock);
console.log(`release: CHANGELOG.md, package.json and package-lock.json set to ${version}`);

// The tests and the build run against the files as they will be committed, so
// a failing suite leaves the version edits in the tree for the owner to see
// and nothing committed.
run('npm', ['test']);
run('npm', ['run', 'build']);

git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
git('commit', '-m', `Release ${version}`);
git('tag', '-a', `v${version}`, '-m', `SceneVoice ${version}`);
console.log(`release: committed and tagged v${version}.`);
console.log('Next: review `git show HEAD`, then `git push --follow-tags` to start the release workflow. Nothing has been pushed.');
