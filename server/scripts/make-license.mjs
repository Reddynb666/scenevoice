#!/usr/bin/env node
// Prints a new SceneVoice licence key and the wrangler command that stores it,
// for organisations that pay by invoice instead of through Stripe.
//
//   node server/scripts/make-license.mjs [--plan plus|org] [--seats N] [--note "Blind school X"]
//
// Nothing is written anywhere: copy the printed command, run it, and send the
// key to the organisation. The note goes into the record so the owner can tell
// licences apart later; keep it to the organisation's name, not people.

import { randomLicenceKey } from '../src/util.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: make-license.mjs [--plan plus|org] [--seats N] [--note "organisation"]');
  process.exit(0);
}

const plan = opt('plan', 'org');
if (!['plus', 'org'].includes(plan)) {
  console.error('--plan must be plus or org');
  process.exit(1);
}
const seats = parseInt(opt('seats', '1'), 10);
if (!Number.isInteger(seats) || seats < 1 || seats > 10000) {
  console.error('--seats must be a whole number from 1 to 10000');
  process.exit(1);
}
const note = String(opt('note', '')).slice(0, 120);

const key = randomLicenceKey();
const record = { plan, seats, used: 0, created: new Date().toISOString(), session: null };
if (note) record.note = note;

console.log(`Licence key: ${key}`);
console.log(`Plan: ${plan}, seats: ${seats}${note ? `, note: ${note}` : ''}`);
console.log('');
console.log('Store it (run from the server/ folder; add --preview false on older wrangler versions):');
console.log(`  npx wrangler kv key put --binding LICENSES --remote ${JSON.stringify(key)} ${JSON.stringify(JSON.stringify(record))}`);
console.log('');
console.log('Revoke it later with:');
console.log(`  npx wrangler kv key delete --binding LICENSES --remote ${JSON.stringify(key)}`);
