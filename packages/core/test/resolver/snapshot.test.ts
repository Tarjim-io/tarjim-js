import { describe, expect, it } from 'vitest';
import { createSnapshot } from '../../src/index.js';
import type { Snapshot, SnapshotReport } from '../../src/index.js';
import { DEFAULT, arrayKeys, flatSlice, leaf, oneBundle, pluralKeys, reporter, snapshotOf, snapshotWith, world } from './world.js';

const CUSTOM_UI = { type: 'custom', name: 'ui' } as const;

describe('plain lookups', () => {
  it('returns the value for a present key and the key name for a missing one', () => {
    const snapshot = snapshotWith({ 'app.title': leaf(1, 'Tarjim') });
    expect(snapshot.t('app.title')).toBe('Tarjim');
    expect(snapshot.t('app.missing')).toBe('app.missing');
  });

  it('reports the locale it serves', () => {
    expect(snapshotWith({ a: leaf(1, 'A') }, { locales: ['en', 'ar'], locale: 'ar' }).language).toBe('ar');
  });

  it('matches key names case-sensitively', () => {
    const snapshot = snapshotWith({ 'Case.Sensitive': leaf(1, 'Upper') });
    expect(snapshot.t('Case.Sensitive')).toBe('Upper');
    expect(snapshot.t('case.sensitive')).toBe('case.sensitive');
  });

  it('counts an empty value as missing', () => {
    const snapshot = snapshotWith({ filled: leaf(1, 'x'), empty: leaf(2, '') });
    expect(snapshot.t('filled')).toBe('x');
    expect(snapshot.t('empty')).toBe('empty');
    expect(snapshot.t('empty', { name: 'x' })).toBe('empty');
  });

  it('matches the key exactly in both directions of case', () => {
    const snapshot = snapshotWith({
      lower: leaf(1, 'lower'),
      'Mixed.Key': leaf(2, 'mixed'),
      ...arrayKeys('menu', 10, ['A']),
    });
    expect(snapshot.t('LOWER')).toBe('LOWER');
    expect(snapshot.t('lower')).toBe('lower');
    expect(snapshot.t('mixed.key')).toBe('mixed.key');
    expect(snapshot.t('Mixed.Key')).toBe('mixed');
    expect(snapshot.entry('LOWER')).toBeNull();
    expect(snapshot.tArray('MENU')).toEqual([]);
    expect(snapshot.tArray('menu')).toEqual(['A']);
  });

  it('treats prototype property names as ordinary key names', () => {
    const raw = '{"schemaVersion":1,"bundle":"ns1","locale":"en","keys":{"constructor":{"id":"21","value":"ctor"}}}';
    const snapshot = snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: raw } }));
    expect(snapshot.t('constructor')).toBe('ctor');
    for (const name of ['toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(snapshot.t(name)).toBe(name);
      expect(snapshot.entry(name)).toBeNull();
      expect(snapshot.tArray(name)).toEqual([]);
    }
  });

  it('answers with key names, an empty list and null when it holds nothing', () => {
    const snapshot = snapshotOf(null);
    expect(snapshot.t('app.title')).toBe('app.title');
    expect(snapshot.tArray('app.title')).toEqual([]);
    expect(snapshot.entry('app.title')).toBeNull();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(snapshotWith({ a: leaf(1, 'A') }))).toBe(true);
  });
});

describe('one locale only', () => {
  const keys = (locale: string) =>
    locale === 'en'
      ? { 'only.english': leaf(1, 'English only'), shared: leaf(2, 'Shared') }
      : { shared: leaf(2, 'مشترك') };
  const held = () =>
    world({ ns1: DEFAULT }, { ns1: { en: flatSlice('ns1', 'en', keys('en')), ar: flatSlice('ns1', 'ar', keys('ar')) } });

  it('returns the key name for a key the selected locale lacks, even when another locale has it', () => {
    const arabic = snapshotOf(held(), { locale: 'ar' });
    expect(arabic.t('only.english')).toBe('only.english');
    expect(arabic.entry('only.english')).toBeNull();
    expect(arabic.t('shared')).toBe('مشترك');
    expect(snapshotOf(held(), { locale: 'en' }).t('only.english')).toBe('English only');
  });

  it('treats a bundle that lacks the selected locale as having no keys', () => {
    const w = world(
      { ns1: DEFAULT, ns2: { type: 'custom', name: 'extras' } },
      {
        ns1: { en: flatSlice('ns1', 'en', { a: leaf(1, 'A') }), ar: flatSlice('ns1', 'ar', { a: leaf(1, 'ا') }) },
        ns2: { en: flatSlice('ns2', 'en', { b: leaf(2, 'B') }) },
      },
    );
    const snapshot = snapshotOf(w, { locale: 'ar' });
    expect(snapshot.t('a')).toBe('ا');
    expect(snapshot.t('b', undefined, { bundle: { type: 'custom', name: 'extras' } })).toBe('b');
    expect(snapshotOf(w, { locale: 'en' }).t('b', undefined, { bundle: { type: 'custom', name: 'extras' } })).toBe('B');
  });
});

