import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    target: 'es2020',
    dts: true,
    clean: false,
    sourcemap: false,
  },
  {
    entry: { 'tarjim-browser.iife': 'src/script-tag.ts' },
    format: ['iife'],
    // Without this tsup names an IIFE `*.global.js`.
    outExtension: () => ({ js: '.js' }),
    globalName: 'Tarjim',
    target: 'es2020',
    platform: 'browser',
    minify: true,
    // The page gets one self-contained file; core is bundled in.
    noExternal: [/.*/],
    clean: false,
    dts: false,
    sourcemap: false,
  },
]);
