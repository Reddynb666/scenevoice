# Third-party notices — SceneVoice desktop test shell

## Open question for the owner: the sample clip

**A build does not contain the sample clip unless it was made with `--with-sample`.** Before a build with the clip is given to anyone, this has to be answered, by the Blender Foundation (foundation at blender.org answers licensing questions) or by a lawyer:

> May 40 seconds of *Tears of Steel* be passed on with the film's own sound, its music included, under the film's CC BY 3.0 licence?

What we have read (2026-11-16):

- The film's end credits: "Licensed as Creative Commons Attribution 3.0" (the frame at 11:43 of the Blender Foundation's download).
- The Blender Foundation's page for the film, https://mango.blender.org/sharing/: "The proceedings and results of the Mango Open Movie project are being licensed under the Creative Commons Attribution 3.0 license. This includes all the data we publish on this website and which we’ll publish on the DVDs. If any content on this site is not licensed as such, it will be clearly indicated." The page excludes logos, trademarks and "material that’s clearly not resulting from the Mango project". It does not mention the soundtrack or the music at all.
- `copyright.txt` in the folder the film is downloaded from puts the *Original Soundtrack files* of Tears of Steel under Creative Commons Attribution-NoDerivs 3.0 (https://creativecommons.org/licenses/by-nd/3.0/), (C) Joram Letwory.

Our reading is that the film, sound included, is a result of the project and so under CC BY 3.0, and that the NoDerivs notice is about the separately released soundtrack files. But nothing we have read says so in as many words: the page is silent on the music, and the only text that names the music restricts it. A cut of the film is a cut of its music too. So the reading stays a reading, and the builds for testers leave the clip out. Without it the shell reads the same ten descriptions over any film the tester opens, and says so.

The shell's own code and the description script (`renderer/sample/narration.json`) are part of SceneVoice and under its MIT licence (`../LICENSE` in the repository; `LICENSE.SceneVoice.txt` next to this file in a build). The ten descriptions were written by us from the pictures of the clip; they are in every build, the film is not.

## Sample film (only in a build made with `--with-sample`)

**Tears of Steel** — (CC) Blender Foundation | mango.blender.org

Licensed under the Creative Commons Attribution 3.0 licence (CC BY 3.0): https://creativecommons.org/licenses/by/3.0/

The sample clip (`renderer/sample/sample.mp4`) is a 40-second excerpt, starting 23 seconds into the film, scaled down to 640 pixels wide and re-encoded as H.264 video with AAC sound. It is cut from the Blender Foundation's own download (`https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov`) by `scripts/make-sample.mjs`. The clip is not kept in this repository. In a build that contains it, the credit line is also shown in the shell's help text.

The descriptions spoken over the clip are written for SceneVoice; the Blender Foundation does not endorse them or this software.

**The film's music** — (C) Joram Letwory - www.tearsofsteel.org

The clip carries the film's own sound, its music included, changed only by the cut, a short fade at each end and the re-encoding. See the open question above.

## The application icon

Made by `scripts/make-icon.mjs` from SceneVoice's own icon artwork (`../static/icons`, MIT like the rest).

## Software in a build

- **Electron** — MIT licence, Copyright (c) Electron contributors and GitHub Inc. https://github.com/electron/electron
- **Chromium** and the libraries built into it (among them FFmpeg under LGPL-2.1-or-later, as built by the Electron project) — each under its own licence; a build carries their full texts in `LICENSES.chromium.html`, next to the application. Electron's own licence is in `LICENSE.electron.txt` beside it.

The shell has no other runtime dependency.

## In the Windows installer only

The installer (`…-setup.exe`) is made with **NSIS** (Nullsoft Scriptable Install System, https://nsis.sourceforge.io), as packaged by electron-builder. The installer program itself, its uninstaller and the helper libraries it unpacks while it runs are NSIS code: NSIS and its standard plug-ins (System, nsDialogs, nsExec) are under the zlib/libpng licence, Copyright (C) 1999-2018 Contributors. It also carries these plug-ins from electron-builder's NSIS bundle: `nsis7z` (unpacks the application; built on 7-Zip, GNU LGPL), `StdUtils` (GNU LGPL 2.1 or later), `UAC` and `WinShell`.

None of this is installed with the application or is part of the zip: it runs during installation and removal only.

**Open point:** the bundle these plug-ins come from ships no licence texts for them. The licences named above for `nsis7z` and `StdUtils` are what their projects publish, written here from general knowledge and not checked against the exact builds in the bundle; the licences of `UAC` and `WinShell` have not been established. Settle this before an installer is published; the zip does not have the question.

## Tools used only for development (never shipped)

- **electron-builder** — MIT licence. For the Windows packages it downloads and runs the NSIS compiler and a 7-Zip program on the developer's machine.
- **Vitest** — MIT licence
- **axe-core** — Mozilla Public License 2.0, Copyright (c) Deque Systems, Inc. (loaded only by `npm run selftest` from `node_modules`)
- An **ffmpeg** on the developer's machine, used by `scripts/make-sample.mjs` to cut the sample clip. It is not copied into anything that ships.
