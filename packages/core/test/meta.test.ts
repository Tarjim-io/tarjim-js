import { describe, expect, it, vi } from 'vitest';
import type { MetaIdentity } from '../src/index.js';
import { API_VERSION, SDK_VERSION } from '../src/index.js';
import {
  API_KEY,
  DELIVERY_URL,
  clientFor,
  controlledStream,
  envelope,
  fixtureResponse,
  hangUntilAborted,
  headersOf,
  problem,
  queryOf,
  recording,
  respond,
  simpleRelease,
  sleep,
} from './support.js';

function answering(response: () => Response | Promise<Response>) {
  return vi.fn(async (_url: string, _init: RequestInit) => response());
}

function bodyOf(file: string): Record<string, unknown> {
  return JSON.parse(envelope(file).body) as Record<string, unknown>;
}

const goodMeta = () => ({ ...simpleRelease().meta });

describe('the meta request', () => {
  it('sends exactly the two Tarjim headers and nothing conditional', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    const outcome = await clientFor(fetchFn).fetchMeta({});

    expect(outcome.kind).toBe('received');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0]![1];
    expect(headersOf(init)).toEqual({ 'x-tarjim-apikey': API_KEY, 'x-tarjim-api-version': API_VERSION });
  });

  it('asks the browser for an uncached, credential-free, non-redirecting cors request', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    await clientFor(fetchFn).fetchMeta({});

    const init = fetchFn.mock.calls[0]![1];
    expect(init).toMatchObject({
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('puts appVersion first, raw, then platform and sdkVersion', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    await clientFor(fetchFn).fetchMeta({});

    expect(fetchFn.mock.calls[0]![0]).toBe(`${DELIVERY_URL}?appVersion=1.4.0&platform=web&sdkVersion=${SDK_VERSION}`);
  });

  it('normalises the app version itself, so a build suffix never reaches the wire', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    await clientFor(fetchFn, { appVersion: '1.4.0+7' }).fetchMeta({});

    expect(fetchFn.mock.calls[0]![0]).toContain('?appVersion=1.4.0&platform=web');
    expect(fetchFn.mock.calls[0]![0]).not.toContain('%2B');
  });

  it('cannot be made to inject a parameter through the app version', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    await clientFor(fetchFn, { appVersion: '1.2&release=9' }).fetchMeta({});

    const url = fetchFn.mock.calls[0]![0];
    expect(url).toBe(`${DELIVERY_URL}?appVersion=1.2.0&platform=web&sdkVersion=${SDK_VERSION}`);
    expect(queryOf(url)).not.toHaveProperty('release');
  });

  it('adds every present identity field in a fixed order, encoded', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    const identity: MetaIdentity = {
      installId: 'inst-1',
      appBuild: '42 beta',
      osVersion: 'macOS 14&15',
      language: 'zh-Hant HK',
      pollSeconds: 900,
      release: 0,
    };
    await clientFor(fetchFn).fetchMeta(identity);

    expect(fetchFn.mock.calls[0]![0]).toBe(
      `${DELIVERY_URL}?appVersion=1.4.0&platform=web&sdkVersion=${SDK_VERSION}` +
        '&release=0&pollSeconds=900&language=zh-Hant%20HK&osVersion=macOS%2014%2615&appBuild=42%20beta&installId=inst-1',
    );
  });

  it('sends a string release id as given', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    await clientFor(fetchFn).fetchMeta({ release: 'r-18' });

    expect(queryOf(fetchFn.mock.calls[0]![0])['release']).toBe('r-18');
  });

  it('leaves out identity fields that are absent, installId included', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    await clientFor(fetchFn).fetchMeta({ language: 'fr' });

    const query = queryOf(fetchFn.mock.calls[0]![0]);
    expect(Object.keys(query)).toEqual(['appVersion', 'platform', 'sdkVersion', 'language']);
    expect(query['language']).toBe('fr');
    expect(query).not.toHaveProperty('installId');
  });

  it('works with no identity argument at all', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    const outcome = await clientFor(fetchFn).fetchMeta();

    expect(outcome.kind).toBe('received');
    expect(Object.keys(queryOf(fetchFn.mock.calls[0]![0]))).toEqual(['appVersion', 'platform', 'sdkVersion']);
  });

  it('never sends a parameter outside the named list and never puts the key in the URL', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    const identity = { language: 'en', apiKey: API_KEY, track: 'web', extra: 'x' } as MetaIdentity;
    await clientFor(fetchFn).fetchMeta(identity);

    const url = fetchFn.mock.calls[0]![0];
    expect(Object.keys(queryOf(url))).toEqual(['appVersion', 'platform', 'sdkVersion', 'language']);
    expect(url).not.toContain(API_KEY);
  });

  it('uses the delivery URL verbatim and the platform it was given', async () => {
    const fetchFn = answering(() => respond(200, goodMeta()));
    await clientFor(fetchFn, { deliveryUrl: 'http://localhost:3000/t/9/meta', platform: 'web-test' }).fetchMeta({});

    expect(fetchFn.mock.calls[0]![0]).toBe(
      `http://localhost:3000/t/9/meta?appVersion=1.4.0&platform=web-test&sdkVersion=${SDK_VERSION}`,
    );
  });
});

