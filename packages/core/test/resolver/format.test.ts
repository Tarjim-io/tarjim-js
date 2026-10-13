import { describe, expect, it } from 'vitest';
import { format } from '../../src/internal.js';
import { leaf, pluralKeys, snapshotWith } from './world.js';

describe('named placeholders', () => {
  it('replaces {name} with an own property of an object and leaves unknown names as authored', () => {
    expect(format('Welcome, {name}! Your {thing} and {toString} and {constructor}.', { name: 'Ana' })).toBe(
      'Welcome, Ana! Your {thing} and {toString} and {constructor}.',
    );
    expect(format('n={n}', { n: 0 })).toBe('n=0');
  });

  it('writes values the way String would', () => {
    expect(format('{a} {b} {c}', { a: null, b: true, c: 1e21 })).toBe('null true 1e+21');
  });

  it('inserts arguments literally and never re-reads what it inserted', () => {
    expect(format('Hi {name} and {x}', { name: '{x}', x: 'no' })).toBe('Hi {x} and no');
    expect(format('Cost {price}!', { price: "$& $1 $` $' $$" })).toBe("Cost $& $1 $` $' $$!");
  });

  it('does not treat {name} specially for array arguments', () => {
    expect(format('{name} %s', ['a'])).toBe('{name} a');
  });
});

describe('printf placeholders with array arguments', () => {
  it('takes arguments in order for %s, %d and %@', () => {
    expect(format('%s has %d items, %@ ok', ['Ana', 5, 'yes'])).toBe('Ana has 5 items, yes ok');
  });

  it('numbers arguments from 1 for %n$ placeholders, in any order and reusable', () => {
    expect(format('%2$d of %1$s, again %1$@', ['Ana', 7])).toBe('7 of Ana, again Ana');
    expect(format('%2$s then %1$s', ['a', 'b'])).toBe('b then a');
  });

  it('turns %% into % and leaves a placeholder with no argument as authored', () => {
    expect(format('100%% sure, %s', ['Ana'])).toBe('100% sure, Ana');
    expect(format('%s and %s and %d', ['one'])).toBe('one and %s and %d');
    expect(format('%1$s %3$s %0$s', ['a'])).toBe('a %3$s %0$s');
    expect(format('a %% b', [])).toBe('a % b');
  });

  it('inserts arguments literally: nothing inside an argument is interpreted', () => {
    expect(format('x %s y %s', ['$&', '$1'])).toBe('x $& y $1');
    expect(format('[%s]', ['%s'])).toBe('[%s]');
    expect(format('x %s y %s', ['%s', 'b'])).toBe('x %s y b');
    expect(format('%s {x}', ['{x}'])).toBe('{x} {x}');
    expect(format('%1$s %%', ['%%'])).toBe('%% %');
    expect(format('%s then %s', ['100%', 'a'])).toBe('100% then a');
  });
});

describe('percent signs with object arguments', () => {
  it('are left alone outside a plural value', () => {
    expect(format('100%% sure, %s %d', { a: 1 })).toBe('100%% sure, %s %d');
  });
});

describe('legacy %%name%% placeholders', () => {
  it('are replaced from object arguments only when the flag is on', () => {
    expect(format('Hello %%name%%', { name: 'Ana' }, { legacyPercentPlaceholders: true })).toBe('Hello Ana');
    expect(format('%%a%% and {a}', { a: 'X' }, { legacyPercentPlaceholders: true })).toBe('X and X');
    expect(format('Hello %%name%%', { name: 'Ana' })).toBe('Hello %%name%%');
    expect(format('%%a%% and {a}', { a: 'X' }, { legacyPercentPlaceholders: false })).toBe('%%a%% and X');
  });

  it('are left as authored when the object has no such own property', () => {
    expect(format('Hello %%name%% %%toString%%', { other: 'x' }, { legacyPercentPlaceholders: true })).toBe(
      'Hello %%name%% %%toString%%',
    );
  });

  it('render as printf would with array arguments, whatever the flag', () => {
    for (const legacyPercentPlaceholders of [false, true]) {
      expect(format('a %%x%% b %s', ['v'], { legacyPercentPlaceholders })).toBe('a %x% b v');
      expect(format('a %%x%% b %s', [], { legacyPercentPlaceholders })).toBe('a %x% b %s');
    }
  });
});

describe('the plural rule', () => {
  const forms = '%d / %s / %@ / %1$d / %2$d / 100%% / {count} / {who}';

  it('lets every printf placeholder take the count and {name} read the object', () => {
    expect(format(forms, { count: 3, who: 'Ana' }, { plural: true, count: 3 })).toBe(
      '3 / 3 / 3 / 3 / %2$d / 100% / 3 / Ana',
    );
  });

  it('writes the count as String would and does not re-read it', () => {
    expect(format(forms, { count: 1e21 }, { plural: true, count: 1e21 })).toBe(
      '1e+21 / 1e+21 / 1e+21 / 1e+21 / %2$d / 100% / 1e+21 / {who}',
    );
  });

  it('does not apply to a text formatted outside the plural path', () => {
    expect(format('plain %d {count}', { count: 3 })).toBe('plain %d 3');
    expect(format('plain %d {count}', { count: 3 }, { plural: false, count: 3 })).toBe('plain %d 3');
  });
});

