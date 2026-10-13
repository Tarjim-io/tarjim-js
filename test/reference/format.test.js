import { describe, expect, it } from 'vitest';
import { buildRelease, leaf, makeSlice, pluralKeys } from '../helpers/fake-delivery.js';
import { startClient } from '../helpers/harness.js';

const DEFAULT = { type: 'namespace', name: 'default' };

// Each test names the template it formats, so the keys are the templates themselves.
async function clientWith(templates, options) {
  const keys = {};
  Object.entries(templates).forEach(([key, value], index) => {
    keys[key] = leaf(index + 1, value);
  });
  const release = buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: { en: makeSlice('ns1', 'en', keys) } } });
  return startClient(release, options);
}

describe('named placeholders', () => {
  it('replaces {name} with an own property of object arguments and leaves unknown names as authored', async () => {
    const { client } = await clientWith({
      greet: 'Welcome, {name}! Your {thing} and {toString} and {constructor}.',
      zero: 'n={n}',
    });
    expect(client.t('greet', { name: 'Ana' })).toBe('Welcome, Ana! Your {thing} and {toString} and {constructor}.');
    expect(client.t('zero', { n: 0 })).toBe('n=0');
  });

  it('inserts arguments literally, never re-reading what it inserted', async () => {
    const { client } = await clientWith({ greet: 'Hi {name} and {x}', dollars: 'Cost {price}!' });
    expect(client.t('greet', { name: '{x}', x: 'no' })).toBe('Hi {x} and no');
    expect(client.t('dollars', { price: "$& $1 $` $' $$" })).toBe("Cost $& $1 $` $' $$!");
  });
});

describe('printf placeholders with array arguments', () => {
  it('takes arguments in order for %s, %d and %@', async () => {
    const { client } = await clientWith({ order: '%s has %d items, %@ ok' });
    expect(client.t('order', ['Ana', 5, 'yes'])).toBe('Ana has 5 items, yes ok');
  });

  it('numbers arguments from 1 for %n$ placeholders, in any order and reusable', async () => {
    const { client } = await clientWith({
      numbered: '%2$d of %1$s, again %1$@',
      mixed: '%2$s then %1$s',
    });
    expect(client.t('numbered', ['Ana', 7])).toBe('7 of Ana, again Ana');
    expect(client.t('mixed', ['a', 'b'])).toBe('b then a');
  });

  it('turns %% into % and leaves a placeholder with no argument as authored', async () => {
    const { client } = await clientWith({
      percent: '100%% sure, %s',
      short: '%s and %s and %d',
      numberedShort: '%1$s %3$s %0$s',
    });
    expect(client.t('percent', ['Ana'])).toBe('100% sure, Ana');
    expect(client.t('short', ['one'])).toBe('one and %s and %d');
    expect(client.t('numberedShort', ['a'])).toBe('a %3$s %0$s');
  });

  it('inserts arguments literally: nothing inside an argument is interpreted', async () => {
    const { client } = await clientWith({ two: 'x %s y %s', one: '[%s]', brace: '%s {x}', pct: '%1$s %%' });
    expect(client.t('two', ['$&', '$1'])).toBe('x $& y $1');
    expect(client.t('one', ['%s'])).toBe('[%s]');
    expect(client.t('two', ['%s', 'b'])).toBe('x %s y b');
    expect(client.t('brace', ['{x}'])).toBe('{x} {x}');
    expect(client.t('pct', ['%%'])).toBe('%% %');
  });

  it('does not treat {name} specially for array arguments', async () => {
    const { client } = await clientWith({ braces: '{name} %s' });
    expect(client.t('braces', ['a'])).toBe('{name} a');
  });
});

