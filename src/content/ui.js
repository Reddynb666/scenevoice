// On-page UI: a caption-style text overlay for low-vision and sighted co-viewers,
// a button in the player controls, and the "ask about this moment" dialog.
// Everything visual lives in a shadow root so the site's CSS cannot reach it.
// Where the player and its controls are comes from the site's platform object.

import { t } from '../shared/i18n.js';
import { formatTime } from '../shared/script.js';
import { containerForOverlays } from './dom.js';
import { youtubePlatform } from './youtube.js';

const CSS = `
:host { all: initial; }
.overlay {
  position: absolute; left: 50%; top: 6%; transform: translateX(-50%);
  max-width: min(86%, 900px); z-index: 60; pointer-events: none;
  font: 600 clamp(16px, 2.4vw, 30px)/1.35 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #fff; background: rgba(8, 8, 12, 0.86); padding: 0.45em 0.8em; border-radius: 10px;
  text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,.35); border-left: 5px solid #ffd54a;
}
.overlay[hidden] { display: none; }
.overlay .kind { display: block; font-size: 0.55em; font-weight: 700; letter-spacing: .06em; color: #ffd54a; text-transform: uppercase; margin-bottom: .15em; }
/* Just above the player's control bar, where people look for playback state, and clear of
   the title the site draws at the top. Stays up while the controls hide; gone when done. */
.progress {
  position: absolute; left: 12px; bottom: var(--sv-progress-bottom, 76px); z-index: 62; pointer-events: none;
  min-width: 260px; max-width: min(70%, 460px); padding: 10px 14px 12px; border-radius: 10px;
  background: rgba(0, 0, 0, 0.92); color: #fff; border: 2px solid #ffd54a; box-shadow: 0 2px 14px rgba(0,0,0,.5);
  font: 700 16px/1.35 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.progress.at-top { bottom: auto; top: 12px; }
.progress[hidden] { display: none; }
.progress .line { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; }
.progress .percent { color: #ffd54a; font-variant-numeric: tabular-nums; }
.progress .eta { display: block; margin-top: 2px; font-weight: 500; font-size: 15px; color: #f0f0f0; }
.progress .eta:empty { display: none; }
.progress .track { height: 8px; margin-top: 8px; border-radius: 4px; background: rgba(255,255,255,.3); overflow: hidden; }
.progress .fill { height: 100%; width: 0; background: #ffd54a; border-radius: 4px; transition: width .6s linear; }
dialog {
  border: none; border-radius: 14px; padding: 0; width: min(560px, 92vw); color: #111; background: #fff;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 20px 60px rgba(0,0,0,.45);
}
dialog::backdrop { background: rgba(0,0,0,.55); }
form { padding: 22px 24px 20px; display: grid; gap: 12px; }
h2 { margin: 0; font-size: 20px; }
p.hint { margin: 0; color: #444; font-size: 14px; }
label { font-weight: 600; }
textarea {
  font: inherit; width: 100%; box-sizing: border-box; min-height: 72px; padding: 10px 12px;
  border: 2px solid #767676; border-radius: 8px; resize: vertical; color: #111; background: #fff;
}
textarea:focus-visible, button:focus-visible { outline: 3px solid #1a5fd6; outline-offset: 2px; }
.row { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
button {
  font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 8px; cursor: pointer;
  border: 2px solid #1a5fd6; background: #1a5fd6; color: #fff;
}
button.secondary { background: #fff; color: #1a5fd6; }
button[disabled] { opacity: .6; cursor: progress; }
/* Always rendered, so the live region exists before its first announcement. */
.answer { margin: 0; min-height: 1.5em; padding: 0 14px; border-radius: 8px; white-space: pre-wrap; }
.answer.filled { padding: 12px 14px; background: #f2f5fb; }
@media (prefers-color-scheme: dark) {
  dialog { background: #1d1f24; color: #f2f2f2; }
  p.hint { color: #c4c4c4; }
  textarea { background: #111317; color: #f2f2f2; border-color: #9a9a9a; }
  button.secondary { background: transparent; color: #8db4ff; border-color: #8db4ff; }
  button { background: #3b7cf0; border-color: #3b7cf0; }
  .answer.filled { background: #2a2e36; }
  textarea:focus-visible, button:focus-visible { outline-color: #8db4ff; }
}
`;

