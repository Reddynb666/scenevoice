// A domain the project does not hold must never be written where it would be used, or
// taken for the project's own. Version 1.1.0 named one as the SceneVoice Cloud relay:
// whoever holds that domain could answer as the relay, be sent video links, titles,
// questions and pictures, and have their text read out as descriptions (SECURITY.md,
// "The relay address in version 1.1.0"). Three rules keep it from coming back:
//
//  1. That domain is named nowhere in what ships or speaks for the project: the sources
//     (src/, the film engine included), static/, scripts/, the site, the relay (server/),
//     the tests, the workflows and the documents. The exceptions are the few texts that
//     tell what happened, and there every passage that names it says it is not ours.
//  2. While SceneVoice Cloud is closed, the relay's address is a placeholder on the
//     reserved .invalid top-level domain, which can never resolve; open, it is a real
//     address. The build refuses anything else (scripts/manifest.mjs, scripts/build.mjs).
//  3. The manifest, as built with Cloud closed, lists the two model hosts and no other.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLES } from '../scripts/locales.mjs';
import { CLOUD_HOST_PERMISSION, isPlaceholderAddress, relayAddressProblem, stampManifest } from '../scripts/manifest.mjs';
import { CLOUD_API_BASE, CLOUD_OPEN, DEFAULT_API_BASE, DEFAULT_QWEN_API_BASE } from '../src/shared/constants.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/**
 * The domain version 1.1.0 named, which was never the project's. Written in two parts so
 * that this file is not itself a hit when the repository is searched for the name.
 */
const FOREIGN = ['scenevoice', 'app'].join('.');

/** Folders searched in full, and what is left out of them: installed packages and build products (none is in git). */
const SEARCHED = ['src', 'static', 'scripts', 'site', 'server', 'test', 'docs', '.github', 'desktop', 'tools'];
/** Folders never entered: installed packages, build products, downloaded films and models. */
const NOT_ENTERED = new Set(['node_modules', '__pycache__', 'dist', 'build', 'out', 'fixtures', 'models', '.git']);
const LEFT_OUT = [/(^|\/)node_modules\//, /(^|\/)__pycache__\//, /^site\/play\/player\.js$/, /^test\/e2e\/output\//];
const TEXT_FILE = /\.(js|mjs|cjs|json|html|css|md|py|toml|yml|yaml|svg|txt|sh)$/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) return [path];
    return NOT_ENTERED.has(name) ? [] : walk(path);
  });
}

/** Every text file searched, as paths from the repository root. */
function searchedFiles() {
  const inFolders = SEARCHED.filter((dir) => existsSync(join(root, dir))).flatMap((dir) => walk(join(root, dir)));
  const atRoot = readdirSync(root).filter((name) => /\.(md|json|js|mjs)$/.test(name) && statSync(join(root, name)).isFile()).map((name) => join(root, name));
  return [...inFolders, ...atRoot]
    .map((path) => relative(root, path).split(sep).join('/'))
    .filter((rel) => TEXT_FILE.test(rel) && !LEFT_OUT.some((skip) => skip.test(rel)));
}

/**
 * The texts that tell what happened, and the words by which each passage naming the
 * domain says it is not the project's. A passage is a paragraph or a list item.
 */
const TELLS_WHAT_HAPPENED = {
  'SECURITY.md': /never the project's/,
  'CHANGELOG.md': /never the project's/,
  'docs/plan-2026-11.zh-CN.md': /不是项目的/,
  'docs/store-submission.zh-CN.md': /不是项目的/,
};

/** A text as passages: a new one starts after a blank line, at a heading, or at a list item. */
function passages(text) {
  const out = [];
  let current = [];
  const close = () => {
    if (current.length) out.push(current.join(' ').replace(/\s+/g, ' '));
    current = [];
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) close();
    else {
      if (/^\s*([-*]|\d+\.)\s|^#{1,6}\s/.test(line)) close();
      current.push(line.trim());
    }
  }
  close();
  return out;
}

