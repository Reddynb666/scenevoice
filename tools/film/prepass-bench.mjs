#!/usr/bin/env node
// Times the local pre-pass over a film, for kill test K4: probe, decode at the
// sampling rate, find faces in every sampled frame, embed every face of at
// least 40 pixels, score scene changes, extract the audio and the subtitles.
// Prints a timing table and saves it as JSON; with --report-dir it also writes
// a K4 record (K4-prepass-<machine>.json) in the shape of a KillTestReport.
//
// Figures under "measured" were measured in this run. Figures under
// "extrapolated" are the measured ones scaled to a two-hour film and are
// marked as such. `pass` is always null here: the plan's pass line is for a
// machine this script cannot know it is running on.
//
// A machine that is doing other work gives slow and uneven figures, so the
// whole measurement can be repeated (--runs 3): the stages reported are those
// of the median run, every run's total is listed, and so is how busy the
// machine was before each (load average, free memory, swap in use, power).
//
// A machine that sleeps under the stopwatch gives nonsense (a closed lid adds
// hours to a stage). Every run is watched for moments when this process did not
// run for more than two seconds; such a run is thrown away and done again, and
// the record lists it. On macOS the script also holds off idle sleep with
// caffeinate while it runs; that does not stop the sleep of a closed lid.
//
// Usage: node prepass-bench.mjs <file> [--fps 2] [--width 960] [--limit seconds] [--runs 1]
//          [--ep cpu | --ep detector=coreml,recogniser=cpu] [--also-ep cpu]...
//          [--tiles] [--out dir] [--report-dir dir] [--film "title"] [--source "…"]
//          [--remark "kept with the record"]...
// Keep the lid open and, if you can, the machine on mains power while it runs.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, loadavg, release, totalmem, type } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { sha256File } from './lib/download.mjs';
import { createFaces, defaultProviders } from './lib/faces.mjs';
import { audioPcm, chooseHwaccel, extractSubtitles, ffmpegVersion, frames, probe, sceneScores } from './lib/media.mjs';
import { CUT_THRESHOLD, MIN_FACE_PIXELS, STALL_LIMIT_MS, cutsFromScores, facePass, outputName, parseProviders, summary, watchMemory, watchStalls } from './lib/prepass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TWO_HOURS = 7200;
const PASS_LINE_MACHINE = 'a 2020+ Intel laptop with integrated graphics';
/** Runs thrown away because the machine slept or stalled are done again, at most this many times in all. */
const EXTRA_ATTEMPTS = 3;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fps: { type: 'string', default: '2' },
    width: { type: 'string', default: '960' },
    limit: { type: 'string' },
    runs: { type: 'string', default: '1' },
    ep: { type: 'string' },
    'also-ep': { type: 'string', multiple: true, default: [] },
    tiles: { type: 'boolean', default: false },
    out: { type: 'string' },
    'report-dir': { type: 'string' },
    film: { type: 'string' },
    source: { type: 'string' },
    note: { type: 'string' },
    remark: { type: 'string', multiple: true, default: [] },
  },
});

const seconds = (ms) => Math.round(ms) / 1000;
const round = (value, digits = 2) => (value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits);

function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** What this machine is, from the system's own commands. */
function machine() {
  const common = { cpuCores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), arch: arch() };
  const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (process.platform === 'darwin') {
    const chip = command('sysctl', ['-n', 'machdep.cpu.brand_string']);
    const model = command('sysctl', ['-n', 'hw.model']);
    return {
      model: `${chip} (${model})`,
      os: `macOS ${command('sw_vers', ['-productVersion'])} (${command('sw_vers', ['-buildVersion'])})`,
      ...common,
      slug: slug(`${chip}-${model}`),
    };
  }
  const chip = cpus()[0]?.model || 'unknown CPU';
  return { model: chip, os: `${type()} ${release()}`, ...common, slug: slug(chip) };
}

/**
 * How much processor the rest of the machine is using, in percent of one core
 * (ps, summed over every process that is not this one or its children). Only
 * the sum is kept: what else runs on the machine is nobody's business.
 */
function otherProcessesCpuPercent() {
  if (process.platform === 'win32') return null;
  const rows = command('ps', ['-axo', 'pid=,ppid=,pcpu=']).split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  if (rows.length < 2) return null;
  let sum = 0;
  for (const [pid, ppid, cpu] of rows) {
    if (pid !== process.pid && ppid !== process.pid && Number.isFinite(cpu)) sum += cpu;
  }
  return Math.round(sum);
}

