import { afterEach, describe, expect, it } from 'vitest';
import { TarjimLanguageError } from '../../src/index.js';
import type { Tarjim } from '../../src/index.js';
import { hashOf } from '../helpers/cycle-world.js';
import { problem, queryOf } from '../support.js';
import { embedded, makeWorld, settle, stillPending, until, within } from './world.js';

let world = makeWorld();
afterEach(() => world.stopAll());

const THREE = { release: { locales: ['en', 'fr', 'de'] } };

describe('choosing the language at start', () => {
  it('takes the language the page asked for, even before any release is held', async () => {
    world = makeWorld();
    const runtime = await world.start({ language: 'de' });
    expect(runtime.language).toBe('de');
  });

  it('downloads text for that language and sends it with the check', async () => {
    world = makeWorld(THREE);
    const runtime = await world.start({ language: 'de' });
    await until(() => runtime.t('a') === 'v1 b1 de', 'the German text');
    expect(queryOf(world.server.requests('meta')[0]!.url)['language']).toBe('de');
  });

  it('follows the browser languages when the page does not choose', async () => {
    world = makeWorld({ languages: ['fr-CA', 'en'] });
    const runtime = await world.start();
    expect(runtime.language).toBe('fr');
    expect(runtime.t('a')).toBe('embedded a fr');
  });

  it('falls back when nothing the visitor prefers is available', async () => {
    world = makeWorld({ languages: ['ja'] });
    const runtime = await world.start({ fallbackLanguage: 'fr' });
    expect(runtime.language).toBe('fr');
  });

  it('uses a language chosen before, over the browser, but not over the page', async () => {
    world = makeWorld(THREE);
    const first = await world.startActive();
    await first.setLanguage('de');
    first.stop();

    const second = await world.start();
    expect(second.language).toBe('de');
    second.stop();
    const third = await world.start({ language: 'fr' });
    expect(third.language).toBe('fr');
  });
});

describe('setLanguage', () => {
  it('refuses a language nobody has text for, and changes nothing', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const events: string[] = [];
    runtime.on('languageChanged', (event) => events.push(event.type));
    const requests = world.fetched.length;

    await expect(runtime.setLanguage('es')).rejects.toBeInstanceOf(TarjimLanguageError);

    expect(runtime.language).toBe('en');
    expect(runtime.t('a')).toBe('v1 b1 en');
    expect(events).toEqual([]);
    expect(world.fetched).toHaveLength(requests);
    expect((await world.state()).languageOverride).toBeUndefined();
  });

  it('refuses something that is not a language at all', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    await expect(runtime.setLanguage('')).rejects.toBeInstanceOf(TarjimLanguageError);
    await expect(runtime.setLanguage(undefined as never)).rejects.toBeInstanceOf(TarjimLanguageError);
    expect(runtime.language).toBe('en');
  });

  it('fetches a language the held release lists without reading meta, then shows it', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const metas = world.metaCount();
    const manifests = world.server.count('manifest');

    await runtime.setLanguage('fr');

    expect(runtime.language).toBe('fr');
    expect(runtime.t('a')).toBe('v1 b1 fr');
    expect(world.metaCount()).toBe(metas);
    expect(world.server.count('manifest')).toBe(manifests);
    expect(world.server.objectCount(hashOf(world.server.current, 'b1', 'fr'))).toBe(1);
  });

  it('keeps the old language and text until the new text is in', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const gate = world.server.hold('object');
    const done = runtime.setLanguage('fr');

    expect(await stillPending(done)).toBe(true);
    expect(runtime.language).toBe('en');
    expect(runtime.t('a')).toBe('v1 b1 en');

    gate.release();
    await within(done);
    expect(runtime.language).toBe('fr');
    expect(runtime.t('a')).toBe('v1 b1 fr');
  });

  it('rejects when the text cannot be fetched, and the old language stays', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const events: string[] = [];
    runtime.on('languageChanged', (event) => events.push(event.type));
    world.server.on('object', () => problem(500, 'delivery.server_error'));

    await expect(runtime.setLanguage('fr')).rejects.toBeInstanceOf(Error);

    expect(runtime.language).toBe('en');
    expect(runtime.t('a')).toBe('v1 b1 en');
    expect(events).toEqual([]);
    expect((await world.state()).languageOverride).toBeUndefined();
  });

  it('works again once the fetch can succeed', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    world.server.on('object', () => problem(500, 'delivery.server_error'), { times: 3 });
    await expect(runtime.setLanguage('fr')).rejects.toBeInstanceOf(Error);
    world.clock.advance(3600);
    world.server.clearRules();

    await runtime.setLanguage('fr');
    expect(runtime.t('a')).toBe('v1 b1 fr');
  });

  it('answers from embedded text for a language only the page embeds', async () => {
    world = makeWorld();
    const runtime = await world.start({ embedded: [embedded('en'), embedded('es')] });
    await runtime.setLanguage('es');
    expect(runtime.language).toBe('es');
    expect(runtime.t('e')).toBe('embedded e es');
  });

  it('is a no-op for the language already in use', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const events: string[] = [];
    runtime.on('languageChanged', (event) => events.push(event.type));
    const requests = world.fetched.length;
    await runtime.setLanguage('en');
    expect(events).toEqual([]);
    expect(world.fetched).toHaveLength(requests);
  });

  it('is what later checks send as the language', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    await runtime.setLanguage('fr');
    world.clock.advance(61);
    await runtime.checkNow();
    expect(queryOf(world.server.requests('meta').slice(-1)[0]!.url)['language']).toBe('fr');
  });
});