const ICON = `<svg viewBox="0 0 36 36" width="100%" height="100%" aria-hidden="true" focusable="false"><path fill="#fff" d="M10 11h12a2 2 0 0 1 2 2v1.5l4-2.5v12l-4-2.5V23a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2zm2 5v2h8v-2h-8zm0 3.5v2h5v-2h-5z"/></svg>`;

export class PageUI {
  constructor({ onToggle, platform = youtubePlatform }) {
    this.onToggle = onToggle;
    this.platform = platform;
    this.host = document.createElement('div');
    this.host.dataset.scenevoice = 'ui';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.overlay.hidden = true;
    this.overlay.setAttribute('aria-hidden', 'true'); // screen readers get the text through the live region
    this.progress = document.createElement('div');
    this.progress.className = 'progress';
    this.progress.hidden = true;
    this.progress.setAttribute('aria-hidden', 'true'); // progress is announced through the live region
    this.progress.innerHTML = '<div class="line"><span class="label"></span><span class="percent"></span></div><span class="eta"></span><div class="track"><div class="fill"></div></div>';
    this.root.append(style, this.overlay, this.progress);
    this.hideTimer = null;
    this.button = null;
    this.dialog = null;
    this.enabled = true;
    this.shortcut = '';
  }

  /** Keep the overlay inside the current player and the button in its controls. */
  mount() {
    const player = this.platform.getPlayer();
    if (player && this.host.parentNode !== player) {
      if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
      player.appendChild(this.host);
    }
    this.placeProgress();
    this.mountButton();
  }

