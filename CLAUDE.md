# SceneVoice — notes for Claude Code

The owner (Reddy, GitHub `reddynb666`) prefers replies in Chinese (简体中文). Code, comments and commit messages stay in English.

## What this is

A Chrome / Edge extension (Manifest V3) that adds AI audio description (口述影像) to YouTube and Bilibili videos for blind and low-vision viewers, using the user's own API key: Gemini for YouTube, Qwen (Alibaba Cloud Model Studio / DashScope) for the China build. SceneVoice Cloud, a relay for people without a key, is written but switched off (`CLOUD_OPEN` in `src/shared/constants.js`). Screen-reader first: every state is announced through ARIA live regions, every control works from the keyboard. Open source, MIT. See `README.md` / `README.zh-CN.md` for the full picture and roadmap.

## Where things are

- Work happens in the checkout you are in; do not touch the other `scenevoice-*` folders next to it. The repository is github.com/reddynb666/scenevoice.
- `docs/plan-2026-11.zh-CN.md` is the plan for the extension and the web player (diagnosis, business model, sprints). `docs/store-submission.zh-CN.md` is the owner's step-by-step checklist for the two stores; `docs/tester-guide.zh-CN.md` is the public guide for screen reader testers in China. `docs/plan-film-2026-11.zh-CN.md` is the plan for the film desktop app (SceneVoice 影院版): kill tests K1–K11, gates G0/G1/G3, milestones M0–M6. The older product blueprint (`SceneVoice-产品蓝图.md`, items A1…H10, kept outside the repository) is done except where the plan says otherwise.

## Layout

