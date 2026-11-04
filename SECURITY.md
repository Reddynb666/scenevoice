# Security

SceneVoice is a browser extension that holds the user's own API keys and
spends their money on model requests. Anything that could leak a key, make
requests the user did not ask for, or let a web page drive the extension is a
security problem. Please report it privately.

## Reporting

- Email: **security@scenevoice.example** (placeholder until the owner sets up
  an address; until then use GitHub's private reporting below).
- Or open a private report at
  https://github.com/reddynb666/scenevoice/security/advisories/new
  (*Security → Report a vulnerability*).
- Please do not open a public issue for a security problem.

You will get an answer within 7 days. Fixes ship as a normal release
(`CHANGELOG.md` names the problem once it is fixed) and you are credited
unless you prefer not to be. There is no bounty programme.

Reports in Chinese are welcome（可以用中文报告）.

## Scope

In scope: everything in this repository that ships in the extension package
(`src/`, `static/`, the build in `scripts/build.mjs`) and the release
workflows. Out of scope: the Gemini, DashScope and Bilibili / YouTube
services themselves, the browser, and a user's own relay they typed under
*Advanced → API address*. Social engineering of the owner is not a finding.

Examples of what counts:

- an API key reaching a web page, a URL, a log, the sync storage, or any host
  other than the one the user chose;
- a web page (YouTube, Bilibili, an embedded player, or any other) starting,
  stopping or reading description jobs, or reading cached descriptions;
- model requests made without the user's action and outside the limits below;
- code loaded from outside the package, or an injected script running in the
  page's own world;
- a prompt-injection path from a video's title, description or captions into
  something other than the description text (for example a request to another
  host).

## Security model (from the 2026-11 audit)

- **Keys live only in `chrome.storage.local`**, behind
  `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, set again on every
  service-worker start. Content scripts cannot read that area; they ask the
  service worker for a description script by message. Nothing secret goes to
  `storage.sync`.
- **Keys travel only in request headers** (`x-goog-api-key` for Gemini,
  `Authorization: Bearer` for Qwen and the SceneVoice Cloud device token),
  never in a URL, and never enter a web page.
- **All model requests are made by the offscreen document's worker**, from an
  extension origin. The content script never calls a model; the service
  worker never does either (Chrome stops it after 30 s). `host_permissions`
  name only the two model hosts; any other address needs the user to type it
  and grant an optional host permission for that single origin.
- **The content script runs in the isolated world** and injects no script into
  the page. There is no `externally_connectable` and no
  `web_accessible_resources`, so pages cannot message the extension or load
  its files. The manifest holds no remote code.
- **Every message checks its sender** against an allowlist per message type
  (`src/shared/sender.js`): job events only from the offscreen document,
  worker commands only from the service worker, tab actions that spend quota
  or read the cache only from a content script of a supported site whose
  frame origin matches its URL. `test/security.test.js` covers the
  classification, the allowlists and that the listeners are wired to them.
- **Spending limits**: embedded players that were never played do not start
  generation; the service worker takes jobs only for the sender's own site, in
  a supported language, no longer than 12 hours; at most two jobs run at once;
  a tab may send at most 30 picture requests a minute. Model timeouts stop a
  hung worker from holding a job open.
- **Bilibili**: the extension reads only data the page already has
  (`window.__INITIAL_STATE__`, the subtitle file the player loads) and calls no
  Bilibili API.
- **No analytics, no telemetry, no server of the developer's** on the
  bring-your-own-key path; what the optional SceneVoice Cloud relay receives
  is listed in `PRIVACY.md`.

## Supply chain

- The extension has no runtime dependencies; `package.json` lists only build
  and test tools, locked by `package-lock.json` and updated by Dependabot.
- GitHub Actions are pinned to commit SHAs; the CI and release jobs run with
  `contents: read` (the release job alone may write a GitHub Release).
- Every release carries `SHA256SUMS`; see `docs/release.md`.
