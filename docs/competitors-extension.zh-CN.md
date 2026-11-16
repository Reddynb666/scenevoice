# 扩展的同类产品开放检索

日期：2026-11-15。`docs/plan-2026-11.zh-CN.md` 说扩展是“唯一一个在你正在看的页面里、按一个键、整段视频、塞进对白空隙、用你自己的读屏朗读的产品”。那句话出自两周前的审计，当时没有做开放搜索。这里补做，三路检索各带一次核查。

## 范围与局限

- 英文搜索可用；中文站点覆盖很薄（搜索引擎以美国索引为主，百度、知乎、搜狗、Edge 和 360 的扩展商店都没能查询），中文部分主要靠直接读天坦社区、点明圈、厂商网站、应用宝和 GitHub。
- AppleVis 多数页面打不开，相关内容来自搜索摘要或镜像，标为未核实。
- 没有人实际试用过下面任何一个产品，功能描述来自它们自己的页面和用户的帖子。

## 结论

**1. 那句“唯一”要收窄，但没有被推翻。**

“整段视频、塞进对白空隙、不用逐个镜头去按”这一条已经不独有：至少三个“粘贴链接就能用”的网页播放器在做。真正还没有第二家的，是下面这个组合：

> 就在 YouTube / B 站的页面里（扩展）+ 贴进对白空隙、不暂停 + 用你自己的读屏念 + 支持 B 站和中文 + 自己的 Key、没有服务器 + 能追问、能说“刚才那句不对” + 开源。

**2. 最接近的对手**

| 名称 | 是什么 | 它有而我们没有的 | 我们有而它没有的 |
| --- | --- | --- | --- |
| ViddyScribe Realtime | 网页播放器，粘贴 YouTube 链接；自称 7000 多用户和机构；上过无障碍播客 | **不用安装、不用 API Key**；对视障个人免费（每个视频最长 15 分钟，不限数量）；98 种语言的自带语音 | 在页面里；用自己的读屏；B 站；追问；自带 Key 的隐私；不限时长。它 11 月 11 日宣布“不暂停模式”免费，但价格页仍写着只对企业开放，有用户说找不到——算“已宣布，未证实上线” |
| Enjoyable Lite | 马来西亚一个比赛作品，网页播放器，功能最像：提前两分半准备、每个空隙一句、有“现在画面是什么”和“重复” | 不用安装、不用登录、不用 Key | 0 星、3 次提交，非商业许可；只有 YouTube |
| Binclusive Content Studio | 网页应用，粘贴链接后等 4–5 分钟；据用户说它的播放器让 NVDA 念描述 | 不用 Key | 免费只到 3 分钟；不在页面里 |
| ViDscribe | 研究原型（CHI 2026），YouTube 链接、描述放进静音段、可追问 | 做过 8 位视障用户的研究 | 是否公开可用不清楚 |
| Gemini 本身 | 把 YouTube 链接贴给 Gemini，得到整段视频的文字描述 | 零成本、零安装；AppleVis 上有人说“这就够了” | 不跟播放同步，长视频会失败 |
| NVDA 插件 Vision Assistant Pro | 用自己的 Gemini Key；给链接出整段描述或导出字幕；新版能每隔几秒报告屏幕变化 | 已有 57 星的用户群 | 不贴对白空隙；不支持 B 站 |
| Recap Audio Describer | Chrome 扩展，在页面里、Alt+D 启动、本机 AI | 不用 Key | 每句都暂停视频；用浏览器语音；6 个用户 |

**3. 中国这边**

- **豆包的“共享屏幕通话”是事实上的对手**：手机上免费，对任何 App 的画面都能讲。视障用户在论坛上说它在刷短视频时每条讲一遍，镜头切换时会断；也有人说它只在被问到时才讲。它不管对白空隙。
- **听见画面（hear-screen）**：2026-10-31 出现的 Windows 小工具（MIT，0 星）。每 4.5 秒截屏发给豆包，用 Windows 语音念，一个热键开始，抖音、B 站、腾讯视频都行。不贴空隙、有 3–8 秒延迟、不走读屏、不能追问。所以“B 站只有我们”这句话不成立，应改成“B 站上唯一贴对白空隙、走读屏的”。
- **手机读屏厂商已经有零件**：心智无障碍助手有“视频自动描述”（爱奇艺、优酷、腾讯视频、西瓜），天坦、点明、保益有短视频文件的理解功能（40 秒到 10 分钟，多为付费）。
- **国内视障用户以手机为主**（这是从上面的产品形态推断的）。扩展只覆盖电脑上的 B 站，而且 B 站那条路是边看边描述、会晚几秒，还没在真实读屏上测过；抖音、快手、优酷、爱奇艺、腾讯视频都不覆盖。
- 没找到：任何给中文网站做 AI 画面描述的浏览器扩展；B 站、抖音、快手自带的 AI 画面描述。

