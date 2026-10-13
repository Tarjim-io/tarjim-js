import { describe, expect, it } from 'vitest';
import type { Meta } from '../src/index.js';
import {
  API_KEY,
  DELIVERY_URL,
  ROTATED_SIGNED_QUERY,
  SIGNED_QUERY,
  clientFor,
  fixtureResponse,
  hangUntilAborted,
  jsonFiles,
  problem,
  queryOf,
  respond,
  simpleRelease,
} from './support.js';
import type { Release, ReleaseOptions } from './support.js';

const IDENTITY = { language: 'fr', release: 18 };

function setup(options: ReleaseOptions = {}) {
  const release = simpleRelease(options);
  const files = jsonFiles(release);
  const en = release.manifest.slices['b1']!['en']!.json.hash;
  const fr = release.manifest.slices['b1']!['fr']!.json.hash;
  const metaRequests = () => release.requests.filter((r) => r.url.startsWith(`${DELIVERY_URL}?`));
  const objectRequests = (hash: string) => release.requests.filter((r) => r.url.includes(`${hash}.json`));
  return { release, files, en, fr, metaRequests, objectRequests };
}

type Answer = () => Response | Error;

/** Makes the old signature stop working for one slice, the way an expired one does. */
function rejectOldSignature(release: Release, hash: string, answer: Answer) {
  release.hook(({ kind, name, url }) =>
    kind === 'object' && name === `${hash}.json` && url.includes('Signature=S1') ? answer() : undefined,
  );
}

function rejectAlways(release: Release, hash: string, answer: Answer) {
  release.hook(({ kind, name }) => (kind === 'object' && name === `${hash}.json` ? answer() : undefined));
}

