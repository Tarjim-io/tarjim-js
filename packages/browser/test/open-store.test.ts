import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, storeId } from '@tarjim/core';
import { DATABASE_NAME, openStore } from '../src/index.js';
import { API_KEY, DELIVERY_URL, FakeLocks, openRaw, request } from './helpers/idb-world.js';
import { makeInstall, slice } from '../../core/test/helpers/store-contract.js';

const options = { deliveryUrl: DELIVERY_URL, apiKey: API_KEY };

/** An open request that fires only the events a test asks for, through both `on…` and listeners. */
class FakeOpenRequest extends EventTarget {
  error: DOMException | null = null;
  result: unknown = undefined;
  fire(type: string): void {
    const event = new Event(type);
    this.dispatchEvent(event);
    (this as unknown as Record<string, ((e: Event) => void) | undefined>)[`on${type}`]?.call(this, event);
  }
}

function fakeFactory(open: () => IDBOpenDBRequest): IDBFactory {
  return { open } as unknown as IDBFactory;
}

async function useStore(store: { putSlice: MemoryStore['putSlice']; readSlices: MemoryStore['readSlices'] }) {
  const one = slice('still works');
  expect(await store.putSlice(one.hash, one.bytes)).toBe('stored');
  expect([...(await store.readSlices([one.hash])).keys()]).toEqual([one.hash]);
}

describe('openStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens a working, not degraded store when IndexedDB is there', async () => {
    const opened = await openStore({ ...options, indexedDB: new IDBFactory(), locks: new FakeLocks() });
    expect(opened.degradedReason).toBeUndefined();
    expect(opened.store.degraded).toBe(false);
    expect(opened.store.id).toBe(await storeId(DELIVERY_URL, API_KEY));
    await useStore(opened.store);
    opened.store.close();
  });

  it('falls back to a degraded in-memory store when there is no IndexedDB', async () => {
    const opened = await openStore(options);
    expect(opened.degradedReason).toBe('unavailable');
    expect(opened.store.degraded).toBe(true);
    expect(opened.store).toBeInstanceOf(MemoryStore);
    expect(opened.store.id).toBe(await storeId(DELIVERY_URL, API_KEY));
    await useStore(opened.store);
  });

  it('resolves as blocked, within the time cap, when the open never completes', async () => {
    const hung = fakeFactory(() => new FakeOpenRequest() as unknown as IDBOpenDBRequest);
    const start = performance.now();
    const opened = await openStore({ ...options, indexedDB: hung, timeoutMs: 50 });
    const elapsed = performance.now() - start;
    expect(opened.degradedReason).toBe('blocked');
    expect(opened.store.degraded).toBe(true);
    expect(elapsed).toBeLessThan(500);
    await useStore(opened.store);
  });

  it('resolves as blocked when the open only ever reports being blocked', async () => {
    const hung = fakeFactory(() => {
      const req = new FakeOpenRequest();
      setTimeout(() => req.fire('blocked'), 1);
      return req as unknown as IDBOpenDBRequest;
    });
    const opened = await openStore({ ...options, indexedDB: hung, timeoutMs: 50 });
    expect(opened.degradedReason).toBe('blocked');
    expect(opened.store.degraded).toBe(true);
  });

  it('resolves as an error when the open request fails', async () => {
    const failing = fakeFactory(() => {
      const req = new FakeOpenRequest();
      req.error = new DOMException('denied', 'UnknownError');
      setTimeout(() => req.fire('error'), 1);
      return req as unknown as IDBOpenDBRequest;
    });
    const opened = await openStore({ ...options, indexedDB: failing, timeoutMs: 500 });
    expect(opened.degradedReason).toBe('error');
    expect(opened.store.degraded).toBe(true);
    await useStore(opened.store);
  });

  it('resolves as an error when opening throws', async () => {
    const throwing = fakeFactory(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const opened = await openStore({ ...options, indexedDB: throwing });
    expect(opened.degradedReason).toBe('error');
    expect(opened.store.degraded).toBe(true);
  });

  it('opens version 1 of tarjim-delivery-v1 and nothing else', async () => {
    const factory = new IDBFactory();
    const open = vi.spyOn(factory, 'open');
    const opened = await openStore({ ...options, indexedDB: factory, locks: new FakeLocks() });
    expect(opened.degradedReason).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]).toEqual(['tarjim-delivery-v1', 1]);
    expect(DATABASE_NAME).toBe('tarjim-delivery-v1');

    const databases = await factory.databases();
    expect(databases).toEqual([{ name: 'tarjim-delivery-v1', version: 1 }]);
    const raw = await openRaw(factory);
    expect(Array.from(raw.objectStoreNames).sort()).toEqual(['slices', 'state']);
    raw.close();
    opened.store.close();
  });

  it('never asks the browser to persist storage or reads its quota', async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    const estimate = vi.fn(async () => ({}));
    vi.stubGlobal('navigator', { storage: { persist, persisted, estimate } });

    const opened = await openStore({ ...options, indexedDB: new IDBFactory(), locks: new FakeLocks() });
    const store = opened.store;
    const one = slice('one');
    await store.putSlice(one.hash, one.bytes);
    await store.writeInstall(makeInstall({ 'ui\nen': one.hash }), 'active');
    await store.cleanup();
    expect(opened.degradedReason).toBeUndefined();
    expect((await store.readState()).active).toBeDefined();
    store.close();

    expect(persist).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
  });

  it('is not blocked by another opener asking for a newer version', async () => {
    const factory = new IDBFactory();
    const opened = await openStore({ ...options, indexedDB: factory, locks: new FakeLocks() });
    expect(opened.degradedReason).toBeUndefined();

    let blocked = false;
    const upgrade = factory.open(DATABASE_NAME, 2);
    upgrade.onblocked = () => (blocked = true);
    upgrade.onupgradeneeded = () => undefined;
    const db = await Promise.race([
      request(upgrade),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the upgrade stayed blocked')), 1000)),
    ]);
    expect(db.version).toBe(2);
    expect(blocked).toBe(false);
    db.close();
  });

  it('keeps one database per format: a second open of the same factory reads the first one\'s data', async () => {
    const factory = new IDBFactory();
    const locks = new FakeLocks();
    const first = await openStore({ ...options, indexedDB: factory, locks });
    const one = slice('persisted');
    await first.store.putSlice(one.hash, one.bytes);
    await first.store.updateState((state) => ({ ...state, lastCheck: 11 }));
    first.store.close();

    const second = await openStore({ ...options, indexedDB: factory, locks });
    expect(second.degradedReason).toBeUndefined();
    expect((await second.store.readState()).lastCheck).toBe(11);
    expect([...(await second.store.readSlices([one.hash])).keys()]).toEqual([one.hash]);
    second.store.close();
  });
});
