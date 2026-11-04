// @vitest-environment node
// The website: both pages pass axe and our own checks, share one structure, keep AAA
// colour tokens; and script.js (the "Hear it" sample, the language memory) behaves.
// Each test gets its own jsdom window so the script's state never leaks between tests.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAGES, checkSite, contrastIssues, loadPage } from './check.mjs';

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

describe('site: accessibility', () => {
  it('both pages: zero axe violations (WCAG 2.2 AA) and no own-check issues', async () => {
    const result = await checkSite();
    expect(result.pages.map((p) => p.page)).toEqual(PAGES);
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
