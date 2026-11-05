// CHANGELOG.md helpers shared by scripts/release.mjs and the release workflow.
//
// The file is "Keep a Changelog" shaped: "## Unreleased" on top, then one
// "## x.y.z — YYYY-MM-DD" heading per version, newest first. Nothing here
// parses the entries themselves; only the headings matter.

const VERSION_HEADING = /^## (\d+\.\d+\.\d+)\b.*$/m;

/** The version named by the first "## x.y.z" heading, or null when there is none. */
export function firstVersion(changelog) {
  const m = changelog.match(VERSION_HEADING);
  return m ? m[1] : null;
}

/**
 * Split a changelog into its "## " sections, in order. Each section keeps its
 * heading line and the body up to (not including) the next heading.
 */
function sections(changelog) {
  const out = [];
  const lines = changelog.split('\n');
  let current = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      current = { heading: line, body: [] };
      out.push(current);
    } else if (current) current.body.push(line);
    else out.push({ heading: null, body: [line] });
  }
  return out;
}

/** The entries under one version's heading, trimmed, or null if the version has no section. */
export function sectionFor(changelog, version) {
  const section = sections(changelog).find((s) => s.heading && new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`).test(s.heading));
  return section ? section.body.join('\n').trim() : null;
}

/**
 * Move everything under "## Unreleased" into a new "## <version> — <date>"
 * section and leave a fresh, empty Unreleased on top. Throws when there is no
 * Unreleased heading, when it is empty (nothing to release) or when the
 * version already has a section. Returns the new text and the released notes.
 */
export function cutUnreleased(changelog, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a date: ${date}`);
  if (sectionFor(changelog, version) !== null) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const parts = sections(changelog);
  const unreleased = parts.find((s) => s.heading && /^## Unreleased\s*$/i.test(s.heading));
  if (!unreleased) throw new Error('CHANGELOG.md has no "## Unreleased" heading');
  const notes = unreleased.body.join('\n').trim();
  if (!notes) throw new Error('nothing under "## Unreleased" to release');
  const rebuilt = parts.map((s) => {
    if (s === unreleased) return `## Unreleased\n\n## ${version} — ${date}\n\n${notes}\n`;
    if (s.heading === null) return s.body.join('\n');
    return `${s.heading}\n${s.body.join('\n')}`;
  });
  return { text: `${rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, notes };
}
