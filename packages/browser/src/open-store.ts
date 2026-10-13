import type { Store } from '@tarjim/core';
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

export async function openStore(_options: OpenStoreOptions): Promise<OpenedStore> {
  throw new Error('not implemented');
}
