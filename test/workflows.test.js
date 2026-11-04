// Pins the parts of the GitHub workflows that a review found wrong once:
// the bundle-size gate must survive the pipe into tee, the store credentials
// must stay out of every step that does not upload, and the two store uploads
// must not depend on each other. Plain text checks: the repository has no YAML
// parser and the files are small.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

/** The steps of a single-job workflow, each as its own text block (steps are list items indented by six spaces). */
function steps(yaml) {
  const body = yaml.slice(yaml.indexOf('\n    steps:'));
  return body.split(/\n {6}- /).slice(1);
}

const workflows = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];

describe('workflows', () => {
  it('runs every piped build step under bash, so a failed size check fails the step', () => {
    for (const file of workflows) {
      const piped = steps(read(file)).filter((s) => /\|\s*tee\b/.test(s));
      expect(piped.length, `${file} has the build:meta | tee step`).toBeGreaterThan(0);
      for (const step of piped) expect(step, `${file}: a step piping into tee needs shell: bash (pipefail)`).toMatch(/\n\s+shell: bash\n/);
    }
  });

  it('gives the store secrets to the upload steps only', () => {
    const yaml = read('.github/workflows/release.yml');
    // No job-level env (four spaces: a key of the job itself).
    expect(yaml).not.toMatch(/\n {4}env:\n/);
    const secret = /secrets\.(CWS_CLIENT_SECRET|CWS_REFRESH_TOKEN|EDGE_API_KEY)\b/;
    const allowed = /^name: (Which store credentials exist|Chrome Web Store|Edge Add-ons)/;
    const seen = [];
    for (const step of steps(yaml)) {
      if (!secret.test(step)) continue;
      expect(step, 'a step other than the store steps reads a store secret').toMatch(allowed);
      seen.push(step.match(allowed)[1]);
    }
    expect(seen).toEqual(['Which store credentials exist', 'Chrome Web Store', 'Edge Add-ons']);
    // The secrets are read in step env blocks, never interpolated into a command line (they would show in the log).
    for (const line of yaml.split('\n')) if (secret.test(line)) expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
  });

  it('needs all five Chrome Web Store secrets, the publisher id included, and uploads to each store independently', () => {
    const yaml = read('.github/workflows/release.yml');
    const [gate, cws, edge] = ['Which store credentials exist', 'Chrome Web Store', 'Edge Add-ons'].map((name) =>
      steps(yaml).find((s) => s.startsWith(`name: ${name}`)));
    for (const name of ['CWS_EXTENSION_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID']) {
      expect(gate, `the gate checks ${name}`).toMatch(new RegExp(`\\[ -n "\\$${name}" \\]`));
    }
    expect(cws).toMatch(/\n\s+if: steps\.stores\.outputs\.cws == 'true'\n/);
    expect(cws).toMatch(/PUBLISHER_ID: \$\{\{ secrets\.CWS_PUBLISHER_ID \}\}/);
    // The Edge upload runs after a failed Chrome upload, but only when the gate (hence everything before it) succeeded.
    expect(edge).toMatch(/\n\s+if: \$\{\{ !cancelled\(\) && steps\.stores\.outputs\.edge == 'true' \}\}\n/);
    for (const name of ['EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY']) {
      expect(edge, `the Edge step passes ${name} to scripts/edge-upload.mjs`).toMatch(new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
    }
  });

  it('cuts a release with the bundle-size check, not the plain build', () => {
    const script = read('scripts/release.mjs');
    expect(script).toMatch(/run\('npm', \['run', 'build:meta'\]\)/);
    expect(script).not.toMatch(/run\('npm', \['run', 'build'\]\)/);
  });
});
