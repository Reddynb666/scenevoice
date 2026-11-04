// The documents that make promises about data: the two privacy policies say the same
// things, every host the manifest asks for is explained in both, and the public texts
// do not claim "no server" without naming the optional Cloud relay.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../src/shared/constants.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const en = read('PRIVACY.md');
const zh = read('PRIVACY.zh-CN.md');
const manifest = JSON.parse(read('static/manifest.json'));
const hosts = manifest.host_permissions.map((p) => new URL(p.replace('*', 'x')).hostname);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Last updated: 4 November 2026" / "最后更新：2026 年 11 月 4 日" as an ISO date. */
function updated(text) {
  const e = text.match(/^Last updated: (\d{1,2}) ([A-Z][a-z]+) (\d{4})$/m);
  if (e) return `${e[3]}-${String(MONTHS.indexOf(e[2]) + 1).padStart(2, '0')}-${e[1].padStart(2, '0')}`;
  const c = text.match(/^最后更新：(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日$/m);
  return c ? `${c[1]}-${c[2].padStart(2, '0')}-${c[3].padStart(2, '0')}` : null;
}

const headings = (text) => text.split('\n').filter((l) => /^#{2,3} /.test(l)).map((l) => l.match(/^(#{2,3}) /)[1]);
const bullets = (text, heading) => {
  const section = text.split(/^### /m).find((s) => s.startsWith(heading));
  return section ? section.split('\n').filter((l) => l.startsWith('- ')).length : 0;
};

describe('privacy policies', () => {
  it('carry the same Last updated date', () => {
    expect(updated(en)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(updated(zh)).toBe(updated(en));
  });

  it('have the same section structure (the Chinese file says it is a faithful translation)', () => {
    expect(headings(zh)).toEqual(headings(en));
    expect(bullets(zh, 'SceneVoice Cloud')).toBe(bullets(en, 'SceneVoice Cloud'));
  });

  it('explain every host the manifest asks for, in both languages', () => {
    expect(hosts).toContain('api.scenevoice.app');
    for (const host of hosts) {
      expect(en, host).toContain(`**${host}**`);
      expect(zh, host).toContain(`**${host}**`);
    }
  });

  it('say what is kept on the computer: the device token, the daily limit, usage counts', () => {
    for (const [text, words] of [
      [en, ['device token', 'daily limit', '**Usage counts**', 'Start free', 'Stop using Cloud', 'server/PRIVACY-ADDENDUM.md']],
      [zh, ['设备令牌', '每日上限', '**用量统计**', '免费开始', '停止使用云端', 'server/PRIVACY-ADDENDUM.md']],
    ]) {
      for (const w of words) expect(text, w).toContain(w);
    }
    // The token is issued by the relay on Start free, not made at install.
    expect(zh).not.toMatch(/安装时匿名生成/);
    expect(zh).toMatch(/按“免费开始”时由中转签发/);
  });
});

describe('public texts and the Cloud relay', () => {
  const texts = {
    'README.md': read('README.md'),
    'README.zh-CN.md': read('README.zh-CN.md'),
    'PRIVACY.md': en,
    'PRIVACY.zh-CN.md': zh,
    'site/index.html': read('site/index.html'),
    'site/zh-CN/index.html': read('site/zh-CN/index.html'),
    'docs/store-listing.md': read('docs/store-listing.md'),
  };

  it('never say "no server" or "nowhere else" without naming the relay', () => {
    for (const [file, text] of Object.entries(texts)) {
      expect(text, file).not.toMatch(/has no backend and collects nothing|^- SceneVoice has no server and no account/m);
      expect(text, file).not.toMatch(/No account, no server, no tracking|No server, no account, no tracking|无账号、无服务器|没有服务器、没有账号、不追踪|^- SceneVoice 没有服务器/m);
      expect(text, file).not.toMatch(/, and nowhere else\./);
      expect(text, file).toMatch(/api\.scenevoice\.app/);
    }
  });

  it('README first-run steps say Cloud is not open yet while the relay is not deployed', () => {
    // Drop this test, and the sentences, when the relay runs under the project's domain.
    expect(texts['README.md']).toMatch(/SceneVoice Cloud\* is not open yet/);
    expect(texts['README.zh-CN.md']).toMatch(/SceneVoice 云端\*还没有开放/);
  });

  it('store listing: the device token is issued on Start free, and the language counts match the code', () => {
    const listing = texts['docs/store-listing.md'];
    expect(listing).not.toMatch(/generated at install/);
    expect(listing).toMatch(/issued by the relay at the moment the user presses \*Start free\*/);
    const locales = readdirSync(join(root, 'scripts/locales')).filter((f) => f.endsWith('.mjs')).length;
    expect(listing).toContain(`Interface in ${locales} languages`);
    expect(listing).toContain(`界面：${locales} 种语言`);
    expect(listing).toContain(`${LANGUAGES.length} of them`);
    expect(listing).toContain(`其中 ${LANGUAGES.length} 种`);
  });
});

describe('release notes', () => {
  it('docs/release.md does not promise pre-release tags the tooling rejects', () => {
    const doc = read('docs/release.md');
    expect(doc).toMatch(/Only `vX\.Y\.Z` tags are supported/);
    expect(doc).not.toMatch(/marked as pre-releases/);
  });
});
