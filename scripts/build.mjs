// Build the extension into dist/ and (with --zip) package it.
//   node scripts/build.mjs             production build; source maps go to dist-maps/
//   node scripts/build.mjs --zip       build + scenevoice-<version>.zip and scenevoice-<version>-sourcemaps.zip
//   node scripts/build.mjs --metafile  build + dist-meta.json and a size table; fails when a bundle is over its limit
//   node scripts/build.mjs --watch     rebuild on change (inline source maps, no minify)
//   node scripts/build.mjs --web       the web player only: src/web/player.js -> site/play/player.js (npm run build:web)

import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { CORE_LOCALES, LOCALES, LOCALE_FOLDERS, SPOKEN_KEYS, STRINGS, coverage, strayKeys } from './locales.mjs';
import { RTL_LANGUAGES } from '../src/shared/constants.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
// Source maps live outside dist/ so they are never in the store package, but
// are kept with each release (the -sourcemaps zip) to read a stack trace.
const maps = join(root, 'dist-maps');
const args = new Set(process.argv.slice(2));

/**
 * Messages written into every _locales folder by writeLocales() rather than
 * translated: ui_lang is the language of the folder's strings as a BCP 47 tag
 * (pt-BR in the pt folder) and ui_dir its direction, which shared/i18n.js puts
 * on <html>. Not in the locale files, so
 * the completeness checks leave them out.
 */
const GENERATED_KEYS = new Set(['ui_lang', 'ui_dir']);

/** Minified bundle sizes CI refuses to exceed; the content script loads on every YouTube page. */
const SIZE_LIMITS = { 'content.js': 120 * 1024 };

/** What may go into the store package, by extension; dotfiles and .map never do. */
const PACKAGED = new Set(['.js', '.html', '.css', '.json', '.png']);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Every key used in source must exist in English and Chinese (the core
 * languages); fail the build otherwise. Other languages may be partial (they
 * fall back to English) but must not hold stale keys or different placeholders.
 */