describe('locale spelling', () => {
  it('finds the downloaded slice under the manifest spelling of the selected locale', () => {
    const w = world({ ns1: DEFAULT }, { ns1: { 'pt-BR': flatSlice('ns1', 'pt-BR', { k: leaf(1, 'olá') }) } });
    expect(snapshotOf(w, { locale: 'pt-br' }).t('k')).toBe('olá');
    expect(snapshotOf(w, { locale: 'PT-BR' }).t('k')).toBe('olá');
  });

  it('uses an embedded slice whose locale differs from the selected one only in case', () => {
    const embedded = [flatSlice('ns1', 'pt-br', { k: leaf(1, 'embedded') })];
    expect(snapshotOf(null, { embedded, locale: 'pt-BR' }).t('k')).toBe('embedded');
    expect(snapshotOf(null, { embedded: [flatSlice('ns1', 'EN', { k: leaf(1, 'upper') })], locale: 'en' }).t('k')).toBe('upper');
  });

  it('still leaves out an embedded slice of another locale', () => {
    const embedded = [flatSlice('ns1', 'pt-PT', { k: leaf(1, 'portugal') })];
    expect(snapshotOf(null, { embedded, locale: 'pt-BR' }).t('k')).toBe('k');
  });

  it('reports the locale as it was given', () => {
    const w = world({ ns1: DEFAULT }, { ns1: { 'pt-BR': flatSlice('ns1', 'pt-BR', {}) } });
    expect(snapshotOf(w, { locale: 'pt-br' }).language).toBe('pt-br');
  });
});

