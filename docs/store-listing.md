# Store listing: Chrome Web Store and Edge Add-ons

Everything the two store forms ask for, ready to paste, for the first submission of the next version (1.2.0). The owner's step-by-step checklist, in Chinese, is `docs/store-submission.zh-CN.md`; this file is where it tells you to copy from.

This text is written for the package as it ships while SceneVoice Cloud is closed: no *Start free*, no allowance, no licence field, and no host permission for the relay. What changes when Cloud opens is in one note, [When SceneVoice Cloud opens](#when-scenevoice-cloud-opens).

Keep the English and Chinese versions in step. Nothing in the name, the summary or the description names a browser: Edge Add-ons does not allow a listing to refer to other browsers, and the same text serves both stores.

## Name (45 characters max)

EN: SceneVoice: AI Audio Description for Video (42 characters)

ZH: SceneVoice 声景：AI 口述影像

The name comes from the manifest (`ext_name` in `scripts/locales/*.mjs`); change it there. "SceneVoice: AI Audio Description for YouTube and Bilibili" (57 characters) does not fit, so the sites are named in the summary and the description.

## Summary (132 characters max)

The stores show the manifest's `ext_description`, not what is typed in a form. These two lines are copies of `scripts/locales/en.mjs` and `scripts/locales/zh_CN.mjs`; a test (`site/site.test.js`) fails when they drift apart. To change the summary, change the locale files and copy the new text here. The summary says what SceneVoice does (who reads the descriptions) and, like the description, does not say that it works with a screen reader: no test with screen reader users has been completed yet.

EN: AI audio description for YouTube and Bilibili, for blind and low-vision viewers. Read by your screen reader or a built-in voice.

ZH: 为 YouTube 和哔哩哔哩视频生成 AI 口述影像，专为盲人和低视力观众设计，由你自己的读屏软件或内置语音朗读。

## Description

The same text goes into the Chrome Web Store description and the Edge Add-ons *Description* (250 to 10,000 characters there; both versions fit).

**EN**

SceneVoice adds audio description to public YouTube videos and, experimentally, to Bilibili videos. Press Alt+Shift+D on a video and you hear what is on screen (who enters, what they do, what the signs and title cards say) in the pauses between dialogue, read by your own screen reader. Creating descriptions takes about half a minute for every five minutes of video, and the first ones are usually ready within a minute.

What it cannot describe: live streams, private or age-restricted videos, and DRM-protected videos (paid or members-only). SceneVoice says so in one sentence when it meets one.

Built for screen reader users
• Descriptions go to a standard ARIA live region, so your own screen reader reads them: your voice, your speed, your braille display.
• Every control works from the keyboard. Every state is announced.
• Every build is checked by the developers with automated accessibility tests. Testing with screen reader users is under way and not finished: if your screen reader stays silent, switch to the built-in voice in the settings and please tell us which screen reader you use.
• A built-in voice is there for listeners without a screen reader.

Fits the pauses
• Every moment is written in three lengths. SceneVoice picks the longest that fits the silence, at your reading speed and playback rate.
• Or let it pause the video and read the full description. Or stay silent until you ask.

Describe now, ask anything
• Alt+Shift+S describes the current moment at once.
• Alt+Shift+Q opens a dialog: "Who is speaking?" "What does the sign say?" and you get an answer about that exact moment.
• Alt+Shift+L repeats the last description. Alt+Shift+H reads every shortcut aloud.

Reads on-screen text first, word for word
• Titles, names, slides, chart figures, prices, contact details, code, menus and signs, exactly as written and before other descriptions, with translation when needed. Text you already hear is not repeated.
• Quiet moments stay quiet: nothing is described just to fill a silence.

Two sites, two models
• YouTube with Google Gemini, which opens the public video by its link.
• Bilibili (experimental), or YouTube where Gemini is not available, with Qwen from Alibaba Cloud Model Studio. SceneVoice sends Qwen small still pictures of the video as it plays, so the first time you watch, descriptions come a few seconds after the picture. This path is new and has had less testing than YouTube with Gemini; it may not work on every video. Qwen is available in mainland China.
• SceneVoice never downloads, records or saves a video or its sound. Pictures are sent only with Qwen or on Bilibili, at most 640 pixels wide, and are kept in memory for a minute or two.

Your key, your data
• You use your own API key: Gemini from Google AI Studio, which has a free tier, or Qwen from Alibaba Cloud Model Studio, billed by use to your own Alibaba Cloud account (the settings page gives an estimate). Google's and Alibaba Cloud's terms apply to what is sent to them.
• No account with us, no subscription, no analytics. Requests go straight from your browser to the model you chose; this version contacts no server of ours.
• Your key stays on your computer, travels only in a request header, and never enters the YouTube or Bilibili page.
• Descriptions are saved on your computer, so a video is described only once.

Languages
• Interface in 14 languages: English and Simplified Chinese, reviewed; Traditional Chinese, Spanish, Portuguese (Brazil), French, German, Japanese, Korean, Russian, Arabic, Hindi, Indonesian and Vietnamese, AI-drafted and awaiting native review.
• Descriptions in any language your browser is set to; 24 of them (English, Simplified and Traditional Chinese, Spanish, French, German, Portuguese, Japanese, Korean, Russian, Arabic, Hindi, Italian, Dutch, Polish, Turkish, Vietnamese, Thai, Indonesian, Bengali, Urdu, Persian, Ukrainian and Swahili) have their own hedging words and test sentences.

SceneVoice is free and open source (MIT). Descriptions are generated by an AI model and can be wrong; it is asked to say when it is unsure and never to invent names, and every run begins "AI-generated audio description follows."

**ZH**

SceneVoice 为公开的 YouTube 视频加上口述影像，也实验性地支持哔哩哔哩视频。在视频页按下 Alt+Shift+D，你就能听到画面上发生了什么：谁进来了、在做什么、标牌和标题卡写了什么。这些描述由你自己的读屏软件在对白空隙里读出来。每 5 分钟视频约需半分钟生成，最前面的几条通常一分钟内就绪。

目前不能描述的视频：直播、私享或有年龄限制的视频，以及受版权保护（DRM，付费或会员专享）的视频。遇到这类视频，SceneVoice 会用一句话说明。

为读屏用户打造
• 描述写入标准的 ARIA 实时区域，由你自己的读屏朗读：语音、语速、盲文显示器都是你自己的。
• 所有操作都能用键盘完成，所有状态都会播报。
• 开发者对每个版本都运行自动化无障碍检查。读屏用户的实测正在进行，还没有完成：如果你的读屏没有读出口述，请在设置里改用内置语音，并告诉我们你用的是哪款读屏。
• 不用读屏的人可以使用内置语音。

放进对白空隙
• 每个时刻都有三种长度的描述，SceneVoice 按你的读屏语速和播放倍速选择能放进空隙的最长版本。
• 也可以让它暂停视频读完整描述，或者平时沉默、只在你要求时描述。

描述当前画面、随时提问
• Alt+Shift+S 立刻描述此刻画面。
• Alt+Shift+Q 打开对话框：“谁在说话？”“牌子上写的什么？”得到针对这一刻的回答。
• Alt+Shift+L 重复上一条描述。Alt+Shift+H 朗读全部快捷键。

屏幕文字优先、按原文朗读
• 标题、人名、幻灯片、图表数字、价格、联系方式、代码、菜单、标牌，照原样先于其他描述读出，必要时附翻译；已经听得到的文字不再重复。
• 安静时刻留白：不会为了填满空隙硬加描述。

两个网站，两种模型
• YouTube 用 Google Gemini，它通过链接直接打开公开视频。
• 哔哩哔哩（实验性），或者在用不了 Gemini 的地方看 YouTube，用阿里云百炼的通义千问。SceneVoice 在播放时把缩小的静态画面发给它，所以第一次观看时，口述会比画面晚几秒。这条路是新的，实测不如 YouTube + Gemini 充分，个别视频可能无法使用。通义千问在中国内地可以使用。
• SceneVoice 从不下载、录制或保存视频和声音。只有用通义千问或在哔哩哔哩上才会发送画面，最宽 640 像素，只在内存里保留一两分钟。

你的密钥，你的数据
• 使用你自己的 API Key：Gemini Key 在 Google AI Studio 申请，有免费额度；通义千问 Key 在阿里云百炼申请，按用量记在你自己的阿里云账号上（设置页有费用估算）。发给它们的内容适用谷歌和阿里云各自的条款。
• 我们这边没有账号、没有订阅、不做统计。请求从你的浏览器直接发给你选的模型；这个版本不联系我们的任何服务器。
• Key 只保存在你的电脑上，只放在请求头里发送，绝不进入 YouTube 或哔哩哔哩的网页。
• 口述保存在本机，同一视频只需生成一次。

语言
• 界面：14 种语言。简体中文和英文完整并经过校对；繁体中文、西班牙文、巴西葡萄牙文、法文、德文、日文、韩文、俄文、阿拉伯文、印地文、印尼文、越南文为 AI 初稿，等待母语者校对。
• 口述：浏览器设置的任何语言；其中 24 种（简体中文、繁体中文、英文、西班牙文、法文、德文、葡萄牙文、日文、韩文、俄文、阿拉伯文、印地文、意大利文、荷兰文、波兰文、土耳其文、越南文、泰文、印尼文、孟加拉文、乌尔都文、波斯文、乌克兰文、斯瓦希里文）各有自己的不确定措辞和试听句。

SceneVoice 免费开源（MIT）。描述由 AI 模型生成，可能出错；我们要求模型在不确定时明说、不编造人名，并且每次开始都会先说“以下为 AI 生成的口述影像”。

## Category

Accessibility (both stores).

## Single purpose

Provide audio description of online videos (YouTube, and experimentally Bilibili) for blind and low-vision users.

## Permission justifications

One entry per permission the form lists (the forms read them from the manifest). Chrome's form has one box for all host permissions: paste the *Host*, *Optional host permissions* and *Content script* entries there together.

- `storage`, `unlimitedStorage`: keep the user's settings in the browser's synced storage (`chrome.storage.sync`: when the browser's own sync is on, the browser copies them to the user's other browsers through their browser account; no key is among them), and the API key, usage counts and generated description scripts on this computer only (`chrome.storage.local`). Scripts for long videos can exceed the default quota (up to 300 videos are kept).
- `tts`: the optional built-in voice, for users without a screen reader or whose screen reader does not read the descriptions.
- `activeTab`: lets the toolbar popup read the address of the current tab when the content script has not answered, to tell whether it is a YouTube or Bilibili video and show the right status.
- `offscreen` (reason `WORKERS`): hosts the worker that sends the description requests to the Gemini or Qwen API. A request can take from 30 seconds to three minutes, longer than a service worker may wait for a fetch, and running it in the video page would expose the user's API key to the page and subject the request to that page's own policies.
- Host `https://generativelanguage.googleapis.com/*`: the Gemini API that generates descriptions. Called only with the user's own key.
- Host `https://dashscope.aliyuncs.com/*`: the Qwen API (Alibaba Cloud Model Studio), the model used on Bilibili and by users in mainland China, where Gemini is not available. Called only with the user's own Qwen key.
- Optional host permissions (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`): requested only for the single origin typed under *Advanced* > *API address*, at the moment the user saves it, for people who route Gemini or Qwen requests through a relay of their own (the two local addresses are for a relay running on the user's own computer). Nothing is requested until then, and only that one origin is.
- Content script on `youtube.com`: follow playback, read the video's caption timing and category from YouTube itself, and show the player button, the text overlay and the question dialog.
- Content script on `www.bilibili.com/video/*` (top frame only): the same on Bilibili video pages. It reads the data the page is delivered with and the subtitle file the player has loaded, and calls no Bilibili API.
- `all_frames: true` on the YouTube content script: YouTube videos are also watched inside embedded players (`youtube.com/embed`, `youtube-nocookie.com/embed`) on other sites, which are frames; the content script must run in that frame to follow the video and show the button. In a frame it never starts descriptions by itself; they begin only after the viewer has played that video and pressed the shortcut.

**Remote code:** No. All code ships in the package; the Gemini and Qwen APIs return data (JSON text), never code.

## Data usage disclosure

Answers for the Chrome Web Store *Privacy practices* tab and the *Data usage* section of Edge's *Privacy* page. They say the same as `PRIVACY.md`; when the policy changes, change both.

**Which types of user data does the extension collect?**

- Personally identifiable information: **No.** There are no accounts, and no name, address or email is asked for.
- Health information: **No.**
- Financial and payment information: **No.** Nothing is sold in or through the extension.
- Authentication information: **Yes.** The user's own API keys (Gemini, Qwen) are kept in `chrome.storage.local` on the user's computer and sent only to the API the user chose, in a request header. They never reach the developer.
- Personal communications: **No.**
- Location: **No.**
- Web history: **Yes.** The form means by it "the list of web pages a user has visited", with titles and times. SceneVoice sends no such list to anyone, but it keeps one of its own, and the same reading that ticks *Authentication information* above for keys that never leave the computer ticks this box:
  - What leaves the browser: nothing about the pages a user visits goes to the developer, and nothing goes to a model beyond the address and title of the one video the user asks to have described; they go to the model the user chose, in that request, and are declared under *Website content* below.
  - What is kept on the computer: the ids of the videos SceneVoice has described, each with its descriptions and the time it was last used (up to 300 videos, in `chrome.storage.local`; *Delete all saved descriptions* on the settings page removes them).
  - What can be copied off the computer by the browser, not by SceneVoice: only when the user sets the "AI-generated" notice to once per video (by default it is said every time), the ids of the videos whose notice has been heard, the last 300, are kept with the settings in `chrome.storage.sync`. With the browser's own sync on, the browser copies that storage to the user's other browsers through their browser account.
  - Why not "No": read as a browsing history that the developer collects, there is none, and an earlier draft of this file answered "No" for that reason. But the list of described videos exists, with times, and in one setting the browser carries part of it to the user's other browsers. Declaring it breaks no rule; leaving the box empty would contradict `PRIVACY.md`, which lists both.
- User activity: **No.** No clicks, keystrokes or usage statistics are recorded or sent.
- Website content: **Yes.** When the user asks for a description, SceneVoice sends to the model the user picked: the video's address (Gemini opens the public video itself), its title, channel or uploader and description as shown on the page, the section or moment to describe, the user's typed question and the context listed in `PRIVACY.md`, and, with Qwen or on Bilibili, scaled-down still pictures of the playing video.

**When does the extension read or send anything?**

- Requests to a model are made only when the user starts descriptions for a video, asks for the current moment, asks a question or marks a description as wrong. (*Create descriptions automatically*, off by default, starts them when a video is opened.)
- Separately, on every YouTube video page and in every embedded YouTube player, the content script re-reads that video's watch page and, when the video has captions, its caption file, from YouTube itself (same origin). It does this as soon as the page loads, before any key is pressed, to learn the caption timing and the video's category. Nothing read this way is stored or sent anywhere else.
- On a Bilibili video page it reads the title, uploader, description and section from the page itself, and, when the user turns on CC subtitles, fetches the subtitle file the player has just loaded. It calls none of Bilibili's APIs.
- Requests to the model are made by the worker of the extension's offscreen document, not by the service worker and not by the video page. The key test on the settings page (*Save and test*) is sent by the settings page itself.

**Who receives this data?** The model API the user chose, under its own terms: Google (Gemini API, `generativelanguage.googleapis.com`) or Alibaba Cloud Model Studio (Qwen, `dashscope.aliyuncs.com`); or the relay address the user typed under *Advanced*, if any. The developer receives nothing: this version makes no request to a server of the developer's.

**Certifications** (all three are ticked):

- I do not sell or transfer user data to third parties, outside of the approved use cases. True: data goes only to the API the user chose, to answer that request.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose. True.
- I do not use or transfer user data to determine creditworthiness or for lending purposes. True.

**Privacy policy URL** (one field in each store, for every language): `https://github.com/reddynb666/scenevoice/blob/main/PRIVACY.md`. Its Chinese translation is `PRIVACY.zh-CN.md`, next to it.

**Limited Use (Chrome Web Store).** The store's Limited Use policy says that "An affirmative statement that your use of the data complies with the Limited Use restrictions" "must be disclosed on a website belonging to your extension" (read on 2026-11-16 at developer.chrome.com/docs/webstore/program-policies/limited-use, quoted in two parts as the page was read out; the policy speaks of user data in general, not of one kind of it). The statement is in both privacy policies, under *Chrome Web Store: Limited Use*, and in the *Privacy* section of both pages of the website. Nothing to type into a form.

## Notes for the reviewer

Paste this block into the Chrome Web Store *Test instructions* tab and into Edge's *Notes for certification*. The review key goes into those two boxes only, never into this repository. In the line that names the extensions page, keep the address of the store you are pasting into.

The times in step 4 come from the extension's own design and messages, not from a measurement on a reviewer's network. Before pasting, run the block once yourself with the review key on the exact zip you upload, and correct anything that differs.

If a box limits the length, cut from the end: the *Network and data* list goes first, then step 6 and step 5. The key and steps 1 to 4 are what a reviewer cannot do without.

```
SceneVoice adds AI audio description to YouTube videos (Bilibili is experimental) for blind and low-vision people. There is no account and no login. Descriptions are written by Google's Gemini API, which needs an API key; the extension has no server of its own that could hold one. A key for this review only (Google AI Studio free tier, no billing, revoked after the review):

FILL IN: PASTE THE REVIEW KEY HERE

SceneVoice is made for screen reader users. By default it writes descriptions to an invisible ARIA live region, so without a screen reader nothing is seen or heard. Step 1 turns on a voice, step 3 turns on text.

1. After install the welcome page opens. Under "Hear them through" choose "Built-in voice", then press "Hear a sample". Three sample descriptions are spoken and shown as text. No key and no network are used.
2. On the same page follow "Add my key in settings". The settings page opens at the field "Gemini API key". Paste the key and press "Save and test". Within a few seconds the line below reads "Connected. Using" and the model's name.
3. On the settings page, in section "3. Voice and sound": "Voice" is already "Built-in voice" from step 1; tick "Show descriptions as large text on the video".
4. Open https://www.youtube.com/watch?v=aqz-KE-bpKQ (a public Creative Commons film, ten minutes, no dialogue), let it play, and press Alt+Shift+D (Option+Shift+D on a Mac).
   Expect, at once: a progress box above the player's controls, and the voice saying "AI-generated audio description follows" and that descriptions are being created.
   Expect, within about a minute: the first descriptions, spoken by the built-in voice and shown as large text on the video, and "You can start watching".
   If Google's model is overloaded this can take up to about three minutes; SceneVoice then moves to another Gemini model by itself, and the progress box stays on screen meanwhile.
5. Alt+Shift+S describes the current moment. Alt+Shift+Q opens a dialog to ask a question about it. Alt+Shift+L repeats the last description. Alt+Shift+H reads every shortcut.
6. The toolbar popup shows status, progress and quick settings. Everything works from the keyboard.

Any other public YouTube video with a few minutes of length works the same way. Live streams, private or age-restricted videos and DRM-protected videos cannot be described, and SceneVoice says so.

Network and data:
- Requests to the model are made by the worker of the extension's offscreen document (chrome://extensions or edge://extensions, Details, Inspect views, offscreen.html; it exists while descriptions are being made) and go only to generativelanguage.googleapis.com. The key test in step 2 is sent by the settings page itself, to the same host.
- On a YouTube page the content script also re-reads that page and its caption file from youtube.com itself (same origin), as soon as the page loads, to place descriptions between lines of dialogue. Nothing from it is sent anywhere else.
- The video's address and title go to the Gemini API only when the user asks for a description. The extension never downloads, records or saves video or audio: Gemini opens the public video by its link.
- Bilibili and the Qwen model are optional, experimental and need a Qwen key from Alibaba Cloud (not supplied). There, scaled-down still pictures of the playing video are sent to dashscope.aliyuncs.com and kept in memory only.
- No remote code. The optional host permission is requested only when a user types a custom API address under Advanced, and only for that one origin.
```

Why a key and no test account: SceneVoice has no accounts, and the key is the only credential there is. Make the review key in a Google Cloud project used for nothing else, on the free tier with no billing attached, and delete it when both reviews are over.

## Edge Add-ons: what Partner Center asks that Chrome does not

Checked against Microsoft's *Publish a Microsoft Edge extension* page on 2026-11-16.

**A description and a logo for every language in the package.** Partner Center lists one row per `_locales` folder, and *Description* (250 to 10,000 characters) and *Extension logo* are required in each row before *Publish* can be pressed. The package has 16 folders: `en`, `zh_CN`, `zh` (a copy of `zh_CN`, so that Hong Kong and Macau browsers get Chinese), `zh_TW`, `ar`, `de`, `es`, `fr`, `hi`, `id`, `ja`, `ko`, `pt_BR`, `pt` (a copy of `pt_BR`), `ru`, `vi`.

Not known until the first upload: what the stores make of the two bare folders, `zh` and `pt`. Chrome's list of locale names has `zh_CN`, `zh_TW`, `pt_BR` and `pt_PT` but not these two, and says an unsupported one is ignored; Partner Center may show a row for each, or none. If either store refuses the package over them, the two copies are taken out in `scripts/locales.mjs` (browsers set to Chinese for Hong Kong or Macau, or to Portuguese for Portugal, then get the English interface) and a new version is cut.

- English and Chinese (Simplified): paste the two descriptions above. For the `zh` row, if there is one, paste the Chinese one again.
- The other 13 rows (`zh_TW`, `ar`, `de`, `es`, `fr`, `hi`, `id`, `ja`, `ko`, `pt_BR`, `pt`, `ru`, `vi`) have no description yet. Three ways to deal with them; the choice is the owner's:
  1. **Remove the rows.** Microsoft's page documents a *Remove* link in each language row of *Store listings*. Whether Partner Center then accepts a package that still contains those `_locales` folders could not be tried without an account. Try this first: it changes nothing in the package.
  2. **Write a description for each.** Translate the English description above into each language the same way the interface strings were drafted (an AI translation, product names kept as they are, the 250-character minimum respected), and begin each with one sentence in that language saying it is a machine translation and where to send corrections. `zh_TW` can be converted from the Simplified Chinese text and read through once; `pt` reuses `pt_BR`. Partner Center also has a *Generate with AI* button under each description box; whatever it writes must be checked against the claims in this file before it is published. These texts are not drafted here: twelve unreviewed translations in a store listing are a risk for the people who would read them with a screen reader.
  3. **Ship fewer languages in the first store package.** Package only the reviewed languages (`en`, `zh_CN` and its `zh` copy) for the first submission and add the AI-drafted ones as native speakers review them. This needs a small change to the build before 1.2.0 is cut (`LOCALE_FOLDERS` in `scripts/locales.mjs` decides which folders are written), and "Interface in 14 languages" in the description, the READMEs and their test would become "2" for that package. People with other browser languages would get the English interface.

  Suggested order: try 1 at the first upload; if *Publish* stays greyed out, choose between 2 and 3. Decide before cutting 1.2.0 if 3 is a possibility, because it changes the package.

**Search terms** (optional; at most 7 terms, 30 characters each, 21 words in all, per language; not shown to users):

- EN: `audio description`, `screen reader`, `blind`, `low vision`, `visually impaired`, `described video`, `YouTube audio description` (14 words)
- ZH: `口述影像`, `无障碍`, `读屏`, `视障`, `盲人`, `视频描述`, `哔哩哔哩`

**Logo.** 1:1, 300 by 300 pixels recommended, 128 by 128 the minimum. `static/icons/icon128.png` meets the minimum. For a 300-pixel logo of the same drawing:

```
python3 -c "import runpy; runpy.run_path('scripts/make_icons.py')['draw'](300).save('docs/store/logo-300.png')"
git checkout -- static/icons    # the script also rewrites the packaged icons; keep the committed ones
```

Upload it once, then use *Duplicate this logo for all languages*.

**No other browser by name.** Edge's policy 1.1.2 says a listing "must not reference other browsers". The name, summary and descriptions above name none. The screenshots must not either: see below.

**The Privacy page** is separate from *Properties* and asks for the single purpose, a justification per permission, the remote-code answer, the data-usage boxes and the privacy policy URL: all from the sections above.

**Properties:** category *Accessibility*; *Website* `https://reddynb666.github.io/scenevoice/`; *Support contact detail*: the support address (`FILL IN`, see `docs/store-submission.zh-CN.md`), or `https://github.com/reddynb666/scenevoice/issues` until there is one.

**Availability:** *Hidden* for the tester round (the listing URL is shared by hand), *Public* afterwards; markets: all, which includes China.

## Screenshots (1280×800) and promo tile (440×280)

What is in `docs/store/` today, made on 2026-11-16 from this source by `scripts/screenshots.py`, before 1.2.0 was cut:

- `1-settings-1280x800.png`: the top of the settings page (the model for each site and the Gemini key).
- `2-popup-1280x800.png`: the toolbar popup beside a caption. The popup is shown away from a video, so its three buttons are greyed out.
- `3-welcome-1280x800.png`: the welcome page, the first thing a new user meets.
- `4-transcript-1280x800.png`: the transcript page with a sample script.
- `5-key-guide-1280x800.png`: the step-by-step key guide.
- `6-shortcuts-1280x800.png`: section *4. Keyboard shortcuts* of the settings page: the four keys the browser keeps, then the keys that are changed on the page.
- `promo-440x280.png`: the small promo tile.
- `zh-CN/` has the same seven files in Simplified Chinese, the caption beside the popup and the promo tile included.

Three things about them:

- **Make them again from the build that is submitted**, so that no image is older than the package beside it (the commands are below; step 6 of the owner's checklist).
- **None shows SceneVoice at work on a video**: the progress box, the large text on the video and the ask dialog need a real video page, which the script does not open. Take one by hand on a real video and let it replace one of the generated ones; keep the file names.
- **The words drawn on the images** (the caption beside the popup, the promo tile) are in `WORDS` in `scripts/screenshots.py`, in English and Simplified Chinese; a test (`site/site.test.js`) keeps "any" video and screen reader names out of them. The shortcuts picture names the keys "Alt+Shift+…", as the description does, on whatever machine it is made; made on a Mac, the other pictures show what a Mac shows.

After making them, look at each one before uploading: no image for Edge Add-ons may show the name of another browser.

To make them again (the script refuses every network request, so nothing is sent anywhere while it runs):

```
npm run build
npm run screenshots                     # English, into docs/store/
python3 scripts/screenshots.py zh_CN    # Chinese, into docs/store/zh-CN/
```

Chrome Web Store takes at least one and at most five screenshots, so one of the six stays out there (the hand-made one of a real video should be among the five); Edge Add-ons takes all six.

## When SceneVoice Cloud opens

SceneVoice Cloud is the planned, optional relay for people without a key of their own (`server/`). It is not deployed and has no address: the project holds no domain for it yet, and the address in the code is a placeholder that cannot resolve. The shipped package neither offers it nor asks for its host. It can open only once the owner holds a domain for it. On that day, a new version is submitted and this listing gains:

- **Description:** one bullet under *Your key, your data* saying what it is (a free daily allowance without a key, through a relay that stores no pictures or questions; your own key never passes through it), and the sentence "this version contacts no server of ours" becomes "with your own key, no server of ours is contacted".
- **Permissions:** a justification for the relay's host. As the build stands, turning `CLOUD_OPEN` on puts that host back into `host_permissions`. An update that adds a host permission can make the browser switch the extension off until the user accepts the new permission, so weigh the other way first: asking for the host at the moment the user presses *Start free* (the optional `https://*/*` already covers it).
- **Data usage:** under *Authentication information*, the device token: a random anonymous token issued by the relay at the moment the user presses *Start free* (not at install), stored in `chrome.storage.local`, sent only to the relay in a request header, and removed by *Stop using Cloud*. Under *Who receives this data*, the relay, with what it keeps (a daily count per token and, while sharing is on, finished description text) and what it never keeps. The *Web history* answer is thought through again, because requests then pass through a server the developer runs. If a paid tier is sold: the *Financial and payment information* answer names the payment platform, and the Chrome Web Store trader declaration changes from non-trader to trader.
- **Notes for the reviewer:** the *Start free* path as a second way in, which needs no key, and the relay's requests in the network section.
- **`PRIVACY.md` and `PRIVACY.zh-CN.md`:** their Cloud section stops saying "not open yet" and names the relay's address and the permission asked for it; the Limited Use statement is read again, because data then passes through a server the developer runs.

Not part of the listing, but due the same day: the website and both READMEs stop saying "planned" (a test in `site/site.test.js` fails until they do), and the web player's Content-Security-Policy in `site/play/index.html` gains the relay's origin by hand (`site/check.mjs` fails until it does).