**4. 平台自己还没做。** 没有找到 YouTube、Chrome、Edge、各家读屏“持续描述正在播放的视频”的功能或公告。YouTube 的口述音轨仍是创作者自己上传；Gemini in Chrome 只回答“已经播过的内容”；JAWS、讲述人、Be My Eyes 只描述一张静止画面。

**5. 差异化不等于有需求——这一条最要紧。**

- 找到的每个同类扩展用户都不到 400。最像的前辈 FYEO 只有 11 个安装，已从商店下架。
- 旧计划引用的“AppleVis 2026 年 7 月有人发帖求的就是这个产品”，查到的是一位开发者在征求意见（免费开源的 Chrome 扩展、用自己的读屏念），回复偏冷：有人说 Copilot 之类很快会做，有人说把链接贴给 Gemini 就够了，两个人说浏览器扩展对他们来说难用，更愿意要网页或桌面应用。（来自搜索摘要，未核实。）
- 需求本身是真的：天坦社区有视障用户要求读屏里直接有视频描述，要求支持链接和手势。

**6. 未来十二个月最大的威胁**

- 谷歌：Gemini 已经能读 YouTube 视频，Gemini in Chrome 就在页面上，研究里已有“会描述的播放器”原型。Chrome 或 YouTube 一旦加上“描述这个视频”，扩展在 YouTube 上的位置就没了；B 站和“走读屏”还在。
- ViddyScribe：一年内免费时长从 1 分钟涨到 15 分钟，又加了不暂停模式，已经有用户。它放开时长或出一个扩展，就直接压过来。
- 国内：豆包让屏幕共享的讲解懂得避开对白；或者某家读屏厂商把实时视频描述绑到一个手势上。

## 对扩展这条线的含义

1. **对手赢在“没有门”，不在引擎。** ViddyScribe、Enjoyable Lite、Binclusive 都是不用安装、不用 Key。这正是旧计划自己列的头两个致命问题。所以上架商店只解决了一半；**网页播放器 + 不用 Key 的云端额度**才是和它们正面比的那条路，而云端中转至今没部署。
2. **真正独有的东西要先被证实能用**：用自己的读屏念、B 站。这两样都还没有任何真人用读屏测过。
3. **对外的说法**（上架文案、网站里目前没有“唯一”这类词，保持）：英文区说“在你正在看的页面里，用你自己的读屏，贴进对白空隙”；中文区在争渡或 NVDA 上实测通过之后再说“B 站上唯一贴对白空隙、用你自己读屏念的”。
4. **手机**：国内用户以手机为主。网页播放器是现成的手机入口，但它目前只支持 YouTube 链接。

---

以下是三路检索的原始报告和核查（英文，未改动）。

## Appendix A — Extensions and web tools

Search tool worked (no quota refusal). Blocked or unrenderable: AppleVis and Greasy Fork (Cloudflare), Edge Add-ons and Product Hunt search pages. AppleVis content below comes from search snippets, so it is marked [unverified]. All listings fetched 2026-11-15.

### Verdict
The claim needs narrowing; it does not fall. "Whole video, fitted into dialogue gaps, with no per-shot pressing" is no longer unique: at least three paste-a-link web players do it for any YouTube video. The nearest competitor is **ViddyScribe Realtime**, which is free for blind individuals and already has podcast exposure. The closest feature twin is Enjoyable Lite, a hackathon prototype. What still stands is the combination: inside the page you are already watching, gap-fitted without pausing, your own screen reader as the voice, Bilibili, your own key with no server, MIT licence. I found no other tool with all of these, and none at all for Bilibili.

