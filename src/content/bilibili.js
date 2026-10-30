// Everything that knows about Bilibili's video page (www.bilibili.com/video/…)
// lives here. Experimental: the selectors and the web APIs below are the ones
// the video page uses at the time of writing; Bilibili does not document them
// and may change them (待确认 before each release).
//
// What is read, and from where:
// - the player, its <video> and the control bar, from the page;
// - title, uploader, description, section (分区) and parts (分P), from the
//   video info API, with the page itself as a fallback;
// - the CC subtitles' timing, from the player API and the subtitle file it
//   names (the same files the player loads when subtitles are turned on). No
//   subtitles, or none readable: descriptions keep the model's own timing.
// All requests go to Bilibili, from the Bilibili page, as the page's own do.

import { bilibiliIdFromUrl, parseBilibiliVideoId } from '../shared/platforms.js';
import { pageVideoType } from '../shared/videotype.js';

/** Public web APIs of the video page (待确认: undocumented; may change, or start to require signed requests). */
export const BILIBILI_API = Object.freeze({
  /** Video info: data.title, owner.name, desc, tname (section), pages[{cid, page, part, duration}]. */
  view: 'https://api.bilibili.com/x/web-interface/view',
  /** Player info for one part: data.subtitle.subtitles[{lan, subtitle_url, ai_type}]. Logged-out viewers may get none. */
  player: 'https://api.bilibili.com/x/player/v2',
});

/** Hosts subtitle files are served from (待确认). Any other address in an API answer is ignored. */
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
 * Subtitle files in the order their timing is most likely to follow the
 * dialogue: subtitles written for Chinese, then AI-generated Chinese, then others.
 */
export function subtitleUrls(subtitles) {
  const score = (s) => {
    const lan = String(s.lan || '').toLowerCase();
    const ai = lan.startsWith('ai-') || Number(s.ai_type) > 0;
    return (/zh/.test(lan) ? 0 : 2) + (ai ? 1 : 0);
  };
  return (Array.isArray(subtitles) ? subtitles : [])
    .filter((s) => s && typeof s.subtitle_url === 'string')
    .sort((a, b) => score(a) - score(b))
    .map((s) => subtitleUrl(s.subtitle_url))
    .filter(Boolean);
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return null;
  const body = await res.json();
  return body && body.code === 0 ? body.data : null;
}

/**
 * What Bilibili says about the video: the section (for the video type) and the
 * subtitle files to take dialogue timing from. Remembers title, uploader,
 * description and part for getMeta().
 */
export async function loadPageInfo(videoId) {
  const ref = parseBilibiliVideoId(videoId);
  if (!ref) return { category: '', captionUrls: [] };
  const query = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid)}`;
  const data = await getJson(`${BILIBILI_API.view}?${query}`);
  if (!data) return { category: '', captionUrls: [] };
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
  const category = typeof data.tname === 'string' ? data.tname : '';
  const cid = page.cid ?? data.cid;
  let captionUrls = [];
  if (cid != null) {
    try {
      const player = await getJson(`${BILIBILI_API.player}?${query}&cid=${encodeURIComponent(cid)}`);
      captionUrls = subtitleUrls(player?.subtitle?.subtitles);
    } catch {
      captionUrls = [];
    }
  }
  return { category, captionUrls };
}

/**
 * Remember the subtitle files the player itself loads (when the viewer turns
 * CC subtitles on): useful when the API gave none. Calls fn(videoId, url).
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
  onNavigate,
  loadPageInfo,
  watchCaptionRequests,
  videoType: ({ category, title }) => pageVideoType({ category, title, platform: 'bilibili' }),
  buttonClass: 'bpx-player-ctrl-btn scenevoice-button',
  buttonStyle: 'width:36px;height:22px;padding:0;border:0;background:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;',
});
