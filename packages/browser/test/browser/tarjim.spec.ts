import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';

const FIXTURES = fileURLToPath(new URL('../../../../test/fixtures/recorded/release-1/', import.meta.url));
const ORIGIN = 'https://app.example.invalid';
const DELIVERY_URL = 'https://delivery.example.invalid/t/1/projects/1/delivery/meta';
const API_KEY = 'tarjim-0-0-0-testkey';
const CORS = { 'access-control-allow-origin': '*' };

const ENVELOPE = JSON.parse(readFileSync(`${FIXTURES}meta.cdn.json`, 'utf8')) as { status: number; headers: Record<string, string>; body: string };
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Release {
  meta: string;
  manifest: Buffer;
  objects: Map<string, Buffer>;
}

function firstRelease(): Release {
  const manifest = readFileSync(`${FIXTURES}manifest.json`);
  const parsed = JSON.parse(manifest.toString()) as { slices: Record<string, Record<string, { json: { hash: string } }>> };
  const objects = new Map<string, Buffer>();
  for (const byLocale of Object.values(parsed.slices)) {
    for (const entry of Object.values(byLocale)) objects.set(entry.json.hash, readFileSync(`${FIXTURES}objects/${entry.json.hash}.json`));
  }
  return { meta: ENVELOPE.body, manifest, objects };
}

/** The recorded release with one English title changed, hashed so that it verifies. */
function secondRelease(first: Release): Release {
  const manifest = JSON.parse(first.manifest.toString()) as { slices: Record<string, Record<string, { json: Record<string, unknown> }>> };
  const bundle = Object.keys(manifest.slices)[0]!;
  const english = manifest.slices[bundle]!['en']!.json as { hash: string };
  const slice = JSON.parse(first.objects.get(english.hash)!.toString()) as { keys: Record<string, { value: string }> };
  slice.keys['app.title']!.value = 'Tarjim two';
  const bytes = Buffer.from(JSON.stringify(slice));
  const hash = sha256(bytes);
  manifest.slices[bundle]!['en']!.json = { hash, size: bytes.length, transferSize: bytes.length };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const meta = { ...(JSON.parse(ENVELOPE.body) as Record<string, unknown>), checksum: sha256(manifestBytes), releaseId: 2 };
  return { meta: JSON.stringify(meta), manifest: manifestBytes, objects: new Map([...first.objects, [hash, bytes]]) };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>runtime</title>
<script type="module">
  import * as sdk from '/browser.js';
  window.sdk = sdk;
  window.ready = true;
</script>`;

let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
    alias: {
      '@tarjim/core/internal': fileURLToPath(new URL('../../../core/src/internal.ts', import.meta.url)),
      '@tarjim/core': fileURLToPath(new URL('../../../core/src/index.ts', import.meta.url)),
    },
    bundle: true,
    format: 'esm',
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

interface Seen {
  meta: string[];
  objects: string[];
  keyHeaders: Array<string | undefined>;
}

async function serve(page: Page, releases: Release[]) {
  const seen: Seen = { meta: [], objects: [], keyHeaders: [] };
  const state = { current: 0, offline: false };

  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    if (pathname === '/browser.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle });
    return route.fulfill({ status: 204 });
  });

  await page.route('https://delivery.example.invalid/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...CORS, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'x-tarjim-apikey, x-tarjim-api-version', 'access-control-max-age': '0' },
      });
    }
    seen.meta.push(request.url());
    seen.keyHeaders.push((await request.allHeaders())['x-tarjim-apikey']);
    if (state.offline) return route.abort();
    return route.fulfill({ status: ENVELOPE.status, headers: { ...ENVELOPE.headers, ...CORS }, body: releases[state.current]!.meta });
  });

  await page.route('https://cdn.example.invalid/**', (route) => {
    const { pathname } = new URL(route.request().url());
    seen.objects.push(route.request().url());
    const release = releases[state.current]!;
    if (pathname.endsWith('/manifest.json')) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: release.manifest });
    }
    const hash = /\/slices\/([0-9a-f]{64})\.json$/.exec(pathname)?.[1];
    const body = hash ? release.objects.get(hash) : undefined;
    if (!body) return route.fulfill({ status: 404, headers: CORS, body: '' });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body });
  });

  return { seen, state };
}

async function open(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
}

const CONFIG = {
  deliveryUrl: DELIVERY_URL,
  apiKey: API_KEY,
  appVersion: '1.0.0',
  defaultBundle: { type: 'namespace', name: 'default' },
  fallbackLanguage: 'en',
  language: 'en',
  embedded: [{ schemaVersion: 1, bundle: 'embedded', locale: 'en', keys: { 'app.title': { id: '1', value: 'Embedded title', tags: [] }, only: { id: '2', value: 'Only embedded', tags: [] } } }],
};

// Runs in the page: starts the SDK and keeps the instance for later calls.
async function startInPage(page: Page, extra: Record<string, unknown> = {}) {
  return page.evaluate(async (config) => {
    const w = window as any;
    w.reports = [];
    const runtime = await w.sdk.Tarjim.start({ ...config, onReport: (report: { code: string }) => w.reports.push(report.code) });
    w.runtime = runtime;
    return { title: runtime.t('app.title'), only: runtime.t('only'), language: runtime.language };
  }, { ...CONFIG, ...extra });
}

test.describe('Tarjim.start in a real browser', () => {
  test('shows the recorded text from the routed delivery hosts', async ({ page }) => {
    const { seen } = await serve(page, [firstRelease()]);
    await open(page);

    const shown = await startInPage(page, { waitForContent: 4000 });

    expect(shown).toEqual({ title: 'Tarjim', only: 'Only embedded', language: 'en' });
    expect(seen.meta).toHaveLength(1);
    expect(new URL(seen.meta[0]!).searchParams.get('platform')).toBe('web');
    expect(seen.keyHeaders[0]).toBe(API_KEY);
    for (const url of seen.objects) expect(url).not.toContain(API_KEY);
  });

  test('answers from the embedded text first when it does not wait', async ({ page }) => {
    await serve(page, [firstRelease()]);
    await open(page);

    const shown = await startInPage(page);
    expect(shown.only).toBe('Only embedded');
    await page.waitForFunction(() => (window as any).runtime.t('app.title') === 'Tarjim', undefined, { timeout: 4000 });
  });

  test('activates a release that was downloaded before a reload', async ({ page }) => {
    const first = firstRelease();
    const { state } = await serve(page, [first, secondRelease(first)]);
    await open(page);
    await startInPage(page, { waitForContent: 4000 });

    state.current = 1;
    const during = await page.evaluate(async () => {
      const runtime = (window as any).runtime;
      const result = await runtime.checkNow();
      return { result, title: runtime.t('app.title') };
    });
    expect(during).toEqual({ result: 'downloaded', title: 'Tarjim' });

    state.offline = true;
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
    const after = await startInPage(page);
    expect(after.title).toBe('Tarjim two');
  });

  test('shows the embedded text and asks for nothing when IndexedDB is gone', async ({ page }) => {
    const { seen } = await serve(page, [firstRelease()]);
    await page.addInitScript(() => {
      try {
        delete (window as any).indexedDB;
      } catch {
        // some engines keep it non-deletable; shadowing it below covers them
      }
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    await open(page);

    const shown = await startInPage(page, { waitForContent: 500 });
    await page.waitForTimeout(500);

    expect(shown.title).toBe('Embedded title');
    expect(seen.meta).toEqual([]);
    expect(seen.objects).toEqual([]);
    expect(await page.evaluate(() => (window as any).reports)).toEqual(['storage-unavailable']);
  });
});
