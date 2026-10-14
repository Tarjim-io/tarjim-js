import { afterEach, describe, expect, it, vi } from 'vitest';
import { TarjimConfigError, createRuntime } from '../../src/index.js';
import { API_KEY, embedded, makeWorld, settle, until, within } from './world.js';

let world = makeWorld();
afterEach(() => world.stopAll());

const BAD_FIELDS: Array<[string, Record<string, unknown>]> = [
  ['a plain-http delivery URL', { deliveryUrl: 'http://delivery.example.invalid/t/1/meta' }],
  ['a delivery URL that is not a URL', { deliveryUrl: 'not a url' }],
  ['a delivery URL with a query', { deliveryUrl: 'https://delivery.example.invalid/meta?x=1' }],
  ['a missing delivery URL', { deliveryUrl: undefined }],
  ['an empty api key', { apiKey: '' }],
  ['an api key that is not a string', { apiKey: 42 }],
  ['a default bundle of the wrong type', { defaultBundle: { type: 'folder', name: 'b1' } }],
  ['a default bundle without a name', { defaultBundle: { type: 'namespace' } }],
  ['a missing default bundle', { defaultBundle: undefined }],
  ['a missing fallback language', { fallbackLanguage: undefined }],
  ['an empty fallback language', { fallbackLanguage: '' }],
];

describe('a configuration that cannot work', () => {
  it.each(BAD_FIELDS)('with %s serves the embedded text and says so once', async (_name, bad) => {
    world = makeWorld();
    const runtime = await within(world.start(bad));

    expect(typeof runtime.t('a')).toBe('string');
    if ('deliveryUrl' in bad || 'apiKey' in bad) expect(runtime.t('a')).toBe('embedded a');
    await world.timers.advance(3_600_000);
    await settle();
    expect(world.server.log).toEqual([]);
    expect(world.fetched).toEqual([]);
    expect(world.reports).toHaveLength(1);
    expect(world.reports[0]!.code).toEqual(expect.any(String));
  });

  it('does not open the store or call the network, and never prints the key', async () => {
    world = makeWorld();
    const runtime = await world.start({ deliveryUrl: 'http://delivery.example.invalid/meta' });
    await runtime.checkNow();

    expect(world.opened).toEqual([]);
    expect(world.fetched).toEqual([]);
    expect(JSON.stringify([world.reports, world.logs])).not.toContain(API_KEY);
  });

  it('still looks up embedded text in other languages', async () => {
    world = makeWorld();
    const runtime = await world.start({ deliveryUrl: 'nope', language: 'fr' });
    expect(runtime.language).toBe('fr');
    expect(runtime.t('a')).toBe('embedded a fr');
  });

  it('is a working runtime with a good configuration (no report, one store, requests)', async () => {
    world = makeWorld();
    await world.startActive();
    expect(world.reports).toEqual([]);
    expect(world.opened).toEqual([['https://delivery.example.invalid/t/1/projects/1/delivery/meta', API_KEY]]);
    expect(world.server.count('meta')).toBeGreaterThan(0);
  });
});

describe('strict mode', () => {
  it.each(BAD_FIELDS)('rejects with a configuration error for %s', async (_name, bad) => {
    world = makeWorld();
    await expect(world.start({ strict: true, ...bad })).rejects.toBeInstanceOf(TarjimConfigError);
    expect(world.opened).toEqual([]);
    expect(world.fetched).toEqual([]);
  });

  it('starts normally with a good configuration', async () => {
    world = makeWorld();
    const runtime = await world.start({ strict: true });
    expect(runtime.t('a')).toBe('embedded a');
    expect(world.reports).toEqual([]);
  });

  it('never throws for an app version it has to normalise', async () => {
    world = makeWorld();
    const runtime = await world.start({ strict: true, appVersion: 'v2.1-beta' });
    expect(runtime.t('a')).toBe('embedded a');
    expect(world.codes()).toEqual(['app-version-normalised']);
  });

  it('does not throw for an insecure context either', async () => {
    world = makeWorld({ secureContext: false });
    const runtime = await world.start({ strict: true });
    expect(runtime.t('a')).toBe('embedded a');
  });
});

