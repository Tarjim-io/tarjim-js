import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { build } from 'esbuild';

const ORIGIN = 'https://app.example.invalid';
const DELIVERY_URL = 'https://delivery.example.invalid/t/1/projects/1/delivery/meta';
const API_KEY = 'tarjim-0-0-0-testkey';

const PAGE = `<!doctype html><meta charset="utf-8"><title>store</title>
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

async function serve(context: BrowserContext): Promise<void> {
  await context.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    if (path === '/browser.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle });
    return route.fulfill({ status: 204 });
  });
}

async function open(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
}

// Everything below runs inside the page, against its real IndexedDB and lock manager.
const SETUP = `
  const encode = (text) => new TextEncoder().encode(text);
  const hex = async (bytes) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const installFor = (slots, checksum) => ({
    checksum, releaseId: 7, manifest: { schemaVersion: 1, bundles: {}, slices: {} }, slots, owed: [],
    manifestUrl: 'https://delivery.example.invalid/manifest.json', slicesBaseUrl: 'https://delivery.example.invalid/slices/',
    authenticated: false, sdkVersion: '0.1.0', installedAt: 1700000000000,
  });
`;

test.describe('stored translations in a real browser', () => {
  test('keep their bytes and active install across a reload', async ({ context, page }) => {
    await serve(context);
    await open(page);

    const written = await page.evaluate(
      async ({ deliveryUrl, apiKey, setup }) => {
        const { openStore } = (window as any).sdk;
        const { encode, hex, installFor } = new Function(`${setup}; return { encode, hex, installFor };`)();
        const { store, degradedReason } = await openStore({ deliveryUrl, apiKey });
        const bytes = encode('{"greeting":"hello"}');
        const hash = await hex(bytes);
        const put = await store.putSlice(hash, bytes);
        const ok = await store.writeInstall(installFor({ 'ui\nen': hash }, 'a'.repeat(64)), 'active');
        store.close();
        return { degradedReason: degradedReason ?? null, degraded: store.degraded, put, ok, hash };
      },
      { deliveryUrl: DELIVERY_URL, apiKey: API_KEY, setup: SETUP },
    );
    expect(written).toMatchObject({ degradedReason: null, degraded: false, put: 'stored', ok: true });

    await page.reload();
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);

    const reread = await page.evaluate(
      async ({ deliveryUrl, apiKey, hash }) => {
        const { openStore } = (window as any).sdk;
        const { store, degradedReason } = await openStore({ deliveryUrl, apiKey });
        const state = await store.readState();
        const slices = await store.readSlices([hash]);
        const text = slices.has(hash) ? new TextDecoder().decode(slices.get(hash)) : null;
        store.close();
        return {
          degradedReason: degradedReason ?? null,
          degraded: store.degraded,
          checksum: state.active?.checksum ?? null,
          frozen: state.active ? Object.isFrozen(state.active) : null,
          text,
        };
      },
      { deliveryUrl: DELIVERY_URL, apiKey: API_KEY, hash: written.hash },
    );
    expect(reread).toEqual({ degradedReason: null, degraded: false, checksum: 'a'.repeat(64), frozen: true, text: '{"greeting":"hello"}' });
  });

  test('turn into a degraded in-memory store, and still resolve, when IndexedDB is gone', async ({ context, page }) => {
    await serve(context);
    await page.addInitScript(() => {
      try {
        delete (window as any).indexedDB;
      } catch {
        // some engines keep it non-deletable; shadowing it below covers them
      }
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    await open(page);

    const result = await page.evaluate(
      async ({ deliveryUrl, apiKey, setup }) => {
        const { openStore } = (window as any).sdk;
        const { encode, hex } = new Function(`${setup}; return { encode, hex };`)();
        const { store, degradedReason } = await openStore({ deliveryUrl, apiKey });
        const bytes = encode('x');
        const hash = await hex(bytes);
        const put = await store.putSlice(hash, bytes);
        const read = await store.readSlices([hash]);
        return { degradedReason, degraded: store.degraded, put, read: read.size };
      },
      { deliveryUrl: DELIVERY_URL, apiKey: API_KEY, setup: SETUP },
    );
    expect(result).toEqual({ degradedReason: 'unavailable', degraded: true, put: 'stored', read: 1 });
  });

  test('let only one of two tabs run while the other holds the lock', async ({ context }) => {
    await serve(context);
    const first = await context.newPage();
    const second = await context.newPage();
    await open(first);
    await open(second);

    const openInPage = (page: Page) =>
      page.evaluate(
        async ({ deliveryUrl, apiKey }) => {
          const w = window as any;
          const { store } = await w.sdk.openStore({ deliveryUrl, apiKey });
          w.store = store;
        },
        { deliveryUrl: DELIVERY_URL, apiKey: API_KEY },
      );
    await openInPage(first);
    await openInPage(second);

    await first.evaluate(() => {
      const w = window as any;
      w.entered = false;
      w.holding = w.store.withLock(async () => {
        w.entered = true;
        await new Promise<void>((resolve) => (w.release = resolve));
        return 'first ran';
      });
    });
    await first.waitForFunction(() => (window as any).entered === true);

    const whileHeld = await second.evaluate(async () => {
      let ran = false;
      const result = await (window as any).store.withLock(async () => {
        ran = true;
        return 'second ran';
      });
      return { busy: typeof result === 'symbol', ran };
    });
    expect(whileHeld).toEqual({ busy: true, ran: false });

    const firstResult = await first.evaluate(async () => {
      const w = window as any;
      w.release();
      return w.holding;
    });
    expect(firstResult).toBe('first ran');

    const afterRelease = await second.evaluate(() => (window as any).store.withLock(async () => 'second ran'));
    expect(afterRelease).toBe('second ran');
  });

  test('are shared between two tabs of one browser context', async ({ context }) => {
    await serve(context);
    const first = await context.newPage();
    const second = await context.newPage();
    await open(first);
    await open(second);

    const args = { deliveryUrl: DELIVERY_URL, apiKey: API_KEY };
    await first.evaluate(async ({ deliveryUrl, apiKey }) => {
      const { store } = await (window as any).sdk.openStore({ deliveryUrl, apiKey });
      await store.updateState((state: object) => ({ ...state, lastCheck: 42 }));
      store.close();
    }, args);
    const seen = await second.evaluate(async ({ deliveryUrl, apiKey }) => {
      const { store } = await (window as any).sdk.openStore({ deliveryUrl, apiKey });
      const state = await store.readState();
      store.close();
      return state.lastCheck ?? null;
    }, args);
    expect(seen).toBe(42);
  });
});