/** How busy the machine is right now: a benchmark on a loaded machine reads slow. */
function conditions() {
  const mac = process.platform === 'darwin';
  const swap = mac ? /used = ([\d.]+)M/.exec(command('sysctl', ['-n', 'vm.swapusage'])) : null;
  const power = mac ? /Now drawing from '([^']+)'/.exec(command('pmset', ['-g', 'batt'])) : null;
  const lowPower = mac ? /lowpowermode\s+(\d)/.exec(command('pmset', ['-g'])) : null;
  return {
    loadAverageOneMinute: process.platform === 'win32' ? null : round(loadavg()[0]),
    otherProcessesCpuPercent: otherProcessesCpuPercent(),
    freeMemoryMb: Math.round(freemem() / 2 ** 20),
    swapUsedMb: swap ? Math.round(Number(swap[1])) : null,
    powerSource: power ? power[1] : null,
    lowPowerMode: lowPower ? lowPower[1] === '1' : null,
  };
}

/**
 * Hold off idle sleep while this process lives (macOS: caffeinate, which ends
 * with us). Returns what was done, in words for the record.
 */
function keepAwake() {
  if (process.platform !== 'darwin') return 'nothing was done to keep the machine awake';
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return 'caffeinate -i held off idle sleep for the length of the script; a closed lid still puts the machine to sleep';
  } catch {
    return 'caffeinate could not be started: nothing kept the machine awake';
  }
}

/** Why `pass` is null, said for the machine this ran on. */
function passNote(box) {
  if (process.platform === 'darwin' && box.arch === 'arm64') {
    return `Measured on an Apple-silicon Mac; the plan's pass line is for ${PASS_LINE_MACHINE}, which was not available: this record cannot pass or fail K4.`;
  }
  return `Measured on ${box.model}; the plan's pass line is for ${PASS_LINE_MACHINE}, and this script cannot tell whether this machine is one: a person has to decide, so this record does not pass or fail K4 by itself.`;
}

/** The date, from the system's date command where there is one. */
function today() {
  return command('date', ['-u', '+%Y-%m-%dT%H:%M:%SZ']) || new Date().toISOString();
}

/** Title and source of the film: from fixtures/SOURCE.json when this is that very file. */
async function filmRecord(file, sha256) {
  try {
    const source = JSON.parse(await readFile(join(HERE, 'fixtures', 'SOURCE.json'), 'utf8'));
    if (source.sha256 === sha256) {
      const credits = source.licenceInFilmCredits
        ? `the film's end credits read "${source.licenceInFilmCredits.text}" (read by eye at ${source.licenceInFilmCredits.atSeconds} s)`
        : 'the film\'s end credits have not been read for a licence yet';
      const notice = `copyright.txt next to the download states ${source.licenceName}${source.licenceScopeAsStated ? ` and says: "${source.licenceScopeAsStated}"` : ''}`;
      return { film: source.title, source: `open licence: ${credits}; ${notice}. ${source.url}, sha256 ${source.sha256}, fetched ${source.fetchedAt}` };
    }
  } catch {
    // No fixture record: fall through.
  }
  return { film: outputName(file), source: 'not registered: this file has no source record (pass --film and --source)' };
}

async function timed(work) {
  const started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started };
}

/** One faces stage: load the models on the wanted providers, run the pass, sum it up. */
async function facesStage(file, { info, fps, width, end, tiles, providers }) {
  const load = await timed(() => createFaces({ providers }));
  const faces = load.result;
  const pass = await facePass(file, { faces, info, fps, width, end, tiles, markAt: info.startTime + 600 });
  const { timing, counts } = pass;
  const detectTotal = timing.detectMs.reduce((a, b) => a + b, 0);
  const embedTotal = timing.embedMs.reduce((a, b) => a + b, 0);
  return {
    runtime: faces.runtime,
    models: [faces.models.detector, faces.models.recogniser].map((model) => `${model.id}: ${model.file} (${model.licence}), sha256 ${model.sha256}`),
    providers: faces.providers,
    providersTried: faces.tried,
    modelLoadSeconds: seconds(load.ms),
    wallSeconds: seconds(timing.wallMs),
    sampledFramesPerSecond: round(counts.framesSampled / (timing.wallMs / 1000)),
    waitingForFramesSeconds: seconds(timing.waitForFramesMs),
    detectSecondsTotal: seconds(detectTotal),
    embedSecondsTotal: seconds(embedTotal),
    detectMsPerFrame: summary(timing.detectMs),
    embedMsPerFace: summary(timing.embedMs),
    wallSecondsToReachFilmMinute10: timing.reachedMarkMs === null ? null : seconds(timing.reachedMarkMs),
    ...counts,
    frameSize: `${pass.width}x${pass.height}`,
  };
}

