// Fails when a package's minified, gzipped bundle grows past its budget.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const BUDGETS = [{ name: '@tarjim/core', entry: 'packages/core/src/index.ts', maxBytes: 12 * 1024 }];

let failed = false;
for (const { name, entry, maxBytes } of BUDGETS) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  const size = gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
  const over = size > maxBytes;
  failed ||= over;
  console.log(`${name}: ${size} bytes min+gz (budget ${maxBytes})${over ? ' OVER BUDGET' : ''}`);
}
process.exitCode = failed ? 1 : 0;
