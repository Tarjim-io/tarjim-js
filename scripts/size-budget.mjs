// Fails when a package's minified, gzipped bundle grows past its budget.
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGETS = [{ name: '@tarjim/core', entry: 'packages/core/src/index.ts', maxBytes: 12 * 1024 }];
// Measured on the shipped file, so it needs `pnpm build` first. 14923 bytes measured, rounded up to
// 15 KB, plus 1 KB of headroom.
const SCRIPT_TAG = { name: '@tarjim/browser (script tag)', file: 'packages/browser/dist/tarjim-browser.iife.js', maxBytes: 16 * 1024 };

const gzipped = (bytes) => gzipSync(bytes, { level: 9 }).length;

let failed = false;
function report(name, size, maxBytes) {
  const over = size > maxBytes;
  failed ||= over;
  console.log(`${name}: ${size} bytes min+gz (budget ${maxBytes})${over ? ' OVER BUDGET' : ''}`);
}

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
  report(name, gzipped(result.outputFiles[0].contents), maxBytes);
}

if (existsSync(SCRIPT_TAG.file)) {
  report(SCRIPT_TAG.name, gzipped(readFileSync(SCRIPT_TAG.file)), SCRIPT_TAG.maxBytes);
} else {
  console.log(`${SCRIPT_TAG.name}: ${SCRIPT_TAG.file} is missing; run \`pnpm build\` first`);
  failed = true;
}
process.exitCode = failed ? 1 : 0;
