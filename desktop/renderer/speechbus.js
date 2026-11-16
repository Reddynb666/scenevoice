// SpeechBus: the only code in the shell that makes sound or writes a live
// region, so the shell never says two things at once.
//
// Descriptions go through one of two channels:
//   'app'    the shell's own voice (Web Speech API), the film turned down under it;
//   'reader' a polite live region, read by the user's own screen reader.
// Status messages always go to the status region (role="status") and never cut
// a description off: they queue behind it. While the app voice speaks, the live
// regions are aria-live="off".
//
// The rule from the plan for the screen reader's own speech, which the shell
// cannot control: when the user does something that makes the screen reader
// talk (moves the focus, opens a dialog or a menu, presses X), the app voice
// stops the current description at once and does not say it again (it stays in
// the log; R repeats it), and whatever the shell has to say next waits 1.5 s.
// While a dialog or a native menu stays open the shell says nothing at all (the
// screen reader is reading it, for longer than 1.5 s): descriptions that come
// due are logged, not spoken, and the 1.5 s run from the moment it closes. The
// same holds for the native Open and Save dialogs.
//
// When the app voice cannot say something (it reports an error, or never
// reports back, or the computer has no voice for the language), descriptions
// go to the screen reader from then on, the one that failed included, and the
// page is told so that it can say what happened. A failed utterance is never
// taken for one that was heard.
//
// BusCore is the pure part (queueing, what may interrupt what, which channel):
// no DOM, no timers, the clock is passed in, each call returns the effects to
// carry out. SpeechBus carries them out in the page.

/** How long the shell stays silent after the user made the screen reader talk. */
export const HOLD_MS = 1500;
/** Pause between the app voice stopping and the next thing said or written. */
export const SETTLE_MS = 120;
/** A description that waited this long is not spoken any more (it is in the log). */
export const STALE_MS = 6000;
/** The film's volume while the app voice speaks, as a share of its own volume. */
export const DUCK_VOLUME = 0.35;
export const DUCK_RAMP_MS = 250;
/** Screen reader users listen fast; the real rate per reader is something K3 measures. */
export const READER_RATE = 1.5;
/** Chrome's voices break above 2. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

/** How an utterance ends when the voice worked: by itself, or because it was stopped. */
const VOICE_ENDINGS = new Set(['end', 'interrupted', 'canceled']);

const MAX_QUEUED_STATUS = 6;
const WRITE_DELAY_MS = 30;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
const PAUSES = /[，。！？；：、,.!?;:]/g;

export function clampRate(rate) {
  const n = Number(rate);
  return Number.isFinite(n) ? Math.min(MAX_RATE, Math.max(MIN_RATE, n)) : 1;
}

/**
 * Where an item is delivered.
 * @param {'description'|'answer'|'status'} kind
 * @param {'app'|'reader'} channel
 * @returns {'voice'|'reader'|'status'}
 */
export function sinkFor(kind, channel) {
  if (kind === 'status') return 'status';
  return channel === 'reader' ? 'reader' : 'voice';
}

/**
 * Whether a new item cuts off what is being said. Only what the user asked for
 * just now does: an answer (D, R, W) or the key list. A timed description never
 * cuts off another one, and a status never cuts off anything.
 */
export function mayInterrupt(incoming) {
  return incoming.kind === 'answer' || (incoming.kind === 'status' && incoming.urgent === true);
}

/** The queued item to say next: what the user asked for, then descriptions, then status. */
export function nextIndex(queue) {
  const asked = queue.findIndex((q) => mayInterrupt(q));
  if (asked >= 0) return asked;
  const description = queue.findIndex((q) => q.kind === 'description');
  return description >= 0 ? description : 0;
}

/** About how long a voice takes to say this, in milliseconds. */
export function estimateSpeechMs(text, rate = 1) {
  const s = String(text || '');
  const cjk = (s.match(CJK) || []).length;
  const other = s.replace(CJK, '').replace(/\s+/g, ' ').trim().length;
  const pauses = (s.match(PAUSES) || []).length;
  const seconds = cjk / 4.5 + other / 15 + pauses * 0.25;
  return Math.max(800, Math.round((seconds * 1000) / clampRate(rate)));
}

function normLang(lang) {
  return String(lang || '').replace(/_/g, '-').toLowerCase();
}

