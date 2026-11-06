// The browser's voice (Web Speech API) for the web player, with the quirks
// smoothed over: voices arrive late in Chrome (voiceschanged), desktop Chrome
// cuts a remote voice off after about 15 seconds (so text is spoken in short
// chunks and kept alive), iOS Safari speaks only after a user gesture (unlock()
// on the first press), and cancel() reports the interrupted utterance as an
// error, which is not a failure. The synthesis object is injectable for tests.

import { groupVoices } from '../shared/voices.js';

/** Longest chunk handed to the voice: well under Chrome's cut-off. */
const CHUNK_CHARS = 180;
/** A voice that has not started within this long is taken as not working. */
const START_TIMEOUT_MS = 4000;
/** Desktop Chrome keep-alive (never on Android, where pause() cancels). */
const KEEPALIVE_MS = 8000;
/** Chrome breaks above 2; the extension's slider goes to 3. */
const MAX_RATE = 2;

/** Sentence-sized pieces of at most CHUNK_CHARS characters, in order. */
export function chunkText(text, max = CHUNK_CHARS) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  if (s.length <= max) return [s];
  // Split after sentence ends without a lookbehind, which Safari before 16.4 cannot parse.
  const parts = s.replace(/([.!?。！？；;])\s*/g, '$1\u0000').split('\u0000').filter(Boolean);
  const out = [];
  let current = '';
  for (const p of parts) {
    if (!current) current = p;
    else if ((current + ' ' + p).length <= max) current = `${current} ${p}`;
    else {
      out.push(current);
      current = p;
    }
  }
  if (current) out.push(current);
  // A single sentence longer than max is cut at spaces (or hard, for CJK).
  return out.flatMap((piece) => {
    if (piece.length <= max) return [piece];
    const words = piece.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      if (w.length > max) {
        if (line) lines.push(line);
        line = '';
        for (let i = 0; i < w.length; i += max) lines.push(w.slice(i, i + max));
      } else if ((line + ' ' + w).trim().length <= max) line = `${line} ${w}`.trim();
      else {
        lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines;
  });
}

export class WebSpeech {
  /**
   * @param {object} [o]
   * @param {SpeechSynthesis} [o.synth]
   * @param {typeof SpeechSynthesisUtterance} [o.Utterance]
   * @param {string} [o.userAgent]
   */
  constructor({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, userAgent = globalThis.navigator?.userAgent || '' } = {}) {
    this.synth = synth || null;
    this.Utterance = typeof Utterance === 'function' ? Utterance : null;
    this.android = /Android/i.test(userAgent);
    this.voices = [];
    this.current = null; // { utterances, resolve, timer, keepalive }
    this.unlocked = false;
    if (this.synth) {
      this.refreshVoices();
      try {
        this.synth.addEventListener?.('voiceschanged', () => this.refreshVoices());
      } catch {
        /* older browsers */
      }
      // Firefox desktop never fires voiceschanged: poll a little.
      let tries = 0;
      const poll = () => {
        if (this.voices.length || tries >= 8) return;
        tries += 1;
        this.refreshVoices();
        setTimeout(poll, 250);
      };
      setTimeout(poll, 250);
    }
  }

  get available() {
    return Boolean(this.synth && this.Utterance);
  }

  refreshVoices() {
    try {
      this.voices = this.synth?.getVoices?.() || [];
    } catch {
      this.voices = [];
    }
  }

  /** The best installed voice for a language: the closest tag, a local one before a remote one; null to let the browser choose. */
  voiceFor(lang) {
    const { matching } = groupVoices(this.voices.map((v) => ({ name: v.name, lang: v.lang, voice: v })), lang);
    if (!matching.length) return null;
    const best = matching[0].score;
    const top = matching.filter((v) => v.score === best);
    return (top.find((v) => v.voice.localService) || top[0]).voice;
  }

  /** iOS Safari speaks only from a user gesture: say nothing audible once, from the first press. */
  unlock() {
    if (this.unlocked || !this.available) return;
    this.unlocked = true;
    try {
      const u = new this.Utterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch {
      /* nothing to unlock */
    }
  }

  /**
   * Speak text. Resolves { ok: true } when the voice has finished, { ok: false }
   * when it never started (no voice, or speech blocked), and { ok: true,
   * cancelled: true } when cancel() cut it short.
   */
  speak(text, { lang = 'en', rate = 1, pitch = 1 } = {}) {
    this.cancel();
    if (!this.available) return Promise.resolve({ ok: false });
    const chunks = chunkText(text);
    if (!chunks.length) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      const voice = this.voiceFor(lang);
      const state = { utterances: [], resolve, timer: null, keepalive: null, started: false, done: 0 };
      this.current = state;
      const finish = (result) => {
        if (this.current !== state) return;
        this.current = null;
        clearTimeout(state.timer);
        clearInterval(state.keepalive);
        resolve(result);
      };
      state.finish = finish;
      for (const chunk of chunks) {
        const u = new this.Utterance(chunk);
        u.lang = lang;
        if (voice) u.voice = voice;
        u.rate = Math.min(MAX_RATE, Math.max(0.5, Number(rate) || 1));
        u.pitch = Math.min(2, Math.max(0, Number(pitch) || 1));
        u.onstart = () => {
          state.started = true;
          clearTimeout(state.timer);
        };
        u.onend = () => {
          state.done += 1;
          if (state.done >= chunks.length) finish({ ok: true });
        };
        u.onerror = (e) => {
          const why = e?.error || '';
          if (why === 'interrupted' || why === 'canceled') return finish({ ok: true, cancelled: true });
          finish({ ok: state.started });
        };
        state.utterances.push(u); // kept until the end: Chrome drops events of collected utterances
      }
      state.timer = setTimeout(() => {
        if (!state.started) {
          try {
            this.synth.cancel();
          } catch {
            /* nothing to cancel */
          }
          finish({ ok: false });
        }
      }, START_TIMEOUT_MS);
      if (!this.android) {
        state.keepalive = setInterval(() => {
          try {
            if (this.synth.speaking && !this.synth.paused) {
              this.synth.pause();
              this.synth.resume();
            }
          } catch {
            /* ignore */
          }
        }, KEEPALIVE_MS);
      }
      try {
        for (const u of state.utterances) this.synth.speak(u);
      } catch {
        finish({ ok: false });
      }
    });
  }

  get speaking() {
    return Boolean(this.current);
  }

  cancel() {
    const state = this.current;
    if (state) state.finish({ ok: true, cancelled: true });
    try {
      this.synth?.cancel();
    } catch {
      /* nothing was speaking */
    }
  }
}