describe('arguments that cannot be turned into text', () => {
  const noPrototype = Object.create(null);
  const throwing = {
    toString() {
      throw new Error('no text');
    },
  };

  it('leaves the placeholder as authored for a named argument, and fills the others', () => {
    expect(format('a {x} b {y}', { x: noPrototype, y: 'ok' })).toBe('a {x} b ok');
    expect(format('{x}', { x: throwing })).toBe('{x}');
  });

  it('leaves the placeholder as authored for a printf argument, and still counts its position', () => {
    expect(format('a %s b %s', [throwing, 'ok'])).toBe('a %s b ok');
    expect(format('%2$s %1$d %1$s', [noPrototype, 'ok'])).toBe('ok %1$d %1$s');
  });

  it('does the same inside a plural value and for a legacy placeholder', () => {
    expect(format('%d items', { count: throwing }, { plural: true, count: throwing as never })).toBe('%d items');
    expect(format('%%x%% and {x}', { x: throwing }, { legacyPercentPlaceholders: true })).toBe('%%x%% and {x}');
  });

  it('gives back the formatted value from a lookup, with that placeholder as authored', () => {
    const snapshot = snapshotWith({ k: leaf(1, 'Hi {name}, {other}') });
    expect(snapshot.t('k', { name: throwing, other: 'there' })).toBe('Hi {name}, there');
  });
});

describe('arguments that fail on any access', () => {
  const trap = (message: string) => () => {
    throw new Error(message);
  };
  const hostile = new Proxy({}, { get: trap('get'), has: trap('has'), ownKeys: trap('ownKeys'), getOwnPropertyDescriptor: trap('descriptor') });

  it('never throws and gives back the text as authored', () => {
    expect(format('Hi {name} %s', hostile as never)).toBe('Hi {name} %s');
    expect(format(undefined as never, { name: 'x' })).toBe('');
  });
});

describe('hostile text', () => {
  it('scans a very long run of braces and percent signs in linear time', () => {
    const started = Date.now();
    format('{'.repeat(200_000), { a: 1 });
    format('%'.repeat(200_000), ['x']);
    format('{a'.repeat(100_000), { a: 1 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('formatting through a lookup', () => {
  const templates = {
    raw: leaf(1, 'Hi {name}, %s and %1$d, 100%%, %%name%%'),
    greet: leaf(2, 'Hi {name}'),
    legacy: leaf(3, 'Hello %%name%%'),
    other: leaf(4, 'x'),
    ...pluralKeys('items', 10, { one: 'one: %d', other: '%d / {count} / {who}' }),
    plain: leaf(30, 'plain %d {count}'),
    ...pluralKeys('parentOnly', 40, { one: '', other: '' }, 'parent {count}'),
  };

  it('returns the value verbatim when no arguments are given', () => {
    const snapshot = snapshotWith(templates);
    const verbatim = 'Hi {name}, %s and %1$d, 100%%, %%name%%';
    expect(snapshot.t('raw')).toBe(verbatim);
    expect(snapshot.t('raw', undefined)).toBe(verbatim);
    expect(snapshot.t('raw', undefined, { bundle: { type: 'namespace', name: 'default' } })).toBe(verbatim);
  });

  it('formats once arguments are given', () => {
    const snapshot = snapshotWith(templates);
    expect(snapshot.t('raw', ['x'])).not.toBe('Hi {name}, %s and %1$d, 100%%, %%name%%');
    expect(snapshot.t('greet', { name: 'Ana' })).toBe('Hi Ana');
  });

  it('never formats the key name returned for a missing key', () => {
    const snapshot = snapshotWith(templates);
    expect(snapshot.t('Hello {name} %s %%', { name: 'Ana' })).toBe('Hello {name} %s %%');
    expect(snapshot.t('Hello {name} %s %%', ['Ana'])).toBe('Hello {name} %s %%');
    expect(snapshot.t('other', { name: 'Ana' })).toBe('x');
  });

  it('replaces %%name%% only when the snapshot is built with the legacy flag', () => {
    const on = snapshotWith(templates, { legacyPercentPlaceholders: true });
    const off = snapshotWith(templates);
    expect(on.t('legacy', { name: 'Ana' })).toBe('Hello Ana');
    expect(off.t('legacy', { name: 'Ana' })).toBe('Hello %%name%%');
  });

  it('lets a plural value take the count for printf placeholders', () => {
    const snapshot = snapshotWith(templates);
    expect(snapshot.t('items', { count: 1 })).toBe('one: 1');
    expect(snapshot.t('items', { count: 3, who: 'Ana' })).toBe('3 / 3 / Ana');
  });

  it('does not give a key that is not plural the count for %d', () => {
    expect(snapshotWith(templates).t('plain', { count: 3 })).toBe('plain %d 3');
  });

  it("formats the parent's own value when no child is usable", () => {
    expect(snapshotWith(templates).t('parentOnly', { count: 4 })).toBe('parent 4');
  });

  it('uses the formatted parent value when the arguments are an array on a plural key', () => {
    const snapshot = snapshotWith({ ...pluralKeys('n', 10, { one: 'o', other: '%d' }, 'parent %s') });
    expect(snapshot.t('n', ['a'])).toBe('parent a');
  });
});
