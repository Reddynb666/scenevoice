// Build the extension into dist/ and (with --zip) package it.
//   node scripts/build.mjs          production build
//   node scripts/build.mjs --zip    build + scenevoice-<version>.zip
//   node scripts/build.mjs --watch  rebuild on change

import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, STRINGS } from './locales.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every key used in source must exist in every locale; fail the build otherwise. */
function checkStrings() {
  const used = new Set();
  for (const file of walk(join(root, 'src')).concat(join(root, 'static', 'manifest.json'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/data-i18n="([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/__MSG_([a-z0-9_]+)__/g)) used.add(m[1]);
  }
  // Keys built dynamically.
  for (const p of ['announce_detail_', 'announce_mode_', 'announce_density_']) for (const k of Object.keys(STRINGS)) if (k.startsWith(p)) used.add(k);
  const problems = [];
  for (const key of used) {
    if (key.startsWith('@@')) continue;
    if (!STRINGS[key]) problems.push(`missing string: ${key}`);
    else for (const l of LOCALES) if (!STRINGS[key][l]) problems.push(`missing ${l}: ${key}`);
  }
  for (const [key, v] of Object.entries(STRINGS)) {
    const counts = LOCALES.map((l) => (v[l]?.match(/\$\d/g) || []).sort().join());
    if (new Set(counts).size > 1) problems.push(`placeholder mismatch: ${key}`);
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

function writeLocales() {
  // Chrome looks for zh_TW, then zh, then the default: give Traditional Chinese
  // readers the Simplified interface rather than English until zh_TW exists.
  const folders = [...LOCALES.map((l) => [l, l]), ['zh', 'zh_CN']];
  for (const [folder, locale] of folders) {
    const out = {};
    for (const [key, v] of Object.entries(STRINGS)) {
      let message = v[locale] ?? v.en;
      const placeholders = {};
      message = message.replace(/\$(\d)/g, (_, n) => {
        placeholders[`p${n}`] = { content: `$${n}` };
        return `$p${n}$`;
      });
      out[key] = Object.keys(placeholders).length ? { message, placeholders } : { message };
    }
    const dir = join(dist, '_locales', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'messages.json'), `${JSON.stringify(out, null, 2)}\n`);
  }
}

function copyStatic() {
  cpSync(join(root, 'static'), dist, { recursive: true });
  for (const page of ['popup', 'options', 'transcript', 'guide']) {
    cpSync(join(root, 'src', page, `${page}.html`), join(dist, `${page}.html`));
    cpSync(join(root, 'src', page, `${page}.css`), join(dist, `${page}.css`));
  }
  cpSync(join(root, 'src', 'offscreen', 'offscreen.html'), join(dist, 'offscreen.html'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return pkg.version;
}

const common = {
  bundle: true,
  target: ['chrome116'],
  legalComments: 'none',
  logLevel: 'warning',
  minify: !args.has('--watch'),
  sourcemap: args.has('--watch') ? 'inline' : false,
};

const entries = [
  { entryPoints: [join(root, 'src/background/index.js')], outfile: join(dist, 'background.js'), format: 'esm' },
  { entryPoints: [join(root, 'src/content/index.js')], outfile: join(dist, 'content.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/popup/popup.js')], outfile: join(dist, 'popup.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/options/options.js')], outfile: join(dist, 'options.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/transcript/transcript.js')], outfile: join(dist, 'transcript.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/guide/guide.js')], outfile: join(dist, 'guide.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/offscreen/offscreen.js')], outfile: join(dist, 'offscreen.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/offscreen/worker.js')], outfile: join(dist, 'offscreen-worker.js'), format: 'iife' },
];

checkStrings();
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const version = copyStatic();
writeLocales();

if (args.has('--watch')) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
  console.log('Watching for changes…');
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
  console.log(`Built SceneVoice ${version} into dist/`);
  if (args.has('--zip')) {
    const zip = join(root, `scenevoice-${version}.zip`);
    if (existsSync(zip)) rmSync(zip);
    execFileSync('zip', ['-qr', zip, '.'], { cwd: dist });
    console.log(`Packaged ${zip}`);
  }
}
