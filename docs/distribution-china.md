# Distribution for mainland China (Edge Add-ons, Gitee)

The Chrome Web Store may not be reachable from mainland China, so the China
edition is also offered through the Microsoft Edge Add-ons store and as a zip
on a Gitee mirror. Both use the same package as the Chrome Web Store
(`npm run package` → `scenevoice-<version>.zip`). Every step below needs the
owner's account and approval; nothing here is automated.

Desktop browsers in China, July 2026 (StatCounter): Chrome 48%, Edge 29%,
360 10%. All are Chromium based and run the same package.

## Microsoft Edge Add-ons

1. Register at Partner Center (free): https://partner.microsoft.com/dashboard/microsoftedge/overview
2. *Create new extension* → upload `scenevoice-<version>.zip`.
3. Availability: all markets, including China.
4. Properties: category *Accessibility*; privacy policy URL = the GitHub (or Gitee) address of `PRIVACY.md`; website = the GitHub repository.
5. Store listing, in English and 简体中文: reuse `docs/store-listing.md` (name, summary, description, screenshots).
6. Notes for certification, in English:
   > SceneVoice adds AI audio description to YouTube and Bilibili videos for blind and low-vision users. To test: open the settings page, add a Gemini API key (https://aistudio.google.com/apikey, free) or a Qwen key (https://bailian.console.aliyun.com/), open any public YouTube video and press Alt+Shift+D. No account or server of ours is involved.
7. Submit. Later versions can be published with Partner Center's REST API (https://learn.microsoft.com/microsoft-edge/extensions-chromium/publish/api/using-addons-api) if releases become frequent.

## Gitee mirror

1. Create an empty public repository `scenevoice` on https://gitee.com (Gitee requires a verified phone number).
2. Mirror the GitHub repository: in Gitee, *Import from GitHub*, or `git remote add gitee git@gitee.com:<user>/scenevoice.git && git push gitee main --tags`.
3. For each release, create a Gitee *Release* with the same tag and attach `scenevoice-<version>.zip` and `SHA256SUMS` from the GitHub Release (both are built by `.github/workflows/release.yml`; see `docs/release.md`).
4. Install instructions for that page (Chinese), for browsers without store access:
   1. 下载 `scenevoice-<version>.zip` 并解压到一个固定的文件夹（以后不要删除或移动它）。
   2. 在 Chrome 打开 `chrome://extensions`（Edge 为 `edge://extensions`，360 浏览器为“扩展中心”），打开“开发者模式”。
   3. 选择“加载已解压的扩展程序”，选中刚才解压的文件夹。
   4. 欢迎页会自动打开：先听一段示例，再选“自己的密钥”，设置页就会在通义千问 Key 输入框打开；按页面上的“分步申请指南”添加 Key。
   5. 更新时下载新版本，覆盖同一个文件夹后，在扩展页面按“重新加载”。

   Developer mode shows a warning on every browser start; the store versions do not.

## Before announcing it in China

- The compliance questions in README.zh-CN.md (正式上线前的合规事项) are answered by a professional.
- The Bilibili checks in CONTRIBUTING.md are done on the live site with a real Qwen key.
