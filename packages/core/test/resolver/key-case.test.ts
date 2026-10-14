import { describe, expect, it } from 'vitest';
import { DEFAULT, arrayKeys, flatSlice, leaf, pluralKeys, snapshotOf, snapshotWith, world } from './world.js';

const lower = { keyCase: 'lower' } as const;

describe("keyCase: 'lower'", () => {
  it('finds a key whatever the case of the stored name and of the requested one', () => {
    const snapshot = snapshotWith({ 'Select people and teams': leaf(1, 'Pick'), add_project: leaf(2, 'Add') }, lower);
    for (const key of ['Select people and teams', 'select people and teams', 'SELECT PEOPLE AND TEAMS']) {
      expect(snapshot.t(key)).toBe('Pick');
    }
    expect(snapshot.t('Add_Project')).toBe('Add');
  });

  it('answers a missing key with the key as it was asked for, not lowercased', () => {
    expect(snapshotWith({ a: leaf(1, 'A') }, lower).t('Missing.Key')).toBe('Missing.Key');
  });

  it('applies to entry() and tArray()', () => {
    const snapshot = snapshotWith({ 'App.Logo': leaf(1, 'Logo'), ...arrayKeys('Menu', 10, ['One', 'Two']) }, lower);
    expect(snapshot.entry('app.logo')?.value).toBe('Logo');
    expect(snapshot.tArray('MENU')).toEqual(['One', 'Two']);
  });

  it('picks plural forms for a key asked for in another case', () => {
    const snapshot = snapshotWith(pluralKeys('Cart.Items', 1, { one: 'One item', other: '%d items' }), lower);
    expect(snapshot.t('cart.items', { count: 1 })).toBe('One item');
    expect(snapshot.t('CART.ITEMS', { count: 3 })).toBe('3 items');
  });

  it('lowercases embedded slices too', () => {
    const snapshot = snapshotOf(null, { ...lower, embedded: [flatSlice('embedded', 'en', { 'Hello.World': leaf(1, 'Hi') })] });
    expect(snapshot.t('hello.world')).toBe('Hi');
  });

  it('applies inside a namespaced slice, where namespace names still match exactly', () => {
    const raw = { schemaVersion: 1, bundle: 'ns1', locale: 'en', namespaces: { 'latest-translations': { Name: leaf(1, 'Name') } } };
    const snapshot = snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: raw } }), lower);
    expect(snapshot.t('name', undefined, { namespace: 'latest-translations' })).toBe('Name');
    expect(snapshot.t('name', undefined, { namespace: 'Latest-Translations' })).toBe('name');
  });

  it('keeps the first of two keys whose names differ only in case', () => {
    const snapshot = snapshotWith({ Cancel: leaf(1, 'first'), cancel: leaf(2, 'second') }, lower);
    expect(snapshot.t('cancel')).toBe('first');
    expect(snapshot.t('CANCEL')).toBe('first');
  });

  // Lowercasing "<key>" and then adding ".one" is not always lowercasing "<key>.one": a final capital
  // sigma becomes ς at the end of a word and σ inside one.
  it('picks plural forms for a key whose lowercase depends on what follows it', () => {
    const snapshot = snapshotWith(pluralKeys('ΟΔΟΣ', 1, { one: 'one road', other: '%d roads' }), lower);
    expect(snapshot.t('ΟΔΟΣ', { count: 1 })).toBe('one road');
    expect(snapshot.t('οδος', { count: 2 })).toBe('2 roads');
  });

  it('lowercases letters outside ASCII', () => {
    expect(snapshotWith({ 'ÉCOLE': leaf(1, 'school') }, lower).t('école')).toBe('school');
  });
});

describe("keyCase: 'exact'", () => {
  it('is the same as leaving keyCase out: names match case-sensitively', () => {
    for (const options of [{}, { keyCase: 'exact' } as const]) {
      const snapshot = snapshotWith({ 'Mixed.Key': leaf(1, 'mixed') }, options);
      expect(snapshot.t('Mixed.Key')).toBe('mixed');
      expect(snapshot.t('mixed.key')).toBe('mixed.key');
    }
  });
});
