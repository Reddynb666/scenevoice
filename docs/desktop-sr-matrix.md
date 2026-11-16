# SceneVoice film app — screen-reader test matrix

**As of 2026-11-16, no cell of this matrix has been tested by anyone.** No screen reader has been run against the film app or its test shell on any system, and the Windows build of the shell has never been started on a Windows machine. What exists is an automated self-test (`npm run selftest` in `desktop/`), run on macOS only: it checks what the shell hands to assistive technology (roles, names, focus, live regions, key handling), not what a screen reader makes of it. Nothing below is a result until a dated run is entered in the last section.

This file is the place where screen-reader results for the desktop app are recorded: first for the K3 test shell (`desktop/`, kill test K3 of `docs/plan-film-2026-11.zh-CN.md`), later for the product itself. The testers' instructions for the K3 round are in `docs/film/k3-tester-guide.zh-CN.md`; its numbered steps (0 to 13) are referred to below as "guide step n".

The builds for testers carry no film: the sample clip's licence question is open (top of `desktop/THIRD-PARTY-NOTICES.md`). A tester opens any video of their own (guide step 3), and "听示例" then plays it from the start with the shell's ten sample descriptions, for 40 seconds. Where a scenario below says "the sample", that run is meant.

## Configurations (rows)

| Id | Configuration | System | Who, in the K3 round | Counts for the K3 pass line |
| --- | --- | --- | --- | --- |
| NVDA | NVDA, speech only | Windows 10 / 11 | the owner, on the borrowed laptop | yes |
| JAWS | JAWS | Windows 10 / 11 | nobody yet | no |
| NAR | Narrator | Windows 10 / 11 | nobody yet | no |
| ZDF | 争渡读屏 公益版 (Zhengdu, free edition) | Windows 10 / 11 | tester 1 | yes |
| ZDL | 争渡读屏 授权版 (Zhengdu, licensed edition) | Windows 10 / 11 | tester 2 | yes |
| BY | 保益读屏 (Baoyi) | Windows 10 / 11 | tester 3 | yes |
| VO | VoiceOver | macOS (arm64 build) | nobody yet | no |
| NONE | No screen reader: keyboard only, app voice | Windows and macOS | the owner | no (baseline) |
| NVDA-B | NVDA with a braille display | Windows 10 / 11 | nobody yet | no |
| MAG | Windows Magnifier with a high-contrast theme, no speech | Windows 10 / 11 | nobody yet | no |

For every run, record: the build (file name and SHA-256), the Windows or macOS version, the screen reader's version, its synthesizer and speech rate, the input method, the security software installed, and whether the tester used the zip or the installer. Testers are named by a code (T1, T2, …), never by name.

## Scenarios (columns) and pass conditions

"In the K3 shell" says whether the scenario can be tried with today's test shell. Scenarios marked *later* need parts of the product that do not exist yet; their pass conditions are drafts taken from the plan and will be fixed when those parts are built.

### S1 Install

- **What:** the tester gets the build, gets past the browser, SmartScreen and security software (360, 火绒, Defender), and starts the app. Every warning is written down (guide step 0).
- **Pass:** the tester starts the app without sighted help and without switching security software off. Every prompt on the way was read by the screen reader and its buttons were reachable by keyboard.
- **The microphone** (guide step 12), which the plan's K3 row lists with SmartScreen and 360 / 火绒 under installation: the tester presses "测试麦克风"; the shell asks the system for the microphone, listens for three seconds, says "麦克风有声音" or "麦克风没有声音" (or why it could not be opened) and lets go of it; nothing is recorded. **Pass:** whatever Windows' privacy settings or the security software asked was read by the screen reader and answered by the tester alone, and the shell said one of its two verdicts. A refusal by the system is written down with the shell's sentence and the name of the error in it: it is a result, not a fail of the tester.
- **In the K3 shell:** yes. The builds are unsigned on purpose in this round; a fail at getting the app started is a result about distribution (K8), not about the app. Zip: one folder inside, named like the zip.

### S2 First run

- **What:** the window opens; the tester listens, then walks through the page with Tab (guide steps 1 and 2).
- **Pass:** nothing plays by itself. The screen reader announces the window, and the focus is on the heading. Every control is reached by Tab in the documented order and announced with its name and role; the player region is announced as a region that takes single keys, with its hint.
- **In the K3 shell:** yes.

### S3 Open film

- **What:** the tester opens a video of their own through the native file dialog (guide step 3), and opens one again while the sample run is playing, plays it and seeks with the arrow keys (guide step 9).
- **Pass:** the native dialog is usable with the screen reader, and while it is open the app voice says nothing even if something is still playing; after it closes the focus is back in the app and the status says the film is open and how long it is; Space plays; each seek announces the new position once, and holding an arrow key announces only the last position. A file the app cannot play is said to be unplayable, in words, and the keys then say that no film is open.
- **In the K3 shell:** yes (it analyses nothing; the film is only played).

### S4 Progress and waiting