describe('the domain version 1.1.0 named', () => {
  const files = searchedFiles();

  it('is searched for in the sources, the site, the relay, the tests and the documents', () => {
    // The search really covers what it claims to: a file of each kind is among those read.
    for (const rel of ['src/shared/constants.js', 'src/film/types.js', 'src/options/options.html', 'static/manifest.json', 'scripts/locales/de.mjs', 'scripts/screenshots.py', 'site/index.html', 'site/zh-CN/index.html', 'site/play/index.html', 'server/wrangler.toml', 'server/README.md', 'server/src/worker.js', 'server/test/devices.test.js', 'test/e2e/e2e.py', 'docs/store-listing.md', '.github/workflows/pages.yml', 'PRIVACY.md', 'PRIVACY.zh-CN.md', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'package.json']) {
      expect(files, rel).toContain(rel);
    }
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((rel) => LEFT_OUT.some((skip) => skip.test(rel)))).toBe(false);
  });

  it('is named nowhere, except by the texts that tell what happened', () => {
    const naming = files.filter((rel) => read(rel).includes(FOREIGN));
    expect(naming.filter((rel) => !(rel in TELLS_WHAT_HAPPENED))).toEqual([]);
    // The note exists where a reader looks for it.
    expect(naming).toContain('SECURITY.md');
    expect(naming).toContain('CHANGELOG.md');
  });

  it('is called not the project\'s in every passage that names it', () => {
    for (const [rel, saysSo] of Object.entries(TELLS_WHAT_HAPPENED)) {
      for (const passage of passages(read(rel)).filter((p) => p.includes(FOREIGN))) {
        expect(passage, `${rel}: a passage names the domain without saying it is not the project's`).toMatch(saysSo);
      }
    }
  });

  it('is in no interface string of any language, and no string gives the relay an address', () => {
    for (const [locale, table] of Object.entries(TABLES)) {
      for (const [key, text] of Object.entries(table)) {
        expect(text, `${locale}: ${key}`).not.toContain(FOREIGN);
        expect(text, `${locale}: ${key}`).not.toContain(new URL(CLOUD_API_BASE).hostname);
      }
    }
  });
});

