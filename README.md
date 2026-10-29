# SceneVoice — AI audio description for YouTube

[中文说明](./README.zh-CN.md)

SceneVoice is a free, open-source browser extension that adds **audio description** to any YouTube video, for blind and low-vision viewers. It watches the video with Google's Gemini model, writes short descriptions of what is on screen, and speaks them in the pauses between dialogue — through **your own screen reader**, so you keep your voice, your speed and your braille display.

It is built for screen reader users first. Every control works from the keyboard; every state is announced; nothing is hidden behind a picture.

## What it does

- **Describes any YouTube video on demand.** Press `Alt+Shift+D` on a video and SceneVoice creates descriptions in about half a minute per five minutes of video. The first part is ready before the rest is finished, and everything is saved on your computer, so a video is described only once.
- **Fits into the pauses.** Every moment is written in three lengths (brief, standard, detailed). SceneVoice picks the longest one that fits the silence and skips a description when even the brief one does not fit, rather than talk over dialogue. When the video has captions (including YouTube's automatic ones), their timing is used to find the real pauses. If you prefer, it can pause the video and read the full description instead, or stay silent until you ask.
- **Reads on-screen text first, word for word.** Titles, names in lower thirds, slides, chart figures, prices, phone numbers and addresses, code, menus, signs and chat messages are transcribed exactly as written and read before other descriptions, in the original with a translation if needed. Text you already hear (a presenter reading a slide, subtitles that match the captions) is not read again. You can turn this off separately.
- **Leaves quiet moments quiet.** Nothing is described just to fill a silence. Music, scenery and long takes get a few words only when the picture really changes.
- **Describe now and ask anything.** `Alt+Shift+S` describes the current moment at once. `Alt+Shift+Q` opens a dialog where you can type a question — "who is speaking?", "what does the sign say?" — and get an answer about that exact moment.
- **Your screen reader, or a built-in voice.** By default descriptions go to a live region that NVDA, JAWS and VoiceOver read with your own settings. People without a screen reader can switch to the browser's built-in voices.
- **Chinese and English, and more.** Descriptions can be written in Simplified or Traditional Chinese, English, Spanish, French, German, Portuguese, Japanese, Korean, Russian, Arabic or Hindi. The interface is in English and Simplified Chinese.
- **Large-text overlay** for low-vision viewers and for sighted people watching with you.
- **No account, no server, no tracking.** You use your own free Gemini API key. SceneVoice has no backend and collects nothing.

## Install

### From the Chrome Web Store

Coming soon. Until then, install the unpacked build below. SceneVoice works in Chrome, Edge, Brave and other Chromium browsers (version 116 or newer).

### Unpacked (developer) build

1. Download the latest `scenevoice-<version>.zip` from the Releases page and unzip it, or build it yourself (see Development).
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the unzipped `dist` folder.
3. The settings page opens. Follow the three steps there to add a Gemini API key.

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
| Change the level of detail | *(set your own)* |
| Change what happens when a description does not fit | *(set your own)* |
| Change how much is described | *(set your own)* |
| Speak faster | *(set your own)* |
| Speak slower | *(set your own)* |
| Stop speaking | *(set your own)* |

Shortcuts can be changed at `chrome://extensions/shortcuts` — do this if one clashes with your screen reader. Chrome lets an extension suggest only four shortcuts, so the others start unset; the settings page lists them all and has a button that opens Chrome's shortcut page. The SceneVoice button in the player's control bar and the toolbar popup do the same things with the mouse.

The shortcuts that change a setting say the new value, for example "Detail: brief." or "Speaking rate: 1.4 times normal." *Speak faster* and *Speak slower* change the built-in voice's rate; with your screen reader they change the speed SceneVoice plans for (the setting below), not the screen reader itself.

The first time you play a video that has no descriptions, SceneVoice says so once and tells you the shortcut.

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

Descriptions are generated by a language model and can be wrong. SceneVoice asks the model to say "appears to" when unsure and never to invent names, but treat anything safety-critical with care.

## Privacy

- SceneVoice has no server and no account, and sends no analytics.
- To create descriptions, the YouTube video's address, title and description are sent to the Gemini API together with your API key. Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) apply.
- Your API key is stored only on your computer (`chrome.storage.local`) and is sent only to the Gemini API address shown in settings. It is never placed in a URL.
- Descriptions are saved on your computer so a video is described only once. You can delete them all from the settings page.
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

- `src/content/` — runs on YouTube pages: playback tracking, live regions, player button, ask dialog, and `generator.js`, the tab's side of generation (start, stop, ask; progress arrives as messages).
- `src/background/` — service worker: text-to-speech, keyboard commands, status for the popup, cache housekeeping, and the hub that starts generation jobs, saves each finished section and tells the tabs. It makes no Gemini calls itself: Chrome stops a service worker whose fetch takes more than 30 seconds, and video requests often do.
- `src/offscreen/` — the offscreen document and its web worker, where the Gemini requests actually run (`worker.js` keeps the job list; `offscreen.js` bridges it to the service worker).
- `src/shared/` — logic shared by all parts: Gemini client and prompts, the generation loop (`generation.js`: sections, resume, model fallback), script parsing, scheduler, cache, settings.
- `src/popup/`, `src/options/` — toolbar popup and settings page.
- `scripts/locales.mjs` — every user-facing string in English and Chinese; the build generates `_locales/`.
- `test/` — unit tests, and `test/e2e/e2e.py` which drives the real extension in headless Chromium against a fake YouTube page and a mock Gemini API (127 checks, including axe accessibility scans).

Testing with a screen reader before a release: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Roadmap

- Character memory you can edit ("call the woman in the red coat Maya"), kept per channel.
- Per-video-type defaults (tutorials more detailed, music videos brief).
- Sharing corrected descriptions so a video is described once for everyone.
- Other platforms where the video can be reached by URL.

## Acknowledgements

Writing guidelines follow the audio description practice described by the American Council of the Blind's Audio Description Project and the UK ITC guidance. Thanks to the blind and low-vision developers and testers on AppleVis whose discussions shaped the design.

## License

MIT — see [LICENSE](./LICENSE).
