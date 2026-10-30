// Everything that knows about Bilibili's video page (www.bilibili.com/video/…)
// lives here. Experimental: the selectors below are the ones the video page uses
// at the time of writing; Bilibili does not document them and may change them
// (待确认 before each release).
//
// SceneVoice reads only what the page already has, and calls none of Bilibili's
// web APIs itself (they are not public, and Bilibili has acted against projects
// that call them):
// - the player, its <video> and the control bar, from the page;
// - title, uploader, description, section (分区) and parts (分P), from the data
//   the page is delivered with (window.__INITIAL_STATE__ in its HTML), and from
//   the page's text after moving to another video without reloading;
// - the CC subtitles' timing, from the subtitle file the player itself loads
//   when the viewer turns subtitles on (seen in the page's resource timing), a
//   static file on Bilibili's file servers. Subtitles off, or none: descriptions
//   keep the model's own timing.

import { bilibiliIdFromUrl, parseBilibiliVideoId } from '../shared/platforms.js';
import { pageVideoType } from '../shared/videotype.js';

/** Hosts subtitle files are served from (待确认). Any other address is ignored. */
const SUBTITLE_HOST = /(^|\.)hdslb\.com$/;
/** Requests for subtitle files, as seen in the page's resource timing. */
const SUBTITLE_PATH = /\/bfs\/(ai_)?subtitle\//;

const PLAYER_SELECTORS = ['.bpx-player-container', '#bilibili-player', '.bilibili-player'];

/** What the info API said about the video on the page, kept for getMeta(). */
let info = null;
/** performance.now() of the last navigation: subtitle requests from before it are another video's. */
let navigatedAt = 0;

export const videoIdFromUrl = (href) => bilibiliIdFromUrl(href);

export function getPlayer() {
  for (const sel of PLAYER_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/**
 * The playing video. Some videos play in <bwp-video>, Bilibili's own player
 * element: it follows the media element API for time and playback (待确认),
 * but SceneVoice cannot take pictures from it (frames.js says so).
 */
export function getVideo() {
  const player = getPlayer();
  if (player) return player.querySelector('video') || player.querySelector('bwp-video');
  return document.querySelector('video') || document.querySelector('bwp-video');
}

/** Bilibili videos do not run ads in the player (待确认 for paid content and bangumi). */
export function isAdShowing() {
  return false;
}

const currentInfo = () => (info && info.id === videoIdFromUrl(location.href) ? info : null);

/** The part's length from the info API, in seconds; NaN until it is known. */
export function getPageDuration() {
  const d = Number(currentInfo()?.duration);
  return Number.isFinite(d) && d > 0 ? d : NaN;
}

function text(sel) {
  const el = document.querySelector(sel);
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

export function getMeta() {
  const known = currentInfo();
  const title =
    known?.title ||
    text('h1.video-title') ||
    text('.video-title') ||
    document.title.replace(/_哔哩哔哩_bilibili\s*$/, '').trim();
  const part = known?.part ? ` - P${known.page} ${known.part}` : '';
  const channel = known?.owner || text('.up-name') || text('.up-detail-top .up-name');
  const description =
    known?.desc || text('.desc-info-text') || document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  return { title: `${title}${part}`, channel, description: description.slice(0, 2000) };
}

/** The player's control bar, right side, for the SceneVoice button (待确认). */
export function rightControls() {
  return getPlayer()?.querySelector('.bpx-player-control-bottom-right') || null;
}

/** Where the progress box goes: just above the control bar (measured; taller in fullscreen). */
export function progressPlacement() {
  const h = getPlayer()?.querySelector('.bpx-player-control-wrap')?.offsetHeight || 0;
  return h > 0 ? { bottom: `${h + 24}px` } : { bottom: '84px' };
}

/** Call fn() whenever the page moves to another address (another video or part, without reloading). */
export function onNavigate(fn) {
  let last = location.href;
  const check = () => {
    if (location.href === last) return;
    last = location.href;
    navigatedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    fn();
  };
  window.addEventListener('popstate', check);
  setInterval(check, 1000);
}

/** A subtitle file address from an API answer or the page, as https; null if it is not a Bilibili subtitle host. */
export function subtitleUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let url;
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol) || !SUBTITLE_HOST.test(url.hostname)) return null;
  url.protocol = 'https:';
  return url.href;
}

