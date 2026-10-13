import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normaliseAppVersion } from '../src/internal.js';
import { clientFor, jsonFiles, simpleRelease } from './support.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const FORBIDDEN = ['document', 'window', 'navigator', 'localStorage', 'indexedDB'];

afterEach(() => vi.unstubAllGlobals());

describe('the core stays free of the page', () => {
  it('does not mention a DOM global anywhere in its sources', () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(SRC + file, 'utf8');
      for (const name of FORBIDDEN) expect(text, `${file} mentions ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(normaliseAppVersion('1.0')).toBe('1.0.0');
  });

  it('runs a whole delivery without touching a DOM global or the global fetch', async () => {
    const touched: string[] = [];
    for (const name of FORBIDDEN) {
      vi.stubGlobal(
        name,
        new Proxy(function () {}, {
          get() {
            touched.push(name);
            throw new Error(`${name} used`);
          },
        }),
      );
    }
    const globalFetch = vi.fn(async () => {
      throw new Error('global fetch used');
    });
    vi.stubGlobal('fetch', globalFetch);

    const release = simpleRelease();
    const client = clientFor(release.fetch);
    const meta = await client.fetchMeta({ language: 'en' });
    const manifest = await client.fetchManifest(release.meta);
    const { results } = await client.fetchSlices(release.meta, jsonFiles(release), {});

    expect(meta.kind).toBe('received');
    expect(manifest.kind).toBe('verified');
    expect([...results.values()].every((r) => r.kind === 'verified')).toBe(true);
    expect(release.requests.length).toBe(4);
    expect(touched).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
