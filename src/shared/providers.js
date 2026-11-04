// Which model describes a video, and how it is shown the video.
// No browser APIs and no keys here: content scripts use this too. Keys stay
// in the service worker (background/index.js providerConfig).
//
//   gemini on YouTube   'video'   Gemini opens the YouTube link itself and describes
//                                 whole sections ahead of playback (the original way).
//   cloud on YouTube    'video'   the same, through the SceneVoice Cloud relay (Gemini
//                                 behind it opens the link).
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

/** The providers a listener holds a key for themselves; the Cloud token is not a key of their own. */
const OWN_KEY_PROVIDERS = PROVIDERS.filter((p) => p !== 'cloud');

/**
 * The provider that actually describes a site: the chosen one when its key is
 * set; otherwise the other key of the listener's own, if there is one; otherwise
 * SceneVoice Cloud, if a device token exists. A listener with one key is never
 * told to get the other. `keys` is { gemini, qwen, cloud } (booleans; cloud is
 * whether a token is saved); without it the chosen provider stands.
 */
export function effectiveProvider(settings, platform, keys) {
  const chosen = providerFor(settings, platform);
  if (!keys || keys[chosen]) return chosen;
  return OWN_KEY_PROVIDERS.find((p) => p !== chosen && keys[p]) || (keys.cloud ? 'cloud' : chosen);
}

/** 'video' when the provider can open the video by its link, otherwise 'frames'. */
export function inputModeFor(provider, platform) {
  return (provider === 'gemini' || provider === 'cloud') && platform === 'youtube' ? 'video' : 'frames';
}
