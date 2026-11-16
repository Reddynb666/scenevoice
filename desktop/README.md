# SceneVoice desktop — first-round test shell (K3)

The smallest Electron app that lets blind testers tell us whether 争渡读屏, 保益读屏 and NVDA can drive an Electron window: buttons, a status region, an in-page dialog, a system notification, a native menu, eight single keys with menu shortcuts, ten spoken descriptions over a film, and a microphone check for the installation record.

It is a **test instrument, not the product**: no model calls, no keys, no face code, no film analysis, no network access at all. One permission is granted to the page, the microphone, and only for the single request that follows a press of "测试麦克风" (see *The microphone* below). The ten descriptions in `renderer/sample/narration.json` are spoken at the same times whatever film is playing. The plan it serves is `../docs/plan-film-2026-11.zh-CN.md` (sections 四, 5.1, 5.5 and the K3 row).

**The builds for testers carry no film.** Whether the sample clip may be passed on is an open question for the owner (top of `THIRD-PARTY-NOTICES.md`), so a build holds it only when made with `--with-sample`. Without it, "听示例" plays the film the tester has opened from its start, with the ten descriptions, for 40 seconds, and says what to do when no film is open yet.

## Run

```
cd desktop
npm install
npm run make-sample     # optional, once: the 40-second sample clip for the developer's copy (see below)
npm start
```

The interface is Chinese on a Chinese system and English otherwise; `npm start -- --lang=en` (or `--lang=zh_CN`) forces one. `SCENEVOICE_DEBUG=1 npm start` prints the shell's log to the terminal. `SCENEVOICE_NO_SAMPLE=1 npm start` behaves like a tester's build: as if the clip were not there.

Where GitHub is slow, Electron's download can come from a mirror: `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`.

## Self-test

```
npm run selftest
```

Opens the window for about a minute, checks the real page from inside (where the focus starts, what the accessibility tree gives a screen reader, every key and menu item reaching its action, real key presses in the dialog, the speech rules on the real live regions, silence while a native dialog is open (a stand-in for one: nobody can answer a real dialog there), the hand-over to the screen reader when the voice fails (with a stand-in voice that fails) and when the computer has no voice for the language (with the list of voices emptied), an accelerator's key pressed on a button not pressing the button, the microphone opening for its button and being refused to every other request (with Chromium's stand-in device: no real microphone is opened, and macOS asks nothing), the sample playing and seeking through the media scheme, a file that cannot be played leaving no film open, the Content-Security-Policy, reflow at 200% zoom, borders and the focus ring under emulated forced colours, axe-core with the WCAG 2.2 AA tags) and that Electron can read every menu accelerator and that the window is shown, prints **one line of JSON** and exits 0, or 1 with the failed checks named in `failed`. It makes no sound, and it does not need its window to stay in front.

- `SCENEVOICE_NO_SAMPLE=1 SCENEVOICE_SELFTEST_FILM=renderer/sample/sample.mp4 npm run selftest` runs it the way a tester's build behaves, with any playable file standing in for the tester's film: "听示例" says what to do while no film is open, then plays the opened film from its start with the descriptions and stops where the sample would end.

- `npm run selftest -- --timing` also plays the whole sample (40 seconds more) and reports under `info` when each description was spoken and how long the voice took.
- `SCENEVOICE_SELFTEST_FILM=/path/to/film npm run selftest` opens that file as "the film" instead of the sample, seeks to 90% of it, plays there, and fetches its last bytes through the media scheme: the check for a film of several gigabytes (K4).
- `SCENEVOICE_SELFTEST_SHOTS=/some/folder npm run selftest` saves pictures of the page (start in light and in dark, playing, 200% zoom, forced colours, dialog).
- A packed build runs it too (`SceneVoiceK3Test.exe --selftest` in the unpacked Windows folder), without axe-core, which is not part of a build. A build without the clip then plays nothing unless `SCENEVOICE_SELFTEST_FILM` names a film; its report says so under `info`.

The self-test cannot run a screen reader: it shows what the shell hands to assistive technology, not what a screen reader makes of it. That is what the testers are for.

## Tests

```
npx vitest run
```

