// Delivers text to the user, either through their screen reader (ARIA live
// regions) or through the browser's voices (chrome.tts in the background).
//
// The two never say the same thing at once. With the built-in voice chosen, a
// listener may well have a screen reader running too (the voice is the way out
// when a screen reader does not read live regions): everything the voice says
// is still written into a region, so it can be read back and reaches a braille
// display, but the regions are not live (aria-live="off") from the moment the
// text goes in until the voice has finished, failed, been cancelled or timed
// out. If the voice cannot speak at all, the text is handed to the screen
// reader instead, and the listener is told why, once.

import { MSG } from '../shared/constants.js';
import { interfaceLocale, t } from '../shared/i18n.js';
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
/** An utterance queued behind the one being spoken may wait this much longer for its turn before the regions stop waiting for it. */
const QUEUED_VOICE_WAIT_MS = 30000;

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
  /**
   * @param {() => object} getSettings  returns current settings
   * @param {{isAudible?: () => boolean, onVoiceFailed?: (notice: string) => void}} [opts]
   *   isAudible: whether this tab's video is playing with sound right now (see speakTts). Default: yes.
   *   onVoiceFailed: called once, with the notice, when the built-in voice cannot read the descriptions
   *     (the page shows it as text too: a listener without a screen reader hears nothing at all then).
   */
  constructor(getSettings, { isAudible = () => true, onVoiceFailed = () => {} } = {}) {
    this.getSettings = getSettings;
    this.isAudible = isAudible;
    this.onVoiceFailed = onVoiceFailed;
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
    /** What the built-in voice has been asked to say and has not finished: id → { text, lang, lead, timer }. */
    this.voiced = new Map();
    /** The regions are aria-live="off" (see mute). */
    this.muted = false;
    /** The "voice cannot read this" notice has been given (it is given once per page). */
    this.voiceFailureSaid = false;
    this.mount();
    document.addEventListener('fullscreenchange', () => this.mount());
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.type !== MSG.TTS_EVENT || !this.voiced.has(msg.id)) return;
      try {
        if (!authorizeContentMessage(msg.type, sender, chrome.runtime?.id)) return;
      } catch {
        return; // a message we cannot attribute
      }
      this.onVoiceEvent(msg);
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
    // Whoever calls this wants the screen reader to say it: the regions are live, whatever the voice was doing.
    this.mute(false);
    this.writes.push({ text, urgent, lang, lead });
    this.drainWrites();
  }

  /**
   * While the built-in voice speaks, no region is live, so a screen reader that
   * is also running does not say the same words over it. The text stays in the
   * region all the same.
   */
  mute(on) {
    if (this.muted === on) return;
    this.muted = on;
    for (const r of this.polite) r.setAttribute('aria-live', on ? 'off' : 'polite');
    for (const r of this.assertive) r.setAttribute('aria-live', on ? 'off' : 'assertive');
  }

  /**
   * Text the built-in voice is about to say, put where it can be read back and
   * where a braille display finds it, without being announced: the regions are
   * muted first. Descriptions keep to one region and status to the other, so
   * the last description stays readable while a status message follows it.
   */
  showVoiced(text, { status, lang, lead }) {
    this.mount();
    this.mute(true);
    this.fill(this.polite[status ? 1 : 0], text, lang, lead);
  }

  /** Put text into a region, in its language; words in the interface language in front of it keep their own. */
  fill(region, text, lang, lead) {
    if (lead && lead !== text && text.startsWith(lead) && lang !== this.uiLang) {
      // One announcement (aria-atomic), two languages.
      region.removeAttribute('lang');
      region.replaceChildren(this.span(lead, this.uiLang), this.span(text.slice(lead.length), lang));
    } else {
      region.setAttribute('lang', lang || this.uiLang);
      region.textContent = text;
    }
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
      this.fill(region, text, lang, lead);
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
   * @param {{urgent?: boolean, status?: boolean, aside?: boolean, lang?: string, lead?: string}} opts
   *   status: a progress or state message; it never cuts off a description in flight.
   *   aside: SceneVoice's own words in answer to a key press (built-in voice only): spoken at once like a
   *     description, but kept in the status region, so the last description stays readable.
   *   lang: the language of the text: the interface language for a status message,
   *     the description language otherwise. lead: see announceToScreenReader.
   */
  say(text, { urgent = false, status = false, aside = false, lang = status ? this.uiLang : this.lang, lead = '' } = {}) {
    const s = this.getSettings();
    if (!text) return Promise.resolve();

    if (status && this.pending) {
      // Queue behind the description: live regions queue naturally; TTS uses enqueue.
      if (s.output === 'tts') this.speakTts(text, true, lang, { status: true, lead });
      else this.announceToScreenReader(text, false, { lang, lead });
      return Promise.resolve();
    }

    this.finish();
    if (s.output === 'tts' && !status) return this.speakTts(text, false, lang, { status: aside, lead });

    this.announceToScreenReader(text, urgent || (s.interrupt && !status), { lang, lead });
    const ms = estimateSeconds(text, s.readerSpeed) * 1000;
    return new Promise((resolve) => {
      const id = `u${(this.seq += 1)}`;
      this.pending = { id, resolve, timer: setTimeout(() => this.finish(), ms) };
    });
  }

  /**
   * Say text with the built-in voice. The text also goes into a muted region
   * (showVoiced), and the regions stay muted until the service worker reports
   * how the utterance ended, or, if it never does, until the utterance should
   * long be over.
   * @param {string} [lang]  the language of the text, which picks the voice; the description language unless said otherwise
   * @param {{status?: boolean, lead?: string}} [o]  status: interface words, kept in the status region. lead: see announceToScreenReader.
   */
  speakTts(text, enqueue, lang = this.lang, { status = false, lead = '' } = {}) {
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
    this.showVoiced(text, { status, lang, lead });
    this.voiced.set(id, { text, lang, lead, timer: setTimeout(() => this.voiceOver(id), fallback + (enqueue ? QUEUED_VOICE_WAIT_MS : 0)) });
    return new Promise((resolve) => {
      if (enqueue) {
        sendSafe({ ...msg, enqueue: true }).then((res) => {
          if (!res) this.voiceOver(id);
        });
        resolve();
        return;
      }
      this.pending = { id, resolve, timer: setTimeout(() => this.finish(), fallback) };
      sendSafe(msg).then((res) => {
        if (res) return;
        // The service worker is gone: nothing will be spoken, and no event will come.
        this.voiceOver(id);
        if (this.pending?.id === id) this.finish();
      });
    });
  }

  /** One utterance of the voice is over, however it ended: forget it, and unmute once none is left. Returns what it was. */
  voiceOver(id) {
    const entry = this.voiced.get(id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.voiced.delete(id);
    if (!this.voiced.size) this.mute(false);
    return entry;
  }

  /**
   * How an utterance ended, from the service worker: end, interrupted,
   * cancelled or error; `noVoice` when this computer has no voice for the
   * text's language (the browser then reads with whatever it has, often
   * silently). After an error the text was not spoken: the screen reader gets
   * it, and a description in flight is given the time the screen reader needs.
   */
  onVoiceEvent(msg) {
    const entry = this.voiceOver(msg.id);
    const failed = msg.event === 'error';
    if (failed || msg.noVoice) this.voiceFailed(entry, failed);
    if (this.pending?.id !== msg.id) return;
    if (!failed) {
      this.finish();
      return;
    }
    clearTimeout(this.pending.timer);
    this.pending.timer = setTimeout(() => this.finish(), estimateSeconds(entry.text, this.getSettings().readerSpeed) * 1000);
  }

  /**
   * The built-in voice could not read something. Said once per page, through
   * the live region (now live again) and to the page (onVoiceFailed), in place
   * of silence; `redeliver`: the text itself was never spoken, so the screen
   * reader is given it too, this time and every time after.
   */
  voiceFailed(entry, redeliver) {
    const notice = t('status_voice_failed');
    if (!this.voiceFailureSaid) {
      this.voiceFailureSaid = true;
      this.announceToScreenReader(notice, false);
      this.onVoiceFailed(notice);
    }
    if (redeliver && entry?.text) this.announceToScreenReader(entry.text, false, { lang: entry.lang, lead: entry.lead });
  }

  /**
   * Status messages (in the interface language): through the screen reader, or by voice for built-in voice users
   * (then written to a muted region as well: readable and on a braille display, but not said twice).
   * Never cuts off a description being read. `always`: said even with status messages turned off (an answer the
   * listener asked for, such as the list of shortcuts).
   */
  status(text, { always = false } = {}) {
    const s = this.getSettings();
    if ((!s.announceStatus && !always) || !text) return Promise.resolve();
    if (s.output === 'tts') return this.pending ? this.say(text, { status: true }) : this.speakTts(text, false, this.uiLang, { status: true });
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
    // Ours to stop: an utterance of this page the voice has not finished (chrome.tts.stop() is global).
    const wasTts = (this.pending && this.getSettings().output === 'tts') || this.voiced.size > 0;
    this.finish();
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.writes = [];
    if (wasTts) sendSafe({ type: MSG.STOP_SPEAKING });
    for (const r of [...this.polite, ...this.assertive]) r.textContent = '';
    // Emptied first, then live again: nothing is left for the screen reader to pick up.
    for (const id of [...this.voiced.keys()]) this.voiceOver(id);
    this.mute(false);
  }
}
