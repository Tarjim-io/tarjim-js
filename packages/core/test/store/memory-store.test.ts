import { describe, expect, it } from 'vitest';
import { BUSY, MemoryStore } from '../../src/index.js';
import { slice, storeContract, until } from '../helpers/store-contract.js';
import type { StoreWorld } from '../helpers/store-contract.js';

function memoryWorld(): StoreWorld {
  const stores = new Map<string, MemoryStore>();
  return {
    async open(name) {
      let store = stores.get(name);
      if (!store) stores.set(name, (store = new MemoryStore(name)));
      return store;
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
