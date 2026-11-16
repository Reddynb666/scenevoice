// The root test run covers the extension, the web player, the relay (server/test),
// the site and the film engine (src/film). The desktop app (desktop/) and the film
// command-line tools (tools/) keep their own tests, runners and dependencies
// (Electron, Playwright, onnxruntime): they are not installed here, so the root run
// must not collect them. CI and `npm run release` run the root
// suite on a checkout that has never installed desktop/.
//
// .claude/ is excluded too: in the main checkout the other worktrees live under
// .claude/worktrees/, each with a full copy of the tests (and of desktop/ and
// tools/), and vitest looks into dot folders. Without this, `npm test` and
// `npm run release` there would run every worktree's suite as well.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'desktop/**', 'tools/**', '.claude/**'],
  },
});