describe('an insecure context', () => {
  it('serves the embedded text, reports once and makes no store and no request', async () => {
    world = makeWorld({ secureContext: false });
    const runtime = await within(world.start());
    await runtime.checkNow();
    await world.timers.advance(3_600_000);

    expect(runtime.t('a')).toBe('embedded a');
    expect(world.codes()).toEqual(['insecure-context']);
    expect(world.opened).toEqual([]);
    expect(world.fetched).toEqual([]);
  });

  it('still switches between embedded languages', async () => {
    world = makeWorld({ secureContext: false });
    const runtime = await world.start();
    await runtime.setLanguage('fr');
    expect(runtime.t('a')).toBe('embedded a fr');
  });
});

describe('storage that cannot be used', () => {
  it('serves the embedded text and never sends a request', async () => {
    world = makeWorld({ degraded: true });
    const runtime = await within(world.start());
    await world.timers.advance(3_600_000);
    await runtime.checkNow();
    await settle();

    expect(runtime.t('a')).toBe('embedded a');
    expect(world.server.log).toEqual([]);
    expect(world.fetched).toEqual([]);
  });

  it('reports it once however many checks are asked for', async () => {
    world = makeWorld({ degraded: true });
    const runtime = await world.start();
    await runtime.checkNow();
    await runtime.checkNow();
    await world.timers.advance(3_600_000);
    expect(world.reportsOf('storage-unavailable')).toHaveLength(1);
    expect(world.reports).toHaveLength(1);
  });

  it('keeps the page language choice working over embedded text', async () => {
    world = makeWorld({ degraded: true });
    const runtime = await world.start();
    await runtime.setLanguage('fr');
    expect(runtime.language).toBe('fr');
    expect(runtime.t('a')).toBe('embedded a fr');
    expect(world.fetched).toEqual([]);
  });
});

describe('the app version', () => {
  it('is sent normalised and reported once with the old and new value', async () => {
    world = makeWorld();
    const runtime = await world.startActive({ appVersion: 'v2.1-beta' });
    await runtime.checkNow();

    expect(world.server.metaQuery(0)['appVersion']).toBe('2.1.0');
    expect(world.reportsOf('app-version-normalised')).toHaveLength(1);
    expect(world.reportsOf('app-version-normalised')[0]!.details).toEqual({ from: 'v2.1-beta', to: '2.1.0' });
  });

  it('is sent as given and not reported when it is already clean', async () => {
    world = makeWorld();
    await world.startActive({ appVersion: '3.4.5' });
    expect(world.server.metaQuery(0)['appVersion']).toBe('3.4.5');
    expect(world.codes()).not.toContain('app-version-normalised');
  });

  it('falls back to 0.0.0 for something that is not a version, and still runs', async () => {
    world = makeWorld();
    const runtime = await world.startActive({ appVersion: 'banana' });
    expect(runtime.t('a')).toBe('v1 b1 en');
    expect(world.server.metaQuery(0)['appVersion']).toBe('0.0.0');
    expect(world.reportsOf('app-version-normalised')).toHaveLength(1);
  });
});

describe('embedded text that is not a list of slices', () => {
  it.each([
    ['a string', 'text'],
    ['a number', 5],
    ['a single slice', embedded('en')],
    ['an object of slices', { en: embedded('en') }],
  ])('ignores %s and reports it once', async (_name, value) => {
    world = makeWorld();
    const runtime = await world.start({ embedded: value as never });
    expect(runtime.t('a')).toBe('a');
    expect(runtime.t('e')).toBe('e');
    await runtime.checkNow();
    expect(world.reportsOf('embedded-invalid')).toHaveLength(1);
    expect(world.reports).toHaveLength(1);
  });

  it('still serves the downloaded text', async () => {
    world = makeWorld();
    const runtime = await world.start({ embedded: 'text' as never });
    await until(() => runtime.t('a') === 'v1 b1 en', 'the downloaded text');
  });

  it('does not report a real list, nor a missing one', async () => {
    world = makeWorld();
    await world.start();
    await world.start({ embedded: undefined });
    expect(world.reportsOf('embedded-invalid')).toEqual([]);
  });
});

