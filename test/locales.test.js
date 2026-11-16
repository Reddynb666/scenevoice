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

  it('names no browser in any language: the same package is listed in the Chrome Web Store and in Edge Add-ons', () => {
    // Edge Add-ons policy 1.1.2: an extension's interface must not reference other browsers. The shortcuts the
    // browser itself keeps are "set by the browser", and its shortcuts page is "the browser’s shortcuts page".
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(TABLES[locale])) {
        expect(text, `${locale}: ${key}`).not.toMatch(/Chrome|Chromium|Microsoft Edge|\bEdge\b|Firefox|Opera|Brave|chrome:\/\/|edge:\/\//i);
      }
    }
    expect(STRINGS.opt_keys_browser.en).toBe('Set by the browser');
    expect(STRINGS.opt_keys_browser_open.en).toBe('Open the browser’s shortcuts page');
    expect(STRINGS.opt_keys_browser.zh_CN).toBe('由浏览器设定');
    expect(STRINGS.opt_keys_browser_open.zh_CN).toBe('打开浏览器的快捷键页面');
    // Every language has the three strings in its own words: none falls back to English in the middle of a translated section.
    for (const locale of LOCALES) for (const key of ['opt_keys_browser', 'opt_keys_browser_note', 'opt_keys_browser_open']) expect(TABLES[locale][key], `${locale}: ${key}`).toBeTruthy();
    // The pages' own fallback text (shown only if a string were missing) names none either.
    for (const page of ['options', 'popup', 'welcome', 'guide', 'transcript']) expect(read(`src/${page}/${page}.html`), page).not.toMatch(/Chrome|\bEdge\b|chrome:\/\//);
    // The button still opens the shortcuts page (Edge maps the address to its own).
    expect(read('src/options/options.js')).toContain("chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })");
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

  it('has what is shown while SceneVoice Cloud is closed in every language, so a page declared German is not read half in English', () => {
    // The closed state is what ships. Its own strings (the welcome page's one path, the popup banner,
    // the two privacy points, the note about a leftover token, the voice that cannot speak) are in
    // all fourteen languages; in the twelve AI-drafted ones they are drafts like the rest of the file.
    const CLOSED = ['welcome_intro_own', 'welcome_step2_title_own', 'welcome_own_only', 'welcome_sample_done_own', 'welcome_sample_silent', 'popup_setup_body_own', 'privacy_1_own', 'privacy_4_own', 'opt_cloud_closed', 'opt_cloud_closed_token', 'error_cloud_closed', 'status_voice_failed'];
    for (const key of CLOSED) {
      expect(STRINGS[key], key).toBeTruthy();
      for (const l of LOCALES) expect(TABLES[l][key]?.trim(), `${l}: ${key}`).toBeTruthy();
    }
    for (const l of LOCALES) {
      // The note about a leftover token names the button by the label that language gives it.
      expect(TABLES[l].opt_cloud_closed_token, `${l}: opt_cloud_closed_token`).toContain(TABLES[l].opt_cloud_stop);
      // Neither privacy point speaks of the relay or of sharing.
      for (const key of ['privacy_1_own', 'privacy_4_own']) expect(TABLES[l][key], `${l}: ${key}`).not.toMatch(/Cloud|云端|雲端/);
    }
  });

  it('gives the relay no address in any language, and does not call it closed where it can only be seen open', () => {
    for (const l of LOCALES) {
      for (const [key, text] of Object.entries(TABLES[l])) {
        // No string names a host for the relay: it has none until the project holds a domain.
        expect(text, `${l}: ${key}`).not.toMatch(/\bapi\.[a-z0-9-]+\.[a-z]{2,}|\.invalid\b/);
      }
      // These two say where a Cloud request goes: to the relay, by name.
      for (const key of ['privacy_6', 'web_privacy_leaves']) if (TABLES[l][key]) expect(TABLES[l][key], `${l}: ${key}`).toMatch(/SceneVoice Cloud|SceneVoice 云端|SceneVoice 雲端/);
    }
    // The web player shows this hint only while Cloud is open (src/web/app.js removes the choice otherwise).
    for (const l of LOCALES) if (TABLES[l].web_source_cloud_hint) expect(TABLES[l].web_source_cloud_hint.split(/[.。]/).filter((part) => part.trim()).length, `${l}: web_source_cloud_hint is one or two sentences, without "not open yet"`).toBeLessThanOrEqual(2);
    expect(TABLES.en.web_source_cloud_hint).toBe('The project’s own key through the SceneVoice relay, with an anonymous device token and a free daily allowance.');
    expect(TABLES.zh_CN.web_source_cloud_hint).toBe('用项目自己的密钥，经 SceneVoice 中转服务器，凭匿名设备凭证和每天的免费额度。');
    expect(read('site/play/index.html')).toContain(`data-i18n="web_source_cloud_hint">${TABLES.en.web_source_cloud_hint}</p>`);
    expect(read('src/web/app.js')).toMatch(/sourceChoice\?\.remove\(\)/);
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

  it('the store summary says what SceneVoice does (who reads the descriptions), not that it works with a screen reader', () => {
    // Nobody has completed a test of the extension with a screen reader user yet (the README
    // and the store description say so), and this is the line both stores show under the name.
    // So it states the mechanism: the descriptions are read by the listener's own screen reader
    // or by a built-in voice. Each alternative below is the claim as an earlier draft of one
    // language made it; "designed for screen reader users" was a draft too, and said nothing
    // of what the extension does.
    const claims = /Works with|Funciona con|Funktioniert mit|Fonctionne avec|Funciona com|Bekerja dengan|Hoạt động cùng|Работает с|काम करता है|يعمل مع|一緒に動きます|함께 쓸 수|可搭配|可配合|配合读屏软件使用|搭配螢幕閱讀器使用|Designed for screen reader users|NVDA|JAWS|VoiceOver/;
    for (const l of LOCALES) expect(TABLES[l].ext_description, `${l} ext_description`).not.toMatch(claims);
    expect(TABLES.en.ext_description).toMatch(/ Read by your screen reader or a built-in voice\.$/);
    expect(TABLES.zh_CN.ext_description).toMatch(/，由你自己的读屏软件或内置语音朗读。$/);
    // Every language names both ways of hearing them, in the words its own interface uses for the built-in voice.
    const lower = (text) => text.toLocaleLowerCase();
    for (const l of LOCALES) {
      const voice = lower(TABLES[l].output_tts).replace(/^(the|der|die|das|la|le|el|o|a) /, '').replace(/^ال/, '');
      const stem = voice.slice(0, Math.max(4, voice.length - 3));
      expect(lower(TABLES[l].ext_description), `${l} names the built-in voice (${TABLES[l].output_tts})`).toContain(stem);
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
