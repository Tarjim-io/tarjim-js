import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256Hex, verify } from '../src/internal.js';
import { FIXTURES } from './support.js';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('sha256Hex', () => {
  it('hashes the recorded fixture bytes to the hash their file name carries', async () => {
    const name = '24fc13c433562806e0a880340583f0b20b3fef792c58a3ebc322c8129c2413c8';
    const bytes = readFileSync(`${FIXTURES}recorded/release-1/objects/${name}.json`);
    expect(await sha256Hex(new Uint8Array(bytes))).toBe(name);
  });

  it('hashes empty bytes to the well-known empty digest', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(EMPTY_HASH);
  });
});

describe('verify', () => {
  const bytes = new TextEncoder().encode('{"hello":"world"}');
  const hash = '93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588';

  it('accepts bytes whose size and hash both match', async () => {
    expect(await verify(bytes, { hash, size: bytes.length })).toBe('ok');
  });

  it('accepts empty bytes with size 0 and the empty-string hash', async () => {
    expect(await verify(new Uint8Array(0), { hash: EMPTY_HASH, size: 0 })).toBe('ok');
  });

  it.each([1, -1])('rejects a listed size that is off by %i', async (delta) => {
    expect(await verify(bytes, { hash, size: bytes.length + delta })).toBe('size');
  });

  it('checks the size before the hash', async () => {
    expect(await verify(bytes, { hash: '0'.repeat(64), size: bytes.length + 1 })).toBe('size');
  });

  it('reports a hash mismatch when the size is right', async () => {
    expect(await verify(bytes, { hash: '0'.repeat(64), size: bytes.length })).toBe('hash');
  });
});
