import { IDBFactory } from 'fake-indexeddb';
import { DATABASE_NAME, openStore } from '../../src/internal.js';
import type { LockManagerLike } from '../../src/internal.js';
import type { Store } from '@tarjim/core';
import { API_KEY, DELIVERY_URL } from '../../../core/test/helpers/store-contract.js';
import type { StoreWorld } from '../../../core/test/helpers/store-contract.js';

export { API_KEY, DELIVERY_URL };

/** Models `ifAvailable`: a name that is held is not granted and the callback gets null. */
export class FakeLocks implements LockManagerLike {
  readonly requests: Array<{ name: string; options: { ifAvailable: boolean } }> = [];
  private readonly held = new Set<string>();

  async request<T>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T> {
    this.requests.push({ name, options });
    if (options.ifAvailable && this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

export interface IdbWorld extends StoreWorld {
  factory: IDBFactory;
  locks: FakeLocks;
  /** The api key a name was opened with, so a test can look for it in the raw database. */
  keyOf(name: string): string;
  dispose(): void;
}

export function createIdbWorld(factory: IDBFactory = new IDBFactory()): IdbWorld {
  const locks = new FakeLocks();
  const opened: Store[] = [];
  const keyOf = (name: string) => `${API_KEY}-${name}`;
  return {
    factory,
    locks,
    keyOf,
    async tamper(_name, hash, bytes) {
      if ((await tamperSlice(factory, hash, bytes)) === 0) throw new Error('nothing to tamper with');
    },
    async open(name) {
      const result = await openStore({ deliveryUrl: DELIVERY_URL, apiKey: keyOf(name), indexedDB: factory, locks });
      if (result.degradedReason) throw new Error(`store opened degraded: ${result.degradedReason}`);
      opened.push(result.store);
      return result.store;
    },
    dispose() {
      for (const store of opened) store.close();
    },
  };
}

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openRaw(factory: IDBFactory): Promise<IDBDatabase> {
  return request(factory.open(DATABASE_NAME) as IDBOpenDBRequest);
}

export interface RawRecord {
  store: string;
  key: IDBValidKey;
  value: unknown;
}

export async function dumpRaw(factory: IDBFactory): Promise<RawRecord[]> {
  const db = await openRaw(factory);
  const records: RawRecord[] = [];
  for (const name of Array.from(db.objectStoreNames)) {
    const objectStore = db.transaction(name).objectStore(name);
    const keys = await request(objectStore.getAllKeys());
    const values = await request(objectStore.getAll());
    keys.forEach((key, i) => records.push({ store: name, key, value: values[i] }));
  }
  db.close();
  return records;
}

/** Every key and value flattened to text, byte arrays included, for substring scans. */
export function flatten(records: RawRecord[]): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (value instanceof Uint8Array) parts.push(new TextDecoder().decode(value), Buffer.from(value).toString('hex'));
    else if (value instanceof ArrayBuffer) walk(new Uint8Array(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        parts.push(k);
        walk(v);
      }
    } else parts.push(String(value));
  };
  for (const record of records) {
    walk(record.key);
    walk(record.value);
  }
  return parts.join('\n');
}

/** Replaces the stored bytes of every slice record whose key mentions `hash`, whatever the record shape. */
export async function tamperSlice(factory: IDBFactory, hash: string, replacement: Uint8Array): Promise<number> {
  const db = await openRaw(factory);
  const tx = db.transaction('slices', 'readwrite');
  const objectStore = tx.objectStore('slices');
  let changed = 0;
  await new Promise<void>((resolve, reject) => {
    const cursor = objectStore.openCursor();
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) return resolve();
      if (JSON.stringify(at.key).includes(hash)) {
        const value = at.value as unknown;
        let next: unknown = value;
        if (value instanceof Uint8Array || value instanceof ArrayBuffer) next = replacement;
        else if (value && typeof value === 'object') {
          next = Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, v instanceof Uint8Array || v instanceof ArrayBuffer ? replacement : v]),
          );
        }
        at.update(next);
        changed++;
      }
      at.continue();
    };
  });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return changed;
}

export async function putRawState(factory: IDBFactory, id: string, value: unknown): Promise<void> {
  const db = await openRaw(factory);
  const tx = db.transaction('state', 'readwrite');
  await request(tx.objectStore('state').put(value, id));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function readRawState(factory: IDBFactory, id: string): Promise<unknown> {
  const db = await openRaw(factory);
  const value = await request(db.transaction('state').objectStore('state').get(id));
  db.close();
  return value;
}
