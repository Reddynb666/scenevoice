// The manifest as it is built: static/manifest.json with the package version,
// and the SceneVoice Cloud relay's host permission only while Cloud is open.
// static/manifest.json names the two model hosts and nothing else; the relay's
// host is added here, from the same constants the code uses, so a build with
// Cloud closed asks for no permission it does not use (both stores refuse a
// permission kept for a feature that is not there yet). Its own module, with
// no side effects, so tests can call it with the switch either way.
//
// Also here: the rule that ties the relay's address to the switch. While Cloud
// is closed the address is a placeholder on .invalid, a name that can never
// resolve, so nothing built from this source names a host the project does not
// hold; a build with Cloud open and the placeholder still in place is refused.

import { CLOUD_API_BASE, CLOUD_OPEN } from '../src/shared/constants.js';

/** The host permission the relay needs: its origin, every path. */
export const CLOUD_HOST_PERMISSION = `${new URL(CLOUD_API_BASE).origin}/*`;

/** Whether an address is on the reserved .invalid top-level domain (RFC 2606): it never resolves. */
export const isPlaceholderAddress = (base) => new URL(base).hostname.endsWith('.invalid');

/**
 * What is wrong with the relay's address for the state of the switch, or '' when nothing is.
 * Closed: the placeholder, and nothing else. Open: an https address that is not the placeholder
 * (or http on localhost, for a relay run on the developer's own computer).
 * @param {{cloudOpen?: boolean, base?: string}} [o]  the switch and the address (the constants unless given)
 * @returns {string}
 */
export function relayAddressProblem({ cloudOpen = CLOUD_OPEN, base = CLOUD_API_BASE } = {}) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return `CLOUD_API_BASE is not an address: ${base}`;
  }
  // Plain http only for a relay on this computer (server/README.md, local development).
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) return `CLOUD_API_BASE must be an https address: ${base}`;
  if (!cloudOpen && !isPlaceholderAddress(base)) return `SceneVoice Cloud is closed, so CLOUD_API_BASE must stay a placeholder on .invalid, not ${url.hostname}: a real host goes in only with the change that opens Cloud, and only on a domain the owner holds`;
  if (cloudOpen && isPlaceholderAddress(base)) return `SceneVoice Cloud is open but CLOUD_API_BASE is still the placeholder ${url.hostname}: set it to the relay's address, on a domain the owner holds`;
  return '';
}

/**
 * @param {object} manifest  static/manifest.json, parsed
 * @param {{version: string, cloudOpen?: boolean}} o  the package version, and the Cloud switch (CLOUD_OPEN unless given)
 * @returns {object} the manifest to write into the build; the argument is not changed
 */
export function stampManifest(manifest, { version, cloudOpen = CLOUD_OPEN }) {
  const hosts = (manifest.host_permissions || []).filter((h) => h !== CLOUD_HOST_PERMISSION);
  return { ...manifest, version, host_permissions: cloudOpen ? [...hosts, CLOUD_HOST_PERMISSION] : hosts };
}
