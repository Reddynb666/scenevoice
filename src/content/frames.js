// Pictures from the playing <video>, for models that are sent frames instead of
// a link to the video (see shared/providers.js). They are taken on this
// computer with a canvas, kept in memory for a minute or two (to answer a
// question or describe a moment again) and never saved.
//
// A video loaded from another site without that site's permission (CORS)
// "taints" the canvas: the browser then refuses to hand its pixels to the page.
// SceneVoice cannot get round that and says so (error code frames-tainted).

import { FRAME_SAMPLING } from '../shared/constants.js';
import { pickEvenly } from '../shared/coverage.js';

export class FrameError extends Error {
  constructor(code, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * One frame of the video as it is now: { time, data } with data a base64 JPEG
 * (no "data:" prefix), at most maxWidth pixels wide.
 * @throws {FrameError} no-video | frames-unsupported (not a <video>) |
 *   frames-not-ready (no picture yet) | frames-tainted (cross-origin) | frames-failed
 */
export function captureFrame(video, { maxWidth = FRAME_SAMPLING.maxWidth, quality = FRAME_SAMPLING.quality, canvas = null } = {}) {
  if (!video) throw new FrameError('no-video');
  if (typeof HTMLVideoElement === 'undefined' || !(video instanceof HTMLVideoElement)) throw new FrameError('frames-unsupported');
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new FrameError('frames-not-ready');
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const c = canvas || document.createElement('canvas');
  c.width = width;
  c.height = height;
  let url;
  try {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(video, 0, 0, width, height);
    // Throws a SecurityError when the canvas is tainted.
    url = c.toDataURL('image/jpeg', quality);
  } catch (err) {
    throw new FrameError(err?.name === 'SecurityError' ? 'frames-tainted' : 'frames-failed', String(err?.message || err));
  }
  const prefix = 'data:image/jpeg;base64,';
  if (typeof url !== 'string' || !url.startsWith(prefix) || url.length === prefix.length) throw new FrameError('frames-failed', 'not a JPEG');
  return { time: round1(video.currentTime), data: url.slice(prefix.length) };
}

/**
 * Whether the picture just drawn on the canvas is solid black, as a protected
 * (DRM) video draws: the browser neither refuses the pixels nor shows them.
 * Samples about a thousand pixels. False when the pixels cannot be read.
 */
export function canvasLooksBlank(canvas) {
  try {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx?.getImageData || !canvas.width || !canvas.height) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const step = Math.max(1, Math.floor(data.length / 4 / 1000)) * 4;
    for (let i = 0; i < data.length; i += step) {
      if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) return false;
    }
    return data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Decides when to take a frame and when enough have been taken for a request,
 * as the video plays. Playback time drives it; a jump in time is a seek, after
 * which the next stretch starts where the viewer now is. Recent frames are
 * kept (keepFrames) for questions and for describing a moment again.
 */
export class FrameSampler {
  constructor({ intervalSeconds = FRAME_SAMPLING.intervalSeconds, windowSeconds = FRAME_SAMPLING.windowSeconds, maxFrames = FRAME_SAMPLING.maxFrames, keepFrames = 45 } = {}) {
    this.interval = intervalSeconds;
    this.window = windowSeconds;
    this.maxFrames = maxFrames;
    this.keep = keepFrames;
    this.frames = [];
    this.clearPosition(null);
  }

  clearPosition(t) {
    /** Where the stretch being collected began; null before playback. */
    this.windowStart = t;
    this.lastTime = t;
    this.lastCapture = -Infinity;
  }

  /** Start the next stretch at t (after a seek, or past a part already described). Frames are kept. */
  reset(t = null) {
    this.clearPosition(t);
  }

  /** A new video: forget everything. */
  clear() {
    this.frames = [];
    this.clearPosition(null);
  }

  /** Note the playback position. Returns whether a frame should be taken now. */
  advance(t) {
    if (!Number.isFinite(t)) return false;
    const seeked = this.lastTime != null && (t < this.lastTime - 0.5 || t - this.lastTime > Math.max(3, this.interval * 2));
    if (seeked) this.clearPosition(t);
    this.lastTime = t;
    if (this.windowStart == null) this.windowStart = t;
    return t - this.lastCapture >= this.interval || t < this.lastCapture;
  }

  /** Keep a frame, replacing one taken at nearly the same moment (after seeking back). */
  add(frame) {
    const near = this.interval / 2;
    this.frames = this.frames.filter((f) => Math.abs(f.time - frame.time) >= near);
    this.frames.push(frame);
    this.frames.sort((a, b) => a.time - b.time);
    if (this.frames.length > this.keep) {
      // Drop the frames farthest from the newest: the viewer may have jumped around.
      this.frames = [...this.frames].sort((a, b) => Math.abs(a.time - frame.time) - Math.abs(b.time - frame.time)).slice(0, this.keep).sort((a, b) => a.time - b.time);
    }
    this.lastCapture = frame.time;
  }

  /**
   * The frames of the stretch being collected, once it is windowSeconds long
   * (or at once with force, at the end of the video): { start, end, frames }
   * with at most maxFrames spread over it. The next stretch starts at its end.
   */
  takeWindow(t, { force = false, end = t } = {}) {
    if (this.windowStart == null || !Number.isFinite(t)) return null;
    if (!force && t - this.windowStart < this.window) return null;
    const start = this.windowStart;
    const stop = Math.max(start, end);
    this.windowStart = stop;
    const frames = this.frames.filter((f) => f.time >= start - 0.05 && f.time <= stop + 0.05);
    if (!frames.length || stop - start < 0.5) return null;
    return { start: round1(start), end: round1(stop), frames: pickEvenly(frames, this.maxFrames) };
  }

  /** Frames taken between t - before and t + after, in time order. */
  around(t, before, after) {
    return this.frames.filter((f) => f.time >= t - before && f.time <= t + after);
  }
}
