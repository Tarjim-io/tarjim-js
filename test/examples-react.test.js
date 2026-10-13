import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const EXAMPLE = fileURLToPath(new URL('../examples/react/', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'tarjim-example-react-'));

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('examples/react', () => {
  it('builds with no network, no environment file and no built package', () => {
    const vite = join(EXAMPLE, 'node_modules/vite/bin/vite.js');
    expect(existsSync(vite), 'run pnpm install first').toBe(true);

    // A build only: it reads the sources of the packages it uses and never starts a server.
    execFileSync(process.execPath, [vite, 'build', EXAMPLE, '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { stdio: 'pipe' });

    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toMatch(/<script type="module"[^>]* src="\/assets\/index-[^"]+\.js"/);
    expect(readdirSync(join(out, 'assets')).some((name) => name.endsWith('.js'))).toBe(true);
  }, 60_000);

  it('never writes HTML into the page and keeps its keys out of the source', () => {
    for (const file of ['src/App.jsx', 'src/main.jsx']) {
      const source = readFileSync(join(EXAMPLE, file), 'utf8');
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
    expect(readFileSync(join(EXAMPLE, 'src/main.jsx'), 'utf8')).toMatch(/import\.meta\.env\.VITE_TARJIM_APIKEY/);
  });
});