describe('the single re-read of the meta', () => {
  it.each<[string, Answer]>([
    ['403 from the edge', () => fixtureResponse('errors/object-403-cdn-edge.json')],
    ['404', () => fixtureResponse('errors/object-404-slice-not-found.json')],
    ['503', () => respond(503, '<html>busy</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['an opaque transport failure', () => new TypeError('Failed to fetch')],
  ])('re-reads once and retries the failed slice with the new signature after %s', async (_label, answer) => {
    const { release, files, en, fr, metaRequests, objectRequests } = setup();
    const stale = release.meta;
    rejectOldSignature(release, en, answer);
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });

    const { results, meta, reread } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(results.get(en)?.kind).toBe('verified');
    expect(results.get(fr)?.kind).toBe('verified');
    expect(reread).toBe(true);
    expect(meta.signedQuery).toBe(ROTATED_SIGNED_QUERY);

    expect(metaRequests()).toHaveLength(1);
    expect(queryOf(metaRequests()[0]!.url)).toMatchObject({
      appVersion: '1.4.0',
      platform: 'web',
      language: 'fr',
      release: '18',
    });
    expect(objectRequests(en).map((r) => r.url)).toEqual([
      `${stale.slicesBaseUrl}${en}.json?${SIGNED_QUERY}`,
      `${stale.slicesBaseUrl}${en}.json?${ROTATED_SIGNED_QUERY}`,
    ]);
    expect(objectRequests(fr)).toHaveLength(1);
  });

  it('sends the retry like any other CDN request, with no headers', async () => {
    const { release, files, en, objectRequests } = setup();
    const stale = release.meta;
    rejectOldSignature(release, en, () => respond(403, 'denied'));
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    const retry = objectRequests(en).slice(-1)[0]!;
    expect(retry.url).toContain(ROTATED_SIGNED_QUERY);
    expect('headers' in retry.init!).toBe(false);
    expect(retry.init).toMatchObject({ credentials: 'omit', redirect: 'error', mode: 'cors' });
    expect(retry.url).not.toContain(API_KEY);
  });

  it('re-reads only once when several slices fail, and retries them all', async () => {
    const { release, files, en, fr, metaRequests } = setup();
    const stale = release.meta;
    rejectOldSignature(release, en, () => respond(403, 'denied'));
    rejectOldSignature(release, fr, () => new TypeError('Failed to fetch'));
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });

    const { results } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(metaRequests()).toHaveLength(1);
    expect(results.get(en)?.kind).toBe('verified');
    expect(results.get(fr)?.kind).toBe('verified');
    expect(release.requests.filter((r) => r.url.includes(ROTATED_SIGNED_QUERY))).toHaveLength(2);
  });

  it('keeps the first outcome when the re-read returns the same signature, and does not retry', async () => {
    const { release, files, en, fr, metaRequests, objectRequests } = setup();
    rejectOldSignature(release, en, () => respond(403, 'denied'));

    const { results, meta } = await clientFor(release.fetch).fetchSlices(release.meta, files, IDENTITY);

    expect(metaRequests()).toHaveLength(1);
    expect(results.get(en)).toEqual({ kind: 'unfetchable', status: 403 });
    expect(results.get(fr)?.kind).toBe('verified');
    expect(objectRequests(en)).toHaveLength(1);
    expect(meta.signedQuery).toBe(SIGNED_QUERY);
  });

  it('keeps the first outcome and the input meta when the checksum changed', async () => {
    const { release, files, en, metaRequests, objectRequests } = setup();
    const stale = release.meta;
    rejectOldSignature(release, en, () => respond(403, 'denied'));
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY, checksum: 'f'.repeat(64) });

    const { results, meta } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(metaRequests()).toHaveLength(1);
    expect(results.get(en)).toEqual({ kind: 'unfetchable', status: 403 });
    expect(objectRequests(en)).toHaveLength(1);
    expect(meta).toBe(stale);
  });

  it.each<[string, Answer]>([
    ['a network failure', () => new TypeError('offline')],
    ['a 503', () => respond(503, 'busy')],
    ['a 429', () => respond(429, null)],
    ['an unbound meta', () => respond(200, { track: null })],
    ['an unreadable meta', () => respond(200, 'nope')],
  ])('keeps the first outcomes when the re-read itself ends in %s', async (_label, answer) => {
    const { release, files, en, metaRequests, objectRequests } = setup();
    const stale = release.meta;
    rejectOldSignature(release, en, () => respond(403, 'denied'));
    release.hook(({ kind }) => (kind === 'meta' ? answer() : undefined));

    const { results, meta } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(metaRequests()).toHaveLength(1);
    expect(results.get(en)).toEqual({ kind: 'unfetchable', status: 403 });
    expect(objectRequests(en)).toHaveLength(1);
    expect(meta).toBe(stale);
  });

  it('does not re-read a second time when the retry fails too', async () => {
    const { release, files, en, metaRequests, objectRequests } = setup();
    const stale = release.meta;
    rejectAlways(release, en, () => respond(403, 'denied'));
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });

    const { results } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(metaRequests()).toHaveLength(1);
    expect(objectRequests(en)).toHaveLength(2);
    expect(results.get(en)).toEqual({ kind: 'unfetchable', status: 403 });
  });

  it('retries only the unfetchable slice, not one that failed verification', async () => {
    const { release, files, en, fr, metaRequests, objectRequests } = setup({ tamper: { slices: { 'b1/fr': 'hash' } } });
    const stale = release.meta;
    rejectOldSignature(release, en, () => respond(403, 'denied'));
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });

    const { results } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(metaRequests()).toHaveLength(1);
    expect(results.get(en)?.kind).toBe('verified');
    expect(results.get(fr)).toEqual({ kind: 'hashMismatch' });
    expect(objectRequests(fr)).toHaveLength(1);
  });

  it.each([
    ['hash mismatch', { slices: { 'b1/en': 'hash' } }, { kind: 'hashMismatch' }],
    ['size mismatch', { slices: { 'b1/en': 'size' } }, { kind: 'sizeMismatch' }],
  ])('does not re-read after a %s', async (_label, tamper, expected) => {
    const { release, files, en, metaRequests, objectRequests } = setup({ tamper });
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    const stale = { ...release.meta, signedQuery: SIGNED_QUERY } as Meta;

    const { results, reread } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(results.get(en)).toEqual(expected);
    expect(metaRequests()).toHaveLength(0);
    expect(objectRequests(en)).toHaveLength(1);
    expect(reread).toBe(false);
  });

  it.each<[string, Answer]>([
    ['a 429', () => respond(429, null)],
    ['a 500', () => respond(500, 'x')],
    ['a 410', () => respond(410, 'x')],
  ])('does not re-read after %s', async (_label, answer) => {
    const { release, files, en, metaRequests, objectRequests } = setup();
    rejectAlways(release, en, answer);

    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, files, IDENTITY);

    expect(results.get(en)?.kind).not.toBe('verified');
    expect(metaRequests()).toHaveLength(0);
    expect(objectRequests(en)).toHaveLength(1);
  });

  it('does not re-read after a refused reference', async () => {
    const { release, files, metaRequests } = setup();
    const client = clientFor(release.fetch);
    expect([...(await client.fetchSlices(release.meta, files, IDENTITY)).results.values()].every((r) => r.kind === 'verified')).toBe(true);
    const before = release.requests.length;
    const meta = { ...release.meta, slicesBaseUrl: 'http://cdn.example.invalid/slices/' } as Meta;

    const { results, reread } = await client.fetchSlices(meta, files, IDENTITY);

    expect([...results.values()]).toEqual(files.map(() => ({ kind: 'refused' })));
    expect(metaRequests()).toHaveLength(0);
    expect(release.requests).toHaveLength(before);
    expect(reread).toBe(false);
  });

  it('does not re-read in origin mode, where a 404 is final', async () => {
    const { release, files, en, fr, metaRequests, objectRequests } = setup({ mode: 'origin' });
    rejectAlways(release, en, () => problem(404, 'delivery.object_not_found'));

    const { results, meta, reread } = await clientFor(release.fetch).fetchSlices(release.meta, files, IDENTITY);

    expect(results.get(en)).toEqual({ kind: 'unfetchable', status: 404 });
    expect(results.get(fr)?.kind).toBe('verified');
    expect(metaRequests()).toHaveLength(0);
    expect(objectRequests(en)).toHaveLength(1);
    expect(objectRequests(en)[0]!.init!.headers).toBeDefined();
    expect(reread).toBe(false);
    expect(meta).toBe(release.meta);
  });

  it('does not re-read in origin mode after a network failure either', async () => {
    const { release, files, en, metaRequests, objectRequests } = setup({ mode: 'origin' });
    rejectAlways(release, en, () => new TypeError('offline'));

    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, files, IDENTITY);

    expect(results.get(en)).toEqual({ kind: 'network' });
    expect(metaRequests()).toHaveLength(0);
    expect(objectRequests(en)).toHaveLength(1);
  });

  it('retries against the slices base of the re-read meta, not the old one', async () => {
    const { release, files, en, fr, objectRequests } = setup();
    const stale = release.meta;
    const moved = 'https://cdn2.example.invalid/releases/1/1/t1/slices/';
    rejectOldSignature(release, en, () => respond(403, 'denied'));
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY, slicesBaseUrl: moved });

    const { results, meta } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(results.get(en)?.kind).toBe('verified');
    expect(results.get(fr)?.kind).toBe('verified');
    expect(meta.slicesBaseUrl).toBe(moved);
    expect(objectRequests(en).map((r) => r.url)).toEqual([
      `${stale.slicesBaseUrl}${en}.json?${SIGNED_QUERY}`,
      `${moved}${en}.json?${ROTATED_SIGNED_QUERY}`,
    ]);
  });

  it('retries when only the slices base changed and the signature did not', async () => {
    const { release, files, en, objectRequests } = setup();
    const stale = release.meta;
    const moved = 'https://cdn2.example.invalid/releases/1/1/t1/slices/';
    release.hook(({ kind, url }) => (kind === 'object' && url.startsWith(stale.slicesBaseUrl) ? respond(403, 'denied') : undefined));
    release.setMeta({ slicesBaseUrl: moved });

    const { results } = await clientFor(release.fetch).fetchSlices(stale, files, IDENTITY);

    expect(results.get(en)?.kind).toBe('verified');
    expect(objectRequests(en).map((r) => r.url)).toContain(`${stale.slicesBaseUrl}${en}.json?${SIGNED_QUERY}`);
    expect(objectRequests(en).at(-1)!.url).toBe(`${moved}${en}.json?${SIGNED_QUERY}`);
  });

  it('spends the re-read on a slice that timed out', async () => {
    const { release, files, en, metaRequests, objectRequests } = setup();
    const stale = release.meta;
    release.hook(({ kind, name, nth, init }) =>
      kind === 'object' && name === `${en}.json` && nth === 0 ? hangUntilAborted(init) : undefined,
    );
    release.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });

    const { results, reread } = await clientFor(release.fetch, { timeoutMs: 40 }).fetchSlices(stale, files, IDENTITY);

    expect(reread).toBe(true);
    expect(metaRequests()).toHaveLength(1);
    expect(results.get(en)?.kind).toBe('verified');
    expect(objectRequests(en)).toHaveLength(2);
  });

  it('does not re-read after a redirected slice answer', async () => {
    const { release, files, en, metaRequests, objectRequests } = setup();
    rejectAlways(release, en, () => respond(200, '{}', { redirected: true }));

    const { results, reread } = await clientFor(release.fetch).fetchSlices(release.meta, files, IDENTITY);

    expect(results.get(en)).toEqual({ kind: 'network' });
    expect(reread).toBe(false);
    expect(metaRequests()).toHaveLength(0);
    expect(objectRequests(en)).toHaveLength(1);
  });
});
