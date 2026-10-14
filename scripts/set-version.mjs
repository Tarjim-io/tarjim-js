// Sets the release version in the three package manifests and in SDK_VERSION, the value the
// client sends on the wire: node scripts/set-version.mjs <version>
// Paths are relative, so run it from the repository root.
import { readFileSync, writeFileSync } from 'node:fs';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta)\.(0|[1-9]\d*))?$/;
const MANIFESTS = ['core', 'browser', 'react'].map((name) => `packages/${name}/package.json`);
const VERSION_TS = 'packages/core/src/version.ts';

const version = process.argv[2] ?? '';
if (!VERSION.test(version)) {
  console.error(`[ERROR] the version must be X.Y.Z, X.Y.Z-alpha.N or X.Y.Z-beta.N, got "${version}"`);
  process.exit(2);
}

// Text edits, not JSON.stringify, so the files keep their formatting byte for byte.
const edits = [
  ...MANIFESTS.map((file) => [file, /^(\s*"version": ")[^"]*(")/m]),
  [VERSION_TS, /(SDK_VERSION = ')[^']*(')/],
];

// Every edit is computed before any file is written, so a failure leaves the tree untouched.
const updated = edits.map(([file, pattern]) => {
  const before = readFileSync(file, 'utf8');
  if (!pattern.test(before)) {
    console.error(`[ERROR] no version found in ${file}`);
    process.exit(1);
  }
  return [file, before.replace(pattern, `$1${version}$2`)];
});

for (const [file, text] of updated) {
  writeFileSync(file, text);
}
console.log(`Set version ${version} in ${updated.length} files.`);