/** Every stage once, with a stopwatch on each. */
async function measureOnce(file, { info, fps, width, end, processed, out, hwaccel }) {
  const before = conditions();
  const memory = watchMemory();
  const clock = watchStalls();
  const probed = await timed(() => probe(file));

  // Decoding alone, to know how fast frames can arrive when nothing else is done with them.
  const decode = await timed(async () => {
    let count = 0;
    for await (const frame of frames(file, { fps, width, end, info })) count = frame.index + 1;
    return count;
  });

  const primary = await facesStage(file, { info, fps, width, end, tiles: options.tiles, providers: parseProviders(options.ep) });
  const others = [];
  for (const text of options['also-ep']) others.push({ asked: text, ...(await facesStage(file, { info, fps, width, end, tiles: options.tiles, providers: parseProviders(text) })) });

  const scenes = await timed(() => sceneScores(file, { info, end }));
  const cuts = cutsFromScores(scenes.result);
  const audio = info.audio.length ? await timed(() => audioPcm(file, { out: join(out, 'audio-16k.wav'), info })) : null;
  const subtitles = await timed(() => extractSubtitles(file, { info }));
  const peak = memory.stop();
  const stalls = clock.stop();

  const stages = {
    probeSeconds: seconds(probed.ms),
    decodeOnly: {
      wallSeconds: seconds(decode.ms),
      framesSampled: decode.result,
      sampledFramesPerSecond: round(decode.result / (decode.ms / 1000)),
      filmSecondsPerSecond: round(processed / (decode.ms / 1000)),
      hwaccel: hwaccel || 'none (software)',
      note: 'the same decode runs again inside the faces stage; this line is not added to the total',
    },
    faces: primary,
    scenes: {
      wallSeconds: seconds(scenes.ms),
      picturesScored: scenes.result.length,
      picturesPerSecond: round(scenes.result.length / (scenes.ms / 1000)),
      cutsAtThreshold: cuts.length,
      threshold: CUT_THRESHOLD,
    },
    audio: audio ? {
      wallSeconds: seconds(audio.ms),
      wavBytes: audio.result.bytes,
      wavSeconds: round(audio.result.duration),
      // The whole track is written, also when --limit shortens the other stages.
      coversWholeFile: true,
    } : null,
    subtitles: { wallSeconds: seconds(subtitles.ms), textTracks: subtitles.result.length },
  };

  // Probing and loading the models happen once; faces and scenes grow with the
  // seconds processed; audio and subtitles always cover the whole file.
  const length = info.endTime - info.startTime;
  const audioSeconds = audio ? audio.ms / 1000 : 0;
  const fixed = stages.probeSeconds + primary.modelLoadSeconds;
  const wholeFile = audioSeconds + subtitles.ms / 1000;
  const growing = primary.wallSeconds + stages.scenes.wallSeconds;
  const total = fixed + growing + wholeFile;
  const twoHours = fixed + growing * (TWO_HOURS / processed) + wholeFile * (TWO_HOURS / length);
  return { before, after: conditions(), stages, others, total, twoHours, audioSeconds, peak, stalls };
}

/** A timing summary as one line of the table; says so when there was nothing to time. */
function perItem(stats, unit) {
  if (!stats.n) return `no ${unit} to time`;
  return `${stats.mean} ms per ${unit} (median ${stats.median}, p95 ${stats.p95})`;
}

function printTable(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) console.log(`${label.padEnd(width)}  ${value}`);
}

