import { afterEach, describe, expect, it } from 'vitest';
import { bundleOrderOf, decodeManifest, decodeStoredManifest } from '../../src/internal.js';
import { createSnapshot } from '../../src/internal.js';
import { DEFAULT, flatSlice, leaf, world as heldWorld } from '../resolver/world.js';
import { makeWorld } from './world.js';
import type { World } from './world.js';

const FILE = { hash: 'a'.repeat(64), size: 1 };
const BUNDLES = {
  b1: { type: 'custom', name: 'one', namespaces: [] },
  b2: { type: 'custom', name: 'two', namespaces: [] },
  b3: { type: 'custom', name: 'three', namespaces: [] },
};
const SLICES = { b1: { en: { json: FILE } }, b2: { en: { json: FILE } }, b3: { en: { json: FILE } } };

describe('the order of the bundles', () => {
  it('comes from bundleOrder when the manifest has it', () => {
    const manifest = decodeManifest({ schemaVersion: 1, bundles: BUNDLES, slices: SLICES, bundleOrder: ['b3', 'b1', 'b2'] })!;

    expect(bundleOrderOf(manifest)).toEqual(['b3', 'b1', 'b2']);
  });

  it('falls back to sorted ids when it does not, namespaces first, then numeric, whatever the order of the object', () => {
    const bundle = { type: 'custom', name: 'x', namespaces: [] };
    const manifest = decodeManifest({
      schemaVersion: 1,
      bundles: { b10: bundle, ns7: bundle, b2: bundle, ns10: bundle },
      slices: { b10: SLICES.b1, ns7: SLICES.b1, b2: SLICES.b1, ns10: SLICES.b1 },
    })!;

    expect(bundleOrderOf(manifest)).toEqual(['ns7', 'ns10', 'b2', 'b10']);
  });

  it.each([
    ['a value that is not a list', 'b1'],
    ['nothing usable', [1, null, {}]],
  ])('falls back for %s', (_label, bundleOrder) => {
    const manifest = decodeManifest({ schemaVersion: 1, bundles: BUNDLES, slices: SLICES, bundleOrder })!;

    expect(bundleOrderOf(manifest)).toEqual(['b1', 'b2', 'b3']);
  });

  it('skips an id with no bundle, and puts a bundle the list omits before the listed ones', () => {
    const manifest = decodeManifest({ schemaVersion: 1, bundles: BUNDLES, slices: SLICES, bundleOrder: ['b3', 'gone', 'b1', 'b3'] })!;

    expect(bundleOrderOf(manifest)).toEqual(['b2', 'b3', 'b1']);
  });

  it('does not name a native bundle, which is skipped', () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      bundles: { n1: { type: 'custom', name: 'native', format: 'ios', namespaces: [] }, b1: BUNDLES.b1 },
      slices: { n1: { en: { strings: FILE } }, b1: SLICES.b1 },
      bundleOrder: ['b1', 'n1'],
    })!;

    expect(bundleOrderOf(manifest)).toEqual(['b1']);
  });

  it('survives being stored and read back', () => {
    const manifest = decodeManifest({ schemaVersion: 1, bundles: BUNDLES, slices: SLICES, bundleOrder: ['b3', 'b1', 'b2'] })!;

    const stored = decodeStoredManifest(JSON.parse(JSON.stringify(manifest)))!;

    expect(bundleOrderOf(stored)).toEqual(['b3', 'b1', 'b2']);
  });

  it('decides which bundle wins a merged lookup, against the order of the object', () => {
    const held = heldWorld(
      { b1: { type: 'custom', name: 'one' }, b2: { type: 'custom', name: 'two' } },
      { b1: { en: flatSlice('b1', 'en', { a: leaf(1, 'one') }) }, b2: { en: flatSlice('b2', 'en', { a: leaf(2, 'two') }) } },
    );
    held.install.manifest.bundleOrder = ['b2', 'b1'];

    const t = createSnapshot({ install: held.install, slices: held.slices, embedded: [], locale: 'en' });

    expect(t.t('a')).toBe('one');
    expect(t.t('a', undefined, { bundle: DEFAULT })).toBe('a');
  });
});

describe('a release that only changes the order', () => {
  let world: World;
  afterEach(() => world.stopAll());

  const ordered = (bundleOrder: string[], releaseId: number) => ({
    content: { b1: 'same', b2: 'same' },
    releaseId,
    manifestOverrides: { bundleOrder },
  });

  it('is a change, and the new winner shows once it is activated', async () => {
    world = makeWorld({ release: ordered(['b1', 'b2'], 1) });
    const tarjim = await world.startActive({ defaultBundle: undefined });
    expect(tarjim.t('a')).toBe('same b2 en');

    world.release(ordered(['b2', 'b1'], 2));
    world.clock.advance(60);

    expect(await tarjim.checkNow()).toBe('downloaded');
    expect(tarjim.t('a')).toBe('same b2 en');
    expect(tarjim.activatePendingUpdate()).toBe(true);
    expect(tarjim.t('a')).toBe('same b1 en');
  });
});