- **What:** a film is being prepared; the tester waits, asks for the status, and is told when silence has a reason (plan, section 四: "沉默必须有解释").
- **Pass (draft):** the stage and the time left can be asked for at any moment from the menu and are read once; progress is never announced so often that it floods the screen reader (no more than one unrequested announcement per minute); each reason for silence is said once, after the description in progress, never over it.
- **In the K3 shell:** *later* (M2). The shell has no preparation stage; only its status line can be tried.

### S5 Name-card dialog

- **What:** an in-page dialog opens (the name confirmation card in the product; the test dialog in the shell), the tester moves in it, types a Chinese name with an input method, and closes it (guide step 7).
- **Pass:** the dialog's title and text are announced on opening; Tab and Shift+Tab stay inside; Escape closes it and the focus returns to the control that opened it; Enter that confirms an input-method candidate does not submit; single keys typed in the field act as text only; while the dialog is open the app says nothing itself. In the product, additionally: every key of the card (yes / no / hear the lines again / type a name / same person as … / do not reveal yet) is reachable and announced.
- **In the K3 shell:** partly: focus trap, Escape, input method and silence can be tried on the test dialog; the real card comes with M2.

### S6 Key leakage in browse mode, in focus mode and with an input method

- **What:** with the focus in the player region the tester presses the eight single keys (Space, Left, Right, D, R, S, W, X) three times over: in the screen reader's browse mode, in its focus or application mode, and with a Chinese input method switched on; then the same eight actions through the menu accelerators (all Ctrl+Alt+key: G, Comma, Period, E, T, C, Q, X; the table is `desktop/shared/actions.js`, and what the choice was checked against is `desktop/test/reserved-keys.js`), once with the focus on a button and once in browse mode, which is where they are needed (guide steps 5 and 6). A tester who runs Windows Magnifier presses them once more with Magnifier on (guide step 11).
- **Pass:** each of the eight actions is reachable in each of the three states, by its single key or by its accelerator, and no key press does two things at once (the action in the app *and* a screen-reader command, or the action *and* a press of the focused button). Which keys the screen reader keeps for itself in which mode is written down per screen reader: that table decides the default key mode. What 争渡 and 保益 do with Ctrl+Alt combinations is not known from any reference: this scenario is where it is found out.
- **In the K3 shell:** yes.

### S7 Double speech during playback

- **What:** the sample run is played from start to end without a key being pressed, once with the app voice and once with descriptions read by the screen reader; then again while the tester presses Tab, opens a dialog and presses X during a description (guide steps 3, 4 and 8). Where the tester agrees, the session's sound is recorded so that overlaps can be counted afterwards instead of remembered.
- **Pass:** in the untouched playback, zero moments in which two voices speak at once (app voice over screen reader, or the same description heard twice). After Tab, an opened dialog or X, the app voice stops at once, does not repeat the description, and says nothing while the dialog or a menu is open. The same holds under the native Open and Save dialogs (guide steps 9 and 13). If the app voice cannot speak on the tester's computer (no Chinese voice, or the speech engine fails), the shell hands the descriptions to the screen reader by itself and says so once in the status region; write down which sentence the tester heard. That hand-over is not double speech, and the descriptions it moved are not lost.
- **In the K3 shell:** yes. This is the scenario the K3 pass line names.

### S8 Status versus description

- **What:** the tester causes status messages (play, pause, seek, speech rate, a notification sent) while descriptions are being read, on both channels.
- **Pass:** a status message never cuts a description off and is never lost: it is read after the description. Only what the user has just asked for (D, R, W, the key list) interrupts. With descriptions on the screen reader's channel, descriptions and status messages arrive in order and complete.
- **In the K3 shell:** yes.

### S9 Screen-reader restart

- **What:** while the app is open and a film is playing, the screen reader is closed and started again (and, separately, started only after the app).
- **Pass:** without restarting the app, the screen reader reads the focused control again, the single keys or accelerators work as before the restart, and the next description (screen-reader channel) or status message is read. The app does not crash or freeze.
- **In the K3 shell:** yes. It is not in the testers' guide for the first round; the owner tries it with NVDA.

### S10 Wrong-name key

- **What:** during a description that names a person, the tester presses X (or its accelerator) and chooses one of the three corrections (guide step 4).
- **Pass:** the app voice stops at once; the dialog opens with the focus on the first choice, and names the person the last description named; the choice is confirmed in words after the dialog closes. In the product, additionally: the whole script is corrected without a model call, and the affected descriptions are spoken again by the synthetic voice.
- **In the K3 shell:** partly: the key, the dialog and the confirmation; the shell only notes the choice.

### S11 Notification while the window is in the background

- **What:** the app sends a system notification while another window has the focus ("ready" after preparation, in the product).
- **Pass:** the screen reader reads the notification's title and text by itself, without the tester looking for it; activating the notification brings the app's window to the front with the focus on a sensible control; the notification is also in the system's notification list.
- **In the K3 shell:** partly: the shell sends its notification the moment the button is pressed, with its own window in front (guide step 10). The background case needs the product's "notify me when ready" (M2). On Windows, a copy run from the zip has no Start menu shortcut and may get no notification at all; use the installed build for this scenario.

### S12 Recording report (*later*)

