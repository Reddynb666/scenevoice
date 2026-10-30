// Page helpers that do not depend on the site.

/**
 * The element to render into while the player is fullscreen, so overlays stay visible
 * and reachable. A <video> element itself cannot hold children, so use its parent.
 */
export function containerForOverlays() {
  const fs = document.fullscreenElement;
  if (!fs) return document.body;
  return fs.tagName === 'VIDEO' ? fs.parentElement || document.body : fs;
}
