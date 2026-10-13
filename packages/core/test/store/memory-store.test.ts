import { describe, expect, it, vi } from 'vitest';
import { BUSY, MemoryStore } from '../../src/internal.js';
import { makeInstall, slice, storeContract, until } from '../helpers/store-contract.js';
import type { StoreWorld } from '../helpers/store-contract.js';

function memoryWorld(): StoreWorld {
  const stores = new Map<string, MemoryStore>();
  return {
    async open(name) {
      let store = stores.get(name);
      if (!store) stores.set(name, (store = new MemoryStore(name)));
      return store;
    },
    async tamper(name, hash, bytes) {
      (stores.get(name) as unknown as { slices: Map<string, Uint8Array> }).slices.set(hash, bytes);
    },
  };
}

storeContract('MemoryStore', memoryWorld);

describe('MemoryStore', () => {
  it('keeps a lock per id across instances in the same process', async () => {
    const one = new MemoryStore('shared-id');
    const two = new MemoryStore('shared-id');
    let entered = false;
    let release!: () => void;
    const holding = one.withLock(async () => {
      entered = true;
      await new Promise<void>((resolve) => (release = resolve));
    });
    await until(() => entered, 'the holder to start');
    expect(await two.withLock(async () => 'ran')).toBe(BUSY);
    release();
    await holding;
    expect(await two.withLock(async () => 'ran')).toBe('ran');
  });

  it('does not report quota for an ordinary slice', async () => {
    const store = new MemoryStore('a');
    const one = slice('one');
    expect(await store.putSlice(one.hash, one.bytes)).toBe('stored');
    expect(store.degraded).toBe(false);
  });
});

describe('MemoryStore state written by something newer', () => {
  const seed = (store: MemoryStore, record: unknown): void => {
    (store as unknown as { state: unknown }).state = record;
  };
  const raw = (store: MemoryStore): Record<string, unknown> => (store as unknown as { state: Record<string, unknown> }).state;

  it('keeps an unknown field through updateState, dropping only what the change removed', async () => {
    const store = new MemoryStore('a');
    seed(store, { futureField: 'x', lastCheck: 1, languageOverride: 'fr' });
    await store.updateState(({ languageOverride: _removed, ...rest }) => ({ ...rest, backoffStep: 2 }));
    expect(raw(store)).toEqual({ futureField: 'x', lastCheck: 1, backoffStep: 2 });
  });

  it('keeps an unknown field through writeInstall, and an active write still clears pending', async () => {
    const store = new MemoryStore('a');
    const one = slice('one');
    await store.putSlice(one.hash, one.bytes);
    seed(store, { futureField: 'x', pending: makeInstall({ 'ui\nen': one.hash }, { checksum: 'b'.repeat(64) }) });
    expect(await store.writeInstall(makeInstall({ 'ui\nen': one.hash }), 'active')).toBe(true);
    expect(raw(store).futureField).toBe('x');
    expect(raw(store).pending).toBeUndefined();
  });
});

describe('MemoryStore slices', () => {
  it('does not rewrite a held slice whose bytes are valid', async () => {
    const store = new MemoryStore('a');
    const one = slice('one');
    await store.putSlice(one.hash, one.bytes);
    const slices = (store as unknown as { slices: Map<string, Uint8Array> }).slices;
    const set = vi.spyOn(slices, 'set');
    expect(await store.putSlice(one.hash, one.bytes)).toBe('held');
    expect(set).not.toHaveBeenCalled();
  });
});
