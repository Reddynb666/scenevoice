# SceneVoice privacy policy

Last updated: 29 October 2026

SceneVoice is a browser extension that creates audio description for YouTube videos. It is designed so that the developer never sees your data.

## What SceneVoice does not do

- It has no server of its own. Nothing you do is sent to the developer.
- It has no accounts, sign-ins or subscriptions.
- It does not collect analytics, usage statistics, crash reports or identifiers.
- It does not read, record or upload the video or audio stream.

## What leaves your computer, and where it goes

When you ask SceneVoice to describe a video, or ask a question about a moment in it, the extension sends a request to the Google Gemini API (`https://generativelanguage.googleapis.com`) containing:

- the address of the YouTube video (which Gemini uses to read the public video itself),
- the video's title, channel name and description as shown on the page,
- the section of the video to describe (start and end time) or the time you asked about,
- your typed question, if you asked one, and the descriptions already made for the moments just before it,
- your Gemini API key, in a request header.

Google processes this under the [Gemini API Terms of Service](https://ai.google.dev/gemini-api/terms) and Google's privacy policy. Depending on your Google account and plan, Google may use requests on the free tier to improve its products; see Google's terms for details.

If you change the API address in Advanced settings to a relay service, the same data is sent to that service instead, and the extension asks your permission for that address first. The relay can see your key and requests; only use a relay you trust.

On a YouTube video page, SceneVoice also asks YouTube itself for that video's caption timing and category (the watch page and its caption file), the same way the YouTube player does when you turn on captions. These requests go only to YouTube, from the YouTube page you are already on, and contain nothing but the video's address. The timing is used to fit descriptions between lines of dialogue, and the category (for example "Education" or "Music") to choose the mode and detail for the kind of video; neither is stored or sent anywhere else.

No other network requests are made.

## What is stored on your computer

- **Your API key**, in the browser's local extension storage (`chrome.storage.local`). It never leaves your computer except as described above, and it is never placed in a URL. Remove it at any time on the settings page.
- **Descriptions** that have been generated, keyed by video and language, so a video is described only once, with the kind of video Gemini judged it to be (entertainment or tutorial). The settings page shows how many are stored and lets you delete them all. The oldest are removed automatically after 300 videos.
- **Settings** such as mode, detail level (and whether you picked them yourself), the mode and detail for each kind of video, language and the built-in voice you chose for each language. These do not include the key. If browser sync is on, settings sync to your other browsers through your browser account.

Nothing is stored anywhere else.

## Permissions the extension asks for

- **Read and change data on youtube.com** — to follow the video's playback, read its caption timing, and show the player button, overlay and question dialog.
- **generativelanguage.googleapis.com** — to call the Gemini API.
- **Storage** — to keep your key, settings and generated descriptions on your computer.
- **Text-to-speech** — for the optional built-in voice.
- **Active tab** — so the toolbar popup can tell whether the current tab is a YouTube video.
- **Offscreen document** — a hidden extension page in which the requests to the Gemini API run. They are made from there rather than from the YouTube page, so your API key never enters the YouTube page and the requests are not subject to YouTube's own page policies.
- **Optional: other websites** — requested only if you enter a custom API address, and only for that address.

## Children

SceneVoice is not directed at children and collects no personal information from anyone.

## Changes

If this policy changes, the new version will be published with the extension and in the project repository, with the date above updated.

## Contact

Questions about privacy can be raised as an issue in the project's GitHub repository.
