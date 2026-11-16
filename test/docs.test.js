// The documents that make promises about data: the two privacy policies say the same
// things, every host the manifest asks for is explained in both, and the public texts
// do not claim "no server" without naming the optional Cloud relay.
// SceneVoice Cloud is closed (CLOUD_OPEN in src/shared/constants.js): the policies say it
// is not open, list no permission for a relay, give the relay no address (it has none
// until the project holds a domain; test/no-foreign-domain.test.js), and keep what it
// will do in one section marked "when it opens".
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLES } from '../scripts/locales.mjs';
import { CLOUD_API_BASE, LANGUAGES } from '../src/shared/constants.js';

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

  it('explain every host the manifest asks for, in both languages, and list no permission for the relay while Cloud is closed', () => {
    expect(hosts).toEqual(['generativelanguage.googleapis.com', 'dashscope.aliyuncs.com']);
    for (const host of hosts) {
      expect(en, host).toContain(`**${host}**`);
      expect(zh, host).toContain(`**${host}**`);
    }
    // The permissions section does not name the relay at all.
    const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
    for (const [text, start, end] of [
      [en, '## Permissions the extension asks for', '## The web player'],
      [zh, '## 扩展申请的权限', '## 网页播放器'],
    ]) {
      const permissions = section(text, start, end);
      expect(permissions.length).toBeGreaterThan(200);
      expect(permissions).not.toMatch(/SceneVoice Cloud|relay|中转/);
    }
  });

  it('say that SceneVoice Cloud is not open, and keep everything about it in the one section marked "when it opens"', () => {
    for (const [text, heading, notOpen, notOffered] of [
      [en, '### SceneVoice Cloud (when it opens)', /\*\*SceneVoice Cloud is not open\.\*\*/, /This version does not offer it, does not ask permission for its address and sends nothing to it\./],
      [zh, '### SceneVoice Cloud（开放之后）', /\*\*SceneVoice Cloud 还没有开放。\*\*/, /这个版本不提供它，不申请访问它的地址的权限，也不向它发送任何内容。/],
    ]) {
      const at = text.indexOf(heading);
      expect(at, heading).toBeGreaterThan(0);
      // Said up front, before anything else, and again at the head of the section itself.
      expect(text.slice(0, 1200)).toMatch(notOffered);
      const cloud = text.slice(at, text.indexOf('\n## ', at));
      expect(cloud).toMatch(notOpen);
      // The relay has no address yet, and the section says so instead of naming one.
      expect(cloud).toMatch(/The relay has no address yet\. It will be on a domain the project holds|中转现在还没有地址。它的地址会在项目自己持有的域名下/);
      expect(cloud).not.toMatch(/https?:\/\//);
      // Outside that section (and the two sentences up front that point to it), nothing mentions Cloud or its token.
      const before = text.slice(0, at).split('\n').filter((line) => !/^SceneVoice Cloud[,， ]/.test(line)).join('\n');
      const after = text.slice(text.indexOf('\n## ', at));
      for (const part of [before, after]) expect(part).not.toMatch(/SceneVoice Cloud|Start free|免费开始|device token|设备凭证|设备令牌/);
    }
  });

  it('say what is kept on the computer: the device token, the daily limit, usage counts', () => {
    for (const [text, words] of [
      [en, ['device token', 'daily limit', '**Usage counts**', 'Start free', 'Stop using Cloud', 'server/PRIVACY-ADDENDUM.md']],
      [zh, ['设备凭证', '每日上限', '**用量统计**', '免费开始', '停用云端', 'server/PRIVACY-ADDENDUM.md']],
    ]) {
      for (const w of words) expect(text, w).toContain(w);
    }
    // The token is issued by the relay on Start free, not made at install.
    expect(zh).not.toMatch(/安装时匿名生成/);
    expect(zh).toMatch(/按“免费开始”时由中转签发/);
  });

  it('name the controls as the interface names them, in each language', () => {
    // A reader looks for the button the policy names: the Chinese policy used to say “停止使用云端”
    // for the button that reads “停用云端”, and 设备令牌 where the interface says 设备凭证.
    for (const key of ['welcome_start_free', 'opt_cloud_stop', 'set_share_descriptions', 'opt_cache_clear', 'web_remember', 'web_play', 'opt_advanced']) {
      expect(en, key).toContain(`*${TABLES.en[key]}*`);
      expect(zh, key).toContain(`“${TABLES.zh_CN[key]}”`);
    }
    expect(en).toContain(`"${TABLES.en.ai_notice.replace(/\.$/, '')}"`);
    expect(zh).toContain(`“${TABLES.zh_CN.ai_notice.replace(/。$/, '')}”`);
    expect(TABLES.zh_CN.opt_cloud_closed_token).toContain('设备凭证');
    expect(zh).not.toMatch(/设备令牌|停止使用云端/);
  });

  it('carry the affirmative Limited Use statement the Chrome Web Store asks for, and say the same four things', () => {
    // Chrome Web Store program policies, Limited Use: an affirmative statement that the use of the
    // data complies with the Limited Use restrictions, disclosed on a website belonging to the extension.
    expect(en).toMatch(/^## Chrome Web Store: Limited Use$/m);
    expect(en).toMatch(/SceneVoice's use of user data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements\./);
    expect(zh).toMatch(/SceneVoice 对用户数据的使用符合 Chrome 应用商店的用户数据政策（Chrome Web Store User Data Policy），包括其中的 Limited Use（有限使用）要求。/);
    const statement = (text, heading) => text.split(`\n## ${heading}\n`)[1].split('\n## ')[0];
    const [enPart, zhPart] = [statement(en, 'Chrome Web Store: Limited Use'), statement(zh, 'Chrome 应用商店：Limited Use（有限使用）')];
    expect(enPart.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(4);
    expect(zhPart.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(4);
    expect(enPart).toMatch(/single purpose/);
    expect(enPart).toMatch(/never sold, never used or transferred for advertising, and never used to determine creditworthiness or for lending/);
    expect(zhPart).toMatch(/单一用途/);
    expect(zhPart).toMatch(/绝不出售，绝不用于或转让用于广告，也绝不用于判断信用状况或放贷/);
    // The statement is about this version: it says nothing of the planned relay.
    for (const part of [enPart, zhPart]) expect(part).not.toMatch(/SceneVoice Cloud|relay|中转/);
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
      // The relay is spoken of (it is planned), and no address is given for it: it has none yet.
      expect(text, file).toMatch(/SceneVoice Cloud|SceneVoice 云端/);
      expect(text, file).not.toContain(new URL(CLOUD_API_BASE).hostname);
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
