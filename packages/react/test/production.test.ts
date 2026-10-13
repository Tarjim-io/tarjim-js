// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

async function bundle(production: boolean): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    write: false,
    external: ['react', 'react/jsx-runtime', '@tarjim/*'],
    jsx: 'automatic',
    logLevel: 'silent',
    ...(production ? { minify: true, define: { 'process.env.NODE_ENV': '"production"' } } : {}),
  });
  return result.outputFiles[0]!.text;
}

describe('a production bundle', () => {
  it('has none of the development warnings, and a development bundle has them', async () => {
    const development = await bundle(false);
    expect(development).toContain('waitForContent is ignored while hydrating');
    expect(development).toContain('The config object changed');
    expect(development).toContain('hydrating needs `embedded`');

    const production = await bundle(true);
    expect(production).not.toContain('[tarjim]');
    expect(production).not.toContain('is ignored while hydrating');
    expect(production).not.toContain('config object');
    expect(production).not.toContain('could not switch');
    expect(production).not.toContain('hydrating needs');
    expect(production).not.toContain('console.');
  });
});