### What exists
- **ViddyScribe Realtime** (beta web player on its own site): whole-video AI description for any YouTube link. Standard mode fits gaps and extended mode pauses; it speaks in its own AI voices (98 languages claimed). The free Individual plan gives unlimited YouTube videos of up to 15 minutes each. The site claims 7,000+ users and organisations; Product Hunt shows 3 points. An AppleVis user reported description only at the very end of a video [unverified]. https://www.viddyscribe.com/pricing, https://doubletaponair.com/how-viddyscribe-is-bringing-real-time-audio-description-to-youtube/ (2025-11-07)
- **Enjoyable Lite** (web app, no install or login): paste a YouTube link and it plays through in under a minute, preparing about 2.5 minutes ahead. One line per pause, own server voices plus screen-reader announcements, 33 languages. Shortcuts for repeat and "what's on screen". PolyForm Noncommercial, 0 stars, US$3 daily spend cap, created 2026-10-17. https://github.com/yayadontknow/enjoyable-lite, https://enjoyable-lite.ables.com.my/
- **ViDscribe** (research web app, CHI EA '26): any YouTube URL, Gemini 3 Pro, descriptions placed in detected silences, own text-to-speech, question answering, six customisation settings. Studied with 8 blind users and 81 videos; public availability is unclear. https://arxiv.org/html/2603.14662v1
- **Binclusive Content Studio** (web app, launched May 2026): paste a YouTube link and wait about 4–5 minutes; the vendor says narration fits dialogue gaps. AppleVis users say its player makes NVDA speak the descriptions [unverified]. Free up to 3-minute videos, then from $10/month. https://studio.binclusive.io/pricing
- **Recap Audio Describer** (Chrome extension, beta): works in the page on any HTML5 video, started with Alt+D. It pauses the video at each cue and uses browser text-to-speech and on-device AI, with no key. 30 minutes free, then paid. 6 users, no ratings, v1.0.17, updated 2026-11-14. https://chromewebstore.google.com/detail/recap-audio-describer/ifdkeegoagmibboldkgdcndaiobkbnpj
- **Screen Reader Description** (Chrome extension): human crowd-sourced text read by the user's own screen reader, on selected YouTube, Disney+, Crunchyroll and HIDIVE videos. 50 users, no ratings, updated 2026-08-03. https://chromewebstore.google.com/detail/mheldpckofmhbfadbafiohnpgfphopjk
- **FYEO** (Chrome extension): the store page no longer renders and it is absent from store search. ExtScope flags it "Suspected delisted" with 11 installs. The developer said on AppleVis it was manual and on demand [unverified]. https://www.extscope.org/extension/ibobehoeobnelieehpkjpmccihfopjjj
- **Vision Assistant Pro** (NVDA add-on, GPL-2.0, 57 stars, pushed 2026-11-15): uses your own Gemini key. Give it a YouTube, Instagram, TikTok or X link and NVDA reads a whole-video description, or it exports SRT/MP3. It is not synchronised to playback. https://github.com/mahmoodhozhabri/VisionAssistantPro
- **YouDescribe**: volunteers plus AI drafts (released 2026-05-21). Its Wishlist extension only queues videos: 138 users, 5.0 from 2 ratings, updated 2026-09-17. https://www.ski.org/news/youdescribe-launches-two-new-describer-interfaces-for-gaad-2026/
- **Others**: VIDIO is a creator tool (https://www.vidio.ai/tools/audio-description-for-youtube). PiccyBot's web description service was in tester stage in August 2026 [unverified]. "Audio Descriptions" (105 users, 2022) and accessibility.video (375 users, 2023) are not AI. CineVoice AI Narrator (Firefox) appears only on a third-party mirror and is not public on Mozilla's site [unverified]. 听见 is a Chinese contest demo with built-in clips, not an extension (https://github.com/dada-maker-0528/tingjian-audio-description).
- **AppleVis thread, 2026-07-30, by "JDM"** [unverified]: a developer's idea check for a free open-source Chrome extension spoken by your own screen reader. Replies were sceptical: one expected Copilot or similar to do this soon, another said blind users prefer a desktop app. If this is the thread the plan cites as demand, it is weaker evidence than the plan states.

### Searched and found nothing
- Bilibili or Chinese-language description extensions: none. Chrome store search for 口述影像 returned zero results; Chinese web searches found only subtitle-summary tools.
- Firefox Add-ons (seven queries): nothing with AI description.
- Edge Add-ons and Greasy Fork: could not be searched; web search surfaced nothing for either.
- "DescribeIt", "AD for YouTube", "Audio Describer" as extensions: nothing. "Describe Now" is a research system only.
- No announcement of YouTube-native AI description or Gemini-in-Chrome video description turned up (not exhaustively checked).

### What the owner should conclude
- **Really alone:** Bilibili and Chinese; an extension that fits gaps without pausing on the page itself; AI description synchronised to playback and voiced by the screen reader; own key with no server; the "last description is wrong" command.
- **Not alone:** whole-video, gap-fitted AI description of any YouTube video. ViddyScribe Realtime, Enjoyable Lite and ViDscribe do it with no install and no API key, which is exactly the plan's fatal problems 1 and 2.
- **Differentiation is not demand:** every extension found has under 400 users, and the nearest prior attempt (FYEO) had 11 installs and looks delisted.
- **Biggest threat in the next twelve months:** ViddyScribe lifting its 15-minute cap or shipping an extension, since it already has the engine, a free tier and an audience. Behind it sits a platform-native feature from Google or Microsoft, which AppleVis commenters already expect.

### Fact-check

Search worked (no quota refusal). AppleVis returned 403 and the Firefox Add-ons search did not render.

1. ViddyScribe Realtime is the nearest competitor (free, YouTube up to 15 minutes, own voices, no extension) → **confirmed, one part unverifiable**. The pricing page says "Watch Unlimited YouTube Videos with AD upto 15 mins per video", and no page mentions an extension. "Standard = no pauses" appears only for the upload product; nothing says Realtime fits gaps. https://www.viddyscribe.com/pricing, https://www.viddyscribe.com/realtime
2. Recap Audio Describer pauses at each cue (6 users, v1.0.17, updated 2026-11-14) → **confirmed**. https://chromewebstore.google.com/detail/recap-audio-describer/ifdkeegoagmibboldkgdcndaiobkbnpj
3. Vision Assistant Pro "is not synchronised to playback" → **outdated**. Version 2026.10.15 added Ambient Observer: a screen watcher with a "watching a film" context, 1–10 s frame interval, own Gemini key. Its SRT export is also meant to be spoken by the screen reader through VLC or PotPlayer during playback. It is not gap-aware. https://github.com/mahmoodhozhabri/VisionAssistantPro
4. "None at all for Bilibili" and Chinese "really alone" → **wrong**; see hear-screen below.
5. FYEO looks delisted → **confirmed**; the store URL renders an empty listing. https://chromewebstore.google.com/detail/ibobehoeobnelieehpkjpmccihfopjjj

Missed:
- **hear-screen** (听见画面): a Windows desktop tool, MIT, v1.0.0 dated 2026-10, 0 stars, built from source. It narrates Douyin, Bilibili and Tencent Video from screen captures every 4.5 s by default. It uses your own Doubao or OpenAI-compatible key and the Windows SAPI voice, with no dialogue-gap fitting. https://github.com/shaxi-60/hear-screen
- **LIMA screen reader** (Roscommon Systems): AI video narration integrated with YouTube that pauses and resumes playback, reported 2026-05-04 [unverified: trade press only]. https://itbrief.com.au/story/roscommon-systems-adds-video-narration-to-lima-screen-reader
- **Private Eye**: an NVDA add-on plus Android Jieshuo plugin for live screen description through Ollama, 1 star; its video mode is [unverified]. https://github.com/devinprater/private-eye
- Four Chrome Web Store searches (three English, one Chinese) surfaced no new AI describer extension. I found no native YouTube, Chrome or Edge feature.

Net effect on the verdict: The narrowed verdict holds, but the "really alone" list shrinks further. Bilibili/Chinese, own-key-no-server-MIT, and continuous description alongside a screen reader each have a desktop precedent, though all are tiny. What remains unique is gap-fitted, non-pausing description inside the page as an extension, and ViddyScribe's own gap-fitting in Realtime is unproven.

## Appendix B — Platforms, browsers and assistive technology

Search tool worked (no quota refusal). Blocked or empty fetches: applevis.com (403, read through the atlas-entry.applevis.com mirror), freedomscientific.com "new features" (403), FYEO's Chrome Web Store listing, Edge Add-ons search, vidscribe.org and piccybot.com/audiodescribe (script-rendered, no content). All URLs accessed 2026-11-15.

### Verdict
The claim needs narrowing. "Whole video, fitted into dialogue gaps, no per-shot pressing" is no longer unique: two web players now do it for any YouTube link. The single nearest competitor is **ViddyScribe Realtime**; its co-founder posted on 2026-11-11 that "Standard AD (no pauses)" is now free on YouTube, 15 minutes per video, unlimited videos. What still looks unique is the combination: inside the youtube.com / bilibili.com page as an extension, spoken by the user's own screen reader, Bilibili support, own-key privacy, plus ask-a-question and "that was wrong". No platform, browser, OS or screen reader gives a running description of an arbitrary YouTube video today.

### What exists
- **ViddyScribe Realtime**: web player (viddyscribe.com/realtime; paste link, URL prefix or search). Whole video; standard (gaps) or extended (pauses); own AI voices, 98 languages; YouTube only; free 15 min/video, paid by email; claims 7,000+ users; no Q&A. Users report it "clunky" and ask how to stop it interrupting. https://atlas-entry.applevis.com/comment/213719 , https://viddyscribe.com/pricing
- **Enjoyable Lite** (ABLEs, Malaysia): open-source (PolyForm Noncommercial) web player, enjoyable-lite.ables.com.my. Whole video in gaps of 2.2 s or more, never over dialogue; own voices (screen reader gets status only); "what's on screen" and repeat keys; 33 languages; no login, shared cache; YouTube only. 0 stars, 3 commits, 2026-10-17. https://github.com/yayadontknow/enjoyable-lite
- **Binclusive Content Studio**: web app; YouTube link, 4–5 min processing; whole video, read by the user's screen reader in its player; free up to 3 min, then subscription; 50+ languages. https://atlas-entry.applevis.com/comment/208091 (2026-05-10)
- **PiccyBot AudioDescribe**: web app (2026-08-20); YouTube sharing and 30-min videos in Pro; backend errors reported. https://atlas-entry.applevis.com/comment/213820
- **Vision Assistant Pro** (NVDA add-on, GPL-2, 57 stars, v2026.10.15): describes YouTube/Bilibili-type URLs on demand as text, exports a description script timed to pauses and an MP3; "Ambient Observer" reports screen changes. Speaks through NVDA; own Gemini key. Not synced to playback in the page. https://github.com/mahmoodhozhabri/VisionAssistantPro
- **Private Eye** (NVDA add-on, Ollama): continuous live screen description; video mode auto-activating on YouTube [unverified, from a Mastodon post]; 1 star, 3 commits, no release. https://github.com/devinprater/private-eye
- **Chrome Web Store** ("audio description"): Recap Audio Describer (6 users, on-device AI, pauses video, browser voice, for creators, updated 2026-11-14); Screen Reader Description (50 users, crowd-written text read by own screen reader on YouTube, 2026-08-03); accessibility.video (375 users, 3.7/5, 2023); Audio Descriptions (105 users, 2022). FYEO: press per shot; developer says live description "not currently possible" (2026-05-01). https://chromewebstore.google.com/search/audio%20description
- **YouTube**: descriptive audio is a creator-uploaded track, Advanced-features channels only; nothing automatic. "Ask YouTube" answers questions, on select videos. https://support.google.com/youtube/answer/16166822
- **Gemini**: pasting a YouTube URL returns a whole-video text description (free; long videos fail) — what AppleVis users say they use. Gemini in Chrome answers about media "already played"; Live shares page content. Guided Vision (2026-10-01) is camera-only, Android. https://afb.org/blog/entry/video-description-gemini-2-5 , https://support.google.com/gemini/answer/16283624
- **Screen readers and OS**: JAWS Picture Smart and Narrator (Ctrl+D / Ctrl+S, all Windows 11 PCs since April 2026) describe one still; Apple's OS 27 preview adds image and viewfinder description and auto-captions, no video description; Copilot Vision reads still frames only [unverified, Yahoo Tech]; Be My Eyes for Windows describes the screen as a still.
- **Seeing AI**: phone only, local MP4, pauses, 10 videos a day. https://nsw.guidedogs.com.au/news/technology-spotlight-video-description-and-other-features-on-seeing-ai-and-piccybot/ (2026-04-16)
- **Direction of travel**: Prime Video uses AI to find dialogue gaps for its describers (aboutamazon.com); Tencent Video's Barrier-Free Theater is platform-made. Research: ViDscribe (CHI EA '26, YouTube web player with description and Q&A, 8 participants, arxiv.org/abs/2603.14662) and MAVP, a conversational accessible video player (arxiv.org/abs/2602.04104, Feb 2026; I believe several authors are at Google, not confirmed on the page).

### Searched and found nothing
- Any YouTube or Google announcement or test of automatic / AI audio description for creator videos (English and Chinese; blog.youtube search returned 0 results).
- Gemini in Chrome, TalkBack, VoiceOver, Narrator, JAWS or Copilot describing a playing video continuously.
- Any Bilibili, Douyin or Youku native AI description; any Chinese-language extension (Chrome store search "口述影像": no results); any tool supporting Bilibili.
- Any Envision or Aira feature for online video; any Seeing AI desktop version.
- Any other extension doing AI description inside the YouTube page through the screen reader. The developer who floated one on AppleVis (2026-07-30) had built nothing by 2026-08-13.

### What the owner should conclude
- Really alone: in-page extension, own screen reader, Bilibili and Chinese, own key, question and correction commands. Nobody found does these together.
- Not alone: "whole video in dialogue gaps for any YouTube link" (ViddyScribe Realtime, Enjoyable Lite) and "read by your screen reader" (Binclusive). The plan's competitor list misses all three, plus Vision Assistant Pro and PiccyBot AudioDescribe.
- Demand signal is mixed: in the July–August AppleVis thread several blind users said pasting the link into Gemini is enough, and two said they find browser extensions hard and prefer web or desktop apps.
- Biggest twelve-month threat: Google. Gemini already ingests YouTube video, Gemini in Chrome sits on the page, and a description-capable video player has been prototyped in research. A "describe this video" mode in Chrome or YouTube would remove the YouTube half of the position; Bilibili and screen-reader output would remain.
- Nearer-term threat: ViddyScribe, which went from 1 to 15 free minutes and added no-pause mode within a year, and already has users.

### Fact-check

Search worked. chrome-stats 403; Chrome Web Store detail pages read via raw HTML and Extpose.

- **ViddyScribe Realtime nearest; no-pause AD free on YouTube, 15 min/video; web player, YouTube only, no extension or Q&A** → confirmed, with caveat → the 2026-11-11 post exists, but the pricing page still lists Standard AD as Enterprise-only and a user wrote on 11-12 that he could not find it: announced, not verified shipped. https://viddyscribe.com/pricing , https://atlas-entry.applevis.com/comment/213719
- **"No tool supports Bilibili"** → wrong → hear-screen, a Windows tool, narrates Douyin/Bilibili/Tencent Video continuously (screen capture every 4.5 s, Doubao model, Windows voice); v1.0.0 2026-10-31, 0 stars. No gap-fitting (ignores audio), 3–8 s delay, no screen-reader output, no Q&A. https://github.com/shaxi-60/hear-screen
- **Vision Assistant Pro takes "YouTube/Bilibili-type URLs"; not synced in page** → wrong on Bilibili, rest confirmed → README lists YouTube, Instagram, TikTok, X only. https://github.com/mahmoodhozhabri/VisionAssistantPro
- **FYEO is a live Chrome extension, press per shot** → outdated → store URL now returns no listing; Extpose records delisting 2026-10-05, 11 installs [date unverified]. https://extpose.com/ext/ibobehoeobnelieehpkjpmccihfopjjj
- **YouTube has nothing automatic** → confirmed → creator-uploaded track only; two more searches found no Google announcement. https://support.google.com/youtube/answer/16166822

Enjoyable Lite and Binclusive details also confirmed. Firefox add-ons search ("audio description", first 25 of 234 results): no AI describer.

Missed:
- hear-screen (above).
- Omni Describer: Windows app, YouTube URL plus own Gemini key, MP3 export; YouTube downloads reported failing in April 2026. https://atlas-entry.applevis.com/forum/windows/new-revolutionary-app-windows-omni-describer
- YouDescribe: volunteer YouTube descriptions with AI drafts and pause-to-ask, 3,000+ users. https://abilitycentral.org/article/youdescribe-accessibility

Net effect on the verdict: It holds — nothing found combines in-page extension, own screen reader, gap-fitting and Q&A, and FYEO has left the store. Restate Bilibili as "the only gap-fitted, screen-reader option", not "the only tool", and treat ViddyScribe's free no-pause mode as announced, not confirmed.

## Appendix C — China: following online video

Search limits: no quota refusal, but WebSearch is US-indexed and thin on Chinese sites. Sogou gave one results page then a captcha; Baidu, 360 and DuckDuckGo fetches failed; Zhihu and Greasy Fork returned 403; Edge, 360 and QQ extension stores could not be queried. Most Chinese evidence comes from direct fetches of 天坦社区 (bbs.tatans.cn), 点明圈 (dmq.dmrjkj.com), vendor sites, 应用宝, the App Store and GitHub. Forum dates marked "~" are converted from relative dates.

### Verdict
The claim needs narrowing; it does not fall. I found no Chinese product that combines whole video, in-page, one key, dialogue-gap timing and the user's own screen reader, and no browser extension for this at all. But "nothing else gives a running description" is false in China. Blind users already get one from 豆包's screen-sharing call, and a new Windows tool, 听见画面 (hear-screen, 2026-10-31), does one-hotkey live description of Douyin/B站. SceneVoice's own README also says that on Bilibili it describes as you watch, a few seconds late, and is untested with a screen reader on the live site. Nearest competitor: 豆包 screen sharing (by use); 听见画面 is nearest by design.

### What exists
- **豆包 共享屏幕通话**: phone app, free, any app on screen. Continuous commentary in its own voice, no gap fitting. A blind user reports narration breaks on cuts and is sometimes missing on silent or music-only clips. https://bbs.tatans.cn/topic/119760 (~Apr 2026); https://dmq.dmrjkj.com/social/newforum/topic/?id=650517 (2025-07-11). Proactive reminders reportedly withdrawn for some blind users: https://bbs.tatans.cn/topic/111154 (2026-01-12).
- **豆包 paste-a-link**: public Douyin/Kuaishou links, after-the-fact text read by the screen reader; unreliable; B站 not mentioned. https://bbs.tatans.cn/topic/95495 (~2025); https://bbs.tatans.cn/topic/116796 (~Mar 2026).
- **听见画面 / hear-screen**: Windows Python app, MIT, v1.0.0, 3 commits, 0 stars. Screenshot every 4.5 s to Doubao vision (own key), spoken by Windows SAPI, not the screen reader. Ctrl+Alt+S live, Ctrl+Alt+D describe now; any on-screen video; 3–8 s lag, no gap fitting, no Q&A. https://github.com/shaxi-60/hear-screen
- **心智无障碍助手** (Android screen reader): "视频自动描述" since 5.0 (~2025) for iQiyi, Youku, Tencent Video, Xigua, started through 字幕识别; cadence and voice not stated. Recognition features cost points. v5.9.0 2026-10-16, 9,750 downloads, 5.0 rating. https://bbs.tatans.cn/topic/76500; https://sj.qq.com/appdetail/com.aaa.xzhd.xzreader.voiceback
- **天坦百宝箱 3.3.0 "AI视频分析"** (~Apr 2026, Android): local file under 10 min/500 MB, timeline text afterwards, 千问 3.5, super members plus points, no online links. Users ask for links, gesture invocation and audio understanding. https://bbs.tatans.cn/topic/120811
- **点明安卓 "视频理解"** (2025-01-21): recorded or gallery video only; Qwen up to 40 s, Gemini up to 5 min; text plus follow-up questions. https://dmq.dmrjkj.com/social/newforum/topic/?id=544506
- **落寞工具箱** (iOS): upload up to 40 s; 4.5/49 ratings; v8.2 Nov 2026; ¥18/month. https://apps.apple.com/cn/app/id1613919345. **保益悦听** reportedly similar (40 s, paid) [unverified: forum snippet, thread now gone]; 应用宝 lists V12.5.8, 2026-11-03, 61,000 downloads, 3.3.
- **争渡读屏** (Windows): AI image description plus embedded-subtitle OCR; no video description. https://www.zdsr.com/docs/zdsr/2. 天坦读屏 8.2.0 likewise reads subtitles only.
- **B站**: 2022 screen-reader adaptation; AI 视频总结 is reportedly subtitle-based [unverified: third-party only]. B站 Chrome extensions are subtitle summarisers (e.g. Bilitato: 1,000 users, 4.8/8, 2026-10-09).
- **无障碍剧场** (Youku 9,200+ titles, China Daily 2026-01-12; Tencent; Douyin/Xigua; 听视无障碍 iOS): pre-made tracks for films and series only.
- **"52Tube(频道)读屏软件"**: 天津日报 2026-09-29 says it describes video, film and livestreams in real time; no site, listing or forum post found. [unverified] https://epaper.tianjinwe.com/tjrb/html/2026-09/29/content_143096_3882184.htm
- **NVDA Vision Assistant Pro**: one-off analysis of YouTube/TikTok/Instagram/X links, Gemini only, no Bilibili; 57 stars.

### Searched and found nothing
- Browser extension or userscript giving AI picture description to blind users on any Chinese site (Chrome store, AMO, GitHub; the GitHub search returned only SceneVoice).
- Native AI picture description for blind users in Bilibili, Douyin or Kuaishou.
- On-screen video features in vivo看见, 小艺, Xiaomi or OPPO (camera only).
- 通义, 元宝, 智谱清言, Kimi, 文心: forum threads cover camera calls only.
- WeChat mini-programs; 信息无障碍研究会 or 中国盲协 projects on AI description of online video.
- Blind UP主 or Zhihu accounts (unreachable).

### What the owner should conclude
- **Really alone:** dialogue-gap timing, speech through the user's screen reader, saved descriptions for replays, questions about the picture, and one key inside the desktop Bilibili page.
- **Not alone:** "running AI description of an online video." 豆包 does it free on the phone for every app. Every Chinese product above except 争渡 and 听见画面 is a phone app, so the audience looks phone-first (my inference). The extension covers only desktop Bilibili, experimentally, and none of Douyin, Kuaishou, Youku, iQiyi or Tencent Video.
- **Demand is real:** a blind user asked for video description inside the screen reader (https://bbs.tatans.cn/topic/53331, ~2024), and 天坦 users ask for links and gestures.
- **Biggest threat in twelve months:** 豆包 making screen-share commentary dialogue-aware, or a screen-reader vendor (天坦, 点明 and 心智 already hold the pieces) binding live video description to a gesture. 听见画面-style tools adding screen-reader output come second.
- **Honest claim for China:** "the only one that times descriptions into dialogue pauses and speaks through your own screen reader, inside the Bilibili page", after it has been tested there with 争渡 or NVDA.

### Fact-check

No quota refusal. Chrome Web Store pages would not render; extension data come from ExtScope/Chromeboard mirrors and AppleVis.

- "No browser extension for this at all" → **wrong as worded** (holds for Chinese sites only). FYEO (Chrome, v82.1.1, 11–12 users, 0 reviews, "suspected delisted") advertises real-time "Watchdog Mode" on Netflix/YouTube/Twitch. Its developer says it is press-"describe" each time; no Bilibili. https://www.extscope.org/extension/ibobehoeobnelieehpkjpmccihfopjjj ; https://mail.applevis.com/forum/assistive-technology/fyeo-demand-media-screen-readervisual-assistant
- 豆包 screen sharing gives "continuous commentary… sometimes missing on silent/music-only clips" → **partly wrong**. The poster says it works on those clips and explains each swiped short video "once"; the only flaw is breaking on cuts. Four users in an older thread say it describes only when asked. dmq 650517 is about shopping, not video. https://bbs.tatans.cn/topic/119760 ; https://bbs.tatans.cn/topic/96965
- 听见画面 → **confirmed** (0 stars, 3 commits all 2026-10-31, MIT, SAPI, 4.5 s, no gap timing, no Q&A). No release artefact. https://github.com/shaxi-60/hear-screen
- NVDA Vision Assistant Pro "one-off analysis" → **outdated**. v2026.10.15 added Ambient Observer (checks screen every 1–10 s, reports changes); Live Assistant since 6.5.0. Both Gemini-only; no Bilibili; 57 stars confirmed. https://github.com/mahmoodhozhabri/VisionAssistantPro
- "Speech through the user's own screen reader: really alone" → **wrong as a mechanism**. Screen Reader Description (Chrome, 46 users, 2026-08-03) feeds crowd-written, non-AI descriptions to the user's screen reader on YouTube/Disney+/Crunchyroll/Hidive. https://chromeboard.com/extension/screen-reader-description-mheldpckofmhbfadbafiohnpgfphopjk
- Also confirmed: 心智 (thread and 应用宝 figures); 争渡 (docs undated). 52Tube quote is verbatim; product still untraceable.

Missed: FYEO; Vision Assistant Pro's Ambient Observer; a planned free open-source Chrome extension (AppleVis, 2026-07-30: shortcut, own screen reader, follow-up questions), unbuilt as of mid-August: https://mail.applevis.com/comment/212860. No missed Chinese continuous describer found (searched 天坦/点明 for 元宝, 通义, 智谱, 小艺 screen sharing; GitHub returns only hear-screen).

Net effect on the verdict: It holds for China and gets slightly stronger, because 豆包 is per-clip and prompt-dependent rather than a proven running description. Drop "no extension at all" and "only one using your screen reader"; keep dialogue-gap timing inside the Bilibili page.
