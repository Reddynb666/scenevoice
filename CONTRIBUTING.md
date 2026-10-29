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

Load `dist/` as an unpacked extension. After changing the content script, reload the YouTube tab too.

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
- [ ] On-screen text is read as a distinct kind of cue, and turning the setting off silences it.
- [ ] Ads are not described.
- [ ] Nothing is spoken twice (live region and built-in voice must not both be active).

**Describe now, repeat, ask**
- [ ] `Alt+Shift+S` speaks at once, even if the screen reader was mid-sentence.
- [ ] `Alt+Shift+L` repeats the last description.
- [ ] `Alt+Shift+Q` opens the dialog with focus in the text field; typing letters does not trigger YouTube shortcuts; Enter sends; the answer is read; Escape returns focus to where it was and playback resumes.

**Shorts and fullscreen**
- [ ] Shorts are described, and a looping Short describes again from the start.
- [ ] In fullscreen, the ask dialog is reachable and visible.

**Popup**
- [ ] Every control is reachable with Tab; status is announced when it changes.

## Reporting bugs

Please include: browser and version, screen reader and version, the video (or a similar public one), what you pressed, what you heard, and what you expected to hear.
