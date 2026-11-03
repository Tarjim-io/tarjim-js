import { describe, expect, it } from 'vitest';
import { decodeManifest, matchLocale, selectLocale } from '../src/internal.js';
import { ROTATED_SIGNED_QUERY, problem, respond, simpleRelease } from './support.js';
import { installed, makeRelease, makeWorld } from './helpers/cycle-world.js';

const FILE = { hash: 'a'.repeat(64), size: 1 };

describe('regional variants when none is exact', () => {
  it('prefer the fallback language when it is one of them', () => {
    expect(matchLocale('en-AU', ['en-GB', 'en-US'], 'en-US')).toBe('en-US');
    expect(matchLocale('en', ['en-GB', 'en-US'], 'en-US')).toBe('en-US');
  });

  it('match the fallback language whatever its case', () => {
    expect(matchLocale('en-AU', ['en-GB', 'en-us'], 'EN-US')).toBe('en-us');
  });

  it('keep the sorted rule when the fallback is not among them', () => {
    expect(matchLocale('en-AU', ['en-US', 'en-GB'], 'fr')).toBe('en-GB');
    expect(matchLocale('en-AU', ['en-GB'], 'en-US')).toBe('en-GB');
  });

  it('never beat an exact match or the base language', () => {
    expect(matchLocale('en-AU', ['en-AU', 'en-US'], 'en-US')).toBe('en-AU');
    expect(matchLocale('de-CH', ['de-AT', 'de'], 'de-AT')).toBe('de');
    expect(matchLocale('de-CH', ['de-AT', 'de'], 'de-DE')).toBe('de');
  });

  it('do not cross a script', () => {
    expect(matchLocale('zh-HK', ['zh-Hans', 'zh-CN'], 'zh-CN')).toBeNull();
  });

  it('are preferred the same way when a locale is selected', () => {
    const chosen = selectLocale({ browser: ['en-AU'], fallback: 'en-US', universe: ['en-GB', 'en-US'], manifestHeld: true });
    expect(chosen.locale).toBe('en-US');
    const given = selectLocale({ explicit: 'en-AU', browser: [], fallback: 'en-US', universe: ['en-GB', 'en-US'], manifestHeld: true });
    expect(given.locale).toBe('en-US');
  });
});

describe('the order of locale selection', () => {
  it('goes through the wanted language, then the fallback, whatever baseLocale says', () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      baseLocale: 'ar',
      bundles: { b1: { type: 'namespace', name: 'default' } },
      slices: { b1: { ar: { json: FILE }, fr: { json: FILE } } },
    })!;
    const universe = Object.keys(manifest.slices['b1']!);

    expect(selectLocale({ browser: ['de'], fallback: 'fr', universe, manifestHeld: true }).locale).toBe('fr');
  });
});

describe('fields a JSON client ignores', () => {
  it('reads a manifest with extra fields, on the manifest and on a bundle', () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      baseLocale: 'en',
      somethingNew: { a: 1 },
      bundles: { b1: { type: 'custom', name: 'one', layout: 'flat', namespaces: ['a'], emptyValues: 'empty_string', future: true } },
      slices: { b1: { en: { json: FILE } } },
    });

    expect(manifest?.bundles['b1']).toEqual({ type: 'custom', name: 'one', layout: 'flat', namespaces: ['a'] });
  });

  it('skips a native bundle, which lists no JSON file, and keeps the rest', () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      bundles: {
        b1: { type: 'custom', name: 'native', format: 'ios', emptyValues: 'empty_string', namespaces: [] },
        b2: { type: 'custom', name: 'droid', format: 'android', namespaces: [] },
        b3: { type: 'custom', name: 'web', namespaces: [] },
      },
      slices: {
        b1: { en: { strings: FILE, stringsdict: FILE } },
        b2: { en: { xml: FILE } },
        b3: { en: { json: FILE } },
      },
    });

    expect(Object.keys(manifest?.bundles ?? {})).toEqual(['b3']);
    expect(Object.keys(manifest?.slices ?? {})).toEqual(['b3']);
  });

  it('takes a bundle locales from its own slices, baseLocale or not', () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      baseLocale: 'en',
      bundles: { b1: { type: 'custom', name: 'one', namespaces: [] }, b2: { type: 'custom', name: 'two', namespaces: [] } },
      slices: { b1: { fr: { json: FILE } }, b2: { ar: { json: FILE }, de: { json: FILE } } },
    });

    expect(Object.keys(manifest!.slices['b1']!)).toEqual(['fr']);
    expect(Object.keys(manifest!.slices['b2']!)).toEqual(['ar', 'de']);
  });
});

const nativeOnly = () =>
  makeRelease({
    releaseId: 2,
    manifestOverrides: {
      bundles: { n1: { type: 'custom', name: 'native', format: 'ios', namespaces: [] } },
      slices: { n1: { en: { strings: FILE } } },
    },
  });

