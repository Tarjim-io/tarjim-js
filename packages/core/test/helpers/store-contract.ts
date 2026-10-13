import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BUSY } from '../../src/index.js';
import type { Install, Store } from '../../src/index.js';

export const DELIVERY_URL = 'https://delivery.example.invalid/t/1/projects/1/delivery/meta';
export const API_KEY = 'tarjim-0-0-0-testkey';

export function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function slice(text: string): { hash: string; bytes: Uint8Array } {
  const bytes = bytesOf(text);
  return { hash: hashOf(bytes), bytes };
}

export function makeInstall(slots: Record<string, string>, overrides: Partial<Install> = {}): Install {
  return {
    checksum: 'c'.repeat(64),
    releaseId: 7,
    manifest: { schemaVersion: 1, bundles: {}, slices: {} },
    slots,
    owed: [],
    manifestUrl: 'https://delivery.example.invalid/manifest.json',
    slicesBaseUrl: 'https://delivery.example.invalid/slices/',
    authenticated: false,
    sdkVersion: '0.1.0',
    installedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 1000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export interface StoreWorld {
  /** The same name always reaches the same data; IndexedDB hands back a new instance each call (a second tab). */
  open(name: string): Promise<Store>;
  /** Replaces the stored bytes under a hash without going through the store, as damage on disk would. */
  tamper(name: string, hash: string, bytes: Uint8Array): Promise<void>;
  dispose?(): void;
}

export function storeContract(name: string, makeWorld: () => StoreWorld | Promise<StoreWorld>): void {
  describe(`${name} store contract`, () => {
    let world: StoreWorld;
    const make = async (): Promise<StoreWorld> => (world = await makeWorld());
    afterEach(() => world?.dispose?.());

    describe('slices', () => {
      it('stores a slice and reads it back', async () => {
        const store = await (await make()).open('a');
        const one = slice('one');
        expect(await store.putSlice(one.hash, one.bytes)).toBe('stored');
        const read = await store.readSlices([one.hash]);
        expect([...read.keys()]).toEqual([one.hash]);
        expect(Array.from(read.get(one.hash)!)).toEqual(Array.from(one.bytes));
      });

      it('never overwrites a slice it already holds', async () => {
        const store = await (await make()).open('a');
        const first = slice('first');
        expect(await store.putSlice(first.hash, first.bytes)).toBe('stored');
        expect(await store.putSlice(first.hash, bytesOf('something else'))).toBe('held');
        const read = await store.readSlices([first.hash]);
        expect(Array.from(read.get(first.hash)!)).toEqual(Array.from(first.bytes));
      });

      it('writes good bytes over a held record that no longer hashes to its key', async () => {
        const w = await make();
        const store = await w.open('a');
        const one = slice('one');
        await store.putSlice(one.hash, one.bytes);
        await w.tamper('a', one.hash, bytesOf('damaged'));
        expect((await store.readSlices([one.hash])).size).toBe(0);

        expect(await store.putSlice(one.hash, one.bytes)).toBe('stored');
        const read = await store.readSlices([one.hash]);
        expect(Array.from(read.get(one.hash)!)).toEqual(Array.from(one.bytes));
        expect(await store.putSlice(one.hash, one.bytes)).toBe('held');
      });

      it('leaves a hash that was never stored out of the result', async () => {
        const store = await (await make()).open('a');
        const held = slice('held');
        await store.putSlice(held.hash, held.bytes);
        const read = await store.readSlices([held.hash, slice('never stored').hash]);
        expect([...read.keys()]).toEqual([held.hash]);
        expect((await store.readSlices([])).size).toBe(0);
      });

      it('leaves bytes that do not match their hash out of the result', async () => {
        const store = await (await make()).open('a');
        const wrong = slice('what the hash names');
        await store.putSlice(wrong.hash, bytesOf('different bytes'));
        const good = slice('good');
        await store.putSlice(good.hash, good.bytes);
        const read = await store.readSlices([wrong.hash, good.hash]);
        expect([...read.keys()]).toEqual([good.hash]);
      });
    });

    describe('installs', () => {
      it('writes an install when every hash it names is held', async () => {
        const store = await (await make()).open('a');
        const one = slice('one');
        await store.putSlice(one.hash, one.bytes);
        const install = makeInstall({ 'ui\nen': one.hash });
        expect(await store.writeInstall(install, 'active')).toBe(true);
        expect((await store.readState()).active).toEqual(install);
      });

      it('writes nothing when one hash it names is missing', async () => {
        const store = await (await make()).open('a');
        const one = slice('one');
        const missing = slice('missing');
        await store.putSlice(one.hash, one.bytes);
        const old = makeInstall({ 'ui\nen': one.hash }, { checksum: 'a'.repeat(64) });
        expect(await store.writeInstall(old, 'active')).toBe(true);

        const next = makeInstall({ 'ui\nen': one.hash, 'ui\nfr': missing.hash }, { checksum: 'b'.repeat(64) });
        expect(await store.writeInstall(next, 'active')).toBe(false);
        expect(await store.writeInstall(next, 'pending')).toBe(false);
        const state = await store.readState();
        expect(state.active).toEqual(old);
        expect(state.pending).toBeUndefined();
      });

      it('writes a pending install beside the active one, and an active write clears pending', async () => {
        const store = await (await make()).open('a');
        const one = slice('one');
        await store.putSlice(one.hash, one.bytes);
        const active = makeInstall({ 'ui\nen': one.hash }, { checksum: 'a'.repeat(64) });
        const pending = makeInstall({ 'ui\nen': one.hash }, { checksum: 'b'.repeat(64) });
        await store.writeInstall(active, 'active');
        expect(await store.writeInstall(pending, 'pending')).toBe(true);
        let state = await store.readState();
        expect(state.active).toEqual(active);
        expect(state.pending).toEqual(pending);

        const promoted = makeInstall({ 'ui\nen': one.hash }, { checksum: 'c'.repeat(64) });
        expect(await store.writeInstall(promoted, 'active')).toBe(true);
        state = await store.readState();
        expect(state.active).toEqual(promoted);
        expect(state.pending).toBeUndefined();
      });

      it('keeps the active install when a download stops part way, across a reopen', async () => {
        const w = await make();
        const first = await w.open('a');
        const kept = slice('kept');
        const orphanOne = slice('orphan one');
        const orphanTwo = slice('orphan two');
        const previous = makeInstall({ 'ui\nen': kept.hash });
        await first.putSlice(kept.hash, kept.bytes);
        await first.writeInstall(previous, 'active');
        await first.putSlice(orphanOne.hash, orphanOne.bytes);
        await first.putSlice(orphanTwo.hash, orphanTwo.bytes);
        first.close();

        const second = await w.open('a');
        expect((await second.readState()).active).toEqual(previous);
        await second.cleanup();
        const read = await second.readSlices([kept.hash, orphanOne.hash, orphanTwo.hash]);
        expect([...read.keys()]).toEqual([kept.hash]);

        const next = makeInstall({ 'ui\nen': kept.hash, 'ui\nfr': orphanOne.hash }, { checksum: 'b'.repeat(64) });
        expect(await second.writeInstall(next, 'active')).toBe(false);
        expect(await second.putSlice(orphanOne.hash, orphanOne.bytes)).toBe('stored');
        expect(await second.writeInstall(next, 'active')).toBe(true);
      });

      it('hands out frozen installs that no later write changes', async () => {
        const store = await (await make()).open('a');
        const one = slice('one');
        await store.putSlice(one.hash, one.bytes);
        const written = makeInstall({ 'ui\nen': one.hash }, { owed: ['ui\nfr'] });
        await store.writeInstall(written, 'active');

        const earlier = (await store.readState()).active!;
        expect(Object.isFrozen(earlier)).toBe(true);
        expect(Object.isFrozen(earlier.slots)).toBe(true);
        expect(Object.isFrozen(earlier.owed)).toBe(true);
        expect(Object.isFrozen(earlier.manifest)).toBe(true);
        expect(() => {
          (earlier as { checksum: string }).checksum = 'edited';
        }).toThrow(TypeError);
        expect(() => {
          earlier.slots['ui\nfr'] = 'edited';
        }).toThrow(TypeError);

        // The object handed to writeInstall is not the stored one.
        try {
          written.checksum = 'edited after write';
        } catch {
          // a frozen input refuses the edit, which is just as good
        }
        expect((await store.readState()).active!.checksum).toBe('c'.repeat(64));

        const replacement = makeInstall({ 'ui\nen': one.hash }, { checksum: 'd'.repeat(64) });
        await store.writeInstall(replacement, 'active');
        const later = (await store.readState()).active!;
        expect(later).not.toBe(earlier);
        expect(later.checksum).toBe('d'.repeat(64));
        expect(earlier.checksum).toBe('c'.repeat(64));
      });
    });

    describe('state', () => {
      it('reads an empty state on a fresh store', async () => {
        const store = await (await make()).open('a');
        expect(await store.readState()).toEqual({});
      });

      it('changes state with a read-modify-write that returns the result', async () => {
        const store = await (await make()).open('a');
        const result = await store.updateState((state) => ({ ...state, lastCheck: 5, languageOverride: 'fr' }));
        expect(result).toEqual({ lastCheck: 5, languageOverride: 'fr' });
        expect(await store.readState()).toEqual({ lastCheck: 5, languageOverride: 'fr' });
        const next = await store.updateState((state) => ({ ...state, lastCheck: (state.lastCheck ?? 0) + 1 }));
        expect(next).toEqual({ lastCheck: 6, languageOverride: 'fr' });
      });

      it('keeps both changes when two writers update different fields at once', async () => {
        const w = await make();
        const one = await w.open('a');
        const two = await w.open('a');
        await Promise.all([
          one.updateState((state) => ({ ...state, lastCheck: 1 })),
          two.updateState((state) => ({ ...state, backoffStep: 2 })),
        ]);
        expect(await one.readState()).toEqual({ lastCheck: 1, backoffStep: 2 });
        expect(await two.readState()).toEqual({ lastCheck: 1, backoffStep: 2 });
      });

      it('loses no increment when ten updates race across two instances', async () => {
        const w = await make();
        const one = await w.open('a');
        const two = await w.open('a');
        const bump = (state: { backoffStep?: number }) => ({ ...state, backoffStep: (state.backoffStep ?? 0) + 1 });
        await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? one : two).updateState(bump)));
        expect((await one.readState()).backoffStep).toBe(10);
      });
    });

    describe('sibling stores', () => {
      it('hides one store\'s slices and state from another', async () => {
        const w = await make();
        const a = await w.open('a');
        const b = await w.open('b');
        const shared = slice('same bytes in both');
        const onlyA = slice('only in a');
        await a.putSlice(shared.hash, shared.bytes);
        await a.putSlice(onlyA.hash, onlyA.bytes);
        await b.putSlice(shared.hash, shared.bytes);
        await a.writeInstall(makeInstall({ 'ui\nen': shared.hash }), 'active');
        await a.updateState((state) => ({ ...state, languageOverride: 'fr' }));

        const stateOfB = await b.readState();
        expect(stateOfB.active).toBeUndefined();
        expect(stateOfB.languageOverride).toBeUndefined();
        expect([...(await b.readSlices([shared.hash, onlyA.hash])).keys()]).toEqual([shared.hash]);
        expect([...(await a.readSlices([shared.hash, onlyA.hash])).keys()].sort()).toEqual([shared.hash, onlyA.hash].sort());
      });

      it('refuses an install in one store that names a hash only a sibling holds', async () => {
        const w = await make();
        const a = await w.open('a');
        const b = await w.open('b');
        const held = slice('held by a');
        await a.putSlice(held.hash, held.bytes);
        expect(await b.writeInstall(makeInstall({ 'ui\nen': held.hash }), 'active')).toBe(false);
        expect(await a.writeInstall(makeInstall({ 'ui\nen': held.hash }), 'active')).toBe(true);
      });
    });

    describe('cleanup', () => {
      it('keeps every slice the active and pending installs name and removes the rest', async () => {
        const store = await (await make()).open('a');
        const inActive = slice('in active');
        const inPending = slice('in pending');
        const unreferenced = slice('unreferenced');
        for (const s of [inActive, inPending, unreferenced]) await store.putSlice(s.hash, s.bytes);
        await store.writeInstall(makeInstall({ 'ui\nen': inActive.hash }), 'active');
        await store.writeInstall(makeInstall({ 'ui\nen': inPending.hash }, { checksum: 'b'.repeat(64) }), 'pending');

        await store.cleanup();
        const read = await store.readSlices([inActive.hash, inPending.hash, unreferenced.hash]);
        expect([...read.keys()].sort()).toEqual([inActive.hash, inPending.hash].sort());
        const state = await store.readState();
        expect(state.active).toBeDefined();
        expect(state.pending).toBeDefined();
      });

      it('never touches a sibling store\'s slices or state', async () => {
        const w = await make();
        const a = await w.open('a');
        const b = await w.open('b');
        const bytesBoth = slice('held by both');
        const bOnly = slice('b only');
        const aActive = slice('a active');
        for (const s of [bytesBoth, aActive]) await a.putSlice(s.hash, s.bytes);
        for (const s of [bytesBoth, bOnly]) await b.putSlice(s.hash, s.bytes);
        const installB = makeInstall({ 'ui\nen': bOnly.hash }, { checksum: 'b'.repeat(64) });
        await b.writeInstall(installB, 'active');
        await b.updateState((state) => ({ ...state, lastCheck: 9 }));
        await a.writeInstall(makeInstall({ 'ui\nen': aActive.hash }), 'active');

        await a.cleanup();

        expect([...(await a.readSlices([bytesBoth.hash, aActive.hash])).keys()]).toEqual([aActive.hash]);
        expect([...(await b.readSlices([bytesBoth.hash, bOnly.hash])).keys()].sort()).toEqual(
          [bytesBoth.hash, bOnly.hash].sort(),
        );
        const state = await b.readState();
        expect(state.active).toEqual(installB);
        expect(state.lastCheck).toBe(9);
      });
    });

    describe('lock', () => {
      it('runs the function and returns its result when nothing holds the lock', async () => {
        const store = await (await make()).open('a');
        expect(await store.withLock(async () => 'ran')).toBe('ran');
      });

      it('answers busy at once, without running the function, while another run holds the lock', async () => {
        const store = await (await make()).open('a');
        let entered = false;
        let release!: () => void;
        const first = store.withLock(async () => {
          entered = true;
          await new Promise<void>((resolve) => (release = resolve));
          return 'first';
        });
        await until(() => entered, 'the first run to start');

        let secondRan = false;
        const second = await store.withLock(async () => {
          secondRan = true;
          return 'second';
        });
        expect(second).toBe(BUSY);
        expect(secondRan).toBe(false);

        release();
        expect(await first).toBe('first');
        expect(await store.withLock(async () => 'third')).toBe('third');
      });

      it('does not make a store with another id wait', async () => {
        const w = await make();
        const a = await w.open('a');
        const b = await w.open('b');
        let entered = false;
        let release!: () => void;
        const holding = a.withLock(async () => {
          entered = true;
          await new Promise<void>((resolve) => (release = resolve));
        });
        await until(() => entered, 'the holder to start');
        expect(await b.withLock(async () => 'ran')).toBe('ran');
        release();
        await holding;
      });

      it('frees the lock when the function throws, and passes the error on', async () => {
        const store = await (await make()).open('a');
        await expect(
          store.withLock(async () => {
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await store.withLock(async () => 'after')).toBe('after');
      });
    });
  });
}