Pure logic only: the key map, the accelerator table against the list of combinations other programs keep for themselves (`test/reserved-keys.js`) and against the key lists of the testers' guide, the test matrix and this file, the SpeechBus queue, the IPC contract, the microphone permission and the listening, locale parity, the two schemes' paths and byte ranges, the menu template, the report, the build configuration, and the packaging scripts (the zip, the icon, what counts as a problem in a package). The repository's root test run does not include this folder.

## The sample clip

`npm run make-sample` cuts 40 seconds (from 0:23) out of *Tears of Steel* — (CC) Blender Foundation | mango.blender.org, CC BY 3.0 — into `renderer/sample/sample.mp4` (640 px wide, H.264 + AAC, about 3 MB). It looks for the film in `../tools/film/fixtures/` and in `desktop/.cache/`, and downloads it once (372 MB) into `desktop/.cache/` when it is in neither. It needs an `ffmpeg` on the PATH (or `FFMPEG=/path/to/ffmpeg`), as a developer tool only. Neither the film nor the clip is committed.

The clip is for the developer's copy (`npm start`, `npm run selftest`). **A package does not contain it** unless it is built with `--with-sample`: the clip carries the film's own sound, music included; the film's credits say CC BY 3.0, the Blender Foundation's page for the film does not mention the music, and a notice next to the download puts the separately released soundtrack files under CC BY-ND 3.0. `THIRD-PARTY-NOTICES.md` quotes all three and states the question the owner has to get answered before a build with the clip goes to anyone.

## How it is put together

| Folder | What |
| --- | --- |
| `main/` | Main process: one window (`contextIsolation`, `sandbox`, no Node in the page, no background throttling), accessibility support forced on, the `app://` scheme with a Content-Security-Policy that forbids every connection, the `svmedia://` scheme (the sample and the one film picked in the native dialog, by opaque token, with byte ranges), the native menu, the notification, the diagnostic report, the self-test. |
| `ipc/contract.js` | Every IPC channel with its validator; messages from anything but the app's own main frame are rejected. |
| `renderer/` | The page: plain HTML, CSS and ES modules. `speechbus.js` is the only code that speaks or writes a live region; `keys.js` is the single-key map; `narration.js` times the descriptions. |
| `shared/` | The action table (key, menu accelerator, label) and the string lookup, used by both sides. |
| `locales/` | Every user-facing string: `en.mjs` and `zh_CN.mjs`. |
| `scripts/` | `make-sample.mjs` (the sample clip), `make-icon.mjs` (the application icon, from `../static/icons`), `zip.mjs` (the Windows zip), `dist.mjs` (the packages), `check-dist.mjs` (what is in them). |
| `build/` | `installer.nsh`: additions to the Windows installer. `icon.ico` and `icon.icns` are made here by `npm run make-icon` and are not committed. |
| `test/` | Vitest. `reserved-keys.js` is the list of key combinations the accelerators stay off, with where each entry comes from. |

**Keys.** Space play/pause, Left/Right 10 s, D describe now, R repeat, S stop speaking, W who is on screen, X the name is wrong, ? help. Each is also in the Listen menu with an accelerator, always Ctrl+Alt+key on Windows (Cmd+Alt+key on macOS): Ctrl+Alt+G play or pause, Ctrl+Alt+Comma back, Ctrl+Alt+Period forward, Ctrl+Alt+E describe now, Ctrl+Alt+T repeat, Ctrl+Alt+C stop speaking, Ctrl+Alt+Q who is on screen, Ctrl+Alt+X the name is wrong, Ctrl+Alt+Slash help. `shared/actions.js` is the one table the menu, the key map and the help text read; `test/accelerators.test.js` holds the testers' guide, the test matrix and this paragraph to it, and checks every accelerator of the menu against `test/reserved-keys.js`.

What that list holds, and from where (read on 2026-11-16; nothing was pressed on Windows):

