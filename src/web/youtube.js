// The YouTube IFrame Player API on the web player page. The API script is the
// one script the page loads from anyone but SceneVoice, and it is loaded only
// when the listener presses Play. The player is created on the
// youtube-nocookie.com host; if it never reports ready there (an old report
// says so for some setups), it is made again on www.youtube.com.

/** Where the API script comes from: there is no copy of it on the nocookie host (404). */
export const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';
export const HOSTS = Object.freeze(['https://www.youtube-nocookie.com', 'https://www.youtube.com']);

/** Load the API once; resolves with the YT namespace. Rejects with Error('network') or Error('timeout'). */
export function loadIframeApi(win, { timeoutMs = 15000 } = {}) {
  if (win.YT?.Player) return Promise.resolve(win.YT);
  if (!win.__scenevoiceYtApi) {
    win.__scenevoiceYtApi = new Promise((resolve, reject) => {
      const previous = win.onYouTubeIframeAPIReady;
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      win.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        try {
          previous?.();
        } catch {
          /* someone else's handler */
        }
        resolve(win.YT);
      };
      const script = win.document.createElement('script');
      script.src = IFRAME_API_SRC;
      script.async = true;
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error('network'));
      };
      win.document.head.appendChild(script);
    }).catch((err) => {
      win.__scenevoiceYtApi = null; // so the next press tries again
      throw err;
    });
  }
  return win.__scenevoiceYtApi;
}

/**
 * Make a player in `el` (the element is replaced by the iframe). Resolves with
 * the player once it is ready; rejects with Error('timeout') when it is not
 * within timeoutMs. The iframe is kept out of the Tab order: the page's own
 * controls drive the video, and keys pressed inside the iframe never reach the page.
 */
export function createPlayer(YT, el, { videoId, start = 0, origin, host = HOSTS[0], title = '', events = {}, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let player = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        player?.destroy?.();
      } catch {
        /* never got far enough to destroy */
      }
      reject(new Error('timeout'));
    }, timeoutMs);
    const playerVars = { enablejsapi: 1, origin, playsinline: 1, rel: 0 };
    if (start > 0) playerVars.start = Math.floor(start);
    player = new YT.Player(el, {
      host,
      videoId,
      width: '100%',
      height: '100%',
      playerVars,
      events: {
        onReady: (e) => {
          clearTimeout(timer);
          const iframe = player.getIframe?.();
          if (iframe) {
            iframe.setAttribute('tabindex', '-1');
            if (title) iframe.setAttribute('title', title);
          }
          if (!settled) {
            settled = true;
            resolve(player);
          }
          events.onReady?.(e);
        },
        onStateChange: (e) => events.onStateChange?.(e),
        onError: (e) => {
          // Before ready, an error is the answer: the video cannot play here.
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const err = new Error('video');
            err.code = e?.data;
            reject(err);
          }
          events.onError?.(e);
        },
        onPlaybackRateChange: (e) => events.onPlaybackRateChange?.(e),
      },
    });
  });
}
