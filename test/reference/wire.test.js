import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY,
  ROTATED_SIGNED_QUERY,
  SIGNED_QUERY,
  buildRelease,
  hangUntilAborted,
  headersOf,
  leaf,
  makeSlice,
  problem,
  queryOf,
  requestsOfKind,
  respond,
} from '../helpers/fake-delivery.js';
import { accessSpy, basicRelease, createHarness, startClient } from '../helpers/harness.js';

describe('the api key', () => {
  it('travels only as a header on the meta request and on origin requests, never in a URL', async () => {
    const origin = basicRelease({ mode: 'origin' });
    const { client } = await startClient(origin);
    expect(client.t('app.title')).toBe('Tarjim');

    expect(origin.requests.length).toBeGreaterThanOrEqual(3);
    for (const { url, init } of origin.requests) {
      expect(url).not.toContain(API_KEY);
      expect(headersOf(init)['x-tarjim-apikey']).toBe(API_KEY);
    }

    const cdn = basicRelease();
    await startClient(cdn);
    const [metaRequest] = requestsOfKind(cdn, 'meta');
    expect(headersOf(metaRequest.init)['x-tarjim-apikey']).toBe(API_KEY);
    for (const { url, init } of [...requestsOfKind(cdn, 'manifest'), ...requestsOfKind(cdn, 'object')]) {
      expect(url).not.toContain(API_KEY);
      expect(JSON.stringify(headersOf(init))).not.toContain(API_KEY);
    }
    expect(requestsOfKind(cdn, 'object').length).toBeGreaterThan(0);
  });

  it('never appears in a report, a console.debug argument or a rejected value, whatever fails', async () => {
    const failures = [
      basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(500, `oops ${API_KEY}`) : undefined)] }),
      basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? new TypeError(`failed ${API_KEY}`) : undefined)] }),
      basicRelease({ hooks: [({ kind }) => (kind === 'object' ? problem(403, 'delivery.forbidden') : undefined)] }),
      basicRelease({ tamper: { manifest: true } }),
      basicRelease({ metaOverrides: { track: null } }),
    ];
    let sawAReport = false;
    for (const release of failures) {
      const harness = createHarness(release, { config: { appVersion: 'v1.0.0-rc.1' } });
      const client = await harness.start();
      expect(client.t('app.title')).toBeTypeOf('string');
      const everything = JSON.stringify([harness.reports, harness.debugCalls, harness.otherConsoleCalls]);
      expect(everything).not.toContain(API_KEY);
      sawAReport ||= harness.reports.length > 0;
    }
    expect(sawAReport).toBe(true);
  });

  it('is kept out of the reports even when the config is wrong', async () => {
    const release = basicRelease();
    const harness = createHarness(release, { config: { defaultBundle: undefined } });
    const client = await harness.start();
    expect(client.active).toBe(false);
    expect(harness.codes()).toContain('config');
    expect(JSON.stringify([harness.reports, harness.debugCalls])).not.toContain(API_KEY);
  });
});

describe('the signed query', () => {
  it('is appended verbatim to CDN manifest and object URLs but never reported', async () => {
    const release = basicRelease({ hooks: [({ kind }) => (kind === 'object' ? respond(403, '') : undefined)] });
    release.hook(({ kind, nth }) => {
      if (kind === 'object' && nth === 0) release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    });
    const harness = createHarness(release);
    await harness.start();

    for (const { url } of requestsOfKind(release, 'manifest')) expect(url.endsWith(`?${SIGNED_QUERY}`)).toBe(true);
    const objectUrls = requestsOfKind(release, 'object').map(({ url }) => url);
    expect(objectUrls[0].endsWith(`?${SIGNED_QUERY}`)).toBe(true);
    expect(objectUrls[1].endsWith(`?${ROTATED_SIGNED_QUERY}`)).toBe(true);

    expect(harness.codes()).toContain('object-unavailable');
    const everything = JSON.stringify([harness.reports, harness.debugCalls, harness.otherConsoleCalls]);
    for (const secret of ['Signature', 'Policy', 'Key-Pair-Id', 'S1', 'S2', 'K1', 'K2']) expect(everything).not.toContain(secret);
  });
});

