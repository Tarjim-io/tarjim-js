import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requestsOfKind, serveRecording } from '../helpers/fake-delivery.js';
import { plainData, startClient } from '../helpers/harness.js';

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/recorded');
const release1 = () => serveRecording(path.join(RECORDED, 'release-1'));

describe('against the recorded release', () => {
  it('is active in English and answers lookups', async () => {
    const { client, reports } = await startClient(release1());
    expect(client.active).toBe(true);
    expect(client.language).toBe('en');
    expect(client.t('app.title')).toBe('Tarjim');
    expect(client.t('cart.items', { count: 3 })).toBe('3 items');
    expect(client.t('cart.items', { count: 0 })).toBe('No items');
    expect(client.t('cart.items', { count: 1 })).toBe('One item');
    expect(plainData(client.tArray('menu'))).toEqual(['Home', 'About', 'Contact']);
    expect(client.entry('hero.image').type).toBe('image');
    expect(plainData(client.entry('hero.image'))).toEqual({
      value: 'https://media.example.com/hero.png',
      id: '4449',
      type: 'image',
      attributes: null,
      className: null,
    });
    expect(client.t('empty.value')).toBe('empty.value');
    expect(client.entry('empty.value')).toBe(null);
    expect(client.t('Case.Sensitive')).toBe('Upper case key');
    expect(client.t('case.sensitive')).toBe('case.sensitive');
    expect(reports).toEqual([]);
  });

  it('formats the recorded greetings', async () => {
    const { client } = await startClient(release1(), { config: { legacyPercentPlaceholders: true } });
    expect(client.t('greeting.named', { name: 'Ana' })).toBe('Welcome, Ana!');
    expect(client.t('greeting.printf', ['Ana', 5])).toBe('Ana has 5 messages');
    expect(client.t('greeting.legacy', { name: 'Ana' })).toBe('Hello Ana');
  });

  it('fetches the three recorded objects only for the selected locale', async () => {
    const served = release1();
    await startClient(served);
    expect(requestsOfKind(served, 'object')).toHaveLength(1);
    expect(requestsOfKind(served, 'meta')).toHaveLength(1);
    expect(requestsOfKind(served, 'manifest')).toHaveLength(1);
  });

  it('selects Arabic: missing keys fall to their names and plurals follow Arabic rules', async () => {
    const { client } = await startClient(release1(), { config: { language: 'ar' } });
    expect(client.language).toBe('ar');
    expect(client.t('app.title')).toBe('ترجم');
    expect(client.t('only.english')).toBe('only.english');
    expect(client.t('cart.items', { count: 3 })).toBe('3 عناصر');
    expect(client.t('cart.items', { count: 11 })).toBe('11 عنصرًا');
    expect(client.t('cart.items', { count: 0 })).toBe('لا عناصر');
  });

  it('selects French, whose slice lacks most keys, without borrowing from English', async () => {
    const { client } = await startClient(release1(), { config: { language: 'fr' } });
    expect(client.language).toBe('fr');
    expect(client.active).toBe(true);
    expect(client.t('app.title')).toBe('app.title');
  });

  it('is inactive with an unbound-key report against the unbound recording', async () => {
    const served = serveRecording(path.join(RECORDED, 'unbound-latest'));
    const { client, codes } = await startClient(served);
    expect(client.active).toBe(false);
    expect(codes()).toEqual(['unbound-key']);
    expect(requestsOfKind(served, 'manifest')).toHaveLength(0);
  });
});
