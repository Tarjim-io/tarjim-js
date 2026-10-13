import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadReference } from '../helpers/load-reference.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/release-reference.sh', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = join(ROOT, 'reference/tarjim-reference.js');
const VERSION = loadReference().version;

function release(tag) {
  const out = join(mkdtempSync(join(tmpdir(), 'release-')), 'dist');
  try {
    execFileSync('bash', [SCRIPT, '--tag', tag, '--out', out], { cwd: ROOT, stdio: 'pipe' });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, status: error.status, output: String(error.stderr) };
  }
}

describe('release script', () => {
  it('attaches the committed file byte for byte, with its sha256', () => {
    const result = release(`reference-v${VERSION}`);
    expect(result.ok).toBe(true);
    const source = readFileSync(SOURCE);
    expect(readFileSync(join(result.out, 'tarjim-reference.js')).equals(source)).toBe(true);
    const digest = createHash('sha256').update(source).digest('hex');
    expect(readFileSync(join(result.out, 'tarjim-reference.js.sha256'), 'utf8')).toBe(
      `${digest}  tarjim-reference.js\n`,
    );
  });

  it('writes release notes that carry the sha256 and the pre-release warning', () => {
    const result = release(`reference-v${VERSION}`);
    const notes = readFileSync(join(result.out, 'notes.md'), 'utf8');
    const digest = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
    expect(notes).toContain(digest);
    expect(notes).toMatch(/not yet for customers/i);
  });

  it.each([
    ['a tag whose version differs from the file', 'reference-v9.9.9'],
    ['a tag without the reference prefix', `v${VERSION}`],
    ['a tag that is not a version', 'reference-vnext'],
  ])('refuses %s', (_what, tag) => {
    const result = release(tag);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/\[ERROR\] .*tag/);
  });
});
