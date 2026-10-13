import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { API_VERSION, decodeManifest } from '../src/index.js';
import type { Meta, SliceFile } from '../src/index.js';
import {
  API_KEY,
  DELIVERY_URL,
  FIXTURES,
  SIGNED_QUERY,
  clientFor,
  fixtureResponse,
  headersOf,
  jsonFiles,
  problem,
  queryOf,
  recording,
  respond,
  sha256Hex,
  simpleRelease,
} from './support.js';

const objectRequests = (release: { requests: { url: string }[] }, marker: string) =>
  release.requests.filter((r) => r.url.includes(marker));

describe('manifest over the CDN', () => {
  it('requests the manifest URL plus the signature, with no headers and no credentials', async () => {
    const release = simpleRelease();
    const outcome = await clientFor(release.fetch).fetchManifest(release.meta);

    expect(outcome.kind).toBe('verified');
    expect(release.requests).toHaveLength(1);
    const { url, init } = release.requests[0]!;
    expect(url).toBe(`${release.meta.manifestUrl}?${SIGNED_QUERY}`);
    expect(init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error' });
    expect('headers' in init!).toBe(false);
    expect('cache' in init!).toBe(false);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the key and the identity query out of the URL', async () => {
    const release = simpleRelease();
    await clientFor(release.fetch).fetchManifest(release.meta);

    const { url } = release.requests[0]!;
    expect(url).not.toContain(API_KEY);
    expect(Object.keys(queryOf(url))).toEqual(['Policy', 'Signature', 'Key-Pair-Id']);
  });

  it('verifies the recorded release and returns the exact bytes', async () => {
    const served = recording('release-1');
    const outcome = await clientFor(served.fetch, { deliveryUrl: served.deliveryUrl }).fetchManifest(served.meta);

    expect(outcome.kind).toBe('verified');
    if (outcome.kind !== 'verified') return;
    const onDisk = readFileSync(`${FIXTURES}recorded/release-1/manifest.json`);
    expect(Buffer.from(outcome.bytes).equals(onDisk)).toBe(true);
    expect(Object.keys(outcome.manifest.slices['ns180']!)).toEqual(['ar', 'en', 'fr']);
  });

  it('reports a checksum mismatch and returns nothing else', async () => {
    const release = simpleRelease({ tamper: { manifest: true } });
    const outcome = await clientFor(release.fetch).fetchManifest(release.meta);

    expect(outcome).toEqual({ kind: 'checksumMismatch' });
    expect(release.requests).toHaveLength(1);
  });

  it('is unreadable when the hash matches but the body is not JSON', async () => {
    const text = 'definitely not json';
    const release = simpleRelease();
    const meta = { ...release.meta, checksum: sha256Hex(text) };
    const outcome = await clientFor(vi.fn(async () => respond(200, text))).fetchManifest(meta);

    expect(outcome).toEqual({ kind: 'unreadable' });
  });

  it('is unreadable when the hash matches but the JSON is not a manifest', async () => {
    const text = '{"hello":"world"}';
    const meta = { ...simpleRelease().meta, checksum: sha256Hex(text) };
    const outcome = await clientFor(vi.fn(async () => respond(200, text))).fetchManifest(meta);

    expect(outcome).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['403 from the edge', () => fixtureResponse('errors/object-403-cdn-edge.json'), { kind: 'unfetchable', status: 403 }],
    ['404', () => fixtureResponse('errors/manifest-404-manifest-not-found.json'), { kind: 'unfetchable', status: 404 }],
    ['503', () => fixtureResponse('errors/manifest-503-manifest-unavailable.json'), { kind: 'unfetchable', status: 503, retryAfter: 30 }],
    ['410', () => respond(410, 'gone'), { kind: 'unfetchable', status: 410 }],
    ['400', () => respond(400, 'bad'), { kind: 'unfetchable', status: 400 }],
    ['429 with a hint', () => respond(429, null, { headers: { 'Retry-After': '7' } }), { kind: 'throttled', retryAfter: 7 }],
    ['429 without one', () => respond(429, null), { kind: 'throttled' }],
    ['500', () => respond(500, 'oops'), { kind: 'server', status: 500 }],
    ['502 with a hint', () => respond(502, null, { headers: { 'Retry-After': '3' } }), { kind: 'server', status: 502, retryAfter: 3 }],
    ['a redirected answer', () => respond(200, '{}', { redirected: true }), { kind: 'network' }],
  ])('maps %s', async (_label, answer, expected) => {
    const meta = simpleRelease().meta;
    const outcome = await clientFor(vi.fn(async () => answer())).fetchManifest(meta);

    expect(outcome).toEqual(expected);
  });

  it('keeps the Retry-After hint on an unfetchable manifest', async () => {
    const meta = simpleRelease().meta;
    const outcome = await clientFor(vi.fn(async () => respond(503, null, { headers: { 'Retry-After': '9' } }))).fetchManifest(meta);

    expect(outcome).toEqual({ kind: 'unfetchable', status: 503, retryAfter: 9 });
  });

  it('is network when fetch rejects', async () => {
    const outcome = await clientFor(vi.fn(async () => Promise.reject(new TypeError('x')))).fetchManifest(simpleRelease().meta);

    expect(outcome).toEqual({ kind: 'network' });
  });
});

describe('an authenticated flag that is not exactly true', () => {
  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
  ])('takes the CDN path for %s: signature appended, no headers, key nowhere', async (_label, authenticated) => {
    const release = simpleRelease();
    const meta = { ...release.meta, authenticated } as unknown as Meta;
    const client = clientFor(release.fetch);
    const files = jsonFiles(release);

    expect((await client.fetchManifest(meta)).kind).toBe('verified');
    const { results } = await client.fetchSlices(meta, files, {});
    expect([...results.values()].every((r) => r.kind === 'verified')).toBe(true);

    expect(release.requests).toHaveLength(1 + files.length);
    for (const { url, init } of release.requests) {
      expect(url.endsWith(`?${SIGNED_QUERY}`)).toBe(true);
      expect('headers' in init!).toBe(false);
      expect(url).not.toContain(API_KEY);
      expect(JSON.stringify(init)).not.toContain(API_KEY);
    }
  });
});

