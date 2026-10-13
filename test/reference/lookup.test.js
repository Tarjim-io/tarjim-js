import { describe, expect, it } from 'vitest';
import { arrayKeys, buildRelease, leaf, makeSlice, pluralKeys } from '../helpers/fake-delivery.js';
import { accessSpy, basicRelease, plainData, startClient } from '../helpers/harness.js';

const DEFAULT = { type: 'namespace', name: 'default' };

async function clientFor(keys, options) {
  const slices = { en: makeSlice('ns1', 'en', keys), ar: makeSlice('ns1', 'ar', keys) };
  return startClient(buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: slices } }), options);
}

async function clientForRawSlice(text, options) {
  const release = buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: { en: text } } });
  return startClient(release, options);
}

describe('plain lookups', () => {
  it('returns the value for a present key and the key name for a missing one', async () => {
    const { client } = await clientFor({ 'app.title': leaf(1, 'Tarjim') });
    expect(client.t('app.title')).toBe('Tarjim');
    expect(client.t('app.missing')).toBe('app.missing');
  });

  it('matches key names case-sensitively', async () => {
    const { client } = await clientFor({ 'Case.Sensitive': leaf(1, 'Upper') });
    expect(client.t('Case.Sensitive')).toBe('Upper');
    expect(client.t('case.sensitive')).toBe('case.sensitive');
  });

  it('counts an empty value as missing', async () => {
    const { client } = await clientFor({ filled: leaf(1, 'x'), empty: leaf(2, '') });
    expect(client.t('filled')).toBe('x');
    expect(client.t('empty')).toBe('empty');
    expect(client.t('empty', { name: 'x' })).toBe('empty');
  });

  it('answers with key names, an empty list and null from a client that is not active', async () => {
    const { client } = await startClient(basicRelease({ metaOverrides: { track: null } }));
    expect(client.active).toBe(false);
    expect(client.t('app.title')).toBe('app.title');
    expect(plainData(client.tArray('app.title'))).toEqual([]);
    expect(client.entry('app.title')).toBe(null);
  });
});

describe('plural parents and children', () => {
  const pluralWith = (extra = {}) => ({
    ...pluralKeys('cart', 10, { one: 'ONE', other: 'MANY' }, 'PARENT'),
    ...extra,
  });

  it('returns the child for the count, not the parent value', async () => {
    const { client } = await clientFor(pluralWith());
    expect(client.t('cart', { count: 1 })).toBe('ONE');
    expect(client.t('cart', { count: 5 })).toBe('MANY');
    expect(client.t('cart')).toBe('PARENT');
  });

  it('uses a parent value only when the arguments carry no numeric count', async () => {
    const { client } = await clientFor(pluralWith());
    expect(client.t('cart', { count: '3' })).toBe('PARENT');
    expect(client.t('cart', {})).toBe('PARENT');
    expect(client.t('cart', [3])).toBe('PARENT');
  });

  it('never uses a key merely named like a form when its id is not listed', async () => {
    const keys = {
      ...pluralKeys('items', 10, { one: 'listed one', other: 'listed other' }),
      'items.few': leaf(99, 'unlisted few'),
      ...pluralKeys('listedFew', 20, { few: 'listed few', other: 'other' }),
    };
    const { client } = await clientFor(keys);
    const arabic = await clientFor(keys, { config: { language: 'ar' } });
    expect(arabic.client.t('items', { count: 3 })).toBe('listed other');
    expect(arabic.client.t('listedFew', { count: 3 })).toBe('listed few');
    expect(client.t('items', { count: 1 })).toBe('listed one');
  });

  it('falls back from an empty child to the parent value, then to the key name unformatted', async () => {
    const keys = {
      ...pluralKeys('a', 10, { one: '', other: '' }, 'parent {count}'),
      ...pluralKeys('b', 20, { one: '', other: '' }, ''),
    };
    const { client } = await clientFor(keys);
    expect(client.t('a', { count: 5 })).toBe('parent 5');
    expect(client.t('b', { count: 5 })).toBe('b');
  });

  it('falls to the other child when the form has no child', async () => {
    const { client } = await clientFor(pluralKeys('cart', 10, { one: 'ONE', other: 'MANY' }));
    expect(client.t('cart', { count: 0 })).toBe('MANY');
    expect(client.t('cart', { count: 2 })).toBe('MANY');
  });
});