- `src/content/` — content script: `platforms.js` picks the site; `youtube.js` and `bilibili.js` are the site adapters; `index.js` playback tracking; `announcer.js` live regions; `ui.js` player button / progress / overlay / ask dialog; `frames.js` frame capture; `generator.js` messages to start/stop/ask.
- `src/background/index.js` — service worker: TTS, keyboard commands, popup status, cache, hub for generation jobs (starts them in the offscreen document, saves each finished section, broadcasts `sv:gen-event`).
- `src/offscreen/` — offscreen document + worker where model requests actually run. **Never move model calls into the content script or the service worker**: Chrome kills a service worker when a fetch takes > 30 s, and YouTube's Connection-Allowlist policy can block requests made from its page.
- `src/shared/` — `providers.js` (Gemini vs Qwen vs Cloud, and which key actually describes a site), `gemini.js`, `qwen.js`, `cloud.js` (the relay's own routes: device token, allowance, licence, what of a script may be shared), `usage.js` (daily counter, prices, daily limit), `language.js` (which codes can be description languages), `generation.js` (section loop, resume, fallback), `script.js` (parsing, density filter, room in a pause), `scheduler.js` (what may interrupt what), `dialogue.js` (caption gaps), `onscreen.js`, `videotype.js`, `labels.js` (the words for setting values; people and their labels are in the `gemini.js` prompts and in `normalizeChunk` / `mergeScript` of `script.js`), `revision.js` (“last description is wrong”), `ask.js`, `progress.js`, `settings.js`, `voices.js`, `errors.js`, `constants.js` (among them `CLOUD_OPEN`, the one switch for SceneVoice Cloud, off; and `CLOUD_API_BASE`, the relay's address, a placeholder on `.invalid` until the owner holds a domain), `modelhealth.js` (models overloaded or slow just now, skipped by the next choice; memory only), `shortcuts.js` (keyboard layer: Chrome syntax and Mac symbols, matching by physical key, Chrome key wins over page key, conflicts, the `pageShortcuts` setting; the page-level listener itself is in `src/content/index.js`), etc.
- `src/film/` — the film engine for the desktop app: pure ES modules, no dependencies, contracts in `src/film/README.md`. `types.js` (the character token `{P3}`, naming levels, shapes), `cast.js` (characters, evidence, levels, outfits), `namegate.js` (tokens into a label, an introduction or the name), `verify.js` (what the picture supports), `filmscript.js`, `timeline.js` (pauses and budgets), `subs.js` (SRT/ASS/WebVTT), `identity.js` (hand labels, face clusters, or no faces), `marks.js` (numbered boxes and the legend), `prompts.js`, `models/` (capability table, routing, wire). Nothing in `src/shared`, the extension or the web player changes for it.
- `src/popup/`, `src/options/`, `src/transcript/`, `src/guide/` (API-key guide), `src/welcome/` (first run: hear a sample, add a key of your own, try a video; the *Start free* path is in the page and taken out while `CLOUD_OPEN` is false) — extension pages.
- `src/web/` — the web player (no `chrome.*` API; the build fails if one gets in): `player.js` entry, `app.js` page, `link.js` YouTube link parsing, `youtube.js` IFrame player, `playback.js` cue scheduling, `output.js` / `speech.js` live region or Web Speech, `keys.js` single-key layer, `model.js` Gemini or relay, `store.js` browser storage, `i18n.js` (English and Simplified Chinese from `scripts/locales/`, aliased in place of `shared/i18n.js`). `npm run build:web` writes `site/play/player.js` (git-ignored; the Pages workflow builds it).
- `scripts/locales/<lang>.mjs` — **every user-facing string**, one file per interface language; `en.mjs` is the reference and `zh_CN.mjs` must be complete (the build fails on a missing key); other languages may be partial and fall back to English. `scripts/locales.mjs` gathers them. `scripts/build.mjs` bundles with esbuild into `dist/`. `scripts/manifest.mjs` makes the built manifest from `static/manifest.json` (the version, and the relay's host permission only while `CLOUD_OPEN` is true) and holds the rule that ties the relay's address to the switch; the build refuses an address that does not fit.
- `test/*.test.js` — vitest (`test/cloud-closed.test.js`: what Cloud being off means; `test/no-foreign-domain.test.js`: no domain the owner does not hold, anywhere). `test/e2e/e2e.py` — Playwright (Python) end-to-end: real extension in headless Chromium, fake YouTube/Bilibili pages, mock model served over TLS on loopback, axe checks.
- `docs/store-listing.md`, `docs/distribution-china.md`, `docs/release.md`, `docs/store/` (screenshots) — Chrome Web Store / Edge Add-ons / Gitee drafts and how a release is cut.
- `server/` — SceneVoice Cloud relay, a Cloudflare Worker (protocol v1 in its README; own tests under `server/test/`). Not deployed; needs a domain the owner holds (its `wrangler.toml` carries placeholders on `.invalid` until then), Cloudflare and Stripe accounts.
- `site/` — the project website (English + Simplified Chinese; the home pages need no build step); `site/play/` is the web player page (`index.html`, `play.css`, built `player.js`); `site/check.mjs` is the accessibility gate for all three pages; `.github/workflows/pages.yml` builds the player and publishes the site.

## Commands

```
npm install
npm run build        # -> dist/
npm run dev          # rebuild on change
npm test             # vitest
npm run test:e2e     # needs: pip install playwright && playwright install chromium; openssl on PATH
npm run package      # dist + scenevoice-<version>.zip (+ sourcemaps zip)
npm run release -- x.y.z   # cut CHANGELOG, set version, test, build, commit + tag locally
npm run build:web    # web player bundle -> site/play/player.js (git-ignored)
node site/check.mjs  # website accessibility check (home pages + web player page)
```

To try a build in Chrome: load `dist/` from this folder as the unpacked extension (chrome://extensions → Developer mode → Load unpacked), then after each `npm run build` press reload there and refresh the video tab. (The old `../scenevoice-1.0.0/` copy is the 1.0.0 release build, YouTube only.)

## Rules

- Accessibility first: anything visual must also be announced; status goes through `announcer.status` and must not interrupt a description being read; the screen reader and the built-in voice never speak at once; the ask dialog traps focus and typing in it never triggers site shortcuts.
- All user-facing text in `scripts/locales/en.mjs` and `scripts/locales/zh_CN.mjs` (and the other languages where you can).
- No new permissions, no analytics, no network requests other than Gemini and DashScope. The SceneVoice Cloud relay becomes a third destination only once `CLOUD_OPEN` is on and `CLOUD_API_BASE` is an address on a domain the owner holds, and then only after the user presses *Start free*; today the switch is off and nothing may offer the relay or contact it. Any permission needs a justification in `PRIVACY.md` and `docs/store-listing.md`.
- Never put a domain the owner does not hold into code, a manifest, a content-security policy, a relay configuration (`server/wrangler.toml`) or a document that presents it as ours. Version 1.1.0 named one as the relay (`SECURITY.md`, *The relay address in version 1.1.0*). A host that is needed before the owner has registered it is written as a placeholder on `.invalid`; `test/no-foreign-domain.test.js` enforces this.
- API keys and the Cloud device token travel only in headers (`x-goog-api-key` for Gemini and the relay, `Authorization: Bearer` for Qwen), never in a URL, and never enter the web page. The own-key path is never degraded in favour of Cloud.
- Bilibili: read only data the page already has (`window.__INITIAL_STATE__`, the subtitle file the player loads). Do not call Bilibili's undocumented APIs.
- Keep both READMEs, `PRIVACY.md` and `CHANGELOG.md` in step with behaviour changes.
- Add vitest tests; run `npm test` and `npm run build` (and the e2e suite when UI changes) before saying something is done. Fix the suite rather than skipping checks.
- Commit locally on this branch; **do not push, publish, or submit to a store without the owner saying yes.**
- When reporting back: whether it already met the requirement, the root cause, which files changed, and how the owner can check it by hand.

## Rules for the film product

- `src/film` stays pure: relative imports into `src/film` and the pure part of `src/shared` only; no `chrome`, `document`, `window`, `navigator`, `node:`, Electron or packages; no translation lookups (the extension build scans all of `src/`); no clocks, no randomness. `test/film-purity.test.js` enforces it.
- The extension's promises do not move: root `package.json` has no dependencies, nothing of `src/film`, `desktop/` or `tools/` is bundled into the extension or the web player, `SCRIPT_VERSION` stays 2. `test/extension-promises.test.js` enforces it. The desktop app has its own package, strings (`desktop/locales`, not `scripts/locales`), privacy text and `desktop-v*` tags.
- The model never writes a name: it writes a token, and the name gate fills it. A face match (clusters, or reference photos of the leads) may propose a name; it is spoken only after a person confirms it or the film's own dialogue agrees. No cloud model is ever asked who a person is. Cast lists are text from licensed sources (Wikidata, pasted by the user, the end credits); reference photos are freely licensed or the user's own. Face data stays on the computer, per film, outside the project folder, and is never exported.
- By default only a name a person has confirmed is spoken. A wrong name is worse than a label: when unsure, the label.
- Numbers marked 待测 in the plan are hypotheses until a kill test reports them (`docs/film/killtests/`).

## Open items

- **Priority (owner, 2026-11-15): the extension first.** Store listing and testing with real screen-reader users come before the film app. The film app (`docs/plan-film-2026-11.zh-CN.md`) continues only through its kill tests (M0) and one audible sample (M1); do not start its M2 or later without the owner saying so.

- Nobody has tested with a real screen reader (NVDA / JAWS / VoiceOver) yet; `CONTRIBUTING.md` has the checklist. Recruiting blind testers is next on the roadmap.
- Qwen path needs a run with a real DashScope key (blueprint E1).
- Not yet on the Chrome Web Store / Edge Add-ons. The release pipeline (`docs/release.md`) is ready but needs the store accounts and secrets.
- SceneVoice Cloud is switched off: nothing offers it, nothing is sent to it, and the package asks for no relay host. It opens only when `server/` runs under a domain the owner holds (none is registered yet) and `CLOUD_OPEN` and `CLOUD_API_BASE` are changed together. The site's store links and contact address, and the testers' contact in `docs/tester-guide.zh-CN.md`, are `FILL IN` placeholders.
- Version 1.1.0 on GitHub Releases still offers *Start free*, pointing at a domain that was never the project's. The site and the READMEs say not to install it; once 1.2.0 is out the owner withdraws the 1.1.0 zip (`docs/store-submission.zh-CN.md`, step 5).
- Microsoft AI for Accessibility grant deadline 2026-12-31 (blueprint G5) — verify on Microsoft's site.
