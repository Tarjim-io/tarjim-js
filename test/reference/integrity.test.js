import { describe, expect, it } from 'vitest';
import {
  ROTATED_SIGNED_QUERY,
  buildRelease,
  leaf,
  makeSlice,
  problem,
  respond,
  requestsOfKind,
} from '../helpers/fake-delivery.js';
import { basicRelease, createHarness, startClient } from '../helpers/harness.js';

const TWO_BUNDLES = {
  bundles: {
    ns1: { type: 'namespace', name: 'default' },
    ns2: { type: 'custom', name: 'extras' },
  },
  slices: {
    ns1: { en: makeSlice('ns1', 'en', { 'app.title': leaf(1, 'Tarjim') }) },
    ns2: { en: makeSlice('ns2', 'en', { 'extra.key': leaf(2, 'Extra') }) },
  },
};
const EXTRAS = { type: 'custom', name: 'extras' };

describe('slice integrity', () => {
  it.each(['hash', 'size'])('never serves a slice whose %s does not match the manifest', async (kind) => {
    const tampered = basicRelease({ tamper: { slices: { 'ns1/en': kind } } });
    const bad = await startClient(tampered);
    expect(bad.client.t('app.title')).toBe('app.title');
    expect(bad.client.active).toBe(false);
    expect(bad.codes().filter((code) => code === 'slice-integrity')).toHaveLength(1);

    const good = await startClient(basicRelease());
    expect(good.client.t('app.title')).toBe('Tarjim');
    expect(good.client.active).toBe(true);
    expect(good.reports).toEqual([]);
  });

  it('lets one failed slot leave the others working', async () => {
    const release = buildRelease({ ...TWO_BUNDLES, tamper: { slices: { 'ns2/en': 'hash' } } });
    const { client, codes } = await startClient(release);
    expect(client.active).toBe(true);
    expect(client.t('app.title')).toBe('Tarjim');
    expect(client.t('extra.key', undefined, { bundle: EXTRAS })).toBe('extra.key');
    expect(codes()).toEqual(['slice-integrity']);
  });

  it('fetches every bundle the manifest lists for the selected locale', async () => {
    const release = buildRelease(TWO_BUNDLES);
    const { client } = await startClient(release);
    expect(requestsOfKind(release, 'object')).toHaveLength(2);
    expect(client.t('extra.key', undefined, { bundle: EXTRAS })).toBe('Extra');
  });

  it('makes a slice with an unknown schema version unreadable and reports it once per version', async () => {
    const release = buildRelease({
      bundles: { ns1: { type: 'namespace', name: 'default' }, ns2: { type: 'custom', name: 'a' }, ns3: { type: 'custom', name: 'b' } },
      slices: {
        ns1: { en: makeSlice('ns1', 'en', { k: leaf(1, 'one') }) },
        ns2: { en: makeSlice('ns2', 'en', { k: leaf(2, 'two') }, { schemaVersion: 2 }) },
        ns3: { en: makeSlice('ns3', 'en', { k: leaf(3, 'three') }, { schemaVersion: 2 }) },
      },
    });
    const { client, codes } = await startClient(release);
    expect(client.t('k')).toBe('one');
    expect(client.t('k', undefined, { bundle: { type: 'custom', name: 'a' } })).toBe('k');
    expect(codes()).toEqual(['slice-schema']);
  });
});

describe('manifest integrity', () => {
  it('goes inactive and reports when the manifest does not match the meta checksum, and fetches no slice', async () => {
    const tampered = basicRelease({ tamper: { manifest: true } });
    const bad = await startClient(tampered);
    expect(bad.client.active).toBe(false);
    expect(bad.client.t('app.title')).toBe('app.title');
    expect(bad.codes()).toEqual(['manifest-integrity']);
    expect(requestsOfKind(tampered, 'object')).toHaveLength(0);

    const good = await startClient(basicRelease());
    expect(good.client.active).toBe(true);
    expect(good.client.t('app.title')).toBe('Tarjim');
  });

  it('goes inactive and reports a manifest with an unknown schema version', async () => {
    const release = basicRelease({ manifestOverrides: { schemaVersion: 2 } });
    const { client, codes } = await startClient(release);
    expect(client.active).toBe(false);
    expect(codes()).toEqual(['manifest-schema']);
    expect(requestsOfKind(release, 'object')).toHaveLength(0);
  });
});

