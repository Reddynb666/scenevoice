// Localized text for setting values, shared by the settings pages (visible
// value and aria-valuetext) and the YouTube tab (spoken when a shortcut changes them).

import { t } from './i18n.js';

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
 */
export function typeAdjustedText(type, changes) {
  const name = t(`type_name_${type}`);
  const mode = changes.mode ? t(`type_mode_${changes.mode}`) : '';
  const detail = changes.detail ? t(`type_detail_${changes.detail}`) : '';
  if (mode && detail) return t('type_switched_both', name, mode, detail);
  if (mode) return t('type_switched_mode', name, mode);
  if (detail) return t('type_switched_detail', name, detail);
  return '';
}

/** The name of a screen reader speed preset, as in the settings list. */
export function readerSpeedLabel(speed) {
  const labels = { 1: t('speed_normal'), 1.6: t('speed_fast'), 2.4: t('speed_very_fast'), 3.2: t('speed_fastest') };
  return labels[speed] || String(speed);
}
