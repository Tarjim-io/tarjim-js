import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';

const FIXTURES = fileURLToPath(new URL('../../../../test/fixtures/recorded/release-1/', import.meta.url));
const REACT_PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
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

const CONFIG = {
  deliveryUrl: DELIVERY_URL,
  apiKey: API_KEY,
  appVersion: '1.0.0',
  defaultBundle: { type: 'namespace', name: 'default' },
  fallbackLanguage: 'en',
  language: 'en',
  embedded: [{ schemaVersion: 1, bundle: 'embedded', locale: 'en', keys: { 'app.title': { id: '1', value: 'Embedded title', tags: [] } } }],
};

// Three readers at different depths and a memo keyed on `t`; a profiler writes down what the DOM shows
// after every commit, which is the only place a mix of two releases could be seen.
const APP = `
import { Profiler, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Tarjim } from '@tarjim/browser';
import { TarjimProvider, useTarjim } from '@tarjim/react';

const w = window;
w.errors = [];
w.addEventListener('error', (event) => w.errors.push(String(event.message)));
w.commits = [];
w.memoRuns = 0;

function Reader({ id }) {
  const { t, language } = useTarjim();
  return <span data-id={id}>{t('app.title') + '|' + language}</span>;
}

function Memo() {
  const { t } = useTarjim();
  const upper = useMemo(() => {
    w.memoRuns += 1;
    return t('app.title').toUpperCase();
  }, [t]);
  return <b id="memo">{upper}</b>;
}

function Expose() {
  w.api = useTarjim();
  return null;
}

const config = JSON.parse(document.getElementById('config').textContent);
const start = async (given) => {
  const runtime = await Tarjim.start(given);
  w.runtime = runtime;
  return runtime;
};

createRoot(document.getElementById('root')).render(
  <Profiler id="app" onRender={() => w.commits.push(Array.from(document.querySelectorAll('[data-id]')).map((node) => node.textContent))}>
    <TarjimProvider config={config} start={start}>
      <Reader id="top" />
      <main>
        <Reader id="middle" />
        <div>
          <Reader id="bottom" />
        </div>
      </main>
      <Memo />
      <Expose />
    </TarjimProvider>
  </Profiler>,
);
`;

const page = (): string =>
  `<!doctype html><meta charset="utf-8"><title>react</title><div id="root"></div>` +
  `<script type="application/json" id="config">${JSON.stringify(CONFIG).replace(/</g, '\\u003c')}</script>` +
  `<script type="module" src="/app.js"></script>`;

let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: APP, loader: 'tsx', resolveDir: REACT_PACKAGE, sourcefile: 'app.tsx' },
    alias: {
      '@tarjim/core/internal': fileURLToPath(new URL('../../../core/src/internal.ts', import.meta.url)),
      '@tarjim/core': fileURLToPath(new URL('../../../core/src/index.ts', import.meta.url)),
      '@tarjim/browser': fileURLToPath(new URL('../../../browser/src/index.ts', import.meta.url)),
      '@tarjim/react': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    },
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    bundle: true,
    format: 'esm',
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

async function serve(browserPage: Page, releases: Release[]) {
  const state = { current: 0 };

  await browserPage.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: page() });
    if (pathname === '/app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle });
    return route.fulfill({ status: 204 });
  });

  await browserPage.route('https://delivery.example.invalid/**', (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...CORS, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'x-tarjim-apikey, x-tarjim-api-version', 'access-control-max-age': '0' },
      });
    }
    return route.fulfill({ status: ENVELOPE.status, headers: { ...ENVELOPE.headers, ...CORS }, body: releases[state.current]!.meta });
  });

  await browserPage.route('https://cdn.example.invalid/**', (route) => {
    const { pathname } = new URL(route.request().url());
    const release = releases[state.current]!;
    if (pathname.endsWith('/manifest.json')) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: release.manifest });
    }
    const hash = /\/slices\/([0-9a-f]{64})\.json$/.exec(pathname)?.[1];
    const body = hash ? release.objects.get(hash) : undefined;
    if (!body) return route.fulfill({ status: 404, headers: CORS, body: '' });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body });
  });

  return state;
}

/** Waits for the bottom reader to show `text`, or fails at once if the page threw. */
async function untilShown(browserPage: Page, text: string): Promise<void> {
  await browserPage.waitForFunction(
    (expected) => {
      const w = window as unknown as { errors?: string[] };
      return (w.errors?.length ?? 0) > 0 || document.querySelector('[data-id=bottom]')?.textContent === expected;
    },
    text,
    { timeout: 4000 },
  );
  expect(await browserPage.evaluate(() => (window as unknown as { errors: string[] }).errors)).toEqual([]);
  expect(await browserPage.locator('[data-id=bottom]').textContent()).toBe(text);
}

const memoRuns = (browserPage: Page): Promise<number> => browserPage.evaluate(() => (window as unknown as { memoRuns: number }).memoRuns);

test.describe('@tarjim/react in a real browser', () => {
  test('no commit shows text from two releases, and a memo keyed on t follows each change', async ({ page: tab }) => {
    const first = firstRelease();
    const state = await serve(tab, [first, secondRelease(first)]);
    await tab.goto(`${ORIGIN}/`);

    await untilShown(tab, 'Tarjim|en');
    expect(await tab.locator('#memo').textContent()).toBe('TARJIM');
    const afterFirst = await memoRuns(tab);

    state.current = 1;
    const downloaded = await tab.evaluate(() => (window as any).runtime.checkNow());
    expect(downloaded).toBe('downloaded');
    expect(await tab.locator('[data-id=bottom]').textContent()).toBe('Tarjim|en');
    expect(await memoRuns(tab)).toBe(afterFirst);

    await tab.evaluate(() => (window as any).runtime.activatePendingUpdate());
    await untilShown(tab, 'Tarjim two|en');
    expect(await tab.locator('#memo').textContent()).toBe('TARJIM TWO');
    const afterActivation = await memoRuns(tab);
    expect(afterActivation).toBeGreaterThan(afterFirst);

    await tab.evaluate(() => (window as any).api.setLanguage('fr'));
    await untilShown(tab, `${await tab.locator('[data-id=bottom]').textContent()}`.replace(/\|en$/, '|fr'));
    expect(await memoRuns(tab)).toBeGreaterThan(afterActivation);

    const commits = await tab.evaluate(() => (window as any).commits as string[][]);
    const mixed = commits.filter((row) => new Set(row).size > 1);
    const seen = new Set(commits.flat());
    expect(mixed).toEqual([]);
    expect(seen.has('Tarjim|en')).toBe(true);
    expect(seen.has('Tarjim two|en')).toBe(true);
    expect([...seen].some((row) => row.endsWith('|fr'))).toBe(true);
  });

  test('keeps the text it had when a downloaded release is not activated', async ({ page: tab }) => {
    const first = firstRelease();
    const state = await serve(tab, [first, secondRelease(first)]);
    await tab.goto(`${ORIGIN}/`);
    await untilShown(tab, 'Tarjim|en');

    state.current = 1;
    await tab.evaluate(() => (window as any).runtime.checkNow());
    await tab.waitForFunction(() => (window as any).api.pendingUpdate === true, undefined, { timeout: 4000 });

    expect(await tab.locator('[data-id=bottom]').textContent()).toBe('Tarjim|en');
  });
});
