// Upload a package to the Microsoft Edge Add-ons draft submission, and
// optionally publish it, through the Partner Center REST API (v1.1, API key).
//
//   node scripts/edge-upload.mjs scenevoice-1.1.0.zip               upload to the draft only
//   node scripts/edge-upload.mjs scenevoice-1.1.0.zip --publish     upload, then publish the draft
//
// Environment: EDGE_PRODUCT_ID (the GUID on the extension's overview page),
// EDGE_CLIENT_ID and EDGE_API_KEY (Partner Center > Publish API > Create API
// credentials). The API only updates an extension that was first published by
// hand; see docs/release.md. Reference:
// https://learn.microsoft.com/microsoft-edge/extensions-chromium/publish/api/using-addons-api

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const API = 'https://api.addons.microsoftedge.microsoft.com';
const POLL_MS = 5000;
const POLL_LIMIT = 120; // 10 minutes

const [file, ...flags] = process.argv.slice(2);
const publish = flags.includes('--publish');
const { EDGE_PRODUCT_ID: productId, EDGE_CLIENT_ID: clientId, EDGE_API_KEY: apiKey } = process.env;

function fail(message) {
  console.error(`edge-upload: ${message}`);
  process.exit(1);
}

if (!file || !file.endsWith('.zip')) fail('usage: node scripts/edge-upload.mjs <package.zip> [--publish]');
if (!productId || !clientId || !apiKey) fail('EDGE_PRODUCT_ID, EDGE_CLIENT_ID and EDGE_API_KEY must be set');

const headers = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };

/** POST that the API answers with 202 and the operation id in the Location header. */
async function start(path, body, contentType) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': contentType }, body });
  if (res.status !== 202) fail(`${path} answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const location = res.headers.get('location') || '';
  const operationId = location.split('/').filter(Boolean).pop();
  if (!operationId) fail(`${path} gave no operation id (Location: ${location})`);
  return operationId;
}

/** Poll an operation until it leaves InProgress; fail on anything but Succeeded. */
async function wait(path, what) {
  for (let i = 0; i < POLL_LIMIT; i++) {
    const res = await fetch(`${API}${path}`, { headers });
    const text = await res.text();
    let status = '';
    let message = '';
    try {
      const json = JSON.parse(text);
      status = json.status || '';
      message = json.message || (json.errors || []).map((e) => e.message).join('; ');
    } catch {
      message = text.slice(0, 300);
    }
    if (!res.ok || status === 'Failed') fail(`${what} failed (${res.status} ${status}): ${message}`);
    if (status === 'Succeeded') return;
    console.log(`edge-upload: ${what} ${status || 'pending'}…`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  fail(`${what} did not finish within ${(POLL_LIMIT * POLL_MS) / 60000} minutes`);
}

const zip = readFileSync(file);
console.log(`edge-upload: uploading ${basename(file)} (${zip.length} bytes) to product ${productId}`);
const uploadId = await start(`/v1/products/${productId}/submissions/draft/package`, zip, 'application/zip');
await wait(`/v1/products/${productId}/submissions/draft/package/operations/${uploadId}`, 'package upload');
console.log('edge-upload: the draft submission now holds this package.');

if (publish) {
  const notes = `Automated upload of ${basename(file)}. Test steps are in the certification notes kept in Partner Center.`;
  const publishId = await start(`/v1/products/${productId}/submissions`, JSON.stringify({ notes }), 'application/json');
  await wait(`/v1/products/${productId}/submissions/operations/${publishId}`, 'publish');
  console.log('edge-upload: submitted for certification.');
} else {
  console.log('edge-upload: not published (pass --publish, or submit the draft in Partner Center).');
}
