import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { Page, Route } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../../../../test/fixtures/recorded/release-1/', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../src/internal.ts', import.meta.url));

let CORE_JS = '';
test.beforeAll(async () => {
  const result = await build({ entryPoints: [ENTRY], bundle: true, format: 'esm', platform: 'browser', write: false });
  CORE_JS = result.outputFiles[0]?.text ?? '';
});
const ENVELOPE = JSON.parse(readFileSync(`${FIXTURES}meta.cdn.json`, 'utf8')) as {
  status: number;
  headers: Record<string, string>;
  body: string;
};
const MANIFEST = readFileSync(`${FIXTURES}manifest.json`);
const SIGNED_QUERY = (JSON.parse(ENVELOPE.body) as { signedQuery: string }).signedQuery;

const API_KEY = 'tarjim-0-0-0-testkey';
const DELIVERY_URL = 'https://delivery.example.invalid/t/1/projects/1/delivery/meta';
const CORS = { 'access-control-allow-origin': '*' };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

async function serve(page: Page, options: { redirectMeta?: boolean } = {}) {
  const seen = { meta: [] as Seen[], objects: [] as Seen[], redirectTarget: [] as Seen[] };
  const record = async (route: Route): Promise<Seen> => {
    const request = route.request();
    return { url: request.url(), method: request.method(), headers: await request.allHeaders() };
  };

  await page.route('https://app.example.invalid/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/core.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: CORE_JS });
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' });
    return route.fulfill({ status: 404, body: '' });
  });

  await page.route('https://delivery.example.invalid/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          'access-control-allow-methods': 'GET',
          'access-control-allow-headers': 'x-tarjim-apikey, x-tarjim-api-version',
          'access-control-max-age': '0',
        },
      });
    }
    seen.meta.push(await record(route));
    if (options.redirectMeta) {
      return route.fulfill({ status: 302, headers: { ...CORS, location: 'https://redirected.example.invalid/meta' }, body: '' });
    }
    return route.fulfill({ status: ENVELOPE.status, headers: { ...ENVELOPE.headers, ...CORS }, body: ENVELOPE.body });
  });

  await page.route('https://redirected.example.invalid/**', async (route) => {
    seen.redirectTarget.push(await record(route));
    return route.fulfill({ status: 200, headers: { ...ENVELOPE.headers, ...CORS }, body: ENVELOPE.body });
  });

  await page.route('https://cdn.example.invalid/**', async (route) => {
    seen.objects.push(await record(route));
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/manifest.json')) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: MANIFEST });
    }
    const hash = /\/slices\/([0-9a-f]{64})\.json$/.exec(pathname)?.[1];
    if (!hash) return route.fulfill({ status: 404, headers: CORS, body: '' });
    const body = readFileSync(`${FIXTURES}objects/${hash}.json`);
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body });
  });

  await page.goto('https://app.example.invalid/');
  return seen;
}

test('fetches, verifies and reads a whole release over the CDN with only simple requests', async ({ page }) => {
  const seen = await serve(page);

  const result = await page.evaluate(async ({ deliveryUrl, apiKey }) => {
    const specifier = '/core.js';
    const core = await import(/* @vite-ignore */ specifier);
    const client = core.createDeliveryClient({
      deliveryUrl,
      apiKey,
      appVersion: '1.0.0',
      platform: 'web',
      fetch: (url: string, init: RequestInit) => fetch(url, init),
      timeoutMs: 5000,
    });
    const meta = await client.fetchMeta({ language: 'en' });
    if (meta.kind !== 'received') return { meta: meta.kind };
    const manifest = await client.fetchManifest(meta.meta);
    if (manifest.kind !== 'verified') return { meta: meta.kind, manifest: manifest.kind };
    const files = Object.values(manifest.manifest.slices).flatMap((byLocale: any) => Object.values(byLocale));
    const slices = await client.fetchSlices(meta.meta, files, {});
    return {
      meta: meta.kind,
      manifest: manifest.kind,
      slices: [...slices.results.values()].map((outcome: any) => outcome.kind),
      reread: slices.reread,
    };
  }, { deliveryUrl: DELIVERY_URL, apiKey: API_KEY });

  expect(result).toEqual({ meta: 'received', manifest: 'verified', slices: ['verified', 'verified', 'verified'], reread: false });

  expect(seen.meta).toHaveLength(1);
  expect(seen.meta[0]!.headers['x-tarjim-apikey']).toBe(API_KEY);
  expect(seen.meta[0]!.headers['x-tarjim-api-version']).toBe('2026-07-29');

  expect(seen.objects).toHaveLength(4);
  for (const request of seen.objects) {
    expect(request.method).toBe('GET');
    expect(Object.keys(request.headers).filter((name) => name.startsWith('x-tarjim'))).toEqual([]);
    expect(new URL(request.url).search.slice(1)).toBe(SIGNED_QUERY);
    expect(request.url).not.toContain(API_KEY);
  }
});

test('treats an answer that redirects as a network failure and never requests the target', async ({ page, browserName }) => {
  // Playwright cannot fulfil a request with a redirect status in WebKit; the Node tests cover it there.
  test.skip(browserName === 'webkit', 'a routed redirect is not possible in WebKit');
  const seen = await serve(page, { redirectMeta: true });

  const outcome = await page.evaluate(async ({ deliveryUrl, apiKey }) => {
    const specifier = '/core.js';
    const core = await import(/* @vite-ignore */ specifier);
    const client = core.createDeliveryClient({
      deliveryUrl,
      apiKey,
      appVersion: '1.0.0',
      platform: 'web',
      fetch: (url: string, init: RequestInit) => fetch(url, init),
      timeoutMs: 5000,
    });
    return client.fetchMeta({});
  }, { deliveryUrl: DELIVERY_URL, apiKey: API_KEY });

  expect(outcome).toEqual({ kind: 'network' });
  expect(seen.meta).toHaveLength(1);
  expect(seen.meta[0]!.headers['x-tarjim-apikey']).toBe(API_KEY);
  expect(seen.redirectTarget).toHaveLength(0);
});

test('hashes with the browser crypto exactly as Node does', async ({ page }) => {
  await serve(page);
  const names = [
    '24fc13c433562806e0a880340583f0b20b3fef792c58a3ebc322c8129c2413c8',
    'b3ffc5df57e7ac4ebed7ba158ab8389bd768a03634c29df171a5613904792eae',
    'fa894e013eae8a148ddcd84cd62feab08e0d7e7f0d4d80d10637e3a738107460',
  ];
  const files = names.map((name) => readFileSync(`${FIXTURES}objects/${name}.json`));

  const browser = await page.evaluate(async (inputs) => {
    const specifier = '/core.js';
    const core = await import(/* @vite-ignore */ specifier);
    const out: { hash: string; verdict: string }[] = [];
    for (const input of inputs) {
      const bytes = new Uint8Array(input.bytes);
      const hash = await core.sha256Hex(bytes);
      out.push({ hash, verdict: await core.verify(bytes, { hash, size: bytes.length }) });
    }
    return out;
  }, files.map((file) => ({ bytes: [...file] })));

  expect(browser.map((entry) => entry.hash)).toEqual(files.map((file) => createHash('sha256').update(file).digest('hex')));
  expect(browser.map((entry) => entry.hash)).toEqual(names);
  expect(browser.map((entry) => entry.verdict)).toEqual(['ok', 'ok', 'ok']);
});
