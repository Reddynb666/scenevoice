// Localized text for setting values, shared by the settings pages (visible
// value and aria-valuetext) and the YouTube tab (spoken when a shortcut changes them).

import { t } from './i18n.js';
import { CHOICES } from './settings.js';

/** 1.2 → "1.2×" (zh: "1.2 倍"). */
export const formatRate = (rate) => t('value_rate', Number(rate).toFixed(1));

/** 1 → "Normal", 1.2 → "120%". */
export const formatPitch = (pitch) =>
  Math.abs(Number(pitch) - 1) < 0.001 ? t('value_pitch_normal') : t('value_percent', String(Math.round(Number(pitch) * 100)));

/** 0.35 → "35%". */
export const formatPercent = (value) => t('value_percent', String(Math.round(Number(value) * 100)));

/**
 * What the video type changed, from typeAdjustments(): "Tutorial video:
 * SceneVoice will pause when needed, with detailed descriptions." '' if nothing.
 * A changed density follows in a sentence of its own.
 */
export function typeAdjustedText(type, changes) {
  const name = t(`type_name_${type}`);
  const mode = changes.mode ? t(`type_mode_${changes.mode}`) : '';
  const detail = changes.detail ? t(`type_detail_${changes.detail}`) : '';
  const density = changes.density ? t(`type_density_${changes.density}`) : '';
  let text = '';
  if (mode && detail) text = t('type_switched_both', name, mode, detail);
  else if (mode) text = t('type_switched_mode', name, mode);
  else if (detail) text = t('type_switched_detail', name, detail);
  if (!density) return text;
  return text ? `${text} ${t('type_also_density', density)}` : t('type_switched_density', name, density);
}

/**
 * Which of mode, detail and density the user picked themselves, and so which
 * the video type still decides: "You chose the mode yourself, so the video type
 * now decides only the detail and how much to describe." '' when none.
 */
export function typeChosenText(settings) {
  const chosen = CHOICES.filter((key) => settings?.[`${key}Chosen`]);
  if (!chosen.length) return '';
  if (chosen.length === CHOICES.length) return t('type_chosen_all');
  const names = (keys) => keys.map((key) => t(`type_key_${key}`));
  const list = ([a, b]) => (b ? t('list_two', a, b) : a);
  return t('type_chosen_some', list(names(chosen)), list(names(CHOICES.filter((key) => !chosen.includes(key)))));
}

/** The name of a screen reader speed preset, as in the settings list. */
export function readerSpeedLabel(speed) {
  const labels = { 1: t('speed_normal'), 1.6: t('speed_fast'), 2.4: t('speed_very_fast'), 3.2: t('speed_fastest') };
  return labels[speed] || String(speed);
}

/**
 * The words of the progress box, the same on the player and in the popup:
 * { label, percent, detail }. percent is a whole number 0..100.
 */
export function generationProgressLabels({ done, total, percent, eta }) {
  return {
    label: total > 1 ? t('progress_section', String(Math.min(done + 1, total)), String(total)) : t('progress_working'),
    percent: `${percent}%`,
    detail: eta == null ? '' : eta < 60 ? t('progress_eta_soon') : t('progress_eta_minutes', String(Math.ceil(eta / 60))),
  };
}

/** Describing as the video plays: upTo is how far the part being watched is described ("1:35"), or ''. */
export function liveProgressLabels({ percent, upTo }) {
  return {
    label: t('progress_live'),
    percent: `${percent}%`,
    detail: upTo ? t('progress_live_up_to', upTo) : t('progress_live_waiting'),
  };
}
