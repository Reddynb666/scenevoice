// Which model describes a video, and how it is shown the video.
// No browser APIs and no keys here: content scripts use this too. Keys stay
// in the service worker (background/index.js providerConfig).
//
//   gemini on YouTube   'video'   Gemini opens the YouTube link itself and describes
//                                 whole sections ahead of playback (the original way).
//   anything else       'frames'  the page takes pictures from the playing video and
//                                 sends a few at a time (content/frames.js): Qwen cannot
//                                 open video links, and Gemini cannot open Bilibili's.

import { DEFAULT_SETTINGS, PLATFORMS, PROVIDERS } from './constants.js';

/** The setting that holds a site's provider: 'bilibili' → 'bilibiliProvider'. */
export const providerSettingKey = (platform) => `${platform}Provider`;

/** The provider chosen for a site, or that site's default. */
export function providerFor(settings, platform) {
  const site = PLATFORMS.includes(platform) ? platform : 'youtube';
  const key = providerSettingKey(site);
  const chosen = settings?.[key];
  return PROVIDERS.includes(chosen) ? chosen : DEFAULT_SETTINGS[key];
}

/** 'video' when the provider can open the video by its link, otherwise 'frames'. */
export function inputModeFor(provider, platform) {
  return provider === 'gemini' && platform === 'youtube' ? 'video' : 'frames';
}
