import { describe, expect, it } from 'vitest';
import { createSnapshot } from '../../src/internal.js';
import type { SnapshotInput } from '../../src/internal.js';
import { DEFAULT, arrayKeys, flatSlice, leaf, pluralKeys, snapshotOf, world } from './world.js';
import type { World } from './world.js';

const FIRST = { type: 'custom', name: 'first' };
const SECOND = { type: 'custom', name: 'second' };

function merged(first: Record<string, unknown>, second: Record<string, unknown>, ids: [string, string] = ['b1', 'b2']) {
  const [one, two] = ids;
  return world(
    { [one]: FIRST, [two]: SECOND },
    { [one]: { en: flatSlice(one, 'en', first) }, [two]: { en: flatSlice(two, 'en', second) } },
  );
}

const read = (held: World | null, extra: Partial<SnapshotInput> = {}) =>
  createSnapshot({ ...(held ? { install: held.install } : {}), slices: held ? held.slices : new Map(), embedded: [], locale: 'en', ...extra });

describe('merged reading, with no default bundle', () => {
  it('finds a key in any loaded bundle', () => {
    const t = read(merged({ a: leaf(1, 'A') }, { b: leaf(2, 'B') }));

    expect(t.t('a')).toBe('A');
    expect(t.t('b')).toBe('B');
  });

  it('gives a key two bundles carry to the later-listed one', () => {
    const t = read(merged({ a: leaf(1, 'first') }, { a: leaf(2, 'second') }));

    expect(t.t('a')).toBe('second');
    expect(t.entry('a')?.id).toBe('2');
  });

  it('goes by the order the manifest gives, not by id', () => {
    const held = merged({ a: leaf(1, 'listed first') }, { a: leaf(2, 'listed last') }, ['b9', 'b2']);
    held.install.manifest.bundleOrder = ['b9', 'b2'];

    expect(read(held).t('a')).toBe('listed last');
  });

  it('goes by sorted id when the manifest gives no order', () => {
    const held = merged({ a: leaf(1, 'b9') }, { a: leaf(2, 'b2') }, ['b9', 'b2']);

    expect(read(held).t('a')).toBe('b9');
  });

  it('takes a plural family whole from the winning bundle, never mixing forms', () => {
    const t = read(
      merged(pluralKeys('cart', 10, { one: 'first one', other: 'first other' }), pluralKeys('cart', 20, { other: 'second other' })));

    expect(t.t('cart', { count: 1 })).toBe('second other');
    expect(t.t('cart', { count: 5 })).toBe('second other');
  });

  it('takes a string array whole from the winning bundle', () => {
    const t = read(merged(arrayKeys('menu', 10, ['a', 'b', 'c']), arrayKeys('menu', 20, ['z'])));

    expect(t.tArray('menu')).toEqual(['z']);
  });

  it('moves on when the later-listed bundle leaves the key untranslated', () => {
    const t = read(merged({ a: leaf(1, 'first') }, { a: leaf(2, '') }));

    expect(t.t('a')).toBe('first');
  });

  it('still lets one lookup read one bundle', () => {
    const t = read(merged({ a: leaf(1, 'first') }, { a: leaf(2, 'second'), b: leaf(3, 'B') }));

    expect(t.t('a', undefined, { bundle: { type: 'custom', name: 'first' } })).toBe('first');
    expect(t.t('b', undefined, { bundle: { type: 'custom', name: 'first' } })).toBe('b');
  });

  it('answers from a downloaded bundle before any embedded slice', () => {
    const held = merged({ a: leaf(1, 'downloaded first') }, { b: leaf(2, 'B') });
    const t = read(held, {
      embedded: [flatSlice('b2', 'en', { a: leaf(9, 'embedded copy of second') }), flatSlice('other', 'en', { a: leaf(8, 'embedded other') })],
    });

    expect(t.t('a')).toBe('downloaded first');
  });

  it('answers from a slice the manifest does not list last of all', () => {
    const held = merged({ a: leaf(1, 'first') }, { b: leaf(2, 'B') });
    const t = read(held, {
      embedded: [flatSlice('other', 'en', { c: leaf(8, 'unlisted c'), d: leaf(7, 'unlisted d') }), flatSlice('b1', 'en', { d: leaf(6, 'copy of first') })],
    });

    expect(t.t('c')).toBe('unlisted c');
    expect(t.t('d')).toBe('copy of first');
  });

  it('serves embedded slices alone with nothing downloaded', () => {
    const t = read(null, { embedded: [flatSlice('any', 'en', { a: leaf(1, 'A') })] });

    expect(t.t('a')).toBe('A');
  });
});

describe('separate reading, with a default bundle', () => {
  it('reads that bundle only, so a later-listed bundle changes nothing', () => {
    const held = world(
      { b1: DEFAULT, b2: SECOND },
      { b1: { en: flatSlice('b1', 'en', { a: leaf(1, 'default') }) }, b2: { en: flatSlice('b2', 'en', { a: leaf(2, 'second'), b: leaf(3, 'B') }) } },
    );
    const t = snapshotOf(held);

    expect(t.t('a')).toBe('default');
    expect(t.t('b')).toBe('b');
    expect(t.t('b', undefined, { bundle: { type: 'custom', name: 'second' } })).toBe('B');
  });
});
