import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the sources, so a package's tests never need another package built first.
    alias: [
      { find: '@tarjim/core/internal', replacement: fileURLToPath(new URL('packages/core/src/internal.ts', import.meta.url)) },
      { find: '@tarjim/core', replacement: fileURLToPath(new URL('packages/core/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['test/**/*.test.js', 'packages/*/test/**/*.test.ts'],
  },
});