describe('which bundle answers', () => {
  it('lets the lowest numeric bundle id win when bundles share type and name', () => {
    const w = world(
      { ns10: DEFAULT, ns7: DEFAULT, ns9: DEFAULT },
      {
        ns10: { en: flatSlice('ns10', 'en', { k: leaf(1, 'from ten'), only10: leaf(3, 'ten') }) },
        ns7: { en: flatSlice('ns7', 'en', { k: leaf(2, 'from seven') }) },
        ns9: { en: flatSlice('ns9', 'en', { k: leaf(4, 'from nine') }) },
      },
    );
    const snapshot = snapshotOf(w);
    expect(snapshot.t('k')).toBe('from seven');
    expect(snapshot.t('only10')).toBe('only10');
  });

  it('lets ns2 answer before ns10', () => {
    const w = world(
      { ns10: DEFAULT, ns2: DEFAULT },
      {
        ns10: { en: flatSlice('ns10', 'en', { k: leaf(1, 'ten') }) },
        ns2: { en: flatSlice('ns2', 'en', { k: leaf(2, 'two') }) },
      },
    );
    expect(snapshotOf(w).t('k')).toBe('two');
  });

  it('matches type as well as name, so a custom bundle never answers a namespace lookup', () => {
    const w = world(
      { ns1: DEFAULT, c1: { type: 'custom', name: 'default' } },
      {
        ns1: { en: flatSlice('ns1', 'en', { 'in.namespace': leaf(1, 'namespace value') }) },
        c1: { en: flatSlice('c1', 'en', { 'in.custom': leaf(2, 'custom value') }) },
      },
    );
    const snapshot = snapshotOf(w);
    const custom = { bundle: { type: 'custom', name: 'default' } } as const;
    expect(snapshot.t('in.custom')).toBe('in.custom');
    expect(snapshot.t('in.custom', undefined, custom)).toBe('custom value');
    expect(snapshot.t('in.namespace', undefined, custom)).toBe('in.namespace');
    expect(snapshot.t('in.namespace')).toBe('namespace value');
    expect(snapshot.t('in.namespace', undefined, { bundle: { type: 'namespace', name: 'nothing' } })).toBe('in.namespace');
  });

  it('never falls to a higher bundle id because the lowest one lacks the selected locale', () => {
    const w = world(
      { ns7: DEFAULT, ns10: DEFAULT },
      {
        ns7: { en: flatSlice('ns7', 'en', { k: leaf(1, 'from seven') }) },
        ns10: { en: flatSlice('ns10', 'en', { k: leaf(2, 'from ten') }), ar: flatSlice('ns10', 'ar', { k: leaf(2, 'من عشرة') }) },
      },
    );
    expect(snapshotOf(w, { locale: 'ar' }).t('k')).toBe('k');
    expect(snapshotOf(w, { locale: 'en' }).t('k')).toBe('from seven');
  });

  it('never falls to a higher bundle id because the lowest one could not be read', () => {
    const w = world(
      { ns7: DEFAULT, ns10: DEFAULT },
      {
        ns7: { en: '{"schemaVersion":1,' },
        ns10: { en: flatSlice('ns10', 'en', { k: leaf(2, 'from ten') }) },
      },
    );
    expect(snapshotOf(w).t('k')).toBe('k');
  });

  it('goes on to a later namespace of the same source when an earlier one holds the key with an empty value', () => {
    const w = world(
      { c1: { ...CUSTOM_UI, layout: 'nested', namespaces: ['a', 'b'] } },
      {
        c1: {
          en: {
            schemaVersion: 1,
            bundle: 'c1',
            locale: 'en',
            namespaces: {
              a: { k: leaf(1, ''), list: leaf(5, '', { string_array_child_keys: [] }) },
              b: { k: leaf(2, 'from b'), list: leaf(3, '', { string_array_child_keys: [4] }), 'list.0': leaf(4, 'item') },
            },
          },
        },
      },
    );
    const snapshot = snapshotOf(w);
    const ui = { bundle: CUSTOM_UI };
    expect(snapshot.t('k', undefined, ui)).toBe('from b');
    expect(snapshot.entry('k', ui)?.value).toBe('from b');
    expect(snapshot.tArray('list', ui)).toEqual(['item']);
    expect(snapshot.t('k', undefined, { ...ui, namespace: 'a' })).toBe('k');
  });

  it('searches nested namespaces in the manifest order, not the slice key order', () => {
    const w = world(
      { ns1: DEFAULT, c1: { ...CUSTOM_UI, layout: 'nested', namespaces: ['b', 'a'] } },
      {
        ns1: { en: flatSlice('ns1', 'en', { x: leaf(1, 'x') }) },
        c1: {
          en: {
            schemaVersion: 1,
            bundle: 'c1',
            locale: 'en',
            namespaces: {
              zz: { dup: leaf(10, 'from zz'), onlyZz: leaf(11, 'zz only') },
              a: { k: leaf(12, 'from a'), mixed: leaf(13, 'a mixed') },
              m: { dup: leaf(14, 'from m') },
              b: { k: leaf(15, 'from b') },
            },
          },
        },
      },
    );
    const snapshot = snapshotOf(w);
    const ui = { bundle: CUSTOM_UI };
    expect(snapshot.t('k', undefined, ui)).toBe('from b');
    expect(snapshot.t('k', undefined, { ...ui, namespace: 'a' })).toBe('from a');
    expect(snapshot.t('k', undefined, { ...ui, namespace: 'm' })).toBe('k');
    expect(snapshot.t('dup', undefined, ui)).toBe('from m');
    expect(snapshot.t('onlyZz', undefined, ui)).toBe('zz only');
    expect(snapshot.t('dup', undefined, { ...ui, namespace: 'zz' })).toBe('from zz');
    expect(snapshot.t('dup', undefined, { ...ui, namespace: 'nowhere' })).toBe('dup');
  });

  it('serves a nested bundle through the namespace option', () => {
    const w = world(
      { ns1: DEFAULT, c1: { ...CUSTOM_UI, layout: 'nested', namespaces: ['n'] } },
      { c1: { en: { schemaVersion: 1, bundle: 'c1', locale: 'en', namespaces: { n: { k: leaf(2, 'nested') } } } } },
    );
    expect(snapshotOf(w).t('k', undefined, { bundle: CUSTOM_UI, namespace: 'n' })).toBe('nested');
  });
});

