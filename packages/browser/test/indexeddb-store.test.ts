import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { BUSY, storeId } from '@tarjim/core';
import { makeInstall, slice, storeContract, until } from '../../core/test/helpers/store-contract.js';
import {
  API_KEY,
  DELIVERY_URL,
  createIdbWorld,
  dumpRaw,
  flatten,
  putRawState,
  readRawState,
  tamperSlice,
} from './helpers/idb-world.js';

storeContract('IndexedDbStore', () => createIdbWorld());

describe('IndexedDbStore', () => {
  describe('raw tampering', () => {
    it('leaves out a slice whose bytes were altered behind its back', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      const altered = slice('altered later');
      const untouched = slice('untouched');
      await store.putSlice(altered.hash, altered.bytes);
      await store.putSlice(untouched.hash, untouched.bytes);

      expect(await tamperSlice(world.factory, altered.hash, new TextEncoder().encode('not the original'))).toBeGreaterThan(0);

      const read = await store.readSlices([altered.hash, untouched.hash]);
      expect([...read.keys()]).toEqual([untouched.hash]);
      world.dispose();
    });
  });

  describe('held slices', () => {
    it('does not write again when the held bytes are valid', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      const one = slice('one');
      await store.putSlice(one.hash, one.bytes);
      const put = vi.spyOn(IDBObjectStore.prototype, 'put');
      try {
        expect(await store.putSlice(one.hash, one.bytes)).toBe('held');
        expect(put).not.toHaveBeenCalled();
      } finally {
        put.mockRestore();
        world.dispose();
      }
    });
  });

  describe('raw garbage in the state record', () => {
    it.each([
      ['a string', 'garbage'],
      ['an array', [1, 2, 3]],
      ['null', null],
      ['a number', 42],
    ])('reads %s as an empty state and still accepts updates', async (_label, garbage) => {
      const world = createIdbWorld();
      const store = await world.open('a');
      await putRawState(world.factory, store.id, garbage);
      expect(await store.readState()).toEqual({});
      expect(await store.updateState((state) => ({ ...state, lastCheck: 3 }))).toEqual({ lastCheck: 3 });
      world.dispose();
    });

    it('drops a field of the wrong shape and keeps the good ones', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      await putRawState(world.factory, store.id, { active: 5, lastCheck: 7 });
      const state = await store.readState();
      expect(state.active).toBeUndefined();
      expect(state.lastCheck).toBe(7);
      world.dispose();
    });

    it('does not throw when the stored install is not an install', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      await putRawState(world.factory, store.id, { active: { checksum: 1 }, pending: 'x', rejectedChecksums: 'no' });
      const state = await store.readState();
      expect(state.active).toBeUndefined();
      expect(state.pending).toBeUndefined();
      expect(state.rejectedChecksums).toBeUndefined();
      world.dispose();
    });
  });

  describe('fields written by a newer tab', () => {
    it('keeps an unknown state field through updateState, dropping only what the change removed', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      await putRawState(world.factory, store.id, { futureField: 'x', lastCheck: 1, languageOverride: 'fr' });

      await store.updateState(({ languageOverride: _removed, ...rest }) => ({ ...rest, backoffStep: 2 }));

      expect(await readRawState(world.factory, store.id)).toEqual({ futureField: 'x', lastCheck: 1, backoffStep: 2 });
      world.dispose();
    });

    it('keeps an unknown state field through writeInstall, and an active write still clears pending', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      const one = slice('one');
      await store.putSlice(one.hash, one.bytes);
      const pending = makeInstall({ 'ui\nen': one.hash }, { checksum: 'b'.repeat(64) });
      await putRawState(world.factory, store.id, { futureField: { nested: [1] }, pending });

      expect(await store.writeInstall(makeInstall({ 'ui\nen': one.hash }), 'active')).toBe(true);

      const raw = (await readRawState(world.factory, store.id)) as Record<string, unknown>;
      expect(raw.futureField).toEqual({ nested: [1] });
      expect(raw.pending).toBeUndefined();
      expect(raw.active).toBeDefined();
      world.dispose();
    });
  });

  describe('quota', () => {
    it('answers quota and becomes degraded when the browser refuses a write', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      const before = slice('before');
      expect(await store.putSlice(before.hash, before.bytes)).toBe('stored');
      expect(store.degraded).toBe(false);

      // A real browser reports quota on the request or the transaction; throwing from the call is the
      // simplest way to make a write fail with that error name.
      const realPut = IDBObjectStore.prototype.put;
      const realAdd = IDBObjectStore.prototype.add;
      const guard = (real: typeof realPut) =>
        function (this: IDBObjectStore, ...args: Parameters<typeof realPut>) {
          if (this.name === 'slices') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          return real.apply(this, args);
        };
      IDBObjectStore.prototype.put = guard(realPut);
      IDBObjectStore.prototype.add = guard(realAdd);
      try {
        const refused = slice('refused');
        expect(await store.putSlice(refused.hash, refused.bytes)).toBe('quota');
        expect(store.degraded).toBe(true);
      } finally {
        IDBObjectStore.prototype.put = realPut;
        IDBObjectStore.prototype.add = realAdd;
      }
      world.dispose();
    });
  });

  describe('an IndexedDB failure that is not quota', () => {
    it('makes no method throw, answers "nothing written" and marks the store degraded', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      const one = slice('one');
      const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
        throw new DOMException('The database connection is closing.', 'InvalidStateError');
      });
      try {
        expect(await store.readState()).toEqual({});
        expect(store.degraded).toBe(true);
        expect(await store.putSlice(one.hash, one.bytes)).toBe('unavailable');
        expect((await store.readSlices([one.hash])).size).toBe(0);
        expect(await store.writeInstall(makeInstall({ 'ui\nen': one.hash }), 'active')).toBe(false);
        expect(await store.updateState((state) => ({ ...state, lastCheck: 5 }))).toEqual({ lastCheck: 5 });
        await expect(store.cleanup()).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
        world.dispose();
      }
    });

    it('still throws what the change function throws', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      await expect(
        store.updateState(() => {
          throw new Error('bad change');
        }),
      ).rejects.toThrow('bad change');
      expect(store.degraded).toBe(false);
      world.dispose();
    });
  });

  describe('locks', () => {
    it('asks the lock manager for tarjim:<id> and only if it is available', async () => {
      const world = createIdbWorld();
      const store = await world.open('a');
      await store.withLock(async () => undefined);
      expect(world.locks.requests).toEqual([{ name: `tarjim:${store.id}`, options: { ifAvailable: true } }]);
      world.dispose();
    });

    it('answers busy when another instance of the same store holds the lock', async () => {
      const world = createIdbWorld();
      const tabOne = await world.open('a');
      const tabTwo = await world.open('a');
      let entered = false;
      let release!: () => void;
      const holding = tabOne.withLock(async () => {
        entered = true;
        await new Promise<void>((resolve) => (release = resolve));
      });
      await until(() => entered, 'the first tab to take the lock');
      let ran = false;
      expect(
        await tabTwo.withLock(async () => {
          ran = true;
        }),
      ).toBe(BUSY);
      expect(ran).toBe(false);
      release();
      await holding;
      expect(await tabTwo.withLock(async () => 'ran')).toBe('ran');
      world.dispose();
    });
  });

  describe('what is stored', () => {
    it('never keeps the api key, only the hashed id', async () => {
      const factory = new IDBFactory();
      const world = createIdbWorld(factory);
      const store = await world.open('a');
      const one = slice('one');
      await store.putSlice(one.hash, one.bytes);
      await store.writeInstall(makeInstall({ 'ui\nen': one.hash }), 'active');
      await store.writeInstall(makeInstall({ 'ui\nen': one.hash }, { checksum: 'b'.repeat(64) }), 'pending');
      await store.updateState((state) => ({ ...state, installId: 'install-1', languageOverride: 'fr', lastCheck: 4 }));
      await store.cleanup();

      const everything = flatten(await dumpRaw(factory));
      expect(everything).not.toContain(world.keyOf('a'));
      expect(everything).not.toContain('testkey');
      expect(everything).toContain(store.id);
      expect(store.id).toBe(await storeId(DELIVERY_URL, world.keyOf('a')));
      expect(DELIVERY_URL).toContain('example.invalid');
      expect(API_KEY).toContain('testkey');
      world.dispose();
    });
  });
});
