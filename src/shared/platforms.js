// Which site a video belongs to, from its address or from the id SceneVoice
// keeps it under. No browser APIs here, so everything is unit-testable.
//
// YouTube videos keep their own 11-character id, as before. A Bilibili video
// is "bili:" + its BV (or av) number, with ":p<n>" for part n of a video with
// several parts (分P) other than the first: "bili:BV1GJ411x7h7:p2".

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const BILI_ID = /^bili:(BV[0-9A-Za-z]{10}|av\d{1,12})(?::p(\d{1,4}))?$/;

/** 'youtube' | 'bilibili' for an address SceneVoice runs on, else null. */
export function platformOfUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === 'www.bilibili.com' && url.pathname.startsWith('/video/')) return 'bilibili';
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)) return 'youtube';
  return null;
}

/** The SceneVoice id of a Bilibili video page (www.bilibili.com/video/BV…/?p=2), or null. */
export function bilibiliIdFromUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== 'www.bilibili.com') return null;
  const m = /^\/video\/(BV[0-9A-Za-z]{10}|av\d{1,12})(?:\/|$)/.exec(url.pathname);
  if (!m) return null;
  const ref = m[1];
  const page = parseInt(url.searchParams.get('p') || '1', 10);
  return Number.isInteger(page) && page > 1 && page < 10000 ? `bili:${ref}:p${page}` : `bili:${ref}`;
}

/** { bvid, aid, page } for a Bilibili id; null for anything else. */
export function parseBilibiliVideoId(id) {
  const m = BILI_ID.exec(String(id || ''));
  if (!m) return null;
  const page = m[2] ? parseInt(m[2], 10) : 1;
  return m[1].startsWith('BV') ? { bvid: m[1], aid: '', page } : { bvid: '', aid: m[1].slice(2), page };
}

/** The site of a video id SceneVoice uses, or null when it is not one. */
export function platformOfVideoId(id) {
  if (parseBilibiliVideoId(id)) return 'bilibili';
  return YOUTUBE_ID.test(String(id || '')) ? 'youtube' : null;
}

/** The page where a video can be watched. */
export function videoPageUrl(id) {
  const bili = parseBilibiliVideoId(id);
  if (bili) {
    const path = bili.bvid || `av${bili.aid}`;
    return `https://www.bilibili.com/video/${path}/${bili.page > 1 ? `?p=${bili.page}` : ''}`;
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(String(id || ''))}`;
}