- From the vendors' own key references: NVDA (Ctrl+Alt with the arrows, Home, End, PageUp, PageDown for tables, Ctrl+Alt+N to start it; in browse mode the cursor keys move its own cursor, so Ctrl+arrow never reaches the page), JAWS (Alt+Ctrl+arrows for tables, Alt+Ctrl+PageUp and PageDown for the voice rate, Ctrl+Left and Ctrl+Right by word), Windows Magnifier (Ctrl+Alt with F, L, D, M, I, R, P, Minus, Space, the arrows, and Enter, H, K for reading), Microsoft Pinyin (Shift+Space, Ctrl+Period; nothing with Ctrl+Alt).
- From memory, no vendor reference read: Ctrl+Space (switches the Chinese input method), Ctrl+Alt+J (starts JAWS), WeChat (Ctrl+Alt+W, system-wide), QQ (Ctrl+Alt with A, Z, S, O, F), NetEase Cloud Music (Ctrl+Alt with P, L, D, M and the arrows).
- **Not known: 争渡读屏 and 保益读屏.** No key reference of either could be found from here. The list keeps off Ctrl+Alt+Z and Ctrl+Alt+B on the guess that their desktop shortcuts follow NVDA's and JAWS's; which Ctrl+Alt combinations they really keep is for the testers to tell us (guide step 6).

So no accelerator uses Space or Enter (they also press the focused button), an arrow, or a letter the list holds; that is why play or pause is G and not P, stop is C and not S, who is Q and not W. Every action is also a menu item (Alt+L opens the Listen menu) and a button on the page, so none depends on its accelerator alone.

**Who speaks.** Descriptions are read by the app's own voice (Web Speech) or, after "用读屏念口述", written to a polite live region for the screen reader. Status messages always go to the status region and wait behind a description. When the user makes the screen reader talk (moves the focus, opens a dialog or a menu), the app voice stops at once, does not repeat itself (R does) and stays silent for 1.5 s. While a dialog or a menu stays open the shell says nothing itself; descriptions that come due are logged, and the 1.5 s run from the moment it closes. The native Open and Save dialogs count as well: the main process tells the page when one opens and closes. When the app voice cannot say a description (the speech engine reports an error, or never reports back), descriptions go to the screen reader's live region from then on, the one that failed included unless it is stale by then, and a status message says which channel reads them now; the button switches back. The same happens, once, when something is about to play on a computer with no voice for the description language or with no voice at all: such a computer would otherwise "speak" Chinese with an English voice and report that all went well. A failed utterance is never counted as spoken.

**The microphone.** The K3 row asks for the microphone to be recorded with the installation (what Windows' privacy settings and the security software say when a program wants it). "测试麦克风", next to the report button at the end of the page, asks for the microphone, listens for three seconds, says "麦克风有声音" or "麦克风没有声音" (or why it could not be opened, with the error's name), and lets go of it. Nothing is recorded, kept, played back or sent: `renderer/mictest.js` looks at the level of each block of samples and drops it. The main process refuses every permission request except this one: sound only, from the page's own main frame, within 15 seconds of the button telling it so, once per press (`main/permissions.js`). The self-test runs the button against Chromium's stand-in device.

**When the page stops.** The window is shown when the page has drawn itself and, whatever happens, after five seconds; starting the app a second time brings the first copy's window forward. If the page's process is gone, the page does not load, it stops answering, or it has not reported 20 seconds after its load began (a process held up by security software sends no event at all), a native message box says so (a screen reader reads it without the page) and offers to load the page again, to save the diagnostic report, or to quit. Quitting from there closes the window without waiting for the page.

**Where the focus starts.** On the heading, with nothing playing. The plan (section 四) puts the first focus on "听示例"; the shell keeps the heading because a tester's build has no sample to hear before a film is open, and because step 1 of the guide asks what the screen reader says of the page from its top. Say so when the K3 result is reported.

**Diagnostic report** (File menu, or the button at the end of the page): versions of Electron, Chromium and the system, accessibility state, GPU feature status, the shell's last 200 log lines, and the container and codec names of the opened film. No file name, no path, nothing else about the film. Nothing is sent anywhere: the tester saves the file and sends it to us. The menu item is carried out by the main process alone, so it still works when the page has stopped answering.

**Things the checklist should watch on Windows** (known in general, not tried here): other programs register Ctrl+Alt+key combinations system-wide, and a combination taken that way does not reach the menu. The table keeps off the ones we know of (see *Keys*); what 争渡 and 保益 keep for themselves is not known to us. A film or a notification of another program may also be what the microphone test hears.

## Packaging