- **What:** in the studio, a blind volunteer records a description; after each take the app reads the quality report (length, how far it runs past the gap, peak, noise floor).
- **Pass (draft, from the M5 exit):** from the end of the countdown to the end of capture the app and, as far as the app can arrange it, the screen reader are silent; the report is read after capture has ended; a tester using a screen reader records ten descriptions alone, by ear or by braille display, and the finished takes contain no screen-reader speech and no spill from the loudspeakers.
- **In the K3 shell:** no (M5).

### S13 Import and nudge (*later*)

- **What:** the tester imports a description pack or an edited script through the native file dialog and, when it is out of step with their copy of the film, shifts it earlier or later by key.
- **Pass (draft):** the import is announced with what was imported (title, version, how much of it has been checked by a person); each nudge announces the new offset once, and holding the key announces only the last value; no description is spoken twice because of a nudge.
- **In the K3 shell:** no (M5 for import, M6 for timing across copies).

### S14 High contrast at 200%

- **What:** with a Windows high-contrast theme on and the page zoomed to 200%, with and without Magnifier, the tester goes through the whole page (guide step 11).
- **Pass:** no content or control is cut off or lost, and nothing needs sideways scrolling; every control has a visible border and the focus ring is clearly visible in the theme's colours; the line with the current description is readable and can take the focus (it is also what a braille display shows).
- **In the K3 shell:** yes. Emulated forced colours and 200% zoom pass in the self-test on macOS; a real Windows high-contrast theme has not been tried.

## The K3 pass line

From the plan (section 六, row K3). All four have to hold:

1. **At least two testers complete the checklist unaided on 争渡.** With this round's three testers (one each on 争渡 free, 争渡 licensed and 保益) that means both 争渡 testers.
2. **All eight actions are reachable**, by single key or by menu accelerator, on each of 争渡, 保益 and NVDA.
3. **No double speech** (S7).
4. **A default is decided for each screen reader:** which channel reads descriptions (app voice or the screen reader) and which key mode (single keys or accelerators).

Installation (S1: SmartScreen, 360 / 火绒, the microphone) is recorded separately, as the plan asks. Whether a tester who needed help only to get the unsigned build started still counts as "unaided" for point 1 is the owner's decision; write it next to the result.

Two things in which this round's shell differs from the plan, to be said with the K3 result: the builds carry no sample film (the descriptions are heard over the tester's own video), and the first focus is on the page's heading, not on "听示例".

If the line is not met, the plan's fallbacks are: make the accelerators with modifier keys the default; or run the same page in the user's own Edge, served locally.

## How to record a run

- One row in the run log per tester and sitting. A run that used a different build, screen-reader version or system is a new run.
- In the results table, each cell holds the latest result and the run it comes from, for example `P (R3)`.
- Codes: `P` pass, `F` fail, `B` blocked (could not get that far), `n/a` cannot be tried in this build, `—` not tested.
- A fail or a block gets one line under "Notes on runs": what the tester did, what the screen reader said, where it stopped.
- Do not enter a result from memory or from the self-test. Only what a person did with the named screen reader goes in.

## Results

### Run log

| Run | Date | Build (file, SHA-256 first 8) | Tester | Configuration | System | Screen reader version, voice, rate | Zip or installer | Security software |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — | — | — |

### Results by configuration and scenario

Not one cell has been tested (2026-11-16).

| Configuration | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 | S11 | S12 | S13 | S14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NVDA | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| JAWS | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| NAR | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| ZDF | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| ZDL | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| BY | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| VO | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| NONE | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| NVDA-B | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| MAG | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

### Keys that reached the app (S6)

One line per screen reader and state, filled in from guide steps 5 and 6: for each of Space, Left, Right, D, R, S, W, X whether it reached the app (`app`), did nothing (`none`) or was taken by the screen reader or another program (`taken by …`). "Accelerators that failed" names them by key (G, Comma, Period, E, T, C, Q, X, Slash) with who took each.

| Configuration | State | Space | Left | Right | D | R | S | W | X | Accelerators that failed | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | browse mode | — | — | — | — | — | — | — | — | — | — |
| — | focus mode | — | — | — | — | — | — | — | — | — | — |
| — | input method on | — | — | — | — | — | — | — | — | — | — |

### Defaults decided per screen reader (K3, point 4)

| Screen reader | Descriptions read by | Key mode | Tester's usual speech rate | Decided on | From runs |
| --- | --- | --- | --- | --- | --- |
| NVDA | — | — | — | — | — |
| 争渡 (free) | — | — | — | — | — |
| 争渡 (licensed) | — | — | — | — | — |
| 保益 | — | — | — | — | — |

### Installation record (S1)

One line per run, from guide steps 0 and 12.

| Run | Zip or installer | Prompts on the way (browser, SmartScreen, security software) | Started unaided | Microphone: prompt or setting met | Microphone: what the shell said | Unaided |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — |

### K3 pass line

| Point | Met? | From runs |
| --- | --- | --- |
| 1. Two testers unaided on 争渡 | — | — |
| 2. All eight actions reachable on 争渡, 保益, NVDA | — | — |
| 3. No double speech | — | — |
| 4. Defaults decided per screen reader | — | — |

### Notes on runs

None yet.