describe('request shape', () => {
  it('sends CDN object requests as plain credential-free GETs with no custom header', async () => {
    const release = basicRelease();
    const { client } = await startClient(release);
    expect(client.t('app.title')).toBe('Tarjim');

    const objects = requestsOfKind(release, 'object');
    const manifests = requestsOfKind(release, 'manifest');
    expect(objects.length).toBeGreaterThan(0);
    expect(manifests.length).toBeGreaterThan(0);
    for (const { url, init } of [...objects, ...manifests]) {
      expect(url).toMatch(/\?Policy=P1&Signature=S1&Key-Pair-Id=K1$/);
      expect(init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error' });
      expect(headersOf(init)).toEqual({});
    }
  });

  it('sends the meta request with exactly the two protocol headers and the default cache mode', async () => {
    const release = basicRelease();
    await startClient(release);
    const [{ init }] = requestsOfKind(release, 'meta');
    expect(init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error' });
    expect(headersOf(init)).toEqual({ 'x-tarjim-apikey': API_KEY, 'x-tarjim-api-version': '2026-07-29' });
    expect('cache' in init).toBe(false);
  });

  it('sets redirect: error on every request, in both modes', async () => {
    for (const mode of ['cdn', 'origin']) {
      const release = basicRelease({ mode });
      await startClient(release);
      expect(release.requests.length).toBeGreaterThanOrEqual(3);
      for (const { init } of release.requests) expect(init.redirect).toBe('error');
    }
  });

  it('gives every request an abort signal and aborts the meta request after 20 seconds', async () => {
    const timers = [];
    const release = basicRelease({
      hooks: [({ kind, init }) => (kind === 'meta' ? hangUntilAborted(init) : undefined)],
    });
    const harness = createHarness(release, {
      globals: {
        setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length,
        clearTimeout: () => {},
      },
    });
    const started = harness.start();
    started.catch(() => {}); // the assertion below reports a failure; this only stops an unhandled rejection
    await vi.waitFor(() => expect(timers.some(({ ms }) => ms === 20000)).toBe(true));
    timers.find(({ ms }) => ms === 20000).fn();

    const client = await started;
    expect(client.active).toBe(false);
    expect(harness.codes()).toEqual(['network']);
  });

  it('treats a response that was redirected, or is an opaque redirect, as a failure', async () => {
    const redirected = { redirected: true };
    const opaque = { type: 'opaqueredirect' };
    for (const variant of [redirected, opaque]) {
      const onMeta = basicRelease({
        hooks: [({ kind }) => (kind === 'meta' ? respond(200, JSON.stringify(basicRelease().meta), variant) : undefined)],
      });
      const harness = createHarness(onMeta);
      const client = await harness.start();
      expect(client.active).toBe(false);
      expect(harness.codes()).toEqual(['network']);
      expect(requestsOfKind(onMeta, 'manifest')).toHaveLength(0);

      const onManifest = basicRelease({
        hooks: [({ kind }) => (kind === 'manifest' ? respond(200, '{}', variant) : undefined)],
      });
      const second = createHarness(onManifest);
      expect((await second.start()).active).toBe(false);
      expect(second.codes()).toContain('network');

      const onObject = basicRelease({
        hooks: [({ kind }) => (kind === 'object' ? respond(200, '{}', variant) : undefined)],
      });
      const third = createHarness(onObject);
      const client3 = await third.start();
      expect(client3.t('app.title')).toBe('app.title');
    }

    const healthy = basicRelease();
    expect((await startClient(healthy)).client.t('app.title')).toBe('Tarjim');
  });
});

describe('client identity on the wire', () => {
  it('asks for the meta with the app version first and no poll interval, install id or key in the query', async () => {
    const release = basicRelease();
    await startClient(release, { config: { language: 'ar', appVersion: '3.4.5' } });
    const [{ url }] = requestsOfKind(release, 'meta');
    expect(url).toBe(
      `${release.deliveryUrl}?appVersion=3.4.5&platform=web&sdkVersion=ref-0.1.0&release=0&language=ar`,
    );
    const query = queryOf(url);
    for (const forbidden of ['pollSeconds', 'installId', 'apikey', 'apiKey']) expect(query).not.toHaveProperty(forbidden);
    expect(query).toMatchObject({ platform: 'web', sdkVersion: 'ref-0.1.0', release: '0' });
  });

  it('reports the library version', async () => {
    const harness = createHarness(basicRelease());
    expect(harness.TarjimReference.version).toBe('0.1.0');
  });
});

describe('app version', () => {
  const cases = [
    ['v2.3.0', '2.3.0'],
    ['2.3.0-rc.1', '2.3.0'],
    ['2.3.0-4-gabc', '2.3.0'],
    ['2.1', '2.1.0'],
    ['1.02', '1.2.0'],
    ['1.2.3.4', '1.2.3'],
    ['2.', '2.0.0'],
    ['1.2.', '1.2.0'],
    ['2.x', '2.0.0'],
    ['1.2.3.', '1.2.3'],
    ['1..2', '0.0.0'],
    ['.', '0.0.0'],
    ['abc', '0.0.0'],
    ['', '0.0.0'],
    [42, '0.0.0'],
    [undefined, '0.0.0'],
    [null, '0.0.0'],
    ['9007199254740991.9007199254740991.9007199254740991', '0.0.0'],
    ['99999999999999999999.1.1', '0.0.0'],
  ];

  it.each(cases)('normalises %j to %s on the wire without rejecting start()', async (given, expected) => {
    const release = basicRelease();
    const harness = createHarness(release, { config: { appVersion: given } });
    const client = await harness.start();
    expect(client.t('app.title')).toBe('Tarjim');

    const [{ url, init }] = requestsOfKind(release, 'meta');
    expect(url).toBe(`${release.deliveryUrl}?appVersion=${expected}&platform=web&sdkVersion=ref-0.1.0&release=0&language=en`);
    expect(JSON.stringify(headersOf(init))).not.toContain(expected);
    for (const { url: objectUrl } of [...requestsOfKind(release, 'manifest'), ...requestsOfKind(release, 'object')]) {
      expect(objectUrl).not.toContain('appVersion');
    }
    expect(harness.codes().filter((code) => code === 'app-version-normalised')).toHaveLength(1);
    expect(JSON.stringify(harness.reports)).not.toContain(API_KEY);
  });

  it('stays quiet when the version is already in its normal form', async () => {
    const harness = createHarness(basicRelease(), { config: { appVersion: '12.0.7' } });
    await harness.start();
    expect(harness.codes()).toEqual([]);
  });

  it('reports the change once even when the meta is read twice', async () => {
    const release = basicRelease();
    release.hook(({ kind, nth }) => {
      if (kind === 'object' && nth === 0) {
        release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
        return respond(403, '');
      }
    });
    const harness = createHarness(release, { config: { appVersion: 'v2.3.0-rc.1' } });
    const client = await harness.start();
    expect(client.t('app.title')).toBe('Tarjim');
    expect(requestsOfKind(release, 'meta')).toHaveLength(2);
    expect(harness.codes().filter((code) => code === 'app-version-normalised')).toHaveLength(1);
  });
});

describe('origin mode urls', () => {
  it('resolves relative manifest and slice URLs against the delivery URL', async () => {
    const release = basicRelease({ mode: 'origin' });
    const { client } = await startClient(release);
    expect(client.t('app.title')).toBe('Tarjim');

    const [manifestRequest] = requestsOfKind(release, 'manifest');
    expect(manifestRequest.url).toBe(new URL(release.meta.manifestUrl, release.deliveryUrl).href);
    const base = new URL(release.meta.slicesBaseUrl, release.deliveryUrl).href;
    const objects = requestsOfKind(release, 'object');
    expect(objects.length).toBeGreaterThan(0);
    for (const { url } of objects) expect(url.startsWith(base)).toBe(true);
    for (const { url } of [manifestRequest, ...objects]) expect(url).not.toContain('?');
  });

  it('works whatever the path of the delivery URL looks like', async () => {
    const deliveryUrl = 'https://gateway.example.invalid/any/%2F/shape;here/v9/get-meta';
    const release = basicRelease({ mode: 'origin', deliveryUrl });
    const { client } = await startClient(release);
    expect(client.active).toBe(true);
    expect(client.t('app.title')).toBe('Tarjim');
    expect(requestsOfKind(release, 'manifest')[0].url).toBe(new URL(release.meta.manifestUrl, deliveryUrl).href);
  });

  it('allows plain http only for loopback hosts', async () => {
    for (const host of ['localhost:4000', '127.0.0.1:4000']) {
      const release = basicRelease({ mode: 'origin', deliveryUrl: `http://${host}/t/1/delivery/meta` });
      expect((await startClient(release)).client.active).toBe(true);
    }
    const remote = basicRelease({ mode: 'origin', deliveryUrl: 'http://delivery.example.invalid/t/1/delivery/meta' });
    const harness = createHarness(remote);
    expect((await harness.start()).active).toBe(false);
    expect(harness.codes()).toEqual(['config']);
    expect(remote.requests).toHaveLength(0);
  });

  it.each([
    ['a trailing slash', (url) => `${url}/`],
    ['a query', (url) => `${url}?x=1`],
    ['a fragment', (url) => `${url}#top`],
    ['userinfo', (url) => url.replace('https://', 'https://user:pass@')],
    ['no scheme', (url) => url.replace('https://', '')],
    ['an empty value', () => ''],
    ['a non-string', () => 42],
  ])('treats a delivery URL with %s as a config error and makes no request', async (_, change) => {
    const release = basicRelease({ mode: 'origin' });
    const harness = createHarness(release, { config: { deliveryUrl: change(release.deliveryUrl) } });
    const client = await harness.start();
    expect(client.active).toBe(false);
    expect(harness.codes()).toEqual(['config']);
    expect(release.requests).toHaveLength(0);

    const good = basicRelease({ mode: 'origin' });
    expect((await startClient(good)).client.active).toBe(true);
  });
});

describe('file types', () => {
  it('fetches the json entry only and never reports the other types', async () => {
    const release = buildRelease({
      extraTypes: ['strings', 'stringsdict', 'xml'],
      bundles: { ns1: { type: 'namespace', name: 'default' } },
      slices: { ns1: { en: makeSlice('ns1', 'en', { a: leaf(1, 'A') }) } },
    });
    const harness = createHarness(release);
    const client = await harness.start();

    const objectUrls = requestsOfKind(release, 'object').map(({ url }) => url.split('?')[0]);
    expect(objectUrls).toEqual([`${release.meta.slicesBaseUrl}${release.objectName('ns1', 'en')}`]);
    expect(client.t('a')).toBe('A');
    expect(release.requests.some(({ url }) => /\.(strings|stringsdict|xml)(\?|$)/.test(url))).toBe(false);
    expect(harness.reports).toEqual([]);
  });
});

describe('no ambient state', () => {
  it('touches no storage, cookie, cache or document while starting and answering lookups', async () => {
    const log = [];
    const globals = {
      localStorage: accessSpy('localStorage', log),
      sessionStorage: accessSpy('sessionStorage', log),
      indexedDB: accessSpy('indexedDB', log),
      caches: accessSpy('caches', log),
      document: accessSpy('document', log),
    };
    const release = basicRelease();
    const { client } = await startClient(release, { globals });
    expect(client.t('app.title')).toBe('Tarjim');
    client.tArray('app.title');
    client.entry('app.title');
    client.t('missing');
    expect(log).toEqual([]);
  });
});

describe('failures that must never reject start()', () => {
  const scenarios = [
    ['fetch throws', () => basicRelease({ hooks: [() => new TypeError('Failed to fetch')] })],
    ['server error', () => basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(500, 'boom') : undefined)] })],
    ['meta is not JSON', () => basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(200, '<html>') : undefined)] })],
    ['meta lacks fields', () => basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(200, '{}') : undefined)] })],
    ['manifest is not JSON', () => basicRelease({ hooks: [({ kind }) => (kind === 'manifest' ? respond(200, 'nope') : undefined)] })],
  ];

  it.each(scenarios)('resolves with an inactive client when %s', async (_, make) => {
    const fake = make();
    const harness = createHarness(fake);
    const client = await harness.start();
    expect(client.active).toBe(false);
    expect(client.language).toBe(null);
    expect(client.t('app.title')).toBe('app.title');
    expect(harness.reports.length).toBeGreaterThan(0);
  });

  it.each([
    ['no config at all', undefined],
    ['null', null],
    ['a string', 'https://delivery.example.invalid'],
    ['an empty object', {}],
  ])('resolves with an inactive client for %s', async (_, config) => {
    const { TarjimReference } = createHarness(basicRelease());
    let promise;
    expect(() => {
      promise = TarjimReference.start(config);
    }).not.toThrow();
    const client = await promise;
    expect(client.active).toBe(false);
    expect(client.t('x')).toBe('x');
  });

  it('reports a missing api key, default bundle, fallback language or fetch as a config problem', async () => {
    for (const missing of ['apiKey', 'defaultBundle', 'fallbackLanguage', 'fetch']) {
      const release = basicRelease();
      const harness = createHarness(release, { config: { [missing]: undefined }, globals: { fetch: undefined } });
      const client = await harness.start();
      expect(client.active).toBe(false);
      expect(harness.codes()).toEqual(['config']);
      expect(release.requests).toHaveLength(0);
    }
    const harness = createHarness(basicRelease(), { config: { apiKey: '' } });
    expect((await harness.start()).active).toBe(false);
    expect(harness.codes()).toEqual(['config']);
  });

  it('survives an onReport that throws', async () => {
    const release = basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(500, 'boom') : undefined)] });
    const client = await createHarness(release, {
      config: {
        onReport: () => {
          throw new Error('listener failed');
        },
      },
    }).start();
    expect(client.active).toBe(false);
  });

  it('reports only through console.debug, never warn, error or log', async () => {
    const release = basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(500, 'boom') : undefined)] });
    const harness = createHarness(release);
    await harness.start();
    expect(harness.debugCalls.length).toBeGreaterThan(0);
    expect(harness.otherConsoleCalls).toEqual([]);
  });
});
