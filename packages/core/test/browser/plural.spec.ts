import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { Page } from '@playwright/test';

const ENTRY = fileURLToPath(new URL('../../src/internal.ts', import.meta.url));

// The browser's own language is English; the text being formatted is Arabic.
test.use({ locale: 'en-US' });

let core = '';
test.beforeAll(async () => {
  const result = await build({ entryPoints: [ENTRY], bundle: true, format: 'esm', platform: 'browser', write: false });
  core = result.outputFiles[0]?.text ?? '';
});

async function open(page: Page) {
  await page.route('https://app.example.invalid/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/core.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: core });
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://app.example.invalid/');
}

const FORMS = { zero: 'Z0', one: 'O1', two: 'T2', few: 'F3', many: 'M4', other: 'X5' };

function slice(locale: string) {
  const names = Object.keys(FORMS);
  const keys: Record<string, unknown> = {
    'cart.items': { id: '10', value: '', tags: [], plural_child_keys: names.map((_, i) => 11 + i) },
    'cart.plain': { id: '30', value: '', tags: [], plural_child_keys: [31, 32] },
    'cart.plain.one': { id: '31', value: 'O1', tags: [] },
    'cart.plain.other': { id: '32', value: 'X5', tags: [] },
  };
  names.forEach((form, i) => {
    keys[`cart.items.${form}`] = { id: String(11 + i), value: FORMS[form as keyof typeof FORMS], tags: [] };
  });
  return { schemaVersion: 1, bundle: 'ns1', locale, keys };
}

const COUNTS = [0, 1, 2, 3, 10, 11, 99, 100];

async function answers(page: Page, locale: string, key: string) {
  return page.evaluate(
    async ({ slices, locale, key, counts }) => {
      const specifier = '/core.js';
      const core = await import(/* @vite-ignore */ specifier);
      const snapshot = core.createSnapshot({
        slices: new Map(),
        embedded: slices,
        locale,
        defaultBundle: { type: 'namespace', name: 'default' },
      });
      const language = (globalThis as unknown as { navigator: { language: string } }).navigator.language;
      return { language, forms: counts.map((count: number) => snapshot.t(key, { count })) as string[] };
    },
    { slices: [slice('ar'), slice('en')], locale, key, counts: COUNTS },
  );
}

test('chooses Arabic plural forms by the text locale while the browser is English', async ({ page }) => {
  await open(page);
  const result = await answers(page, 'ar', 'cart.items');
  expect(result.language).toBe('en-US');
  expect(result.forms).toEqual(['Z0', 'O1', 'T2', 'F3', 'F3', 'M4', 'M4', 'X5']);
});

test('chooses English plural forms for English text in the same browser', async ({ page }) => {
  await open(page);
  const result = await answers(page, 'en', 'cart.items');
  expect(result.forms).toEqual(['Z0', 'O1', 'X5', 'X5', 'X5', 'X5', 'X5', 'X5']);
});

test('uses the Arabic rules for a key with no zero child, falling to the other child at 0', async ({ page }) => {
  await open(page);
  const result = await answers(page, 'ar', 'cart.plain');
  expect(result.forms).toEqual(['X5', 'O1', 'X5', 'X5', 'X5', 'X5', 'X5', 'X5']);
});
