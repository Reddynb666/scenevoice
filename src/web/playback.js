// The cue loop of the web player: the extension's playback rules
// (content/index.js) against a YouTube IFrame player instead of a <video>.
// Polled every 250 ms by the page. Gaps mode speaks the longest version that
// fits the pause the model estimated and skips what does not fit; pause mode
// pauses the video for what does not fit and resumes after; manual mode is
// silent until asked. A cue that comes due while one at least as important is
// being read waits for the next pause (DEFER_WAIT seconds) or is dropped.
// The player object is injectable: tests use a fake with time, state and rate.

import { chooseUtterance, cueAt, passesDensity } from '../shared/script.js';
import { CueScheduler, mayInterrupt, pickOne } from '../shared/scheduler.js';

/** YT.PlayerState values, so nothing here needs the YT global. */
export const STATE = Object.freeze({ UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 });

/** Seconds a cue held back during another description waits for a pause. */
export const DEFER_WAIT = 5;
/** A jump of more than this many seconds is a seek: speech stops, nothing stale fires. */
export const SEEK_JUMP = 2.5;
/** After this many skipped descriptions in gaps mode, the listener is told once that pause mode would keep them. */
export const SKIPPED_NOTICE_AFTER = 3;
/** The screen reader's end is only estimated: hold a paused video this much longer before resuming. */
export const SCREENREADER_RESUME_HOLD_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Playback {
  /**
   * @param {object} o
   * @param {() => object|null} o.player  the YT player (getCurrentTime, getPlayerState, getPlaybackRate, pauseVideo, playVideo), or null before one exists
   * @param {import('./output.js').WebOutput} o.output
   * @param {() => {mode: string, detail: string, density: string, output: string, readerSpeed: number, ttsRate: number}} o.getSettings
   * @param {() => string} o.aiNotice     the "AI-generated audio description follows." sentence, in the interface language
   * @param {(skipped: number) => void} [o.onSkipped]  more than a few descriptions found no pause (gaps mode), once per video
   */
  constructor({ player, output, getSettings, aiNotice, onSkipped = () => {} }) {
    this.player = player;
    this.output = output;
    this.getSettings = getSettings;
    this.aiNotice = aiNotice;
    this.onSkipped = onSkipped;
    this.scheduler = new CueScheduler([]);
    this.enabled = true;
    this.setVideo();
  }

  /** A new video: forget the old script, the notice said, what was skipped and what was held. */
  setVideo() {
    this.script = null;
    this.scheduler.setCues([]);
    this.lastTime = null;
    this.noticeSaid = false;
    this.skipped = 0;
    this.skippedSaid = false;
    this.lastSpoken = null;
    this.deferred = null;
    this.speakingCue = null;
    this.speechToken = 0;
    this.pausedByUs = null;
  }

  setScript(script) {
    this.script = script;
    this.scheduler.setCues(script?.cues || []);
    this.scheduler.reset(this.lastTime);
  }

  get cues() {
    return this.script?.cues || [];
  }

  /** The speed descriptions are read at: the voice's rate, or the speed the listener says their screen reader has. */
  readerRate() {
    const s = this.getSettings();
    return s.output === 'tts' ? s.ttsRate : s.readerSpeed;
  }

  setting(key) {
    return this.getSettings()[key];
  }

  /** Called every 250 ms. */
  tick() {
    const player = this.player();
    if (!player) return;
    const t = Number(player.getCurrentTime?.());
    if (!Number.isFinite(t)) return;
    const last = this.lastTime;
    this.lastTime = t;
    if (Number.isFinite(last) && Math.abs(t - last) > SEEK_JUMP) {
      // A seek: the description of the old moment stops, nothing stale fires.
      this.deferred = null;
      this.scheduler.reset(t);
      if (this.output.speaking) this.stopSpeaking({ keepPause: false });
      return;
    }
    if (!this.enabled || !this.script || this.setting('mode') === 'manual') {
      this.scheduler.reset(t);
      return;
    }
    if (player.getPlayerState?.() !== STATE.PLAYING) return;
    const density = this.setting('density');
    const fired = this.scheduler.tick(t).filter((c) => passesDensity(c, density));
    const cue = pickOne(fired);
    if (!cue) {
      this.tryHeld(t);
      return;
    }
    if (!mayInterrupt(this.speakingCue, cue)) {
      this.hold(cue, t);
      return;
    }
    this.deliver(cue);
  }

  /** Keep a cue that came due during another description for the next pause: the more important of it and one already waiting. */
  hold(cue, now) {
    if (this.deferred) {
      if (pickOne([this.deferred.cue, cue]) !== cue) return;
      this.noteSkipped();
    }
    this.deferred = { cue, at: now };
  }

  /** Say the held cue once nothing else is being said, if the rest of its pause still fits it. */
  tryHeld(now) {
    if (this.speakingCue || !this.deferred) return;
    const { cue, at } = this.deferred;
    if (now < at - 1) {
      this.deferred = null; // seeked away
      return;
    }
    if (now - at > DEFER_WAIT) {
      this.deferred = null;
      this.noteSkipped();
      return;
    }
    // The pause the model estimated began at the cue's own moment; part of it has passed.
    const left = { ...cue, start: now, gap: Math.max(0, cue.gap - (now - cue.start)), source: cue };
    if (this.deliver(left)) this.deferred = null;
  }

  utteranceFor(cue, manual = false) {
    const player = this.player();
    return chooseUtterance(cue, {
      mode: manual ? 'manual' : this.setting('mode'),
      detail: this.setting('detail'),
      rate: this.readerRate(),
      onScreenText: true,
      playbackRate: Number(player?.getPlaybackRate?.()) || 1,
    });
  }

  /**
   * Say a cue now. The first description of a video is led by the AI notice.
   * Returns whether it was said (false: it did not fit and the mode says skip).
   */
  deliver(cue, { manual = false } = {}) {
    const u = this.utteranceFor(cue, manual);
    if (!u) {
      this.noteSkipped();
      return false;
    }
    let text = u.text;
    if (!this.noticeSaid) {
      this.noticeSaid = true;
      text = `${this.aiNotice()} ${text}`;
    }
    this.lastSpoken = { text: u.text, cue: cue.source || cue };
    this.speakText(text, { pause: u.needsPause, cue: manual ? null : cue });
    return true;
  }

  /**
   * @param {object} o
   * @param {boolean} [o.pause]  pause the video while it is read (pause mode), and resume after
   * @param {object|null} [o.cue]  the cue being read, so one no more important does not cut it off;
   *   null for what the listener asked for (describe now, repeat, an answer): nothing scheduled cuts it off
   */
  async speakText(text, { pause = false, cue = null } = {}) {
    const player = this.player();
    const token = (this.speechToken += 1);
    this.speakingCue = cue ? { kind: cue.kind, priority: cue.priority } : { kind: 'manual', priority: 0 };
    // If an earlier utterance paused the video, this one inherits the duty to resume it.
    if (this.pausedByUs) this.pausedByUs = token;
    if (pause && player && player.getPlayerState?.() === STATE.PLAYING) {
      this.pausedByUs = token;
      player.pauseVideo();
    }
    await this.output.say(text);
    if (token !== this.speechToken) return; // a newer utterance took over
    this.speakingCue = null;
    if (this.pausedByUs !== token) return;
    if (pause && !this.output.voiceOn) {
      await sleep(SCREENREADER_RESUME_HOLD_MS);
      if (token !== this.speechToken) return;
    }
    this.resumeIfPausedByUs();
  }

  resumeIfPausedByUs() {
    if (!this.pausedByUs) return;
    this.pausedByUs = null;
    this.player()?.playVideo?.();
  }

  /** The listener pressed play or pause themselves: the video is theirs again. */
  userTookOver() {
    this.pausedByUs = null;
  }

  /** Describe what is on screen now. Returns false when there is no description for this moment yet. */
  describeNow() {
    const player = this.player();
    const t = Number(player?.getCurrentTime?.()) || 0;
    const cue = cueAt(this.cues, t);
    if (!cue) return false;
    return this.deliver(cue, { manual: true });
  }

  /** Say the last description again. Returns false when nothing has been said yet. */
  repeatLast() {
    if (!this.lastSpoken) return false;
    this.speakText(this.lastSpoken.text, { cue: null });
    return true;
  }

  /** Say something the listener asked for (an answer). Resolves when it has been read. */
  sayManual(text) {
    return this.speakText(text, { cue: null });
  }

  /** Stop speaking at once; a video paused for the description resumes unless told otherwise. */
  stopSpeaking({ keepPause = false } = {}) {
    this.speechToken += 1;
    this.speakingCue = null;
    this.deferred = null;
    this.output.stop();
    if (keepPause) this.pausedByUs = null;
    else this.resumeIfPausedByUs();
  }

  /** A description found no pause and was skipped: in gaps mode, after a few, the listener hears once that pause mode would keep them. */
  noteSkipped() {
    if (this.setting('mode') !== 'gaps') return;
    this.skipped += 1;
    if (this.skipped <= SKIPPED_NOTICE_AFTER || this.skippedSaid) return;
    this.skippedSaid = true;
    this.onSkipped(this.skipped);
  }
}
