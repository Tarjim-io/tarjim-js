import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TarjimConfigError, TarjimLanguageError } from '../../src/index.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const SCRIPT_TAG = fileURLToPath(new URL('../../../browser/dist/tarjim-browser.iife.js', import.meta.url));

describe('error names', () => {
  it('names each error after its class, so logs and error trackers show it', () => {
    expect(new TarjimConfigError('x').name).toBe('TarjimConfigError');
    expect(new TarjimLanguageError('x').name).toBe('TarjimLanguageError');
    expect(String(new TarjimLanguageError('no text'))).toBe('TarjimLanguageError: no text');
  });

  it('keeps the names in the built ESM and CommonJS files', () => {
    for (const file of ['index.js', 'index.cjs']) {
      expect(existsSync(`${DIST}${file}`), `${file} is missing; build first`).toBe(true);
      const load = file.endsWith('.cjs') ? `Promise.resolve(require(${JSON.stringify(`${DIST}${file}`)}))` : `import(${JSON.stringify(`${DIST}${file}`)})`;
      const run = spawnSync(
        process.execPath,
        [...(file.endsWith('.cjs') ? [] : ['--input-type=module']), '-e', `${load}.then((m) => console.log(new m.TarjimConfigError('x').name, new m.TarjimLanguageError('x').name))`],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim(), file).toBe('TarjimConfigError TarjimLanguageError');
    }
  });

  // The script-tag file is minified, which renames classes: the names must survive as literals.
  it('keeps the names in the minified script-tag file', () => {
    expect(existsSync(SCRIPT_TAG), 'the script-tag file is missing; build first').toBe(true);
    const source = readFileSync(SCRIPT_TAG, 'utf8');
    expect(source).toContain('"TarjimConfigError"');
    expect(source).toContain('"TarjimLanguageError"');
  });
});
