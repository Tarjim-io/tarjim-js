import { BUSY, installHashes, mergeState, runWithProcessLock, sanitiseInstall, sanitiseState, sha256Hex } from '@tarjim/core';
import type { Install, State, Store } from '@tarjim/core';

export const DATABASE_NAME = 'tarjim-delivery-v1';

export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

type Settle<T> = (value: T) => void;
type Fail = (error: unknown) => void;

const isQuota = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === 'QuotaExceededError';

/**
 * Runs `work` in one transaction and resolves with the value it passed to `settle` once the transaction
 * has committed. The transaction only stays open while requests are pending, so `work` and its callbacks
 * may not wait on anything but IndexedDB requests.
 */
function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, settle: Settle<T>, fail: Fail) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let tx: IDBTransaction | undefined;
    const fail: Fail = (error) => {
      reject(error);
      try {
        tx?.abort();
      } catch {
        // already finished
      }
    };
    try {
      tx = db.transaction(stores, mode);
      tx.oncomplete = () => resolve(result);
      // A refused write (quota included) arrives here, not as an exception from the call.
      tx.onabort = () => reject(tx?.error ?? new Error('transaction aborted'));
      work(tx, (value) => (result = value), fail);
    } catch (error) {
      fail(error);
    }
  });
}

/** Runs `then` with a request's result; an exception inside it aborts the transaction. */
function onResult<R>(request: IDBRequest<R>, fail: Fail, then: (result: R) => void): void {
  request.onsuccess = () => {
    try {
      then(request.result);
    } catch (error) {
      fail(error);
    }
  };
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array((value as ArrayBuffer).slice(0));
  return undefined;
}

export class IndexedDbStore implements Store {
  readonly id: string;
  degraded = false;
  private readonly db: IDBDatabase;
  private readonly locks: LockManagerLike | undefined;

  constructor(id: string, database: IDBDatabase, locks?: LockManagerLike) {
    this.id = id;
    this.db = database;
    this.locks = locks;
  }

  withLock<T>(fn: () => Promise<T>): Promise<T | typeof BUSY> {
    const locks = this.locks ?? (globalThis.navigator?.locks as LockManagerLike | undefined);
    if (!locks) return runWithProcessLock(this.id, fn);
    return locks.request(`tarjim:${this.id}`, { ifAvailable: true }, async (lock) => (lock === null ? BUSY : fn()));
  }

  async readState(): Promise<State> {
    try {
      return await transact<State>(this.db, ['state'], 'readonly', (tx, settle, fail) => {
        onResult(tx.objectStore('state').get(this.id), fail, (raw) => settle(sanitiseState(raw)));
      });
    } catch {
      return {};
    }
  }

  async updateState(change: (state: State) => State): Promise<State> {
    try {
      return await transact<State>(this.db, ['state'], 'readwrite', (tx, settle, fail) => {
        const store = tx.objectStore('state');
        onResult(store.get(this.id), fail, (raw) => {
          const next = sanitiseState(change(sanitiseState(raw)));
          store.put(mergeState(raw, next), this.id);
          settle(next);
        });
      });
    } catch (error) {
      if (isQuota(error)) this.degraded = true;
      throw error;
    }
  }

  async putSlice(hash: string, bytes: Uint8Array): Promise<'stored' | 'held' | 'quota'> {
    try {
      return await transact<'stored' | 'held'>(this.db, ['slices'], 'readwrite', (tx, settle, fail) => {
        const slices = tx.objectStore('slices');
        const key = [this.id, hash];
        // Checked inside the transaction so two tabs racing on one hash cannot both write.
        onResult(slices.get(key), fail, (existing) => {
          if (existing !== undefined) return settle('held');
          slices.put(bytes.slice(), key);
          settle('stored');
        });
      });
    } catch (error) {
      if (!isQuota(error)) throw error;
      this.degraded = true;
      return 'quota';
    }
  }

  async readSlices(hashes: string[]): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>();
    let raw: Map<string, unknown>;
    try {
      raw = await transact<Map<string, unknown>>(this.db, ['slices'], 'readonly', (tx, settle, fail) => {
        const slices = tx.objectStore('slices');
        const read = new Map<string, unknown>();
        const wanted = [...new Set(hashes)];
        settle(read);
        for (const hash of wanted) {
          onResult(slices.get([this.id, hash]), fail, (value) => {
            if (value !== undefined) read.set(hash, value);
          });
        }
      });
    } catch {
      return found;
    }
    // Hashed after the transaction: awaiting inside one would let it commit early.
    for (const [hash, value] of raw) {
      const bytes = toBytes(value);
      if (bytes && (await sha256Hex(bytes)) === hash) found.set(hash, bytes);
    }
    return found;
  }

  async writeInstall(install: Install, as: 'active' | 'pending'): Promise<boolean> {
    const clean = sanitiseInstall(install);
    if (!clean) return false;
    try {
      return await transact<boolean>(this.db, ['slices', 'state'], 'readwrite', (tx, settle, fail) => {
        const slices = tx.objectStore('slices');
        const state = tx.objectStore('state');
        const hashes = installHashes(clean);
        let missing = false;
        let outstanding = hashes.length;

        const write = (): void => {
          if (missing) return settle(false);
          onResult(state.get(this.id), fail, (raw) => {
            const next: State = { ...sanitiseState(raw), [as]: clean };
            if (as === 'active') delete next.pending;
            state.put(mergeState(raw, next), this.id);
            settle(true);
          });
        };

        settle(false);
        if (outstanding === 0) return write();
        for (const hash of hashes) {
          onResult(slices.count([this.id, hash]), fail, (count) => {
            if (count === 0) missing = true;
            if (--outstanding === 0) write();
          });
        }
      });
    } catch (error) {
      if (!isQuota(error)) throw error;
      this.degraded = true;
      return false;
    }
  }

  async cleanup(): Promise<void> {
    await transact<void>(this.db, ['slices', 'state'], 'readwrite', (tx, _settle, fail) => {
      const slices = tx.objectStore('slices');
      onResult(tx.objectStore('state').get(this.id), fail, (raw) => {
        const state = sanitiseState(raw);
        const keep = new Set([state.active, state.pending].flatMap((install) => (install ? installHashes(install) : [])));
        // Keys are listed and filtered rather than range-bound: a key range needs the IDBKeyRange global,
        // which does not exist next to an injected factory.
        onResult(slices.getAllKeys(), fail, (keys) => {
          for (const key of keys) {
            if (Array.isArray(key) && key[0] === this.id && !keep.has(key[1] as string)) slices.delete(key);
          }
        });
      });
    });
  }

  close(): void {
    this.db.close();
  }
}
