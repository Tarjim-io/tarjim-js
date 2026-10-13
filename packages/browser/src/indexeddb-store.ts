import { BUSY, installHashes, mergeState, runWithProcessLock, sanitiseInstall, sanitiseState, sha256Hex } from '@tarjim/core';
import type { Install, State, Store } from '@tarjim/core';

export const DATABASE_NAME = 'tarjim-delivery-v1';

export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export type KeyRangeLike = Pick<typeof IDBKeyRange, 'bound'>;

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

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

export class IndexedDbStore implements Store {
  readonly id: string;
  degraded = false;
  private readonly db: IDBDatabase;
  private readonly locks: LockManagerLike | undefined;
  private readonly keyRange: KeyRangeLike | undefined;

  constructor(id: string, database: IDBDatabase, locks?: LockManagerLike, keyRange?: KeyRangeLike) {
    this.id = id;
    this.db = database;
    this.locks = locks;
    this.keyRange = keyRange;
    // A newer tab upgrading the database, or the browser dropping the connection, ends this store for good.
    database.onversionchange = () => {
      this.degraded = true;
      database.close();
    };
    database.onclose = () => {
      this.degraded = true;
    };
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
      this.degraded = true;
      return {};
    }
  }

  async updateState(change: (state: State) => State): Promise<State> {
    // An object, not locals: the callbacks assign these after TypeScript has narrowed them.
    const run: { attempted?: State; changeThrew: boolean } = { changeThrew: false };
    try {
      return await transact<State>(this.db, ['state'], 'readwrite', (tx, settle, fail) => {
        const store = tx.objectStore('state');
        onResult(store.get(this.id), fail, (raw) => {
          try {
            run.attempted = sanitiseState(change(sanitiseState(raw)));
          } catch (error) {
            run.changeThrew = true;
            throw error;
          }
          store.put(mergeState(raw, run.attempted), this.id);
          settle(run.attempted);
        });
      });
    } catch (error) {
      if (run.changeThrew) throw error;
      this.degraded = true;
      if (run.attempted) return run.attempted;
      // The record was never read, so the change is applied to an empty state.
      try {
        return sanitiseState(change({}));
      } catch {
        return {};
      }
    }
  }

  async putSlice(hash: string, bytes: Uint8Array): Promise<'stored' | 'held' | 'quota' | 'unavailable'> {
    const key = [this.id, hash];
    try {
      // Checked inside the transaction so two tabs racing on one hash cannot both write.
      const first = await transact<{ existing?: unknown }>(this.db, ['slices'], 'readwrite', (tx, settle, fail) => {
        const slices = tx.objectStore('slices');
        onResult(slices.get(key), fail, (existing) => {
          if (existing === undefined) slices.put(bytes.slice(), key);
          settle({ existing });
        });
      });
      if (first.existing === undefined) return 'stored';
      const held = toBytes(first.existing);
      if (held && (await sha256Hex(held)) === hash) return 'held';

      // The held record is damaged. It is only replaced if it is still the damaged one just seen.
      return await transact<'stored' | 'held'>(this.db, ['slices'], 'readwrite', (tx, settle, fail) => {
        const slices = tx.objectStore('slices');
        onResult(slices.get(key), fail, (current) => {
          const now = toBytes(current);
          if (current !== undefined && now && !(held && sameBytes(now, held))) return settle('held');
          slices.put(bytes.slice(), key);
          settle('stored');
        });
      });
    } catch (error) {
      this.degraded = true;
      return isQuota(error) ? 'quota' : 'unavailable';
    }
  }

  async readSlices(hashes: string[]): Promise<Map<string, Uint8Array>> {
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
      this.degraded = true;
      return new Map();
    }
    // Hashed after the transaction: awaiting inside one would let it commit early.
    const checked = await Promise.all(
      [...raw].map(async ([hash, value]): Promise<[string, Uint8Array] | undefined> => {
        const bytes = toBytes(value);
        return bytes && (await sha256Hex(bytes)) === hash ? [hash, bytes] : undefined;
      }),
    );
    return new Map(checked.filter((entry) => entry !== undefined));
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
    } catch {
      this.degraded = true;
      return false;
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.sweep();
    } catch {
      this.degraded = true;
    }
  }

  private async sweep(): Promise<void> {
    await transact<void>(this.db, ['slices', 'state'], 'readwrite', (tx, _settle, fail) => {
      const slices = tx.objectStore('slices');
      onResult(tx.objectStore('state').get(this.id), fail, (raw) => {
        const state = sanitiseState(raw);
        const keep = new Set([state.active, state.pending].flatMap((install) => (install ? installHashes(install) : [])));
        // The id check stays even with a range: it is what keeps a sibling's slices safe if the range is wrong.
        const range = this.ownKeys();
        onResult(range ? slices.getAllKeys(range) : slices.getAllKeys(), fail, (keys) => {
          for (const key of keys) {
            if (Array.isArray(key) && key[0] === this.id && !keep.has(key[1] as string)) slices.delete(key);
          }
        });
      });
    });
  }

  // Without a key range implementation the whole store is listed and filtered instead.
  private ownKeys(): IDBKeyRange | undefined {
    let range = this.keyRange;
    if (!range) {
      try {
        range = globalThis.IDBKeyRange;
      } catch {
        // reading the global can throw in a sandboxed frame
      }
    }
    // [id, []] sorts after every [id, <string>], since arrays sort after strings.
    return range?.bound([this.id], [this.id, []]);
  }

  close(): void {
    this.db.close();
  }
}
