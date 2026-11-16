# Releasing SceneVoice

How a version gets from this repository to GitHub Releases, the Chrome Web
Store and Edge Add-ons (and, once it exists, the Gitee mirror). The owner
decides when; nothing below pushes or publishes by itself. The owner's
checklist for the first store submission, in Chinese, is
`docs/store-submission.zh-CN.md`.

Two things to know before the first store release:

- **The first version of each store is uploaded by hand.** Neither store's
  API can create an item: the Chrome Web Store item and the Edge Add-ons
  product are made in their dashboards, with the zip from the GitHub Release.
  The upload steps in the workflow only update an item that exists (section 3).
- **The stores get the zip the tag workflow built**, downloaded from the
  GitHub Release and checked against `SHA256SUMS`. Never a zip made on a
  laptop: a package is not reproducible byte for byte (the build writes the
  time into it), and a local zip can carry the version number of a release it
  is not.

## 1. Cut the version in a clean checkout of main

A release is cut from `main`, in a fresh clone that holds nothing else. Not in
a working tree with other work in it: `scripts/release.mjs` refuses any
checkout where `git status` shows a change or an untracked file, as an
everyday checkout usually does, and `npm test` runs every test file it finds
below the folder it starts in, apart from the folders `vitest.config.js`
excludes, so stray work beside the release can fail the release. Not from a
feature branch either: the tag would carry that branch's unfinished work.

First get the changes for the release into `main` (a pull request, CI green).
Then, outside the repository folder:

```
git clone https://github.com/reddynb666/scenevoice.git ~/scenevoice-release
cd ~/scenevoice-release
git switch main
npm ci
npm run release -- 1.2.0
git show HEAD
```

`scripts/release.mjs` refuses to run on a dirty working tree or an existing
tag, then:

