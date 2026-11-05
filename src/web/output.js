// Delivers text on the web player, the way content/announcer.js does in the
// extension: descriptions go to a polite live region for the screen reader, or
// to the browser's voice (speech.js) with the live regions set aria-live="off"
// while it speaks, so the screen reader and the voice never talk at once.
// Status messages go to a separate status region and never cut off a
// description being read: while one is pending they wait their turn.

import { estimateSeconds } from '../shared/script.js';

/** Delay before a live region is filled, and the gap kept before the next write. */
const WRITE_DELAY_MS = 30;
const WRITE_GAP_MS = 60;

export class WebOutput {
  /**
   * @param {object} o
   * @param {HTMLElement} o.description  the polite live region descriptions and answers are written to
   * @param {HTMLElement} o.status       the status region (role="status")
   * @param {() => {output: string, readerSpeed: number, ttsRate: number}} o.getSettings
   * @param {import('./speech.js').WebSpeech} [o.speech]
   * @param {() => string} o.uiLang      the interface language
   * @param {() => string} o.lang        the description language
   * @param {(ms: number) => number} [o.setTimeout]
   */
  constructor({ description, status, getSettings, speech = null, uiLang = () => 'en', lang = () => 'en', onVoiceFailed = () => {} }) {
    this.description = description;
    this.statusRegion = status;
    this.getSettings = getSettings;
    this.speech = speech;
    this.uiLang = uiLang;
    this.lang = lang;
    this.onVoiceFailed = onVoiceFailed;
    this.pending = null; // { resolve, timer }
    /** One write queue per region: a description never waits behind queued status text. */
    this.queues = new Map();
    this.afterPending = [];
    this.seq = 0;
  }

  queue(region) {
    if (!this.queues.has(region)) this.queues.set(region, { writes: [], timer: null });
    return this.queues.get(region);
  }

  /** Whether the voice, not the screen reader, speaks descriptions now. */
  get voiceOn() {
    return this.getSettings().output === 'tts' && Boolean(this.speech?.available);
  }

  /** While the voice speaks, neither region is live: the screen reader stays quiet. */
  mute(on) {
    const value = on ? 'off' : 'polite';
    this.description.setAttribute('aria-live', value);
    this.statusRegion.setAttribute('aria-live', value);
  }

  /** Put text in a region without waiting for speech; writes are made one after the other so each is noticed. */
  write(region, text, lang) {
    this.queue(region).writes.push({ text, lang });
    this.drain(region);
  }

  drain(region) {
    const q = this.queue(region);
    if (q.timer || !q.writes.length) return;
    const { text, lang } = q.writes.shift();
    region.textContent = '';
    q.timer = setTimeout(() => {
      region.setAttribute('lang', lang);
      region.textContent = text;
      q.timer = setTimeout(() => {
        q.timer = null;
        this.drain(region);
      }, WRITE_GAP_MS);
    }, WRITE_DELAY_MS);
  }

  /**
   * Say a description or an answer. Resolves when it has (probably) been read:
   * the voice's own end, or an estimate of the screen reader's. Cuts off what
   * was being said before (the caller decides whether it may: scheduler.mayInterrupt).
   * @param {{lang?: string}} [o]
   */
  say(text, { lang = this.lang() } = {}) {
    if (!text) return Promise.resolve();
    this.finish();
    const s = this.getSettings();
    const id = (this.seq += 1);
    if (this.voiceOn) {
      this.mute(true);
      this.description.setAttribute('lang', lang);
      this.description.textContent = text;
      return new Promise((resolve) => {
        this.pending = { id, resolve, timer: null };
        this.speech.speak(text, { lang, rate: s.ttsRate }).then((result) => {
          if (this.pending?.id !== id) return;
          if (result.ok) {
            this.finish();
            return;
          }
          // The voice never started: the screen reader takes over, this text included.
          this.pending = null;
          this.mute(false);
          this.onVoiceFailed();
          this.say(text, { lang }).then(resolve);
        });
      });
    }
    this.write(this.description, text, lang);
    const ms = estimateSeconds(text, s.readerSpeed) * 1000;
    return new Promise((resolve) => {
      this.pending = { id, resolve, timer: setTimeout(() => this.finish(), ms) };
    });
  }

  /**
   * A status message, in the interface language: after the description being
   * read, never over it. By voice when the voice is on (the regions are then
   * muted, so the screen reader does not say it a second time).
   */
  status(text) {
    if (!text) return Promise.resolve();
    if (this.pending) {
      return new Promise((resolve) => {
        this.afterPending.push(() => this.status(text).then(resolve));
      });
    }
    if (this.voiceOn) {
      this.mute(true);
      this.statusRegion.setAttribute('lang', this.uiLang());
      this.statusRegion.textContent = text;
      const id = (this.seq += 1);
      return new Promise((resolve) => {
        this.pending = { id, resolve, timer: null, status: true };
        this.speech.speak(text, { lang: this.uiLang(), rate: this.getSettings().ttsRate }).then(() => {
          if (this.pending?.id === id) this.finish();
        });
      });
    }
    this.write(this.statusRegion, text, this.uiLang());
    return Promise.resolve();
  }

  get speaking() {
    return Boolean(this.pending && !this.pending.status);
  }

  /** The current utterance is over: resolve it, let the regions speak again, and say what waited. */
  finish() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (this.voiceOn || this.description.getAttribute('aria-live') === 'off') this.mute(false);
    p.resolve();
    const waiting = this.afterPending;
    this.afterPending = [];
    for (const fn of waiting) fn();
  }

  /** Stop speaking at once and forget what was waiting. */
  stop() {
    const wasVoice = this.pending && this.voiceOn;
    // What waited to be read as a description goes; status that waited its turn is still said (finish() runs it).
    const q = this.queue(this.description);
    clearTimeout(q.timer);
    q.timer = null;
    q.writes = [];
    this.finish();
    if (wasVoice || this.speech?.speaking) this.speech?.cancel();
    this.mute(false);
    this.description.textContent = '';
  }
}