describe('a 200 answer', () => {
  it('hands back the decoded meta, every field, when it is complete', async () => {
    const meta = goodMeta();
    const outcome = await clientFor(answering(() => respond(200, meta))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'received', meta });
  });

  it('accepts the recorded CDN meta', async () => {
    const served = recording('release-1');
    const outcome = await clientFor(served.fetch, { deliveryUrl: served.deliveryUrl }).fetchMeta({});

    expect(outcome.kind).toBe('received');
    if (outcome.kind === 'received') expect(outcome.meta.releaseId).toBe(18);
  });

  it('accepts an authenticated meta that carries no signature', async () => {
    const meta = { ...simpleRelease({ mode: 'origin' }).meta };
    const outcome = await clientFor(answering(() => respond(200, meta))).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });

  it('accepts a string release id and a schema version it does not know', async () => {
    const meta = { ...goodMeta(), releaseId: 'r-1', schemaVersion: 99 };
    const outcome = await clientFor(answering(() => respond(200, meta))).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });

  it('is unbound for the recorded meta that has no track', async () => {
    const served = recording('unbound-latest');
    const outcome = await clientFor(served.fetch, { deliveryUrl: served.deliveryUrl }).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unbound' });
  });

  it.each([
    ['null', { track: null }],
    ['missing', {}],
    ['a number', { track: 5 }],
    ['an object', { track: { name: 'web' } }],
  ])('is unbound when track is %s, and makes no further request', async (_label, patch) => {
    const meta: Record<string, unknown> = { ...goodMeta(), ...patch };
    if (!('track' in patch)) delete meta['track'];
    const fetchFn = answering(() => respond(200, meta));
    const outcome = await clientFor(fetchFn).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unbound' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('decides unbound before it checks the rest of the meta', async () => {
    const outcome = await clientFor(answering(() => respond(200, { track: null }))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unbound' });
  });

  it.each([
    ['a checksum that is not 64 lower-case hex', { checksum: 'ABC' }],
    ['an upper-case checksum', { checksum: 'A'.repeat(64) }],
    ['a missing manifestUrl', { manifestUrl: undefined }],
    ['a missing slicesBaseUrl', { slicesBaseUrl: undefined }],
    ['a non-numeric schemaVersion', { schemaVersion: '1' }],
    ['a missing pollAfter', { pollAfter: undefined }],
    ['a missing releaseId', { releaseId: undefined }],
    ['an unsigned unauthenticated meta', { signedQuery: null }],
    ['an empty signedQuery', { signedQuery: '' }],
  ])('is unreadable with %s', async (_label, patch) => {
    const meta = { ...goodMeta(), ...patch };
    const outcome = await clientFor(answering(() => respond(200, meta))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['text', 'not json at all'],
    ['an array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['null', 'null'],
    ['an empty body', ''],
  ])('is unreadable when the body is %s', async (_label, body) => {
    const outcome = await clientFor(answering(() => respond(200, body))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unreadable' });
  });
});

describe('problem answers', () => {
  it('is unreleased for a stage with nothing released, with the poll hint', async () => {
    const outcome = await clientFor(answering(() => fixtureResponse('errors/meta-404-stage-unreleased.json'))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unreleased', pollAfter: 900 });
  });

  it.each(['delivery.track_unreleased', 'delivery.not_published'])('is unreleased for %s', async (code) => {
    const outcome = await clientFor(answering(() => problem(404, code, { pollAfter: 300 }))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unreleased', pollAfter: 300 });
  });

  it('is unreleased without a hint when none is given', async () => {
    const outcome = await clientFor(answering(() => problem(404, 'delivery.stage_unreleased'))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unreleased' });
  });

  it.each([
    'errors/meta-400-app-version-required.json',
    'errors/meta-400-validation.json',
    'errors/meta-401-unauthorized.json',
    'errors/meta-403-apikey-project-mismatch.json',
    'errors/meta-403-forbidden.json',
    'errors/meta-404-not-found.json',
  ])('is a configuration problem for %s, with its status and code', async (file) => {
    const row = envelope(file);
    const code = (JSON.parse(row.body) as { code: string }).code;
    const outcome = await clientFor(answering(() => fixtureResponse(file))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'configuration', status: row.status, code });
  });

  it.each(['errors/meta-404-stage-not-found.json', 'errors/meta-404-track-not-found.json'])(
    'carries the poll hint of %s on a configuration problem',
    async (file) => {
      const body = bodyOf(file);
      const outcome = await clientFor(answering(() => fixtureResponse(file))).fetchMeta({});

      expect(outcome).toEqual({ kind: 'configuration', status: 404, code: body['code'], pollAfter: 1800 });
    },
  );

  it('keeps the code when the poll hint is malformed', async () => {
    for (const pollAfter of ['soon', -5, 1.5, null]) {
      const outcome = await clientFor(answering(() => problem(403, 'forbidden', { pollAfter }))).fetchMeta({});

      expect(outcome).toEqual({ kind: 'configuration', status: 403, code: 'forbidden' });
    }
  });

  it('keeps the poll hint when the code is not a string', async () => {
    const outcome = await clientFor(answering(() => problem(403, 5 as unknown as string, { pollAfter: 60 }))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'configuration', status: 403, pollAfter: 60 });
  });

  it('is still a configuration problem when the body is not JSON', async () => {
    const outcome = await clientFor(answering(() => respond(403, 'denied', { headers: { 'Content-Type': 'text/plain' } }))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'configuration', status: 403 });
  });

  it('is throttled with the Retry-After seconds', async () => {
    const outcome = await clientFor(answering(() => fixtureResponse('errors/meta-429-too-many-requests.json'))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'throttled', retryAfter: 60 });
  });

  it('is throttled without a hint when there is no Retry-After', async () => {
    const outcome = await clientFor(answering(() => fixtureResponse('errors/meta-429-invalid-key-limiter.json'))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'throttled' });
  });

  it.each([
    'errors/meta-500-cdn-signing-failed.json',
    'errors/meta-502-upstream-error.json',
    'errors/meta-503-cdn-edge.json',
    'errors/meta-503-disabled.json',
  ])('is a server problem for %s', async (file) => {
    const outcome = await clientFor(answering(() => fixtureResponse(file))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'server', status: envelope(file).status });
  });

  it.each([
    [201, 'created'],
    [202, 'accepted'],
    [204, null],
    [302, null],
    [304, null],
    [418, 'teapot'],
    [409, 'conflict'],
  ])('is a server problem for status %i', async (status, body) => {
    const outcome = await clientFor(answering(() => respond(status, body))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'server', status });
  });

  describe('Retry-After', () => {
    const withRetryAfter = (value: string, status = 503) =>
      clientFor(answering(() => respond(status, null, { headers: { 'Retry-After': value } }))).fetchMeta({});

    it('reads delta-seconds, zero included', async () => {
      expect(await withRetryAfter('120')).toEqual({ kind: 'server', status: 503, retryAfter: 120 });
      expect(await withRetryAfter('0')).toEqual({ kind: 'server', status: 503, retryAfter: 0 });
      expect(await withRetryAfter('30', 429)).toEqual({ kind: 'throttled', retryAfter: 30 });
    });

    it.each([
      'Wed, 21 Oct 2026 07:28:00 GMT',
      '-5',
      '1.5',
      '1e3',
      'soon',
      '',
    ])('ignores %j', async (value) => {
      expect(await withRetryAfter(value)).toEqual({ kind: 'server', status: 503 });
    });
  });
});

