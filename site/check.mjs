#!/usr/bin/env node
// Accessibility check for the website: node site/check.mjs
//
// Loads each page in jsdom, runs axe-core against WCAG 2.2 A/AA (plus axe's best
// practices) and adds the checks axe cannot do without a browser: every link has
// text and a target that exists, every button has a name, the two language pages
// share one structure, and the colour tokens in styles.css keep AAA contrast.
// jsdom has no layout, so axe's colour-contrast rule is replaced by the token check.
// The web player (play/index.html) is one page for both languages, localized by
// its script: it is checked as served (English text) and its data-i18n keys must
// exist in English and Chinese. Exits 1 on any finding. site/site.test.js runs the
// same functions under vitest.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { TABLES } from '../scripts/locales.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** The home page in its two languages: same structure, compared to each other. */
export const PAGES = ['index.html', 'zh-CN/index.html'];
/** Pages of their own, checked one by one: the web player. */
export const TOOL_PAGES = ['play/index.html'];
/**
 * The one script a page may load from anyone else: YouTube's player API, on the
 * web player. It is named here even though play/index.html loads it from its
 * script (and only after Play is pressed), so adding it to the HTML cannot pass
 * by accident either.
 */
export const ALLOWED_EXTERNAL_SCRIPTS = { 'play/index.html': ['https://www.youtube.com/iframe_api'] };

/** The page as jsdom sees it, with the file: URL so relative links can be resolved. */
export function loadPage(rel, { url, runScript = false } = {}) {
  const file = join(here, rel);
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(readFileSync(file, 'utf8'), {
    url: url || pathToFileURL(file).href,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  dom.jsdomErrors = errors;
  if (runScript) dom.window.eval(readFileSync(join(here, 'script.js'), 'utf8'));
  return dom;
}

/** axe-core violations for WCAG 2.2 A/AA and best practices, as short strings. */
export async function axeViolations(dom) {
  const { window } = dom;
  window.eval(axeSource);
  const { violations } = await window.axe.run(window.document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false } }, // needs layout; see contrastIssues()
    resultTypes: ['violations'],
  });
  return violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

