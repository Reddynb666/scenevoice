// The film product lives beside the extension without changing it. These checks
// keep the extension's written promises true while src/film, desktop/ and
// tools/film grow: no runtime dependencies (SECURITY.md), nothing of the desktop
// app in the extension or the web player, the saved-script format untouched, and
// a root test run that never needs the desktop app's packages.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCRIPT_VERSION } from '../src/shared/constants.js';
import config from '../vitest.config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relPath) => readFileSync(join(root, relPath), 'utf8');
const pkg = JSON.parse(read('package.json'));

/** The bundles scripts/build.mjs makes: the nine extension entries and the web player. */
const ENTRIES = [
  'src/background/index.js',
  'src/content/index.js',
  'src/popup/popup.js',
  'src/options/options.js',
  'src/transcript/transcript.js',
  'src/guide/guide.js',
  'src/welcome/welcome.js',
  'src/offscreen/offscreen.js',
  'src/offscreen/worker.js',
  'src/web/player.js',
];

function specifiers(src) {
  const found = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  return found;
}

/** Every file reachable from the entries by relative imports. */
function reachable(entries) {
  const seen = new Set();
  const queue = entries.map((e) => join(root, e));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
    }
  }
  return [...seen].map((f) => relative(root, f).split(sep).join('/'));
}

describe('the extension is unchanged by the film product', () => {
  it('still has no runtime dependencies, and the root does not install Electron or Playwright', () => {
    expect(pkg.dependencies).toBeUndefined();
    const dev = Object.keys(pkg.devDependencies || {});
    for (const name of dev) expect(name).not.toMatch(/^(electron|electron-builder|electron-updater|playwright|@playwright\/test|onnxruntime-node|sherpa-onnx)/);
  });

  it('builds the same entries as before, and names them here', () => {
    const build = read('scripts/build.mjs');
    for (const entry of ENTRIES) expect(build, entry).toContain(entry);
  });

  it('bundles nothing from src/film, desktop/ or tools/ into the extension or the web player', () => {
    const files = reachable(ENTRIES);
    expect(files.length).toBeGreaterThan(30);
    expect(files.filter((f) => f.startsWith('src/film/') || f.startsWith('desktop/') || f.startsWith('tools/'))).toEqual([]);
  });

  it('keeps the saved-script format at version 2: film scripts have their own format (src/film/filmscript.js)', () => {
    expect(SCRIPT_VERSION).toBe(2);
  });

  it('runs the root tests without the desktop app or the film tools: desktop/ and tools/ are excluded from collection', () => {
    expect(config.test.exclude).toContain('desktop/**');
    expect(config.test.exclude).toContain('tools/**');
    expect(config.test.exclude).toContain('**/node_modules/**');
  });

  it('does not collect the other worktrees: in the main checkout they live under .claude/worktrees, and .claude/ is excluded', () => {
    expect(config.test.exclude).toContain('.claude/**');
    // The defaults are kept, not replaced.
    expect(config.test.exclude).toContain('**/.git/**');
    // The pattern is anchored at the root being tested: a suite run from inside a worktree (whose own path
    // contains .claude/worktrees/) still collects its own tests. This file running at all is the proof.
    expect(config.test.exclude.filter((p) => p.includes('.claude'))).toEqual(['.claude/**']);
  });
});