describe('meta problems', () => {
  it('goes inactive with a meta-schema report for an unknown meta schema version, without fetching more', async () => {
    const release = basicRelease({ metaOverrides: { schemaVersion: 2 } });
    const { client, codes } = await startClient(release);
    expect(client.active).toBe(false);
    expect(codes()).toEqual(['meta-schema']);
    expect(release.requests).toHaveLength(1);
  });

  it('reports a meta-status with the status and problem code', async () => {
    const release = basicRelease({
      hooks: [({ kind }) => (kind === 'meta' ? problem(403, 'delivery.forbidden') : undefined)],
    });
    const { client, reports } = await startClient(release);
    expect(client.active).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ code: 'meta-status', status: 403 });
    expect(JSON.stringify(reports[0])).toContain('delivery.forbidden');
  });

  it('names the problem code in the problemCode field and nothing else of the body', async () => {
    const release = basicRelease({
      hooks: [({ kind }) => (kind === 'meta' ? problem(403, 'delivery.forbidden', { detail: 'secret detail' }) : undefined)],
    });
    const { reports } = await startClient(release);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ code: 'meta-status', status: 403, problemCode: 'delivery.forbidden' });
    expect(JSON.stringify(reports[0])).not.toContain('secret detail');

    const plain = basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(502, 'Bad gateway') : undefined)] });
    expect('problemCode' in (await startClient(plain)).reports[0]).toBe(false);
  });

  it('reports a meta-status without a problem code when the body is not JSON', async () => {
    const release = basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? respond(502, 'Bad gateway') : undefined)] });
    const { client, reports } = await startClient(release);
    expect(client.active).toBe(false);
    expect(reports[0]).toMatchObject({ code: 'meta-status', status: 502 });
  });

  it('treats an unreleased stage as normal: inactive and no report', async () => {
    const release = basicRelease({
      hooks: [({ kind }) => (kind === 'meta' ? problem(404, 'delivery.stage_unreleased') : undefined)],
    });
    const { client, reports } = await startClient(release);
    expect(client.active).toBe(false);
    expect(reports).toEqual([]);

    const other = basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? problem(404, 'delivery.not_found') : undefined)] });
    expect((await startClient(other)).codes()).toEqual(['meta-status']);
  });

  it.each([
    ['not JSON', () => respond(200, 'hello')],
    ['an empty object', () => respond(200, '{}')],
    ['a JSON array', () => respond(200, '[]')],
    ['JSON null', () => respond(200, 'null')],
  ])('reports meta-invalid for a meta that is %s', async (_, answer) => {
    const release = basicRelease({ hooks: [({ kind }) => (kind === 'meta' ? answer() : undefined)] });
    const { client, codes } = await startClient(release);
    expect(client.active).toBe(false);
    expect(codes()).toEqual(['meta-invalid']);
  });

  it('reports meta-invalid when the meta lacks its manifest address', async () => {
    const release = basicRelease({ metaOverrides: { manifestUrl: undefined } });
    const { client, codes } = await startClient(release);
    expect(client.active).toBe(false);
    expect(codes()).toEqual(['meta-invalid']);
  });
});

describe('unbound key', () => {
  it('is inactive with a report and no manifest request when the meta has no track', async () => {
    const unbound = basicRelease({ metaOverrides: { track: null } });
    const bad = await startClient(unbound);
    expect(bad.client.active).toBe(false);
    expect(bad.client.t('app.title')).toBe('app.title');
    expect(bad.codes()).toEqual(['unbound-key']);
    expect(requestsOfKind(unbound, 'manifest')).toHaveLength(0);
    expect(requestsOfKind(unbound, 'object')).toHaveLength(0);

    const allowed = basicRelease({ metaOverrides: { track: null } });
    const good = await startClient(allowed, { config: { allowUnboundKey: true } });
    expect(good.client.active).toBe(true);
    expect(good.client.t('app.title')).toBe('Tarjim');
    expect(good.codes()).toEqual([]);
  });
});

describe('insecure context', () => {
  it.each([
    ['no crypto at all', undefined],
    ['crypto without subtle', {}],
  ])('goes inactive with a report and makes no request with %s', async (_, crypto) => {
    const release = basicRelease();
    const harness = createHarness(release, { globals: { crypto } });
    const client = await harness.start();
    expect(client.active).toBe(false);
    expect(harness.codes()).toEqual(['insecure-context']);
    expect(release.requests).toHaveLength(0);

    const secure = await startClient(basicRelease());
    expect(secure.client.active).toBe(true);
  });
});

describe('locale unavailable', () => {
  it('goes inactive and reports when neither the language nor the fallback is in the manifest', async () => {
    const release = basicRelease();
    const { client, codes } = await startClient(release, { config: { language: 'de', fallbackLanguage: 'fr' } });
    expect(client.active).toBe(false);
    expect(client.language).toBe(null);
    expect(codes()).toEqual(['locale-unavailable']);
    expect(requestsOfKind(release, 'object')).toHaveLength(0);
  });
});