async function main() {
  const file = positionals[0];
  if (!file) throw new Error('usage: node prepass-bench.mjs <file> [--fps 2] [--width 960] [--limit seconds] [--runs 1] [--ep cpu] [--also-ep cpu] [--tiles] [--out dir] [--report-dir dir]');
  const fps = Number(options.fps);
  const width = Number(options.width);
  const runCount = Math.max(1, Math.round(Number(options.runs)));
  const out = resolve(options.out || join(HERE, 'out', outputName(file)));
  await mkdir(out, { recursive: true });

  const info = await probe(file);
  if (!info.video) throw new Error(`${file} has no video stream`);
  const length = info.endTime - info.startTime;
  const limit = options.limit === undefined ? undefined : Math.min(Number(options.limit), length);
  const end = limit === undefined ? undefined : info.startTime + limit;
  const processed = limit ?? length;
  const hwaccel = await chooseHwaccel();
  const awake = keepAwake();

  const runs = [];
  const interrupted = [];
  for (let attempt = 1; runs.length < runCount && attempt <= runCount + EXTRA_ATTEMPTS; attempt += 1) {
    const measured = await measureOnce(file, { info, fps, width, end, processed, out, hwaccel });
    if (measured.stalls.gaps.length) {
      // The stopwatch ran while the machine did not: these figures are not a measurement.
      const lost = round(measured.stalls.gaps.reduce((sum, gap) => sum + gap.seconds, 0), 1);
      interrupted.push({ attempt, wallSecondsIncludingTheStops: round(measured.total), stops: measured.stalls.gaps, before: measured.before });
      console.log(`attempt ${attempt}: thrown away, this process did not run for ${lost} s in ${measured.stalls.gaps.length} stop(s) (the machine slept or stalled); doing it again`);
      continue;
    }
    runs.push({ run: runs.length + 1, attempt, ...measured });
    console.log(`run ${runs.length} of ${runCount}: ${round(measured.total)} s in all (load average before ${measured.before.loadAverageOneMinute}, swap in use ${measured.before.swapUsedMb ?? '?'} MB, longest stop ${measured.stalls.longestGapMs} ms)`);
  }
  if (!runs.length) {
    throw new Error(`every one of ${interrupted.length} attempts was interrupted (this process did not run for more than ${STALL_LIMIT_MS / 1000} s at a stretch: the machine slept or stalled). Nothing was saved. Keep the lid open and the machine awake, and run it again.`);
  }
  // The median run by total stands for the measurement; with an even count, the slower of the middle two.
  const ordered = [...runs].sort((a, b) => a.total - b.total);
  const chosen = ordered[Math.floor(ordered.length / 2)];
  const { stages, others } = chosen;
  const primary = stages.faces;
  const factor = TWO_HOURS / processed;
  const wholeFileFactor = TWO_HOURS / length;

  const sha256 = await sha256File(file);
  const record = await filmRecord(file, sha256);
  const box = machine();
  const peakSelf = Math.max(...runs.map((run) => run.peak.peakRssBytes));
  const peakFfmpeg = runs.some((run) => run.peak.peakFfmpegRssBytes === null) ? null : Math.max(...runs.map((run) => run.peak.peakFfmpegRssBytes));
  const report = {
    id: 'K4',
    what: 'Local pre-pass timing: probe, decode at the sampling rate, face detection (YuNet) in every sampled frame, an embedding (SFace) for every face of at least 40 px, scene scores for every picture, audio to 16 kHz mono WAV, text subtitles to SRT. Only this part of K4; see notMeasured.',
    film: options.film || record.film,
    source: options.source || record.source,
    machine: { model: box.model, os: box.os, cpuCores: box.cpuCores, memoryGb: box.memoryGb, arch: box.arch },
    date: today(),
    tools: {
      node: process.version,
      ffmpeg: await ffmpegVersion(),
      faceRuntime: primary.runtime,
      faceModels: primary.models,
      providersTriedInOrder: parseProviders(options.ep) || defaultProviders(),
    },
    settings: { samplingFps: fps, frameWidth: width, tiles: options.tiles, minFacePixelsForEmbedding: MIN_FACE_PIXELS, detectorScoreThreshold: 0.6, limitSeconds: limit ?? null },
    measured: {
      film: {
        fileBytes: info.bytes,
        durationSeconds: round(length, 3),
        secondsProcessed: round(processed, 3),
        video: `${info.video.codec} ${info.video.width}x${info.video.height} at ${round(info.video.fps, 3)} fps`,
        audio: info.audio.map((track) => `${track.codec} ${track.channels} ch`).join(', ') || 'none',
      },
      runs: runs.length,
      runsAskedFor: runCount,
      runRule: runs.length > 1
        ? `the whole measurement was repeated ${runs.length} times; "stages" and "totalSeconds" are those of run ${chosen.run}, the median run by total; every run is listed in allRuns`
        : 'one run',
      interruptedRuns: {
        rule: `a run in which this process did not run for more than ${STALL_LIMIT_MS / 1000} s at a stretch (the machine slept or stalled) is thrown away and done again, at most ${EXTRA_ATTEMPTS} extra times; its figures are not used anywhere else in this record`,
        thrownAway: interrupted,
      },
      conditions: {
        note: 'other programs were not stopped for the measurement. Load average counts busy threads on the whole machine, this run included; otherProcessesCpuPercent is what every other process used at that moment, 100 being one core; swap in use on a machine with little memory means stalls that have nothing to do with the work measured',
        keptAwake: awake,
        beforeTheChosenRun: chosen.before,
        afterTheChosenRun: chosen.after,
        longestStopInTheChosenRunMs: chosen.stalls.longestGapMs,
      },
      stages,
      totalSeconds: round(chosen.total),
      totalIs: 'probe + model loading + decode-and-faces + scene scores + audio + subtitles (the decode-only line is not in it)',
      totalAsShareOfSecondsProcessed: round(chosen.total / processed, 4),
      allRuns: runs.map((run) => ({
        run: run.run,
        attempt: run.attempt,
        totalSeconds: round(run.total),
        decodeOnlySeconds: run.stages.decodeOnly.wallSeconds,
        modelLoadSeconds: run.stages.faces.modelLoadSeconds,
        facesStageSeconds: run.stages.faces.wallSeconds,
        detectMsPerFrameMean: run.stages.faces.detectMsPerFrame.mean,
        embedMsPerFaceMean: run.stages.faces.embedMsPerFace.mean,
        scenesStageSeconds: run.stages.scenes.wallSeconds,
        audioStageSeconds: run.stages.audio?.wallSeconds ?? null,
        otherProviders: run.others.map((other) => ({
          asked: other.asked,
          modelLoadSeconds: other.modelLoadSeconds,
          facesStageSeconds: other.wallSeconds,
          detectMsPerFrameMean: other.detectMsPerFrame.mean,
          embedMsPerFaceMean: other.embedMsPerFace.mean,
        })),
        before: run.before,
        longestStopMs: run.stalls.longestGapMs,
      })),
      peakResidentMemoryMb: {
        thisProcess: round(peakSelf / 2 ** 20, 0),
        ffmpegChildren: peakFfmpeg === null ? null : round(peakFfmpeg / 2 ** 20, 0),
        how: 'the highest over all runs, sampled every 250 ms: this process by process.memoryUsage.rss(), ffmpeg by ps; a short spike between samples can be missed',
      },
      otherProviders: others,
    },
    extrapolated: {
      marked: 'EXTRAPOLATED, not measured: the measured stage times scaled linearly from the seconds processed to 7200 seconds, model loading and probing counted once.',
      assumes: `the same picture size and codec as this file (${info.video.codec} ${info.video.width}x${info.video.height}), the same share of frames with faces, and no slowdown from heat or memory over two hours`,
      factor: round(factor, 3),
      facesStageSeconds: round(primary.wallSeconds * factor),
      scenesStageSeconds: round(stages.scenes.wallSeconds * factor),
      audioStageSeconds: round(chosen.audioSeconds * wholeFileFactor),
      prepassSecondsPerTwoHourFilm: round(chosen.twoHours),
      prepassMinutesPerTwoHourFilm: round(chosen.twoHours / 60),
      prepassMinutesPerTwoHourFilmEveryRun: runs.map((run) => round(run.twoHours / 60)),
    },
    threshold: { prepassMinutesPerTwoHourFilm: 45 },
    pass: null,
    note: options.note || passNote(box),
    // What the person running it wants kept with the record, word for word.
    remarks: options.remark,
    notMeasured: [
      'any Windows or Intel machine, and so the pass line itself',
      'the model calls, speech recognition and speech synthesis that the full preparation of a film also needs: "ready in 5 minutes for the first 10" is not answered by this record',
      'a 1080p or HEVC file, or a file of several gigabytes',
      'seeking in the player and the timeline of a Matroska file that does not start at zero (the frame reader\'s own timestamps are unit-tested on a small synthetic file, not measured in a player)',
      'a second face model (AuraFace): only execution providers for the same two models were compared',
      'the other face back end the plan names (onnxruntime-web in a renderer worker): only onnxruntime-node was run',
    ],
  };

  const shown = [
    ['film', `${report.film}, ${report.measured.film.video}, ${round(length, 1)} s${limit === undefined ? '' : ` (first ${processed} s processed)`}`],
    ['machine', `${box.model}, ${box.os}, ${box.memoryGb} GB`],
    ['run shown', runs.length > 1 ? `run ${chosen.run} of ${runs.length} (the median by total); totals of all runs: ${runs.map((run) => round(run.total)).join(', ')} s` : 'the only run'],
    ['runs thrown away', interrupted.length ? `${interrupted.length} (the machine slept or stalled under them: ${interrupted.map((run) => `attempt ${run.attempt}, ${run.stops.length} stop(s)`).join('; ')})` : 'none'],
    ['machine before it', `load average ${chosen.before.loadAverageOneMinute}, other processes using ${chosen.before.otherProcessesCpuPercent ?? '?'}% of a core, free memory ${chosen.before.freeMemoryMb} MB, swap in use ${chosen.before.swapUsedMb ?? '?'} MB, power ${chosen.before.powerSource ?? '?'}${chosen.before.lowPowerMode ? ', LOW POWER MODE' : ''}`],
    ['probe', `${stages.probeSeconds} s`],
    ['decode only', `${stages.decodeOnly.wallSeconds} s  (${stages.decodeOnly.sampledFramesPerSecond} sampled frames/s, ${stages.decodeOnly.filmSecondsPerSecond}x real time, hwaccel ${stages.decodeOnly.hwaccel})`],
    ['load face models', `${primary.modelLoadSeconds} s  (detector on ${primary.providers.detector}, recogniser on ${primary.providers.recogniser})`],
    ['decode + faces', `${primary.wallSeconds} s  (${primary.sampledFramesPerSecond} sampled frames/s; ${primary.framesSampled} frames, ${primary.facesFound} faces, ${primary.facesEmbedded} embedded)`],
    ['  detection', perItem(primary.detectMsPerFrame, 'frame')],
    ['  embedding', perItem(primary.embedMsPerFace, 'face')],
    ...others.map((other) => [`  with --ep ${other.asked}`, `${other.wallSeconds} s; detection ${other.detectMsPerFrame.mean} ms on ${other.providers.detector}, embedding ${other.embedMsPerFace.mean} ms on ${other.providers.recogniser}`]),
    ['scene scores', `${stages.scenes.wallSeconds} s  (${stages.scenes.picturesScored} pictures, ${stages.scenes.picturesPerSecond}/s, ${stages.scenes.cutsAtThreshold} cuts at ${CUT_THRESHOLD})`],
    ['audio to WAV', stages.audio ? `${stages.audio.wallSeconds} s  (${round(stages.audio.wavBytes / 1e6, 1)} MB)` : 'no audio track'],
    ['subtitles', `${stages.subtitles.wallSeconds} s  (${stages.subtitles.textTracks} text tracks)`],
    ['total', `${report.measured.totalSeconds} s  (${round((chosen.total / processed) * 100, 1)}% of the seconds processed)`],
    ['peak memory', `${report.measured.peakResidentMemoryMb.thisProcess} MB this process, ${report.measured.peakResidentMemoryMb.ffmpegChildren ?? '?'} MB ffmpeg`],
    ['EXTRAPOLATED to 2 h', `${report.extrapolated.prepassMinutesPerTwoHourFilm} min  (not measured; every run: ${report.extrapolated.prepassMinutesPerTwoHourFilmEveryRun.join(', ')} min; assumes ${report.extrapolated.assumes})`],
    ['K4 pass line', `45 min per two-hour film on ${PASS_LINE_MACHINE}: pass stays null (${report.note})`],
  ];
  printTable(shown);

  await writeFile(join(out, 'bench.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`saved ${join(out, 'bench.json')}`);
  if (options['report-dir']) {
    const dir = resolve(options['report-dir']);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `K4-prepass-${box.slug}.json`);
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`saved ${path}`);
  }
}

main().catch((error) => {
  console.error(`prepass-bench failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
