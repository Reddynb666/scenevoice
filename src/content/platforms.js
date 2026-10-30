// The site the content script is running on. The manifest injects it into
// YouTube pages and into Bilibili video pages only (www.bilibili.com/video/*).

import { platformOfUrl } from '../shared/platforms.js';
import { bilibiliPlatform } from './bilibili.js';
import { youtubePlatform } from './youtube.js';

export function platformFor(href) {
  return platformOfUrl(href) === 'bilibili' ? bilibiliPlatform : youtubePlatform;
}
