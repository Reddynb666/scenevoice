// The desktop shell's own tests: pure logic only (keys, the SpeechBus queue,
// the IPC contract, locale parity, the schemes' path and range arithmetic).
// The root vitest config excludes desktop/**; run these with `npx vitest run`
// in this folder. What needs a real window is covered by `npm run selftest`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
});
