# Film tools: measurement scripts for the kill tests

Command-line scripts (Node, ES modules) that the film plan's kill tests need
(`docs/plan-film-2026-11.zh-CN.md`, section 六): read a film with ffmpeg, find
and embed faces, time the whole local pass, and save what the next experiments
start from.

**Nothing here ships.** This folder is scaffolding for measurements. It has its
own `package.json` and lockfile so that its native dependency never reaches the
extension, the web player or the desktop app, and it does not import from
`src/`. The root test run excludes `tools/`.

## What you need

- Node 22 or later. Only Node 24.14 has been tried.
- `ffmpeg` and `ffprobe` on `PATH` (any recent build). The Homebrew build on the
  owner's Mac is a GPL build: fine for running these scripts locally, **never to
  be copied into anything that is distributed**.
- macOS or Windows for the accelerated face models (CoreML, DirectML); elsewhere
  they run on the CPU.

```
cd tools/film
npm install          # onnxruntime-node only
```

Behind a proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` to use
`HTTPS_PROXY`. From mainland China `huggingface.co` is usually not reachable
without one, so `fetch-models.mjs` will need it there
(`NODE_USE_ENV_PROXY=1 node fetch-models.mjs`); `download.blender.org` answered
without one. A fetch that times out can simply be run again: finished files are
kept and checked, unfinished ones continue from their `.part` file.

## Run them in this order

```
node fetch-fixture.mjs                                   # test film, subtitles, licence record
node fetch-models.mjs                                    # YuNet + SFace, licence checked, SHA-256 checked
npm test                                                 # 20 checks; one of them uses the film and the models
node check-faces.mjs  fixtures/tears_of_steel_720p.mov   # boxes on faces? same person alike? pictures to look at
node prepass-bench.mjs fixtures/tears_of_steel_720p.mov --runs 3 \
     --also-ep cpu --also-ep detector=coreml,recogniser=cpu \
     --report-dir ../../docs/film/killtests              # timing table + the K4 record
