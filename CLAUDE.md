# SceneVoice — notes for Claude Code

The owner (Reddy, GitHub `reddynb666`) prefers replies in Chinese (简体中文). Code, comments and commit messages stay in English.

## What this is

A Chrome / Edge extension (Manifest V3) that adds AI audio description (口述影像) to YouTube and Bilibili videos for blind and low-vision viewers, using the user's own API key: Gemini for YouTube, Qwen (Alibaba Cloud Model Studio / DashScope) for the China build. Screen-reader first: every state is announced through ARIA live regions, every control works from the keyboard. Open source, MIT. See `README.md` / `README.zh-CN.md` for the full picture and roadmap.

## Where things are

- Work happens in the checkout you are in; do not touch the other `scenevoice-*` folders next to it. The repository is github.com/reddynb666/scenevoice.
- `docs/plan-2026-11.zh-CN.md` is the current plan (diagnosis, business model, sprints). The older product blueprint (`SceneVoice-产品蓝图.md`, items A1…H10, kept outside the repository) is done except where the plan says otherwise.

## Layout

- `src/content/` — content script: `platforms.js` picks the site; `youtube.js` and `bilibili.js` are the site adapters; `index.js` playback tracking; `announcer.js` live regions; `ui.js` player button / progress / overlay / ask dialog; `frames.js` frame capture; `generator.js` messages to start/stop/ask.
- `src/background/index.js` — service worker: TTS, keyboard commands, popup status, cache, hub for generation jobs (starts them in the offscreen document, saves each finished section, broadcasts `sv:gen-event`).
- `src/offscreen/` — offscreen document + worker where model requests actually run. **Never move model calls into the content script or the service worker**: Chrome kills a service worker when a fetch takes > 30 s, and YouTube's Connection-Allowlist policy can block requests made from its page.
- `src/shared/` — `providers.js` (Gemini vs Qwen vs Cloud, and which key actually describes a site), `gemini.js`, `qwen.js`, `cloud.js` (the relay's own routes: device token, allowance, licence, what of a script may be shared), `usage.js` (daily counter, prices, daily limit), `language.js` (which codes can be description languages), `generation.js` (section loop, resume, fallback), `script.js` (parsing, density filter, room in a pause), `scheduler.js` (what may interrupt what), `dialogue.js` (caption gaps), `onscreen.js`, `videotype.js`, `labels.js` (one label per person), `revision.js` (“last description is wrong”), `ask.js`, `progress.js`, `settings.js`, `voices.js`, `errors.js`, `constants.js`, etc.
- `src/popup/`, `src/options/`, `src/transcript/`, `src/guide/` (API-key guide), `src/welcome/` (first run: hear a sample, Start free or own key) — extension pages.
- `scripts/locales/<lang>.mjs` — **every user-facing string**, one file per interface language; `en.mjs` is the reference and `zh_CN.mjs` must be complete (the build fails on a missing key); other languages may be partial and fall back to English. `scripts/locales.mjs` gathers them. `scripts/build.mjs` bundles with esbuild into `dist/`.
- `test/*.test.js` — vitest. `test/e2e/e2e.py` — Playwright (Python) end-to-end: real extension in headless Chromium, fake YouTube/Bilibili pages, mock model served over TLS on loopback, axe checks.
- `docs/store-listing.md`, `docs/distribution-china.md`, `docs/release.md`, `docs/store/` (screenshots) — Chrome Web Store / Edge Add-ons / Gitee drafts and how a release is cut.
- `server/` — SceneVoice Cloud relay, a Cloudflare Worker (protocol v1 in its README; own tests under `server/test/`). Not deployed; needs the owner's domain, Cloudflare and Stripe accounts.
- `site/` — the project website (English + Simplified Chinese, no build step); `site/check.mjs` is its accessibility gate; `.github/workflows/pages.yml` publishes it.

## Commands

```
npm install
npm run build        # -> dist/
npm run dev          # rebuild on change
npm test             # vitest
npm run test:e2e     # needs: pip install playwright && playwright install chromium; openssl on PATH
npm run package      # dist + scenevoice-<version>.zip (+ sourcemaps zip)
npm run release -- x.y.z   # cut CHANGELOG, set version, test, build, commit + tag locally
node site/check.mjs  # website accessibility check
```

To try a build in Chrome: load `dist/` from this folder as the unpacked extension (chrome://extensions → Developer mode → Load unpacked), then after each `npm run build` press reload there and refresh the video tab. (The old `../scenevoice-1.0.0/` copy is the 1.0.0 release build, YouTube only.)

## Rules

- Accessibility first: anything visual must also be announced; status goes through `announcer.status` and must not interrupt a description being read; the screen reader and the built-in voice never speak at once; the ask dialog traps focus and typing in it never triggers site shortcuts.
- All user-facing text in `scripts/locales/en.mjs` and `scripts/locales/zh_CN.mjs` (and the other languages where you can).
- No new permissions, no analytics, no network requests other than Gemini / DashScope / the SceneVoice Cloud relay (`api.scenevoice.app`, only after *Start free*). Any permission needs a justification in `PRIVACY.md` and `docs/store-listing.md`.
- API keys and the Cloud device token travel only in headers (`x-goog-api-key` for Gemini and the relay, `Authorization: Bearer` for Qwen), never in a URL, and never enter the web page. The own-key path is never degraded in favour of Cloud.
- Bilibili: read only data the page already has (`window.__INITIAL_STATE__`, the subtitle file the player loads). Do not call Bilibili's undocumented APIs.
- Keep both READMEs, `PRIVACY.md` and `CHANGELOG.md` in step with behaviour changes.
- Add vitest tests; run `npm test` and `npm run build` (and the e2e suite when UI changes) before saying something is done. Fix the suite rather than skipping checks.
- Commit locally on this branch; **do not push, publish, or submit to a store without the owner saying yes.**
- When reporting back: whether it already met the requirement, the root cause, which files changed, and how the owner can check it by hand.

## Open items

- Nobody has tested with a real screen reader (NVDA / JAWS / VoiceOver) yet; `CONTRIBUTING.md` has the checklist. Recruiting blind testers is next on the roadmap.
- Qwen path needs a run with a real DashScope key (blueprint E1).
- Not yet on the Chrome Web Store / Edge Add-ons. The release pipeline (`docs/release.md`) is ready but needs the store accounts and secrets.
- SceneVoice Cloud is not deployed: the extension's *Start free* fails plainly until `server/` runs under the owner's domain; the site's store links and contact address are `FILL IN` placeholders.
- Microsoft AI for Accessibility grant deadline 2026-12-31 (blueprint G5) — verify on Microsoft's site.
