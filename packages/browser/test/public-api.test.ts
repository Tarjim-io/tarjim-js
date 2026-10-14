import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import * as internal from '../src/internal.js';

const PUBLIC_VALUES = ['Tarjim', 'TarjimConfigError', 'TarjimLanguageError'];
const INTERNAL_VALUES = ['DATABASE_NAME', 'IndexedDbStore', 'browserPlatform', 'openStore'];
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// A separate process, so the answer is what a user's `import` would get, not what vitest aliases.
function builtExports(file: string): string[] {
  expect(existsSync(`${DIST}${file}`), `${file} is missing; build first`).toBe(true);
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import(${JSON.stringify(`${DIST}${file}`)}).then((m) => console.log(JSON.stringify(Object.keys(m).sort())))`],
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as string[];
}

describe('the public entry', () => {
  it('exposes only Tarjim and the two error classes at runtime', () => {
    expect(Object.keys(api).sort()).toEqual(PUBLIC_VALUES);
  });

  it('re-exports the errors so instanceof works for users of this package', async () => {
    const core = await import('@tarjim/core');
    expect(api.TarjimConfigError).toBe(core.TarjimConfigError);
    expect(api.TarjimLanguageError).toBe(core.TarjimLanguageError);
  });

  it('keeps the storage and platform internals off the public entry', () => {
    for (const name of INTERNAL_VALUES) expect(api).not.toHaveProperty(name);
  });
});

describe('the internal entry', () => {
  it('holds the storage and platform internals', () => {
    expect(Object.keys(internal).sort()).toEqual(INTERNAL_VALUES);
  });
});

describe('the built package', () => {
  it('exports the same public names as the source', () => {
    expect(builtExports('index.js')).toEqual(PUBLIC_VALUES);
  });

  it('exports the internals from its internal entry only', () => {
    expect(builtExports('internal.js')).toEqual(INTERNAL_VALUES);
  });
});
