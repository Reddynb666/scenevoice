// Two-way binding between form controls and settings.
// <input type="checkbox" data-setting="enabled">
// <input type="radio" name="mode" value="gaps" data-setting="mode">
// <select data-setting="language"> / <input type="range" data-setting="ttsRate" data-number>
//
// A slider with data-format="rate|pitch|percent" gets a spoken value
// (aria-valuetext: "1.2×", not "1.2") and fills its <output for="…">.
//
// chrome.storage.sync allows about two writes a second, so sliders save on
// "change" (when the user lets go), not on every step of a drag.

import { formatPercent, formatPitch, formatRate } from './labels.js';
import { getSettings, setSettings } from './storage.js';

const FORMATS = { rate: formatRate, pitch: formatPitch, percent: formatPercent };

function readControl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.number !== undefined) return Number(el.value);
  return el.value;
}

function writeControl(el, value) {
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else if (el.type === 'radio') el.checked = String(value) === el.value;
  else el.value = String(value);
}

/** Put a slider's value into words for screen readers and its visible <output>. */
function showValue(el) {
  const format = FORMATS[el.dataset.format];
  if (!format) return;
  const text = format(readControl(el));
  el.setAttribute('aria-valuetext', text);
  if (el.id) {
    for (const out of el.ownerDocument.querySelectorAll(`output[for="${el.id}"]`)) out.textContent = text;
  }
}

/**
 * @param {ParentNode} root
 * @param {(settings: object, live?: object) => void} onChange
 *   called with saved settings, and with `live` for unsaved slider movement
 * @param {(err: Error) => void} onError  a save failed (e.g. storage quota)
 */
export async function bindSettings(root, onChange, onError) {
  const controls = [...root.querySelectorAll('[data-setting]')];
  let current = await getSettings();

  const apply = (settings) => {
    current = settings;
    for (const el of controls) {
      const key = el.dataset.setting;
      if (!(key in settings)) continue;
      // Do not move a slider or text field out from under the user's hands.
      const editing = document.activeElement === el && (el.type === 'range' || el.type === 'text' || el.tagName === 'TEXTAREA');
      if (!editing) {
        writeControl(el, settings[key]);
        showValue(el);
      }
    }
    onChange?.(settings);
  };
  apply(current);

  const save = async (el) => {
    try {
      const next = await setSettings({ [el.dataset.setting]: readControl(el) });
      apply(next);
    } catch (err) {
      onError?.(err);
    }
  };

  for (const el of controls) {
    if (el.type === 'range') {
      el.addEventListener('input', () => {
        showValue(el);
        onChange?.(current, { ...current, [el.dataset.setting]: readControl(el) });
      });
      el.addEventListener('change', () => save(el));
    } else {
      const evt = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        if (el.type === 'radio' && !el.checked) return;
        save(el);
      });
    }
  }
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && changes.settings) apply(await getSettings());
  });
}

/**
 * Make a page follow the SceneVoice Cloud switch (CLOUD_OPEN in constants.js).
 * In the HTML, what belongs to Cloud is marked data-cloud="open" and hidden,
 * and what is said instead while Cloud is closed is marked data-cloud="closed".
 * The side that does not apply is taken out of the document, not disabled or
 * hidden: a screen reader finds no dead control and no words about something
 * that is not there. Call it before the page is localized or bound to settings.
 */
export function applyCloudSwitch(root, open) {
  for (const el of root.querySelectorAll('[data-cloud]')) {
    if ((el.dataset.cloud === 'open') === Boolean(open)) el.hidden = false;
    else el.remove();
  }
}