node face-tracks.mjs  fixtures/tears_of_steel_720p.mov   # detections.json, shots.json, contact sheets
```

Every script takes any film file, not only the fixture, and prints its usage
when run without arguments.

| Script | What it does |
| --- | --- |
| `fetch-fixture.mjs` | Downloads the test film with resume and a size check, the English and Chinese subtitle files it finds in the folder listing, and `copyright.txt`; writes `fixtures/SOURCE.json` (URL, SHA-256, bytes, fetch date from the HTTP `Date` header or `--fetched-at`, the licence notice word for word). `--credits-licence "…" --credits-at <seconds>` records what a person read in the end credits, marked as read by eye. |
| `fetch-models.mjs` | Lists both model repositories through the Hugging Face API, picks the newest full-precision `.onnx`, reads `LICENSE` and `README.md` at the same commit and **stops if the licence is not the expected one**, downloads, checks the SHA-256 the API states, writes `models/manifest.json`. |
| `check-faces.mjs` | Label-free sanity check: cosine similarity of a face against the face overlapping it in the next sampled frame of the same shot (same person), and of two faces in one frame (different people). Writes annotated frames and sheets of aligned 112×112 crops for the worst cases to `out/<name>/check/`. |
| `prepass-bench.mjs` | Times probe, decode at the sampling rate, face detection, embedding, scene scores, audio and subtitle extraction; records peak memory and how busy the machine was (load average, what other processes use, swap, power source); scales the result to a two-hour film (marked as extrapolated). `--runs N` repeats everything and reports the median run. A run during which the machine slept or stalled for more than two seconds is thrown away and done again, and the record lists it. `--report-dir` writes `K4-prepass-<machine>.json`. It never writes `pass: true` or `false`. |
| `face-tracks.mjs` | Runs the face pass and writes `out/<name>/detections.json`, `shots.json` and one contact sheet per minute in `sheets/` (green box: embedded; yellow: found but under 40 px, not embedded). |

| Library | What is in it |
| --- | --- |
| `lib/media.mjs` | `probe`, `frames` (async iterator of raw RGB), `frameAt`, `sceneScores`, `audioPcm`, `extractSubtitles`, `encodeJpeg` / `writeJpeg` / `readJpeg`. Children are spawned with argument arrays; errors carry the tail of ffmpeg's stderr. |
| `lib/faces.mjs` | `createFaces()` → `detect(rgb, width, height, { scoreThreshold, nmsThreshold, tiles })` and `embed(rgb, width, height, face)`, with the execution provider that loaded for each model. The header comment says exactly what each model is fed. |
| `lib/prepass.mjs` | The face pass with a stopwatch on each part, shot cuts from scene scores, statistics, the memory sampler, the watch for a machine that sleeps under the stopwatch. |
| `lib/draw.mjs` | Boxes, dots, digit labels, shrinking and pasting on RGB buffers, for the pictures a person checks. |
| `lib/download.mjs` | Resumable download with size and SHA-256 checks. |

### Times

Every `t` is in the file's own timestamps (what ffprobe prints). A player that
rebases a file to start at zero shows `t - probe(file).startTime`; for most
files the two are the same. Frame `i` of `frames()` is the last picture shown at
or before `first + i / fps`. Two traps the tests pin down: Matroska stores whole
milliseconds (the reader allows 1 ms of slack so a picture stored as 0.042 s
still counts as 1/24 s), and Matroska reports the last timestamp as its
duration, so a file that starts at 5 s and plays 3.5 s says 8.5.

### Outputs

`detections.json`: `frames[]` of `{ t, faces[] }`; a face is `{ box: [x, y, w, h],
score, landmarks: 5 × [x, y], embedding }` in pixels of the sampled frame. The
embedding is base64 of 128 little-endian float32 at unit length, or `null` when
the shorter side of the box is under 40 px. `shots.json`: `cuts[]` of
`{ t, score }` and `shots[]` of `{ start, end }`; a picture whose ffmpeg scene
score is 0.3 or more starts a shot, unless a cut was taken less than 0.25 s
before. That threshold is the usual one for ffmpeg's `select` filter; it has not
been checked against a hand-marked cut list, and slow dissolves are missed.

Face data of a film stays on the machine that made it: `out/` is git-ignored,
and the plan (5.9) keeps the product's face data outside the project folder.

## What is downloaded, from where, under which licence

| What | From | Licence, as the source states it |
| --- | --- | --- |
| `tears_of_steel_720p.mov` (372,178,639 bytes) | `https://download.blender.org/demo/movies/ToS/` | Two statements, both recorded in `fixtures/SOURCE.json`. The film's end credits (11:43) read "Licensed as Creative Commons Attribution 3.0 / www.tearsofsteel.org" (read by eye). `copyright.txt` in the same folder says "Creative Commons Attribution-NoDerivs 3.0 — This license applies to the Original Soundtrack files of Tears of Steel", credit "(C) Joram Letwory - www.tearsofsteel.org". So the soundtrack may be copied but not changed: keep anything that mixes or cuts this film's sound on this machine until someone has asked the Blender Foundation. |
| `TOS-en.srt`, `TOS-CH.srt`, `TOS-CH-traditional.srt` | `…/ToS/subtitles/` | No separate notice in that folder. |
| `face_detection_yunet_2023mar.onnx` (232,589 bytes) | `https://huggingface.co/opencv/face_detection_yunet` | MIT (`LICENSE`: "MIT License, Copyright (c) 2020 Shiqi Yu"; README: "All files in this directory are licensed under MIT License"). |
| `face_recognition_sface_2021dec.onnx` (38,696,353 bytes) | `https://huggingface.co/opencv/face_recognition_sface` | Apache-2.0 (`LICENSE`: Apache License 2.0; README: "All files in this directory are licensed under Apache 2.0 License"). |
| `onnxruntime-node` 1.31.1 and its 16 dependencies | npm | MIT, except `global-agent` (BSD-3-Clause), `semver` (ISC) and `type-fest` (MIT OR CC0-1.0), as their `package.json` files state. Its install script fetches extra binaries only for CUDA on Linux; on macOS and Windows everything is in the package. |

