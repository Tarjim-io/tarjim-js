import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeManifest } from '../src/index.js';
import { FIXTURES, simpleRelease } from './support.js';

const HASH = 'a'.repeat(64);

function manifestWith(slices: unknown, bundles: unknown = { b1: { type: 'namespace', name: 'default' } }) {
  return { schemaVersion: 1, bundles, slices };
}

describe('decodeManifest', () => {
  it('reads the recorded manifest', () => {
    const raw = JSON.parse(readFileSync(`${FIXTURES}recorded/release-1/manifest.json`, 'utf8')) as unknown;
    const manifest = decodeManifest(raw);

    expect(manifest).toEqual({
      schemaVersion: 1,
      bundles: { ns180: { type: 'namespace', name: 'default', namespaces: [] } },
      slices: {
        ns180: {
          ar: { hash: 'b3ffc5df57e7ac4ebed7ba158ab8389bd768a03634c29df171a5613904792eae', size: 1518 },
          en: { hash: '24fc13c433562806e0a880340583f0b20b3fef792c58a3ebc322c8129c2413c8', size: 1481 },
          fr: { hash: 'fa894e013eae8a148ddcd84cd62feab08e0d7e7f0d4d80d10637e3a738107460', size: 244 },
        },
      },
    });
  });

  it('keeps a bundle layout and its namespaces', () => {
    const manifest = decodeManifest(
      manifestWith({}, { c1: { type: 'custom', name: 'checkout', layout: 'nested', namespaces: ['a', 'b'], other: 1 } }),
    );

    expect(manifest?.bundles['c1']).toEqual({ type: 'custom', name: 'checkout', layout: 'nested', namespaces: ['a', 'b'] });
  });

  it('turns namespaces that are not an array into an empty list', () => {
    const manifest = decodeManifest(manifestWith({}, { c1: { type: 'custom', name: 'x', namespaces: 'a' } }));

    expect(manifest?.bundles['c1']?.namespaces).toEqual([]);
  });

  it('drops a bundle whose type or name is not a string and keeps the others', () => {
    const manifest = decodeManifest(
      manifestWith(
        {},
        { bad1: { type: 1, name: 'x' }, bad2: { type: 'namespace' }, bad3: 'nope', good: { type: 'namespace', name: 'ok' } },
      ),
    );

    expect(Object.keys(manifest?.bundles ?? {})).toEqual(['good']);
  });

  it('keeps only json files, whatever other types are listed', () => {
    const release = simpleRelease({ extraTypes: ['strings', 'stringsdict', 'xml'] });
    const listed = Object.keys(release.manifest.slices['b1']!['en']!);
    const manifest = decodeManifest(release.manifest);

    expect(listed).toContain('xml');
    expect(manifest?.slices['b1']?.['en']).toEqual({
      hash: release.manifest.slices['b1']!['en']!.json.hash,
      size: release.manifest.slices['b1']!['en']!.json.size,
    });
    expect(JSON.stringify(manifest)).not.toContain('xml');
  });

  it('ignores fields it does not know', () => {
    const manifest = decodeManifest({ ...manifestWith({}), baseLocale: 'en', surprise: { a: 1 } });

    expect(manifest).toEqual({ schemaVersion: 1, bundles: { b1: { type: 'namespace', name: 'default', namespaces: [] } }, slices: {} });
  });

  it.each([
    ['an upper-case hash', 'A'.repeat(64)],
    ['a short hash', 'a'.repeat(63)],
    ['a long hash', 'a'.repeat(65)],
    ['a non-hex hash', 'g'.repeat(64)],
    ['a numeric hash', 12345],
    ['a missing hash', undefined],
  ])('drops a file with %s and keeps its siblings', (_label, hash) => {
    const manifest = decodeManifest(
      manifestWith({ b1: { en: { json: { hash, size: 5 } }, fr: { json: { hash: HASH, size: 5 } } } }),
    );

    expect(manifest?.slices['b1']?.['fr']).toEqual({ hash: HASH, size: 5 });
    expect(manifest?.slices['b1']?.['en']).toBeUndefined();
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '5'],
    ['infinite', Infinity],
    ['beyond the safe range', 2 ** 60],
    ['missing', undefined],
    ['null', null],
  ])('drops a file whose size is %s', (_label, size) => {
    const manifest = decodeManifest(
      manifestWith({ b1: { en: { json: { hash: HASH, size } }, fr: { json: { hash: HASH, size: 0 } } } }),
    );

    expect(manifest?.slices['b1']?.['fr']).toEqual({ hash: HASH, size: 0 });
    expect(manifest?.slices['b1']?.['en']).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'manifest'],
    ['a number', 5],
    ['an array', []],
    ['an empty object', {}],
    ['a string schema version', { schemaVersion: '1', bundles: {}, slices: {} }],
    ['missing bundles', { schemaVersion: 1, slices: {} }],
    ['missing slices', { schemaVersion: 1, bundles: {} }],
    ['array bundles', { schemaVersion: 1, bundles: [], slices: {} }],
    ['null slices', { schemaVersion: 1, bundles: {}, slices: null }],
  ])('answers null for %s', (_label, value) => {
    expect(decodeManifest(value)).toBeNull();
  });

  it('never throws on junk', () => {
    const junk: unknown[] = [
      manifestWith({ b1: null }),
      manifestWith({ b1: { en: null } }),
      manifestWith({ b1: { en: { json: null } } }),
      manifestWith({ b1: { en: 'x' } }),
      manifestWith([1, 2]),
      manifestWith({ b1: { en: { json: { hash: {}, size: [] } } } }),
      Object.create(null),
      new Proxy({}, { get: () => { throw new Error('trap'); } }),
    ];

    for (const value of junk) expect(() => decodeManifest(value)).not.toThrow();
    expect(decodeManifest(manifestWith({}))).not.toBeNull();
  });
});