1. moves everything under `## Unreleased` in `CHANGELOG.md` into
   `## 1.2.0 — <today>` and leaves an empty `## Unreleased` on top (the date is
   today's in UTC: before 08:00 in Beijing that is still yesterday);
2. sets `version` in `package.json` and `package-lock.json`;
3. runs `npm test` and `npm run build:meta` (the build with the bundle-size
   check, so a `content.js` over 120 KB is caught before a tag exists; a
   failure leaves the edits in the tree and commits nothing);
4. commits `Release 1.2.0` and tags `v1.2.0` (an annotated tag).

If step 3 fails, nothing was committed: put the three files back with
`git checkout -- CHANGELOG.md package.json package-lock.json`, fix the cause
on `main`, pull, and run the command again.

When `git show HEAD` shows what you expect (the CHANGELOG section and the
version lines in `package.json` and `package-lock.json`, nothing else), push
the commit and the tag. This is the step
that publishes, so it is the owner's:

```
git push --follow-tags
```

The clone can be deleted afterwards.

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
5. If all five Chrome Web Store secrets exist, uploads the zip as a **draft**
   of the store item. If the three Edge secrets exist, uploads the zip to the
   Edge Add-ons **draft submission**. Neither step publishes; that stays a
   click in the store's dashboard, after the listing and screenshots are
   checked. Without the secrets the steps are skipped and the GitHub Release
   is still made. The two uploads are independent: a failed Chrome Web Store
   upload does not skip the Edge one. The store secrets are given only to
   these upload steps (and to the step that checks they are set), not to
   `npm ci`, `pip`, the end-to-end suite or any third-party action.

Only `vX.Y.Z` tags are supported; there are no pre-release tags such as
`v1.2.0-rc1`. `scripts/release.mjs` accepts only `major.minor.patch`, a Chrome
or Edge manifest version cannot carry a suffix, and the version check needs the
tag, `package.json`, `dist/manifest.json` and the first CHANGELOG heading to be
identical. To try a build before tagging, `npm run package` on the branch and
load the zip unpacked; that zip is for trying only, never for a store or a
tester (it carries the previous version's number).

A failed run can be re-run from the Actions tab after the cause is fixed; if
the fix needs a commit, delete the tag (`git push --delete origin v1.2.0`,
`git tag -d v1.2.0`), reset the release commit and cut the version again.

## 3. Secrets

Set under *Settings → Secrets and variables → Actions*. Both groups are
optional, but a group is all or nothing: the Chrome Web Store step runs only
when all five `CWS_*` secrets are set, the Edge step only when all three
`EDGE_*` secrets are; an incomplete group skips that store.

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `CWS_EXTENSION_ID` | The 32-letter id of the store item | Developer Dashboard → the item → the id in the address bar. The first version must be uploaded by hand to create the item. |
| `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` | An OAuth client in a Google Cloud project with the *Chrome Web Store API* enabled | https://console.cloud.google.com → APIs & Services → Credentials. Google's own guide (https://developer.chrome.com/docs/webstore/using-api) makes a client of type *Web application* and gets the token in the OAuth Playground; a *Desktop app* client with the consent URL and `curl` works as well. **Set the consent screen's publishing status to *In production* before making the refresh token** (see the note below). |
| `CWS_REFRESH_TOKEN` | A refresh token for that client with scope `https://www.googleapis.com/auth/chromewebstore` | Follow the "Obtain access and refresh tokens" section of the guide above, signed in as the Google account that owns the store item. |
| `CWS_PUBLISHER_ID` | Required. The publisher id: `chrome-webstore-upload-cli` 4.x speaks the Web Store API v2, which addresses the item as `publishers/{publisherId}/items/{id}` and refuses to run without it, for a personal account as much as for a group publisher | Developer Dashboard → *Publisher* → *Settings* (Google's guide, "Obtain your publisher ID"). |
| `EDGE_PRODUCT_ID` | The product GUID | Partner Center → Microsoft Edge → the extension → *Extension identity*, also the GUID in the address bar. The first version is published through Partner Center by hand; the API only updates. |
| `EDGE_CLIENT_ID`, `EDGE_API_KEY` | Publish API credentials (v1.1, API key) | Partner Center → Microsoft Edge → *Publish API* → *Enable* the API-key experience → *Create API credentials*. Keys expire; the Publish API page shows the date. |

**The refresh token and the seven-day trap.** Google's guide says to add
your own address under *Test users* so the project can be used at once. A
project left like that (user type *External*, publishing status *Testing*)
issues refresh tokens that expire after seven days. The symptom, a week after
setting the secrets: the tag workflow publishes the GitHub Release, then the
Chrome Web Store step fails with an authorisation error (`invalid_grant`),
and the job is red; the Edge step still runs. To avoid it: on the OAuth
consent screen press *Publish app* so that the status reads *In production*
(for an app only its owner uses, the "unverified app" warning at consent can
be passed), and only then make the refresh token. If a token has already
expired: publish the consent screen, make a new refresh token, replace
`CWS_REFRESH_TOKEN`, and re-run the failed job from the Actions tab (or
upload that version's zip in the dashboard by hand). A token also stops
working when its consent is revoked or it has not been used for six months.

The Edge API key has an expiry date too: the *Publish API* page shows it. Put
it in a calendar.

Do not set any of these secrets before the first versions are in the stores:
without them the workflow makes the GitHub Release and skips both uploads,
which is what the first, hand-made submission needs.

The upload tools: [`chrome-webstore-upload-cli`](https://github.com/fregante/chrome-webstore-upload-cli)
(run with `npx`, pinned in the workflow) and `scripts/edge-upload.mjs`
(this repository, plain `fetch` against the
[Edge Add-ons REST API](https://learn.microsoft.com/microsoft-edge/extensions-chromium/publish/api/using-addons-api)).
Both can be run from a laptop with the same environment variables; see the
comments at the top of `scripts/edge-upload.mjs`.

## 4. After the workflow

For the first version of a store there is no draft: download
`scenevoice-x.y.z.zip` and `SHA256SUMS` from the GitHub Release, check them
(below), and create the item by hand as `docs/store-submission.zh-CN.md`
describes. From the second version on, with the secrets set:

1. **Chrome Web Store**: Developer Dashboard → the item → check the draft's
   version, the listing text (`docs/store-listing.md`), the screenshots
   (`docs/store/`, made by `npm run screenshots`) and the privacy practices
   answers → *Submit for review*.
2. **Edge Add-ons**: Partner Center → the extension → the draft shows the new
   package → check the listing in every language row → *Publish*. Or run
   `node scripts/edge-upload.mjs scenevoice-x.y.z.zip --publish`.
3. **Gitee mirror**, once it has been created (`docs/distribution-china.md`;
   it does not exist yet): push the tag to Gitee and attach
   `scenevoice-x.y.z.zip` and `SHA256SUMS` to a Gitee release with the same tag.
4. Tell the people who asked: the README's install section links to each place.

## Verifying a download

```
sha256sum -c SHA256SUMS
```

prints `OK` for each file that matches what the workflow built. On macOS use
`shasum -a 256 -c SHA256SUMS`.
