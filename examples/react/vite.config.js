import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const source = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The packages are not published yet: build against their sources, so no package needs building first.
    alias: [
      { find: '@tarjim/core/internal', replacement: source('../../packages/core/src/internal.ts') },
      { find: '@tarjim/core', replacement: source('../../packages/core/src/index.ts') },
      { find: '@tarjim/browser/internal', replacement: source('../../packages/browser/src/internal.ts') },
      { find: '@tarjim/browser', replacement: source('../../packages/browser/src/index.ts') },
      { find: '@tarjim/react', replacement: source('../../packages/react/src/index.ts') },
    ],
  },
});