describe('only the current manifest is served', () => {
  const both = () =>
    world(
      { ns1: DEFAULT, c1: CUSTOM_UI },
      {
        ns1: { en: flatSlice('ns1', 'en', { here: leaf(1, 'here') }) },
        c1: { en: flatSlice('c1', 'en', { gone: leaf(2, 'was served') }) },
      },
    );

  it('serves a bundle while the manifest lists it', () => {
    expect(snapshotOf(both()).t('gone', undefined, { bundle: CUSTOM_UI })).toBe('was served');
  });

  it('stops serving a bundle the manifest no longer lists, even if its bytes and slot are still held', () => {
    const w = both();
    delete w.install.manifest.bundles.c1;
    delete w.install.manifest.slices.c1;
    const snapshot = snapshotOf(w);
    expect(snapshot.t('gone', undefined, { bundle: CUSTOM_UI })).toBe('gone');
    expect(snapshot.entry('gone', { bundle: CUSTOM_UI })).toBeNull();
    expect(snapshot.t('here')).toBe('here');
  });

  it('does not serve an embedded copy of a bundle the manifest does not list when an install is held', () => {
    const w = both();
    delete w.install.manifest.bundles.c1;
    const snapshot = snapshotOf(w, { embedded: [flatSlice('c1', 'en', { gone: leaf(2, 'embedded gone') })] });
    expect(snapshot.t('gone', undefined, { bundle: CUSTOM_UI })).toBe('gone');
  });

  it('lets an embedded slice of an unlisted bundle answer default lookups, after every listed source', () => {
    const w = oneBundle({ shared: leaf(1, 'downloaded'), blank: leaf(2, '') });
    const embedded = [
      flatSlice('old9', 'en', { shared: leaf(3, 'unlisted'), blank: leaf(4, 'unlisted blank'), extra: leaf(5, 'unlisted extra') }),
      flatSlice('ns1', 'en', { blank: leaf(6, 'listed embedded') }),
    ];
    const snapshot = snapshotOf(w, { embedded });
    expect(snapshot.t('shared')).toBe('downloaded');
    expect(snapshot.t('blank')).toBe('listed embedded');
    expect(snapshot.t('extra')).toBe('unlisted extra');
    expect(snapshot.t('extra', undefined, { bundle: CUSTOM_UI })).toBe('extra');
  });

  it('falls to embedded when the default bundle was dropped or renumbered', () => {
    const dropped = world({ c1: CUSTOM_UI }, { c1: { en: flatSlice('c1', 'en', { other: leaf(1, 'x') }) } });
    const renumbered = world({ ns2: DEFAULT }, { ns2: { en: flatSlice('ns2', 'en', { other: leaf(1, 'x') }) } });
    const embedded = [flatSlice('ns1', 'en', { k: leaf(2, 'embedded') })];
    expect(snapshotOf(dropped, { embedded }).t('k')).toBe('embedded');
    expect(snapshotOf(renumbered, { embedded }).t('k')).toBe('embedded');
    expect(snapshotOf(renumbered, { embedded }).entry('k')?.value).toBe('embedded');
  });

  it('serves the same bundle again when a later manifest lists it', () => {
    const w = both();
    const without = both();
    delete without.install.manifest.bundles.c1;
    expect(snapshotOf(without).t('gone', undefined, { bundle: CUSTOM_UI })).toBe('gone');
    expect(snapshotOf(w).t('gone', undefined, { bundle: CUSTOM_UI })).toBe('was served');
  });
});

describe('slots the snapshot cannot read', () => {
  it('skips a slot whose bytes are absent and falls to the embedded copy', () => {
    const w = oneBundle({ a: leaf(1, 'from ota') });
    w.slices.clear();
    const snapshot = snapshotOf(w, { embedded: [flatSlice('ns1', 'en', { a: leaf(1, 'embedded') })] });
    expect(snapshot.t('a')).toBe('embedded');
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['empty', ''],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('skips a slot whose bytes are %s', (_, text) => {
    const w = world({ ns1: DEFAULT }, { ns1: { en: text } });
    const snapshot = snapshotOf(w, { embedded: [flatSlice('ns1', 'en', { a: leaf(1, 'embedded') })] });
    expect(snapshot.t('a')).toBe('embedded');
    expect(snapshot.tArray('a')).toEqual([]);
    expect(snapshot.entry('zzz')).toBeNull();
  });

  it('skips a slice with another schema version and reports it without the key names', () => {
    const { report, reports, codes } = reporter();
    const w = world({ ns1: DEFAULT }, { ns1: { en: { schemaVersion: 2, bundle: 'ns1', locale: 'en', keys: { secret: leaf(1, 'v') } } } });
    const snapshot = snapshotOf(w, { report });
    expect(snapshot.t('secret')).toBe('secret');
    expect(codes()).toContain('slice-schema');
    expect(JSON.stringify(reports)).not.toContain('secret');
  });

  it.each([
    ['a missing version', '{"bundle":"ns1","locale":"en","keys":{}}', undefined],
    ['a version written as text', '{"schemaVersion":"1","bundle":"ns1","locale":"en","keys":{}}', undefined],
    ['a version that is null', '{"schemaVersion":null,"bundle":"ns1","locale":"en","keys":{}}', undefined],
    ['a version too large to be finite', '{"schemaVersion":1e400,"bundle":"ns1","locale":"en","keys":{}}', undefined],
    ['a later version', '{"schemaVersion":3,"bundle":"ns1","locale":"en","keys":{}}', 3],
    ['a fractional version', '{"schemaVersion":1.5,"bundle":"ns1","locale":"en","keys":{}}', 1.5],
  ])('reports a slice with %s, naming the version only when it is a number', (_, text, version) => {
    const { report, reports } = reporter();
    snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: text } }), { report });
    expect(reports).toEqual([{ code: 'slice-schema', ...(version === undefined ? {} : { details: { schemaVersion: version } }) }]);
  });

  it('reports nothing for slices it reads', () => {
    const { report, codes } = reporter();
    snapshotWith({ a: leaf(1, 'A') }, { report });
    expect(codes()).toEqual([]);
  });

  it('reads a slice from the bytes of the slot for the selected locale only', () => {
    const w = world(
      { ns1: DEFAULT },
      { ns1: { en: flatSlice('ns1', 'en', { k: leaf(1, 'en') }), fr: flatSlice('ns1', 'fr', { k: leaf(1, 'fr') }) } },
    );
    expect(snapshotOf(w, { locale: 'fr' }).t('k')).toBe('fr');
    expect(snapshotOf(w, { locale: 'en' }).t('k')).toBe('en');
  });
});