function checkStrings() {
  const used = new Set();
  for (const file of walk(join(root, 'src')).concat(join(root, 'static', 'manifest.json'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/data-i18n="([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/__MSG_([a-z0-9_]+)__/g)) used.add(m[1]);
  }
  // Keys built dynamically.
  for (const p of ['announce_detail_', 'announce_mode_', 'announce_density_', 'status_fallback_', 'opt_next_']) for (const k of Object.keys(STRINGS)) if (k.startsWith(p)) used.add(k);
  const problems = [];
  for (const key of used) {
    if (key.startsWith('@@') || GENERATED_KEYS.has(key)) continue;
    if (!STRINGS[key]) problems.push(`missing string: ${key}`);
    else for (const l of CORE_LOCALES) if (!STRINGS[key][l]) problems.push(`missing ${l}: ${key}`);
  }
  // Text read aloud during playback must never fall back to English.
  for (const l of LOCALES) for (const key of SPOKEN_KEYS) if (!STRINGS[key]?.[l]) problems.push(`missing ${l}: ${key} (spoken during playback)`);
  for (const [key, v] of Object.entries(STRINGS)) {
    const reference = (v.en.match(/\$\d/g) || []).sort().join();
    for (const l of LOCALES) {
      if (v[l] && (v[l].match(/\$\d/g) || []).sort().join() !== reference) problems.push(`placeholder mismatch in ${l}: ${key}`);
    }
  }
  for (const l of LOCALES) for (const key of strayKeys(l)) problems.push(`${l} has a key English does not: ${key}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const partial = LOCALES.filter((l) => !CORE_LOCALES.includes(l)).map((l) => `${l} ${Math.round(coverage(l) * 100)}%`);
  if (partial.length) console.log(`Interface languages besides English and Chinese: ${partial.join(', ')} (the rest falls back to English)`);
}

function writeLocales() {
  // One folder per language file, plus a bare parent folder for every regional
  // locale (zh from zh_CN, pt from pt_BR): Chrome looks for zh_HK, then zh,
  // then the default, never a sibling region, so a Chinese or Portuguese
  // browser locale with no file of its own gets that interface rather than
  // English. The list is LOCALE_FOLDERS in locales.mjs.
  for (const [folder, locale] of LOCALE_FOLDERS) {
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
    // Which language this folder's strings are in, for the pages' <html lang>
    // and dir (shared/i18n.js): @@ui_locale is the browser's locale, which may
    // have no folder here and then gets English. The source locale's tag, not
    // the folder's: the pt folder holds Brazilian Portuguese, so it says pt-BR.
    // Generated, so the locale files themselves need not carry it.
    out.ui_lang = { message: locale.replace('_', '-') };
    out.ui_dir = { message: RTL_LANGUAGES.includes(folder.split('_')[0]) ? 'rtl' : 'ltr' };
    const dir = join(dist, '_locales', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'messages.json'), `${JSON.stringify(out, null, 2)}\n`);
  }
}

function copyStatic() {
  cpSync(join(root, 'static'), dist, { recursive: true });
  for (const page of ['popup', 'options', 'transcript', 'guide', 'welcome']) {
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

/**
 * A zip in plain Node (no dependency): local headers, central directory, end
 * record, deflate from zlib. Entries are sorted so the same files give the
 * same listing. Chrome, Edge and `unzip` all read it.
 */
function writeZip(file, entries) {
  const crc32 = zlib.crc32 || ((buf) => {
    // Node before 22.2 has no zlib.crc32.
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  });
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method ? deflated : data;
    const fields = [[20, 2], [0x800, 2], [method, 2], [time, 2], [date, 2], [crc32(data), 4], [body.length, 4], [data.length, 4], [nameBuf.length, 2], [0, 2]];
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    let at = 4;
    for (const [v, w] of fields) at = w === 2 ? local.writeUInt16LE(v, at) : local.writeUInt32LE(v, at);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    at = 6;
    for (const [v, w] of fields) at = w === 2 ? central.writeUInt16LE(v, at) : central.writeUInt32LE(v, at);
    // comment length, disk number, internal and external attributes stay 0
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...locals, directory, end]));
}

/** Files of a folder as zip entries with forward-slash names relative to it. */
function entriesOf(dir, keep) {
  return walk(dir)
    .map((p) => relative(dir, p).split(/[\\/]/).join('/'))
    .filter((name) => !name.split('/').some((part) => part.startsWith('.')))
    .filter(keep)
    .map((name) => ({ name, data: readFileSync(join(dir, name)) }));
}

/** esbuild writes maps next to the bundles; keep dist/ free of them. */
function moveSourceMaps() {
  rmSync(maps, { recursive: true, force: true });
  mkdirSync(maps, { recursive: true });
  for (const f of readdirSync(dist)) if (f.endsWith('.map')) renameSync(join(dist, f), join(maps, f));
}

/**
 * dist-meta.json (esbuild's metafile, merged over the bundles) and a size
 * table for the CI summary. Exits 1 when a bundle is over its limit.
 */
function reportSizes(results) {
  const metafile = { inputs: {}, outputs: {} };
  for (const r of results) {
    Object.assign(metafile.inputs, r.metafile.inputs);
    Object.assign(metafile.outputs, r.metafile.outputs);
  }
  writeFileSync(join(root, 'dist-meta.json'), `${JSON.stringify(metafile, null, 2)}\n`);
  const rows = Object.keys(metafile.outputs)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: relative(dist, join(root, f)), bytes: statSync(join(root, f)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  const over = rows.filter((r) => SIZE_LIMITS[r.name] && r.bytes > SIZE_LIMITS[r.name]);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log('| Bundle | Minified | Limit |\n| --- | ---: | ---: |');
  for (const r of rows) console.log(`| ${r.name} | ${kb(r.bytes)} | ${SIZE_LIMITS[r.name] ? kb(SIZE_LIMITS[r.name]) : ''} |`);
  if (over.length) {
    console.error(`Bundle over its size limit: ${over.map((r) => `${r.name} (${kb(r.bytes)})`).join(', ')}`);
    process.exit(1);
  }
}

const common = {
  bundle: true,
  target: ['chrome116'],
  legalComments: 'none',
  logLevel: 'warning',
  minify: !args.has('--watch'),
  sourcemap: args.has('--watch') ? 'inline' : 'external',
  sourcesContent: true,
  metafile: args.has('--metafile'),
};

const entries = [
  { entryPoints: [join(root, 'src/background/index.js')], outfile: join(dist, 'background.js'), format: 'esm' },
  { entryPoints: [join(root, 'src/content/index.js')], outfile: join(dist, 'content.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/popup/popup.js')], outfile: join(dist, 'popup.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/options/options.js')], outfile: join(dist, 'options.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/transcript/transcript.js')], outfile: join(dist, 'transcript.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/guide/guide.js')], outfile: join(dist, 'guide.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/welcome/welcome.js')], outfile: join(dist, 'welcome.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/offscreen/offscreen.js')], outfile: join(dist, 'offscreen.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/offscreen/worker.js')], outfile: join(dist, 'offscreen-worker.js'), format: 'iife' },
];

/**
 * The web player (site/play): the same shared modules as the extension, on a
 * plain page. shared/i18n.js (chrome.i18n) is replaced by src/web/i18n.js,
 * which reads the locale tables; nothing else in the bundle may touch chrome.*
 * (checked after the build). No source map: the site is served as it is.
 */
const webAliases = {
  name: 'web-aliases',
  setup(b) {
    const sharedI18n = join(root, 'src', 'shared', 'i18n.js');
    const webI18n = join(root, 'src', 'web', 'i18n.js');
    b.onResolve({ filter: /i18n\.js$/ }, (a) => (a.resolveDir && resolve(a.resolveDir, a.path) === sharedI18n ? { path: webI18n } : null));
  },
};

async function buildWeb() {
  checkStrings();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const outfile = join(root, 'site', 'play', 'player.js');
  const entry = {
    ...common,
    sourcemap: false,
    entryPoints: [join(root, 'src/web/player.js')],
    outfile,
    format: 'iife',
    define: { __SCENEVOICE_VERSION__: JSON.stringify(pkg.version) },
    plugins: [webAliases],
  };
  if (args.has('--watch')) {
    await (await context(entry)).watch();
    console.log('Watching the web player for changes…');
    return;
  }
  await build(entry);
  const text = readFileSync(outfile, 'utf8');
  const stray = text.match(/\bchrome\.(storage|runtime|i18n|tts|tabs|commands|offscreen)\b/);
  if (stray) {
    console.error(`site/play/player.js reaches for ${stray[0]}: a shared module that needs the extension was bundled into the web player`);
    process.exit(1);
  }
  console.log(`Built the SceneVoice ${pkg.version} web player into site/play/player.js (${(text.length / 1024).toFixed(1)} KB)`);
}

if (args.has('--web')) {
  await buildWeb();
  process.exit(0);
}

checkStrings();
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const version = copyStatic();
writeLocales();

if (args.has('--watch')) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
  console.log('Watching for changes…');
} else {
  const results = await Promise.all(entries.map((e) => build({ ...common, ...e })));
  moveSourceMaps();
  console.log(`Built SceneVoice ${version} into dist/ (source maps in dist-maps/)`);
  if (args.has('--metafile')) reportSizes(results);
  if (args.has('--zip')) {
    const stray = entriesOf(dist, (name) => !PACKAGED.has(name.slice(name.lastIndexOf('.'))));
    if (stray.length) {
      console.error(`dist/ holds files the package does not allow: ${stray.map((e) => e.name).join(', ')}`);
      process.exit(1);
    }
    const zip = join(root, `scenevoice-${version}.zip`);
    writeZip(zip, entriesOf(dist, (name) => PACKAGED.has(name.slice(name.lastIndexOf('.')))));
    const mapZip = join(root, `scenevoice-${version}-sourcemaps.zip`);
    writeZip(mapZip, entriesOf(maps, (name) => name.endsWith('.map')));
    console.log(`Packaged ${zip} and ${mapZip}`);
  }
}
