import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_LOCALES, LOCALES, LOCALE_FOLDERS, SPOKEN_KEYS, STRINGS, TABLES, coverage, strayKeys } from '../scripts/locales.mjs';
import { COMMANDS } from '../src/shared/constants.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('static/manifest.json'));

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('interface strings', () => {
  it('has English and Simplified Chinese for every string, with the same placeholders', () => {
    expect(CORE_LOCALES).toEqual(['en', 'zh_CN']);
    expect(LOCALES.slice(0, 2)).toEqual(CORE_LOCALES);
    for (const [key, v] of Object.entries(STRINGS)) {
      for (const l of CORE_LOCALES) expect(v[l]?.trim(), `${l}: ${key}`).toBeTruthy();
      const reference = (v.en.match(/\$\d/g) || []).sort().join();
      for (const l of LOCALES) if (v[l]) expect((v[l].match(/\$\d/g) || []).sort().join(), `placeholders in ${l}: ${key}`).toBe(reference);
    }
  });

  it('ships other languages only when they are nearly complete, with no stale keys', () => {
    for (const l of LOCALES) {
      expect(strayKeys(l), `${l} keys English does not have`).toEqual([]);
      if (!CORE_LOCALES.includes(l)) expect(coverage(l), `${l} coverage`).toBeGreaterThanOrEqual(0.9);
      // Keys follow the order of en.mjs, so the files can be read side by side.
      const order = Object.keys(TABLES.en).filter((k) => k in TABLES[l]);
      expect(Object.keys(TABLES[l]), `${l} key order`).toEqual(order);
    }
  });

  it('has the strings spoken during playback in every language, so no English is spliced into a description', () => {
    expect(SPOKEN_KEYS).toContain('late_prefix');
    for (const l of LOCALES) for (const key of SPOKEN_KEYS) expect(STRINGS[key]?.[l]?.trim(), `${l}: ${key}`).toBeTruthy();
  });

  it('keeps Chinese characters out of short labels in languages whose voices cannot read them', () => {
    // A Spanish or Russian screen-reader voice has no reading for 通义千问: a select option or
    // heading holding it is announced with a gap or noise in the middle. Longer prose may gloss
    // the Chinese name; the provider labels and guide headings must not.
    const readsHan = ['ja', 'ko', 'zh_CN', 'zh_TW'];
    for (const l of LOCALES) {
      if (readsHan.includes(l)) continue;
      for (const [key, text] of Object.entries(TABLES[l])) {
        if (/^provider_|^guide_\w+_title$/.test(key)) expect(text, `${l}: ${key}`).not.toMatch(/\p{Script=Han}/u);
      }
    }
  });

  it('keeps the store name and summary within the manifest limits, naming both sites', () => {
    // Chrome: name 45 characters, description 132. Both stores show these.
    for (const l of LOCALES) {
      expect(TABLES[l].ext_name.length, `${l} ext_name`).toBeLessThanOrEqual(45);
      expect(TABLES[l].ext_description.length, `${l} ext_description`).toBeLessThanOrEqual(132);
      expect(TABLES[l].ext_description, `${l} names Bilibili`).toMatch(/Bilibili|哔哩哔哩/);
    }
  });

  it('writes a bare parent folder for every regional locale, so pt-PT and zh-HK browsers do not get English', () => {
    // Chrome resolves pt_PT → pt → default_locale and never tries pt_BR; the
    // build therefore writes _locales/pt from pt_BR (and zh from zh_CN, the
    // core locale, not zh_TW), and each folder's ui_lang names its source.
    const folders = Object.fromEntries(LOCALE_FOLDERS);
    for (const locale of LOCALES) {
      expect(folders[locale], `${locale} folder`).toBe(locale);
      const base = locale.split('_')[0];
      expect(folders[base], `${base} folder for ${locale}`).toBeTruthy();
      expect(LOCALES, `${base} folder written from a shipped locale`).toContain(folders[base]);
    }
    expect(folders.zh).toBe('zh_CN');
    expect(folders.pt).toBe('pt_BR');
    expect(new Set(LOCALE_FOLDERS.map(([f]) => f)).size, 'no folder written twice').toBe(LOCALE_FOLDERS.length);
  });

  it('translates every string into Chinese', () => {
    const same = Object.entries(STRINGS).filter(([, v]) => v.en === v.zh_CN).map(([k]) => k);
    expect(same).toEqual(['value_percent']);
  });

  it('defines every string the source uses', () => {
    const used = new Set();
    for (const file of walk(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/data-i18n="([a-z0-9_]+)"/g)) used.add(m[1]);
    }
    for (const m of read('static/manifest.json').matchAll(/__MSG_([a-z0-9_]+)__/g)) used.add(m[1]);
    // ui_lang and ui_dir are not strings: build.mjs writes them into each folder's messages.json (the folder's language and direction).
    const generated = new Set(['ui_lang', 'ui_dir']);
    const missing = [...used].filter((k) => !STRINGS[k] && !generated.has(k));
    expect(missing).toEqual([]);
  });
});

describe('keyboard commands', () => {
  const names = Object.keys(manifest.commands);

  it('lists the same commands in the manifest and in the code', () => {
    expect(new Set(names)).toEqual(new Set(COMMANDS));
    for (const name of names) {
      const key = manifest.commands[name].description.match(/__MSG_(\w+)__/)[1];
      expect(STRINGS[key], name).toBeTruthy();
    }
  });

  it('suggests no more than the four keys Chrome allows', () => {
    const suggested = names.filter((n) => manifest.commands[n].suggested_key);
    expect(suggested.length).toBeLessThanOrEqual(4);
  });

  it('handles every command on the YouTube page', () => {
    const content = read('src/content/index.js');
    for (const name of COMMANDS) expect(content, name).toContain(`case '${name}':`);
  });

  it('announces each value a cycle shortcut can choose', () => {
    for (const v of ['brief', 'standard', 'detailed']) expect(STRINGS[`announce_detail_${v}`]).toBeTruthy();
    for (const v of ['gaps', 'pause', 'manual']) expect(STRINGS[`announce_mode_${v}`]).toBeTruthy();
    for (const v of ['essential', 'standard', 'full']) expect(STRINGS[`announce_density_${v}`]).toBeTruthy();
  });
});
