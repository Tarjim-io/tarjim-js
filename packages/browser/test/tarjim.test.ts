import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeId } from '@tarjim/core';
import type { Tarjim as Instance, TarjimReport } from '@tarjim/core';
import { Tarjim, browserPlatform } from '../src/index.js';
import { makeRelease, makeServer } from '../../core/test/helpers/cycle-world.js';
import { API_KEY, DELIVERY_URL, queryOf } from '../../core/test/support.js';
import { embedded, sleep, until, within } from '../../core/test/runtime/world.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 Safari/605.1.15';

interface FakeDocument {
  visibilityState: string;
  listeners: Map<string, Set<() => void>>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  dispatch(type: string): void;
}

function fakeDocument(visibilityState = 'visible'): FakeDocument {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState,
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
}

interface Page {
  document: FakeDocument;
  indexedDB: IDBFactory | undefined;
}

function stubPage(options: { languages?: string[]; userAgentData?: { platform: string } | undefined; secure?: boolean; hidden?: boolean; indexedDB?: IDBFactory | null } = {}): Page {
  const document = fakeDocument(options.hidden ? 'hidden' : 'visible');
  const indexedDB = options.indexedDB === null ? undefined : (options.indexedDB ?? new IDBFactory());
  vi.stubGlobal('navigator', {
    languages: options.languages ?? ['en'],
    userAgent: MAC_USER_AGENT,
    ...(options.userAgentData ? { userAgentData: options.userAgentData } : {}),
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('isSecureContext', options.secure ?? true);
  vi.stubGlobal('indexedDB', indexedDB);
  return { document, indexedDB };
}

const running: Instance[] = [];
beforeEach(() => stubPage());
afterEach(() => {
  for (const runtime of running.splice(0)) runtime.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function start(config: Record<string, unknown>): Promise<Instance> {
  const runtime = await Tarjim.start({
    deliveryUrl: DELIVERY_URL,
    apiKey: API_KEY,
    appVersion: '1.4.0',
    defaultBundle: { type: 'namespace', name: 'b1' },
    fallbackLanguage: 'en',
    embedded: [embedded('en'), embedded('fr')],
    ...config,
  } as never);
  running.push(runtime);
  return runtime;
}

describe('browserPlatform', () => {
  it('names the platform web', () => {
    expect(browserPlatform().name).toBe('web');
  });

  it('reads the visitor languages from the navigator when asked', () => {
    stubPage({ languages: ['fr-CA', 'en'] });
    const platform = browserPlatform();
    expect(platform.browserLanguages()).toEqual(['fr-CA', 'en']);
    stubPage({ languages: ['de'] });
    expect(platform.browserLanguages()).toEqual(['de']);
  });

  it('has no languages when the navigator has none', () => {
    vi.stubGlobal('navigator', {});
    expect(Array.from(browserPlatform().browserLanguages())).toEqual([]);
  });

  describe('the system version', () => {
    it('comes from the user agent data platform', () => {
      stubPage({ userAgentData: { platform: 'macOS' } });
      expect(browserPlatform().osVersion?.()).toBe('macOS');
    });

    it('is absent without user agent data, whatever the user agent string says', () => {
      stubPage();
      const version = browserPlatform().osVersion?.();
      expect(version).toBeUndefined();
      expect(String(version)).not.toContain('14_2');
    });
  });

  describe('the secure context', () => {
    it('is true on a secure page with crypto', () => {
      stubPage({ secure: true });
      expect(browserPlatform().secureContext).toBe(true);
    });

    it('is false on an insecure page', () => {
      stubPage({ secure: false });
      expect(browserPlatform().secureContext).toBe(false);
    });

    it('is false without crypto.subtle even on a secure page', () => {
      stubPage({ secure: true });
      vi.stubGlobal('crypto', { randomUUID: () => 'x' });
      expect(browserPlatform().secureContext).toBe(false);
    });
  });

  describe('visibility', () => {
    it('follows the document', () => {
      const { document } = stubPage({ hidden: true });
      const visibility = browserPlatform().visibility!;
      expect(visibility.visible()).toBe(false);
      document.visibilityState = 'visible';
      expect(visibility.visible()).toBe(true);
    });

    it('calls the listener on visibilitychange until it is removed', () => {
      const { document } = stubPage();
      const visibility = browserPlatform().visibility!;
      const listener = vi.fn();
      const off = visibility.onChange(listener);
      document.dispatch('visibilitychange');
      expect(listener).toHaveBeenCalledTimes(1);

      off();
      document.dispatch('visibilitychange');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(document.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
    });
  });

  it('sets and clears timers on the page timer', () => {
    vi.useFakeTimers();
    const { timers } = browserPlatform();
    const callback = vi.fn();
    timers!.set(callback, 1000);
    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(callback).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    timers!.clear(timers!.set(cancelled, 1000));
    vi.advanceTimersByTime(2000);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('gives the time, a random fraction and unique random ids', () => {
    const platform = browserPlatform();
    expect(Math.abs(platform.now() - Date.now())).toBeLessThan(1000);
    for (let i = 0; i < 20; i++) {
      const value = platform.random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    const a = platform.randomId();
    expect(a).toMatch(UUID);
    expect(platform.randomId()).not.toBe(a);
  });

  it('logs only to the quiet console levels', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const others = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((spy) => spy.mockImplementation(() => undefined));
    const platform = browserPlatform();

    platform.log('debug', 'quiet', { n: 1 });
    platform.log('info', 'louder');

    expect(debug).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(debug.mock.calls[0])).toContain('quiet');
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls[0])).toContain('louder');
    for (const spy of others) expect(spy).not.toHaveBeenCalled();
  });

  it('opens the page store for the delivery URL and key', async () => {
    const opened = await browserPlatform().openStore(DELIVERY_URL, API_KEY);
    expect(opened.degradedReason).toBeUndefined();
    expect(opened.store.degraded).toBe(false);
    expect(opened.store.id).toBe(await storeId(DELIVERY_URL, API_KEY));
    opened.store.close();
  });

  it('opens a degraded store when the page has no IndexedDB', async () => {
    stubPage({ indexedDB: null });
    const opened = await browserPlatform().openStore(DELIVERY_URL, API_KEY);
    expect(opened.store.degraded).toBe(true);
    expect(opened.degradedReason).toEqual(expect.any(String));
  });
});

describe('Tarjim.start in a page', () => {
  it('answers from the embedded text and then from the downloaded release', async () => {
    const server = makeServer(makeRelease());
    const runtime = await within(start({ fetch: server.fetch }));

    expect(runtime.ready).toBe(true);
    expect(runtime.t('a')).toBe('embedded a');
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    expect(server.metaQuery(0)['platform']).toBe('web');
  });

  it('uses the page fetch when the configuration gives none', async () => {
    const server = makeServer(makeRelease());
    const pageFetch = vi.fn(server.fetch);
    vi.stubGlobal('fetch', pageFetch);
    const runtime = await start({});
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    expect(pageFetch).toHaveBeenCalled();
  });

  it('sends the visitor language and the system version, and picks the matching text', async () => {
    stubPage({ languages: ['fr-CA', 'en'], userAgentData: { platform: 'Windows' } });
    const server = makeServer(makeRelease());
    const runtime = await start({ fetch: server.fetch });

    expect(runtime.language).toBe('fr');
    await until(() => runtime.t('a') === 'v1 b1 fr', 'the French text');
    const query = server.metaQuery(0);
    expect(query['language']).toBe('fr');
    expect(query['osVersion']).toBe('Windows');
  });

  it('sends no system version when the browser does not tell', async () => {
    const server = makeServer(makeRelease());
    const runtime = await start({ fetch: server.fetch });
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    expect(server.metaQuery(0)).not.toHaveProperty('osVersion');
  });

  it('keeps a downloaded release for the next page load, which then shows it', async () => {
    const { indexedDB } = stubPage();
    const server = makeServer(makeRelease());
    const first = await start({ fetch: server.fetch });
    await until(() => first.t('a') === 'v1 b1 en', 'the release');
    server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    expect(await first.checkNow()).toBe('downloaded');
    expect(first.t('a')).toBe('v1 b1 en');
    first.stop();

    stubPage({ indexedDB: indexedDB! });
    server.on('meta', () => new Error('offline'));
    const second = await within(start({ fetch: server.fetch }));
    expect(second.t('a')).toBe('v2 b1 en');
  });

  it('creates an install id in the page store and sends it on later checks', async () => {
    const server = makeServer(makeRelease());
    const runtime = await start({ fetch: server.fetch });
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    await runtime.checkNow();

    expect(queryOf(server.requests('meta').slice(-1)[0]!.url)['installId']).toMatch(UUID);
  });

  it('serves the embedded text and asks for nothing when the page has no IndexedDB', async () => {
    stubPage({ indexedDB: null });
    const server = makeServer(makeRelease());
    const reports: TarjimReport[] = [];
    const runtime = await within(start({ fetch: server.fetch, onReport: (report: TarjimReport) => reports.push(report) }));
    await runtime.checkNow();
    await sleep(40);

    expect(runtime.t('a')).toBe('embedded a');
    expect(server.log).toEqual([]);
    expect(reports.map((report) => report.code)).toEqual(['storage-unavailable']);
  });

  it('serves the embedded text and asks for nothing on an insecure page', async () => {
    stubPage({ secure: false });
    const server = makeServer(makeRelease());
    const runtime = await start({ fetch: server.fetch });
    await runtime.checkNow();
    await sleep(40);
    expect(runtime.t('a')).toBe('embedded a');
    expect(server.log).toEqual([]);
  });

  it('waits to check while the page is hidden and checks when it shows', async () => {
    const { document } = stubPage({ hidden: true });
    const server = makeServer(makeRelease());
    await start({ fetch: server.fetch });
    await sleep(60);
    expect(server.count('meta')).toBe(0);

    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    await until(() => server.count('meta') === 1, 'the check on showing the page');
  });

  it('stops checking and listening on stop()', async () => {
    const { document } = stubPage();
    const server = makeServer(makeRelease());
    const runtime = await start({ fetch: server.fetch });
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    await sleep(40);

    runtime.stop();
    expect(document.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
  });

  it('is a new, independent instance each time', async () => {
    const server = makeServer(makeRelease());
    const a = await start({ fetch: server.fetch, language: 'en' });
    const b = await start({ fetch: server.fetch, language: 'en' });
    expect(a).not.toBe(b);
    await a.setLanguage('fr');
    expect(b.language).toBe('en');
  });
});
