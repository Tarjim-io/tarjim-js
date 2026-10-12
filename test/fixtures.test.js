import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function walk(dir) {
  // Dotfiles (.DS_Store) are never committed; they must not fail a local run.
  return readdirSync(dir).filter((name) => !name.startsWith('.')).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Hosts a fixture may name. Anything else is a real host leaking into a public repository.
const ALLOWED_HOST = /^(.+\.invalid|example\.com|.+\.example\.com|api\.tarjim\.io)$/;

const LEAKS = [
  ['an API key', /tarjim-\d+-\d+-(?!0-invalid\b)/],
  ['a CloudFront signature', /Signature=(?!REDACTED)/],
  ['a CloudFront policy', /Policy=(?!REDACTED)/],
  ['a CloudFront key pair id', /Key-Pair-Id=(?!REDACTED)/],
  ['an amazonaws or cloudfront host', /amazonaws\.com|cloudfront\.net/],
  ['an internal ticket id', /\bTJ-\d+/],
];

// Any scheme-relative authority, also JSON-escaped (`https:\/\/host`) or protocol-relative (`//host`).
const HOST = /(?:^|[^A-Za-z0-9:\\/])(?:[a-z][a-z0-9+.-]*:)?(?:\\?\/){2}([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gi;

describe('fixtures', () => {
  const files = walk(FIXTURES);

  it('carry no key, signature or real host', () => {
    const found = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [what, pattern] of LEAKS) {
        if (pattern.test(text)) found.push(`${relative(FIXTURES, file)}: ${what}`);
      }
      for (const [, host] of text.matchAll(HOST)) {
        if (!ALLOWED_HOST.test(host)) found.push(`${relative(FIXTURES, file)}: host ${host}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('are envelopes with a provenance, a status and a string or null body', () => {
    const envelopes = files.filter(
      (f) => f.endsWith('.json') && (f.includes('/errors/') || /\/meta\.[a-z]+\.json$/.test(f)),
    );
    expect(envelopes.length).toBeGreaterThan(0);
    for (const file of envelopes) {
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      expect(['hand-built', 'recorded'], file).toContain(envelope.provenance);
      expect(Number.isInteger(envelope.status), file).toBe(true);
      expect(typeof envelope.headers, file).toBe('object');
      expect(envelope.body === null || typeof envelope.body === 'string', file).toBe(true);
    }
  });

  const recordedRoot = join(FIXTURES, 'recorded');
  const recordings = existsSync(recordedRoot)
    ? readdirSync(recordedRoot).filter((n) => statSync(join(recordedRoot, n)).isDirectory())
    : [];

  // The scrub touches meta only; this proves the manifest and every object are still the bytes
  // the server hashed.
  it.each(recordings)('recording %s keeps its hash chain', (name) => {
    const dir = join(recordedRoot, name);
    const metaFile = readdirSync(dir).find((n) => /^meta\.(cdn|origin)\.json$/.test(n));
    expect(metaFile).toBeDefined();
    const meta = JSON.parse(JSON.parse(readFileSync(join(dir, metaFile), 'utf8')).body);
    const manifestBytes = readFileSync(join(dir, 'manifest.json'));
    expect(sha256(manifestBytes)).toBe(meta.checksum);

    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const listed = new Set();
    for (const locales of Object.values(manifest.slices)) {
      for (const types of Object.values(locales)) {
        for (const [type, entry] of Object.entries(types)) listed.add(`${entry.hash}.${type}`);
      }
    }
    expect(listed.size).toBeGreaterThan(0);
    for (const object of listed) {
      expect(sha256(readFileSync(join(dir, 'objects', object))), object).toBe(object.split('.')[0]);
    }
    const stored = readdirSync(join(dir, 'objects')).filter((n) => !n.startsWith('.'));
    expect(new Set(stored)).toEqual(listed);
  });
});
