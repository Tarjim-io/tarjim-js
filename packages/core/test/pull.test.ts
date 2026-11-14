import { describe, expect, it, vi } from 'vitest';
import { createSnapshot } from '../src/internal.js';
import { pull } from '../src/pull.js';
import type { Slice } from '../src/slice.js';
import * as fake from '../../../test/helpers/fake-delivery.js';
import { API_KEY, DELIVERY_URL, SIGNED_QUERY, problem, respond } from './support.js';

type Built = { fetch: (url: string, init?: RequestInit) => Promise<Response>; requests: { url: string; init?: RequestInit }[]; meta: Record<string, unknown> };
const buildRelease = fake.buildRelease as unknown as (options: Record<string, unknown>) => Built;

const leaf = (id: string, value: string) => ({ id, value, tags: [] });
const slice = (bundle: string, locale: string, keys: Record<string, unknown>) => ({ schemaVersion: 1, bundle, locale, keys });

// Two custom bundles, listed out of id order, each in two locales; the SPA reads `spa`.
function twoBundles(options: Record<string, unknown> = {}) {
  return buildRelease({
    bundles: {
      c12: { type: 'custom', name: 'emails', layout: 'flat' },
      c3: { type: 'custom', name: 'spa', layout: 'flat' },
    },
    slices: {
      c12: { fr: slice('c12', 'fr', { subject: leaf('9', 'Objet') }), en: slice('c12', 'en', { subject: leaf('9', 'Subject') }) },
      c3: { en: slice('c3', 'en', { 'home.title': leaf('1', 'Home') }), ar: slice('c3', 'ar', { 'home.title': leaf('1', 'الرئيسية') }) },
    },
    ...options,
  });
}

const run = (release: Built, extra: Partial<Parameters<typeof pull>[0]> = {}) =>
  pull({ deliveryUrl: DELIVERY_URL, apiKey: API_KEY, fetch: release.fetch, ...extra });

describe('pull', () => {
  it('returns every bundle and locale of the stage current release, sorted by bundle id then locale, with the release id and checksum', async () => {
    const release = twoBundles();
    const result = await run(release);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices.map((s) => `${s.bundle}/${s.locale}`)).toEqual(['c3/ar', 'c3/en', 'c12/en', 'c12/fr']);
    expect(result.releaseId).toBe(String(release.meta['releaseId']));
    expect(result.checksum).toBe(release.meta['checksum']);
  });

  it('keeps each slice exactly as the server sent it', async () => {
    const release = twoBundles();
    const result = await run(release, { bundles: ['spa'], locales: ['en'] });

    expect(result).toMatchObject({ ok: true, slices: [slice('c3', 'en', { 'home.title': leaf('1', 'Home') })] });
  });

  it('narrows to the named bundles and locales, matching a locale whatever its case', async () => {
    const result = await run(twoBundles(), { bundles: ['spa', 'emails'], locales: ['EN'] });

    expect(result.ok && result.slices.map((s) => `${s.bundle}/${s.locale}`)).toEqual(['c3/en', 'c12/en']);
  });

  it('produces slices that serve the default bundle through embedded before anything is downloaded', async () => {
    const result = await run(twoBundles(), { bundles: ['spa'], locales: ['en'] });
    if (!result.ok) throw new Error(result.reason);

    const snapshot = createSnapshot({ slices: new Map(), embedded: result.slices, locale: 'en', defaultBundle: { type: 'custom', name: 'spa' } });
    expect(snapshot.t('home.title')).toBe('Home');
  });

  it('works in origin mode, sending the key only in its header', async () => {
    const release = twoBundles({ mode: 'origin' });
    const result = await run(release, { locales: ['en'] });

    expect(result.ok).toBe(true);
    for (const { url } of release.requests) expect(url).not.toContain(API_KEY);
  });

  it('sends the app version when given, and none otherwise', async () => {
    const withVersion = twoBundles();
    await run(withVersion, { appVersion: 'v2.1.0' });
    const without = twoBundles();
    await run(without);

    expect(withVersion.requests[0]!.url).toContain('appVersion=2.1.0');
    expect(without.requests[0]!.url).not.toContain('appVersion');
  });

  describe('fails with a one-line reason and no slices', () => {
    const cases: [string, () => Promise<Awaited<ReturnType<typeof pull>>>, RegExp][] = [
      ['an invalid delivery URL', () => pull({ deliveryUrl: 'ftp://x', apiKey: API_KEY, fetch: twoBundles().fetch }), /delivery URL/],
      ['no key', () => pull({ deliveryUrl: DELIVERY_URL, apiKey: '', fetch: twoBundles().fetch }), /TARJIM_APIKEY/],
      ['a stage with nothing released', () => run(twoBundles({ hooks: [({ kind }: { kind: string }) => (kind === 'meta' ? problem(404, 'delivery.stage_unreleased') : undefined)] })), /no release/],
      ['a refused key', () => run(twoBundles({ hooks: [({ kind }: { kind: string }) => (kind === 'meta' ? problem(401, 'unauthorized') : undefined)] })), /401/],
      ['a manifest that fails its checksum', () => run(twoBundles({ tamper: { manifest: true } })), /checksum/],
      ['a slice that fails its hash', () => run(twoBundles({ tamper: { slices: { 'c3/en': 'hash' } } })), /hash/],
      ['a bundle the release does not have', () => run(twoBundles(), { bundles: ['nope'] }), /bundle "nope"/],
      ['a locale a chosen bundle does not have', () => run(twoBundles(), { bundles: ['spa'], locales: ['fr'] }), /locale "fr"/],
      ['a network failure', () => pull({ deliveryUrl: DELIVERY_URL, apiKey: API_KEY, fetch: vi.fn(async () => Promise.reject(new TypeError('offline'))) }), /network/],
    ];
    it.each(cases)('for %s', async (_label, attempt, reason) => {
      const result = await attempt();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(reason);
      expect(result.reason).not.toMatch(/\n/);
      expect(result.reason).not.toContain(API_KEY);
      expect(result.reason).not.toContain(SIGNED_QUERY);
    });
  });

  it('never repeats the key or a signature in what it returns', async () => {
    const result = await run(twoBundles());
    const text = JSON.stringify(result);

    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SIGNED_QUERY);
  });

  it('is typed as a list embedded accepts', async () => {
    const result = await run(twoBundles(), { bundles: ['spa'] });
    const embedded: Slice[] = result.ok ? result.slices : [];
    expect(embedded.length).toBe(2);
    expect(respond).toBeTypeOf('function');
  });
});
