// @vitest-environment node
// The website: both pages pass axe and our own checks, share one structure, keep AAA
// colour tokens; and script.js (the "Hear it" sample, the language memory) behaves.
// Each test gets its own jsdom window so the script's state never leaks between tests.
//
// Also here, because they are the same kind of promise: what the public texts claim
// (the site, the READMEs' install section, the store listing, the owner's checklist
// and the testers' guide) is checked against the code they describe: the SceneVoice
// Cloud switch, the manifest's own summary, and the names of the controls they quote.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TABLES } from '../scripts/locales.mjs';
import { AI_NOTICE_SEEN_MAX, CACHE_LIMIT, CLOUD_API_BASE, CLOUD_OPEN, DEFAULT_SETTINGS, SAMPLE_DESCRIPTIONS } from '../src/shared/constants.js';
import { PAGES, TOOL_PAGES, checkSite, connectSources, contrastIssues, loadPage, pageIssues } from './check.mjs';

const BASE = 'https://example.test/scenevoice/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scriptSource = readFileSync(new URL('./script.js', import.meta.url), 'utf8');

/** A page with script.js running, short pauses (`gap` ms), and an optional fake speechSynthesis. */
function openPage(rel, { synth, stored, gap = 30 } = {}) {
  const url = rel === 'index.html' ? BASE : `${BASE}zh-CN/`;
  const dom = loadPage(rel, { url });
  const { window } = dom;
  window.document.getElementById('sample').setAttribute('data-gap', String(gap));
  if (stored) window.localStorage.setItem('scenevoice-lang', stored);
  if (synth) {
    window.speechSynthesis = synth;
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  } else {
    delete window.speechSynthesis;
    delete window.SpeechSynthesisUtterance;
  }
  window.eval(scriptSource);
  return dom;
}

/** A speechSynthesis that "speaks" each utterance a few milliseconds after speak(). */
function fakeSynth() {
  const spoken = [];
  const synth = {
    spoken,
    cancelled: 0,
    cancel() { this.cancelled++; },
    speak(u) {
      spoken.push(u.text);
      setTimeout(() => { u.onstart?.(); setTimeout(() => u.onend?.(), 5); }, 5);
    },
  };
  return synth;
}

const $ = (dom, sel) => dom.window.document.querySelector(sel);
const lines = (dom) => [...dom.window.document.querySelectorAll('#sample p')].map((p) => p.textContent);
/** A file of the repository, by its path from the root. */
const repoFile = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('site: accessibility', () => {
  it('both home pages and the web player: zero axe violations (WCAG 2.2 AA) and no own-check issues', async () => {
    const result = await checkSite();
    expect(result.pages.map((p) => p.page)).toEqual([...PAGES, ...TOOL_PAGES]);
    for (const p of result.pages) {
      expect(p.violations, p.page).toEqual([]);
      expect(p.issues, p.page).toEqual([]);
    }
  }, 30000);

  it('English and Chinese pages share one structure', async () => {
    const result = await checkSite();
    expect(result.structure).toEqual([]);
  }, 30000);

  it('colour tokens meet AAA for text and 3:1 for rings and borders, light and dark', () => {
    expect(contrastIssues()).toEqual([]);
    expect(contrastIssues({ light: { bg: '#ffffff', text: '#777777', muted: '#111111', link: '#111111', visited: '#111111', 'button-text': '#ffffff', 'button-bg': '#111111', panel: '#ffffff', focus: '#111111', border: '#111111', 'focus-gap': '#ffffff' } }))
      .toEqual(['light: --text on --bg is 4.48:1, needs 7:1', 'light: --text on --panel is 4.48:1, needs 7:1']);
  });

  it('install steps describe the welcome page, which is what opens after install', () => {
    // The extension opens welcome.html on install (focus on its heading); the settings
    // page with the key field only opens once "My own key" is chosen there.
    const install = (rel) => $(loadPage(rel), '#install').textContent;
    expect(install('index.html')).toMatch(/welcome page then opens/);
    expect(install('index.html')).not.toMatch(/settings page then opens|focus on the key field/);
    expect(install('zh-CN/index.html')).toMatch(/会打开欢迎页/);
    expect(install('zh-CN/index.html')).not.toMatch(/设置页会自动打开|焦点就在/);
  });

  it('works without JavaScript: the sample text is already on the page', () => {
    for (const rel of PAGES) {
      const dom = loadPage(rel);
      expect(lines(dom).filter((t) => t).length).toBe(6);
      expect($(dom, '#sample-status').textContent).toBe('');
    }
  });

  it('the "Hear it" buttons are hidden until script.js runs, and a noscript note says so', () => {
    for (const rel of PAGES) {
      const raw = loadPage(rel);
      expect($(raw, '#hear-buttons').hidden).toBe(true);
      expect($(raw, '#hear noscript').textContent).toMatch(/JavaScript/);
      // The CSS must not undo the attribute: .button-row is display: flex.
      expect(readFileSync(new URL('./styles.css', import.meta.url), 'utf8')).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
      const live = openPage(rel);
      expect($(live, '#hear-buttons').hidden).toBe(false);
    }
  });

  it('a broken sample block leaves the buttons hidden rather than live and dead', () => {
    const dom = loadPage('index.html', { url: BASE });
    dom.window.document.getElementById('sample-data').textContent = '{not json';
    dom.window.eval(scriptSource);
    expect($(dom, '#hear-buttons').hidden).toBe(true);
  });

  it('stores that are not open yet are plain text, never links to "#"; the only store link is GitHub', () => {
    for (const rel of PAGES) {
      const dom = loadPage(rel);
      expect(dom.window.document.querySelectorAll('a[href="#"]').length).toBe(0);
      const stores = [...dom.window.document.querySelectorAll('[data-store]')];
      expect(stores.map((s) => s.getAttribute('data-store'))).toEqual(['chrome', 'edge', 'github', 'gitee']);
      for (const s of stores) {
        if (s.tagName === 'A') expect(s.getAttribute('href')).toMatch(/^https:\/\/github\.com\//);
        else {
          expect(s.tagName).toBe('SPAN');
          expect(s.classList.contains('placeholder')).toBe(true);
          expect(s.hasAttribute('tabindex')).toBe(false);
        }
      }
      expect(stores.filter((s) => s.tagName === 'A').map((s) => s.getAttribute('data-store'))).toEqual(['github']);
    }
  });

  it('the install paragraph does not claim a store review or a Gitee release that do not exist yet', () => {
    const install = (rel) => $(loadPage(rel), '#install p').textContent;
    expect(install('index.html')).toMatch(/Store listings are on the way/);
    expect(install('index.html')).not.toMatch(/being reviewed/);
    expect(install('zh-CN/index.html')).toMatch(/商店版本正在准备/);
    expect(install('zh-CN/index.html')).not.toMatch(/正在审核|GitHub 或 Gitee|建议走/);
    expect(install('zh-CN/index.html')).toMatch(/Edge 加载项和 Gitee 镜像上线后/);
  });

  it('share previews get a PNG card with its size, on both pages; the Chinese page links the Chinese privacy policy', () => {
    for (const rel of PAGES) {
      const doc = loadPage(rel).window.document;
      const meta = (sel) => doc.querySelector(sel)?.getAttribute('content');
      expect(meta('meta[property="og:image"]')).toBe('https://reddynb666.github.io/scenevoice/assets/og.png');
      expect(meta('meta[name="twitter:image"]')).toBe('https://reddynb666.github.io/scenevoice/assets/og.png');
      expect(meta('meta[property="og:image:type"]')).toBe('image/png');
      expect([meta('meta[property="og:image:width"]'), meta('meta[property="og:image:height"]')]).toEqual(['1200', '630']);
      expect(meta('meta[name="twitter:image:alt"]')).toBe(meta('meta[property="og:image:alt"]'));
      const ld = JSON.parse(doc.querySelector('script[type="application/ld+json"]').textContent);
      expect(ld.sameAs).toBe('https://github.com/reddynb666/scenevoice');
      expect(ld.codeRepository).toBeUndefined();
    }
    // The PNG is 1200 by 630 (IHDR width and height), as the meta tags promise.
    const png = readFileSync(new URL('./assets/og.png', import.meta.url));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);

    const zh = loadPage('zh-CN/index.html').window.document;
    const privacy = [...zh.querySelectorAll('a')].filter((a) => /PRIVACY/.test(a.getAttribute('href')));
    expect(privacy.map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/reddynb666/scenevoice/blob/main/PRIVACY.zh-CN.md',
      'https://github.com/reddynb666/scenevoice/blob/main/PRIVACY.md',
      'https://github.com/reddynb666/scenevoice/blob/main/PRIVACY.zh-CN.md',
    ]);
    expect(privacy[1].getAttribute('hreflang')).toBe('en');
    expect(privacy[1].getAttribute('lang')).toBe('en');
    const en = loadPage('index.html').window.document;
    for (const a of en.querySelectorAll('a[href*="PRIVACY"]')) expect(a.getAttribute('href')).toMatch(/\/PRIVACY\.md$/);
  });
});