/**
 * The installed voice for a language, or null. Never a voice that needs the
 * network. For Chinese, Mandarin (zh-CN, then zh-TW) before Cantonese.
 * @param {{lang: string, localService?: boolean, default?: boolean}[]} voices
 */
export function pickVoice(voices, lang) {
  const want = normLang(lang);
  const primary = want.split('-')[0];
  if (!primary) return null;
  let best = null;
  let bestScore = -1;
  for (const voice of voices || []) {
    if (!voice || voice.localService === false) continue;
    const have = normLang(voice.lang);
    if (have.split('-')[0] !== primary) continue;
    let score = 0;
    if (have === want) score += 8;
    else if (primary === 'zh' && /^zh-(cn|hans)/.test(have)) score += 6;
    else if (primary === 'zh' && /^zh-tw/.test(have)) score += 4;
    else if (primary === 'en' && /^en-(us|gb)/.test(have)) score += 2;
    if (voice.default) score += 1;
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

/**
 * What an installed voice list means for the app voice.
 *   'loading': the list is empty and may still arrive (Chromium fills it a moment after the page starts);
 *   'none':    no voice at all, or none for the language: descriptions may not be spoken;
 *   'ok':      a voice for the language is installed.
 * @param {{lang: string, localService?: boolean}[]} voices
 * @param {string} lang
 * @param {boolean} settled  the list has had its time to arrive
 * @returns {'loading'|'none'|'ok'}
 */
export function voiceState(voices, lang, settled) {
  if (pickVoice(voices, lang)) return 'ok';
  return (voices || []).length || settled ? 'none' : 'loading';
}

/**
 * The block a "the screen reader is busy" event of the main process stands for. A native dialog
 * gets a reason of its own: 'dialog' is the page's own dialog, which may be open at the same time,
 * and the block of a menu is lifted by any key that reaches the page, which must not lift this one.
 * @param {string} cause  'menu' | 'dialog'
 * @returns {'menu'|'native'}
 */
export function blockReason(cause) {
  return cause === 'dialog' ? 'native' : 'menu';
}

/** The film's volume part-way through a ramp (progress 0 to 1). */
export function volumeAt(from, to, progress) {
  const p = Math.min(1, Math.max(0, progress));
  return Math.min(1, Math.max(0, from + (to - from) * p));
}

function cleanText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The pure core. Items: { id, kind, text, lang, urgent, tag, remember, log, time, at }.
 * Effects, in the order to carry them out:
 *   { type: 'speak', item }                     start the app voice
 *   { type: 'cancel' }                          stop the app voice
 *   { type: 'write', region, item }             put text in the 'status' or 'reader' live region
 *   { type: 'live', status, reader }            set aria-live of the two regions ('polite' | 'off')
 *   { type: 'duck', on }                        turn the film down or back up
 *   { type: 'log', item }                       append a description to the log
 *   { type: 'current', item }                   show it on the current-description line
 *   { type: 'note', what, item, cause }         for the diagnostic log: 'cut', 'skipped', 'failed'
 *     ('failed': the app voice could not say it; the channel is 'reader' from here on)
 */
export class BusCore {
  /** @param {{channel?: 'app'|'reader', rate?: number}} [o] */
  constructor({ channel = 'app', rate = 1 } = {}) {
    this.channel = channel === 'reader' ? 'reader' : 'app';
    this.rate = clampRate(rate);
    /** What is being said now: { item, sink, until }. */
    this.current = null;
    this.queue = [];
    this.holdUntil = 0;
    /** Why the shell must say nothing for now: 'dialog', 'menu', 'native'. Empty when it may speak. */
    this.blocks = new Set();
    /** The last description, for R: kept when it was cut off or never spoken. */
    this.last = null;
    this.seq = 0;
  }

  live(on) {
    return { type: 'live', status: on ? 'polite' : 'off', reader: on && this.channel === 'reader' ? 'polite' : 'off' };
  }

  /**
   * Something to say.
   * @param {{kind: 'description'|'answer'|'status', text: string, lang?: string, urgent?: boolean,
   *          tag?: string, remember?: boolean, log?: boolean, time?: number}} input
   *   tag: a status with a tag replaces a waiting status with the same tag (the position
   *   after each of several seeks: only the last one is worth saying).
   * @param {number} now  milliseconds on any steady clock
   */
  say(input, now) {
    const text = cleanText(input && input.text);
    if (!text) return [];
    const kind = input.kind === 'description' || input.kind === 'answer' ? input.kind : 'status';
    const item = {
      id: ++this.seq,
      kind,
      text,
      lang: input.lang || '',
      urgent: kind === 'status' && input.urgent === true,
      tag: kind === 'status' && typeof input.tag === 'string' ? input.tag : '',
      remember: kind !== 'status' && input.remember === true,
      log: kind !== 'status' && input.log === true,
      time: Number.isFinite(input.time) ? input.time : null,
      at: now,
    };
    const effects = [];
    if (item.kind !== 'status') effects.push({ type: 'current', item });
    if (item.log) effects.push({ type: 'log', item });
    if (item.remember) this.last = item;
    if (item.kind === 'answer') {
      // The newest thing the user asked for replaces an older one still waiting.
      this.queue = this.queue.filter((q) => q.kind !== 'answer');
    } else if (item.kind === 'status') {
      // The same message again, or a newer one about the same thing, replaces the one waiting.
      this.queue = this.queue.filter((q) => !(q.kind === 'status' && (q.text === item.text || (item.tag && q.tag === item.tag))));
      const waiting = this.queue.filter((q) => q.kind === 'status');
      if (waiting.length >= MAX_QUEUED_STATUS) this.queue.splice(this.queue.indexOf(waiting[0]), 1);
    }
    this.queue.push(item);
    if (this.current && mayInterrupt(item)) effects.push(...this.cut('asked', now));
    effects.push(...this.pump(now));
    return effects;
  }

  /** Stop what is being said, without saying it again. */
  cut(cause, now) {
    const { item, sink } = this.current;
    this.current = null;
    const effects = [];
    if (sink === 'voice') {
      effects.push({ type: 'cancel' }, { type: 'duck', on: false }, this.live(true));
      this.holdUntil = Math.max(this.holdUntil, now + SETTLE_MS);
    }
    effects.push({ type: 'note', what: 'cut', cause, item });
    return effects;
  }

  /** Start the next queued item when nothing is being said, nothing is open and no hold is running. */
  pump(now) {
    const effects = [];
    if (this.current) return effects;
    this.queue = this.queue.filter((q) => {
      if (q.kind !== 'description' || now - q.at <= STALE_MS) return true;
      effects.push({ type: 'note', what: 'skipped', cause: 'stale', item: q });
      return false;
    });
    if (!this.queue.length || this.blocks.size || now < this.holdUntil) return effects;
    const [item] = this.queue.splice(nextIndex(this.queue), 1);
    const sink = sinkFor(item.kind, this.channel);
    if (sink === 'voice') {
      // `until` is a watchdog here: the voice itself reports when it has finished.
      this.current = { item, sink, until: now + estimateSpeechMs(item.text, this.rate) * 3 + 5000 };
      effects.push(this.live(false), { type: 'duck', on: true }, { type: 'speak', item });
    } else {
      // A screen reader gives no "finished" signal: the estimate stands in for it.
      this.current = { item, sink, until: now + estimateSpeechMs(item.text, READER_RATE) };
      effects.push({ type: 'write', region: sink, item });
    }
    return effects;
  }

  end(now) {
    const { sink } = this.current;
    this.current = null;
    const effects = [];
    if (sink === 'voice') {
      effects.push({ type: 'duck', on: false }, this.live(true));
      this.holdUntil = Math.max(this.holdUntil, now + SETTLE_MS);
    }
    effects.push(...this.pump(now));
    return effects;
  }

  /** The app voice finished the utterance with this id. */
  finished(id, now) {
    if (!this.current || this.current.sink !== 'voice' || this.current.item.id !== id) return [];
    return this.end(now);
  }

  /**
   * The app voice could not say the utterance with this id: it reported an error, or never
   * reported back. A voice that failed once is not tried again by itself: descriptions go to the
   * screen reader from here on, and this one first, unless it has waited too long by now.
   * @param {string} cause  the voice's error, or 'timeout'
   */
  failed(id, cause, now) {
    if (!this.current || this.current.sink !== 'voice' || this.current.item.id !== id) return [];
    const { item } = this.current;
    this.current = null;
    this.channel = 'reader';
    this.queue.unshift(item);
    this.holdUntil = Math.max(this.holdUntil, now + SETTLE_MS);
    return [{ type: 'cancel' }, { type: 'note', what: 'failed', cause, item }, { type: 'duck', on: false }, this.live(true), ...this.pump(now)];
  }

  /**
   * The app voice is known to be of no use before it has failed: the computer has no voice for
   * the language. Descriptions go to the screen reader from here on, what the voice is in the
   * middle of included.
   * @param {string} cause  'no-voice'
   * @returns {object[]} effects; empty when the screen reader reads descriptions already
   */
  noVoice(cause, now) {
    if (this.channel === 'reader') return [];
    if (this.current && this.current.sink === 'voice') return this.failed(this.current.item.id, cause, now);
    this.channel = 'reader';
    return [this.live(true), ...this.pump(now)];
  }

  /** Time has passed: an estimate ran out, a hold ended, or the voice never reported back. */
  tick(now) {
    if (this.current && now >= this.current.until) {
      if (this.current.sink !== 'voice') return this.end(now);
      return this.failed(this.current.item.id, 'timeout', now);
    }
    return this.pump(now);
  }

  /** When tick() has to be called next, or null when nothing is waiting. */
  wakeAt() {
    if (this.current) return this.current.until;
    // While something is open, closing it is what wakes the bus.
    return this.queue.length && !this.blocks.size ? this.holdUntil : null;
  }

  /**
   * The user did something that makes the screen reader talk: stop the current
   * item at once, do not repeat it, and stay silent for HOLD_MS.
   */
  userActed(cause, now) {
    const effects = this.current ? this.cut(cause, now) : [];
    this.holdUntil = Math.max(this.holdUntil, now + HOLD_MS);
    return effects;
  }

  /**
   * A dialog or a native menu opened (on) or closed. While one is open the
   * screen reader is reading it and the shell says nothing itself: what is being
   * said stops, descriptions that come due are logged and wait (and are dropped
   * when they have waited too long), status messages wait. After the last one
   * closes the usual hold runs, for the screen reader to say where the focus is.
   * @param {string} reason  'dialog' (in the page) | 'menu' | 'native' (a native dialog)
   */
  setBlocked(reason, on, now) {
    if (on) {
      this.blocks.add(reason);
      return this.current ? this.cut(reason, now) : [];
    }
    if (!this.blocks.delete(reason)) return [];
    this.holdUntil = Math.max(this.holdUntil, now + HOLD_MS);
    return this.pump(now);
  }

  /** S: stop the description being spoken and drop those waiting. Status messages stay. */
  stop(now) {
    const effects = this.current && this.current.sink !== 'status' ? this.cut('stop', now) : [];
    this.queue = this.queue.filter((q) => q.kind === 'status');
    effects.push(...this.pump(now));
    return effects;
  }

  setChannel(channel, now) {
    const next = channel === 'reader' ? 'reader' : 'app';
    if (next === this.channel) return [];
    const effects = this.current && this.current.sink !== 'status' ? this.cut('channel', now) : [];
    this.channel = next;
    effects.push(this.live(true), ...this.pump(now));
    return effects;
  }

  setRate(rate) {
    this.rate = clampRate(rate);
  }
}

/**
 * The bus in the page: carries out BusCore's effects with the Web Speech API,
 * the live regions, the log and the film's volume.
 */
export class SpeechBus {
  /**
   * @param {object} o
   * @param {HTMLElement} o.statusEl   role="status"
   * @param {HTMLElement} o.readerEl   the polite region descriptions are written to for the screen reader
   * @param {HTMLElement} o.logEl      role="log"
   * @param {HTMLElement} o.currentEl  the text of the current-description line
   * @param {() => (HTMLMediaElement|null)} [o.media]  the film, to turn down under the app voice
   * @param {string} [o.lang]          language of descriptions (BCP 47)
   * @param {string} [o.uiLang]        language of status messages
   * @param {'app'|'reader'} [o.channel]
   * @param {number} [o.rate]
   * @param {number} [o.volume]        volume of the app voice, 0 to 1
   * @param {(seconds: number) => string} [o.clock]  how a film time is written in the log
   * @param {(line: string) => void} [o.onNote]      one line for the diagnostic log
   * @param {(cause: string) => void} [o.onVoiceFailed]  the app voice could not speak and the
   *   channel is now 'reader': called after the bus has dealt with it, so it may use the bus.
   *   cause: the voice's own error, 'timeout', or 'no-voice' (see voiceUnavailable)
   */
  constructor({
    statusEl,
    readerEl,
    logEl,
    currentEl,
    media = () => null,
    lang = 'en-US',
    uiLang = lang,
    channel = 'app',
    rate = 1,
    volume = 1,
    clock = (s) => String(Math.round(s)),
    onNote = () => {},
    onVoiceFailed = () => {},
    synth = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    now = () => performance.now(),
    maxLog = 200,
  }) {
    this.statusEl = statusEl;
    this.readerEl = readerEl;
    this.logEl = logEl;
    this.currentEl = currentEl;
    this.media = media;
    this.lang = lang;
    this.uiLang = uiLang;
    this.volume = volume;
    this.clock = clock;
    this.onNote = onNote;
    this.onVoiceFailed = onVoiceFailed;
    this.synth = synth || null;
    this.Utterance = typeof Utterance === 'function' ? Utterance : null;
    this.now = now;
    this.maxLog = maxLog;
    /** Without a voice engine everything goes to the screen reader. */
    this.voiceAvailable = Boolean(this.synth && this.Utterance);
    this.core = new BusCore({ channel: this.voiceAvailable ? channel : 'reader', rate });
    this.speaking = null; // { id, utterance }: the reference also keeps Chrome from collecting it early
    this.wakeTimer = null;
    this.writeTimers = new Map();
    this.duckTimer = null;
    /** The film's own volume, restored after each description. */
    this.baseVolume = 1;
    this.apply(this.core.live(true));
    this.logEl.setAttribute('aria-live', 'off');
  }

  get channel() {
    return this.core.channel;
  }

  get rate() {
    return this.core.rate;
  }

  /** The last description, for R and for "the name is wrong". */
  get last() {
    return this.core.last;
  }

  /** A timed description: spoken or handed to the screen reader, logged, remembered for R. */
  describe(text, { lang = this.lang, time = null } = {}) {
    this.run(this.core.say({ kind: 'description', text, lang, time, log: true, remember: true }, this.now()));
  }

  /** What the user asked for just now (D, R, W): through the description channel, at once. */
  answer(text, { lang = this.lang, remember = false, log = false, time = null } = {}) {
    this.run(this.core.say({ kind: 'answer', text, lang, remember, log, time }, this.now()));
  }

  /** An interface message: to the status region, behind any description. `tag`: see BusCore.say. */
  status(text, { urgent = false, tag = '' } = {}) {
    this.run(this.core.say({ kind: 'status', text, lang: this.uiLang, urgent, tag }, this.now()));
  }

  /** R. @returns {boolean} false when there is nothing to repeat */
  repeat() {
    const last = this.core.last;
    if (!last) return false;
    this.answer(last.text, { lang: last.lang });
    return true;
  }

  userActed(cause) {
    this.run(this.core.userActed(cause, this.now()));
  }

  /** A dialog or a native menu opened or closed: see BusCore.setBlocked. */
  setBlocked(reason, on) {
    this.run(this.core.setBlocked(reason, on, this.now()));
  }

  /** Whether a dialog or a menu is keeping the shell silent. */
  get blocked() {
    return this.core.blocks.size > 0;
  }

  stop() {
    this.run(this.core.stop(this.now()));
  }

  /** @returns {boolean} whether the channel is now the one asked for */
  setChannel(channel) {
    if (channel === 'app' && !this.voiceAvailable) return false;
    this.run(this.core.setChannel(channel, this.now()));
    return this.core.channel === channel;
  }

  setRate(rate) {
    this.core.setRate(rate);
  }

  /**
   * The page has found that no installed voice can read the descriptions: hand them to the
   * screen reader, and tell the page (onVoiceFailed) exactly as after a failed utterance.
   * @returns {boolean} whether anything changed
   */
  voiceUnavailable(cause = 'no-voice') {
    if (this.core.channel === 'reader') return false;
    const effects = this.core.noVoice(cause, this.now());
    this.run(effects);
    // With nothing in the middle of being spoken there is no 'failed' effect to tell the page by.
    if (!effects.some((effect) => effect.type === 'note' && effect.what === 'failed')) this.onVoiceFailed(cause);
    return true;
  }

  voices() {
    try {
      return this.synth ? this.synth.getVoices() : [];
    } catch {
      return [];
    }
  }

  /** Whether an installed voice can read this language. */
  hasVoiceFor(lang) {
    return Boolean(pickVoice(this.voices(), lang));
  }

  run(effects) {
    for (const effect of effects) this.apply(effect);
    this.schedule();
    // Only after the whole batch: the page answers by using the bus.
    const failure = effects.find((effect) => effect.type === 'note' && effect.what === 'failed');
    if (failure) this.onVoiceFailed(failure.cause);
  }

  schedule() {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const at = this.core.wakeAt();
    if (at == null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.run(this.core.tick(this.now()));
    }, Math.max(0, at - this.now()) + 1);
  }

  apply(effect) {
    switch (effect.type) {
      case 'speak':
        this.startVoice(effect.item);
        break;
      case 'cancel':
        this.stopVoice();
        break;
      case 'write':
        this.write(effect.region === 'reader' ? this.readerEl : this.statusEl, effect.item);
        this.onNote(`bus: ${effect.item.kind} #${effect.item.id} to the ${effect.region} region`);
        break;
      case 'live':
        this.statusEl.setAttribute('aria-live', effect.status);
        this.readerEl.setAttribute('aria-live', effect.reader);
        break;
      case 'duck':
        this.duck(effect.on);
        break;
      case 'log':
        this.appendLog(effect.item);
        break;
      case 'current':
        this.currentEl.setAttribute('lang', effect.item.lang || this.lang);
        this.currentEl.textContent = effect.item.text;
        break;
      case 'note':
        this.onNote(`bus: ${effect.item.kind} #${effect.item.id} ${effect.what} (${effect.cause})`);
        break;
      default:
        break;
    }
  }

  startVoice(item) {
    const started = this.now();
    const done = (why) => {
      if (!this.speaking || this.speaking.id !== item.id) return;
      this.speaking = null;
      this.onNote(`bus: voice finished #${item.id} (${why}) after ${Math.round(this.now() - started)} ms`);
      // Anything but an end of its own, or one we asked for, means the description was not heard.
      this.run(VOICE_ENDINGS.has(why) ? this.core.finished(item.id, this.now()) : this.core.failed(item.id, why, this.now()));
    };
    let utterance;
    try {
      utterance = new this.Utterance(item.text);
      utterance.lang = item.lang || this.lang;
      const voice = pickVoice(this.voices(), utterance.lang);
      if (voice) utterance.voice = voice;
      utterance.rate = this.core.rate;
      utterance.volume = this.volume;
      utterance.onend = () => done('end');
      utterance.onerror = (event) => done((event && event.error) || 'error');
      this.speaking = { id: item.id, utterance };
      this.onNote(`bus: ${item.kind} #${item.id} to the app voice (${voice ? voice.lang : 'default voice'})`);
      this.synth.speak(utterance);
    } catch (err) {
      this.speaking = { id: item.id, utterance: null };
      // Report back after this batch of effects, never in the middle of it.
      setTimeout(() => done(`exception ${err && err.message}`), 0);
    }
  }

  stopVoice() {
    this.speaking = null;
    try {
      this.synth.cancel();
    } catch {
      /* nothing to stop */
    }
  }

  /** Empty the region first, fill it a moment later: screen readers then notice the same text again. */
  write(el, item) {
    clearTimeout(this.writeTimers.get(el));
    el.textContent = '';
    this.writeTimers.set(
      el,
      setTimeout(() => {
        el.setAttribute('lang', item.lang || this.uiLang);
        el.textContent = item.text;
      }, WRITE_DELAY_MS),
    );
  }

  appendLog(item) {
    const doc = this.logEl.ownerDocument;
    const entry = doc.createElement('p');
    entry.className = 'entry';
    if (item.time != null) {
      const time = doc.createElement('span');
      time.className = 'time';
      time.textContent = `${this.clock(item.time)} `;
      entry.append(time);
    }
    const text = doc.createElement('span');
    text.setAttribute('lang', item.lang || this.lang);
    text.textContent = item.text;
    entry.append(text);
    this.logEl.append(entry);
    while (this.logEl.children.length > this.maxLog) this.logEl.firstElementChild.remove();
  }

  /** Turn the film down under the app voice, and back up after it. */
  duck(on) {
    const media = this.media();
    clearInterval(this.duckTimer);
    this.duckTimer = null;
    if (!media) return;
    const from = media.volume;
    const to = on ? this.baseVolume * DUCK_VOLUME : this.baseVolume;
    const started = this.now();
    const step = () => {
      const progress = (this.now() - started) / DUCK_RAMP_MS;
      media.volume = volumeAt(from, to, progress);
      if (progress >= 1) {
        clearInterval(this.duckTimer);
        this.duckTimer = null;
      }
    };
    this.duckTimer = setInterval(step, 25);
    step();
  }
}
