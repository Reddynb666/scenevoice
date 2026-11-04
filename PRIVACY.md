# SceneVoice privacy policy

Last updated: 4 November 2026

SceneVoice is a browser extension that creates audio description for YouTube videos and, experimentally, Bilibili videos. With your own API key it is designed so that the developer never sees your data; the optional SceneVoice Cloud relay is described below.

## What SceneVoice does not do

- With your own API key, SceneVoice has no server of its own and nothing you do is sent to the developer. The optional SceneVoice Cloud relay, which you turn on yourself with *Start free*, is the one exception; see *SceneVoice Cloud* below.
- It has no accounts or sign-ins. SceneVoice Cloud uses an anonymous device token; an optional paid Plus or organisation licence key can be attached to it (see *Licences* below).
- It does not collect analytics, usage statistics or crash reports. The only identifier is the random SceneVoice Cloud device token, which exists only after you press *Start free* and is removed by *Stop using Cloud*.
- It does not read, record or upload the video or audio stream.

## What leaves your computer, and where it goes

When you ask SceneVoice to describe a video, ask a question about a moment in it, or describe again a moment whose description you marked as wrong, the extension sends a request to the Google Gemini API (`https://generativelanguage.googleapis.com`) containing:

- the address of the YouTube video (which Gemini uses to read the public video itself),
- the video's title, channel name and description as shown on the page,
- the section of the video to describe (start and end time) or the time you asked about,
- your typed question, if you asked one, with the descriptions already made for the moments just before it, the labels the descriptions use for people (such as "the woman in red"), and your last three questions about the same video with their answers (kept in the tab's memory only, so that a follow-up question is understood),
- when you mark a description as wrong, that description, so that Gemini does not simply repeat it,
- your Gemini API key, in the `x-goog-api-key` request header (never in the address).


Google processes this under the [Gemini API Terms of Service](https://ai.google.dev/gemini-api/terms) and Google's privacy policy. Depending on your Google account and plan, Google may use requests on the free tier to improve its products; see Google's terms for details.

If you change the API address in Advanced settings to a relay service, the same data is sent to that service instead, and the extension asks your permission for that address first. The relay can see your key and requests; only use a relay you trust.

On a YouTube video page, SceneVoice also asks YouTube itself for that video's caption timing and category (the watch page and its caption file), the same way the YouTube player does when you turn on captions. These requests go only to YouTube, from the YouTube page you are already on, and contain nothing but the video's address. The timing is used to fit descriptions between lines of dialogue, and the category (for example "Education" or "Music") to choose the mode and detail for the kind of video; neither is stored or sent anywhere else.

### Qwen, and Bilibili

Qwen cannot open a video by its address, and Gemini cannot open Bilibili's. With Qwen (on either site), or with any model on Bilibili, SceneVoice instead takes a scaled-down picture (at most 640 pixels wide, JPEG) of the video playing in your tab every 2 seconds while descriptions are being made, and sends up to 6 at a time, with the title, uploader and description, to the model you chose for that site. Asking a question sends up to 6 pictures of the last 20 seconds, with the same question context as above; marking a description as wrong sends a few pictures of that moment. With Qwen, the request goes to Alibaba Cloud Model Studio (`https://dashscope.aliyuncs.com`, or the address you set) with your Qwen API key in the `Authorization: Bearer` request header (the form its OpenAI-compatible API requires; never in the address), under Alibaba Cloud's terms. What reaches Alibaba Cloud is the pictures and the text listed above, never the video file or its sound. Using a Qwen key with Alibaba Cloud's mainland China address keeps these requests inside mainland China. The pictures are kept in the tab's memory for a minute or two (to answer a question about the moment) and are never saved.

On a Bilibili video page, SceneVoice reads the video's title, uploader, description, section and parts from the page itself (the data the page is delivered with), and calls none of Bilibili's APIs. When you turn on CC subtitles in the player, SceneVoice fetches the same subtitle file the player has just loaded, from Bilibili's file servers (`*.hdslb.com`), to fit descriptions between lines of dialogue. Nothing from either is stored or sent elsewhere.

### SceneVoice Cloud (optional)

SceneVoice Cloud is for people who do not want to make an API key. It is off until you press **Start free** on the welcome page or the settings page, and users with their own key send nothing to SceneVoice.

- **What the relay receives.** The same request Google would receive (see above: the video's address, title, channel and description, the section to describe, your question, the recent descriptions; on Bilibili, the scaled-down pictures), sent to `https://api.scenevoice.app` instead, with an anonymous device token in place of your key. The relay forwards it to the Gemini API with the project's own key and passes the answer back. It does not log the request or the answer.
- **The device token** is a random string issued when you press *Start free*. It is not tied to an account, an email address or a name, and nothing else identifies you. The relay keeps, per token, how many seconds of video were described today (the free allowance) and which plan the token is on. Remove the token at any time with *Stop using Cloud* on the settings page; a new *Start free* issues a new one.
- **Finished descriptions, when sharing is on.** With *Share finished descriptions with other SceneVoice users* turned on (it is turned on when you press *Start free*; turn it off on the settings page), the text of a video's descriptions is sent to the relay once they are complete: the video ID, language, length, the descriptions with their timing, the labels used for people, the kind of video and the model. The relay keeps this text so the next listener of the same video gets it at once. It does not keep who sent it, and SceneVoice strips the descriptions you marked as wrong before sending.
- **What the relay never keeps:** pictures of the video, your questions, the model's answers to them, your IP address (a salted hash of it is used only to limit how many tokens one network can create in a day), or anything about your browser.
- **Licences.** If you activate a Plus or organisation licence key, the relay stores which key is attached to your token. Payment, where there is any, is handled by Stripe or the platform you paid on; the relay sees only that a licence key exists.

The relay's own privacy addendum, with the data it stores and for how long, is in the project repository (`server/PRIVACY-ADDENDUM.md`).

No other network requests are made.

## What is stored on your computer

- **Your API keys** (Gemini, Qwen), with the model and address for each, and the SceneVoice Cloud device token if you have one (with its plan and model), in the browser's local extension storage (`chrome.storage.local`). They never leave your computer except as described above, and are never placed in a URL. Remove them at any time on the settings page.
- **Descriptions** that have been generated, keyed by video and language, so a video is described only once, with the kind of video Gemini judged it to be (entertainment or tutorial). The settings page shows how many are stored and lets you delete them all. The oldest are removed automatically after 300 videos.
- **Descriptions you marked as wrong**, with the time you marked them and what replaced them, next to the descriptions of that video, so that the corrected version is kept. They are never sent to the developer (there is no feedback server), are stripped before a video's descriptions are shared through SceneVoice Cloud, and are deleted with the descriptions of that video, including by *Delete all saved descriptions*. At most the last 50 per video are kept.
- **Settings** such as mode, detail level (and whether you picked them yourself), the mode and detail for each kind of video, the model for each site, language and the built-in voice you chose for each language, the daily limit, whether finished descriptions are shared with other SceneVoice users, and whether SceneVoice has already told you how to create descriptions. These do not include the key. If browser sync is on, settings sync to your other browsers through your browser account.
- **Usage counts** — the tokens and requests each model reports for the current day, with a rough cost estimate from list prices, and each video's own token count next to its descriptions — are kept on this computer only, so the settings page can show today's usage and the popup what a video cost; they are never sent anywhere.
- **Videos whose "AI-generated" notice you have heard**, only if you set that notice to once per video: the video IDs (YouTube's or Bilibili's), the last 300, in the same synced settings storage, so the notice is not repeated.

Nothing else is stored on your computer; what the SceneVoice Cloud relay keeps, if you use it, is listed above.

## Permissions the extension asks for

- **Read and change data on youtube.com** — to follow the video's playback, read its caption timing, and show the player button, overlay and question dialog.
- **Read and change data on www.bilibili.com/video/** — the same, on Bilibili video pages only (experimental).
- **generativelanguage.googleapis.com** — to call the Gemini API.
- **dashscope.aliyuncs.com** — to call the Qwen API (Alibaba Cloud Model Studio).
- **api.scenevoice.app** — SceneVoice Cloud, the optional relay above. Contacted only after you press *Start free*.
- **Storage** — to keep your key, settings and generated descriptions on your computer.
- **Text-to-speech** — for the optional built-in voice.
- **Active tab** — so the toolbar popup can tell whether the current tab is a video SceneVoice supports.
- **Offscreen document** — a hidden extension page in which the requests to the Gemini or Qwen API run. They are made from there rather than from the YouTube page, so your API key never enters the YouTube page and the requests are not subject to YouTube's own page policies.
- **Optional: other websites** — requested only if you enter a custom API address, and only for that address.

## Children

SceneVoice is not directed at children and collects no personal information from anyone.

## Changes

If this policy changes, the new version will be published with the extension and in the project repository, with the date above updated.

## Contact

Questions about privacy can be raised as an issue in the project's GitHub repository.
