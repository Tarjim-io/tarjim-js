import { describe, expect, it, vi } from 'vitest';
import { API_KEY, clientFor, headersOf, problem, queryOf, respond, simpleRelease } from './support.js';
import type { Meta } from '../src/internal.js';

const PUBLIC_URL = 'https://delivery.example.invalid/delivery/k3v9q2/meta';

function goodMeta(): Record<string, unknown> {
  return { ...simpleRelease().meta };
}

function answering(body: Record<string, unknown>) {
  return vi.fn(async () => respond(200, body));
}

describe('a meta with no polling interval', () => {
  it('is received when pollAfter is absent', async () => {
    const meta = goodMeta();
    delete meta['pollAfter'];

    const outcome = await clientFor(answering(meta)).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });

  it('is received when pollAfter is not a number, since it is never read', async () => {
    const outcome = await clientFor(answering({ ...goodMeta(), pollAfter: 'soon' })).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });
});

describe('the binding field', () => {
  it('accepts distribution where track was', async () => {
    const meta: Record<string, unknown> = { ...goodMeta(), distribution: 'mobile-app' };
    delete meta['track'];

    const outcome = await clientFor(answering(meta)).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });

  it('does not call a key unbound when distribution is present beside a null track', async () => {
    const outcome = await clientFor(answering({ ...goodMeta(), distribution: 'mobile-app', track: null })).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });

  it('accepts a meta that carries neither name', async () => {
    const meta = goodMeta();
    delete meta['track'];

    const outcome = await clientFor(answering(meta)).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });

  it('still stops on the null track a server sends for an unbound key', async () => {
    const outcome = await clientFor(answering({ ...goodMeta(), track: null })).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unbound' });
  });
});

describe('appVersion on the wire', () => {
  it('sends a padded version with suffix and leading zeros removed', async () => {
    const fetchFn = answering(goodMeta());
    await clientFor(fetchFn, { appVersion: 'v02.1-rc1' }).fetchMeta({});

    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain('?appVersion=2.1.0&');
  });

  it.each([
    ['nothing', undefined],
    ['text that holds no version', 'beta'],
    ['a component longer than nine digits', '1234567890.0.0'],
  ])('sends no appVersion for %s', async (_label, appVersion) => {
    const fetchFn = answering(goodMeta());
    await clientFor(fetchFn, appVersion === undefined ? { appVersion: undefined as unknown as string } : { appVersion }).fetchMeta({});

    const url = String((fetchFn.mock.calls[0] as unknown[])[0]);
    expect(queryOf(url)).not.toHaveProperty('appVersion');
    expect(url).toContain('?platform=web&');
  });

  it('keeps a nine digit component', async () => {
    const fetchFn = answering(goodMeta());
    await clientFor(fetchFn, { appVersion: '123456789.0.0' }).fetchMeta({});

    expect(queryOf(String((fetchFn.mock.calls[0] as unknown[])[0]))['appVersion']).toBe('123456789.0.0');
  });
});

describe('a client with no version', () => {
  it('sends no appVersion, and surfaces a 400 delivery.app_version_required as a configuration failure without asking again', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return problem(400, 'delivery.app_version_required');
    });

    const outcome = await clientFor(fetchFn, { appVersion: undefined as unknown as string }).fetchMeta({});

    expect(outcome).toEqual({ kind: 'configuration', status: 400, code: 'delivery.app_version_required' });
    expect(urls.map((url) => queryOf(url)['appVersion'])).toEqual([undefined]);
  });
});

describe('the identity sent with meta', () => {
  it('never carries pollSeconds', async () => {
    const fetchFn = answering(goodMeta());
    await clientFor(fetchFn).fetchMeta({ pollSeconds: 900, language: 'en' } as never);

    const query = queryOf(String((fetchFn.mock.calls[0] as unknown[])[0]));
    expect(query).not.toHaveProperty('pollSeconds');
    expect(query['language']).toBe('en');
  });
});

describe('an opaque public delivery URL', () => {
  it('is used as given, with a key that has no tenant in it', async () => {
    const fetchFn = answering(goodMeta());
    await clientFor(fetchFn, { deliveryUrl: PUBLIC_URL, apiKey: 'tj_prod_abcdefghijklmnopqrstuvwxyz' }).fetchMeta({});

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.split('?')[0]).toBe(PUBLIC_URL);
    expect(headersOf(init)['x-tarjim-apikey']).toBe('tj_prod_abcdefghijklmnopqrstuvwxyz');
    expect(url).not.toContain('tj_prod_');
  });

  it('resolves a relative manifest address against it, in origin mode', async () => {
    const release = simpleRelease({ mode: 'origin' });
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      return release.fetch(url.replace(/^.*\/released\/7\/manifest$/, new URL(release.meta.manifestUrl, release.deliveryUrl).href), init);
    });
    const meta: Meta = { ...release.meta, manifestUrl: 'released/7/manifest', authenticated: true };

    await clientFor(fetchFn, { deliveryUrl: PUBLIC_URL, apiKey: API_KEY }).fetchManifest(meta);

    expect(urls).toEqual(['https://delivery.example.invalid/delivery/k3v9q2/released/7/manifest']);
  });
});
