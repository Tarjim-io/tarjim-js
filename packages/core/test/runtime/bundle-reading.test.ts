import { afterEach, describe, expect, it } from 'vitest';
import { TarjimConfigError } from '../../src/index.js';
import { respond, simpleRelease } from '../support.js';
import { makeWorld } from './world.js';
import type { World } from './world.js';

const TWO = { content: { b1: 'v1', b2: 'v2' } };
const THREE = { content: { b1: 'v1', b2: 'v2', b3: 'v3' } };
const SEPARATE = { defaultBundle: { type: 'namespace', name: 'b1' } };
const MERGED = { defaultBundle: undefined };

let world: World;
afterEach(() => world.stopAll());

async function next(): Promise<void> {
  world.clock.advance(60);
  world.returnToForeground();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('choosing how bundles are read', () => {
  it('reads every loaded bundle when nothing is configured', async () => {
    world = makeWorld({ release: TWO });

    const tarjim = await world.startActive(MERGED);

    expect(tarjim.t('a')).toBe('v2 b2 en');
  });

  it('reads one bundle when a default bundle is given, so an existing app is unchanged', async () => {
    world = makeWorld({ release: TWO });

    const tarjim = await world.startActive(SEPARATE);

    expect(tarjim.t('a')).toBe('v1 b1 en');
  });

  it('reads one bundle when asked to by name', async () => {
    world = makeWorld({ release: TWO });

    const tarjim = await world.startActive({ ...SEPARATE, bundleMode: 'separate' });

    expect(tarjim.t('a')).toBe('v1 b1 en');
  });

  it('reads them merged when asked, ignoring a default bundle and saying so', async () => {
    world = makeWorld({ release: TWO });

    const tarjim = await world.startActive({ ...SEPARATE, bundleMode: 'merged' });

    expect(tarjim.t('a')).toBe('v2 b2 en');
    expect(world.codes()).toContain('default-bundle-ignored');
  });

  it.each([
    ['separate reading with no default bundle', { bundleMode: 'separate', defaultBundle: undefined }],
    ['a mode it does not know', { bundleMode: 'mixed', defaultBundle: undefined }],
    ['a merged reading with a default bundle, when strict', { bundleMode: 'merged', ...SEPARATE }],
    ['a bundle list that is not a list', { bundles: 'b1', defaultBundle: undefined }],
    ['a bundle list holding something else', { bundles: ['b1', 2], defaultBundle: undefined }],
  ])('refuses %s when strict', async (_label, config) => {
    world = makeWorld({ release: TWO });

    await expect(world.start({ ...config, strict: true })).rejects.toBeInstanceOf(TarjimConfigError);
  });
});

describe.each([
  ['merged', MERGED],
  ['separate', SEPARATE],
])('naming the bundles to load, %s', (_mode, reading) => {
  it('loads every bundle when none is named', async () => {
    world = makeWorld({ release: THREE });

    await world.startActive(reading);

    expect(Object.keys((await world.state()).active!.slots).sort()).toEqual(['b1\nen', 'b2\nen', 'b3\nen']);
  });

  it('loads only the named bundles', async () => {
    world = makeWorld({ release: THREE });

    await world.startActive({ ...reading, bundles: ['b1', 'b3'] });

    expect(Object.keys((await world.state()).active!.slots).sort()).toEqual(['b1\nen', 'b3\nen']);
    expect(world.fetched.filter((url) => url.includes('/slices/'))).toHaveLength(2);
  });

  it('warns about a name the manifest lacks, once, and loads the rest', async () => {
    world = makeWorld({ release: TWO });

    await world.startActive({ ...reading, bundles: ['b1', 'nope'] });
    await next();

    expect(world.reportsOf('bundle-unknown')).toHaveLength(1);
    expect(world.reportsOf('bundle-unknown')[0]!.details).toEqual({ name: 'nope' });
    expect(Object.keys((await world.state()).active!.slots)).toEqual(['b1\nen']);
  });
});

describe('a bundle that was not named', () => {
  it('is not read even when its text is already held, as after narrowing the list', async () => {
    world = makeWorld({ release: TWO });
    (await world.startActive(MERGED)).stop();

    const narrowed = await world.start({ ...MERGED, bundles: ['b1'] });

    expect(narrowed.t('a')).toBe('v1 b1 en');
  });

  it('does not offer its languages', async () => {
    world = makeWorld({ languages: ['fr'] });
    world.server.use(
      simpleRelease({
        bundles: { b1: { type: 'namespace', name: 'b1' }, b2: { type: 'namespace', name: 'b2' } },
        slices: {
          b1: { en: { schemaVersion: 1, keys: { a: { id: '1', value: 'one', tags: [] } } } },
          b2: { fr: { schemaVersion: 1, keys: { a: { id: '1', value: 'deux', tags: [] } } } },
        },
      }),
    );

    const tarjim = await world.startActive({ ...MERGED, bundles: ['b1'], embedded: [] });
    world.returnToForeground();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tarjim.t('a')).toBe('one');
    expect(tarjim.language).toBe('en');
  });
});

