import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/internal.ts'],
    format: ['esm', 'cjs'],
    target: 'es2020',
    dts: true,
    clean: true,
    sourcemap: false,
  },
  {
    entry: { 'bin/tarjim-pull': 'src/bin/tarjim-pull.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    dts: false,
    clean: false,
    sourcemap: false,
  },
]);