  mountButton() {
    const controls = this.platform.rightControls();
    if (!controls) return;
    if (!this.button || !controls.contains(this.button)) {
      const b = document.createElement('button');
      b.className = this.platform.buttonClass;
      if (this.platform.buttonStyle) b.style.cssText = this.platform.buttonStyle;
      b.type = 'button';
      b.innerHTML = ICON;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onToggle();
      });
      controls.prepend(b);
      this.button = b;
    }
    this.renderButton();
  }

  setButtonState(enabled, shortcut) {
    this.enabled = enabled;
    if (shortcut !== undefined) this.shortcut = shortcut;
    this.renderButton();
  }

  renderButton() {
    if (!this.button) return;
    const label = t('player_button_label');
    this.button.setAttribute('aria-label', label);
    this.button.title = this.shortcut ? `${label} (${this.shortcut})` : label;
    this.button.setAttribute('aria-pressed', this.enabled ? 'true' : 'false');
    this.button.style.opacity = this.enabled ? '1' : '0.55';
  }

  showText(text, kind, seconds) {
    clearTimeout(this.hideTimer);
    this.overlay.replaceChildren();
    if (kind === 'text') {
      const k = document.createElement('span');
      k.className = 'kind';
      k.textContent = t('overlay_on_screen_text');
      this.overlay.append(k);
    }
    this.overlay.append(document.createTextNode(text));
    this.overlay.hidden = false;
    this.hideTimer = setTimeout(() => {
      this.overlay.hidden = true;
    }, Math.max(2500, seconds * 1000 + 800));
  }

  hideText() {
    clearTimeout(this.hideTimer);
    this.overlay.hidden = true;
  }

  /**
   * Above the control bar, or at the top where the site has none there (Shorts).
   * Checked on every mount, since one tab moves between watch pages and Shorts.
   */
  placeProgress() {
    const place = this.platform.progressPlacement?.() || {};
    this.progress.classList.toggle('at-top', Boolean(place.top));
    if (place.bottom) this.progress.style.setProperty('--sv-progress-bottom', place.bottom);
    else this.progress.style.removeProperty('--sv-progress-bottom');
  }

  /** Visible progress for sighted and low-vision viewers; screen readers hear the announcements instead. */
  showProgress({ done, total, fraction, eta }) {
    const label = this.progress.querySelector('.label');
    const etaEl = this.progress.querySelector('.eta');
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    label.textContent = total > 1 ? t('progress_section', String(Math.min(done + 1, total)), String(total)) : t('progress_working');
    this.progress.querySelector('.percent').textContent = `${percent}%`;
    etaEl.textContent = eta == null ? '' : eta < 60 ? t('progress_eta_soon') : t('progress_eta_minutes', String(Math.ceil(eta / 60)));
    this.progress.querySelector('.fill').style.width = `${Math.max(2, percent)}%`;
    if (this.progress.hidden) {
      // Generation can start before the player exists (or after the site rebuilt it): attach now.
      this.mount();
      this.progress.hidden = false;
    }
  }

  /** Describing as the video plays (pictures): how far the part being watched is described, and how much of the video is. */
  showLiveProgress({ percent, upTo }) {
    this.progress.querySelector('.label').textContent = t('progress_live');
    this.progress.querySelector('.percent').textContent = `${percent}%`;
    this.progress.querySelector('.eta').textContent = upTo ? t('progress_live_up_to', upTo) : t('progress_live_waiting');
    this.progress.querySelector('.fill').style.width = `${Math.max(2, percent)}%`;
    if (this.progress.hidden) {
      this.mount();
      this.progress.hidden = false;
    }
  }

  hideProgress() {
    this.progress.hidden = true;
  }

  /**
   * Open the ask dialog. onSubmit(question) resolves to { text, time }: the
   * answer and the moment it is about, offered as "Go to 2:15" (time null: no
   * button). onClose({ jumpTo }) gets that moment when the user chose to go there.
   */
  openAsk({ onSubmit, onClose }) {
    if (this.dialog?.open) {
      this.dialog.querySelector('textarea').focus();
      return;
    }
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'sv-ask-title');
    dialog.innerHTML = `
      <form method="dialog" novalidate>
        <h2 id="sv-ask-title"></h2>
        <p class="hint" id="sv-ask-hint"></p>
        <label for="sv-ask-input"></label>
        <textarea id="sv-ask-input" aria-describedby="sv-ask-hint" autocomplete="off"></textarea>
        <p class="answer" id="sv-ask-answer" role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="row">
          <button type="button" class="secondary" data-act="jump" hidden></button>
          <button type="button" class="secondary" data-act="close"></button>
          <button type="submit" data-act="ask"></button>
        </div>
      </form>`;
    dialog.querySelector('h2').textContent = t('ask_title');
    dialog.querySelector('#sv-ask-hint').textContent = t('ask_hint');
    dialog.querySelector('label').textContent = t('ask_label');
    dialog.querySelector('[data-act=close]').textContent = t('ask_close');
    dialog.querySelector('[data-act=ask]').textContent = t('ask_submit');
    const input = dialog.querySelector('textarea');
    const answer = dialog.querySelector('.answer');
    const submit = dialog.querySelector('[data-act=ask]');
    // First in the row: one Tab from the question field reaches it.
    const jump = dialog.querySelector('[data-act=jump]');
    /** The moment of the answer shown, and the one the user chose to go to. */
    let answerTime = null;
    let jumpTo = null;
    const setAnswer = (result) => {
      const { text = '', time = null } = typeof result === 'string' ? { text: result } : result || {};
      answer.classList.toggle('filled', Boolean(text));
      answer.textContent = text;
      answerTime = Number.isFinite(time) ? time : null;
      jump.hidden = answerTime == null;
      jump.textContent = answerTime == null ? '' : t('ask_jump', formatTime(answerTime));
    };

    // Keep the player's single-key shortcuts (YouTube's k, j, l, f, m; Bilibili's space, d, f…) from firing while typing.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      dialog.addEventListener(type, (e) => {
        if (type === 'keydown' && e.key === 'Enter' && !e.shiftKey && e.target === input) {
          e.preventDefault();
          dialog.querySelector('form').requestSubmit();
        }
        e.stopPropagation();
      });
    }
    dialog.querySelector('[data-act=close]').addEventListener('click', () => dialog.close());
    jump.addEventListener('click', () => {
      jumpTo = answerTime;
      dialog.close();
    });
    dialog.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q || submit.disabled) return;
      submit.disabled = true;
      setAnswer(t('ask_thinking'));
      try {
        setAnswer(await onSubmit(q));
      } finally {
        submit.disabled = false;
        input.select();
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus?.();
      onClose?.({ jumpTo });
    });

    // A modal dialog renders in the top layer, so it shows above a fullscreen player wherever it sits.
    if (!this.host.isConnected) containerForOverlays().appendChild(this.host);
    this.root.append(dialog);
    this.dialog = dialog;
    dialog.showModal();
    input.focus();
  }

  destroy() {
    this.button?.remove();
    this.host.remove();
  }
}
