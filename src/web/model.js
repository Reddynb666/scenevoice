// Which model the web player talks to and how: the listener's own Gemini key
// straight to generativelanguage.googleapis.com, or SceneVoice Cloud (the
// relay, Gemini-compatible) with an anonymous device token. Either credential
// travels in the x-goog-api-key header only; the GeminiClient never puts it in
// a URL. Error messages are the extension's, with the page's own words where
// the extension's point to a settings page that does not exist here.

import { CLOUD_API_BASE, DEFAULT_API_BASE } from '../shared/constants.js';
import { cleanAllowance, cloudRequest, validToken } from '../shared/cloud.js';
import { ApiError } from '../shared/errors.js';
import { GeminiClient } from '../shared/gemini.js';
import { errorMessage, resetTimeText, t } from './i18n.js';

/** A client for the listener's own key, or for the relay with a device token. `model` '' = pick one from the key's list. */
export function makeClient({ source, key = '', token = '', model = '', fetchImpl }) {
  if (source === 'cloud') {
    if (!token) throw new ApiError('no-key');
    return new GeminiClient({ apiKey: token, apiBase: CLOUD_API_BASE, model, fetchImpl });
  }
  if (!key) throw new ApiError('no-key');
  return new GeminiClient({ apiKey: key, apiBase: DEFAULT_API_BASE, model, fetchImpl });
}

/** The provider name the error messages use for a source. */
export const providerOf = (source) => (source === 'cloud' ? 'cloud' : 'gemini');

/**
 * Register this browser with the relay and get its device token (shared/cloud.js
 * registerDevice, saying client "web"). Resolves { token, plan, allowance }.
 */
export async function registerWebDevice(fetchImpl, { version = '', locale = '' } = {}) {
  const { status, body } = await cloudRequest(fetchImpl, '/v1/devices', { method: 'POST', body: { client: 'web', version, locale } });
  const detail = String(body?.error?.message || `HTTP ${status}`);
  if (status === 429) {
    const details = Array.isArray(body?.error?.details) ? body.error.details : [];
    const limit = details.find((d) => d?.reason === 'SCENEVOICE_DEVICE_LIMIT');
    if (limit) {
      const err = new ApiError('device-limit', detail, status);
      err.resetAt = cleanAllowance(limit).resetsAt;
      throw err;
    }
    throw new ApiError('rate-limited', detail, status);
  }
  if (status < 200 || status >= 300 || !validToken(body?.token)) throw new ApiError('request-failed', detail, status);
  return { token: body.token, plan: body.plan, allowance: cleanAllowance(body.allowance) };
}

/**
 * The message for an error on the page: the page's own words for the codes
 * whose extension message points to the settings page (web_error_*,
 * web_error_cloud_*), the extension's otherwise.
 */
export function webErrorMessage(err, provider = 'gemini') {
  const code = err instanceof ApiError ? err.code : typeof err === 'string' ? err : 'unknown';
  const key = String(code || 'unknown').replace(/-/g, '_');
  if (code === 'allowance') return t('web_error_allowance', resetTimeText(err?.resetAt));
  if (code === 'device-limit') return t('error_cloud_device_limit', resetTimeText(err?.resetAt));
  if (provider === 'cloud') {
    const own = t(`web_error_cloud_${key}`);
    if (!own.startsWith('web_error_')) return own;
  }
  const own = t(`web_error_${key}`);
  if (!own.startsWith('web_error_')) return own;
  return errorMessage(code, provider);
}
