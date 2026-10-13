import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSnapshot, decodeManifest, matchLocale, selectLocale, slotName } from '../../src/internal.js';
import type { Snapshot } from '../../src/internal.js';
import { FIXTURES } from '../support.js';
import { DEFAULT } from './world.js';
import { makeInstall } from '../helpers/store-contract.js';

const RELEASE = `${FIXTURES}recorded/release-1/`;
const manifest = decodeManifest(JSON.parse(readFileSync(`${RELEASE}manifest.json`, 'utf8')));
if (manifest === null) throw new Error('the recorded manifest does not decode');

const slices = new Map<string, Uint8Array>();
const slots: Record<string, string> = {};
for (const [bundleId, byLocale] of Object.entries(manifest.slices)) {
  for (const [locale, file] of Object.entries(byLocale)) {
    slots[slotName(bundleId, locale)] = file.hash;
    slices.set(file.hash, new Uint8Array(readFileSync(`${RELEASE}objects/${file.hash}.json`)));
  }
}
const install = makeInstall(slots, { manifest });
const locales = [...new Set(Object.values(manifest.slices).flatMap((byLocale) => Object.keys(byLocale)))];

const snapshotFor = (locale: string, legacy = false): Snapshot =>
  createSnapshot({ install, slices, embedded: [], locale, defaultBundle: DEFAULT, legacyPercentPlaceholders: legacy });

describe('a recorded release, from bytes to answers', () => {
  it('answers the English lookups', () => {
    const en = snapshotFor('en');
    expect(en.language).toBe('en');
    expect(en.t('app.title')).toBe('Tarjim');
    expect(en.t('Case.Sensitive')).toBe('Upper case key');
    expect(en.t('case.sensitive')).toBe('case.sensitive');
    expect(en.t('empty.value')).toBe('empty.value');
    expect(en.t('app.missing')).toBe('app.missing');
    expect(en.tArray('menu')).toEqual(['Home', 'About', 'Contact']);
  });

  it('formats named, printf and legacy placeholders', () => {
    const off = snapshotFor('en');
    const on = snapshotFor('en', true);
    expect(off.t('greeting.named', { name: 'Ana' })).toBe('Welcome, Ana!');
    expect(off.t('greeting.printf', ['Ana', 5])).toBe('Ana has 5 messages');
    expect(off.t('greeting.legacy', { name: 'Ana' })).toBe('Hello %%name%%');
    expect(on.t('greeting.legacy', { name: 'Ana' })).toBe('Hello Ana');
    expect(off.t('greeting.named')).toBe('Welcome, {name}!');
  });

  it('chooses English plural forms', () => {
    const en = snapshotFor('en');
    expect(en.t('cart.items', { count: 0 })).toBe('No items');
    expect(en.t('cart.items', { count: 1 })).toBe('One item');
    expect(en.t('cart.items', { count: 5 })).toBe('5 items');
    expect(en.t('cart.items')).toBe('cart.items');
  });

  it('chooses Arabic plural forms by the text locale', () => {
    const ar = snapshotFor('ar');
    expect(ar.t('app.title')).toBe('ترجم');
    expect(ar.t('cart.items', { count: 0 })).toBe('لا عناصر');
    expect(ar.t('cart.items', { count: 1 })).toBe('عنصر واحد');
    expect(ar.t('cart.items', { count: 2 })).toBe('عنصران');
    expect(ar.t('cart.items', { count: 3 })).toBe('3 عناصر');
    expect(ar.t('cart.items', { count: 11 })).toBe('11 عنصرًا');
    expect(ar.t('cart.items', { count: 100 })).toBe('100 عنصر');
    expect(ar.tArray('menu')).toEqual(['الرئيسية', 'من نحن', 'اتصل بنا']);
  });

  it('returns an entry without the server-side fields', () => {
    expect(snapshotFor('en').entry('hero.image')).toEqual({
      value: 'https://media.example.com/hero.png',
      id: '4449',
      type: 'image',
      attributes: null,
      className: null,
    });
    expect(snapshotFor('ar').entry('hero.image')?.value).toBe('https://media.example.com/hero-ar.png');
  });

  it('serves only the locale it was given, keeping a key another locale has out of reach', () => {
    expect(snapshotFor('en').t('only.english')).toBe('English only');
    expect(snapshotFor('ar').t('only.english')).toBe('only.english');
    expect(snapshotFor('fr').t('app.title')).toBe('app.title');
    expect(snapshotFor('fr').tArray('menu')).toEqual([]);
  });

  it('is reached from a browser language through the locale choice', () => {
    expect(locales.sort()).toEqual(['ar', 'en', 'fr']);
    const choice = selectLocale({ browser: ['de-DE', 'ar-EG'], fallback: 'en', universe: locales });
    expect(choice).toEqual({ locale: 'ar', source: 'browser' });
    expect(matchLocale('FR-ca', locales)).toBe('fr');
    expect(snapshotFor(choice.locale).t('app.title')).toBe('ترجم');
  });
});
