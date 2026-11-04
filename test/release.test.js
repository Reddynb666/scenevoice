import { describe, expect, it } from 'vitest';
import { cutUnreleased, firstVersion, sectionFor } from '../scripts/changelog.mjs';

const CHANGELOG = `# Changelog

## Unreleased

- Something new.
- Something fixed.

## 1.0.0 — 2026-10-29

- First release.
`;

describe('changelog cutting', () => {
  it('moves the Unreleased entries under a dated version heading and leaves Unreleased empty', () => {
    const { text, notes } = cutUnreleased(CHANGELOG, '1.1.0', '2026-11-04');
    expect(notes).toBe('- Something new.\n- Something fixed.');
    expect(text).toBe(`# Changelog

## Unreleased

## 1.1.0 — 2026-11-04

- Something new.
- Something fixed.

## 1.0.0 — 2026-10-29

- First release.
`);
    // Cutting twice in a row has nothing to release.
    expect(() => cutUnreleased(text, '1.2.0', '2026-11-05')).toThrow(/nothing under/);
  });

  it('refuses when the version already exists, the heading is missing, or the inputs are malformed', () => {
    expect(() => cutUnreleased(CHANGELOG, '1.0.0', '2026-11-04')).toThrow(/already has a section/);
    expect(() => cutUnreleased('# Changelog\n\n## 1.0.0 — 2026-10-29\n\n- x\n', '1.1.0', '2026-11-04')).toThrow(/no "## Unreleased"/);
    expect(() => cutUnreleased(CHANGELOG, 'v1.1.0', '2026-11-04')).toThrow(/not a version/);
    expect(() => cutUnreleased(CHANGELOG, '1.1.0', '4 Nov 2026')).toThrow(/not a date/);
  });

  it('reads the first released version and the notes of a given version', () => {
    expect(firstVersion(CHANGELOG)).toBe('1.0.0');
    expect(firstVersion('# Changelog\n\n## Unreleased\n')).toBeNull();
    const { text } = cutUnreleased(CHANGELOG, '1.1.0', '2026-11-04');
    expect(firstVersion(text)).toBe('1.1.0');
    expect(sectionFor(text, '1.1.0')).toBe('- Something new.\n- Something fixed.');
    expect(sectionFor(text, '1.0.0')).toBe('- First release.');
    expect(sectionFor(text, '1.10.0')).toBeNull();
    // 1.1.0 must not match 1.1.0-rc or 1.1.01 style headings by prefix.
    expect(sectionFor('## 1.1.01 — 2026-01-01\n\n- no\n', '1.1.0')).toBeNull();
  });
});
