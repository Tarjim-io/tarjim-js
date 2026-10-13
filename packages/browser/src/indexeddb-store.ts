import { BUSY } from '@tarjim/core';
import type { Install, State, Store } from '@tarjim/core';

export const DATABASE_NAME = 'tarjim-delivery-v1';

export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export class IndexedDbStore implements Store {
  readonly id: string;
  degraded = false;

  constructor(id: string, _database: IDBDatabase, _locks?: LockManagerLike) {
    this.id = id;
  }

  withLock<T>(_fn: () => Promise<T>): Promise<T | typeof BUSY> {
    throw new Error('not implemented');
  }
  readState(): Promise<State> {
    throw new Error('not implemented');
  }
  updateState(_change: (state: State) => State): Promise<State> {
    throw new Error('not implemented');
  }
  putSlice(_hash: string, _bytes: Uint8Array): Promise<'stored' | 'held' | 'quota'> {
    throw new Error('not implemented');
  }
  readSlices(_hashes: string[]): Promise<Map<string, Uint8Array>> {
    throw new Error('not implemented');
  }
  writeInstall(_install: Install, _as: 'active' | 'pending'): Promise<boolean> {
    throw new Error('not implemented');
  }
  cleanup(): Promise<void> {
    throw new Error('not implemented');
  }
  close(): void {}
}