describe('references the CDN path refuses', () => {
  async function refusedAndNeverRequested(patch: Partial<Record<keyof Meta, unknown>>, call: 'manifest' | 'slices') {
    const release = simpleRelease();
    const client = clientFor(release.fetch);
    const files = jsonFiles(release);

    const good = call === 'manifest' ? await client.fetchManifest(release.meta) : (await client.fetchSlices(release.meta, files, {})).results.get(files[0]!.hash);
    expect(good?.kind).toBe('verified');
    const before = release.requests.length;
    expect(before).toBeGreaterThan(0);

    const meta = { ...release.meta, ...patch } as Meta;
    if (call === 'manifest') {
      expect(await client.fetchManifest(meta)).toEqual({ kind: 'refused' });
    } else {
      const { results } = await client.fetchSlices(meta, files, {});
      expect([...results.values()]).toEqual(files.map(() => ({ kind: 'refused' })));
    }
    expect(release.requests).toHaveLength(before);
  }

  const badReferences: [string, string][] = [
    ['not https', 'http://cdn.example.invalid/releases/1/'],
    ['a protocol-relative one', '//cdn.example.invalid/releases/1/'],
    ['relative', 'releases/1/'],
    ['carrying a query', 'https://cdn.example.invalid/releases/1/?x=1'],
    ['carrying a fragment', 'https://cdn.example.invalid/releases/1/#top'],
    ['not a URL', 'https://cdn example.invalid/releases/1/'],
    ['a different scheme', 'ftp://cdn.example.invalid/releases/1/'],
  ];

  it.each(badReferences)('refuses a manifest reference that is %s', async (_label, reference) => {
    await refusedAndNeverRequested({ manifestUrl: reference + 'manifest.json' }, 'manifest');
  });

  it.each(badReferences)('refuses a slices base that is %s', async (_label, reference) => {
    await refusedAndNeverRequested({ slicesBaseUrl: reference }, 'slices');
  });

  it('refuses a slices base without a trailing slash, rather than running the hash into the path', async () => {
    await refusedAndNeverRequested({ slicesBaseUrl: 'https://cdn.example.invalid/releases/1/1/t1/slices' }, 'slices');
    await refusedAndNeverRequested({ slicesBaseUrl: 'https://cdn.example.invalid' }, 'slices');
  });

  it.each([
    ['a space', 'Policy=a b'],
    ['a fragment marker', 'Policy=a#b'],
    ['a quote', 'Policy="x"'],
    ['a newline', 'Policy=a\nb'],
    ['an empty string', ''],
  ])('refuses a signature with %s', async (_label, signedQuery) => {
    await refusedAndNeverRequested({ signedQuery }, 'manifest');
    await refusedAndNeverRequested({ signedQuery }, 'slices');
  });

  it('refuses a signature that is not a string', async () => {
    await refusedAndNeverRequested({ signedQuery: null }, 'manifest');
    await refusedAndNeverRequested({ signedQuery: 5 }, 'slices');
  });
});