describe('loading another bundle later', () => {
  it('fetches it from the held manifest, without reading meta', async () => {
    world = makeWorld({ release: TWO });
    const tarjim = await world.startActive({ ...MERGED, bundles: ['b1'] });
    expect(tarjim.t('a')).toBe('v1 b1 en');
    const metas = world.metaCount();

    expect(await tarjim.loadBundle('b2')).toBe(true);

    expect(world.metaCount()).toBe(metas);
    expect(tarjim.t('a')).toBe('v2 b2 en');
  });

  it('does not touch a newer release the server now names', async () => {
    world = makeWorld({ release: TWO });
    const tarjim = await world.startActive({ ...MERGED, bundles: ['b1'] });
    const held = (await world.state()).active!.checksum;
    world.release({ content: { b1: 'new', b2: 'new' }, releaseId: 2 });

    await tarjim.loadBundle('b2');

    expect((await world.state()).active!.checksum).toBe(held);
    expect(tarjim.t('a')).toBe('v2 b2 en');
  });

  it('answers false and warns for a name the held manifest lacks', async () => {
    world = makeWorld({ release: TWO });
    const tarjim = await world.startActive({ ...MERGED, bundles: ['b1'] });

    expect(await tarjim.loadBundle('nope')).toBe(false);

    expect(world.reportsOf('bundle-unknown')).toHaveLength(1);
    expect(Object.keys((await world.state()).active!.slots)).toEqual(['b1\nen']);
  });

  it('answers true with nothing to do when every bundle is already loaded', async () => {
    world = makeWorld({ release: TWO });
    const tarjim = await world.startActive(MERGED);
    const before = world.fetched.length;

    expect(await tarjim.loadBundle('b2')).toBe(true);
    expect(world.fetched).toHaveLength(before);
  });

  it('keeps the text it has when the file cannot be fetched', async () => {
    world = makeWorld({ release: TWO });
    const tarjim = await world.startActive({ ...MERGED, bundles: ['b1'] });
    world.server.on('object', () => respond(500, 'no'));
    world.server.on('meta', () => respond(500, 'no'));

    expect(await tarjim.loadBundle('b2')).toBe(false);

    expect(tarjim.t('a')).toBe('v1 b1 en');
  });

  it('never mixes releases: a newer one brings every loaded bundle, whole', async () => {
    world = makeWorld({ release: THREE });
    const tarjim = await world.startActive({ ...MERGED, bundles: ['b1'] });
    await tarjim.loadBundle('b2');
    world.release({ content: { b1: 'new', b2: 'new', b3: 'new' }, releaseId: 2 });

    world.clock.advance(60);
    expect(await tarjim.checkNow()).toBe('downloaded');

    const { pending } = await world.state();
    expect(Object.keys(pending!.slots).sort()).toEqual(['b1\nen', 'b2\nen']);
    expect(tarjim.t('a')).toBe('v2 b2 en');

    tarjim.activatePendingUpdate();
    expect(tarjim.t('a')).toBe('new b2 en');
    expect(tarjim.t('a', undefined, { bundle: { type: 'namespace', name: 'b1' } })).toBe('new b1 en');
  });
});
