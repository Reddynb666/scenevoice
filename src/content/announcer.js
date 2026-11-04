// Delivers text to the user, either through their screen reader (ARIA live
// regions) or through the browser's voices (chrome.tts in the background).

import { MSG } from '../shared/constants.js';
import { interfaceLocale } from '../shared/i18n.js';
import { authorizeContentMessage } from '../shared/sender.js';
import { estimateSeconds } from '../shared/script.js';
import { voiceFor } from '../shared/settings.js';
import { containerForOverlays } from './dom.js';

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

/** Delay before a live region is filled, and the gap kept before the next write. */
const WRITE_DELAY_MS = 30;
const WRITE_GAP_MS = 60;

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
  /**
   * @param {() => object} getSettings  returns current settings
   * @param {{isAudible?: () => boolean}} [opts]
   *   isAudible: whether this tab's video is playing with sound right now (see speakTts). Default: yes.
   */
  constructor(getSettings, { isAudible = () => true } = {}) {
    this.getSettings = getSettings;
    this.isAudible = isAudible;
    this.host = document.createElement('div');
    this.host.dataset.scenevoice = 'announcer';
    this.host.style.cssText = HIDDEN_STYLE;
    // Two regions of each kind, used alternately, so identical text is still re-announced.
    this.polite = [makeRegion('polite'), makeRegion('polite')];
    this.assertive = [makeRegion('assertive'), makeRegion('assertive')];
    this.host.append(...this.polite, ...this.assertive);
    /** The language of the interface strings (status, errors, notices): what t() returns, not the browser's locale. */
    this.uiLang = interfaceLocale();
    this.lang = 'en';
    this.flip = 0;
    this.pending = null; // { id, resolve, timer }
    /** Texts waiting to be written to a live region, oldest first. */
    this.writes = [];
    this.writeTimer = null;
    this.seq = 0;
    this.mount();
    document.addEventListener('fullscreenchange', () => this.mount());
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.type !== MSG.TTS_EVENT || !this.pending || msg.id !== this.pending.id) return;
      try {
        if (authorizeContentMessage(msg.type, sender, chrome.runtime?.id)) this.finish();
      } catch {
        // Ignore a message we cannot attribute.
      }
    });
  }

  /**
   * The description language: what descriptions and answers are written and
   * spoken in. Each write carries its own language (see announceToScreenReader),
   * since the same live regions also hold status and error text in the
   * interface language, and a screen reader that switches voices by language
   * must read each in the right one.
   */
  get lang() {
    return this._lang;
  }

  set lang(value) {
    this._lang = value || 'en';
  }

  mount() {
    const parent = containerForOverlays();
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  }

  /**
   * Put text into a live region without waiting for speech. Writes are made one
   * after the other: two messages in quick succession ("Descriptions loaded",
   * then what the video type changed) are both read, not only the last.
   * @param {{lang?: string, lead?: string}} [opts]
   *   lang: the language of the text; the interface language unless said otherwise (status, errors).
   *   lead: words in the interface language the text begins with ("Earlier: " before a description),
   *     marked with their own language so the voice changes after them.
   */
  announceToScreenReader(text, urgent, { lang = this.uiLang, lead = '' } = {}) {
    this.writes.push({ text, urgent, lang, lead });
    this.drainWrites();
  }

  drainWrites() {
    if (this.writeTimer || !this.writes.length) return;
    this.mount();
    const { text, urgent, lang, lead } = this.writes.shift();
    const pair = urgent ? this.assertive : this.polite;
    const region = pair[this.flip % 2];
    const other = pair[(this.flip + 1) % 2];
    this.flip += 1;
    other.textContent = '';
    region.textContent = '';
    // A short delay makes screen readers notice the change reliably; the next
    // write waits a little longer, so that each change is seen on its own.
    this.writeTimer = setTimeout(() => {
      if (lead && lead !== text && text.startsWith(lead) && lang !== this.uiLang) {
        // One announcement (aria-atomic), two languages.
        region.removeAttribute('lang');
        region.replaceChildren(this.span(lead, this.uiLang), this.span(text.slice(lead.length), lang));
      } else {
        region.setAttribute('lang', lang || this.uiLang);
        region.textContent = text;
      }
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        this.drainWrites();
      }, WRITE_GAP_MS);
    }, WRITE_DELAY_MS);
  }

  span(text, lang) {
    const el = document.createElement('span');
    el.setAttribute('lang', lang);
    el.textContent = text;
    return el;
  }

  /**
   * Speak text. Resolves when speech has (probably) finished.
   * @param {string} text
   * @param {{urgent?: boolean, status?: boolean, lang?: string, lead?: string}} opts
   *   status: a progress or state message; it never cuts off a description in flight.
   *   lang: the language of the text: the interface language for a status message,
   *     the description language otherwise. lead: see announceToScreenReader.
   */
  say(text, { urgent = false, status = false, lang = status ? this.uiLang : this.lang, lead = '' } = {}) {
    const s = this.getSettings();
    if (!text) return Promise.resolve();

    if (status && this.pending) {
      // Queue behind the description: live regions queue naturally; TTS uses enqueue.
      if (s.output === 'tts') this.speakTts(text, true, lang);
      else this.announceToScreenReader(text, false, { lang, lead });
      return Promise.resolve();
    }

    this.finish();
    if (s.output === 'tts' && !status) return this.speakTts(text, false, lang);

    this.announceToScreenReader(text, urgent || (s.interrupt && !status), { lang, lead });
    const ms = estimateSeconds(text, s.readerSpeed) * 1000;
    return new Promise((resolve) => {
      const id = `u${(this.seq += 1)}`;
      this.pending = { id, resolve, timer: setTimeout(() => this.finish(), ms) };
    });
  }

  /** @param {string} [lang]  the language of the text, which picks the voice; the description language unless said otherwise */
  speakTts(text, enqueue, lang = this.lang) {
    const s = this.getSettings();
    // A hidden tab whose video is paused or muted must not talk over the tab
    // the user is watching (with two tabs open, YouTube pauses the one in the
    // background). A hidden tab whose video plays with sound is being listened
    // to, from another window or with the screen off: it keeps describing.
    // The wait stands in for the speech, so the scheduler is not thrown off.
    if (document.visibilityState !== 'visible' && !this.isAudible()) {
      return new Promise((resolve) => setTimeout(resolve, estimateSeconds(text, s.ttsRate) * 1000));
    }
    const id = `u${(this.seq += 1)}`;
    const fallback = (estimateSeconds(text, s.ttsRate) * 2 + 3) * 1000;
    const msg = { type: MSG.SPEAK, text, lang, rate: s.ttsRate, pitch: s.ttsPitch, ...voiceFor(s, lang), id };
    return new Promise((resolve) => {
      if (enqueue) {
        sendSafe({ ...msg, enqueue: true });
        resolve();
        return;
      }
      this.pending = { id, resolve, timer: setTimeout(() => this.finish(), fallback) };
      sendSafe(msg).then((res) => {
        if (!res) this.finish();
      });
    });
  }

  /** Status messages (in the interface language): to the screen reader always (also braille), by voice for TTS users. */
  status(text) {
    const s = this.getSettings();
    if (!s.announceStatus || !text) return Promise.resolve();
    if (s.output === 'tts') {
      this.announceToScreenReader(text, false);
      return this.pending ? this.say(text, { status: true }) : this.speakTts(text, false, this.uiLang);
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
    this.writeTimer = null;
    this.writes = [];
    if (wasTts) sendSafe({ type: MSG.STOP_SPEAKING });
    for (const r of [...this.polite, ...this.assertive]) r.textContent = '';
  }
}
