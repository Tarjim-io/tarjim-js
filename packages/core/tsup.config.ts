import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts'],
  format: ['esm', 'cjs'],
  target: 'es2020',
  dts: true,
  clean: true,
  sourcemap: false,
});