describe('objects over the origin path', () => {
  it('sends both Tarjim headers to the manifest, resolved against the delivery URL, with no query', async () => {
    const release = simpleRelease({ mode: 'origin' });
    const outcome = await clientFor(release.fetch).fetchManifest(release.meta);

    expect(outcome.kind).toBe('verified');
    const { url, init } = release.requests[0]!;
    expect(url).toBe(new URL(release.meta.manifestUrl, DELIVERY_URL).href);
    expect(url).not.toContain('?');
    expect(headersOf(init)).toEqual({ 'x-tarjim-apikey': API_KEY, 'x-tarjim-api-version': API_VERSION });
    expect(init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error' });
  });

  it('sends both headers to every slice and never appends a signature', async () => {
    const release = simpleRelease({ mode: 'origin', metaOverrides: { signedQuery: 'Policy=ignored' } });
    const files = jsonFiles(release);
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, files, {});

    expect([...results.values()].map((r) => r.kind)).toEqual(['verified', 'verified']);
    expect(release.requests).toHaveLength(files.length);
    for (const { url, init } of release.requests) {
      expect(url).toBe(new URL(release.meta.slicesBaseUrl, DELIVERY_URL).href + url.split('/').pop());
      expect(url).not.toContain('?');
      expect(headersOf(init)['x-tarjim-apikey']).toBe(API_KEY);
      expect(headersOf(init)['x-tarjim-api-version']).toBe(API_VERSION);
    }
  });

  it('accepts an absolute reference on the same origin', async () => {
    const release = simpleRelease({ mode: 'origin', metaOverrides: { manifestUrl: 'https://delivery.example.invalid/releases/7/manifest.json' } });
    const outcome = await clientFor(release.fetch).fetchManifest(release.meta);

    expect(outcome.kind).toBe('verified');
    expect(release.requests[0]!.url).toBe('https://delivery.example.invalid/releases/7/manifest.json');
  });

  it('resolves a rooted reference against the origin only, whatever the delivery path holds', async () => {
    const deliveryUrl = 'https://delivery.example.invalid/a%20b/..%2fc/meta';
    const release = simpleRelease({ mode: 'origin', metaOverrides: { manifestUrl: '/releases/7/manifest.json' } });
    const client = clientFor(release.fetch, { deliveryUrl });
    await client.fetchManifest(release.meta);

    expect(release.requests[0]!.url).toBe('https://delivery.example.invalid/releases/7/manifest.json');
  });

  it.each([
    ['an absolute URL on another host', 'https://evil.example.invalid/releases/7/manifest.json'],
    ['a protocol-relative URL', '//evil.example.invalid/releases/7/manifest.json'],
    ['backslashes', '\\\\evil.example.invalid\\releases\\manifest.json'],
    ['a slash and a backslash', '/\\evil.example.invalid/manifest.json'],
    ['another scheme on the same host', 'http://delivery.example.invalid/releases/7/manifest.json'],
    ['another port', 'https://delivery.example.invalid:8443/releases/7/manifest.json'],
    ['a userinfo trick', 'https://delivery.example.invalid@evil.example.invalid/manifest.json'],
    ['something unparseable', 'http://[bad'],
  ])('refuses a manifest reference that is %s, and sends nothing', async (_label, manifestUrl) => {
    const release = simpleRelease({ mode: 'origin' });
    const client = clientFor(release.fetch);
    expect((await client.fetchManifest(release.meta)).kind).toBe('verified');
    expect(release.requests).toHaveLength(1);

    const outcome = await client.fetchManifest({ ...release.meta, manifestUrl });
    expect(outcome).toEqual({ kind: 'refused' });
    expect(release.requests).toHaveLength(1);
  });

  it.each([
    ['an absolute URL on another host', 'https://evil.example.invalid/slices/'],
    ['a protocol-relative URL', '//evil.example.invalid/slices/'],
    ['backslashes', '\\\\evil.example.invalid\\slices\\'],
  ])('refuses a slices base that is %s, and sends nothing', async (_label, slicesBaseUrl) => {
    const release = simpleRelease({ mode: 'origin' });
    const client = clientFor(release.fetch);
    const files = jsonFiles(release);
    expect([...(await client.fetchSlices(release.meta, files, {})).results.values()].every((r) => r.kind === 'verified')).toBe(true);
    const before = release.requests.length;

    const { results } = await client.fetchSlices({ ...release.meta, slicesBaseUrl }, files, {});
    expect([...results.values()]).toEqual(files.map(() => ({ kind: 'refused' })));
    expect(release.requests).toHaveLength(before);
  });
});