describe('a language asked for before the text is in', () => {
  // A page that sets the language from its URL calls setLanguage as soon as it renders, before the
  // first release has arrived.
  it('waits for the first release, then switches to the language', async () => {
    world = makeWorld(THREE);
    const gate = world.server.hold('meta');
    const runtime = await world.start({ language: 'en' });
    // German is only in the release; the page embeds English and French.
    const done = runtime.setLanguage('de');
    gate.release();

    await within(done);

    expect(runtime.language).toBe('de');
    expect(runtime.t('a')).toBe('v1 b1 de');
  });

  it('still refuses a language the first release does not have', async () => {
    world = makeWorld(THREE);
    const gate = world.server.hold('meta');
    const runtime = await world.start({ language: 'en' });
    const done = runtime.setLanguage('es');
    gate.release();
    await expect(within(done)).rejects.toBeInstanceOf(TarjimLanguageError);
    expect(runtime.language).toBe('en');
  });

  it('refuses when no release can be fetched and nothing embedded has the language', async () => {
    world = makeWorld(THREE);
    world.server.on('meta', () => problem(500, 'delivery.server_error'));
    const runtime = await world.start({ language: 'en' });
    await expect(within(runtime.setLanguage('de'))).rejects.toBeInstanceOf(TarjimLanguageError);
    expect(runtime.language).toBe('en');
  });
});

describe('a reload in a language the stored release has no text for yet', () => {
  it('fetches that text at once, without waiting for the next check', async () => {
    world = makeWorld(THREE);
    (await world.startActive({ language: 'en' })).stop();
    const metas = world.metaCount();

    const runtime = await world.start({ language: 'fr' });

    await until(() => runtime.t('a') === 'v1 b1 fr', 'the French text');
    expect(world.metaCount()).toBe(metas);
  });

  it('is waited for by start, like a first release, up to waitForContent', async () => {
    world = makeWorld(THREE);
    (await world.startActive({ language: 'en' })).stop();

    const runtime = await world.start({ language: 'fr', waitForContent: 3000 });

    expect(runtime.t('a')).toBe('v1 b1 fr');
  });
});

describe('remembering the choice', () => {
  const asRuntime = async (config: Record<string, unknown> = {}): Promise<Tarjim> => {
    const runtime = await world.startActive(config);
    await runtime.setLanguage('fr');
    return runtime;
  };

  it('saves it when the page did not pick a language', async () => {
    world = makeWorld(THREE);
    await asRuntime();
    expect((await world.state()).languageOverride).toBe('fr');
  });

  it('does not save it when the page picked its language', async () => {
    world = makeWorld(THREE);
    await asRuntime({ language: 'en' });
    expect((await world.state()).languageOverride).toBeUndefined();
  });

  it('saves it for a page that picked its language but asked to', async () => {
    world = makeWorld(THREE);
    await asRuntime({ language: 'en', persistLanguage: true });
    expect((await world.state()).languageOverride).toBe('fr');
  });

  it('does not save it for a page that asked not to', async () => {
    world = makeWorld(THREE);
    await asRuntime({ persistLanguage: false });
    expect((await world.state()).languageOverride).toBeUndefined();
  });

  it('is not what the next load uses when it was not saved', async () => {
    world = makeWorld(THREE);
    const first = await asRuntime({ language: 'en' });
    first.stop();
    const second = await world.start({ language: 'en' });
    expect(second.language).toBe('en');
  });
});

describe('the language event', () => {
  it('fires once per real change, after the text is in', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const seen: string[] = [];
    runtime.on('languageChanged', () => seen.push(`${runtime.language}:${runtime.t('a')}`));

    await runtime.setLanguage('fr');
    await runtime.setLanguage('fr');
    await runtime.setLanguage('de');
    await settle();

    expect(seen).toEqual(['fr:v1 b1 fr', 'de:v1 b1 de']);
  });
});