describe('embedded translations', () => {
  const embeddedEn = flatSlice('ns1', 'en', {
    'embedded.only': leaf(50, 'Embedded value'),
    blank: leaf(51, ''),
    both: leaf(52, 'embedded both'),
  });

  it('answers a key that only the embedded slice has', () => {
    const snapshot = snapshotWith({ other: leaf(1, 'x') }, { embedded: [embeddedEn] });
    expect(snapshot.t('embedded.only')).toBe('Embedded value');
    expect(snapshot.t('other')).toBe('x');
  });

  it('prefers the downloaded value to the embedded one', () => {
    const snapshot = snapshotWith({ both: leaf(1, 'ota both') }, { embedded: [embeddedEn] });
    expect(snapshot.t('both')).toBe('ota both');
  });

  it('lets an empty downloaded value fall through to the embedded one', () => {
    const snapshot = snapshotWith({ both: leaf(1, '') }, { embedded: [embeddedEn] });
    expect(snapshot.t('both')).toBe('embedded both');
    expect(snapshot.entry('both')?.value).toBe('embedded both');
  });

  it('lets an empty embedded value fall through to the key name', () => {
    const snapshot = snapshotWith({ x: leaf(1, 'x') }, { embedded: [embeddedEn] });
    expect(snapshot.t('blank')).toBe('blank');
    expect(snapshot.entry('blank')).toBeNull();
  });

  it('uses only the embedded slices of the selected locale', () => {
    const arabic = flatSlice('ns1', 'ar', { 'embedded.only': leaf(50, 'قيمة') });
    const snapshot = snapshotOf(null, { embedded: [embeddedEn, arabic], locale: 'ar' });
    expect(snapshot.t('embedded.only')).toBe('قيمة');
    expect(snapshot.t('both')).toBe('both');
  });

  it('answers from embedded slices alone when no install is held, in array order', () => {
    const first = flatSlice('x1', 'en', { k: leaf(1, 'first'), a: leaf(2, 'only first') });
    const second = flatSlice('x2', 'en', { k: leaf(3, 'second'), b: leaf(4, 'only second') });
    const snapshot = snapshotOf(null, { embedded: [first, second] });
    expect(snapshot.t('k')).toBe('first');
    expect(snapshot.t('a')).toBe('only first');
    expect(snapshot.t('b')).toBe('only second');
    expect(snapshot.language).toBe('en');
  });

  it('serves a locale that exists only in the embedded slices', () => {
    const snapshot = snapshotOf(null, { embedded: [flatSlice('ns1', 'ar', { k: leaf(1, 'مرحبا') })], locale: 'ar' });
    expect(snapshot.t('k')).toBe('مرحبا');
    expect(snapshot.language).toBe('ar');
  });

  it('gives a lookup that names another bundle nothing from embedded slices when no install is held', () => {
    const snapshot = snapshotOf(null, { embedded: [flatSlice('x1', 'en', { k: leaf(1, 'first') })] });
    expect(snapshot.t('k', undefined, { bundle: CUSTOM_UI })).toBe('k');
    expect(snapshot.tArray('k', { bundle: CUSTOM_UI })).toEqual([]);
    expect(snapshot.entry('k', { bundle: CUSTOM_UI })).toBeNull();
    expect(snapshot.t('k')).toBe('first');
  });

  it('matches an embedded slice to a bundle by its id through the install manifest', () => {
    const w = world(
      { ns1: DEFAULT, c1: CUSTOM_UI },
      { ns1: { en: flatSlice('ns1', 'en', { here: leaf(1, 'here') }) } },
    );
    const snapshot = snapshotOf(w, {
      embedded: [flatSlice('c1', 'en', { k: leaf(2, 'custom embedded') }), flatSlice('ns1', 'en', { k: leaf(3, 'default embedded') })],
    });
    expect(snapshot.t('k')).toBe('default embedded');
    expect(snapshot.t('k', undefined, { bundle: CUSTOM_UI })).toBe('custom embedded');
  });

  it('ignores anything that is not a readable slice', () => {
    const garbage = [null, 7, 'text', [], { schemaVersion: 2, bundle: 'ns1', locale: 'en', keys: { g: leaf(1, 'v') } }] as never[];
    const snapshot = snapshotOf(null, { embedded: [...garbage, embeddedEn] });
    expect(snapshot.t('embedded.only')).toBe('Embedded value');
    expect(snapshot.t('g')).toBe('g');
  });

  it('answers tArray and entry from the embedded slice too', () => {
    const embedded = flatSlice('ns1', 'en', {
      ...arrayKeys('menu', 1, ['A', 'B']),
      'hero.image': leaf(9, 'https://media.example.com/h.png', { type: 'image' }),
    });
    const snapshot = snapshotWith({ x: leaf(100, 'x') }, { embedded: [embedded] });
    expect(snapshot.tArray('menu')).toEqual(['A', 'B']);
    expect(snapshot.entry('hero.image')?.value).toBe('https://media.example.com/h.png');
  });
});

