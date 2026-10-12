import { describe, expect, it } from 'vitest';
import { buildRelease, leaf, makeSlice, pluralKeys, requestsOfKind } from '../helpers/fake-delivery.js';
import { startClient } from '../helpers/harness.js';

const DEFAULT = { type: 'namespace', name: 'default' };

function objectNamesRequested(release) {
  return requestsOfKind(release, 'object').map(({ url }) => url.split('?')[0].split('/').pop());
}

function titlesRelease(titles) {
  const slices = {};
  for (const [locale, title] of Object.entries(titles)) {
    slices[locale] = makeSlice('ns1', locale, { 'app.title': leaf(1, title) });
  }
  return buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: slices } });
}

describe('choosing the locale', () => {
  it('matches the requested language case-insensitively against the manifest keys', async () => {
    const release = titlesRelease({ en: 'Tarjim', ar: 'ترجم' });
    const { client } = await startClient(release, { config: { language: 'AR' } });
    expect(client.language).toBe('ar');
    expect(client.t('app.title')).toBe('ترجم');
    expect(objectNamesRequested(release)).toEqual([release.objectName('ns1', 'ar')]);
  });

  it('answers with the locale key exactly as the manifest spells it', async () => {
    const regional = titlesRelease({ en: 'Tarjim', 'pt-BR': 'Tradutor' });
    const first = await startClient(regional, { config: { language: 'pt-br' } });
    expect(first.client.language).toBe('pt-BR');
    expect(first.client.t('app.title')).toBe('Tradutor');

    const lowerCased = titlesRelease({ en: 'Tarjim', 'en-us': 'Tarjim US' });
    const second = await startClient(lowerCased, { config: { language: 'en-US' } });
    expect(second.client.language).toBe('en-us');
    expect(second.client.t('app.title')).toBe('Tarjim US');
  });

  it('falls to the fallback language as a whole when the language is not in the manifest', async () => {
    const release = titlesRelease({ en: 'Tarjim', ar: 'ترجم' });
    const { client, codes } = await startClient(release, { config: { language: 'de', fallbackLanguage: 'en' } });
    expect(client.language).toBe('en');
    expect(client.t('app.title')).toBe('Tarjim');
    expect(objectNamesRequested(release)).toEqual([release.objectName('ns1', 'en')]);
    expect(codes()).toEqual([]);
  });

  it('matches exactly: a region variant is not reduced to its base language', async () => {
    const release = titlesRelease({ en: 'Tarjim', ar: 'ترجم' });
    const { client } = await startClient(release, { config: { language: 'en-GB', fallbackLanguage: 'ar' } });
    expect(client.language).toBe('ar');
    expect(objectNamesRequested(release)).toEqual([release.objectName('ns1', 'ar')]);
  });

  it('defaults the language to the fallback language', async () => {
    const release = titlesRelease({ en: 'Tarjim', ar: 'ترجم' });
    const { client } = await startClient(release, { config: { language: undefined, fallbackLanguage: 'ar' } });
    expect(client.language).toBe('ar');
    expect(client.t('app.title')).toBe('ترجم');
  });

  it('asks for exactly one object per bundle, and only ones the manifest lists', async () => {
    const release = titlesRelease({ en: 'Tarjim', ar: 'ترجم', fr: 'Tarjim fr' });
    await startClient(release, { config: { language: 'fr' } });
    const listed = new Set(
      Object.values(release.manifest.slices.ns1).map((entry) => `${entry.json.hash}.json`),
    );
    const requested = objectNamesRequested(release);
    expect(requested).toEqual([release.objectName('ns1', 'fr')]);
    for (const name of requested) expect(listed.has(name)).toBe(true);
  });

  it('unions the locale keys over every bundle of the manifest', async () => {
    const release = buildRelease({
      bundles: { ns1: DEFAULT, ns2: { type: 'custom', name: 'extras' } },
      slices: {
        ns1: { en: makeSlice('ns1', 'en', { 'app.title': leaf(1, 'Tarjim') }) },
        ns2: {
          en: makeSlice('ns2', 'en', { x: leaf(2, 'Extra') }),
          ar: makeSlice('ns2', 'ar', { x: leaf(2, 'إضافي') }),
        },
      },
    });
    const { client } = await startClient(release, { config: { language: 'ar' } });
    expect(client.language).toBe('ar');
    expect(client.t('x', undefined, { bundle: { type: 'custom', name: 'extras' } })).toBe('إضافي');
    expect(client.t('app.title')).toBe('app.title');
    expect(objectNamesRequested(release)).toEqual([release.objectName('ns2', 'ar')]);
  });
});

describe('one locale only', () => {
  it('returns the key name for a key the selected locale lacks, even when the fallback has it', async () => {
    const slices = {
      en: makeSlice('ns1', 'en', { 'only.english': leaf(1, 'English only'), shared: leaf(2, 'Shared') }),
      ar: makeSlice('ns1', 'ar', { shared: leaf(2, 'مشترك') }),
    };
    const release = buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: slices } });
    const arabic = await startClient(release, { config: { language: 'ar', fallbackLanguage: 'en' } });
    expect(arabic.client.t('only.english')).toBe('only.english');
    expect(arabic.client.t('shared')).toBe('مشترك');
    expect(arabic.client.entry('only.english')).toBe(null);
    expect(objectNamesRequested(release)).toEqual([release.objectName('ns1', 'ar')]);

    const english = await startClient(buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: slices } }));
    expect(english.client.t('only.english')).toBe('English only');
  });

  it('treats a bundle that lacks the selected locale as having no keys, not as English', async () => {
    const release = buildRelease({
      bundles: { ns1: DEFAULT, ns2: { type: 'custom', name: 'extras' } },
      slices: {
        ns1: { en: makeSlice('ns1', 'en', { a: leaf(1, 'A') }), ar: makeSlice('ns1', 'ar', { a: leaf(1, 'ا') }) },
        ns2: { en: makeSlice('ns2', 'en', { b: leaf(2, 'B') }) },
      },
    });
    const { client } = await startClient(release, { config: { language: 'ar' } });
    expect(client.t('a')).toBe('ا');
    expect(client.t('b', undefined, { bundle: { type: 'custom', name: 'extras' } })).toBe('b');
  });
});