describe('origin mode with a delivery URL that is not http or https', () => {
  it.each([
    ['a file URL', 'file:///srv/tarjim/meta'],
    ['an ftp URL', 'ftp://delivery.example.invalid/meta'],
  ])('refuses every object for %s, and sends nothing', async (_label, deliveryUrl) => {
    const release = simpleRelease({ mode: 'origin' });
    const client = clientFor(release.fetch, { deliveryUrl });

    expect(await client.fetchManifest(release.meta)).toEqual({ kind: 'refused' });
    const files = jsonFiles(release);
    const { results } = await client.fetchSlices(release.meta, files, {});
    expect([...results.values()]).toEqual(files.map(() => ({ kind: 'refused' })));
    expect(release.requests).toHaveLength(0);
  });
});

describe('a slices base over the origin path', () => {
  it('is requested with a trailing slash and refused without one, sending nothing', async () => {
    const release = simpleRelease({ mode: 'origin' });
    const client = clientFor(release.fetch);
    const files = jsonFiles(release);
    expect([...(await client.fetchSlices(release.meta, files, {})).results.values()].every((r) => r.kind === 'verified')).toBe(true);
    const before = release.requests.length;

    const { results } = await client.fetchSlices({ ...release.meta, slicesBaseUrl: 'releases/7/slices' }, files, {});
    expect([...results.values()]).toEqual(files.map(() => ({ kind: 'refused' })));
    expect(release.requests).toHaveLength(before);
  });
});

