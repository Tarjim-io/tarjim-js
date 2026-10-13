import { MemoryStore, storeId } from '@tarjim/core';
import type { Store } from '@tarjim/core';
import { DATABASE_NAME, IndexedDbStore } from './indexeddb-store.js';
import type { LockManagerLike } from './indexeddb-store.js';

export interface OpenStoreOptions {
  deliveryUrl: string;
  apiKey: string;
  indexedDB?: IDBFactory;
  locks?: LockManagerLike;
  timeoutMs?: number;
}

export interface OpenedStore {
  store: Store;
  degradedReason?: 'unavailable' | 'blocked' | 'error';
}

type OpenResult = { db: IDBDatabase } | { reason: 'blocked' | 'error' };

function openDatabase(factory: IDBFactory, timeoutMs: number): Promise<OpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OpenResult): void => {
      if (settled) {
        // An open that completes after the cap has nobody to use it.
        if ('db' in result) result.db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ reason: 'blocked' }), timeoutMs);
    try {
      // The version never changes: a new format gets a new database name.
      const request = factory.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('slices');
        request.result.createObjectStore('state');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        const complete = db.objectStoreNames.contains('slices') && db.objectStoreNames.contains('state');
        finish(complete ? { db } : { reason: 'error' });
        if (!complete) db.close();
      };
      request.onerror = () => finish({ reason: 'error' });
    } catch {
      finish({ reason: 'error' });
    }
  });
}

/** Never rejects: whatever goes wrong, the caller gets a working in-memory store marked degraded. */
export async function openStore(options: OpenStoreOptions): Promise<OpenedStore> {
  let id: string;
  try {
    id = await storeId(options.deliveryUrl, options.apiKey);
  } catch {
    return { store: new MemoryStore('unhashed', { degraded: true }), degradedReason: 'error' };
  }
  const fallback = (degradedReason: 'unavailable' | 'blocked' | 'error'): OpenedStore => ({
    store: new MemoryStore(id, { degraded: true }),
    degradedReason,
  });

  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) return fallback('unavailable');
  const opened = await openDatabase(factory, options.timeoutMs ?? 3000);
  if (!('db' in opened)) return fallback(opened.reason);
  return { store: new IndexedDbStore(id, opened.db, options.locks) };
}