describe('plural forms follow the selected locale', () => {
  const forms = { zero: 'Z0', one: 'O1', two: 'T2', few: 'F3', many: 'M4', other: 'X5' };
  const withoutZero = { one: 'O1', other: 'X5' };

  const keys = {
    ...pluralKeys('cart.items', 10, forms),
    ...pluralKeys('cart.plain', 20, withoutZero),
    ...pluralKeys('cart.noFew', 30, withoutZero),
  };
  const make = () => {
    const slices = {};
    for (const locale of ['en', 'ar', 'fr']) slices[locale] = makeSlice('ns1', locale, keys);
    return buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: slices } });
  };

  it('uses the Arabic rules for 3 when ar is selected, and the English rules when en is', async () => {
    const arabic = await startClient(make(), { config: { language: 'ar' } });
    expect(arabic.client.t('cart.items', { count: 3 })).toBe('F3');
    expect(arabic.client.t('cart.items', { count: 11 })).toBe('M4');
    expect(arabic.client.t('cart.items', { count: 2 })).toBe('T2');
    expect(arabic.client.t('cart.items', { count: 1 })).toBe('O1');
    expect(arabic.client.t('cart.items', { count: 100 })).toBe('X5');
    expect(arabic.client.t('cart.noFew', { count: 3 })).toBe('X5');

    const english = await startClient(make(), { config: { language: 'en' } });
    expect(english.client.t('cart.items', { count: 3 })).toBe('X5');
    expect(english.client.t('cart.items', { count: 1 })).toBe('O1');
  });

  it('uses the zero child for count 0 in every language that has one, and the language rule otherwise', async () => {
    for (const language of ['en', 'ar', 'fr']) {
      const { client } = await startClient(make(), { config: { language } });
      expect(client.t('cart.items', { count: 0 })).toBe('Z0');
    }
    const english = await startClient(make(), { config: { language: 'en' } });
    expect(english.client.t('cart.plain', { count: 0 })).toBe('X5');
    const french = await startClient(make(), { config: { language: 'fr' } });
    expect(french.client.t('cart.plain', { count: 0 })).toBe('O1');
    expect(french.client.t('cart.plain', { count: 1.5 })).toBe('O1');
  });
});

describe('bundle lookup', () => {
  it('lets the lowest numeric bundle id win when two share type and name', async () => {
    const release = buildRelease({
      bundles: { ns10: DEFAULT, ns7: DEFAULT, ns9: DEFAULT },
      slices: {
        ns10: { en: makeSlice('ns10', 'en', { k: leaf(1, 'from ten'), only10: leaf(3, 'ten') }) },
        ns7: { en: makeSlice('ns7', 'en', { k: leaf(2, 'from seven') }) },
        ns9: { en: makeSlice('ns9', 'en', { k: leaf(4, 'from nine') }) },
      },
    });
    const { client } = await startClient(release);
    expect(client.t('k')).toBe('from seven');
    expect(client.t('only10')).toBe('only10');
  });

  it('matches type as well as name, so a custom bundle never answers a namespace lookup', async () => {
    const release = buildRelease({
      bundles: { ns1: DEFAULT, c1: { type: 'custom', name: 'default' } },
      slices: {
        ns1: { en: makeSlice('ns1', 'en', { 'in.namespace': leaf(1, 'namespace value') }) },
        c1: { en: makeSlice('c1', 'en', { 'in.custom': leaf(2, 'custom value') }) },
      },
    });
    const { client } = await startClient(release);
    expect(client.t('in.custom')).toBe('in.custom');
    expect(client.t('in.custom', undefined, { bundle: { type: 'custom', name: 'default' } })).toBe('custom value');
    expect(client.t('in.namespace', undefined, { bundle: { type: 'custom', name: 'default' } })).toBe('in.namespace');
    expect(client.t('in.namespace')).toBe('namespace value');
    expect(client.t('in.namespace', undefined, { bundle: { type: 'namespace', name: 'nothing' } })).toBe('in.namespace');
  });

  it('searches nested namespaces in the manifest order, not the slice key order', async () => {
    const release = buildRelease({
      bundles: {
        ns1: DEFAULT,
        c1: { type: 'custom', name: 'ui', layout: 'nested', namespaces: ['b', 'a'] },
      },
      slices: {
        ns1: { en: makeSlice('ns1', 'en', { x: leaf(1, 'x') }) },
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
    });
    const { client } = await startClient(release);
    const ui = { bundle: { type: 'custom', name: 'ui' } };

    expect(client.t('k', undefined, ui)).toBe('from b');
    expect(client.t('k', undefined, { ...ui, namespace: 'a' })).toBe('from a');
    expect(client.t('k', undefined, { ...ui, namespace: 'm' })).toBe('k');
    expect(client.t('dup', undefined, ui)).toBe('from m');
    expect(client.t('onlyZz', undefined, ui)).toBe('zz only');
    expect(client.t('dup', undefined, { ...ui, namespace: 'zz' })).toBe('from zz');
    expect(client.t('dup', undefined, { ...ui, namespace: 'nowhere' })).toBe('dup');
  });
});