```
npm run dist:win      # Windows x64: a zip holding one folder with the build, and an NSIS installer
npm run dist:mac      # macOS arm64: a zip of the .app
npm run check-dist    # list and check what is in dist/ again
```

Both run on a Mac; the Windows packages need neither Windows nor Wine. Output goes to `dist/` (git-ignored):

| File | What |
| --- | --- |
| `SceneVoice-K3-Test-<version>-win-x64.zip` | the Windows build in one folder of the same name: unzip anywhere and start `SceneVoiceK3Test.exe` in that folder |
| `SceneVoice-K3-Test-<version>-win-x64-setup.exe` | the installer: assisted (a welcome page, then it installs), for the current user only, no administrator rights, in Simplified Chinese; desktop and Start menu shortcuts named "SceneVoice 影院版 测试版" |
| `SceneVoice-K3-Test-<version>-mac-arm64.zip` | the macOS app |

**No film in a package by default.** `npm run dist:win -- --with-sample` (after `npm run make-sample`) puts the clip in; read the top of `THIRD-PARTY-NOTICES.md` first. `--no-sample` is still accepted and means the default. `check-dist` fails when a build that was not asked to carry the clip holds it, and when one that was asked lacks it (`npm run check-dist -- --with-sample`).

The targets and options are in `package.json` (`build`): app id `app.scenevoice.desktop.k3test` (the same id is in `main/index.js`, because Windows shows notifications only when the two agree), product name "SceneVoice 影院版 测试版", `asar` on, only the folders the app runs from. The program file and the package files have plain ASCII names so that a zip made here unpacks the same with every tool. `scripts/dist.mjs` makes the application icon from the extension's artwork (`scripts/make-icon.mjs`: the program, the installer and the shortcuts carry it instead of Electron's), runs electron-builder for the unpacked folder and the installer, deletes its by-products, makes the Windows zip itself (`scripts/zip.mjs`: electron-builder's own zip has no folder in it, so "extract here" would scatter twenty files) and then runs `scripts/check-dist.mjs`, which lists `app.asar` and the resources folder and fails when a package holds node_modules, a source map, a path of the build machine, an updater file, an elevation helper or the clip it should not have, or lacks a licence file, the application icon, or the one folder inside the zip. A build also leaves its unpacked folder in `dist/` (`win-unpacked`, `mac-arm64`): `npm run check-dist` reads those, so it has nothing to check once they are deleted.

Where GitHub is slow, the downloads (Electron for the target platform, the NSIS tools) can come from mirrors: `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

**Unsigned, on purpose.** This round has no certificate; how a tester gets past SmartScreen and antivirus software is step 0 of the test (`../docs/film/k3-tester-guide.zh-CN.md`). The build script switches certificate discovery off so that nothing in the builder's keychain or environment is used by accident. There is no auto-update, no publishing configuration, and Electron's fuses are left at their defaults. On macOS the unsigned app opens on the machine that built it; expect Gatekeeper to stop a copy downloaded elsewhere until the user allows it in System Settings, Privacy & Security (not tried).

**What has been tried** (2026-11-16, on an Apple Silicon Mac): all three packages build, without the sample clip. The macOS zip was unpacked and its app's `--selftest` passed twice: 45 checks with nothing to play, and 53 checks with `SCENEVOICE_SELFTEST_FILM` naming a film, which is the tester's flow ("听示例" over the opened film) run from `app.asar`. The two Windows packages hold the same `app.asar`, byte for byte; their contents were listed and checked, the zip was tested with the system's `unzip` (one folder, no errors), and the program file and the installer were found to carry the application icon. But **neither Windows package has been started: no Windows machine, and no Wine, was available.** Nobody has run the installer or the uninstaller, seen SmartScreen or an antivirus react to them, pressed an accelerator under NVDA, 争渡 or 保益, opened a real microphone from a package (the self-test uses Chromium's stand-in device), seen the icon in Explorer, or tried a notification from either package. A copy run from the zip has no Start menu shortcut, so Windows may show no notification for it; the installed copy should. `--with-sample` was tried once as an unpacked macOS build outside `dist/` (27 files in `app.asar`, the clip among them) and deleted: no package with the clip has been made.

The Windows installer contains NSIS code (the installer program and its plug-ins); see `THIRD-PARTY-NOTICES.md` for their licences and the point that is still open there.
