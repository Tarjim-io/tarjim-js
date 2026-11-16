import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURES = `${ROOT}test/fixtures/recorded/release-1/`;
const EXAMPLE = `${ROOT}examples/plain-html/`;
const BUNDLE = `${ROOT}packages/browser/dist/tarjim-browser.iife.js`;
const VARIANT = `${EXAMPLE}with-package.html`;
const ORIGIN = 'https://app.example.invalid';
const CORS = { 'access-control-allow-origin': '*' };

const ENVELOPE = JSON.parse(readFileSync(`${FIXTURES}meta.cdn.json`, 'utf8')) as { status: number; headers: Record<string, string>; body: string };

// A distribution serves custom bundles and the example reads one, `web`. The recorded English and
// Arabic slices are served again as that flat custom bundle, with their hashes and the manifest
// checksum recomputed, so the page still verifies the whole chain.
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const OBJECTS = new Map<string, Buffer>();
const RECORDED_MANIFEST = JSON.parse(readFileSync(`${FIXTURES}manifest.json`, 'utf8')) as { slices: Record<string, Record<string, unknown>> };
const CUSTOM_SLICES: Record<string, { json: { hash: string; size: number; transferSize: number } }> = {};
for (const locale of ['en', 'ar']) {
  const recorded = RECORDED_MANIFEST.slices['ns180']?.[locale] as { json: { hash: string } };
  const slice = JSON.parse(readFileSync(`${FIXTURES}objects/${recorded.json.hash}.json`, 'utf8')) as Record<string, unknown>;
  const bytes = Buffer.from(JSON.stringify({ ...slice, bundle: 'c1' }));
  const hash = sha256(bytes);
  OBJECTS.set(hash, bytes);
  CUSTOM_SLICES[locale] = { json: { hash, size: bytes.length, transferSize: bytes.length } };
}
const MANIFEST = Buffer.from(
  JSON.stringify({ ...RECORDED_MANIFEST, bundles: { c1: { type: 'custom', name: 'web', layout: 'flat' } }, slices: { c1: CUSTOM_SLICES } }),
);
const META_BODY = JSON.stringify({ ...(JSON.parse(ENVELOPE.body) as Record<string, unknown>), checksum: sha256(MANIFEST) });

test.beforeAll(() => {
  for (const file of [BUNDLE, VARIANT]) {
    if (!existsSync(file)) throw new Error(`${file} is missing: run \`pnpm build\` before the browser tests`);
  }
});

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };

async function serve(page: Page, script: Buffer) {
  const seen = { meta: 0, objects: 0 };

  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const name = pathname === '/' ? 'with-package.html' : pathname.slice(1);
    if (name === 'tarjim-browser.iife.js') return route.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: script });
    const file = `${EXAMPLE}${name}`;
    if (!/^[\w.-]+$/.test(name) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    let body = readFileSync(file, 'utf8');
    // The recording names its object host under .invalid; the example's policy lists the real one.
    if (name === 'with-package.html') {
      const policy = /(<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*content="[^"]*?)connect-src /;
      expect(body).toMatch(policy);
      body = body.replace(policy, '$1connect-src https://cdn.example.invalid ');
      expect(body).toContain('cdn.example.invalid');
    }
    return route.fulfill({ status: 200, contentType: TYPES[extname(name)] ?? 'text/plain', body });
  });

  await page.route('https://delivery.example.com/**', (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...CORS, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'x-tarjim-apikey, x-tarjim-api-version', 'access-control-max-age': '0' },
      });
    }
    seen.meta += 1;
    return route.fulfill({ status: ENVELOPE.status, headers: { ...ENVELOPE.headers, ...CORS }, body: META_BODY });
  });

  await page.route('https://cdn.example.invalid/**', (route) => {
    const { pathname } = new URL(route.request().url());
    seen.objects += 1;
    const hash = /\/slices\/([0-9a-f]{64})\.json$/.exec(pathname)?.[1];
    const body = pathname.endsWith('/manifest.json') ? MANIFEST : hash ? OBJECTS.get(hash) : undefined;
    if (!body) return route.fulfill({ status: 404, headers: CORS, body: '' });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body });
  });

  return seen;
}

test.describe('the script-tag build in a real browser', () => {
  test('renders the recorded text from the page that loads it with an integrity hash', async ({ page }) => {
    const seen = await serve(page, readFileSync(BUNDLE));

    await page.goto(`${ORIGIN}/`);

    await expect(page.locator('[data-key="app.title"]')).toHaveText('Tarjim', { timeout: 6000 });
    expect(await page.evaluate(() => Object.keys((window as any).Tarjim).sort())).toEqual(['start', 'version']);
    expect(seen.meta).toBeGreaterThan(0);
  });

  test('refuses a copy of the file with one byte changed', async ({ page }) => {
    const tampered = Buffer.from(readFileSync(BUNDLE));
    tampered[tampered.length - 1] = tampered[tampered.length - 1] === 0x20 ? 0x0a : 0x20;
    const seen = await serve(page, tampered);

    await page.goto(`${ORIGIN}/`);
    await page.waitForTimeout(1500);

    expect(await page.evaluate(() => typeof (window as any).Tarjim)).toBe('undefined');
    await expect(page.locator('[data-key="app.title"]')).toHaveText('app.title');
    expect(seen).toEqual({ meta: 0, objects: 0 });
  });
});