describe('no formatting without arguments', () => {
  it('returns the value verbatim when args is undefined, even if it looks like a template', async () => {
    const { client } = await clientWith({ raw: 'Hi {name}, %s and %1$d, 100%%, %%name%%' });
    expect(client.t('raw')).toBe('Hi {name}, %s and %1$d, 100%%, %%name%%');
    expect(client.t('raw', undefined)).toBe('Hi {name}, %s and %1$d, 100%%, %%name%%');
    expect(client.t('raw', undefined, { bundle: DEFAULT })).toBe('Hi {name}, %s and %1$d, 100%%, %%name%%');
    expect(client.t('raw', ['x'])).not.toBe('Hi {name}, %s and %1$d, 100%%, %%name%%');
  });

  it('never formats the key name returned for a missing key', async () => {
    const { client } = await clientWith({ other: 'x' });
    expect(client.t('Hello {name} %s %%', { name: 'Ana' })).toBe('Hello {name} %s %%');
    expect(client.t('Hello {name} %s %%', ['Ana'])).toBe('Hello {name} %s %%');
    expect(client.t('other', { name: 'Ana' })).toBe('x');
  });
});

describe('legacy %%name%% placeholders', () => {
  const templates = { legacy: 'Hello %%name%%', both: '%%a%% and {a}' };

  it('are replaced from object arguments only when the flag is on', async () => {
    const on = await clientWith(templates, { config: { legacyPercentPlaceholders: true } });
    expect(on.client.t('legacy', { name: 'Ana' })).toBe('Hello Ana');
    expect(on.client.t('both', { a: 'X' })).toBe('X and X');

    const off = await clientWith(templates);
    expect(off.client.t('legacy', { name: 'Ana' })).toBe('Hello %%name%%');
    expect(off.client.t('both', { a: 'X' })).toBe('%%a%% and X');
  });

  it('are left as authored when the object has no such own property', async () => {
    const { client } = await clientWith({ legacy: 'Hello %%name%% %%toString%%' }, { config: { legacyPercentPlaceholders: true } });
    expect(client.t('legacy', { other: 'x' })).toBe('Hello %%name%% %%toString%%');
  });

  it('render as printf would with array arguments, whatever the flag', async () => {
    for (const legacyPercentPlaceholders of [false, true]) {
      const { client } = await clientWith({ legacy: 'a %%x%% b %s' }, { config: { legacyPercentPlaceholders } });
      expect(client.t('legacy', ['v'])).toBe('a %x% b v');
      expect(client.t('legacy', [])).toBe('a %x% b %s');
    }
  });
});

describe('plural values with object arguments', () => {
  const forms = {
    one: 'one: %d',
    other: '%d / %s / %@ / %1$d / %2$d / 100%% / {count} / {who}',
  };

  async function pluralClient() {
    const keys = { ...pluralKeys('items', 10, forms), plain: leaf(30, 'plain %d {count}') };
    const release = buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: { en: makeSlice('ns1', 'en', keys) } } });
    return startClient(release);
  }

  it('lets printf placeholders take the count and {name} read the object', async () => {
    const { client } = await pluralClient();
    expect(client.t('items', { count: 1 })).toBe('one: 1');
    expect(client.t('items', { count: 3, who: 'Ana' })).toBe('3 / 3 / 3 / 3 / %2$d / 100% / 3 / Ana');
  });

  it('formats the count as String would and does not re-read it', async () => {
    const { client } = await pluralClient();
    expect(client.t('items', { count: 1e21 })).toBe('1e+21 / 1e+21 / 1e+21 / 1e+21 / %2$d / 100% / 1e+21 / {who}');
  });

  it("applies the same rule to the parent's own value when no child is usable", async () => {
    const keys = pluralKeys('items', 10, { one: '', other: '' }, 'parent %d of {count}');
    const release = buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: { en: makeSlice('ns1', 'en', keys) } } });
    const { client } = await startClient(release);
    expect(client.t('items', { count: 4 })).toBe('parent 4 of 4');
  });

  it('does not apply the plural printf rule to a key that is not plural', async () => {
    const { client } = await pluralClient();
    expect(client.t('plain', { count: 3 })).toBe('plain %d 3');
  });
});