Nothing else is downloaded: no InsightFace or SCRFD weights, no ffmpeg binary.
The exact commit of each model repository, the URL and the SHA-256 are in
`models/manifest.json`. `fixtures/`, `models/`, `out/`, `cache/` and
`node_modules/` are git-ignored; together they take about 730 MB.

The pre- and post-processing in `lib/faces.mjs` was written from OpenCV's own
implementation of these two models (`modules/objdetect/src/face_detect.cpp` and
`face_recognize.cpp`, Apache-2.0), which is what the zoo's `yunet.py` and
`sface.py` call.

## The K4 record

`docs/film/killtests/K4-prepass-<machine>.json` holds one machine's timing of
the local pre-pass. The plan's pass line (a two-hour film in 45 minutes) is for
a 2020+ Intel laptop with integrated graphics; a record from any other machine
keeps `pass: null` and says so in `note`. Its `notMeasured` list names the parts
of K4 this script does not touch (player seeking, speech synthesis while
playing, a non-zero-start Matroska file in the player, a second face model).

Run the benchmark with the lid open, on mains power if possible, and with as
little else running as you can manage. The script holds off idle sleep on macOS
(`caffeinate -i`), but a closed lid still puts a laptop to sleep, and a sleep
under the stopwatch turns seconds into hours: such a run is detected, thrown
away, repeated, and listed under `measured.interruptedRuns`. What the machine
was doing besides is in `measured.conditions`.

## What the runs on the fixture showed (2026-11-16, Apple M3, 8 GB)

Figures from `check-faces.mjs`, `face-tracks.mjs` and from looking at the
pictures they write; the timings are in the K4 record.

- **Frame times.** Sample `k` of `frames()` at 2 fps was compared with picture
  `12k` pulled out of the film by number, at seven places: identical pixels
  (mean difference 0.000), while the pictures one before and one after differ
  wherever something moves. The first frame's `t` is 0, the file's start.
- **Boxes sit on faces**, landmarks on eyes, nose and mouth corners (looked at
  on a dozen annotated frames and on the contact sheets of minutes 0, 4 and 7).
  1003 boxes in 1469 sampled frames; the shorter side runs from 14 px to
  428 px, median 97 px; 193 are under 40 px and get no embedding.
- **What is missed:** people seen from behind, and faces in wide shots where
  they are a few pixels (the three walking away at 4:13, the four kneeling at
  7:44, the sniper from behind at 7:14). Right for a face detector, a gap for
  following a person.
- **False detections** exist at the default score of 0.6: robot parts
  (7:40–7:41), smoke and blur (7:23), a graphic in the end credits (10:57).
  Some are large enough to be embedded.
- **Same person, half a second apart in one shot** (557 pairs): median cosine
  0.89, 94.8% above 0.5, 97.7% at or above OpenCV's same-person line of 0.363.
  **Different people in one frame** (284 pairs): median 0.12, 99.6% under
  0.363; the one pair above 0.5 (0.59) is two false boxes on the same robot.
  The low "same" pairs are profiles, a face half covered by an eyepiece,
  motion blur, dark shots, and one box that slid from a face onto a robot.
- **Three people at 4:10**, each against all three half a second later: same
  person 0.947, 0.536, 0.911; different people between -0.059 and 0.159. The
  0.536 is the man in the middle, in three-quarter view with an eyepiece.
  CoreML and CPU give the same numbers to within 0.002.
- **`tiles: true`** added 139 boxes (1003 to 1142) and took the detector from
  3.8 ms to 15.8 ms per frame. Of 40 added boxes looked at, 8 were clearly
  faces (small or in profile), about 5 could not be told, and 27 were not faces
  (robots, a hubcap, a lamp, credits graphics). Off by default.
- **SFace was slower on CoreML than on the CPU** on this machine: 22.3 ms per
  face against 10.9 ms, while YuNet was faster on CoreML (3.8 ms per frame
  against 12.2 ms). The scripts still try CoreML first for both, as the task
  set; `--ep detector=coreml,recogniser=cpu` is the faster pairing here.
- **The machine was busy** during the timing (load average 9 to 12, other
  processes using between one and two cores, 7 GB of swap in use, on battery):
  the K4 record states this for every run.
