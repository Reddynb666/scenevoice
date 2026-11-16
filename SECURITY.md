# Security

SceneVoice is a browser extension that holds the user's own API keys and
spends their money on model requests. Anything that could leak a key, make
requests the user did not ask for, or let a web page drive the extension is a
security problem. Please report it privately.

## Reporting

- Open a private report with GitHub's private vulnerability reporting:
  https://github.com/reddynb666/scenevoice/security/advisories/new
  (on the repository page: *Security → Report a vulnerability*). Only the
  maintainers see it.
- Please do not open a public issue for a security problem.

<!-- FILL IN (owner): once there is a real security or support e-mail address,
     add it here as a second way to report. Never publish a made-up address. -->

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
  `Authorization: Bearer` for Qwen), never in a URL, and never enter a web
  page. The SceneVoice Cloud device token will travel the same way
  (`x-goog-api-key`) once Cloud opens.
- **All model requests are made by the offscreen document's worker**, from an
  extension origin. The content script never calls a model; the service
  worker never does either (Chrome stops it after 30 s). `host_permissions`
  name only the two model hosts; any other address needs the user to type it
  and grant an optional host permission for that single origin.
- **SceneVoice Cloud is closed behind one switch**, `CLOUD_OPEN` in
  `src/shared/constants.js`, which is `false`. While it is, nothing offers
  the relay, no request to it is made (every relay route goes through
  `cloudRequest()` in `src/shared/cloud.js`, which refuses; the service
  worker gives no config that names the relay and counts a saved device
  token as no key; the offscreen worker refuses Cloud commands), and the
  built manifest does not ask for its host: `scripts/manifest.mjs` adds the
  relay's host to `host_permissions` only when the switch is on.
  `test/cloud-closed.test.js` checks both states. A build with the switch
  forced on (`SCENEVOICE_CLOUD_OPEN=1`) exists for the end-to-end suite only
  and cannot be packaged.
- **No address the project does not hold.** While Cloud is closed, the
  relay's address in the code (`CLOUD_API_BASE`) is a placeholder on the
  reserved `.invalid` top-level domain, which can never resolve, and the build
  refuses any other value; the relay's own configuration
  (`server/wrangler.toml`) carries placeholders of the same kind. A real
  address goes in only with the change that opens Cloud, and only on a domain
  the owner holds. `test/no-foreign-domain.test.js` keeps this so (see *The
  relay address in version 1.1.0* below for why).
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
- **No analytics, no telemetry, no server of the developer's**: this version
  works with the user's own key only. What the SceneVoice Cloud relay will
  receive when it opens is listed in `PRIVACY.md`, in a section marked as
  not applying yet.

## The relay address in version 1.1.0

Found on 16 November 2026. Fixed in the version after 1.1.0.

- **What was wrong.** Version 1.1.0 (4 November 2026), and the web player as
  it was published before this fix, offered *Start free* (SceneVoice Cloud),
  which sent its requests to `api.scenevoice.app`. That domain was never the
  project's: the relay was never deployed, the address was written into the
  code without the project holding the domain, and the domain is registered
  to someone else.
- **What is known.** When this was found the address did not resolve, so
  *Start free* could only fail, and no request is known to have been
  answered. Whoever holds the domain could change that. From then on, a copy
  of 1.1.0 in which *Start free* is pressed, or the old web player with
  *SceneVoice Cloud* chosen, would send that party the video's address,
  title, uploader and description, the questions typed and, on Bilibili,
  pictures of the video; with sharing on (*Start free* turned it on),
  finished descriptions too; and would read out whatever came back as
  descriptions. In 1.1.0 the *Activate* button for a licence key registered
  at the same address before sending the key. Your own Gemini or Qwen key
  was never sent there: Cloud requests carried only the device token.
- **What to do.** If you installed 1.1.0, update to a later version; an
  extension loaded from a zip does not update by itself. Until you have, do
  not press *Start free* or *Activate*. If *Start free* ever succeeded for you (it said that
  SceneVoice Cloud is ready), press *Stop using Cloud* on the settings page
  and tell us through the private report above. The web player needs no
  update: the page you open is always the current one.
- **What the fixed version does.** SceneVoice Cloud is not offered anywhere.
  The package asks for no permission for a relay address and makes no request
  to one, and the address left in the code is a placeholder that cannot
  resolve. A device token left by 1.1.0 is never used and is removed when the
  extension updates, together with a site left set to Cloud and the sharing
  switch; if a token is still there, the settings page offers *Stop using
  Cloud* to remove it. The web player offers your own key
  only, and its Content-Security-Policy lets the page's own requests go to
  Google's Gemini API and to no other address.
- **What stays in force.** No domain the project does not hold is written
  into the code, a manifest, a content-security policy, the relay's
  configuration, or a document that presents it as the project's. When
  SceneVoice Cloud opens, its address will be on a domain the project holds,
  and `PRIVACY.md` will name it before any build uses it.

## Supply chain

- The extension has no runtime dependencies; `package.json` lists only build
  and test tools, locked by `package-lock.json` and updated by Dependabot.
- GitHub Actions are pinned to commit SHAs in every workflow (CI, release and
  Pages; `test/workflows.test.js` fails on a floating tag); the CI and release
  jobs run with `contents: read` (the release job alone may write a GitHub
  Release).
- The store credentials (Chrome Web Store refresh token, Edge API key) are
  step-scoped in the release workflow: only the two upload steps and the step
  that checks they are set see them, never `npm ci`, `pip`, the end-to-end
  suite or a third-party action.
- Every release carries `SHA256SUMS`; see `docs/release.md`.