describe('transport failures', () => {
  it('is network when fetch rejects', async () => {
    const fetchFn = answering(() => Promise.reject(new TypeError('Failed to fetch')));
    const outcome = await clientFor(fetchFn).fetchMeta({});

    expect(outcome).toEqual({ kind: 'network' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('is network when fetch throws synchronously', async () => {
    const fetchFn = vi.fn(() => {
      throw new Error('boom');
    });
    const outcome = await clientFor(fetchFn as never).fetchMeta({});

    expect(outcome).toEqual({ kind: 'network' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('is network for a response that followed a redirect', async () => {
    const outcome = await clientFor(answering(() => respond(200, goodMeta(), { redirected: true }))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'network' });
  });

  it('is network for an opaque redirect', async () => {
    const outcome = await clientFor(answering(() => respond(200, goodMeta(), { type: 'opaqueredirect' }))).fetchMeta({});

    expect(outcome).toEqual({ kind: 'network' });
  });

  it('is network when the request never answers within the inactivity window', async () => {
    const fetchFn = vi.fn((_url: string, init: RequestInit) => hangUntilAborted(init));
    const started = Date.now();
    const outcome = await clientFor(fetchFn, { timeoutMs: 40 }).fetchMeta({});

    expect(outcome).toEqual({ kind: 'network' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('is network when the body stalls mid-stream past the window', async () => {
    const stream = controlledStream();
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => stream.fail(new DOMException('aborted', 'AbortError')));
      stream.push('{"checksum":');
      return stream.response;
    });
    const outcome = await clientFor(fetchFn, { timeoutMs: 60 }).fetchMeta({});

    expect(outcome).toEqual({ kind: 'network' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('completes a slow body that keeps delivering chunks inside the window', async () => {
    const text = JSON.stringify(goodMeta());
    const stream = controlledStream();
    const fetchFn = vi.fn(async () => stream.response);
    const pending = clientFor(fetchFn, { timeoutMs: 120 }).fetchMeta({});

    const step = Math.ceil(text.length / 5);
    for (let at = 0; at < text.length; at += step) {
      stream.push(text.slice(at, at + step));
      await sleep(50);
    }
    stream.close();

    expect((await pending).kind).toBe('received');
  });

  it('is network when a body-less response never delivers its bytes', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const response = {
        status: 200,
        redirected: false,
        type: 'basic',
        headers: new Headers(),
        body: null,
        // Like a real body read, it rejects when the request is aborted.
        arrayBuffer: () => hangUntilAborted(init),
      };
      return response as unknown as Response;
    });
    const started = Date.now();
    const outcome = await clientFor(fetchFn, { timeoutMs: 40 }).fetchMeta({});

    expect(outcome).toEqual({ kind: 'network' });
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('reads a body-less response through arrayBuffer when it does arrive', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(goodMeta()));
    const response = {
      status: 200,
      redirected: false,
      type: 'basic',
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Response;
    const outcome = await clientFor(vi.fn(async () => response)).fetchMeta({});

    expect(outcome.kind).toBe('received');
  });
});
