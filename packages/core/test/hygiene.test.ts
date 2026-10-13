import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_KEY,
  ROTATED_SIGNED_QUERY,
  SIGNED_QUERY,
  clientFor,
  controlledStream,
  fixtureResponse,
  hangUntilAborted,
  jsonFiles,
  problem,
  recording,
  respond,
  serialise,
  simpleRelease,
} from './support.js';
import type { MetaOutcome } from '../src/index.js';

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const;

afterEach(() => vi.restoreAllMocks());

// The received meta legitimately carries the signature; every other outcome must not.
function outcomeText(outcome: MetaOutcome) {
  return serialise(outcome.kind === 'received' ? { kind: outcome.kind } : outcome);
}

function expectClean(text: string) {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain('Signature=');
  expect(text).not.toContain('Policy=');
  expect(text).not.toContain(SIGNED_QUERY);
  expect(text).not.toContain(ROTATED_SIGNED_QUERY);
  expect(text).not.toContain('example.invalid');
  expect(text).not.toContain('https://');
}

describe('key and signature hygiene', () => {
  it('leaks nothing into any outcome and never logs, across every path', async () => {
    const spies = CONSOLE_METHODS.map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    const texts: string[] = [];
    const kinds: string[] = [];

    const leakyError = (url: string, init: RequestInit) =>
      new TypeError(`Failed to fetch ${url} with ${JSON.stringify(init.headers)} ${API_KEY} ${SIGNED_QUERY}`);

    const metaRows = [
      () => fixtureResponse('errors/meta-401-unauthorized.json'),
      () => fixtureResponse('errors/meta-404-stage-unreleased.json'),
      () => fixtureResponse('errors/meta-429-too-many-requests.json'),
      () => fixtureResponse('errors/meta-503-cdn-edge.json'),
      () => problem(403, 'forbidden', { detail: `key ${API_KEY} at https://delivery.example.invalid/x?${SIGNED_QUERY}` }),
      () => respond(200, 'not json'),
      () => respond(200, { track: null }),
      () => respond(200, simpleRelease().meta, { redirected: true }),
    ];
    for (const row of metaRows) {
      const outcome = await clientFor(async () => row()).fetchMeta({ language: 'en' });
      kinds.push(outcome.kind);
      texts.push(outcomeText(outcome));
    }
    const thrown = await clientFor(async (url, init) => Promise.reject(leakyError(url, init))).fetchMeta({});
    kinds.push(thrown.kind);
    texts.push(outcomeText(thrown));
    const hung = await clientFor((_url, init) => hangUntilAborted(init), { timeoutMs: 20 }).fetchMeta({});
    kinds.push(hung.kind);
    texts.push(outcomeText(hung));
    const received = await clientFor(async () => respond(200, simpleRelease().meta)).fetchMeta({});
    kinds.push(received.kind);
    texts.push(outcomeText(received));

    const release = simpleRelease({ tamper: { manifest: true } });
    texts.push(serialise(await clientFor(release.fetch).fetchManifest(release.meta)));
    const failing = clientFor(async (url, init) => Promise.reject(leakyError(url, init)));
    texts.push(serialise(await failing.fetchManifest(release.meta)));
    const slices = simpleRelease();
    slices.hook(({ kind, url }) => (kind === 'object' && url.includes('Signature=S1') ? respond(403, `denied ${API_KEY}`) : undefined));
    slices.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    const stale = { ...slices.meta, signedQuery: SIGNED_QUERY };
    const reread = await clientFor(slices.fetch).fetchSlices(stale, jsonFiles(slices), { language: 'en' });
    texts.push(serialise({ results: reread.results, reread: reread.reread }));
    const refused = await clientFor(slices.fetch).fetchSlices({ ...stale, slicesBaseUrl: 'http://x.example.invalid/' }, jsonFiles(slices));
    texts.push(serialise({ results: refused.results }));
    const rawFailures = await failing.fetchSlices(stale, jsonFiles(slices));
    texts.push(serialise({ results: rawFailures.results }));

    expect(kinds).toEqual([
      'configuration', 'unreleased', 'throttled', 'server', 'configuration', 'unreadable', 'unbound', 'network',
      'network', 'network', 'received',
    ]);
    expect(texts.length).toBeGreaterThan(15);
    for (const text of texts) expectClean(text);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('never throws out of the client, whatever fetch does', async () => {
    const release = simpleRelease();
    const files = jsonFiles(release);
    const broken = [
      async () => {
        throw new Error(`boom ${API_KEY}`);
      },
      async () => undefined as unknown as Response,
      async () => ({ status: 200 }) as unknown as Response,
      async () => {
        const stream = controlledStream();
        stream.fail(new Error(`stream ${API_KEY}`));
        return stream.response;
      },
    ];
    for (const fetchFn of broken) {
      const client = clientFor(fetchFn, { timeoutMs: 30 });
      expect(await client.fetchMeta({})).toEqual({ kind: 'network' });
      expect(await client.fetchManifest(release.meta)).toEqual({ kind: 'network' });
      const { results } = await client.fetchSlices(release.meta, files);
      expect([...results.values()].every((r) => r.kind === 'network')).toBe(true);
    }
  });

  it('puts the key in a header of the meta request only, never in a URL', async () => {
    const served = recording('release-1');
    const client = clientFor(served.fetch, { deliveryUrl: served.deliveryUrl });
    const outcome = await client.fetchMeta({ installId: 'inst-1', language: 'en' });
    expect(outcome.kind).toBe('received');
    if (outcome.kind !== 'received') return;
    await client.fetchManifest(outcome.meta);

    expect(served.requests.length).toBe(2);
    for (const { url } of served.requests) expect(url).not.toContain(API_KEY);
    const [metaRequest, manifestRequest] = served.requests;
    expect(JSON.stringify(metaRequest!.init!.headers)).toContain(API_KEY);
    expect(manifestRequest!.init).not.toHaveProperty('headers');
  });
});