describe('slices', () => {
  it('requests each slice at the base plus hash.json plus the signature, with no headers', async () => {
    const release = simpleRelease();
    const files = jsonFiles(release);
    const { results, meta, reread } = await clientFor(release.fetch).fetchSlices(release.meta, files, {});

    expect(release.requests.map((r) => r.url).sort()).toEqual(
      files.map((f) => `${release.meta.slicesBaseUrl}${f.hash}.json?${SIGNED_QUERY}`).sort(),
    );
    for (const { url, init } of release.requests) {
      expect(url).not.toContain(API_KEY);
      expect('headers' in init!).toBe(false);
      expect(init).toMatchObject({ mode: 'cors', credentials: 'omit', redirect: 'error' });
    }
    expect([...results.keys()].sort()).toEqual(files.map((f) => f.hash).sort());
    expect([...results.values()].every((r) => r.kind === 'verified')).toBe(true);
    expect(meta).toBe(release.meta);
    expect(reread).toBe(false);
  });

  it('verifies the slices of the recorded release and returns their exact bytes', async () => {
    const served = recording('release-1');
    const client = clientFor(served.fetch, { deliveryUrl: served.deliveryUrl });
    const manifestOutcome = await client.fetchManifest(served.meta);
    expect(manifestOutcome.kind).toBe('verified');
    if (manifestOutcome.kind !== 'verified') return;

    const files = Object.values(manifestOutcome.manifest.slices['ns180']!);
    const { results } = await client.fetchSlices(served.meta, files, {});

    expect(results.size).toBe(3);
    for (const file of files) {
      const outcome = results.get(file.hash);
      expect(outcome?.kind).toBe('verified');
      const onDisk = readFileSync(`${FIXTURES}recorded/release-1/objects/${file.hash}.json`);
      if (outcome?.kind === 'verified') expect(Buffer.from(outcome.bytes).equals(onDisk)).toBe(true);
    }
  });

  it('reports a hash mismatch without returning the bytes', async () => {
    const release = simpleRelease({ tamper: { slices: { 'b1/en': 'hash' } } });
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, jsonFiles(release), {});

    const en = results.get(release.manifest.slices['b1']!['en']!.json.hash);
    expect(en).toEqual({ kind: 'hashMismatch' });
    const fr = results.get(release.manifest.slices['b1']!['fr']!.json.hash);
    expect(fr?.kind).toBe('verified');
  });

  it('reports a size mismatch', async () => {
    const release = simpleRelease({ tamper: { slices: { 'b1/fr': 'size' } } });
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, jsonFiles(release), {});

    expect(results.get(release.manifest.slices['b1']!['fr']!.json.hash)).toEqual({ kind: 'sizeMismatch' });
    expect(results.get(release.manifest.slices['b1']!['en']!.json.hash)?.kind).toBe('verified');
  });

  it('fetches a hash listed twice once', async () => {
    const release = simpleRelease();
    const [first] = jsonFiles(release) as [SliceFile];
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, [first, { ...first }], {});

    expect(release.requests).toHaveLength(1);
    expect(results.size).toBe(1);
    expect(results.get(first.hash)?.kind).toBe('verified');
  });

  it('requests nothing for an empty list', async () => {
    const release = simpleRelease();
    const { results, reread } = await clientFor(release.fetch).fetchSlices(release.meta, [], {});

    expect(results.size).toBe(0);
    expect(reread).toBe(false);
    expect(release.requests).toHaveLength(0);
  });

  it('requests only the json files of a manifest that lists other types', async () => {
    const release = simpleRelease({ extraTypes: ['strings', 'stringsdict', 'xml'] });
    const manifest = decodeManifest(release.manifest);
    const files = Object.values(manifest!.slices['b1']!);
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, files, {});

    expect(release.requests).toHaveLength(2);
    expect(release.requests.every((r) => r.url.includes('.json?'))).toBe(true);
    expect([...results.values()].every((r) => r.kind === 'verified')).toBe(true);
  });

  it('requests all files in parallel', async () => {
    const release = simpleRelease();
    let inFlight = 0;
    let peak = 0;
    release.hook(async ({ kind }) => {
      if (kind !== 'object') return;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
    });
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, jsonFiles(release), {});

    expect(peak).toBe(2);
    expect([...results.values()].every((r) => r.kind === 'verified')).toBe(true);
  });

  it.each([
    ['a 429 with a hint', () => respond(429, null, { headers: { 'Retry-After': '5' } }), { kind: 'throttled', retryAfter: 5 }],
    ['a 500', () => respond(500, 'x'), { kind: 'server', status: 500 }],
    ['a 410', () => respond(410, 'x'), { kind: 'unfetchable', status: 410 }],
    ['a redirected answer', () => respond(200, 'x', { redirected: true }), { kind: 'network' }],
  ])('maps %s per file without a re-read', async (_label, answer, expected) => {
    const release = simpleRelease();
    const files = jsonFiles(release);
    const fetchFn = vi.fn(async () => answer());
    const { results, reread } = await clientFor(fetchFn).fetchSlices(release.meta, files, {});

    expect([...results.values()]).toEqual(files.map(() => expected));
    expect(fetchFn).toHaveBeenCalledTimes(files.length);
    expect(reread).toBe(false);
  });

  it('keeps a 404 problem body from leaking into the outcome', async () => {
    const release = simpleRelease({ mode: 'origin' });
    release.hook(({ kind }) => (kind === 'object' ? problem(404, 'delivery.object_not_found') : undefined));
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, jsonFiles(release), {});

    expect([...results.values()]).toEqual([
      { kind: 'unfetchable', status: 404 },
      { kind: 'unfetchable', status: 404 },
    ]);
  });
});