describe('the security note', () => {
  const security = read('SECURITY.md');
  const note = security.split('\n## The relay address in version 1.1.0\n')[1]?.split('\n## ')[0].replace(/\s+/g, ' ');
  const changelog = read('CHANGELOG.md');

  it('SECURITY.md says what was wrong, what is known, what to do and what the fixed version does', () => {
    expect(note, 'the section "The relay address in version 1.1.0"').toBeTruthy();
    expect(note).toMatch(/Found on 16 November 2026\. Fixed in the version after 1\.1\.0\./);
    expect(note).toContain(`\`api.${FOREIGN}\``);
    expect(note).toMatch(/That domain was never the project's/);
    expect(note).toMatch(/the address did not resolve/);
    expect(note).toMatch(/no request is known to have been answered/);
    expect(note).toMatch(/If you installed 1\.1\.0, update to a later version/);
    expect(note).toMatch(/do not press \*Start free\*/);
    expect(note).toMatch(/SceneVoice Cloud is not offered anywhere/);
    expect(note).toMatch(/asks for no permission for a relay address and makes no request to one/);
    // The domain is named in that section and nowhere else in the file.
    expect(security.split(FOREIGN).length - 1).toBe(note.split(FOREIGN).length - 1);
    // Reports go to GitHub's private reporting; no made-up address is published.
    expect(security).toContain('https://github.com/reddynb666/scenevoice/security/advisories/new');
    expect(security).not.toMatch(/[\w.+-]+@[\w-]+\.(example|invalid|test)\b/);
    expect(security).toMatch(/<!-- FILL IN \(owner\)/);
  });

  it('CHANGELOG.md carries it in the entry after 1.1.0, and the 1.1.0 entry keeps its history with one pointer', () => {
    const [newer, older] = changelog.split('\n## 1.1.0 ');
    const entry = newer.split('\n').find((line) => line.startsWith('- **Security: the relay address in 1.1.0 was never the project\'s.**'));
    expect(entry, 'the security entry above the 1.1.0 section').toBeTruthy();
    for (const said of [/found on 16 November 2026/, /did not resolve/, /no request is known to have been answered/, /If you installed 1\.1\.0, update/, /is not offered anywhere/, /SECURITY\.md/]) expect(entry).toMatch(said);
    // The released entry is history: it still names the permission 1.1.0 asked for, and points to the note.
    const history = older.split('\n## ')[0].split('\n').filter((line) => line.includes(FOREIGN));
    expect(history).toHaveLength(1);
    expect(history[0]).toContain(`New host permission \`https://api.${FOREIGN}/*\` [that address was never the project's: see the security note`);
    expect(history[0].split(FOREIGN).length - 1).toBe(1);
  });
});

describe('the relay\'s address and the switch', () => {
  const placeholder = 'https://scenevoice-cloud.invalid';

  it('is a placeholder that cannot resolve for as long as Cloud is closed', () => {
    expect(relayAddressProblem()).toBe('');
    expect(isPlaceholderAddress(CLOUD_API_BASE)).toBe(!CLOUD_OPEN);
    if (!CLOUD_OPEN) {
      expect(new URL(CLOUD_API_BASE).hostname).toMatch(/\.invalid$/);
      expect(CLOUD_API_BASE).toBe(placeholder);
    }
    expect(new URL(CLOUD_API_BASE).protocol).toBe('https:');
    expect(CLOUD_HOST_PERMISSION).toBe(`${CLOUD_API_BASE}/*`);
    // The two model addresses are real, and the relay's is neither of them.
    for (const model of [DEFAULT_API_BASE, DEFAULT_QWEN_API_BASE]) {
      expect(isPlaceholderAddress(model)).toBe(false);
      expect(new URL(model).hostname).not.toBe(new URL(CLOUD_API_BASE).hostname);
    }
  });

  it('the rule: closed means the placeholder and nothing else, open means a real https address', () => {
    expect(relayAddressProblem({ cloudOpen: false, base: placeholder })).toBe('');
    expect(relayAddressProblem({ cloudOpen: false, base: 'https://relay.example.org' })).toMatch(/SceneVoice Cloud is closed, so CLOUD_API_BASE must stay a placeholder on \.invalid, not relay\.example\.org/);
    expect(relayAddressProblem({ cloudOpen: false, base: `https://api.${FOREIGN}` })).toMatch(/must stay a placeholder/);
    expect(relayAddressProblem({ cloudOpen: false, base: 'http://localhost:8787' })).toMatch(/must stay a placeholder/);
    expect(relayAddressProblem({ cloudOpen: true, base: placeholder })).toMatch(/SceneVoice Cloud is open but CLOUD_API_BASE is still the placeholder scenevoice-cloud\.invalid/);
    expect(relayAddressProblem({ cloudOpen: true, base: 'https://relay.example.org' })).toBe('');
    expect(relayAddressProblem({ cloudOpen: true, base: 'http://relay.example.org' })).toMatch(/must be an https address/);
    // A relay on the developer's own computer, for local development only.
    expect(relayAddressProblem({ cloudOpen: true, base: 'http://localhost:8787' })).toBe('');
    expect(relayAddressProblem({ cloudOpen: true, base: 'http://127.0.0.1:8787' })).toBe('');
    expect(relayAddressProblem({ cloudOpen: true, base: 'not an address' })).toMatch(/is not an address/);
    expect(isPlaceholderAddress('https://relay.your-domain.invalid')).toBe(true);
    expect(isPlaceholderAddress('https://invalid.example.org')).toBe(false);
  });

  it('is enforced by the build, on the switch as the source has it', () => {
    const build = read('scripts/build.mjs');
    expect(build).toMatch(/const addressProblem = relayAddressProblem\(\{ cloudOpen: CLOUD_OPEN \}\);\nif \(addressProblem\) \{\n {2}console\.error\(addressProblem\);\n {2}process\.exit\(1\);\n\}/);
    // The check stands before anything is written to disk.
    expect(build.indexOf('const addressProblem')).toBeLessThan(build.indexOf('function copyStatic'));
    // The source says why, where the address is.
    expect(read('src/shared/constants.js')).toMatch(/placeholder on the reserved \.invalid top-level domain[\s\S]*export const CLOUD_API_BASE = 'https:\/\/scenevoice-cloud\.invalid';/);
  });
});

describe('hosts in what is built and deployed while Cloud is closed', () => {
  const MODEL_HOSTS = ['https://generativelanguage.googleapis.com/*', 'https://dashscope.aliyuncs.com/*'];
  const source = JSON.parse(read('static/manifest.json'));

  it('the built manifest lists the two model hosts and no other', () => {
    const built = stampManifest(source, { version: '9.8.7', cloudOpen: false });
    expect(built.host_permissions).toEqual(MODEL_HOSTS);
    for (const host of built.host_permissions) expect(MODEL_HOSTS, host).toContain(host);
    // Nothing else in it is an address outside the sites it runs on and the optional pattern.
    const named = [...new Set(JSON.stringify(built).match(/https?:\/\/[^/"]+/g))].sort();
    expect(named).toEqual(['http://127.0.0.1', 'http://localhost', 'https://*', 'https://dashscope.aliyuncs.com', 'https://generativelanguage.googleapis.com', 'https://m.youtube.com', 'https://www.bilibili.com', 'https://www.youtube-nocookie.com', 'https://www.youtube.com']);
    expect(built.content_security_policy).toBeUndefined();
    expect(built.externally_connectable).toBeUndefined();
  });

  it('a build that is lying in dist/ lists them too', () => {
    // dist/ is what gets loaded by hand and packaged. It is not in git, so there may be none;
    // when there is one and Cloud is closed, it must not be a build left over from another state.
    const path = join(root, 'dist', 'manifest.json');
    if (!existsSync(path) || CLOUD_OPEN) return;
    const built = JSON.parse(readFileSync(path, 'utf8'));
    expect(built.host_permissions, 'dist/manifest.json is stale: run npm run build').toEqual(MODEL_HOSTS);
    expect(JSON.stringify(built)).not.toContain(FOREIGN);
  });

  it('the web player may connect to itself and to the Gemini API, and to nothing else', () => {
    const page = read('site/play/index.html');
    const policy = page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
    const connect = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src')).split(/\s+/).slice(1);
    if (!CLOUD_OPEN) expect(connect).toEqual(["'self'", 'https://generativelanguage.googleapis.com']);
    // Every origin the policy names anywhere is one the page is meant to use.
    const origins = [...new Set(policy.match(/https:\/\/[^\s;]+/g))].sort();
    if (!CLOUD_OPEN) expect(origins).toEqual(['https://generativelanguage.googleapis.com', 'https://s.ytimg.com', 'https://www.youtube-nocookie.com', 'https://www.youtube.com']);
  });

  it('the relay\'s configuration names placeholders, not a domain: its route and its allowed origins', () => {
    const toml = read('server/wrangler.toml');
    const hosts = [...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1]);
    const origins = toml.match(/^ALLOWED_ORIGINS = "([^"]*)"$/m)[1].split(',').map((s) => new URL(s.trim()).hostname);
    expect(hosts.length).toBe(1);
    expect(origins.length).toBeGreaterThan(0);
    for (const host of [...hosts, ...origins]) expect(host).toMatch(/\.invalid$/);
    expect(toml.match(/FILL IN/g).length).toBeGreaterThanOrEqual(2);
    expect(read('server/README.md')).toMatch(/\*\*The relay runs only under a domain its operator holds\.\*\*/);
  });
});
