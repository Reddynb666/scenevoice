## What this changes

<!-- One paragraph: what a user hears or does differently, and why. -->

## Checklist

- [ ] Accessibility: every new control is keyboard-reachable with a spoken name; status goes through `announcer.status` and never cuts off a description being read; the screen reader and the built-in voice never speak at once; the ask dialog still traps focus. Tested with a screen reader, or `CONTRIBUTING.md`'s checklist says what is still untested.
- [ ] Every user-visible string is in `scripts/locales/en.mjs` and `scripts/locales/zh_CN.mjs` (same key, same placeholders), in natural Chinese.
- [ ] No new permissions, analytics or network requests other than the model APIs (and SceneVoice Cloud where it applies); keys travel only in headers.
- [ ] `npm test` and `npm run build` pass; `npm run test:e2e` when the UI changed; new behaviour has a vitest test.
- [ ] `CHANGELOG.md` (under *Unreleased*), both READMEs and `PRIVACY.md` / `PRIVACY.zh-CN.md` are in step with the change.