describe('plural parents and children', () => {
  const pluralWith = (extra: Record<string, unknown> = {}) => ({
    ...pluralKeys('cart', 10, { one: 'ONE', other: 'MANY' }, 'PARENT'),
    ...extra,
  });

  it('returns the child for the count, never the parent value', () => {
    const snapshot = snapshotWith(pluralWith());
    expect(snapshot.t('cart', { count: 1 })).toBe('ONE');
    expect(snapshot.t('cart', { count: 5 })).toBe('MANY');
    expect(snapshot.t('cart')).toBe('PARENT');
  });

  it('uses the parent value when the arguments carry no numeric count', () => {
    const snapshot = snapshotWith(pluralWith());
    expect(snapshot.t('cart', { count: '3' })).toBe('PARENT');
    expect(snapshot.t('cart', {})).toBe('PARENT');
    expect(snapshot.t('cart', [3])).toBe('PARENT');
  });

  it('never uses a key merely named like a form when the parent does not list its id', () => {
    const keys = {
      ...pluralKeys('items', 10, { one: 'listed one', other: 'listed other' }),
      'items.few': leaf(99, 'unlisted few'),
      ...pluralKeys('listedFew', 20, { few: 'listed few', other: 'other' }),
    };
    const arabic = snapshotWith(keys, { locales: ['ar'] });
    expect(arabic.t('items', { count: 3 })).toBe('listed other');
    expect(arabic.t('listedFew', { count: 3 })).toBe('listed few');
    expect(snapshotWith(keys).t('items', { count: 1 })).toBe('listed one');
  });

  it('never uses a listed child whose name does not end in the form', () => {
    const keys = {
      items: leaf(10, '', { plural_child_keys: [11, 12] }),
      'unrelated.name': leaf(11, 'wrong one'),
      'items.other': leaf(12, 'right other'),
    };
    expect(snapshotWith(keys).t('items', { count: 1 })).toBe('right other');
  });

  it('falls from an empty child to the parent value, then to the key name unformatted', () => {
    const keys = {
      ...pluralKeys('a', 10, { one: '', other: '' }, 'parent {count}'),
      ...pluralKeys('b', 20, { one: '', other: '' }, ''),
    };
    const snapshot = snapshotWith(keys);
    expect(snapshot.t('a', { count: 5 })).toBe('parent 5');
    expect(snapshot.t('b', { count: 5 })).toBe('b');
  });

  it('uses the other form for a well-formed tag that has no plural data', () => {
    const keys = pluralKeys('cart', 10, { one: 'ONE', few: 'FEW', other: 'MANY' });
    const snapshot = snapshotWith(keys, { locales: ['qaa'] });
    for (const count of [0, 1, 2, 3, 11]) expect(snapshot.t('cart', { count })).toBe('MANY');
  });

  it('never uses a listed child that is named after another parent as a form', () => {
    const keys = {
      ...pluralKeys('cart', 10, { one: 'cart one', other: 'cart other' }),
      items: leaf(20, 'ITEMS PARENT', { plural_child_keys: [11] }),
    };
    expect(snapshotWith(keys).t('items', { count: 1 })).toBe('ITEMS PARENT');
  });

  it('falls to the other child when the form has no child', () => {
    const snapshot = snapshotWith(pluralKeys('cart', 10, { one: 'ONE', other: 'MANY' }));
    expect(snapshot.t('cart', { count: 0 })).toBe('MANY');
    expect(snapshot.t('cart', { count: 2 })).toBe('MANY');
  });

  it('falls to the other child when the child for the form is empty', () => {
    const snapshot = snapshotWith(pluralKeys('cart', 10, { one: '', other: 'MANY' }, 'PARENT'));
    expect(snapshot.t('cart', { count: 1 })).toBe('MANY');
  });

  it('falls to the embedded copy when the downloaded parent has nothing usable', () => {
    const embedded = flatSlice('ns1', 'en', pluralKeys('cart', 10, { one: 'embedded one', other: 'embedded other' }));
    const snapshot = snapshotWith(pluralKeys('cart', 10, { one: '', other: '' }, ''), { embedded: [embedded] });
    expect(snapshot.t('cart', { count: 1 })).toBe('embedded one');
  });
});