describe('a release with no file this client can read', () => {
  it('keeps what is held and reports it, without installing anything', async () => {
    const w = await installed();
    const held = (await w.state()).active?.checksum;
    w.server.use(nativeOnly());
    w.clock.advance(60);

    const result = await w.run();

    expect(result.conditions).toEqual([{ code: 'no-file-type' }]);
    const state = await w.state();
    expect(state.active?.checksum).toBe(held);
    expect(state.pending).toBeUndefined();
  });

  it('is reported with nothing held too, and leaves nothing installed', async () => {
    const w = makeWorld({ release: nativeOnly() });

    const result = await w.run();

    expect(result.conditions).toEqual([{ code: 'no-file-type' }]);
    expect((await w.state()).active).toBeUndefined();
  });

  it('is not downloaded again at the next check', async () => {
    const w = makeWorld({ release: nativeOnly() });
    await w.run();
    w.clock.advance(60);
    await w.run();

    expect(w.server.count('manifest')).toBe(1);
  });
});

describe('a manifest that cannot be fetched with its signature', () => {
  it.each([
    ['403', () => respond(403, 'expired')],
    ['404', () => respond(404, 'gone')],
    ['503', () => respond(503, 'busy')],
    ['an opaque failure', () => new TypeError('Failed to fetch')],
  ])('after %s, reads meta once and retries with the new signature', async (_label, answer) => {
    const release = makeRelease();
    const w = makeWorld({ release });
    w.server.on('manifest', () => {
      release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
      return answer();
    }, { times: 1 });

    const result = await w.run();

    expect(result.outcome).toBe('activated');
    expect(w.server.count('meta')).toBe(2);
    expect(w.server.requests('manifest').map(({ url }) => url.includes('Signature=S2'))).toEqual([false, true]);
  });

  it('keeps what is held when the retry fails too, reading meta only once', async () => {
    const w = await installed();
    const held = (await w.state()).active?.checksum;
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    w.server.on('manifest', () => respond(403, 'expired'));
    w.clock.advance(60);
    const before = w.server.count('meta');
    const manifestsBefore = w.server.count('manifest');

    expect((await w.run()).outcome).toBe('failed');

    expect(w.server.count('meta')).toBe(before + 2);
    expect(w.server.requests('manifest').length).toBe(manifestsBefore + 2);
    expect((await w.state()).active?.checksum).toBe(held);
  });

  it('gives up for this check when the re-read names another release', async () => {
    const second = makeRelease({ content: { b1: 'v2' }, releaseId: 2 });
    const w = makeWorld({ release: makeRelease() });
    w.server.on('manifest', () => {
      w.server.use(second);
      return respond(403, 'expired');
    }, { times: 1 });

    expect((await w.run()).outcome).toBe('failed');

    expect(w.server.count('manifest')).toBe(1);
    expect((await w.state()).active).toBeUndefined();
  });

  it('is not retried in origin mode, where there is no signature to renew', async () => {
    const release = simpleRelease({ mode: 'origin' });
    release.hook(({ kind }) => (kind === 'manifest' ? respond(403, 'no') : undefined));
    const w = makeWorld({ release });

    expect((await w.run()).outcome).toBe('failed');

    expect(w.server.count('meta')).toBe(1);
  });
});

describe('answers about the binding', () => {
  it('treats nothing released for this app version as normal, keeping what is held', async () => {
    const w = await installed();
    const held = (await w.state()).active?.checksum;
    w.server.on('meta', () => problem(404, 'delivery.stage_unreleased', { appVersion: '1.4.0' }), { times: 1 });
    w.clock.advance(60);

    const result = await w.run();

    expect(result).toEqual({ outcome: 'noChange', conditions: [] });
    expect((await w.state()).active?.checksum).toBe(held);
  });

  it.each([
    [404, 'delivery.distribution_not_found'],
    [401, 'unauthorized'],
  ])('treats %s %s as a configuration error, keeping what is held', async (status, code) => {
    const w = await installed();
    const held = (await w.state()).active?.checksum;
    w.server.on('meta', () => problem(status, code), { times: 1 });
    w.clock.advance(60);

    const result = await w.run();

    expect(result).toEqual({ outcome: 'failed', conditions: [{ code: 'configuration', status, problemCode: code }] });
    expect((await w.state()).active?.checksum).toBe(held);
  });

  it('keeps what is held on an unknown schema version, and never calls it a refusal', async () => {
    const w = await installed();
    const held = (await w.state()).active?.checksum;
    w.server.use(makeRelease({ releaseId: 2, metaOverrides: { schemaVersion: 2 } }));
    w.clock.advance(60);

    const result = await w.run();

    expect(result.outcome).toBe('noChange');
    expect(result.conditions).toEqual([{ code: 'meta-schema', schemaVersion: 2 }]);
    expect((await w.state()).active?.checksum).toBe(held);
  });
});