/**
 * The video data the page was delivered with: window.__INITIAL_STATE__ in an
 * inline script of the HTML. Read as text (the content script cannot see the
 * page's variables). Null when it is not there or is not about this video
 * (after moving to another video without reloading, the HTML still has the first).
 */
export function initialVideoData(doc, ref) {
  for (const script of doc.querySelectorAll('script:not([src])')) {
    const src = script.textContent || '';
    const at = src.indexOf('window.__INITIAL_STATE__');
    if (at < 0) continue;
    const open = src.indexOf('{', at);
    if (open < 0) continue;
    const json = balancedJson(src, open);
    if (!json) continue;
    try {
      const data = JSON.parse(json)?.videoData;
      if (!data || typeof data !== 'object') return null;
      if (ref?.bvid && data.bvid !== ref.bvid) return null;
      if (ref?.aid && String(data.aid) !== String(ref.aid)) return null;
      return data;
    } catch {
      return null;
    }
  }
  return null;
}

/** The JSON object starting at `open`, by matching braces outside strings. */
function balancedJson(src, open) {
  let depth = 0;
  let inString = false;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/**
 * What the page says about the video: the section (for the video type).
 * Remembers title, uploader, description and part for getMeta(). Subtitles come
 * later, if the viewer turns them on (watchCaptionRequests).
 */
export async function loadPageInfo(videoId) {
  const ref = parseBilibiliVideoId(videoId);
  if (!ref) return { category: '', captionUrls: [] };
  const data = initialVideoData(document, ref);
  if (!data) {
    info = null;
    return { category: '', captionUrls: [] };
  }
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const page = pages.find((p) => p?.page === ref.page) || pages[ref.page - 1] || pages[0] || {};
  info = {
    id: videoId,
    title: typeof data.title === 'string' ? data.title : '',
    owner: typeof data.owner?.name === 'string' ? data.owner.name : '',
    desc: typeof data.desc === 'string' ? data.desc : '',
    part: pages.length > 1 && typeof page.part === 'string' ? page.part : '',
    page: ref.page,
    duration: Number(page.duration ?? data.duration),
  };
  return { category: typeof data.tname === 'string' ? data.tname : '', captionUrls: [] };
}

/**
 * Use the subtitle file the player itself loads when the viewer turns CC
 * subtitles on, for dialogue timing. Calls fn(videoId, url).
 */
export function watchCaptionRequests(fn) {
  const seen = (entry) => {
    if (!SUBTITLE_PATH.test(entry.name) || entry.startTime < navigatedAt) return;
    const url = subtitleUrl(entry.name);
    const id = videoIdFromUrl(location.href);
    if (url && id) fn(id, url);
  };
  try {
    new PerformanceObserver((list) => list.getEntries().forEach(seen)).observe({ type: 'resource', buffered: true });
  } catch {
    /* PerformanceObserver unavailable */
  }
}

/** Bilibili, as the content script sees it. */
export const bilibiliPlatform = Object.freeze({
  id: 'bilibili',
  videoIdFromUrl,
  getPlayer,
  getVideo,
  isAdShowing,
  getPageDuration,
  getMeta,
  rightControls,
  progressPlacement,
  onNavigate,
  loadPageInfo,
  watchCaptionRequests,
  videoType: ({ category, title }) => pageVideoType({ category, title, platform: 'bilibili' }),
  buttonClass: 'bpx-player-ctrl-btn scenevoice-button',
  buttonStyle: 'width:36px;height:22px;padding:0;border:0;background:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;',
});
