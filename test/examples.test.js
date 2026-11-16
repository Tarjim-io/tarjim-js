import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildRelease } from './helpers/fake-delivery.js';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const RECORDED_OBJECTS = './fixtures/recorded/release-1/objects/';
const EN = '24fc13c433562806e0a880340583f0b20b3fef792c58a3ebc322c8129c2413c8';
const AR = 'b3ffc5df57e7ac4ebed7ba158ab8389bd768a03634c29df171a5613904792eae';

// A distribution serves custom bundles, so the examples read one: a flat custom bundle named `web`
// carrying the recorded English and Arabic text, rebuilt under the bundle id `c1`.
function recordedSlice(hash) {
  return { ...JSON.parse(read(`${RECORDED_OBJECTS}${hash}.json`)), bundle: 'c1' };
}

function fakePage(lang, keys) {
  const elements = keys.map(([key, count]) => ({
    textContent: key,
    getAttribute: (name) => (name === 'data-key' ? key : name === 'data-count' ? count ?? null : null),
  }));
  return {
    elements,
    document: { documentElement: { lang }, querySelectorAll: () => elements },
  };
}

// Runs the page's two scripts, in order, in one browser-like context, with only `fetch` replaced.
async function runExample(scripts, lang, keys) {
  const deliveryUrl = 'https://delivery.example.com/delivery/0123456789abcdef0123456789abcdef/meta';
  const server = buildRelease({
    deliveryUrl,
    bundles: { c1: { type: 'custom', name: 'web', layout: 'flat' } },
    slices: { c1: { en: recordedSlice(EN), ar: recordedSlice(AR) } },
  });
  const page = fakePage(lang, keys);
  const context = vm.createContext({
    document: page.document,
    fetch: server.fetch,
    crypto: globalThis.crypto,
    console: { debug() {} },
    URL,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(read('../reference/tarjim-reference.js'), context);
  vm.runInContext(scripts, context);
  await vi.waitFor(() => expect(page.elements[0].textContent).not.toBe(keys[0][0]));
  return page.elements.map((element) => element.textContent);
}

function inlineScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  expect(scripts).toHaveLength(1);
  return scripts[0];
}

describe('examples/plain-html', () => {
  it('index.html fills the page from the release, plurals included', async () => {
    const script = inlineScript(read('../examples/plain-html/index.html'));
    expect(await runExample(script, 'en', [['app.title'], ['cart.items', '3']])).toEqual(['Tarjim', '3 items']);
  });

  it('the strict-CSP variant has no inline script and its config file fills the page', async () => {
    const html = read('../examples/plain-html/strict-csp.html');
    expect(html).not.toMatch(/<script>/);
    expect(html).toMatch(/script-src 'self';/);
    expect(await runExample(read('../examples/plain-html/tarjim-config.js'), 'ar', [['app.title']])).toEqual(['ترجم']);
  });

  it('never writes HTML into the page', () => {
    for (const file of ['index.html', 'tarjim-config.js']) {
      expect(read(`../examples/plain-html/${file}`)).not.toMatch(/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\(|document\.write\(/);
    }
  });
});