describe('string arrays', () => {
  it('returns the listed children in list order and skips ids the slice lacks or that are not strings', async () => {
    const keys = {
      menu: leaf(1, '', { string_array_child_keys: [3, 1000, 2, 5, 4, 6] }),
      'menu.a': leaf(2, 'second'),
      'menu.b': leaf(3, 'first'),
      'menu.c': leaf(4, ''),
      'menu.d': leaf(5, 'third'),
      'menu.e': leaf(6, 7),
      unrelated: leaf(7, 'not listed'),
    };
    const { client } = await clientFor(keys);
    expect(plainData(client.tArray('menu'))).toEqual(['first', 'second', 'third', '']);
  });

  it('returns an empty list for a missing key', async () => {
    const { client } = await clientFor({ ...arrayKeys('menu', 1, ['A', 'B']) });
    expect(plainData(client.tArray('menu'))).toEqual(['A', 'B']);
    expect(plainData(client.tArray('nothing'))).toEqual([]);
  });
});

describe('entry', () => {
  const full = {
    'hero.image': leaf(12, 'https://media.example.com/hero.png', {
      type: 'image',
      class: 'hero',
      attributes: { alt: 'A hero', title: 'Hero', width: '640', height: '480', loading: 'lazy' },
      skip_tid: true,
      text_type: 'plain',
      value_casing: 'upper',
      string_array_child_keys: [],
    }),
  };

  it('returns exactly value, id, type, attributes and className', async () => {
    const { client, codes } = await clientFor(full);
    expect(plainData(client.entry('hero.image'))).toEqual({
      value: 'https://media.example.com/hero.png',
      id: '12',
      type: 'image',
      attributes: { alt: 'A hero', title: 'Hero', width: '640', height: '480', loading: 'lazy' },
      className: 'hero',
    });
    expect(codes()).toEqual([]);
  });

  it('gives a plain text entry the defaults', async () => {
    const { client } = await clientFor({ plain: { id: 5, value: 'Hello' } });
    expect(plainData(client.entry('plain'))).toEqual({
      value: 'Hello',
      id: '5',
      type: 'text',
      attributes: null,
      className: null,
    });
  });

  it('is null for a missing key and for an empty value', async () => {
    const { client } = await clientFor({ empty: leaf(1, ''), ok: leaf(2, 'x') });
    expect(client.entry('missing')).toBe(null);
    expect(client.entry('empty')).toBe(null);
    expect(client.entry('ok')).not.toBe(null);
  });

  it('drops attributes outside the allow-list and non-string values, reporting once', async () => {
    const keys = {
      one: leaf(1, 'https://media.example.com/a.png', {
        type: 'image',
        attributes: { alt: 'ok', onerror: 'alert(1)', style: 'x', class: 'sneaky', width: 640, 'data-x': 'y' },
      }),
      two: leaf(2, 'https://media.example.com/b.png', { type: 'image', attributes: { onclick: 'z' } }),
    };
    const { client, codes } = await clientFor(keys);
    const one = plainData(client.entry('one'));
    expect(one.attributes).toEqual({ alt: 'ok' });
    expect(one.className).toBe(null);
    expect(plainData(client.entry('two')).attributes).toBe(null);
    client.entry('one');
    expect(codes().filter((code) => code === 'attribute-dropped')).toHaveLength(1);
  });

  it.each([
    ['an array', ['alt']],
    ['a string', 'alt=x'],
    ['a number', 7],
    ['null', null],
  ])('treats attributes that are %s as none', async (_, attributes) => {
    const { client } = await clientFor({ k: leaf(1, 'v', { attributes }) });
    expect(plainData(client.entry('k')).attributes).toBe(null);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['an object', { a: 1 }],
    ['a boolean', true],
    ['an array', [1]],
  ])('is null for a leaf whose id is %s, while t still answers', async (_, id) => {
    const keys = { k: { value: 'v', ...(id === undefined ? {} : { id }) } };
    const { client } = await clientFor(keys);
    expect(client.entry('k')).toBe(null);
    expect(client.t('k')).toBe('v');
  });

  it('accepts a string or a finite number as the id', async () => {
    const { client } = await clientFor({ a: { id: 'x1', value: 'v' }, b: { id: 12, value: 'v' } });
    expect(client.entry('a').id).toBe('x1');
    expect(client.entry('b').id).toBe('12');
  });

  it('works for entries in a nested bundle with a namespace option', async () => {
    const release = buildRelease({
      bundles: { ns1: DEFAULT, c1: { type: 'custom', name: 'ui', layout: 'nested', namespaces: ['n'] } },
      slices: {
        ns1: { en: makeSlice('ns1', 'en', { x: leaf(1, 'x') }) },
        c1: { en: { schemaVersion: 1, bundle: 'c1', locale: 'en', namespaces: { n: { k: leaf(2, 'nested') } } } },
      },
    });
    const { client } = await startClient(release);
    expect(plainData(client.entry('k', { bundle: { type: 'custom', name: 'ui' }, namespace: 'n' })).value).toBe('nested');
  });
});

