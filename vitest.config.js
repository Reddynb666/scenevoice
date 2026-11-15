// The root test run covers the extension, the web player, the relay (server/test),
// the site and the film engine (src/film). The desktop app keeps its own tests and
// its own dependencies (Electron, Playwright) under desktop/: they are not installed
// here, so the root run must not collect them. CI and `npm run release` run the root
// suite on a checkout that has never installed desktop/.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'desktop/**', 'tools/film/node_modules/**'],
  },
});
