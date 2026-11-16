# Distribution for mainland China (Edge Add-ons; a Gitee mirror later)

The Chrome Web Store cannot be reached from mainland China. For people there,
the store is **Microsoft Edge Add-ons**: it is reachable, Edge comes with
Windows, and a store install needs no developer mode and updates by itself. A zip on a Gitee mirror, for browsers without a store, is
planned and does not exist yet.

Edge Add-ons takes the same package as the Chrome Web Store: the
`scenevoice-<version>.zip` attached to the GitHub Release (see
`docs/release.md`; never a zip built on a laptop). Every step below needs the
owner's account and approval; the first submission cannot be automated. The
owner's checklist, in Chinese, is `docs/store-submission.zh-CN.md`; the text
to paste is in `docs/store-listing.md`.

Desktop browsers in China, July 2026 (StatCounter): Chrome 48%, Edge 29%,
360 10%. All are Chromium based and run the same package.

## Microsoft Edge Add-ons

Partner Center's pages, in the order it shows them (checked against
Microsoft's *Publish a Microsoft Edge extension* page on 2026-11-16):

1. **Register** at Partner Center (free): https://partner.microsoft.com/dashboard/microsoftedge/overview.
   A personal Microsoft account, not a work or school one; account type
   *Individual*. The country or region and the account type cannot be changed
   after registration.
2. **Create new extension**, then upload `scenevoice-<version>.zip`. The first
   version is always uploaded here by hand; the REST API only updates a
   product that exists.
3. **Availability.** *Visibility*: **Hidden** for the tester round (the
   listing is not found by search or browsing; the listing URL, shown on the
   extension's *Overview* page, is shared with testers by hand), **Public**
   afterwards. *Markets*: all markets, which includes China.
4. **Properties.** Category *Accessibility*; *Website*
   `https://reddynb666.github.io/scenevoice/`; *Support contact detail*: the
   support address once the owner has one, or the GitHub issues address.
5. **Privacy.** A page of its own, separate from *Properties*: the single
   purpose, a justification for each permission, *No, I am not using remote
   code*, the data-usage boxes and their three certifications, and the privacy
   policy URL. All of it is in `docs/store-listing.md` (*Single purpose*,
   *Permission justifications*, *Data usage disclosure*). Microsoft's page
   warns that an incomplete or inaccurate answer here can delay or fail
   certification.
6. **Store listings.** One row for every language folder in the package, 16
   of them, and each row needs a *Description* of 250 to 10,000 characters and
   a logo before *Publish* can be pressed. English and Chinese are written;
   what to do about the other rows is the owner's choice between three options
   set out under *Edge Add-ons* in `docs/store-listing.md`, where the search
   terms and the logo command are too. The name and the short description
   come from the package and cannot be typed here.
7. **Publish**, and on the page that opens, **Notes for certification**: paste
   the *Notes for the reviewer* block from `docs/store-listing.md`, with the
   review key filled in and `edge://extensions` kept as the address of the
   extensions page. SceneVoice has no account, so the key is the only
   credential a tester needs; say so, as the block does.
8. Certification can take up to seven business days. When the status reads
   *In the Store*, copy the listing URL for the testers.

Later versions can be uploaded by the tag workflow once the three `EDGE_*`
secrets are set (`docs/release.md`, section 3).

## Gitee mirror (planned, not created)

Nothing here has been done; the README and the website say so. When the owner
sets it up:

1. Create an empty public repository `scenevoice` on https://gitee.com.
   Gitee's present requirements for an account and for a public repository
   (phone or real-name verification, a review before a repository becomes
   public) were not checked for this document: follow what the site asks.
2. Mirror the GitHub repository: in Gitee, *Import from GitHub*, or
   `git remote add gitee git@gitee.com:<user>/scenevoice.git && git push gitee main --tags`.
3. For each release, create a Gitee *Release* with the same tag and attach
   `scenevoice-<version>.zip` and `SHA256SUMS` from the GitHub Release.
4. Put the install steps below on that page. They are the short form; the
   version written to be followed with a screen reader, by keyboard only, is
   `docs/tester-guide.zh-CN.md`.
   1. 下载 `scenevoice-<version>.zip` 并解压到一个固定的文件夹（以后不要删除或移动它）。选的文件夹里要直接有 `manifest.json` 这个文件。
   2. 在 Edge 打开 `edge://extensions`（Chrome 为 `chrome://extensions`，360 浏览器为“扩展中心”），打开“开发人员模式”（Chrome 里叫“开发者模式”）。
   3. 选择“加载解压缩的扩展”（Chrome 里叫“加载已解压的扩展程序”），选中刚才解压的文件夹。
   4. 欢迎页会自动打开：先听一段示例，再按“去设置页添加我的密钥”，设置页就会在通义千问 Key 输入框打开；按页面上的“分步申请指南”添加 Key。
   5. 更新时下载新版本，覆盖同一个文件夹后，在扩展页面按“重新加载”。

   这样安装的扩展不会自动更新。重新打开浏览器时，浏览器可能会提醒“开发人员模式下的扩展”已开启；从商店安装的版本没有这个提醒。

The names of the browser's own controls in step 2 and 3, and the wording of
the start-up reminder, have not been checked with a screen reader on Windows.
The owner's first walk through the tester guide with NVDA is the moment to
correct them, here and there.

## Before testers in China get it, and before the Edge listing goes public

- **A run with a real Qwen key on the live Bilibili site, by the owner.** The
  Bilibili and Qwen path has only ever met a fake page and a mock model. It is
  the only path a tester in mainland China can use (YouTube and Gemini are not
  reachable there), so it is checked first, without a screen reader: *Save and
  test* accepts the key, and `Alt+Shift+D` on a Bilibili video brings a first
  description within about 20 seconds of playback. Then once more with a
  screen reader, following `docs/tester-guide.zh-CN.md` from start to finish.
- **Two Bilibili videos for the test**, chosen from inside mainland China and
  playable without an account: a short one with dialogue and pauses, and one
  where somebody talks all the time. Their links are not written into the
  tester guide, which is a public page: the owner sends them to each tester
  with the key (step 10 of `docs/store-submission.zh-CN.md`). The sample link
  on the welcome page (`src/welcome/welcome.html`) should be checked the same
  way.
- **The compliance questions** in README.zh-CN.md (正式上线前的合规事项) are
  answered by a professional before the listing is made public in China.
  Whether a hidden listing for a handful of testers may go ahead before that
  is the owner's decision; nothing here settles it.
