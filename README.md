# SceneVoice — AI audio description for YouTube

[中文说明](./README.zh-CN.md)

SceneVoice is a free, open-source browser extension that adds **audio description** to any YouTube video, for blind and low-vision viewers. It watches the video with Google's Gemini model, writes short descriptions of what is on screen, and speaks them in the pauses between dialogue — through **your own screen reader**, so you keep your voice, your speed and your braille display.

It is built for screen reader users first. Every control works from the keyboard; every state is announced; nothing is hidden behind a picture.

## What it does

- **Describes any YouTube video on demand.** Press `Alt+Shift+D` on a video and SceneVoice creates descriptions in about half a minute per five minutes of video. The first part is ready before the rest is finished (you hear *You can start watching*), progress is shown above the player's controls and said at 25%, 50% and 75% (this can be turned off), and everything is saved on your computer, so a video is described only once.
- **Fits into the pauses.** Every moment is written in three lengths (brief, standard, detailed). SceneVoice picks the longest one that fits the silence and skips a description when even the brief one does not fit, rather than talk over dialogue. When the video has captions (including YouTube's automatic ones), their timing is used to find the real pauses. If you prefer, it can pause the video and read the full description instead, or stay silent until you ask.
- **Reads on-screen text first, word for word.** Titles, names in lower thirds, slides, chart figures, prices, phone numbers and addresses, code, menus, signs and chat messages are transcribed exactly as written and read before other descriptions, in the original with a translation if needed. Text you already hear (a presenter reading a slide, subtitles that match the captions) is not read again. You can turn this off separately.
- **Leaves quiet moments quiet.** Nothing is described just to fill a silence. Music, scenery and long takes get a few words only when the picture really changes.
- **Describe now and ask anything.** `Alt+Shift+S` describes the current moment at once. `Alt+Shift+Q` opens a dialog where you can type a question — "who is speaking?", "what does the sign say?" — and get an answer about that exact moment. Every answer starts with the moment it is about ("At 2:15: …"), and *Go to 2:15* below it takes you there.
- **Says what it sees, and says when it is not sure.** Descriptions stick to what is visible: no guessed feelings or motives, no praise or judgement, and no names unless they are on screen or spoken. When something is blurred, small or too quick, the description says so ("appears to", "hard to see"), and descriptions Gemini is not sure of are spoken less often.
- **Tell it when it is wrong.** *Last description is wrong* (in the popup, or a shortcut you set) marks what you just heard. SceneVoice describes only that moment again, replaces the saved description, and tells you each step. The mark stays on your computer.
- **Your screen reader, or a built-in voice.** By default descriptions go to a live region that NVDA, JAWS and VoiceOver read with your own settings. People without a screen reader can switch to the browser's built-in voices.
- **Chinese and English, and more.** Descriptions can be written in Simplified or Traditional Chinese, English, Spanish, French, German, Portuguese, Japanese, Korean, Russian, Arabic or Hindi. The interface is in English and Simplified Chinese.
- **Large-text overlay** for low-vision viewers and for sighted people watching with you.
- **No account, no server, no tracking.** You use your own free Gemini API key. SceneVoice has no backend and collects nothing.
- **China site (experimental): Bilibili with Qwen.** On Bilibili video pages, SceneVoice can describe as you watch with Alibaba Cloud's Qwen. See [below](#china-site--bilibili-experimental).

## Install

### From the Chrome Web Store

Coming soon. Until then, install the unpacked build below. SceneVoice works in Chrome, Edge, Brave and other Chromium browsers (version 116 or newer).

### Unpacked (developer) build

1. Download the latest `scenevoice-<version>.zip` from the Releases page and unzip it, or build it yourself (see Development).
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the unzipped `dist` folder.
3. The settings page opens, with focus on the key field (the Qwen key field in a Chinese browser). Follow the steps there, or the step-by-step guide linked from it, written for screen reader users, to add a key. A key that does not work is explained: wrong key, no connection, quota used up, or Gemini not available where you are.
4. The first time you play a video without descriptions, SceneVoice says once which key creates them. The popup lists every shortcut under *All keyboard shortcuts*, with a button to change them.

### Getting a Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Choose **Create API key** and copy it.
3. Paste it into SceneVoice's settings page and press **Save and test**.

The free tier is enough for everyday use. Google's terms for the Gemini API apply to what you send; see [Privacy](#privacy).

## Using it

Open any YouTube video.

| Action | Shortcut |
| --- | --- |
| Create descriptions for this video, or turn them on and off | `Alt+Shift+D` |
| Describe what is on screen right now | `Alt+Shift+S` |
| Repeat the last description | `Alt+Shift+L` |
| Ask a question about this moment | `Alt+Shift+Q` |
| Mark the last description as wrong and describe that moment again | *(set your own)* |
| Change the level of detail | *(set your own)* |
| Change what happens when a description does not fit | *(set your own)* |
| Change how much is described | *(set your own)* |
| Speak faster | *(set your own)* |
| Speak slower | *(set your own)* |
| Stop speaking | *(set your own)* |

Shortcuts can be changed at `chrome://extensions/shortcuts` — do this if one clashes with your screen reader. Chrome lets an extension suggest only four shortcuts, so the others start unset; the settings page lists them all and has a button that opens Chrome's shortcut page. The SceneVoice button in the player's control bar and the toolbar popup do the same things with the mouse.

The shortcuts that change a setting say the new value, for example "Detail: brief." or "Speaking rate: 1.4 times normal." *Speak faster* and *Speak slower* change the built-in voice's rate; with your screen reader they change the speed SceneVoice plans for (the setting below), not the screen reader itself.

The first time you play a video that has no descriptions, SceneVoice says so once and tells you the shortcut.

### When a description is wrong

Press *Last description is wrong* in the popup, or the shortcut if you set one, right after a description you think is wrong. SceneVoice says which one it marked ("Marked the description at 1:35 as wrong. Describing that moment again. It said: …"), asks Gemini to look again at about 20 seconds around that moment only, and then reads the new description ("Updated. The description at 1:35 is now: …"). If, looking again, there is nothing there worth describing, the description is removed and SceneVoice says so. The rest of the video is not described again.

If you have not heard a description yet, the one for the moment on screen is marked. Answers to questions are not saved, so there is nothing to mark; ask again instead. Corrected descriptions are labelled *Corrected* on the page that lists all descriptions.

Your marks stay on your computer, next to the saved descriptions, and are deleted with them. To describe the moment again, Gemini is sent the description you marked, so that it does not just repeat it.

### Settings worth knowing

- **When a description does not fit** — *Keep playing* (default) uses a shorter version that fits the pause, or skips it; *Pause the video* reads the full description and continues; *Only when I ask* keeps quiet until you press Describe now.
- **Detail** — Brief, Standard or Detailed: how long each description is. Standard is close to professional audio description.
- **How much to describe** — *Essentials only* (scene changes, who is there, the main action), *Moderate* (default; adds expressions, gestures, objects, appearance) or *As much as possible* (also scenery and background). On-screen text counts one step more: *Essentials only* still reads helpful text, *Moderate* reads all of it. None of them fills silences: the model is asked not to. It writes everything once; this only filters, so changing it is instant.
- **Read on-screen text** — on by default. Text is transcribed exactly as written and read ahead of other descriptions: a description that comes due while text is being read is dropped rather than cutting it off (unless it is more important), and text that appears while someone is speaking waits up to 8 seconds for a pause. Text the captions show is also spoken is left out.
- **By video type** — on by default. Entertainment (films, music, vlogs, games) keeps playing with brief descriptions of the essentials only, so the pace is not broken and quiet moments stay quiet; tutorials and explainers (lessons, how-to, science, news with charts) pause for detailed descriptions, so nothing on screen is missed. Each type's mode, detail and amount can be changed on the settings page. The type comes from the video's YouTube category and title (read from the page, with no extra request), and from Gemini once descriptions exist (it names the type in the same answer as the descriptions). SceneVoice says once per video what it changed and, the first time, how to change it back; the popup shows the values in use for the video in the tab. A mode, detail or amount you pick yourself (in the popup, on the settings page or with a shortcut) always wins; *Let the video type decide again* on the settings page undoes that.
- **How fast does your screen reader speak?** — SceneVoice cannot hear your screen reader, so it uses this to judge what fits in a pause. If descriptions get cut off, pick a slower setting; if they are too short, pick a faster one.
- **Interrupt other speech** — descriptions cut off whatever the screen reader is saying, so they stay in time with the picture. Off by default.
- **Create descriptions automatically** — starts as soon as you open a video. Off by default because it uses your API quota on every video you open.
- **Built-in voice** — voice, speaking rate and pitch, each set separately, with a *Test voice* button that reads a sentence in the description language. Voices for the description language are listed first, and each description language remembers its own voice. A voice chosen on another computer that this one does not have is replaced by an automatic one.
- **Quick settings in the popup** — detail, mode, how much to describe, on-screen text and speed (the rate of the built-in voice, or your screen reader speed) are in the toolbar popup as well as on the settings page.
- **Restore default settings** — at the end of the settings page. It resets every preference but keeps your API key, model, saved descriptions and keyboard shortcuts.

Settings other than the key are saved in your browser profile (`chrome.storage.sync`) and follow you to your other browsers if sync is on.

## China site / Bilibili (experimental)

YouTube and Gemini are usually not reachable from mainland China. This prototype runs SceneVoice on Bilibili video pages (`www.bilibili.com/video/…`) with Qwen (通义千问), Alibaba Cloud's model. It is a minimum viable version for testing, not yet a release.

### Setting it up

1. Create an API key in the Alibaba Cloud Model Studio (阿里云百炼) console: [bailian.console.aliyun.com](https://bailian.console.aliyun.com/). The model has to understand pictures; the default is `qwen-vl-max`.
2. On SceneVoice's settings page, under *1. Connect an AI model* → *Qwen (Alibaba Cloud Model Studio)*, paste the key and press **Save and test**. The key is stored like the Gemini key: on this computer only, out of reach of web pages and content scripts, and sent only to the Qwen API address.
3. *Which model describes each site*: Bilibili uses Qwen and YouTube uses Gemini by default. Either site can use either model.
4. Open a Bilibili video and press `Alt+Shift+D` (or *Create descriptions* in the popup).

### How it differs from YouTube with Gemini

- Gemini opens a YouTube video by its link and describes it before you get there. Qwen cannot open video links, and Gemini cannot open Bilibili's, so on Bilibili (and with Qwen on YouTube) SceneVoice describes **as you watch**: every 2 seconds it takes a picture of the playing `<video>` in the page (with a canvas, scaled to 640 pixels wide, JPEG), and every 12 seconds sends up to 6 of them to the model. The newest important description is said at the next pause that fits it, so it comes **a few seconds after the picture**. Every description is saved: the next time you watch, they are said on time, as on YouTube. Only the parts you have watched are described.
- While it describes as you watch, a box above the player's controls says *Describing as you watch* and *Described up to 1:35* (how far the part you are watching is described), with the share of the video described. The popup says the same, and it is said at 25%, 50% and 75% of the video (with *Announce generation progress*).
- *Describe now*, questions and *Last description is wrong* send pictures of that moment.
- Bilibili's CC subtitles (written ones first, then AI-generated ones) give the dialogue timing when they can be read, as YouTube captions do. When there are none, or they cannot be read, the model's own estimate is used.
- The video type (entertainment or tutorial) comes from the Bilibili section (分区) and the title.
- On Bilibili, *Same as my browser* as the description language means Chinese. With the built-in voice, Chinese voices are listed and used first. Screen reader output works as on YouTube.
- `Alt+Shift+D` turns descriptions, and the picture taking, off and on. *Stop* in the popup stops the picture taking and keeps what was described.

### Known limitations

- **Pictures protected by the browser (cross-origin).** When a video is loaded from another site without that site's permission (CORS), the browser "taints" the canvas and refuses to hand its picture to the page. SceneVoice then says that it cannot take pictures from this video and that no descriptions can be made for it, and sends nothing. Some Bilibili videos may play in Bilibili's own `<bwp-video>` element rather than a `<video>`; it cannot be drawn on a canvas and gets a similar message.
- **Protected (DRM) video.** Paid or members-only videos are often encrypted, and the browser then draws them as solid black without any error. After about 12 seconds of black pictures in a row SceneVoice stops taking pictures and says the video is protected. (A fade to black in a film is much shorter.)
- On first viewing, descriptions come a few seconds late, and parts you skip are not described. The model sees still pictures only: it misses movement between them and all sound.
- Cost: about 5 requests per minute of video, each with up to 6 small pictures, billed to your Alibaba Cloud account.
- Bilibili does not document its page structure or web APIs, and they may change. Viewers who are not logged in may get no subtitles. Bangumi (番剧) and live streams, players embedded in other sites and the mobile site are not supported.
- The Bilibili content script has not yet been tried with a screen reader on the live site (see the manual checks below).

### To be confirmed (待确认)

What this prototype could not check against current documentation. Each is a setting or a constant in one place, marked 待确认 in the code.

| What | Where | Now |
| --- | --- | --- |
| Model Studio's OpenAI-compatible address (mainland China; other regions differ) | Settings → Qwen → Advanced; `DEFAULT_QWEN_API_BASE` in `src/shared/constants.js` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Default vision model | Settings → Qwen → Model name; `DEFAULT_QWEN_MODEL` | `qwen-vl-max` |
| Pictures as base64 `data:` URLs in `image_url` parts, and how many per request | `src/shared/qwen.js`; local setting `qwenMaxFrames` | 6 per request, 640 px wide |
| `response_format: {"type": "json_object"}` for vision models | local setting `qwenJsonMode` | off: the prompt asks for JSON and the reply is read leniently |
| Error codes (`invalid_api_key`, `Arrearage`, `data_inspection_failed`…) | `classifyQwenHttp` in `src/shared/qwen.js` | best effort |
| Bilibili APIs `x/web-interface/view` and `x/player/v2` (subtitles may need a login or signed requests) | `BILIBILI_API` in `src/content/bilibili.js` | unsigned requests with the page's cookies |
| Bilibili player selectors, `<bwp-video>` behaviour, no ads in the player | `src/content/bilibili.js` | `.bpx-player-container`, `.bpx-player-control-bottom-right` |
| Bilibili sections → video type | `src/shared/videotype.js` | keyword match |

`qwenJsonMode` and `qwenMaxFrames` have no control on the settings page yet. To change one, open the settings page's developer tools and run, for example, `chrome.storage.local.get('local').then(({ local }) => chrome.storage.local.set({ local: { ...local, qwenMaxFrames: 4 } }))`.

### Compliance before a public release (待确认)

This prototype is for testing. Before it is offered to the public in mainland China, someone qualified must check at least the following. None of it has been checked yet, and this list is not legal advice.

- **Generative AI rules**: whether SceneVoice, which calls a model with the user's own key, has to complete algorithm filing (算法备案) or generative AI service filing or registration under the Interim Measures for the Management of Generative AI Services (《生成式人工智能服务管理暂行办法》) and the deep synthesis provisions (《互联网信息服务深度合成管理规定》), and how AI-generated descriptions must be labelled (《人工智能生成合成内容标识办法》).
- **Personal information** (《个人信息保护法》): a Chinese privacy notice, and consent for sending pictures of what the user watches to Alibaba Cloud.
- **Distribution**: the Chrome Web Store is not reachable from mainland China; Edge Add-ons or a Chinese browser's store have their own review. A project website may need ICP filing.
- **Bilibili**: its terms on reading its pages and web APIs automatically, and the uploaders' rights in the pictures sent to a model.

## How it works

```
YouTube page ──(video link, title)──▶ Gemini API (your key) ──(timed script, JSON)──▶ saved on your computer
                                                                                        │
                                           video time ──▶ scheduler ──▶ pick length ──▶ your screen reader / built-in voice
```

- The video itself is never downloaded or uploaded. Gemini reads public YouTube videos by URL, in sections of five minutes. Requests are made from a worker in the extension's own hidden page (an offscreen document), not from the YouTube tab: your key never enters the page, YouTube's page policies cannot block the requests, and the job carries on if you leave the video. Progress is saved after every section, so an interruption costs at most one section. Two tabs showing the same video share one run.
- If the chosen model is overloaded or no longer available for your key, the extension retries with increasing pauses and then continues with the next best model.
- For every moment the model writes three versions of the description, how long the following pause is, whether it is on-screen text or action, and how important it is. On-screen text also comes as an exact transcription, written before the spoken versions so that they quote it rather than paraphrase it; the transcript page shows it when a description translates or shortens it.
- If the video has captions, the extension reads them (from YouTube, in the page itself; nothing is sent elsewhere). Their timing corrects the pauses the model estimated: a description that starts just before someone stops talking is moved to the end of their sentence. Their words leave out on-screen text that is also spoken within a few seconds.
- While you watch, the extension checks the video's position several times a second. When a cue's time arrives it chooses the longest version that fits the pause at your reading speed and playback rate (or skips the cue, or pauses the video in pause mode, if none fits), lowers the video volume a little, and hands the text to a live region (or the built-in voice).
- People found in one section are passed to the next so names stay consistent.

Descriptions are generated by a language model and can be wrong. SceneVoice asks the model to describe only what is visible (no guessed feelings, judgements or identities, with examples of each in English and Chinese), to say "appears to" or "hard to see" when unsure, and to rate how sure it is of every description. A description it is not sure of counts as one step less important, so it is heard less often, and is said to be uncertain ("Not certain.", "不太确定。") if its own words do not already say so. Answers to questions name the moment they are about and say so when the picture does not show the answer. When you find a mistake, mark it (see above). Still, treat anything safety-critical with care.

## Privacy

- SceneVoice has no server and no account, and sends no analytics.
- To create descriptions, the YouTube video's address, title and description are sent to the Gemini API together with your API key. To describe a moment again, the description you marked as wrong is sent too. Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) apply.
- Your API key is stored only on your computer (`chrome.storage.local`) and is sent only to the Gemini API address shown in settings. It is never placed in a URL.
- Descriptions are saved on your computer so a video is described only once. You can delete them all from the settings page.
- The descriptions you mark as wrong are recorded on your computer only, with the saved descriptions, and are deleted with them. There is no feedback server.
- Settings (not the key) are synced through your browser profile if sync is on.

Full policy: [PRIVACY.md](./PRIVACY.md).

## Development

```
npm install
npm run build        # builds into dist/
npm test             # unit tests (vitest)
npm run test:e2e     # end-to-end test in headless Chromium with a mock Gemini API
npm run package      # build + scenevoice-<version>.zip for the Web Store
npm run dev          # rebuild on change
```

Layout:

- `src/content/` — runs on YouTube pages and Bilibili video pages: playback tracking, live regions, player button, ask dialog, and `generator.js`, the tab's side of generation (start, stop, ask; progress arrives as messages). What depends on the site is in a platform adapter, `youtube.js` or `bilibili.js` (`platforms.js` picks one); `frames.js` takes pictures of the playing video for models that are sent frames.
- `src/background/` — service worker: text-to-speech, keyboard commands, status for the popup, cache housekeeping, and the hub that starts generation jobs, saves each finished section and tells the tabs. It makes no Gemini calls itself: Chrome stops a service worker whose fetch takes more than 30 seconds, and video requests often do.
- `src/offscreen/` — the offscreen document and its web worker, where the Gemini requests actually run (`worker.js` keeps the job list; `offscreen.js` bridges it to the service worker).
- `src/shared/` — logic shared by all parts: Gemini client and prompts, the generation loop (`generation.js`: sections, resume, model fallback), script parsing, scheduler, cache, settings. Which model a site uses and whether it opens the video link or is sent frames is in `providers.js`; `qwen.js` is the Qwen client, `frames.js` the prompts built from frames, `describe.js` runs them with either model, and `coverage.js` tracks which parts of a video are described.
- `src/popup/`, `src/options/` — toolbar popup and settings page.
- `scripts/locales.mjs` — every user-facing string in English and Chinese; the build generates `_locales/`.
- `test/` — unit tests, and `test/e2e/e2e.py` which drives the real extension in headless Chromium against a fake YouTube page and a mock Gemini API (127 checks, including axe accessibility scans).

Testing with a screen reader before a release: see [CONTRIBUTING.md](./CONTRIBUTING.md), which also lists the manual checks for Bilibili.

## Roadmap

- Character memory you can edit ("call the woman in the red coat Maya"), kept per channel.
- Per-video-type defaults (tutorials more detailed, music videos brief).
- Sharing corrected descriptions so a video is described once for everyone.
- Other platforms where the video can be reached by URL.

## Acknowledgements

Writing guidelines follow the audio description practice described by the American Council of the Blind's Audio Description Project and the UK ITC guidance. Thanks to the blind and low-vision developers and testers on AppleVis whose discussions shaped the design.

## License

MIT — see [LICENSE](./LICENSE).