describe('hostile slice content', () => {
  const hostileLeaves = {
    nullLeaf: null,
    numberLeaf: 7,
    stringLeaf: 'text',
    arrayLeaf: ['a'],
    boolLeaf: true,
    numberValue: { id: '1', value: 5 },
    objectValue: { id: '2', value: { toString: 'x' } },
    arrayValue: { id: '3', value: ['a', 'b'] },
    nullValue: { id: '4', value: null },
    noValue: { id: '5' },
    objectId: { id: { a: 1 }, value: 'v' },
    nullId: { id: null, value: 'v' },
    hugeId: { id: '__HUGE__', value: 'huge' },
    longIdString: { id: '9'.repeat(500), value: 'long' },
    selfParent: { id: '10', value: 'self', plural_child_keys: [10], string_array_child_keys: [10] },
    cycleA: { id: '11', value: 'A', plural_child_keys: [12], string_array_child_keys: [12] },
    'cycleA.one': { id: '12', value: 'A one', plural_child_keys: [11], string_array_child_keys: [11] },
    badLists: { id: '13', value: 'lists', plural_child_keys: 'nope', string_array_child_keys: { 0: 1 } },
    weirdListEntries: {
      id: '14',
      value: 'weird',
      plural_child_keys: [null, {}, [], 1e308, '9'.repeat(400), true, -1, 1.5],
      string_array_child_keys: [null, {}, [], 1e308, '9'.repeat(400), true, -1, 1.5],
    },
    badAttributes: { id: '15', value: 'v', type: 7, class: { a: 1 }, attributes: { alt: { toString: 1 } } },
    badClass: { id: '16', value: 'v', class: 5, type: ['image'] },
  };
  const protoKeys = '"__proto__":{"id":"20","value":"proto"},"constructor":{"id":"21","value":"ctor"}';
  const raw = (inner) => `{"schemaVersion":1,"bundle":"ns1","locale":"en","keys":{${inner}}}`;
  const hostileRaw = raw(`${protoKeys},${Object.entries(hostileLeaves)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',')}`).replace('"__HUGE__"', '1e400');

  const argShapes = [undefined, null, 0, 'str', [], [1, 2], {}, { count: 3 }, { count: NaN }, { count: Infinity }, { count: -1 }, { count: 1e21 }, { count: 1.5 }, { name: 'x' }];

  it('never throws and always returns the right type, whatever a leaf looks like', async () => {
    const { client, TarjimReference } = await clientForRawSlice(hostileRaw);
    expect(TarjimReference.version).toBeTypeOf('string');
    const names = [...Object.keys(hostileLeaves), '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'missing', ''];
    for (const name of names) {
      for (const args of argShapes) {
        expect(client.t(name, args)).toBeTypeOf('string');
      }
      for (const options of [undefined, {}, { namespace: 'x' }, { bundle: { type: 'custom', name: 'nope' } }, { bundle: null }, { bundle: 5 }]) {
        expect(client.t(name, undefined, options)).toBeTypeOf('string');
        const list = plainData(client.tArray(name, options));
        expect(Array.isArray(list)).toBe(true);
        for (const item of list) expect(item).toBeTypeOf('string');
        const entry = plainData(client.entry(name, options));
        if (entry !== null) {
          expect(Object.keys(entry).sort()).toEqual(['attributes', 'className', 'id', 'type', 'value']);
          expect(entry.value).toBeTypeOf('string');
          expect(entry.id).toBeTypeOf('string');
        }
      }
    }
  });

  it('treats prototype property names as ordinary key names', async () => {
    const { client } = await clientForRawSlice(raw(protoKeys));
    expect(client.t('constructor')).toBe('ctor');
    for (const name of ['toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      expect(client.t(name)).toBe(name);
      expect(client.entry(name)).toBe(null);
      expect(plainData(client.tArray(name))).toEqual([]);
    }

    const bare = await clientFor({ plain: leaf(1, 'v') });
    expect(bare.client.t('constructor')).toBe('constructor');
    expect(bare.client.t('__proto__')).toBe('__proto__');
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"text"'],
    ['a number', '7'],
  ])('survives a keys map that is %s', async (_, keys) => {
    const text = `{"schemaVersion":1,"bundle":"ns1","locale":"en","keys":${keys}}`;
    const { client } = await clientForRawSlice(text);
    expect(client.t('app.title')).toBe('app.title');
    expect(plainData(client.tArray('app.title'))).toEqual([]);
    expect(client.entry('app.title')).toBe(null);
  });

  it.each([
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['not JSON', 'not json at all'],
    ['empty', ''],
    ['without keys', '{"schemaVersion":1}'],
  ])('survives a slice that is %s', async (_, text) => {
    const { client } = await clientForRawSlice(text);
    expect(client.t('app.title')).toBe('app.title');
    expect(plainData(client.tArray('app.title'))).toEqual([]);
    expect(client.entry('app.title')).toBe(null);
  });

  it('survives nested namespaces that are not objects', async () => {
    const release = buildRelease({
      bundles: { ns1: DEFAULT, c1: { type: 'custom', name: 'ui', layout: 'nested', namespaces: ['a', 'b', 'c'] } },
      slices: {
        ns1: { en: makeSlice('ns1', 'en', { x: leaf(1, 'x') }) },
        c1: { en: '{"schemaVersion":1,"bundle":"c1","locale":"en","namespaces":{"a":null,"b":[1],"c":"s","d":{"k":{"id":"1","value":"found"}}}}' },
      },
    });
    const { client } = await startClient(release);
    const ui = { bundle: { type: 'custom', name: 'ui' } };
    expect(client.t('k', undefined, ui)).toBe('found');
    expect(client.t('zzz', undefined, ui)).toBe('zzz');
  });
});

describe('text only', () => {
  it('returns markup in a value as the same plain string and never touches the document', async () => {
    const log = [];
    const markup = '<img src=x onerror="alert(1)"> & <b>bold</b>';
    const { client } = await clientFor(
      { html: leaf(1, markup), image: leaf(2, 'https://media.example.com/a.png', { type: 'image', attributes: { alt: markup } }) },
      { globals: { document: accessSpy('document', log) } },
    );
    expect(client.t('html')).toBe(markup);
    expect(client.entry('html').value).toBe(markup);
    expect(plainData(client.entry('image')).attributes).toEqual({ alt: markup });
    expect(log).toEqual([]);
  });

  it('always returns a string from t, even for odd keys and non-string values', async () => {
    const { client } = await clientFor({
      number: leaf(1, 5),
      list: leaf(2, ['a']),
      nothing: leaf(3, null),
      fine: leaf(4, 'fine'),
    });
    for (const key of ['number', 'list', 'nothing', 'fine', 'absent', undefined, null, 7, {}, []]) {
      expect(client.t(key)).toBeTypeOf('string');
    }
    expect(client.t('number')).toBe('number');
    expect(client.t('list')).toBe('list');
    expect(client.t('fine')).toBe('fine');
  });
});