describe('re-reading the meta after an object failure (CDN)', () => {
  const rotateOnFirstObject = (release, failure) =>
    release.hook(({ kind, nth }) => {
      if (kind === 'object' && nth === 0) {
        release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
        return failure();
      }
    });

  it.each([
    ['403', () => respond(403, '')],
    ['404', () => problem(404, 'delivery.object_not_found')],
    ['503', () => respond(503, '')],
    ['a network error', () => new TypeError('Failed to fetch')],
    ['an opaque redirect', () => respond(200, '{}', { type: 'opaqueredirect' })],
  ])('re-reads the meta exactly once and retries the object with the new signature after %s', async (_, failure) => {
    const release = basicRelease();
    rotateOnFirstObject(release, failure);
    const { client, reports } = await startClient(release);

    expect(requestsOfKind(release, 'meta')).toHaveLength(2);
    const objects = requestsOfKind(release, 'object');
    expect(objects).toHaveLength(2);
    expect(objects[0].url).toMatch(/Signature=S1/);
    expect(objects[1].url).toMatch(/Signature=S2/);
    expect(objects[1].url.split('?')[0]).toBe(objects[0].url.split('?')[0]);
    expect(requestsOfKind(release, 'manifest')).toHaveLength(1);
    expect(client.t('app.title')).toBe('Tarjim');
    expect(reports).toEqual([]);
  });

  it('makes the re-read the same request as the first meta read', async () => {
    const release = basicRelease();
    rotateOnFirstObject(release, () => respond(403, ''));
    await startClient(release);
    const [first, second] = requestsOfKind(release, 'meta');
    expect(second.url).toBe(first.url);
    expect({ ...second.init, signal: undefined }).toEqual({ ...first.init, signal: undefined });
  });

  it('never re-reads a second time when the retried object fails too', async () => {
    const release = basicRelease({ hooks: [({ kind }) => (kind === 'object' ? respond(403, '') : undefined)] });
    release.hook(({ kind, nth }) => {
      if (kind === 'object' && nth === 0) release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    });
    const { client, codes } = await startClient(release);

    expect(requestsOfKind(release, 'meta')).toHaveLength(2);
    expect(requestsOfKind(release, 'object')).toHaveLength(2);
    expect(client.active).toBe(false);
    expect(client.t('app.title')).toBe('app.title');
    expect(codes()).toEqual(['object-unavailable']);
  });

  it('shares one re-read between several failing objects and retries only the failed ones', async () => {
    const release = buildRelease(TWO_BUNDLES);
    const failing = release.objectName('ns2', 'en');
    release.hook(({ kind, name, nth }) => {
      if (kind === 'object' && name === failing && nth === 0) {
        release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
        return respond(403, '');
      }
    });
    const { client, reports } = await startClient(release);

    expect(requestsOfKind(release, 'meta')).toHaveLength(2);
    const objects = requestsOfKind(release, 'object');
    expect(objects).toHaveLength(3);
    expect(objects.filter(({ url }) => url.includes(release.objectName('ns1', 'en')))).toHaveLength(1);
    expect(client.t('extra.key', undefined, { bundle: EXTRAS })).toBe('Extra');
    expect(reports).toEqual([]);
  });

  it('does not re-read a second time for a later failure in the same start', async () => {
    const release = buildRelease(TWO_BUNDLES);
    const first = release.objectName('ns1', 'en');
    const second = release.objectName('ns2', 'en');
    release.hook(({ kind, name, url }) => {
      if (kind !== 'object') return;
      if (name === first && url.includes('Signature=S1')) {
        release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
        return respond(403, '');
      }
      if (name === second) return respond(403, '');
    });
    const { client, codes } = await startClient(release);
    expect(requestsOfKind(release, 'meta')).toHaveLength(2);
    expect(client.t('app.title')).toBe('Tarjim');
    expect(client.t('extra.key', undefined, { bundle: EXTRAS })).toBe('extra.key');
    expect(codes()).toEqual(['object-unavailable']);
  });

  it('gives up on the failed slots, without restarting, when the re-read meta has a different checksum', async () => {
    const release = buildRelease(TWO_BUNDLES);
    const failing = release.objectName('ns2', 'en');
    release.hook(({ kind, name, nth }) => {
      if (kind === 'object' && name === failing && nth === 0) {
        release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY, checksum: 'ab'.repeat(32) });
        return respond(403, '');
      }
    });
    const { client, codes } = await startClient(release);

    expect(requestsOfKind(release, 'meta')).toHaveLength(2);
    expect(requestsOfKind(release, 'manifest')).toHaveLength(1);
    expect(requestsOfKind(release, 'object').filter(({ url }) => url.includes(failing))).toHaveLength(1);
    expect(client.t('app.title')).toBe('Tarjim');
    expect(client.t('extra.key', undefined, { bundle: EXTRAS })).toBe('extra.key');
    expect(codes()).toEqual(['object-unavailable']);
  });

  it('does not retry when the re-read meta carries the same signature', async () => {
    const release = basicRelease({ hooks: [({ kind }) => (kind === 'object' ? respond(403, '') : undefined)] });
    const { client, codes } = await startClient(release);
    expect(requestsOfKind(release, 'meta')).toHaveLength(2);
    expect(requestsOfKind(release, 'object')).toHaveLength(1);
    expect(client.active).toBe(false);
    expect(codes()).toEqual(['object-unavailable']);
  });
});

