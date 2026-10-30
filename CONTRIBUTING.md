# Contributing to SceneVoice

Thank you for helping. SceneVoice exists for blind and low-vision viewers, so the bar for every change is: does it still work well with a screen reader, with no mouse, and with no sight of the screen?

## Ground rules

- Blind and low-vision users are the experts. If you are sighted, test with a screen reader and the monitor off before you open a pull request, and ask for a review from someone who uses one daily.
- Every user-visible string lives in `scripts/locales.mjs` in both English and Simplified Chinese. The build fails if a string is missing in either language.
- No new permissions without a written justification in `PRIVACY.md`.
- No analytics, no remote code, no network requests other than the Gemini API.

## Development

```
npm install
npm run dev          # rebuild dist/ on every change; reload the extension in chrome://extensions
npm test             # unit tests
npm run test:e2e     # end-to-end test (needs Python 3 and playwright with Chromium)
```

Load `dist/` as an unpacked extension. After changing the content script, reload the YouTube (or Bilibili) tab too.

## Before a release: screen reader checklist

Run through this with at least one of NVDA (Windows), JAWS (Windows) or VoiceOver (macOS), on a real YouTube video with dialogue.

**Setup**
- [ ] The settings page opens after install and focus is in the API key field.
- [ ] Every control on the settings page is reachable with Tab and has a spoken name and state.
- [ ] Saving a wrong key gives a spoken error; saving a right key says which model is in use.

**Generation**
- [ ] `Alt+Shift+D` on a fresh video announces that descriptions are being created, then "ready for the first 5 minutes", then the total count.
- [ ] Pressing the shortcut again during generation reports progress instead of starting over.
- [ ] Closing the tab mid-way and reopening the video continues where it stopped.

**Playback**
- [ ] Descriptions are heard in pauses, not on top of dialogue (Keep playing mode).
- [ ] In Pause mode the video stops, the full description is read, and playback resumes by itself.
- [ ] Seeking forward or back does not produce a flood of old descriptions.
- [ ] Changing the detail level with the shortcut is announced and takes effect on the next cue.
- [ ] On-screen text is read as a distinct kind of cue, word for word, and turning the setting off silences it.
- [ ] A visual description that comes due while on-screen text is being read does not cut the text off.
- [ ] On a video with captions, a slide title the presenter reads aloud is not read again.
- [ ] A music video or landscape passage is not filled with descriptions; *Essentials only* is quieter still.
- [ ] Ads are not described.
- [ ] Nothing is spoken twice (live region and built-in voice must not both be active).

**Describe now, repeat, ask**
- [ ] `Alt+Shift+S` speaks at once, even if the screen reader was mid-sentence.
- [ ] `Alt+Shift+L` repeats the last description.
- [ ] `Alt+Shift+Q` opens the dialog with focus in the text field; typing letters does not trigger YouTube shortcuts; Enter sends; the answer is read, starting with the moment it is about; Escape returns focus to where it was and playback resumes.
- [ ] After an answer, one Tab from the question field reaches *Go to …*; pressing it closes the dialog, says "Jumped to …" and plays from that moment.

**Description is wrong**
- [ ] Right after a description, *Last description is wrong* in the popup (or its shortcut, once set) says at once which description was marked, then reads the new one; the rest of the video is not described again.
- [ ] *Repeat* then repeats the corrected description, and playing past that moment again speaks the new one.
- [ ] With no description heard yet, and none near the current moment, it says there is nothing to mark. After an answer to a question, it says answers are not saved.
- [ ] Pressing it again while a correction is being made says it is still working. With no network, it says the description could not be made again.
- [ ] A description said to be uncertain ("Not certain." / "不太确定。") sounds natural with your screen reader in both languages.

**Shorts and fullscreen**
- [ ] Shorts are described, and a looping Short describes again from the start.
- [ ] In fullscreen, the ask dialog is reachable and visible.

**Popup**
- [ ] Every control is reachable with Tab; status is announced when it changes.

**China site: Bilibili with Qwen (experimental)**

On a real Bilibili video (`www.bilibili.com/video/…`), from mainland China if possible, with a Qwen key from Alibaba Cloud Model Studio:
- [ ] *Save and test* in the Qwen section says which model is in use; a wrong key gives a spoken error in Chinese and English.
- [ ] The popup on a Bilibili video names the video; without a Qwen key it asks for one (not for a Gemini key).
- [ ] `Alt+Shift+D` says SceneVoice is describing as you watch; within about 20 seconds of playback the first description is heard, in a pause, a few seconds late. It is in Chinese with the description language set to follow the browser.
- [ ] On a video with CC subtitles (written or AI), descriptions do not talk over dialogue; the console shows "dialogue timing from captions".
- [ ] The SceneVoice button appears in Bilibili's control bar and has a spoken name; Bilibili's own shortcuts (space, f, d) do not fire while typing in the ask dialog.
- [ ] `Alt+Shift+S` and `Alt+Shift+Q` answer about the current picture; *Last description is wrong* describes that moment again.
- [ ] `Alt+Shift+D` again says descriptions are off and no more pictures are sent; the network panel shows no more requests to dashscope.aliyuncs.com.
- [ ] Watching the same stretch again says the saved descriptions on time, without new requests.
- [ ] A part (分P) switch, and a jump to a related video, start over for the new video.
- [ ] Find a video whose picture cannot be taken (if any: a `<bwp-video>` player, or a cross-origin stream): SceneVoice says so clearly and sends nothing.
- [ ] Not logged in: subtitles may be missing; descriptions still work with the model's own timing.

## Reporting bugs

Please include: browser and version, screen reader and version, the video (or a similar public one), what you pressed, what you heard, and what you expected to hear.
