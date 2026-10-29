# Changelog

## 1.0.0 — 2026-10-29

First release.

- On-demand AI audio description for any public YouTube video, using your own Gemini API key.
- Three playback modes (keep playing, pause the video, only when asked) and three detail levels.
- Descriptions are written in three lengths and chosen to fit the pause at your reading speed and playback rate.
- On-screen text read as its own kind of cue.
- Output through screen reader live regions (default) or the browser's built-in voices.
- Describe now, repeat last, and an ask-a-question dialog.
- Videos are described in five-minute sections with partial results available early; progress is saved and resumes. Generation runs in a worker inside the extension's offscreen document (not in the YouTube page, whose connection allowlist would otherwise be able to block it, and not in the service worker, which Chrome stops after a 30-second fetch); tabs showing the same video share one job, and the job carries on if the tab leaves the video.
- Overloaded or missing models: retries with increasing pauses, then the next best model takes over automatically.
- English and Simplified Chinese interface; descriptions in twelve languages.
- Large-text overlay, player button, keyboard shortcuts, dark mode.
- Progress is visible (player pill, popup bar with Stop) and audible: pressing the SceneVoice button or `Alt+Shift+D` while descriptions are being created announces the percentage, the section being worked on and the time left.
- A "how much to describe" setting (essentials / standard / everything) filters cues by importance without regenerating; a transcript page lists every description with its timestamp.
- No server, no account, no analytics.