describe('object failures in origin mode', () => {
  it.each([403, 404, 503])('marks the slot unavailable after a %i without re-reading the meta', async (status) => {
    const release = buildRelease({ ...TWO_BUNDLES, mode: 'origin' });
    const failing = release.objectName('ns2', 'en');
    release.hook(({ kind, name }) => (kind === 'object' && name === failing ? respond(status, '') : undefined));
    const { client } = await startClient(release);

    expect(requestsOfKind(release, 'meta')).toHaveLength(1);
    expect(requestsOfKind(release, 'object')).toHaveLength(2);
    expect(client.active).toBe(true);
    expect(client.t('app.title')).toBe('Tarjim');
    expect(client.t('extra.key', undefined, { bundle: EXTRAS })).toBe('extra.key');
  });
});

describe('every slot that cannot be loaded is reported', () => {
  const failures = [
    ['a 500', () => respond(500, 'oops')],
    ['a 429', () => problem(429, 'delivery.rate_limited')],
    ['a network error', () => new TypeError('Failed to fetch')],
  ];

  describe.each(['cdn', 'origin'])('in %s mode', (mode) => {
    it.each(failures)('reports object-unavailable for %s on a slice', async (_, answer) => {
      const release = basicRelease({ mode, hooks: [({ kind }) => (kind === 'object' ? answer() : undefined)] });
      const { client, codes } = await startClient(release);
      expect(client.active).toBe(false);
      expect(client.t('app.title')).toBe('app.title');
      expect(codes()).toEqual(['object-unavailable']);
    });
  });

  describe.each([
    ['cdn', 'https://[bad/'],
    ['origin', 'http://[bad/'],
  ])('a slice address that is not a URL in %s mode', (mode, slicesBaseUrl) => {
    it('reports meta-invalid, still resolves and fetches no slice', async () => {
      const release = basicRelease({ mode, metaOverrides: { slicesBaseUrl } });
      const { client, reports } = await startClient(release);
      expect(client.active).toBe(false);
      expect(reports.map((report) => report.code)).toEqual(['meta-invalid']);
      expect(release.requests).toHaveLength(2);
    });
  });

  it.each([
    ['cdn', 'http://[bad/manifest.json'],
    ['cdn', 'http://cdn.example.invalid/manifest.json'],
    ['origin', 'http://[bad/manifest.json'],
  ])('reports meta-invalid for a manifest address that is unusable in %s mode (%s)', async (mode, manifestUrl) => {
    const release = basicRelease({ mode, metaOverrides: { manifestUrl } });
    const { client, codes } = await startClient(release);
    expect(client.active).toBe(false);
    expect(codes()).toEqual(['meta-invalid']);
    expect(release.requests).toHaveLength(1);
  });

  it('reports meta-invalid and sends no request to another origin in origin mode', async () => {
    const elsewhere = 'https://elsewhere.example.invalid/';
    for (const overrides of [{ manifestUrl: `${elsewhere}manifest.json` }, { slicesBaseUrl: `${elsewhere}slices/` }]) {
      const release = basicRelease({ mode: 'origin', metaOverrides: overrides });
      const { client, codes } = await startClient(release);
      expect(client.active).toBe(false);
      expect(codes()).toEqual(['meta-invalid']);
      for (const { url } of release.requests) expect(url.startsWith('https://delivery.example.invalid/')).toBe(true);
    }
  });
});

describe('the delivery mode', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'true'],
    ['a number', 1],
    ['false', false],
  ])('is CDN mode when authenticated is %s', async (_, authenticated) => {
    const release = basicRelease({ metaOverrides: { authenticated } });
    const { client, reports } = await startClient(release);
    expect(client.active).toBe(true);
    expect(client.t('app.title')).toBe('Tarjim');
    expect(reports).toEqual([]);
    for (const { url, init } of [...requestsOfKind(release, 'manifest'), ...requestsOfKind(release, 'object')]) {
      expect(url).toContain('Signature=S1');
      expect(init.headers).toBeUndefined();
    }
  });
});
