// The film engine (src/film) is pure logic shared by the desktop app and, later,
// the extension: relative imports only, into src/film and the pure part of
// src/shared; no browser, extension, Node or Electron globals; no translation
// lookups (the extension's build scans all of src/ for translation keys).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const film = join(root, 'src', 'film');
const shared = join(root, 'src', 'shared');

/** src/shared modules that need the extension (chrome.*) or a page: never reachable from src/film. */
const NOT_PURE = ['cache.js', 'storage.js', 'form.js', 'i18n.js', 'sender.js', 'shortcuts.js', 'settings.js', 'labels.js'];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Source with comments and the contents of string and template literals blanked,
 * so a word in a comment or in an exported document ("word/document.xml") is not
 * mistaken for a use of a global. Code inside ${…} of a template is kept.
 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  const stack = []; // 'tpl' while inside a template literal, a number (brace depth) while inside ${…}
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (top() === 'tpl') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        out += '`';
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push(0);
        out += '${';
        i += 2;
      } else i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < src.length && src[i] !== ch && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i += 1;
      out += `${ch}${ch}`;
      continue;
    }
    if (ch === '`') {
      stack.push('tpl');
      out += '`';
      i += 1;
      continue;
    }
    if (typeof top() === 'number') {
      if (ch === '{') stack[stack.length - 1] += 1;
      else if (ch === '}') {
        if (top() === 0) {
          stack.pop();
          out += '}';
          i += 1;
          continue;
        }
        stack[stack.length - 1] -= 1;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The import and re-export specifiers of a module, read from the source as written. */
function specifiers(src) {
  const found = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  return found;
}

const filmFiles = walk(film).filter((f) => f.endsWith('.js'));
const rel = (file) => relative(root, file).split(sep).join('/');

describe('the film engine stays pure', () => {
  it('has modules to check', () => {
    expect(filmFiles.length).toBeGreaterThan(0);
  });

  it('imports by relative path only, and reaches only src/film and the pure part of src/shared', () => {
    const problems = [];
    const seen = new Set();
    const queue = [...filmFiles];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) {
          problems.push(`${rel(file)} imports "${spec}" (not a relative path)`);
          continue;
        }
        const target = resolve(dirname(file), spec);
        const inFilm = target.startsWith(film + sep);
        const inShared = target.startsWith(shared + sep);
        if (!inFilm && !inShared) problems.push(`${rel(file)} imports ${rel(target)} (outside src/film and src/shared)`);
        else if (inShared && NOT_PURE.includes(relative(shared, target))) problems.push(`${rel(file)} reaches ${rel(target)}, which needs the extension`);
        else if (!existsSync(target)) problems.push(`${rel(file)} imports ${rel(target)}, which does not exist`);
        else queue.push(target);
      }
    }
    expect(problems).toEqual([]);
  });

  it('touches no browser, extension, Node or Electron global', () => {
    const problems = [];
    for (const file of filmFiles) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      const m = code.match(/(?<![.\w$])(chrome|document|window|navigator|localStorage|globalThis)\s*[.[]/) || code.match(/(?<![.\w$])(process)\s*\.(?:env|argv|cwd|platform|versions)\b/) || code.match(/(?<![.\w$])(require)\s*\(/);
      if (m) problems.push(`${rel(file)} uses ${m[1]}`);
    }
    expect(problems).toEqual([]);
  });

  it('has no translation lookups: the extension build would look for their keys in scripts/locales', () => {
    const problems = [];
    for (const file of walk(film)) {
      const text = readFileSync(file, 'utf8');
      if (/\bt\(\s*'/.test(text)) problems.push(`${rel(file)} calls a translation function with a literal key`);
      if (/data-i18n="/.test(text) || /__MSG_[a-z0-9_]+__/.test(text)) problems.push(`${rel(file)} holds an extension translation marker`);
    }
    expect(problems).toEqual([]);
  });

  it('uses no clock and no randomness, so every result can be reproduced', () => {
    const problems = [];
    for (const file of filmFiles) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      const m = code.match(/\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(/);
      if (m) problems.push(`${rel(file)} uses ${m[0]}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('codeOnly', () => {
  it('blanks comments and string contents, and keeps the code inside a template expression', () => {
    expect(codeOnly("const a = 'document.xml'; // window.x\nconst b = `x ${document.title} y`;")).toBe("const a = ''; \nconst b = `${document.title}`;");
    expect(codeOnly('/* chrome.tts */ call("chrome.storage")')).toBe(' call("")');
  });
});
