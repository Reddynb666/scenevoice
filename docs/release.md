# Releasing SceneVoice

How a version gets from this repository to GitHub Releases, the Chrome Web
Store, Edge Add-ons and the Gitee mirror. The owner decides when; nothing
below pushes or publishes by itself.

## 1. Cut the version locally

```
npm run release -- 1.1.0
```

`scripts/release.mjs` refuses to run on a dirty working tree or an existing
tag, then:

1. moves everything under `## Unreleased` in `CHANGELOG.md` into
   `## 1.1.0 — <today>` and leaves an empty `## Unreleased` on top;
2. sets `version` in `package.json` and `package-lock.json`;
3. runs `npm test` and `npm run build` (a failure leaves the edits in the tree
   and commits nothing);
4. commits `Release 1.1.0` and tags `v1.1.0` (an annotated tag).

Check `git show HEAD`, then push the commit and the tag:

```
git push --follow-tags
```

## 2. What the tag starts

`.github/workflows/release.yml` runs on every `v*` tag:

1. `npm ci`, `npm test`, `npm run build:meta` (bundle sizes in the job summary;
   fails if `content.js` is over 120 KB), the Python end-to-end suite, `npm run package`.
2. Checks that the tag, `package.json`, `dist/manifest.json` and the first
   `## x.y.z` heading in `CHANGELOG.md` all name the same version, and that the
   CHANGELOG section is not empty. A mismatch stops the release before anything is published.
3. Checks the package holds no dotfiles and no source maps, writes `SHA256SUMS`.
4. Creates the GitHub Release `SceneVoice x.y.z` with that version's CHANGELOG
   section as the notes and three files: `scenevoice-x.y.z.zip` (the extension,
   what the stores get), `scenevoice-x.y.z-sourcemaps.zip` (external source
   maps with sources, for reading stack traces; never inside the extension) and `SHA256SUMS`.
5. If the Chrome Web Store secrets exist, uploads the zip as a **draft** of the
   store item. If the Edge secrets exist, uploads the zip to the Edge Add-ons
   **draft submission**. Neither step publishes; that stays a click in the
   store's dashboard, after the listing and screenshots are checked. Without
   the secrets the steps are skipped and the GitHub Release is still made.

Pre-release tags (`v1.2.0-rc1`) are marked as pre-releases on GitHub. The
version check compares the tag to `package.json` literally, so a pre-release
needs the same string in `package.json` and `CHANGELOG.md`.

A failed run can be re-run from the Actions tab after the cause is fixed; if
the fix needs a commit, delete the tag (`git push --delete origin v1.1.0`,
`git tag -d v1.1.0`), reset the release commit and cut the version again.

## 3. Secrets

Set under *Settings → Secrets and variables → Actions*. All are optional; a
missing group skips that store.

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `CWS_EXTENSION_ID` | The 32-letter id of the store item | Developer Dashboard → the item → the id in the address bar. The first version must be uploaded by hand to create the item. |
| `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` | An OAuth client of type *Desktop app* in a Google Cloud project with the *Chrome Web Store API* enabled | https://console.cloud.google.com → APIs & Services → Credentials. The project's OAuth consent screen must list the Google account that owns the item as a test user (or be published). |
| `CWS_REFRESH_TOKEN` | A refresh token for that client with scope `https://www.googleapis.com/auth/chromewebstore` | Follow https://developer.chrome.com/docs/webstore/using-api (the "Get an access token" section): open the consent URL with the client id, exchange the code with `curl` for a refresh token. The token stays valid while the consent is not revoked. |
| `CWS_PUBLISHER_ID` | Optional. The publisher id the newer Web Store API wants for a group publisher | Developer Dashboard → Account. Leave unset for a personal account unless the upload step says it is required. |
| `EDGE_PRODUCT_ID` | The product GUID | Partner Center → Microsoft Edge → the extension → *Extension identity*, also the GUID in the address bar. The first version is published through Partner Center by hand; the API only updates. |
| `EDGE_CLIENT_ID`, `EDGE_API_KEY` | Publish API credentials (v1.1, API key) | Partner Center → Microsoft Edge → *Publish API* → *Enable* the API-key experience → *Create API credentials*. Keys expire; the Publish API page shows the date. |

The upload tools: [`chrome-webstore-upload-cli`](https://github.com/fregante/chrome-webstore-upload-cli)
(run with `npx`, pinned in the workflow) and `scripts/edge-upload.mjs`
(this repository, plain `fetch` against the
[Edge Add-ons REST API](https://learn.microsoft.com/microsoft-edge/extensions-chromium/publish/api/using-addons-api)).
Both can be run from a laptop with the same environment variables; see the
comments at the top of `scripts/edge-upload.mjs`.

## 4. After the workflow

1. **Chrome Web Store**: Developer Dashboard → the item → check the draft's
   version, the listing text (`docs/store-listing.md`), the screenshots
   (`docs/store/`, made by `npm run screenshots`) and the privacy practices
   answers → *Submit for review*.
2. **Edge Add-ons**: Partner Center → the extension → the draft shows the new
   package → check the listing in both languages → *Publish*. Or run
   `node scripts/edge-upload.mjs scenevoice-x.y.z.zip --publish`.
3. **Gitee mirror** (`docs/distribution-china.md`): push the tag to Gitee and
   attach `scenevoice-x.y.z.zip` and `SHA256SUMS` to a Gitee release with the
   same tag.
4. Tell the people who asked: the README's install section links to each place.

## Verifying a download

```
sha256sum -c SHA256SUMS
```

prints `OK` for each file that matches what the workflow built. On macOS use
`shasum -a 256 -c SHA256SUMS`.
