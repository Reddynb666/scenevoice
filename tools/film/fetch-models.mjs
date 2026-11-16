#!/usr/bin/env node
// Downloads the two face models the kill tests use, from the OpenCV model zoo
// on Hugging Face: the YuNet face detector and the SFace face recogniser. For
// each repository it lists the files through the Hugging Face API, takes the
// current full-precision .onnx, reads LICENSE and README.md, and stops if the
// licence is not the expected one (MIT for YuNet, Apache-2.0 for SFace). The
// download is checked against the SHA-256 the API states. Writes
// models/manifest.json. Nothing else is downloaded.
//
// Usage: node fetch-models.mjs [--dir models]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { download, fetchJson, fetchText, progressLine } from './lib/download.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = 'https://huggingface.co';

const MODELS = [
  { id: 'yunet', repo: 'opencv/face_detection_yunet', stem: /^face_detection_yunet_(\d{4})([a-z]{3})\.onnx$/, licence: 'MIT' },
  { id: 'sface', repo: 'opencv/face_recognition_sface', stem: /^face_recognition_sface_(\d{4})([a-z]{3})\.onnx$/, licence: 'Apache-2.0' },
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const { values: options } = parseArgs({
  options: { dir: { type: 'string', default: join(HERE, 'models') } },
});

/** The licence a LICENSE file is, from its own opening words. */
function licenceOfText(text) {
  const head = text.slice(0, 600).replace(/\s+/g, ' ').trim();
  if (/^MIT License\b/i.test(head)) return 'MIT';
  if (/^Apache License,? Version 2\.0\b/i.test(head)) return 'Apache-2.0';
  if (/^BSD 3-Clause/i.test(head)) return 'BSD-3-Clause';
  if (/^BSD 2-Clause/i.test(head)) return 'BSD-2-Clause';
  return null;
}

/** The licence sentence of a README, e.g. "All files in this directory are licensed under [MIT License](./LICENSE)." */
function licenceSentence(readme) {
  const line = readme.split(/\r?\n/).find((text) => /licensed under/i.test(text));
  return line ? line.trim() : null;
}

function licenceOfSentence(sentence) {
  if (!sentence) return null;
  if (/\bMIT\b/.test(sentence)) return 'MIT';
  if (/Apache[ -]?(License[, ]*)?(Version )?2(\.0)?/i.test(sentence)) return 'Apache-2.0';
  return null;
}

/** The newest full-precision model in a file listing: no _int8, no _int8bq, latest year and month in the name. */
function pickModel(files, stem) {
  const dated = files
    .map((file) => ({ file, match: stem.exec(file.path) }))
    .filter((entry) => entry.match)
    .map(({ file, match }) => ({ file, order: Number(match[1]) * 12 + MONTHS.indexOf(match[2]) }))
    .sort((a, b) => b.order - a.order);
  return dated[0]?.file || null;
}

async function fetchModel(model, dir) {
  const { json: repo } = await fetchJson(`${HUB}/api/models/${model.repo}`);
  const revision = repo.sha;
  if (!/^[0-9a-f]{40}$/.test(revision || '')) throw new Error(`${model.repo}: the API gave no commit id`);
  const { json: files } = await fetchJson(`${HUB}/api/models/${model.repo}/tree/${revision}`);
  const picked = pickModel(files, model.stem);
  if (!picked) throw new Error(`${model.repo}: no full-precision .onnx found among ${files.map((f) => f.path).join(', ')}`);
  if (!picked.lfs?.oid) throw new Error(`${model.repo}: the API states no SHA-256 for ${picked.path}`);

  const licenceText = (await fetchText(`${HUB}/${model.repo}/raw/${revision}/LICENSE`)).text;
  const readme = (await fetchText(`${HUB}/${model.repo}/raw/${revision}/README.md`)).text;
  const fromFile = licenceOfText(licenceText);
  const sentence = licenceSentence(readme);
  const fromReadme = licenceOfSentence(sentence);
  if (fromFile !== model.licence || fromReadme !== model.licence) {
    throw new Error(
      `${model.repo}: expected ${model.licence}, but LICENSE reads as ${fromFile || 'unrecognised'} and README says: ${sentence || '(no licence sentence)'}. `
      + 'Nothing was downloaded from this repository. Read both files and decide before going on.',
    );
  }

  const url = `${HUB}/${model.repo}/resolve/${revision}/${picked.path}`;
  const got = await download(url, join(dir, picked.path), {
    bytes: picked.lfs.size,
    sha256: picked.lfs.oid,
    onProgress: progressLine(picked.path),
  });
  return {
    id: model.id,
    file: picked.path,
    url,
    sha256: got.sha256,
    bytes: got.bytes,
    licence: model.licence,
    source: `${HUB}/${model.repo} at ${revision}`,
    licenceEvidence: {
      licenceFile: `${HUB}/${model.repo}/blob/${revision}/LICENSE`,
      licenceFileOpens: licenceText.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(' / '),
      readme: sentence,
    },
  };
}

async function main() {
  const dir = resolve(options.dir);
  await mkdir(dir, { recursive: true });
  const entries = [];
  // One after the other: if either licence is not as expected, stop before the next download.
  for (const model of MODELS) entries.push(await fetchModel(model, dir));
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(entries, null, 2)}\n`);
  for (const entry of entries) console.log(`${entry.id}: ${entry.file}, ${entry.bytes} bytes, ${entry.licence}, sha256 ${entry.sha256}`);
  console.log(`wrote ${join(dir, 'manifest.json')}`);
}

main().catch((error) => {
  console.error(`fetch-models failed: ${error.message}`);
  process.exitCode = 1;
});