describe('children belong to the namespace of their parent', () => {
  const nested = () =>
    world(
      { c1: { ...CUSTOM_UI, layout: 'nested', namespaces: ['a', 'b'] } },
      {
        c1: {
          en: {
            schemaVersion: 1,
            bundle: 'c1',
            locale: 'en',
            namespaces: {
              a: {
                cart: leaf(1, 'PARENT', { plural_child_keys: [2] }),
                menu: leaf(3, '', { string_array_child_keys: [4] }),
              },
              b: { 'cart.other': leaf(2, 'child in b'), 'menu.0': leaf(4, 'item in b') },
            },
          },
        },
      },
    );
  const ui = { bundle: CUSTOM_UI, namespace: 'a' } as const;

  it('does not take a plural child from another namespace', () => {
    expect(snapshotOf(nested()).t('cart', { count: 5 }, ui)).toBe('PARENT');
  });

  it('does not take a string array child from another namespace', () => {
    expect(snapshotOf(nested()).tArray('menu', ui)).toEqual([]);
  });
});

describe('plural forms follow the text locale', () => {
  const forms = { zero: 'Z0', one: 'O1', two: 'T2', few: 'F3', many: 'M4', other: 'X5' };
  const keys = {
    ...pluralKeys('cart.items', 10, forms),
    ...pluralKeys('cart.plain', 20, { one: 'O1', other: 'X5' }),
    ...pluralKeys('cart.noFew', 30, { one: 'O1', other: 'X5' }),
  };
  const locales = ['en', 'ar', 'fr'];

  it('uses the Arabic rules when ar is selected and the English rules when en is', () => {
    const arabic = snapshotWith(keys, { locales, locale: 'ar' });
    expect(arabic.t('cart.items', { count: 3 })).toBe('F3');
    expect(arabic.t('cart.items', { count: 11 })).toBe('M4');
    expect(arabic.t('cart.items', { count: 2 })).toBe('T2');
    expect(arabic.t('cart.items', { count: 1 })).toBe('O1');
    expect(arabic.t('cart.items', { count: 100 })).toBe('X5');
    expect(arabic.t('cart.noFew', { count: 3 })).toBe('X5');

    const english = snapshotWith(keys, { locales, locale: 'en' });
    expect(english.t('cart.items', { count: 3 })).toBe('X5');
    expect(english.t('cart.items', { count: 1 })).toBe('O1');
  });

  it('uses the zero child for a count of 0 in every language that has one, and the language rule otherwise', () => {
    for (const locale of locales) {
      expect(snapshotWith(keys, { locales, locale }).t('cart.items', { count: 0 })).toBe('Z0');
    }
    expect(snapshotWith(keys, { locales, locale: 'en' }).t('cart.plain', { count: 0 })).toBe('X5');
    const french = snapshotWith(keys, { locales, locale: 'fr' });
    expect(french.t('cart.plain', { count: 0 })).toBe('O1');
    expect(french.t('cart.plain', { count: 1.5 })).toBe('O1');
  });

  it('selects the other form for a locale that is not a language tag, still uses zero for 0, and never throws', () => {
    const odd = {
      ...pluralKeys('cart.items', 10, { zero: 'Z0', one: 'O1', other: 'X5' }),
      ...pluralKeys('cart.plain', 20, { one: 'O1', other: 'X5' }),
    };
    const snapshot = snapshotWith(odd, { locales: ['en_US'] });
    expect(snapshot.t('cart.items', { count: 1 })).toBe('X5');
    expect(snapshot.t('cart.items', { count: 0 })).toBe('Z0');
    expect(snapshot.t('cart.plain', { count: 1 })).toBe('X5');
  });

  it('builds its plural rules once, only for the locale it serves', () => {
    const real = Intl.PluralRules;
    const seen: unknown[] = [];
    class Recording extends real {
      constructor(locales?: string | string[], options?: Intl.PluralRulesOptions) {
        seen.push(locales);
        super(locales, options);
      }
    }
    (Intl as { PluralRules: unknown }).PluralRules = Recording;
    try {
      const snapshot = snapshotWith(keys, { locales, locale: 'ar' });
      for (let count = 0; count < 20; count++) snapshot.t('cart.items', { count });
      snapshot.t('cart.items', { count: 3 });
    } finally {
      (Intl as { PluralRules: unknown }).PluralRules = real;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(1);
    for (const wanted of seen) expect(wanted === 'ar' || (Array.isArray(wanted) && wanted[0] === 'ar')).toBe(true);
  });
});

describe('the downloaded translation is searched whole before the embedded one', () => {
  it('lets a downloaded other form beat an embedded few form', () => {
    const downloaded = pluralKeys('items', 10, { one: 'ota one', other: 'ota other' });
    const embedded = flatSlice('ns1', 'ar', pluralKeys('items', 10, { few: 'embedded few', other: 'embedded other' }));
    const snapshot = snapshotWith(downloaded, { locales: ['ar'], embedded: [embedded] });
    expect(snapshot.t('items', { count: 3 })).toBe('ota other');
  });

  it('still uses the embedded few form when nothing is downloaded for the key', () => {
    const embedded = flatSlice('ns1', 'ar', pluralKeys('items', 10, { few: 'embedded few', other: 'embedded other' }));
    const snapshot = snapshotWith({ unrelated: leaf(1, 'x') }, { locales: ['ar'], embedded: [embedded] });
    expect(snapshot.t('items', { count: 3 })).toBe('embedded few');
  });
});

describe('string arrays', () => {
  it('returns the listed children in list order and skips ids the slice lacks or that are not strings', () => {
    const snapshot = snapshotWith({
      menu: leaf(1, '', { string_array_child_keys: [3, 1000, 2, 5, 4, 6] }),
      'menu.a': leaf(2, 'second'),
      'menu.b': leaf(3, 'first'),
      'menu.c': leaf(4, ''),
      'menu.d': leaf(5, 'third'),
      'menu.e': leaf(6, 7),
      unrelated: leaf(7, 'not listed'),
    });
    expect(snapshot.tArray('menu')).toEqual(['first', 'second', 'third', '']);
  });

  it('returns the values of an array key and an empty list for a missing one', () => {
    const snapshot = snapshotWith(arrayKeys('menu', 1, ['A', 'B']));
    expect(snapshot.tArray('menu')).toEqual(['A', 'B']);
    expect(snapshot.tArray('nothing')).toEqual([]);
  });

  it('returns an empty list for a key that has no array children', () => {
    expect(snapshotWith({ plain: leaf(1, 'v') }).tArray('plain')).toEqual([]);
  });

  it('reads the children by id from the slice that holds the parent', () => {
    const embedded = flatSlice('ns1', 'en', arrayKeys('menu', 1, ['embedded A']));
    const snapshot = snapshotWith(arrayKeys('menu', 1, ['A', 'B']), { embedded: [embedded] });
    expect(snapshot.tArray('menu')).toEqual(['A', 'B']);
  });
});

describe('what a snapshot keeps', () => {
  it('reports to the callback it was built with, even if the input is changed afterwards', () => {
    const first: SnapshotReport[] = [];
    const second: SnapshotReport[] = [];
    const w = oneBundle({ a: leaf(1, 'javascript:alert(1)', { type: 'image' }) });
    const input = { install: w.install, slices: w.slices, embedded: [], locale: 'en', defaultBundle: DEFAULT, report: (r: SnapshotReport) => void first.push(r) };
    const snapshot = createSnapshot(input);
    input.report = (r: SnapshotReport) => void second.push(r);
    snapshot.entry('a');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe('a snapshot never changes', () => {
  it('keeps answering from its own data after a later snapshot is built from newer data', () => {
    const older = snapshotWith({ k: leaf(1, 'old value'), gone: leaf(2, 'old only') });
    const newer = snapshotWith({ k: leaf(1, 'new value') });
    expect(newer.t('k')).toBe('new value');
    expect(older.t('k')).toBe('old value');
    expect(older.t('gone')).toBe('old only');
    expect(newer.t('gone')).toBe('gone');
  });

  it('answers the same on every call', () => {
    const snapshot = snapshotWith({ k: leaf(1, 'v'), ...pluralKeys('p', 10, { one: 'one', other: 'many' }) });
    const first = [snapshot.t('k'), snapshot.t('p', { count: 1 }), snapshot.entry('k')];
    snapshotWith({ k: leaf(1, 'other') });
    expect([snapshot.t('k'), snapshot.t('p', { count: 1 }), snapshot.entry('k')]).toEqual(first);
  });

  it('can be built again from the same input with the same answers', () => {
    const w = oneBundle({ k: leaf(1, 'v') });
    const input = { install: w.install, slices: w.slices, embedded: [], locale: 'en', defaultBundle: DEFAULT };
    expect(createSnapshot(input).t('k')).toBe('v');
    expect(createSnapshot(input).t('k')).toBe('v');
  });
});