function accessibleName(el) {
  const doc = el.ownerDocument;
  const byId = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map((id) => doc.getElementById(id)?.textContent.trim()).filter(Boolean).join(' ');
  const imgAlt = [...el.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt').trim()).join(' ');
  return (el.getAttribute('aria-label') || byId || el.textContent.trim() || imgAlt || el.getAttribute('title') || '').trim();
}

/** Things to check by hand that axe does not: names, targets, metadata, no third parties. */
export function pageIssues(dom, rel) {
  const { document: doc } = dom.window;
  const issues = [];
  const dir = dirname(join(here, rel));
  const push = (msg) => issues.push(`${rel}: ${msg}`);
  const landing = PAGES.includes(rel);
  const allowedScripts = ALLOWED_EXTERNAL_SCRIPTS[rel] || [];

  if (!doc.documentElement.getAttribute('lang')) push('<html> has no lang');
  if (!doc.documentElement.getAttribute('dir')) push('<html> has no dir');
  if (!doc.title.trim()) push('empty <title>');
  if (!doc.querySelector('meta[name="description"]')?.content.trim()) push('no meta description');
  if (!doc.querySelector('meta[property="og:title"]')) push('no Open Graph title');
  // Share previews (X, Facebook, LinkedIn, Slack, WeChat) render PNG/JPEG/WebP only, never SVG.
  const ogImage = doc.querySelector('meta[property="og:image"]')?.content || '';
  if (!/^https:\/\/.+\.(png|jpe?g|webp)$/i.test(ogImage)) push(`og:image must be an absolute https PNG/JPEG/WebP, not "${ogImage}"`);
  if (!doc.querySelector('meta[property="og:image:alt"]')?.content.trim()) push('no og:image:alt');
  if ((doc.querySelector('meta[name="twitter:image"]')?.content || '') !== ogImage) push('twitter:image differs from og:image');

  const h1s = doc.querySelectorAll('h1');
  if (h1s.length !== 1) push(`${h1s.length} <h1> elements`);
  let last = 1;
  for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const level = Number(h.tagName[1]);
    if (level > last + 1) push(`heading level skips from h${last} to h${level}: "${h.textContent.trim()}"`);
    last = level;
  }

  const skip = doc.querySelector('.skip-link');
  if (!skip) push('no skip link');
  else if (!doc.querySelector(skip.getAttribute('href'))) push('skip link points nowhere');

  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    const name = accessibleName(a);
    if (!name) push(`link without text: ${a.outerHTML.slice(0, 80)}`);
    if (href == null || href === '') { push(`link without href: "${name}"`); continue; }
    // "#" scrolls to the top and moves the focus start point there: a trap for keyboard users.
    if (href === '#') { push(`dead "#" link: "${name}"`); continue; }
    if (href.startsWith('#')) {
      if (!doc.getElementById(href.slice(1))) push(`fragment ${href} has no target ("${name}")`);
    } else if (!/^(https?:|mailto:)/.test(href)) {
      const target = resolve(dir, href.split(/[#?]/)[0]);
      if (!existsSync(target) && !existsSync(join(target, 'index.html'))) push(`local link ${href} does not exist ("${name}")`);
    }
  }

  for (const b of doc.querySelectorAll('button')) {
    if (!accessibleName(b)) push(`button without a name: ${b.outerHTML.slice(0, 80)}`);
    if (!b.getAttribute('type')) push(`button without type: "${accessibleName(b)}"`);
  }

  // A store is either a real link or plain text saying "coming soon": never a focusable dead end.
  for (const s of doc.querySelectorAll('[data-store]')) {
    const store = s.getAttribute('data-store');
    const isLink = s.tagName === 'A' && /^https:\/\//.test(s.getAttribute('href') || '');
    const isPlaceholder = s.tagName === 'SPAN' && s.classList.contains('placeholder') && !s.hasAttribute('tabindex');
    if (!isLink && !isPlaceholder) push(`store "${store}" is neither an https link nor a span.placeholder`);
  }

  // The "Hear it" buttons only work with script.js: hidden until it runs, and said so without it.
  if (landing && !doc.querySelector('#hear-buttons[hidden]')) push('#hear-buttons is not hidden before script.js runs');
  if (landing && !doc.querySelector('#hear noscript')?.textContent.trim()) push('#hear has no <noscript> note');

  for (const img of doc.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) push(`image without alt: ${img.getAttribute('src')}`);
  }

  // No external scripts, styles, fonts or images: the page must not call anyone
  // (the web player's one exception is named in ALLOWED_EXTERNAL_SCRIPTS).
  for (const el of doc.querySelectorAll('script[src], link[rel="stylesheet"], link[rel~="icon"], img[src], iframe')) {
    const src = el.getAttribute('src') || el.getAttribute('href') || '';
    if (el.tagName === 'SCRIPT' && allowedScripts.includes(src)) continue;
    if (/^(https?:)?\/\//.test(src) || el.tagName === 'IFRAME') push(`external resource: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of doc.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"], link[rel="preload"][as="font"]')) {
    push(`third-party hint: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) if (attr.startsWith('on')) push(`inline handler ${attr} on <${el.tagName.toLowerCase()}>`);
  }

  // Both languages reachable from each other.
  const langs = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => l.getAttribute('hreflang'));
  for (const want of ['en', 'zh-Hans', 'x-default']) if (!langs.includes(want)) push(`no hreflang alternate for ${want}`);
  if (!doc.querySelector('a[data-lang-switch]')) push('no language switch link');

  if (!landing) {
    // The web player: one page, localized by its script. Every key it names must exist in both core languages.
    const keys = new Set();
    for (const el of doc.querySelectorAll('[data-i18n]')) keys.add(el.getAttribute('data-i18n'));
    for (const el of doc.querySelectorAll('[data-i18n-attr]')) for (const pair of el.getAttribute('data-i18n-attr').split(';')) keys.add(pair.split(':')[1]?.trim());
    for (const key of keys) for (const locale of ['en', 'zh_CN']) if (!TABLES[locale][key]) push(`data-i18n key ${key} is missing in ${locale}`);
    // Its live regions: a status region of its own, a polite description region, and the keyboard surface with a name.
    if (!doc.querySelector('#status[role="status"][aria-live="polite"]')) push('no status live region');
    if (doc.querySelector('#description')?.getAttribute('aria-live') !== 'polite') push('description region is not polite');
    if (!doc.querySelector('#player-region[role="application"][tabindex="0"]')?.getAttribute('aria-label')) push('player region is not a named, focusable application region');
    if (!doc.querySelector('iframe') && !doc.querySelector('#player-host')) push('no place for the YouTube player');
    // The key field is never part of a form that could submit it in a web address.
    const key = doc.getElementById('key');
    if (!key || key.type !== 'password' || key.closest('form')) push('the key field must be a password field outside every form');
    if (!doc.querySelector('noscript')?.textContent.trim()) push('no <noscript> note');
    return issues;
  }

  // Structured data and the sample block must parse.
  try {
    const ld = JSON.parse(doc.querySelector('script[type="application/ld+json"]').textContent);
    if (ld['@type'] !== 'SoftwareApplication') push('JSON-LD is not a SoftwareApplication');
    if (ld.applicationCategory !== 'Accessibility') push('JSON-LD applicationCategory is not Accessibility');
    if (ld.offers?.price !== '0') push('JSON-LD offer is not free');
    if ('codeRepository' in ld) push('JSON-LD uses codeRepository (a SoftwareSourceCode property) on a SoftwareApplication; use sameAs');
  } catch (e) {
    push(`JSON-LD missing or invalid: ${e.message}`);
  }
  try {
    const sample = JSON.parse(doc.getElementById('sample-data').textContent);
    if (sample.lines?.length !== 3) push('sample-data does not hold three lines');
    for (const k of ['sr', 'tts', 'stop']) if (!sample.labels?.[k]) push(`sample-data lacks label ${k}`);
    for (const k of ['sr', 'tts', 'done', 'stopped', 'unavailable']) if (!sample.status?.[k]) push(`sample-data lacks status ${k}`);
    // The visible fallback text and what the script speaks must agree.
    const visible = [...doc.querySelectorAll('#sample p:not(.dialogue)')].map((p) => p.textContent.trim());
    if (visible.join('\n') !== sample.lines.join('\n')) push('sample text on the page differs from sample-data');
  } catch (e) {
    push(`sample-data missing or invalid: ${e.message}`);
  }

  // Live regions: status separate from the sample, so a status never replaces a line.
  if (!doc.querySelector('#sample-status[role="status"]')) push('no status live region');
  if (doc.querySelector('#sample')?.getAttribute('aria-live') !== 'polite') push('sample region is not polite');

  return issues;
}

/** The landmark/section skeleton, so the two languages can be compared. */
function skeleton(dom) {
  const { document: doc } = dom.window;
  const ids = [...doc.querySelectorAll('[id]')].map((el) => `${el.tagName.toLowerCase()}#${el.id}`);
  const headings = [...doc.querySelectorAll('h1, h2, h3')].map((h) => h.tagName.toLowerCase());
  const stores = [...doc.querySelectorAll('[data-store]')].map((a) => a.getAttribute('data-store'));
  const buttons = [...doc.querySelectorAll('button')].map((b) => b.id);
  return { ids, headings, stores, buttons };
}

/** Differences between the two pages' skeletons; empty when they match. */
export function structureDiff(domA, domB) {
  const a = skeleton(domA);
  const b = skeleton(domB);
  const out = [];
  for (const key of Object.keys(a)) {
    if (a[key].join('|') !== b[key].join('|')) out.push(`${key} differ:\n  ${a[key].join(' ')}\n  ${b[key].join(' ')}`);
  }
  return out;
}

/* ---------- Colour tokens ---------- */

function luminance(hex) {
  const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The light and dark token sets from styles.css, in the order they are written. */
export function readTokens(css = readFileSync(join(here, 'styles.css'), 'utf8')) {
  const [light, dark] = css.split('prefers-color-scheme: dark');
  const parse = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
  return { light: parse(light), dark: parse(dark.split('}')[0] + '}') };
}

// Text pairs need AAA (7:1); rings and borders need 3:1 (WCAG 1.4.11).
const TEXT_PAIRS = [['text', 'bg'], ['muted', 'bg'], ['link', 'bg'], ['visited', 'bg'], ['button-text', 'button-bg'],
  ['text', 'panel'], ['muted', 'panel'], ['link', 'panel'], ['visited', 'panel']];
const UI_PAIRS = [['focus', 'bg'], ['focus', 'panel'], ['border', 'bg'], ['border', 'panel'], ['focus-gap', 'focus'], ['button-bg', 'bg']];

export function contrastIssues(tokens = readTokens()) {
  const out = [];
  for (const [scheme, t] of Object.entries(tokens)) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const r = contrast(t[fg], t[bg]);
      if (r < 7) out.push(`${scheme}: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs 7:1`);
    }
    for (const [fg, bg] of UI_PAIRS) {
      const r = contrast(t[fg], t[bg]);
      if (r < 3) out.push(`${scheme}: --${fg} against --${bg} is ${r.toFixed(2)}:1, needs 3:1`);
    }
  }
  return out;
}

/* ---------- Whole site ---------- */

export async function checkSite() {
  const all = [...PAGES, ...TOOL_PAGES];
  const doms = all.map((p) => loadPage(p));
  const pages = [];
  for (let i = 0; i < all.length; i++) {
    pages.push({ page: all[i], violations: await axeViolations(doms[i]), issues: pageIssues(doms[i], all[i]) });
  }
  return { pages, structure: structureDiff(doms[0], doms[1]), contrast: contrastIssues() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkSite();
  let failed = false;
  for (const p of result.pages) {
    console.log(`${p.page}: ${p.violations.length} axe violation(s), ${p.issues.length} other issue(s)`);
    for (const v of p.violations) console.log(`  axe: ${v}`);
    for (const i of p.issues) console.log(`  ${i}`);
    if (p.violations.length || p.issues.length) failed = true;
  }
  if (result.structure.length) { failed = true; console.log('structure:'); for (const s of result.structure) console.log(`  ${s}`); }
  if (result.contrast.length) { failed = true; console.log('contrast:'); for (const c of result.contrast) console.log(`  ${c}`); }
  if (!failed) console.log('ok: both home pages (same structure) and the web player, AAA colour tokens');
  process.exit(failed ? 1 : 0);
}
