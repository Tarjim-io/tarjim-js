import { describe, expect, it } from 'vitest';
import { decodeSlice } from '../../src/index.js';
import { flatSlice, leaf } from './world.js';

const decoded = (value: unknown) => {
  const result = decodeSlice(value);
  if (result === null) throw new Error('expected a decoded slice');
  return result;
};
const flatLeaves = (value: unknown) => decoded(value).namespaces.get('') ?? new Map();

describe('which slices are readable', () => {
  it('reads a version 1 flat slice', () => {
    const slice = decoded(flatSlice('ns1', 'en', { a: leaf(1, 'A') }));
    expect(slice.bundle).toBe('ns1');
    expect(slice.locale).toBe('en');
    expect([...slice.namespaces.keys()]).toEqual(['']);
    expect(slice.namespaces.get('')?.get('a')?.value).toBe('A');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a string', 'text'],
    ['an array', []],
    ['a boolean', true],
  ])('is null for %s', (_, value) => {
    expect(decodeSlice(value)).toBeNull();
  });

  it.each([
    ['a later version', 2],
    ['version 0', 0],
    ['a version written as text', '1'],
    ['a missing version', undefined],
    ['a fractional version', 1.5],
  ])('is null for %s', (_, schemaVersion) => {
    expect(decodeSlice({ schemaVersion, bundle: 'ns1', locale: 'en', keys: { a: leaf(1, 'A') } })).toBeNull();
  });

  it('never throws, whatever the input', () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error('get');
      },
      ownKeys() {
        throw new Error('ownKeys');
      },
      has() {
        throw new Error('has');
      },
      getPrototypeOf() {
        throw new Error('getPrototypeOf');
      },
    });
    const cyclic: Record<string, unknown> = { schemaVersion: 1, bundle: 'b', locale: 'en' };
    cyclic.keys = cyclic;
    const inputs = [hostile, cyclic, { schemaVersion: 1, keys: hostile }, { schemaVersion: 1, namespaces: { n: hostile } }];
    for (const input of inputs) expect(() => decodeSlice(input)).not.toThrow();
  });

  it('does not change the object it reads', () => {
    const input = flatSlice('ns1', 'en', { a: leaf(1, 'A', { attributes: { alt: 'x' }, plural_child_keys: [2] }) });
    const before = JSON.stringify(input);
    decodeSlice(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('layouts', () => {
  it('reads a nested slice into one namespace per key', () => {
    const slice = decoded({
      schemaVersion: 1,
      bundle: 'c1',
      locale: 'en',
      namespaces: { a: { k: leaf(1, 'from a') }, b: { k: leaf(2, 'from b') } },
    });
    expect([...slice.namespaces.keys()].sort()).toEqual(['a', 'b']);
    expect(slice.namespaces.get('a')?.get('k')?.value).toBe('from a');
    expect(slice.namespaces.get('b')?.get('k')?.value).toBe('from b');
    expect(slice.namespaces.has('')).toBe(false);
  });

  it('skips nested namespaces that are not objects and keeps the ones that are', () => {
    const slice = decoded({
      schemaVersion: 1,
      bundle: 'c1',
      locale: 'en',
      namespaces: { a: null, b: [1], c: 'text', d: { k: leaf(1, 'found') } },
    });
    expect(slice.namespaces.get('d')?.get('k')?.value).toBe('found');
    for (const name of ['a', 'b', 'c']) expect(slice.namespaces.get(name)?.size ?? 0).toBe(0);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['text', 'text'],
    ['a number', 7],
    ['missing', undefined],
  ])('holds no leaves when keys is %s', (_, keys) => {
    const slice = decodeSlice({ schemaVersion: 1, bundle: 'ns1', locale: 'en', keys });
    expect(slice === null || [...slice.namespaces.values()].every((leaves) => leaves.size === 0)).toBe(true);
  });
});

describe('leaves', () => {
  it('keeps the id, the value and the type', () => {
    const found = flatLeaves(flatSlice('ns1', 'en', { a: leaf(12, 'A', { type: 'image' }) })).get('a');
    expect(found?.id).toBe('12');
    expect(found?.value).toBe('A');
    expect(found?.type).toBe('image');
  });

  it('turns a number id into text and keeps a text id', () => {
    const leaves = flatLeaves(flatSlice('ns1', 'en', { n: { id: 12, value: 'v' }, s: { id: 'x1', value: 'v' } }));
    expect(leaves.get('n')?.id).toBe('12');
    expect(leaves.get('s')?.id).toBe('x1');
  });

  it.each([
    ['a number', 5],
    ['an object', { toString: 'x' }],
    ['an array', ['a', 'b']],
    ['null', null],
    ['missing', undefined],
  ])('treats a value that is %s as missing', (_, value) => {
    const found = flatLeaves(flatSlice('ns1', 'en', { k: { id: '1', value } })).get('k');
    expect(found?.value).toBeUndefined();
  });

  it('keeps an empty value as it is, for the lookup to treat as missing', () => {
    expect(flatLeaves(flatSlice('ns1', 'en', { k: leaf(1, '') })).get('k')?.value ?? '').toBe('');
  });

  it('drops leaves that are not objects', () => {
    const leaves = flatLeaves(
      flatSlice('ns1', 'en', { nothing: null, number: 7, text: 'text', list: ['a'], flag: true, fine: leaf(1, 'ok') }),
    );
    expect([...leaves.keys()]).toEqual(['fine']);
  });

  it('keeps attributes only when they are a plain object', () => {
    const leaves = flatLeaves(
      flatSlice('ns1', 'en', {
        object: leaf(1, 'v', { attributes: { alt: 'a' } }),
        list: leaf(2, 'v', { attributes: ['alt'] }),
        text: leaf(3, 'v', { attributes: 'alt=x' }),
        number: leaf(4, 'v', { attributes: 7 }),
        nothing: leaf(5, 'v', { attributes: null }),
        absent: leaf(6, 'v'),
      }),
    );
    expect(leaves.get('object')?.attributes).toEqual({ alt: 'a' });
    for (const name of ['list', 'text', 'number', 'nothing', 'absent']) expect(leaves.get(name)?.attributes).toBeNull();
  });

  it('keeps child id lists as arrays of text ids', () => {
    const leaves = flatLeaves(
      flatSlice('ns1', 'en', {
        plural: leaf(1, '', { plural_child_keys: [2, '3'] }),
        list: leaf(4, '', { string_array_child_keys: [5, 6] }),
        neither: leaf(7, 'v'),
      }),
    );
    expect(leaves.get('plural')?.pluralChildIds).toEqual(['2', '3']);
    expect(leaves.get('list')?.arrayChildIds).toEqual(['5', '6']);
    expect(leaves.get('neither')?.pluralChildIds).toBeUndefined();
    expect(leaves.get('neither')?.arrayChildIds).toBeUndefined();
  });

  it('drops list entries that are not ids and lists that are not arrays', () => {
    const leaves = flatLeaves(
      flatSlice('ns1', 'en', {
        weird: leaf(1, 'v', { plural_child_keys: [null, {}, [], true, 2, '3'], string_array_child_keys: [null, {}, 4] }),
        notArrays: leaf(5, 'v', { plural_child_keys: 'nope', string_array_child_keys: { 0: 1 } }),
      }),
    );
    expect(leaves.get('weird')?.pluralChildIds).toEqual(['2', '3']);
    expect(leaves.get('weird')?.arrayChildIds).toEqual(['4']);
    expect(leaves.get('notArrays')?.pluralChildIds).toBeUndefined();
    expect(leaves.get('notArrays')?.arrayChildIds).toBeUndefined();
  });

  it('keeps nothing else the server sent', () => {
    const found = flatLeaves(
      flatSlice('ns1', 'en', { k: leaf(1, 'v', { skip_tid: true, text_type: 'plain', value_casing: 'upper', extra: 1 }) }),
    ).get('k');
    expect(found).toBeDefined();
    const allowed = ['id', 'value', 'type', 'attributes', 'className', 'pluralChildIds', 'arrayChildIds'];
    for (const name of Object.keys(found ?? {})) expect(allowed).toContain(name);
  });

  it('treats prototype property names as ordinary key names', () => {
    const raw = '{"schemaVersion":1,"bundle":"ns1","locale":"en","keys":{"__proto__":{"id":"20","value":"proto"},"constructor":{"id":"21","value":"ctor"}}}';
    const leaves = flatLeaves(JSON.parse(raw));
    expect(leaves.get('__proto__')?.value).toBe('proto');
    expect(leaves.get('constructor')?.value).toBe('ctor');
    expect(leaves.get('toString')).toBeUndefined();
  });
});

describe('looking a leaf up by id', () => {
  it('finds each leaf by its id with the key it was sent under', () => {
    const slice = decoded(flatSlice('ns1', 'en', { a: leaf(1, 'A'), b: leaf(2, 'B') }));
    expect(slice.byId.get('1')?.key).toBe('a');
    expect(slice.byId.get('2')?.leaf.value).toBe('B');
    expect(slice.byId.get('3')).toBeUndefined();
  });

  it('lets the first leaf with an id keep it', () => {
    const slice = decoded(flatSlice('ns1', 'en', { first: leaf(1, 'one'), second: leaf(1, 'again') }));
    expect(slice.byId.get('1')?.key).toBe('first');
  });

  it('leaves a leaf with an unusable id out of the index', () => {
    const slice = decoded(flatSlice('ns1', 'en', { a: { id: { a: 1 }, value: 'v' }, b: { id: null, value: 'v' }, c: { value: 'v' } }));
    expect(slice.byId.size).toBe(0);
  });
});