describe('site: "Hear it" sample', () => {
  it('screen reader mode: status first, then dialogue and description lines, then "end"', async () => {
    const dom = openPage('index.html');
    const button = $(dom, '#hear-sr');
    button.click();
    expect($(dom, '#sample-status').textContent).toMatch(/Playing three sample descriptions/);
    expect(lines(dom)).toEqual([]); // cleared, lines come one at a time
    expect(button.textContent).toBe('Stop the sample');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect($(dom, '#sample').getAttribute('aria-live')).toBe('polite');
    await wait(400);
    expect(lines(dom)).toEqual([
      'Dialogue.', 'A woman in a red coat runs across a rain-soaked street, holding a newspaper over her head.',
      'Dialogue.', 'On screen: "Chapter 2 — The Harbour". A fishing boat rounds the pier at dawn.',
      'Dialogue.', 'He takes a folded letter from his pocket, hesitates, and puts it back unopened.',
    ]);
    expect($(dom, '#sample-status').textContent).toBe('End of the sample.');
    expect(button.textContent).toBe('Hear it with your screen reader');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('pressing the button again stops the sample and says so', async () => {
    const dom = openPage('zh-CN/index.html');
    const button = $(dom, '#hear-sr');
    button.click();
    expect(button.textContent).toBe('停止示例');
    await wait(50);
    button.click();
    const count = lines(dom).length;
    expect($(dom, '#sample-status').textContent).toBe('示例已停止。');
    expect(button.textContent).toBe('用我的读屏听');
    await wait(200);
    expect(lines(dom).length).toBe(count); // nothing more arrives
  });

  it('built-in voice: speaks each line in the page language, mutes the live region while speaking, restores it after', async () => {
    const synth = fakeSynth();
    const dom = openPage('zh-CN/index.html', { synth });
    const button = $(dom, '#hear-tts');
    button.click();
    expect($(dom, '#sample-status').textContent).toBe('开始用浏览器的语音播放三条示例口述。');
    expect(button.textContent).toBe('停止示例');
    await wait(40);
    expect($(dom, '#sample').getAttribute('aria-live')).toBe('off');
    await wait(400);
    expect(synth.spoken).toEqual(['对白。', '一个穿红色大衣的女人把报纸顶在头上挡雨，跑过湿漉漉的街道。', '对白。', '屏幕文字：“第二章 码头”。天刚亮，一艘渔船绕过防波堤。', '对白。', '他从口袋里掏出一封折好的信，犹豫了一下，没拆开又放了回去。']);
    expect(lines(dom)).toEqual(synth.spoken);
    expect($(dom, '#sample').getAttribute('aria-live')).toBe('polite');
    expect($(dom, '#sample-status').textContent).toBe('示例播放完了。');
    expect(button.textContent).toBe('用浏览器的语音听');
  });

  it('built-in voice: waits a full gap (not a third) for the status and the renamed button to be read before speaking', async () => {
    // Muting the live region does not stop what the screen reader is already saying,
    // so the voice must not start until that has had the same time as in screen-reader mode.
    const synth = fakeSynth();
    const dom = openPage('index.html', { synth, gap: 600 });
    const button = $(dom, '#hear-tts');
    button.click();
    expect(button.textContent).toBe('Stop the sample'); // a second press still stops
    expect($(dom, '#sample-status').textContent).toBe("Playing three sample descriptions with the browser's voice.");
    await wait(300); // half the gap: the old third-of-a-gap delay would have spoken by now
    expect(synth.spoken).toEqual([]);
    expect($(dom, '#sample').getAttribute('aria-live')).toBe('polite');
    await wait(400); // 700 ms: the first line, and only the first, has been handed to the voice
    expect(synth.spoken).toEqual(['Dialogue.']);
    expect($(dom, '#sample').getAttribute('aria-live')).toBe('off');
  });

  it('built-in voice: stopping cancels speech; the other button cancels it too', async () => {
    const synth = fakeSynth();
    const dom = openPage('index.html', { synth });
    $(dom, '#hear-tts').click();
    await wait(40);
    $(dom, '#hear-tts').click();
    expect(synth.cancelled).toBeGreaterThan(1); // once before speaking, once to stop
    expect($(dom, '#sample-status').textContent).toBe('Sample stopped.');
    expect($(dom, '#sample').getAttribute('aria-live')).toBe('polite');
    const before = synth.cancelled;
    $(dom, '#hear-tts').click();
    await wait(40);
    $(dom, '#hear-sr').click();
    expect(synth.cancelled).toBeGreaterThan(before);
    expect($(dom, '#hear-tts').textContent).toBe("Hear it with the browser's voice");
    expect($(dom, '#hear-sr').textContent).toBe('Stop the sample');
  });

  it('without speech synthesis the button says so and leaves the sample text in place', () => {
    const dom = openPage('index.html');
    $(dom, '#hear-tts').click();
    expect($(dom, '#sample-status').textContent).toMatch(/no speech synthesis/);
    expect(lines(dom).length).toBe(6);
    expect($(dom, '#hear-tts').textContent).toBe("Hear it with the browser's voice");
  });

  it('a voice that never starts is reported instead of staying silent', async () => {
    const synth = { spoken: [], cancel() {}, speak(u) { this.spoken.push(u.text); } };
    const dom = openPage('index.html', { synth });
    $(dom, '#hear-tts').click();
    await wait(40);
    expect(synth.spoken.length).toBe(1);
    expect($(dom, '#sample').getAttribute('aria-live')).toBe('off');
    // The watchdog is 4 s in the page; here we only check that nothing else is said meanwhile.
    expect($(dom, '#sample-status').textContent).toBe("Playing three sample descriptions with the browser's voice.");
  });
});

describe('site: language memory', () => {
  it('clicking the language link remembers the choice', () => {
    const dom = openPage('index.html');
    $(dom, 'a[data-lang-switch]').click();
    expect(dom.window.localStorage.getItem('scenevoice-lang')).toBe('zh-CN');
  });

  it('a remembered other language sends the visitor there, keeping the section', () => {
    const dom = openPage('index.html', { stored: 'zh-CN' });
    // jsdom cannot navigate; it reports the attempt as a "not implemented" error.
    expect(dom.jsdomErrors.some((e) => /navigation/.test(e.message))).toBe(true);
  });

  it('no memory, or memory of this page, means no redirect', () => {
    expect(openPage('index.html').jsdomErrors).toEqual([]);
    expect(openPage('zh-CN/index.html', { stored: 'zh-CN' }).jsdomErrors).toEqual([]);
  });
});

describe('site: what the pages claim today', () => {
  it('no made-up e-mail address: until the owner has one, the contact is GitHub issues and the FILL IN note stays', () => {
    for (const rel of PAGES) {
      const raw = readFileSync(new URL(`./${rel}`, import.meta.url), 'utf8');
      const doc = loadPage(rel).window.document;
      const mail = [...doc.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute('href'));
      for (const href of mail) expect(href, rel).not.toMatch(/example\.|your-address|scenevoice\.example/);
      const contact = doc.querySelector('#organisations a[data-contact]').getAttribute('href');
      if (mail.length === 0) {
        expect(contact, rel).toBe('https://github.com/reddynb666/scenevoice/issues');
        expect(raw, rel).toMatch(/<!-- FILL IN: (contact address|联系邮箱)/);
      }
    }
  });

  it('the footer says what testing has happened, not that the extension was made with testers', () => {
    const footer = (rel) => $(loadPage(rel), '[data-testers]').textContent;
    expect(footer('index.html')).not.toMatch(/Made with blind/);
    expect(footer('index.html')).toMatch(/web player has been tried by its first testers on AppleVis/);
    expect(footer('index.html')).toMatch(/Testing with screen reader users continues/);
    expect(footer('zh-CN/index.html')).not.toMatch(/一起做出来/);
    expect(footer('zh-CN/index.html')).toMatch(/网页播放器已经由 AppleVis 上的第一批测试者试用过/);
    for (const rel of PAGES) expect(readFileSync(new URL(`./${rel}`, import.meta.url), 'utf8'), rel).toMatch(/<!-- FILL IN: (testers' names|测试者名单)/);
  });

  it('SceneVoice Cloud is planned, with no button, for as long as the switch is off', () => {
    // When CLOUD_OPEN becomes true this test fails on purpose: the pages must then be rewritten.
    for (const rel of PAGES) {
      const doc = loadPage(rel).window.document;
      const text = doc.querySelector('main').textContent;
      // The button is named in one place at most: the warning about version 1.1.0 (the next test).
      const warning = doc.querySelector('#install [data-old-release]')?.textContent || '';
      expect(text.replace(warning, ''), rel).not.toMatch(/Start free|免费开始/);
      expect(/planned and not open|还在筹备，没有开放/.test(text), rel).toBe(!CLOUD_OPEN);
      // Every plan that is not "your own key" is marked as planned in its title.
      const plans = [...doc.querySelectorAll('#cost dl.plans dt')].map((dt) => dt.textContent);
      expect(plans.length, rel).toBe(4);
      for (const plan of plans.slice(1)) expect(plan, rel).toMatch(/planned$|筹备中$/);
      // Nothing to press for Cloud: the page's only buttons are the two sample buttons.
      expect([...doc.querySelectorAll('button')].map((b) => b.id), rel).toEqual(['hear-sr', 'hear-tts']);
      for (const a of doc.querySelectorAll('a')) expect(a.textContent, rel).not.toMatch(/Cloud|云端/);
    }
    // What is planned for organisations is said to be planned, not offered.
    expect($(loadPage('index.html'), '#organisations').textContent).toMatch(/^\s*For organisations and creators\s*Planned, not available yet/);
    expect($(loadPage('zh-CN/index.html'), '#organisations').textContent).toMatch(/还在筹备、现在没有/);
  });

  it('version 1.1.0 is not to be installed: the install section says so before any download link, and "no button" and "no server" are said of 1.2.0 on', () => {
    // The site goes live on the merge to main, before 1.2.0 exists, and 1.1.0 is the only release
    // the Releases page lists that day (its zip was withdrawn on 16 November 2026; copies are
    // installed). Its Start free button points at an address that was never the project's
    // (SECURITY.md), so the page names no download as ready: it says which version to install and
    // which not to. Shorten the warning, and drop "from version 1.2.0", once 1.2.0 is out.
    const en = loadPage('index.html').window.document;
    const zh = loadPage('zh-CN/index.html').window.document;
    const warning = (doc) => doc.querySelector('#install [data-old-release]').textContent;
    const said = {
      en: 'Install version 1.2.0 or later; do not install version 1.1.0. On its welcome page, 1.1.0 shows “Start free” (SceneVoice Cloud), which points at an address that was never the project\'s. The fix is in the version after it, 1.2.0.',
      zh: '请安装 1.2.0 或更新的版本，不要安装 1.1.0。1.1.0 的欢迎页上有“免费开始”（SceneVoice 云端），它指向的地址从来不是项目的。这个问题在它之后的版本 1.2.0 里修复。',
    };
    expect(warning(en)).toBe(`${said.en} If the Releases page does not list 1.2.0 yet, use the web player until it does.`);
    expect(warning(zh)).toBe(`${said.zh}如果 Releases 页面上还没有 1.2.0，请先用网页播放器。`);
    // The same sentences as the READMEs' install section (there with Markdown emphasis), which point to SECURITY.md.
    for (const [readme, sentence] of [['README.md', said.en.replace('“Start free”', '*Start free*')], ['README.zh-CN.md', said.zh]]) {
      const install = repoFile(readme).split(/\n## (?:Install|安装)\n/)[1].split(/\n### /)[0];
      expect(install, readme).toContain(sentence);
      expect(install, readme).toContain('(./SECURITY.md)');
      expect(install, readme).not.toMatch(/Take the newest release|请下载最新的版本|that service never opened|这项服务从未开放/);
    }
    // It names the button as 1.1.0 has it, which is no longer on the welcome page of the build that ships.
    expect(TABLES.en.welcome_start_free).toBe('Start free');
    expect(TABLES.zh_CN.welcome_start_free).toBe('免费开始');
    for (const doc of [en, zh]) {
      // A reader meets the warning before the row of download links, and the web player is offered meanwhile.
      const children = [...doc.querySelector('#install').children];
      const at = (sel) => children.findIndex((c) => c.matches(sel));
      expect(at('[data-old-release]')).toBeGreaterThan(0);
      expect(at('[data-old-release]')).toBeLessThan(at('.button-row'));
      expect(doc.querySelector('#install [data-old-release] a').getAttribute('href')).toMatch(/play\//);
      // The one download link is the list of releases, labelled with the version to take: nothing links the 1.1.0 files.
      expect(doc.querySelector('#install a[data-store="github"]').getAttribute('href')).toBe('https://github.com/reddynb666/scenevoice/releases');
      expect(doc.querySelector('#install a[data-store="github"]').textContent).toMatch(/1\.2\.0/);
      for (const a of doc.querySelectorAll('a')) expect(a.getAttribute('href')).not.toMatch(/1\.1\.0|releases\/(download|tag|latest)/);
      expect(doc.querySelector('#install').textContent).not.toMatch(/Take the newest release|请下载最新的版本/);
    }
    for (const readme of ['README.md', 'README.zh-CN.md']) expect(repoFile(readme), readme).not.toMatch(/releases\/(download|tag)\/v?1\.1\.0|scenevoice-1\.1\.0\.zip/);
    // What is true only of the build with the switch off is not said of "the extension" at large.
    expect(en.querySelector('#cost').textContent).toMatch(/there is no button for it in the web player, or in the extension from version 1\.2\.0 on\./);
    expect(en.querySelector('#privacy').textContent).toMatch(/the web player, and the extension from version 1\.2\.0 on, contact no SceneVoice server at all\./);
    expect(en.querySelector('main').textContent).not.toMatch(/today's extension|no button for it in the extension or/);
    expect(zh.querySelector('#cost').textContent).toMatch(/网页播放器里没有它的按钮，扩展从 1\.2\.0 版起也没有。/);
    expect(zh.querySelector('#privacy').textContent).toMatch(/网页播放器，以及 1\.2\.0 版起的扩展，都不联系 SceneVoice 的任何服务器。/);
    expect(zh.querySelector('main').textContent).not.toMatch(/现在的扩展|扩展和网页播放器里都没有它的按钮/);
  });

  it('the relay is given no address, and the privacy section carries the Limited Use statement', () => {
    const en = loadPage('index.html').window.document.querySelector('#privacy').textContent;
    const zh = loadPage('zh-CN/index.html').window.document.querySelector('#privacy').textContent;
    // The relay is planned and has no address: the page says so instead of naming one.
    expect(en).toMatch(/a relay run by the project, on a domain the project holds, with an anonymous device token; the relay has no address yet/);
    expect(zh).toMatch(/中转会放在项目自己持有的域名下，请求携带匿名的设备凭证；中转现在还没有地址/);
    for (const text of [en, zh]) expect(text).not.toMatch(/planned address|计划使用的地址|\bapi\./);
    // Chrome Web Store, Limited Use: the affirmative statement on a website belonging to the extension
    // (the policies carry it in full; test/docs.test.js).
    expect(en).toMatch(/SceneVoice's use of user data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements/);
    expect(zh).toMatch(/SceneVoice 对用户数据的使用符合 Chrome 应用商店的用户数据政策，包括其中的 Limited Use（有限使用）要求/);
  });

  it('the one-sentence claim does not promise "any" video, and the page says what cannot be described', () => {
    const en = loadPage('index.html').window.document;
    const zh = loadPage('zh-CN/index.html').window.document;
    for (const sel of ['.lead', 'meta[name="description"]', 'meta[property="og:description"]', 'meta[property="og:image:alt"]']) {
      expect(en.querySelector(sel).textContent + (en.querySelector(sel).getAttribute('content') || ''), sel).not.toMatch(/\bany\b/i);
      expect(zh.querySelector(sel).textContent + (zh.querySelector(sel).getAttribute('content') || ''), sel).not.toMatch(/任何|任意/);
    }
    expect(en.querySelector('#hook').textContent).toMatch(/Live streams, private or age-restricted videos and paid or members-only \(DRM-protected\) videos cannot be described/);
    expect(en.querySelector('#hook').textContent).toMatch(/Bilibili support is experimental/);
    expect(zh.querySelector('#hook').textContent).toMatch(/直播、私享或有年龄限制的视频，以及付费、会员专享（受 DRM 保护）的视频目前无法描述/);
    expect(zh.querySelector('#hook').textContent).toMatch(/哔哩哔哩的支持还是实验性的/);
    // The share card is rendered from the SVG: its words are the same claim.
    const card = readFileSync(new URL('./assets/og.svg', import.meta.url), 'utf8');
    const words = [...card.matchAll(/<(?:text|desc)[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(words.length).toBeGreaterThan(4);
    for (const line of words) expect(line).not.toMatch(/\bany\b/i);
  });

  it('install: the welcome page step names the control that is there, and testers in China are sent to their guide', () => {
    const en = $(loadPage('index.html'), '#install').textContent;
    const zh = $(loadPage('zh-CN/index.html'), '#install').textContent;
    expect(en).toContain(`“${TABLES.en.welcome_own_key_link}”`);
    expect(zh).toContain(`“${TABLES.zh_CN.welcome_own_key_link}”`);
    for (const rel of PAGES) {
      const links = [...loadPage(rel).window.document.querySelectorAll('#install a')].map((a) => a.getAttribute('href'));
      expect(links, rel).toContain('https://github.com/reddynb666/scenevoice/blob/main/docs/tester-guide.zh-CN.md');
    }
  });
});

describe('site: the web player page follows the SceneVoice Cloud switch', () => {
  const relay = new URL(CLOUD_API_BASE).origin;
  /** The page with its policy rewritten, as an owner might edit it. */
  function withConnect(sources) {
    const dom = loadPage('play/index.html');
    const meta = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    meta.setAttribute('content', meta.getAttribute('content').replace(/connect-src[^;]*/, `connect-src ${sources.join(' ')}`));
    return dom;
  }
  const cloudIssues = (dom, cloudOpen) => pageIssues(dom, 'play/index.html', { cloudOpen }).filter((i) => /SceneVoice Cloud|connect-src/.test(i));

  it('as served: the policy lets the page reach the relay exactly when Cloud is open', () => {
    const sources = connectSources(loadPage('play/index.html').window.document);
    expect(sources).toContain("'self'");
    expect(sources).toContain('https://generativelanguage.googleapis.com');
    expect(sources.includes(relay)).toBe(CLOUD_OPEN);
    expect(sources.length).toBe(CLOUD_OPEN ? 3 : 2);
  });

  it('closed: a policy that lists the relay is refused; open: a policy without it is refused', () => {
    const without = ["'self'", 'https://generativelanguage.googleapis.com'];
    expect(cloudIssues(withConnect(without), false)).toEqual([]);
    expect(cloudIssues(withConnect([...without, relay]), false)).toEqual([`play/index.html: SceneVoice Cloud is closed but connect-src lists the relay: remove ${relay} from the Content-Security-Policy`]);
    expect(cloudIssues(withConnect(without), true)).toEqual([`play/index.html: SceneVoice Cloud is open but connect-src does not list the relay: add ${relay} to the Content-Security-Policy`]);
    expect(cloudIssues(withConnect([...without, relay]), true)).toEqual([]);
    const none = loadPage('play/index.html');
    none.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').remove();
    expect(cloudIssues(none, false)).toEqual(['play/index.html: no connect-src in the Content-Security-Policy']);
  });

  it('closed: the page as served shows no Cloud choice and says nothing about Cloud, the relay or a device token', () => {
    const dom = loadPage('play/index.html');
    const doc = dom.window.document;
    // The choice is in the HTML for the day Cloud opens, and ships hidden: the script removes it or shows it.
    const cloud = doc.getElementById('source-cloud');
    expect(cloud).not.toBeNull();
    expect(cloud.closest('fieldset').hidden).toBe(true);
    expect(doc.getElementById('source-own').closest('fieldset').hidden).toBe(true);
    // The key field is outside that group, so a visitor always has it.
    expect(doc.getElementById('key').closest('[hidden]')).toBeNull();
    expect(cloudIssues(dom, false)).toEqual([]);
    // The two privacy points carry the own-key wording the script also uses while Cloud is closed.
    expect(doc.querySelector('[data-i18n="web_privacy_leaves"]').textContent).toBe(TABLES.en.web_privacy_leaves_own);
    expect(doc.querySelector('[data-i18n="web_privacy_local"]').textContent).toBe(TABLES.en.web_privacy_local_own);

    // Shown, the choice is a finding; so is any sentence about Cloud left in view.
    doc.getElementById('source-cloud').closest('fieldset').hidden = false;
    expect(cloudIssues(dom, false)).toEqual([
      'play/index.html: SceneVoice Cloud is closed but its choice is shown as served: ship it hidden',
      'play/index.html: SceneVoice Cloud is closed but the page as served still speaks of it',
    ]);
    const wordy = loadPage('play/index.html');
    wordy.window.document.querySelector('[data-i18n="web_privacy_leaves"]').textContent = TABLES.en.web_privacy_leaves;
    expect(cloudIssues(wordy, false)).toEqual(['play/index.html: SceneVoice Cloud is closed but the page as served still speaks of it']);
  });
});

describe('texts for the stores, the owner and the testers', () => {
  const listing = repoFile('docs/store-listing.md');
  // The two texts that are pasted into the stores, from the **EN** mark to the next section.
  const description = listing.split('\n## Description\n')[1].split('\n## Category\n')[0].split('\n**EN**\n')[1];
  const reviewer = listing.split('\n## Notes for the reviewer\n')[1].split('\n## Edge Add-ons')[0].split('```')[1];

  it('store listing: the name and the summary are the manifest\'s own, in English and Chinese', () => {
    // The stores show ext_name and ext_description from the package, whatever a form says.
    expect(listing).toContain(`\nEN: ${TABLES.en.ext_name} (${TABLES.en.ext_name.length} characters)\n`);
    expect(listing).toContain(`\nZH: ${TABLES.zh_CN.ext_name}\n`);
    expect(listing).toContain(`\nEN: ${TABLES.en.ext_description}\n`);
    expect(listing).toContain(`\nZH: ${TABLES.zh_CN.ext_description}\n`);
    // The summary is held to the description's rule: no screen reader is said to work
    // (test/locales.test.js checks the same line in every language).
    const summary = listing.split('\n## Summary (132 characters max)\n')[1].split('\n## Description\n')[0];
    expect(summary).not.toMatch(/NVDA|JAWS|VoiceOver|Works with|配合读屏软件使用/);
    // It says what SceneVoice does: who reads the descriptions.
    expect(summary).toMatch(/\nEN: .* Read by your screen reader or a built-in voice\.\n/);
    expect(summary).toMatch(/\nZH: .*，由你自己的读屏软件或内置语音朗读。\n/);
    for (const line of summary.split('\n').filter((l) => /^(EN|ZH): /.test(l))) expect(line.slice(4).length).toBeLessThanOrEqual(132);
  });

  it('store listing: the description claims only what is true today', () => {
    // No screen reader is named as working: nobody has completed a test with one yet.
    expect(description).not.toMatch(/NVDA|JAWS|VoiceOver|Works with/);
    expect(description).toMatch(/Testing with screen reader users is under way and not finished/);
    expect(description).toMatch(/读屏用户的实测正在进行，还没有完成/);
    // Not "any" video, and the exceptions are named.
    expect(description).not.toMatch(/\bany YouTube\b|任意 YouTube|任何 YouTube/i);
    expect(description).toMatch(/live streams, private or age-restricted videos, and DRM-protected videos/);
    expect(description).toMatch(/直播、私享或有年龄限制的视频，以及受版权保护（DRM，付费或会员专享）的视频/);
    // Bilibili with Qwen is experimental, as the settings page and the privacy policy say.
    expect(description).toMatch(/experimentally, to Bilibili videos/);
    expect(description).toMatch(/• Bilibili \(experimental\)/);
    expect(description).toMatch(/• 哔哩哔哩（实验性）/);
    expect(TABLES.en.set_provider_bilibili).toMatch(/experimental/);
    // Edge Add-ons: a listing may not name another browser, and the same text serves both stores.
    expect(description).not.toMatch(/Chrome|Firefox|Safari|\bEdge\b|\bBrave\b|Opera/);
    // Cloud is in the description exactly when the switch is on; this fails on purpose the day it flips.
    expect(/SceneVoice Cloud|云端|Start free|免费开始/.test(description)).toBe(CLOUD_OPEN);
    expect(listing).toMatch(/\n## When SceneVoice Cloud opens\n/);
    // Edge: 250 to 10,000 characters for each language's description.
    for (const part of [description.split('**ZH**')[0], description.split('**ZH**')[1]]) {
      expect(part.trim().length).toBeGreaterThan(250);
      expect(part.trim().length).toBeLessThan(10000);
    }
  });

  it('store listing: the data answers match the code', () => {
    const data = listing.split('\n## Data usage disclosure\n')[1].split('\n## Notes for the reviewer\n')[0];
    expect(data).toMatch(/re-reads that video's watch page and, when the video has captions, its caption file, from YouTube itself/);
    expect(data).toMatch(/as soon as the page loads, before any key is pressed/);
    expect(data).toMatch(/made by the worker of the extension's offscreen document, not by the service worker/);
    expect(data).not.toMatch(/nothing is read from pages the user does not describe|service worker's network panel/);
    // Web history: ticked, and the facts given for it are the code's.
    // (It used to read "No ... keeps no list of the pages a user visits", which the two lists below
    // contradict, and then "the owner decides"; the privacy policy lists both, so the answer is Yes.)
    expect(data).toMatch(/- Web history: \*\*Yes\.\*\*/);
    expect(data).not.toMatch(/Web history: \*\*(No|the owner decides)/);
    expect(data).not.toMatch(/keeps no list of the pages a user visits/);
    expect(data).toMatch(/the address and title of the one video the user asks to have described; they go to the model the user chose/);
    expect(data).toContain(`each with its descriptions and the time it was last used (up to ${CACHE_LIMIT} videos, in \`chrome.storage.local\``);
    expect(data).toContain(`the last ${AI_NOTICE_SEEN_MAX}, are kept with the settings in \`chrome.storage.sync\``);
    expect(data).toMatch(/\(by default it is said every time\)/);
    expect(DEFAULT_SETTINGS.aiNoticeEveryTime).toBe(true);
    expect(repoFile('src/shared/cache.js')).toMatch(/index\[key\] = Date\.now\(\)/);
    expect(repoFile('src/content/index.js')).toMatch(/chrome\.storage\.sync\.set\(\{ \[AI_NOTICE_SEEN_KEY\]: \[\.\.\.list, id\]\.slice\(-AI_NOTICE_SEEN_MAX\) \}\)/);
    // The storage justification says where each thing is kept, as the privacy policy does.
    const storage = listing.split('\n## Permission justifications\n')[1].split('\n').find((l) => l.startsWith('- `storage`, `unlimitedStorage`:'));
    expect(storage).toMatch(/settings in the browser's synced storage \(`chrome\.storage\.sync`/);
    expect(storage).toMatch(/the API key, usage counts and generated description scripts on this computer only \(`chrome\.storage\.local`\)/);
    expect(storage).not.toMatch(/settings, usage counts and generated description scripts on the user's computer/);
    expect(repoFile('src/shared/storage.js')).toMatch(/chrome\.storage\.sync\.get\('settings'\)/);
    for (const [policy, said] of [['PRIVACY.md', /settings sync to your other browsers through your browser account/], ['PRIVACY.zh-CN.md', /设置会通过你的浏览器账号同步到你的其他浏览器/]]) {
      expect(repoFile(policy), policy).toMatch(said);
      expect(repoFile(policy), policy).not.toMatch(/keep your key, settings and generated descriptions on your computer|在你的电脑上保存 Key、设置和已生成的口述/);
    }
    // The service worker really makes no request, and the content script really reads the watch page unasked.
    expect(repoFile('src/background/index.js')).not.toMatch(/\bfetch\(/);
    expect(repoFile('src/content/youtube.js')).toMatch(/fetch\(`\$\{location\.origin\}\/watch\?v=/);
  });

  it('store listing: the reviewer notes quote controls by their current names and leave the key as FILL IN', () => {
    for (const key of ['welcome_output_legend', 'output_tts', 'welcome_sample_button', 'welcome_own_key_link', 'opt_key_label', 'opt_key_save', 'opt_speech_title', 'set_output', 'set_show_text']) {
      expect(reviewer, key).toContain(`"${TABLES.en[key]}"`);
    }
    expect(reviewer).toContain(`"${TABLES.en.opt_key_ok.split('$1')[0].trim()}"`);
    expect(reviewer).toContain(`"${TABLES.en.ai_notice.replace(/\.$/, '')}"`);
    expect(reviewer).toMatch(/^FILL IN: PASTE THE REVIEW KEY HERE$/m);
    expect(listing).not.toMatch(/AIza[0-9A-Za-z_-]{20}|sk-[0-9A-Za-z]{20}/);
    expect(reviewer).toMatch(/offscreen document/);
    expect(/SceneVoice Cloud|Start free/.test(reviewer)).toBe(CLOUD_OPEN);
  });

  it('store images: the words drawn on them claim what the description claims, in both languages, and the listing names every file', () => {
    const script = repoFile('scripts/screenshots.py');
    // WORDS holds everything written on an image (the caption beside the popup, the promo tile).
    const block = script.split('\nWORDS = {\n')[1].split('\n}\n')[0];
    const words = (lang) => [...block.split(`    "${lang}": {`)[1].split('\n    },')[0].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((w) => !/^(popup|promo)_/.test(w));
    for (const lang of ['en', 'zh_CN']) {
      expect(words(lang).length, lang).toBe(9);
      for (const line of words(lang)) {
        // Not "any" video; no screen reader named as working; no browser named (Edge Add-ons).
        expect(line, lang).not.toMatch(/\bany\b|任何|任意/i);
        expect(line, lang).not.toMatch(/NVDA|JAWS|VoiceOver|Works with|争渡|保益/);
        expect(line, lang).not.toMatch(/Chrome|Firefox|Safari|\bEdge\b|Brave|Opera/);
      }
    }
    expect(words('en')).toContain('YouTube and Bilibili videos,');
    expect(words('zh_CN')).toContain('YouTube 和哔哩哔哩视频，');
    // The Chinese pictures carry Chinese words: nothing but key names and product names is left in Latin letters.
    for (const line of words('zh_CN')) expect(line.replace(/SceneVoice|YouTube|Alt\+Shift\+D|AI/g, '')).not.toMatch(/[A-Za-z]/);
    // Nothing else is written on an image: the two drawing functions take every string from WORDS.
    for (const name of ['compose_popup', 'promo_tile']) {
      const body = script.split(`\ndef ${name}(`)[1].split('\n\n\n')[0];
      expect(body, name).toMatch(/words, cjk = words_for\(lang\)/);
      expect([...body.matchAll(/d\.text\(\([^)]*\), ([^,]+),/g)].map((m) => m[1]), name).toSatisfy((drawn) => drawn.length > 0 && drawn.every((d) => /^(words\[|line$)/.test(d)));
    }
    // No request leaves the machine while the pictures are made.
    expect(script).toMatch(/ctx\.route\(lambda url: not url\.startswith\("chrome-extension:\/\/"\), lambda route: route\.abort\(\)\)/);
    // Every file the script writes is in the listing's inventory and in the repository, in both languages.
    const files = [...new Set([...script.matchAll(/out \/ "([^"]+\.png)"/g)].map((m) => m[1]))];
    expect(files).toEqual(['promo-440x280.png', '1-settings-1280x800.png', '2-popup-1280x800.png', '3-welcome-1280x800.png', '4-transcript-1280x800.png', '5-key-guide-1280x800.png', '6-shortcuts-1280x800.png']);
    const inventory = listing.split('\n## Screenshots (1280×800) and promo tile (440×280)\n')[1].split('\n## ')[0];
    for (const file of files) {
      expect(inventory, file).toContain(`- \`${file}\`:`);
      for (const dir of ['docs/store', 'docs/store/zh-CN']) {
        const png = readFileSync(new URL(`../${dir}/${file}`, import.meta.url));
        const size = file.includes('promo') ? [440, 280] : [1280, 800];
        expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${dir}/${file}`).toEqual(size);
      }
    }
    expect(inventory).not.toMatch(/all made on 2026-11-04|is missing in both|should lose "Any"/);
    expect(inventory).toMatch(/None shows SceneVoice at work on a video/);
  });

  it('READMEs: the install section lists what exists and says what does not', () => {
    const en = repoFile('README.md').split('\n## Install\n')[1].split('\n### Try it without installing\n')[0];
    const zh = repoFile('README.zh-CN.md').split('\n## 安装\n')[1].split('\n### 不安装也能试\n')[0];
    expect(en).toMatch(/What exists today:\n\n- \[GitHub Releases\]/);
    expect(en).toMatch(/- \*\*Chrome Web Store:\*\* not listed yet\./);
    expect(en).toMatch(/- \*\*Edge Add-ons:\*\* not listed yet\./);
    expect(en).toMatch(/- \*\*A Gitee mirror\*\* for downloads inside mainland China: planned, not created\./);
    expect(en).not.toMatch(/link when published/);
    expect(zh).toMatch(/现在已有的：\n\n- \[GitHub Releases\]/);
    expect(zh).toMatch(/- \*\*Chrome 应用商店\*\*：尚未上架。/);
    expect(zh).toMatch(/- \*\*Edge 加载项商店\*\*：尚未上架。/);
    expect(zh).toMatch(/- \*\*Gitee 镜像\*\*（方便中国内地下载）：在计划中，还没有建立。/);
    for (const text of [en, zh]) expect(text).toContain('docs/tester-guide.zh-CN.md');
    // No claim that a screen reader test of the extension has been completed.
    expect(repoFile('README.md')).toMatch(/nobody has yet completed a test of the extension with a screen reader user/);
    expect(repoFile('README.zh-CN.md')).toMatch(/还没有读屏用户完整测试过这个扩展/);
  });

  it('owner checklist: every step is marked as the owner\'s or as prepared, and the domain comes first', () => {
    const checklist = repoFile('docs/store-submission.zh-CN.md');
    const steps = checklist.split('\n').filter((l) => /^## 第 \d+ 步/.test(l));
    expect(steps.map((l) => Number(l.match(/第 (\d+) 步/)[1]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const step of steps) expect(step).toMatch(/【你来做】|【已备好】/);
    // Step 0 is the domain. The question "is it yours" is answered: it is not, it has been taken out,
    // and the owner has nothing to do about it now. (The name is put together here so that a search
    // of the repository for it finds only the texts that tell what happened.)
    const foreign = ['scenevoice', 'app'].join('.');
    expect(steps[0]).toBe(`## 第 0 步 【已备好】域名：${foreign} 不是项目的，已经从代码和文档里拿掉`);
    const zero = checklist.split(`${steps[0]}\n`)[1].split('\n## ')[0];
    expect(zero).toMatch(/这一步你现在不用做任何事/);
    expect(zero).toMatch(/\n已经做了什么：\n/);
    expect(zero).toContain('`test/no-foreign-domain.test.js`');
    expect(zero).toContain('`server/wrangler.toml`');
    expect(zero).toMatch(/2026 年 11 月 16 日发现这件事时，那个地址没有解析记录/);
    // What is left for the owner: a domain of his own, registered, before Cloud can open. Nothing else now.
    expect(zero).toMatch(/先选一个域名，由你本人注册到手，再把它写进代码/);
    expect(zero).toMatch(/在那之前，云端不能开放，总开关不能打开/);
    expect(checklist).not.toMatch(/这个域名是不是你的|如果是你的：|\n## 安全提醒/);
    // The merge follows at once: it is what takes the Cloud choice off the live web player.
    expect(steps[1]).toBe('## 第 1 步 【你来做】尽快把这次的改动合并进 main');
    expect(checklist).toMatch(/Private vulnerability reporting/);
    expect(checklist).toMatch(/【已备好】/);
    expect(checklist).toMatch(/Unlisted/);
    expect(checklist).toMatch(/Hidden/);
    expect(checklist).toMatch(/npm run release -- 1\.2\.0/);
    // The commands are the release document's own.
    const release = repoFile('docs/release.md');
    for (const line of ['git clone https://github.com/reddynb666/scenevoice.git ~/scenevoice-release', 'npm ci', 'npm run release -- 1.2.0', 'git push --follow-tags']) {
      expect(checklist).toContain(line);
      expect(release).toContain(line);
    }
    // Every file it tells the owner to copy from exists.
    for (const rel of ['docs/store-listing.md', 'docs/release.md', 'docs/tester-guide.zh-CN.md', 'SECURITY.md', 'PRIVACY.md', 'PRIVACY.zh-CN.md', 'scripts/screenshots.py', 'scripts/make_icons.py', 'static/icons/icon128.png', 'test/no-foreign-domain.test.js', 'server/wrangler.toml']) {
      expect(checklist).toContain(rel);
      expect(() => readFileSync(new URL(`../${rel}`, import.meta.url))).not.toThrow();
    }
  });

  it('owner checklist: each step can be done where it stands', () => {
    const checklist = repoFile('docs/store-submission.zh-CN.md');
    const step = (n) => checklist.split(new RegExp(`\\n## 第 ${n} 步[^\\n]*\\n`))[1].split(/\n## |\n---\n/)[0];
    // Step 4 comes before 1.2.0 is cut: it says which build to try (this source, unpacked, for the
    // owner only), and it does not ask for the release zip, which only exists after step 5.
    expect(step(4)).toMatch(/`npm ci` 和 `npm run build`/);
    expect(step(4)).toMatch(/选中里面的 `dist` 文件夹/);
    expect(step(4)).toMatch(/绝不能上传商店，也不能发给测试者/);
    expect(step(4)).toMatch(/GitHub 上的 1\.1\.0 不能装/);
    expect(step(4)).not.toMatch(/你要上传的那个压缩包|从第 1 步走到第 6 步/);
    // What would change the package is decided before the cut, not in the step that uploads it.
    expect(step(4)).toMatch(/\n### 4\.3 切版本之前要定的事\n/);
    expect(step(4)).toMatch(/“首次提交只打包中英文”要改构建脚本，改完才能切版本/);
    expect(step(8)).not.toMatch(/要在第 \d 步切版本之前决定/);
    // The run through the reviewer notes is on the checked release zip, in step 5; then 1.1.0 is withdrawn.
    const five = step(5);
    expect(five.indexOf('shasum -a 256 --ignore-missing -c SHA256SUMS')).toBeGreaterThan(0);
    expect(five.indexOf('“Notes for the reviewer”')).toBeGreaterThan(five.indexOf('scenevoice-1.2.0.zip: OK'));
    expect(five).toMatch(/\n7\. 上传之前，用这个刚校验过的压缩包和第 4\.2 步的那把 Key/);
    expect(five).toMatch(/\n8\. 1\.2\.0 能正常下载之后，处理 1\.1\.0：/);
    // The 1.1.0 zip was withdrawn on 16 November 2026, with a warning on its release. Step 1 says so,
    // and keeps what is left for the owner, which does not wait for 1.2.0: telling those who installed it.
    expect(step(0)).toContain('`scenevoice-1.1.0.zip` 已经删掉');
    expect(step(1)).toMatch(/\n6\. 1\.1\.0 的发布页，不用再动（2026 年 11 月 16 日已处理）/);
    expect(step(1)).toContain('`scenevoice-1.1.0.zip` 已经删掉，原来的下载地址打不开了');
    expect(step(1)).toMatch(/\n7\. 还剩一件和 1\.1\.0 有关的事，不用等 1\.2\.0：\n   - 告诉已经装了 1\.1\.0 的人/);
    expect(step(1)).not.toMatch(/再把它附带的|马上撤下/);
    expect(repoFile('docs/store-listing.md')).toMatch(/run the block once yourself with the review key on the exact zip you upload/);
    // Nothing a step uses is made by a later one. Where a step takes something from another, that
    // one is earlier:
    for (const [n, phrase] of [
      [3, '用第 2 步定下的那个专门用来发布的 Google 账号登录'],
      [3, '填第 2 步的支持邮箱'],
      [5, '第 4.2 步的那把 Key'],
      [7, 'Support 填第 2 步的邮箱'],
      [7, '换成第 4.2 步的 Key'],
      [8, 'Support contact detail 填第 2 步的邮箱'],
      [8, '徽标上传第 6 步做的 `docs/store/logo-300.png`'],
      [8, '按第 4.3 步定下的办法做'],
      [10, '第 4.1 步挑好的两个测试视频链接'],
    ]) {
      expect(step(n), `step ${n}`).toContain(phrase);
      expect(Number(phrase.match(/第 (\d+)/)[1])).toBeLessThan(n);
    }
    // and where a step names a later one, the sentence says that the thing is done then, not now.
    for (let n = 0; n <= 12; n++) {
      for (const sentence of step(n).split(/[。\n]/)) {
        const later = [...sentence.matchAll(/第 (\d+)(?:\.\d)? 步/g)].map((m) => Number(m[1])).filter((m) => m > n);
        if (later.length) expect(sentence, `step ${n} names step ${later[0]}`).toMatch(/到时再做|要发给测试者|再做第 \d+ 步|才有|会再提醒|直接做第 \d+ 步/);
      }
    }
    expect(step(6)).toContain("save('docs/store/logo-300.png')");
    // Everything that must be true before submitting is in a step before the submit button,
    // never in the closing list: the Limited Use statement is one of them, and it is done.
    const seven = step(7);
    expect(seven.indexOf('Limited Use')).toBeGreaterThan(0);
    expect(seven.indexOf('Limited Use')).toBeLessThan(seven.indexOf('Submit for review'));
    expect(seven).toMatch(/“Web history”一项要勾选（Yes）/);
    for (const policy of ['PRIVACY.md', 'PRIVACY.zh-CN.md']) expect(repoFile(policy), policy).toMatch(/^## Chrome (Web Store: Limited Use|应用商店：Limited Use（有限使用）)$/m);
    const unverified = checklist.split('\n## 还没有核实的事\n')[1];
    expect(unverified).toMatch(/这里没有哪一件需要你在提交之前先做完。/);
    expect(unverified).not.toMatch(/Limited Use|提交之前请|没有的话，要补|必须/);
  });

  it('owner checklist: what it tells the owner to change is not held in place by a test it does not name', () => {
    const checklist = repoFile('docs/store-submission.zh-CN.md');
    const tests = repoFile('site/site.test.js') + repoFile('test/docs.test.js');
    const exists = (title) => tests.includes(`it('${title}`);
    // While one of these tests holds a text in place, the step that changes the text names the test.
    for (const title of [
      'stores that are not open yet are plain text',
      'the install paragraph does not claim a store review',
      'READMEs: the install section lists what exists and says what does not',
      'version 1.1.0 is not to be installed',
    ]) {
      if (exists(title)) expect(checklist, title).toContain(`“${title}” 这一条`);
    }
    // And a test the checklist names is there under that name: when one is renamed or removed,
    // docs/store-submission.zh-CN.md is changed with it.
    const named = [...checklist.matchAll(/“([^”]+)” 这一条/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const title of named) expect(exists(title), `docs/store-submission.zh-CN.md names a test that does not exist: ${title}`).toBe(true);

    // Testers: the guide in the repository is the public page and is complete as it stands. What is
    // private (the key, the links) goes to each tester in a message, and the list of what to have
    // ready before sending is here, in the owner's checklist, not in the guide.
    const ten = checklist.split(/\n## 第 10 步[^\n]*\n/)[1].split('\n## ')[0];
    expect(ten).toMatch(/\n发出之前，逐项确认：\n/);
    for (const line of ['安装：[', '测试密钥：[', '测试视频一（有对白、有停顿）：[', '测试视频二（一直有人说话）：[']) expect(ten).toContain(line);
    expect(ten).toContain('https://github.com/reddynb666/scenevoice/blob/main/docs/tester-guide.zh-CN.md');
    expect(ten).toMatch(/密钥只发给本人，不要发到群里，也不要写进任何公开的文件/);
    expect(checklist).not.toMatch(/复制一份到仓库文件夹之外|仓库里的那一份不要填|把副本发给测试者/);
    expect(checklist).not.toMatch(/sk-[0-9A-Za-z]{20}|AIza[0-9A-Za-z_-]{20}/);
  });

  it('tester guide: a public page that says what the test is and how to take part, readable with a screen reader, in the interface\'s own words', () => {
    const guide = repoFile('docs/tester-guide.zh-CN.md');
    const zh = TABLES.zh_CN;
    // No tables, no pictures: headings, short numbered steps and one reply form.
    expect(guide).not.toMatch(/^\s*\|/m);
    expect(guide).not.toMatch(/!\[|<img|<table|<br/i);
    expect(guide.match(/^### 检查 \d：/gm)).toEqual(Array.from({ length: 9 }, (_, i) => `### 检查 ${i + 1}：`));
    const steps = guide.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(steps.length).toBeGreaterThan(80);
    for (const step of steps) expect(step.length, step).toBeLessThan(120);
    // Nothing that needs sight.
    expect(guide).not.toMatch(/看到|点击|右上角|左上角|颜色|鼠标/);
    // The site, the READMEs and CONTRIBUTING link to this file, so its first reader is someone who
    // came from a public link: it opens with what the test is, then how to take part, then the test.
    // There is no section for the owner in it (his list is in docs/store-submission.zh-CN.md).
    expect(guide.split('\n## ')[0]).toMatch(/这是一份请读屏用户帮忙测试 SceneVoice 的指南。/);
    expect(guide.split('\n').filter((l) => l.startsWith('## '))[0]).toBe('## 怎样参加');
    expect(guide).not.toMatch(/发出之前|这一节给项目所有者看|这一页是公开的模板/);
    const taking = guide.split('\n## 怎样参加\n')[1].split('\n## ')[0];
    // The contact is the owner's to supply. For as long as it is missing, the page says plainly that
    // recruitment has not opened and where it will be announced, and publishes no address of any kind.
    const blanks = guide.match(/FILL IN/g) || [];
    if (blanks.length) {
      expect(blanks).toHaveLength(1);
      expect(taking).toMatch(/<!-- FILL IN（项目所有者）：[^>]*-->/);
      expect(taking).toMatch(/现在还没有开始招募测试者，报名用的联系方式也还没有定下来。/);
      expect(taking).toMatch(/报名办法会写在这一节，也会写在项目网站的“安装”一节和 GitHub 上的中文说明里。/);
      expect(taking).toContain('https://reddynb666.github.io/scenevoice/zh-CN/');
      expect(guide).not.toMatch(/mailto:|[\w.+-]+@[\w-]+\.\w+/);
    } else {
      expect(taking).not.toMatch(/还没有开始招募/);
    }
    // A reader of the rendered page meets no blank: the one note to the owner is a comment.
    expect(guide.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/FILL IN/);
    // What is private is sent to each tester, and none of it is on this page.
    expect(taking).toMatch(/我们会单独发给你四样东西：安装用的商店链接或压缩包，一把测试用的密钥，两个测试视频的链接，以及把回复发到哪里。/);
    expect(guide.match(/由我们单独发给你/g)).toHaveLength(5);
    expect(guide).not.toMatch(/sk-[0-9A-Za-z]{20}|BV[0-9A-Za-z]{10}/);
    // Testers install the version they are sent, never the 1.1.0 release.
    expect(guide).toMatch(/请只安装我们发给你的版本，版本号是 1\.2\.0 或更新。GitHub 上的 1\.1\.0 是旧版，请不要安装。/);
    // Alt+Shift+X stops SceneVoice's own voice and empties its announcements; it cannot stop what the
    // screen reader is already reading (announcer.stop), so the guide names the screen reader's own key.
    expect(guide).not.toMatch(/可以按 Alt\+Shift\+X 让它停下来/);
    expect(guide).toMatch(/\n6\. 想让读屏停下来，请按读屏自己的停止键，一般是 Ctrl。\n/);
    expect(guide).toMatch(/\n7\. Alt\+Shift\+X 停的是内置语音，并清掉 SceneVoice 还没读出的播报。读屏已经在读的那一段，它停不了。\n/);
    expect(repoFile('src/content/announcer.js')).toMatch(/if \(wasTts\) sendSafe\(\{ type: MSG\.STOP_SPEAKING \}\);\n\s+for \(const r of \[\.\.\.this\.polite, \.\.\.this\.assertive\]\) r\.textContent = '';/);
    expect(guide).toMatch(/扩展不会自动收集任何东西/);
    // The names a tester will hear, quoted as the interface has them now.
    for (const key of ['welcome_title', 'welcome_output_legend', 'output_screenreader', 'output_tts', 'welcome_sample_button', 'welcome_own_key_link', 'opt_qwen_key_label', 'opt_key_save', 'opt_key_remove', 'ask_title', 'ask_label', 'ask_thinking', 'status_looking', 'ai_notice', 'popup_this_video', 'popup_describe_now', 'popup_ask', 'popup_report', 'popup_all_keys', 'popup_all_settings']) {
      expect(guide, key).toContain(`“${zh[key]}”`);
    }
    expect(guide).toContain(`“${zh.opt_key_ok.split('$1')[0]}”`);
    expect(guide).toContain(`“${zh.announce_reader_speed.replace('$1', zh.speed_very_fast)}”`);
    expect(guide).toContain(`“${SAMPLE_DESCRIPTIONS['zh-CN'][0]}”`);
    expect(zh.welcome_sample_done_own.startsWith('示例结束')).toBe(true);
    expect(zh.status_live_start.startsWith('SceneVoice 开始边看边生成口述')).toBe(true);
    expect(zh.error_qwen_bad_key.startsWith('通义千问 API Key 无效')).toBe(true);
    expect(zh.error_qwen_no_key.startsWith('SceneVoice 在这个网站上需要通义千问 API Key')).toBe(true);
    for (const said of ['示例结束', 'SceneVoice 开始边看边生成口述', '通义千问 API Key 无效', 'SceneVoice 在这个网站上需要通义千问 API Key']) expect(guide).toContain(said);
    // While Cloud is closed the guide has nothing to warn testers away from.
    expect(/云端|免费开始/.test(guide)).toBe(CLOUD_OPEN);
    // CONTRIBUTING sends Chinese testers here.
    expect(repoFile('CONTRIBUTING.md')).toContain('(./docs/tester-guide.zh-CN.md)');
  });
});
