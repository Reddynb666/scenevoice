// Delivers text to the user, either through their screen reader (ARIA live
// regions) or through the browser's voices (chrome.tts in the background).

import { MSG } from '../shared/constants.js';
import { estimateSeconds } from '../shared/script.js';
import { containerForOverlays } from './youtube.js';

const HIDDEN_STYLE = [
  'position:absolute',
  'width:1px',
  'height:1px',
  'margin:-1px',
  'padding:0',
  'overflow:hidden',
  'clip:rect(0 0 0 0)',
  'clip-path:inset(50%)',
  'white-space:nowrap',
  'border:0',
].join(';');

function makeRegion(politeness) {
  const el = document.createElement('div');
  el.setAttribute('aria-live', politeness);
  el.setAttribute('aria-atomic', 'true');
  el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
  el.dataset.scenevoice = 'live';
  el.style.cssText = HIDDEN_STYLE;
  return el;
}

/** chrome.runtime.sendMessage throws synchronously once the extension has been reloaded. */
function sendSafe(msg) {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export class Announcer {
  /** @param {() => object} getSettings  returns current settings */
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.lang = 'en';
    this.host = document.createElement('div');
    this.host.dataset.scenevoice = 'announcer';
    this.host.style.cssText = HIDDEN_STYLE;
    // Two regions of each kind, used alternately, so identical text is still re-announced.
    this.polite = [makeRegion('polite'), makeRegion('polite')];
    this.assertive = [makeRegion('assertive'), makeRegion('assertive')];
    this.host.append(...this.polite, ...this.assertive);
    this.flip = 0;
    this.pending = null; // { id, resolve, timer }
    this.writeTimer = null;
    this.seq = 0;
    this.mount();
    document.addEventListener('fullscreenchange', () => this.mount());
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === MSG.TTS_EVENT && this.pending && msg.id === this.pending.id) this.finish();
    });
  }

  mount() {
    const parent = containerForOverlays();
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  }

  /** Put text into a live region without waiting for speech. */
  announceToScreenReader(text, urgent) {
    this.mount();
    clearTimeout(this.writeTimer);
    const pair = urgent ? this.assertive : this.polite;
    const region = pair[this.flip % 2];
    const other = pair[(this.flip + 1) % 2];
    this.flip += 1;
    other.textContent = '';
    region.textContent = '';
    // A short delay makes screen readers notice the change reliably.
    this.writeTimer = setTimeout(() => {
      region.textContent = text;
    }, 30);
  }

  /**
   * Speak text. Resolves when speech has (probably) finished.
   * @param {string} text
   * @param {{urgent?: boolean, status?: boolean}} opts
   *   status: a progress or state message; it never cuts off a description in flight.
   */
  say(text, { urgent = false, status = false } = {}) {
    const s = this.getSettings();
    if (!text) return Promise.resolve();

    if (status && this.pending) {
      // Queue behind the description: live regions queue naturally; TTS uses enqueue.
      if (s.output === 'tts') this.speakTts(text, true);
      else this.announceToScreenReader(text, false);
      return Promise.resolve();
    }

    this.finish();
    if (s.output === 'tts' && !status) return this.speakTts(text, false);

    this.announceToScreenReader(text, urgent || (s.interrupt && !status));
    const ms = estimateSeconds(text, s.readerSpeed) * 1000;
    return new Promise((resolve) => {
      const id = `u${(this.seq += 1)}`;
      this.pending = { id, resolve, timer: setTimeout(() => this.finish(), ms) };
    });
  }

  speakTts(text, enqueue) {
    const s = this.getSettings();
    // A background tab must not talk over the one the user is watching.
    if (document.visibilityState !== 'visible') {
      return new Promise((resolve) => setTimeout(resolve, estimateSeconds(text, s.ttsRate) * 1000));
    }
    const id = `u${(this.seq += 1)}`;
    const fallback = (estimateSeconds(text, s.ttsRate) * 2 + 3) * 1000;
    return new Promise((resolve) => {
      if (enqueue) {
        sendSafe({ type: MSG.SPEAK, text, lang: this.lang, rate: s.ttsRate, voice: s.ttsVoice, id, enqueue: true });
        resolve();
        return;
      }
      this.pending = { id, resolve, timer: setTimeout(() => this.finish(), fallback) };
      sendSafe({ type: MSG.SPEAK, text, lang: this.lang, rate: s.ttsRate, voice: s.ttsVoice, id }).then((res) => {
        if (!res) this.finish();
      });
    });
  }

  /** Status messages: to the screen reader always (also braille), by voice for TTS users. */
  status(text) {
    const s = this.getSettings();
    if (!s.announceStatus || !text) return Promise.resolve();
    if (s.output === 'tts') {
      this.announceToScreenReader(text, false);
      return this.pending ? this.say(text, { status: true }) : this.speakTts(text, false);
    }
    return this.say(text, { status: true });
  }

  get speaking() {
    return Boolean(this.pending);
  }

  finish() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve();
  }

  stop() {
    const wasTts = this.pending && this.getSettings().output === 'tts';
    this.finish();
    clearTimeout(this.writeTimer);
    if (wasTts) sendSafe({ type: MSG.STOP_SPEAKING });
    for (const r of [...this.polite, ...this.assertive]) r.textContent = '';
  }
}
