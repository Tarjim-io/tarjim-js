import { describe, expect, it } from 'vitest';
import { sanitiseInstall, sanitiseState } from '../../src/internal.js';
import { makeInstall } from '../helpers/store-contract.js';

describe('sanitiseInstall', () => {
  it.each([NaN, Infinity, -Infinity])('reads an install whose installedAt is %s as absent', (installedAt) => {
    expect(sanitiseInstall(makeInstall({}, { installedAt }))).toBeUndefined();
  });

  it('keeps an install with an ordinary installedAt', () => {
    expect(sanitiseInstall(makeInstall({}))).toEqual(makeInstall({}));
  });
});

const sharedLattice = (levels: number): unknown => {
  let node: unknown[] = [];
  for (let i = 0; i < levels; i++) node = [node, node];
  return node;
};

describe('sanitiseInstall manifest', () => {
  it.each([
    ['an empty object', {}],
    ['a manifest without bundles or slices', { schemaVersion: 1 }],
    ['a string', 'manifest'],
  ])('reads an install whose manifest is %s as absent', (_label, manifest) => {
    expect(sanitiseInstall({ ...makeInstall({}), manifest })).toBeUndefined();
  });

  it('round-trips a valid manifest', () => {
    const manifest = {
      schemaVersion: 1,
      bundles: { ui: { type: 'web', name: 'UI', namespaces: ['a'] } },
      slices: { ui: { en: { hash: 'd'.repeat(64), size: 3 } } },
    };
    const install = makeInstall({}, { manifest });
    expect(sanitiseInstall(install)).toEqual(install);
  });

  it('reads a manifest carrying a lattice of shared arrays under an unknown key in well under a second', () => {
    const manifest = { schemaVersion: 1, bundles: {}, slices: {}, extra: sharedLattice(24) };
    const start = Date.now();
    const clean = sanitiseInstall({ ...makeInstall({}), manifest });
    expect(Date.now() - start).toBeLessThan(200);
    expect(clean?.manifest).toEqual({ schemaVersion: 1, bundles: {}, slices: {} });
  });

  it('freezes the manifest it returns', () => {
    const clean = sanitiseInstall(makeInstall({}));
    expect(Object.isFrozen(clean?.manifest)).toBe(true);
    expect(Object.isFrozen(clean?.manifest.bundles)).toBe(true);
  });
});

describe('sanitiseState', () => {
  it.each([NaN, Infinity])('drops a reported map that holds %s', (bad) => {
    expect(sanitiseState({ reported: { a: 1, b: bad } }).reported).toBeUndefined();
  });

  it('keeps a reported map of finite numbers', () => {
    expect(sanitiseState({ reported: { a: 1, b: 2 } }).reported).toEqual({ a: 1, b: 2 });
  });
});