describe('the platform and configuration wiring', () => {
  it('sends the platform name and the system version to the delivery server', async () => {
    world = makeWorld({ osVersion: '14.2' });
    await world.startActive();
    const query = world.server.metaQuery(0);
    expect(query['platform']).toBe('web');
    expect(query['osVersion']).toBe('14.2');
    expect(query['language']).toBe('en');
  });

  it('sends no system version when the platform has none', async () => {
    world = makeWorld();
    await world.startActive();
    expect(world.server.metaQuery(0)).not.toHaveProperty('osVersion');
  });

  it('uses the fetch from the configuration before the platform one', async () => {
    world = makeWorld();
    const own = vi.fn(world.server.fetch);
    const runtime = await world.start({ fetch: own });
    await until(() => runtime.t('a') === 'v1 b1 en', 'the downloaded text');
    expect(own).toHaveBeenCalled();
    expect(world.fetched).toEqual([]);
  });

  it('opens the store for this delivery URL and key', async () => {
    world = makeWorld();
    await world.start();
    expect(world.opened).toEqual([['https://delivery.example.invalid/t/1/projects/1/delivery/meta', API_KEY]]);
  });

  it('keeps a report callback that throws from hurting the runtime', async () => {
    world = makeWorld();
    const runtime = await world.start({
      appVersion: 'v2-beta',
      onReport: () => {
        throw new Error('boom');
      },
    });
    await until(() => runtime.t('a') === 'v1 b1 en', 'the downloaded text');
  });

  it('applies the legacy placeholder setting to lookups', async () => {
    world = makeWorld();
    const legacy = { en: { ...embedded('en'), keys: { hi: { id: '1', value: 'Hi %%name%%', tags: [] } } } };
    const on = await world.start({ embedded: [legacy.en as never], legacyPercentPlaceholders: true });
    const off = await world.start({ embedded: [legacy.en as never] });
    expect(on.t('hi', { name: 'Z' })).toBe('Hi Z');
    expect(off.t('hi', { name: 'Z' })).not.toBe('Hi Z');
  });
});

describe('keyCase', () => {
  it("applies 'lower' to lookups in embedded text", async () => {
    world = makeWorld();
    const runtime = await world.start({ keyCase: 'lower', embedded: [embedded('en', { 'Mixed.Key': { id: '903', value: 'mixed', tags: [] } })] });
    expect(runtime.t('MIXED.KEY')).toBe('mixed');
    expect(runtime.t('A')).toBe('embedded a');
  });

  it("applies 'lower' to lookups in downloaded text", async () => {
    world = makeWorld();
    const runtime = await world.startActive({ keyCase: 'lower' });
    expect(runtime.t('A')).toBe(runtime.t('a'));
    expect(runtime.t('A')).not.toMatch(/^(A|embedded a)$/);
  });

  it('matches exactly when keyCase is left out', async () => {
    world = makeWorld();
    const runtime = await world.start();
    expect(runtime.t('a')).toBe('embedded a');
    expect(runtime.t('A')).toBe('A');
  });

  it('reads keyCase once, at start', async () => {
    world = makeWorld();
    const config = world.config({ keyCase: 'exact' });
    const runtime = await createRuntime(config, world.platform());
    (config as { keyCase: string }).keyCase = 'lower';
    await runtime.setLanguage('fr');
    expect(runtime.t('A')).toBe('A');
    runtime.stop();
  });

  it('rejects an unknown keyCase in strict mode', async () => {
    world = makeWorld();
    await expect(world.start({ strict: true, keyCase: 'upper' })).rejects.toBeInstanceOf(TarjimConfigError);
  });

  it('treats an unknown keyCase as exact without strict, and keeps serving', async () => {
    world = makeWorld();
    const runtime = await world.start({ keyCase: 'upper' });
    expect(runtime.t('a')).toBe('embedded a');
    expect(runtime.t('A')).toBe('A');
    expect(world.reports).toEqual([]);
  });
});
