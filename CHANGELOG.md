# Changelog

## Unreleased

- Descriptions no longer talk over dialogue. When the video has captions, their timing corrects the pauses the model estimated, and a description that starts at the tail of a sentence waits for it to end.
- In *Keep playing* mode a description that does not fit is now skipped, even an important one (previously its brief version was spoken anyway). In *Pause the video* mode it pauses the video instead.
- Built-in voice: pitch can now be set alongside voice and speaking rate. Voices for the description language are listed first (Chinese voices for Chinese descriptions), with their language spelled out, and each description language remembers its own voice. *Test voice* reads a sentence in the description language rather than the interface language. A synced voice that this computer does not have is replaced by an automatic voice for the description language.
- The popup has a speed control (built-in voice rate, or screen reader speed) next to detail and mode, a *Test voice* button, and names the shortcuts for these settings.
- New *Speak faster* and *Speak slower* shortcuts (unset by default, as Chrome allows only four suggested keys). Shortcuts that change a setting say the new value, and say so if it could not be saved.
- *Restore default settings* on the settings page. It keeps the API key, model, saved descriptions and keyboard shortcuts.
- Sliders are read out as values ("1.2×", "35%", "Normal") and are tied to their labels; the volume slider used to be read as "0.35", and the label around the rate and volume sliders belonged to the value shown next to them rather than to the slider.
- Settings are checked when read, so a bad or out-of-range value synced from another browser falls back to its default. Two quick changes on the same page no longer overwrite each other.

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
