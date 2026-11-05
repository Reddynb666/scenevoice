// What the listener pasted: a YouTube link in any of its forms, a bare video
// id, or a Bilibili link (recognised so the page can say why it cannot play it).
// No browser APIs here, so everything is unit-testable.

const ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_ID = /^\/(?:shorts|live|embed|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;

/** "1h2m3s", "1m30s", "90" → seconds; NaN when it is none of these. */
export function parseStart(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m || !(m[1] || m[2] || m[3])) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function hostOf(url) {
  return url.hostname.toLowerCase().replace(/^(www|m|music|mobile)\./, '');
}

/**
 * @returns {{videoId: string, start: number} | {bilibili: true} | null}
 *   the YouTube video and where to start (0 when the link says nothing),
 *   {bilibili: true} for a Bilibili link, null for anything else.
 */
export function parseVideoLink(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (ID.test(raw)) return { videoId: raw, start: 0 };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = hostOf(url);
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') return { bilibili: true };
  const youtube = host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be';
  if (!youtube) return null;
  const start = parseStart(url.searchParams.get('t') || url.searchParams.get('start') || url.hash.match(/t=([^&]+)/)?.[1]);
  const found = (id) => (id && ID.test(id) ? { videoId: id, start: Number.isFinite(start) && start > 0 ? Math.floor(start) : 0 } : null);
  if (host === 'youtu.be') return found(url.pathname.slice(1, 12));
  const v = url.searchParams.get('v');
  if (v) return found(v);
  const path = url.pathname.match(PATH_ID);
  if (path) return found(path[1]);
  // youtube.com/attribution_link?u=%2Fwatch%3Fv%3DID
  const u = url.searchParams.get('u');
  if (u) {
    try {
      return parseVideoLink(new URL(u, 'https://www.youtube.com').href);
    } catch {
      return null;
    }
  }
  return null;
}
