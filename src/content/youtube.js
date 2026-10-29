// Everything that knows about YouTube's page structure lives here,
// so a YouTube redesign only needs changes in one file.

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function videoIdFromUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)) return null;
  const v = url.searchParams.get('v');
  if (url.pathname === '/watch' && v && ID_RE.test(v)) return v;
  const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

export function isShorts(href = location.href) {
  return /\/shorts\//.test(href);
}

export function getPlayer() {
  if (isShorts()) {
    return (
      document.querySelector('ytd-reel-video-renderer[is-active] #shorts-player') ||
      document.querySelector('#shorts-player') ||
      document.querySelector('.html5-video-player')
    );
  }
  return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
}

export function getVideo() {
  const player = getPlayer();
  const v = player?.querySelector('video.html5-main-video') || player?.querySelector('video');
  if (v) return v;
  const all = [...document.querySelectorAll('video')];
  return all.find((el) => !el.paused) || all[0] || null;
}

export function isAdShowing() {
  const player = getPlayer();
  return Boolean(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
}

/** Parse an ISO-8601 duration such as PT1H2M3S into seconds; NaN if absent. */
export function parseIsoDuration(value) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || '');
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return NaN;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}

/** The video's length as the page declares it, independent of any ad playing in the player. */
export function getPageDuration() {
  return parseIsoDuration(document.querySelector('meta[itemprop="duration"]')?.getAttribute('content'));
}

function text(sel) {
  const el = document.querySelector(sel);
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

export function getMeta() {
  const title =
    text('ytd-watch-metadata h1') ||
    text('ytd-reel-video-renderer[is-active] h2') ||
    text('.ytp-title-link') ||
    document.title.replace(/\s*-\s*YouTube\s*$/, '').replace(/^\(\d+\)\s*/, '');
  const channel = text('ytd-watch-metadata ytd-channel-name a') || text('ytd-video-owner-renderer ytd-channel-name a') || text('.ytp-title-channel-name');
  const description =
    text('ytd-watch-metadata #description-inline-expander yt-attributed-string') ||
    text('ytd-watch-metadata #description-inline-expander') ||
    document.querySelector('meta[name="description"]')?.getAttribute('content') ||
    '';
  return { title, channel, description: description.slice(0, 2000) };
}

/**
 * The element to render into while the player is fullscreen, so overlays stay visible
 * and reachable. A <video> element itself cannot hold children, so use its parent.
 */
export function containerForOverlays() {
  const fs = document.fullscreenElement;
  if (!fs) return document.body;
  return fs.tagName === 'VIDEO' ? fs.parentElement || document.body : fs;
}

/** Call fn() whenever YouTube's single-page navigation lands on a new page. */
export function onNavigate(fn) {
  let last = location.href;
  const check = () => {
    if (location.href !== last) {
      last = location.href;
      fn();
    }
  };
  document.addEventListener('yt-navigate-finish', () => {
    last = location.href;
    fn();
  });
  window.addEventListener('popstate', check);
  setInterval(check, 1000);
}

// ---------- captions (for real dialogue timing) ----------

/**
 * The caption tracks listed in a watch page's player response.
 * @returns {Array<{baseUrl: string, languageCode: string, kind: string}>}
 */
export function extractCaptionTracks(html) {
  const key = '"captionTracks":';
  const at = typeof html === 'string' ? html.indexOf(key) : -1;
  if (at < 0) return [];
  const from = html.indexOf('[', at + key.length);
  if (from < 0) return [];
  // Find the matching bracket, skipping over strings.
  let depth = 0;
  let inString = false;
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const list = JSON.parse(html.slice(from, i + 1));
          return Array.isArray(list)
            ? list
              .filter((tr) => tr && typeof tr.baseUrl === 'string')
              .map((tr) => ({ baseUrl: tr.baseUrl, languageCode: tr.languageCode || '', kind: tr.kind || '' }))
            : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/**
 * The track whose timing best follows the spoken dialogue: subtitles written for
 * the spoken language, then auto-generated captions (always in the spoken
 * language, timed word by word), then any subtitles.
 */
export function pickCaptionTrack(tracks) {
  if (!tracks?.length) return null;
  const asr = tracks.find((tr) => tr.kind === 'asr');
  const manual = tracks.filter((tr) => tr.kind !== 'asr');
  return (asr && manual.find((tr) => tr.languageCode === asr.languageCode)) || asr || manual[0] || null;
}

/** A timedtext URL for one track, asking for the json3 format. Null for anything but YouTube's timedtext API. */
export function timedTextUrl(baseUrl, origin = location.origin) {
  let url;
  try {
    url = new URL(baseUrl, origin);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(url.hostname) || url.pathname !== '/api/timedtext') return null;
  url.searchParams.set('fmt', 'json3');
  return url.href;
}

/**
 * Remember the caption requests the player itself makes (when captions are
 * turned on). They carry tokens a plain request may lack, so they are the most
 * reliable source. Calls fn(videoId, url) for each one.
 */
export function watchTimedTextRequests(fn) {
  const seen = (entry) => {
    if (!entry.name.includes('/api/timedtext')) return;
    try {
      const url = new URL(entry.name);
      const v = url.searchParams.get('v');
      if (url.origin === location.origin && v) fn(v, url.href);
    } catch {
      /* not a URL */
    }
  };
  try {
    new PerformanceObserver((list) => list.getEntries().forEach(seen)).observe({ type: 'resource', buffered: true });
  } catch {
    /* PerformanceObserver unavailable */
  }
}

/** Fetch the caption tracks listed on this video's watch page. Same origin as the page. */
export async function fetchCaptionTracks(videoId) {
  const res = await fetch(`${location.origin}/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'same-origin' });
  if (!res.ok) return [];
  return extractCaptionTracks(await res.text());
}

export function rightControls() {
  return getPlayer()?.querySelector('.ytp-right-controls') || null;
}
