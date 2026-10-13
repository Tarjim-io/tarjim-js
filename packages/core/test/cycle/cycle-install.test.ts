import { describe, expect, it, vi } from 'vitest';
import { BUSY, slotName } from '../../src/index.js';
import { hashOf, installed, makeRelease, makeWorld } from '../helpers/cycle-world.js';
import type { World } from '../helpers/cycle-world.js';
import { ROTATED_SIGNED_QUERY, respond } from '../support.js';

/** Records whether each cleanup ran while the store lock was held. */
function watchCleanup(w: World) {
  const calls: { insideLock: boolean }[] = [];
  const original = w.store.cleanup.bind(w.store);
  vi.spyOn(w.store, 'cleanup').mockImplementation(async () => {
    calls.push({ insideLock: (await w.store.withLock(async () => true)) === BUSY });
    await original();
  });
  return calls;
}

const two = (tag: string) => ({ b1: tag, b2: tag });

describe('a release that changed', () => {
  it('waits as the pending install once something is active', async () => {
    const w = await installed({ release: makeRelease({ releaseId: 1 }) });
    const active = (await w.state()).active!;
    const next = makeRelease({ content: { b1: 'v2' }, releaseId: 2 });
    w.server.use(next);

    const result = await w.run();
    expect(result.outcome).toBe('downloaded');
    const state = await w.state();
    expect(state.pending?.checksum).toBe(next.meta.checksum);
    expect(state.pending?.slots[slotName('b1', 'en')]).toBe(hashOf(next, 'b1', 'en'));
    expect(state.active).toEqual(active);
    expect(result.install).toEqual(state.pending);
    expect(await w.holds(hashOf(next, 'b1', 'en'))).toBe(true);
  });

  it('replaces an older pending install with the newest one', async () => {
    const w = await installed();
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    await w.run();
    w.clock.advance(1000);
    const third = makeRelease({ content: { b1: 'v3' }, releaseId: 3 });
    w.server.use(third);

    expect((await w.run()).outcome).toBe('downloaded');
    expect((await w.state()).pending?.checksum).toBe(third.meta.checksum);
  });

  it('installs an older release too, since only a different checksum matters', async () => {
    const newer = makeRelease({ content: { b1: 'v2' }, releaseId: 5 });
    const older = makeRelease({ content: { b1: 'v1' }, releaseId: 3 });
    const w = await installed({ release: newer });
    w.server.use(older);

    const result = await w.run();
    expect(result.outcome).toBe('downloaded');
    const state = await w.state();
    expect(state.pending?.checksum).toBe(older.meta.checksum);
    expect(state.pending?.releaseId).toBe(3);
    expect(state.active?.releaseId).toBe(5);
  });

  it('downloads nothing when the checksum is the one already active', async () => {
    const w = await installed();
    const manifests = w.server.count('manifest');
    const objects = w.server.count('object');

    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('manifest')).toBe(manifests);
    expect(w.server.count('object')).toBe(objects);
  });

  it('downloads nothing when the checksum is the one already pending', async () => {
    const w = await installed();
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    await w.run();
    const pending = (await w.state()).pending!;
    const manifests = w.server.count('manifest');
    const objects = w.server.count('object');
    w.clock.advance(1000);

    expect((await w.run()).outcome).toBe('noChange');
    expect((await w.state()).pending).toEqual(pending);
    expect(w.server.count('manifest')).toBe(manifests);
    expect(w.server.count('object')).toBe(objects);
  });
});

describe('a meta that returns to the active release', () => {
  it('discards the pending install and never activates it', async () => {
    const original = makeRelease({ releaseId: 1 });
    const w = await installed({ release: original });
    const active = (await w.state()).active!;
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    await w.run();
    expect((await w.state()).pending).toBeDefined();

    w.server.use(original);
    w.clock.advance(1000);
    const manifests = w.server.count('manifest');
    expect((await w.run()).outcome).toBe('noChange');

    const state = await w.state();
    expect(state.pending).toBeUndefined();
    expect(state.active).toEqual(active);
    expect(w.server.count('manifest')).toBe(manifests);
  });
});

describe('the bundles of a new release', () => {
  it('leaves out a bundle the new manifest no longer lists, and reuses what is held', async () => {
    const w = await installed({ release: makeRelease({ content: two('v1') }) });
    const before = makeRelease({ content: two('v1') });
    const next = makeRelease({ content: { b1: 'v1', b3: 'v1' }, releaseId: 2 });
    w.server.use(next);
    const objects = w.server.count('object');

    expect((await w.run()).outcome).toBe('downloaded');
    const pending = (await w.state()).pending!;
    expect(Object.keys(pending.slots).sort()).toEqual([slotName('b1', 'en'), slotName('b3', 'en')]);
    expect(pending.slots[slotName('b1', 'en')]).toBe(hashOf(before, 'b1', 'en'));
    expect(w.server.count('object')).toBe(objects + 1);
    expect(w.server.objectCount(hashOf(next, 'b3', 'en'))).toBe(1);
    expect(w.server.objectCount(hashOf(before, 'b1', 'en'))).toBe(1);
  });

  it('adopts a release whose selected-locale slots are all unchanged, without an event or a download', async () => {
    const w = await installed();
    const active = (await w.state()).active!;
    const calls = watchCleanup(w);
    const next = makeRelease({ locales: ['en', 'fr', 'de'], releaseId: 2 });
    w.server.use(next);
    const objects = w.server.count('object');

    const result = await w.run();
    expect(result.outcome).toBe('noChange');
    expect(result.install).toBeUndefined();
    const state = await w.state();
    expect(state.pending).toBeUndefined();
    expect(state.active?.checksum).toBe(next.meta.checksum);
    expect(state.active?.releaseId).toBe(2);
    expect(state.active?.slots).toEqual(active.slots);
    expect(w.server.count('object')).toBe(objects);
    expect(calls).toHaveLength(1);

    const manifests = w.server.count('manifest');
    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('manifest')).toBe(manifests);
  });

  it('adopts into the pending install when that is the newest one known', async () => {
    const w = await installed();
    const active = (await w.state()).active!;
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    await w.run();
    const pending = (await w.state()).pending!;
    w.clock.advance(1000);
    const next = makeRelease({ content: { b1: 'v2' }, locales: ['en', 'fr', 'de'], releaseId: 3 });
    w.server.use(next);

    expect((await w.run()).outcome).toBe('noChange');
    const state = await w.state();
    expect(state.active).toEqual(active);
    expect(state.pending?.checksum).toBe(next.meta.checksum);
    expect(state.pending?.slots).toEqual(pending.slots);
  });

  it('adopts a first release that has nothing for the selected locale', async () => {
    const w = makeWorld({ locale: 'de' });

    const result = await w.run();
    expect(result.outcome).toBe('noChange');
    expect(result.install).toBeUndefined();
    const state = await w.state();
    expect(state.active?.checksum).toBe(w.server.current.meta.checksum);
    expect(state.active?.slots).toEqual({});
    expect(state.active?.owed).toEqual([]);

    w.clock.advance(1000);
    await w.run();
    expect(w.server.count('manifest')).toBe(1);
  });

  it('installs a release that drops a bundle and leaves the rest identical', async () => {
    const w = await installed({ release: makeRelease({ content: two('v1') }) });
    const active = (await w.state()).active!;
    const next = makeRelease({ content: { b1: 'v1' }, releaseId: 2 });
    w.server.use(next);
    const objects = w.server.count('object');

    const result = await w.run();
    expect(result.outcome).toBe('downloaded');
    const state = await w.state();
    expect(state.pending?.checksum).toBe(next.meta.checksum);
    expect(Object.keys(state.pending?.slots ?? {})).toEqual([slotName('b1', 'en')]);
    expect(state.active).toEqual(active);
    expect(w.server.count('object')).toBe(objects);
  });

  it('installs a release that drops the selected locale', async () => {
    const w = await installed();
    const next = makeRelease({ locales: ['fr'], releaseId: 2 });
    w.server.use(next);

    expect((await w.run()).outcome).toBe('downloaded');
    const state = await w.state();
    expect(state.pending?.checksum).toBe(next.meta.checksum);
    expect(state.pending?.slots).toEqual({});
  });
});

describe('a manifest that cannot be used', () => {
  it('rejects a manifest that does not match its checksum, once', async () => {
    const w = makeWorld({ release: makeRelease({ tamper: { manifest: true } }) });
    const checksum = w.server.current.meta.checksum;

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'manifestIntegrity' });
    const state = await w.state();
    expect(state.rejectedChecksums).toContain(checksum);
    expect(state.active).toBeUndefined();
    expect(w.server.count('manifest')).toBe(1);

    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(2);
    expect(w.server.count('manifest')).toBe(1);

    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('activated');
  });

  it('rejects a manifest with a schema version it does not know, once', async () => {
    const w = makeWorld({ release: makeRelease({ manifestOverrides: { schemaVersion: 2 } }) });
    const checksum = w.server.current.meta.checksum;

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'manifestSchema', schemaVersion: 2 });
    const state = await w.state();
    expect(state.rejectedChecksums).toContain(checksum);
    expect(state.active).toBeUndefined();
    expect(w.server.count('object')).toBe(0);

    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('manifest')).toBe(1);

    w.server.use(makeRelease({ releaseId: 2, content: { b1: 'v2' } }));
    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('activated');
  });

  it('does not request the manifest for a meta with an unknown schema version, and keeps polling', async () => {
    const w = makeWorld({ release: makeRelease({ metaOverrides: { schemaVersion: 2 } }) });

    const result = await w.run();
    expect(result.outcome).toBe('noChange');
    expect(result.conditions).toContainEqual({ code: 'metaSchema', schemaVersion: 2 });
    expect(w.server.count('manifest')).toBe(0);
    const state = await w.state();
    expect(state.active).toBeUndefined();
    expect(state.lastCheck).toBe(w.clock.now());

    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(2);
    expect(w.server.count('manifest')).toBe(0);
  });

  it('keeps what is held when the meta has an unknown schema version', async () => {
    const w = await installed();
    const active = (await w.state()).active!;
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2, metaOverrides: { schemaVersion: 2 } }));

    expect((await w.run()).outcome).toBe('noChange');
    expect((await w.state()).active).toEqual(active);
  });
});

describe('a slice that does not verify', () => {
  it.each(['hash', 'size'] as const)('is never stored, and the slot is owed (%s)', async (kind) => {
    const bad = makeRelease({ content: two('v1'), tamper: { slices: { 'b1/en': kind } } });
    const w = makeWorld({ release: bad });

    const result = await w.run();
    expect(result.conditions).toContainEqual({ code: 'sliceIntegrity' });
    const state = await w.state();
    expect(state.active?.owed).toEqual([slotName('b1', 'en')]);
    expect(state.active?.slots[slotName('b2', 'en')]).toBe(hashOf(bad, 'b2', 'en'));
    expect(await w.holds(hashOf(bad, 'b1', 'en'))).toBe(false);
    expect(await w.holds(hashOf(bad, 'b2', 'en'))).toBe(true);
  });

  it('keeps the previous text of a slot whose new slice fails, and installs the rest', async () => {
    const v1 = makeRelease({ content: two('v1') });
    const w = await installed({ release: v1 });
    const active = (await w.state()).active!;
    const v2 = makeRelease({ content: two('v2'), releaseId: 2, tamper: { slices: { 'b1/en': 'hash' } } });
    w.server.use(v2);

    const result = await w.run();
    expect(result.conditions).toContainEqual({ code: 'sliceIntegrity' });
    const state = await w.state();
    expect(state.active).toEqual(active);
    expect(state.pending?.slots[slotName('b1', 'en')]).toBe(hashOf(v1, 'b1', 'en'));
    expect(state.pending?.slots[slotName('b2', 'en')]).toBe(hashOf(v2, 'b2', 'en'));
  });
});

describe('owed slots', () => {
  const spec = { content: two('v1') };

  async function withOwedSlot() {
    const bad = makeRelease({ ...spec, tamper: { slices: { 'b1/en': 'hash' } } });
    const w = makeWorld({ release: bad });
    await w.run();
    w.clock.advance(1000);
    expect((await w.state()).active?.owed).toEqual([slotName('b1', 'en')]);
    return { w, owed: hashOf(bad, 'b1', 'en'), other: hashOf(bad, 'b2', 'en') };
  }

  it('are retried alone, with the signature of the new meta, and fill the install', async () => {
    const { w, owed, other } = await withOwedSlot();
    const good = makeRelease(spec);
    good.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    w.server.use(good);
    const manifests = w.server.count('manifest');
    const otherRequests = w.server.objectCount(other);

    const result = await w.run();
    expect(['activated', 'downloaded']).toContain(result.outcome);
    expect(result.install?.owed).toEqual([]);
    expect(w.server.objectCount(owed)).toBe(2);
    expect(w.server.objectCount(other)).toBe(otherRequests);
    expect(w.server.requests('object').slice(-1)[0]?.url).toContain(ROTATED_SIGNED_QUERY);
    expect(w.server.count('manifest')).toBe(manifests);
    const state = await w.state();
    expect(state.active?.owed).toEqual([]);
    expect(state.active?.slots[slotName('b1', 'en')]).toBe(owed);
    expect(state.active?.installedAt).toBe(w.clock.now());
  });

  it.each([
    ['still comes back damaged', () => undefined],
    ['fails to download', () => respond(500, 'oops', { headers: { 'Content-Type': 'text/plain' } })],
  ])('write no install and give no result when the retry %s', async (_label, answer) => {
    const { w, owed } = await withOwedSlot();
    const before = (await w.state()).active!;
    w.server.on('object', answer, { name: owed });

    const result = await w.run();
    expect(result.outcome).toBe('noChange');
    expect(result.install).toBeUndefined();
    const state = await w.state();
    expect(state.active).toEqual(before);
    expect(state.pending).toBeUndefined();
    expect(w.server.objectCount(owed)).toBe(2);

    w.server.clearRules();
    w.server.use(makeRelease(spec));
    w.clock.advance(1000);
    const retried = await w.run();
    expect(retried.install?.owed).toEqual([]);
  });
});

describe('cleanup', () => {
  it('runs once after an install is written, inside the lock', async () => {
    const w = makeWorld();
    const calls = watchCleanup(w);

    expect((await w.run()).outcome).toBe('activated');
    expect(calls).toEqual([{ insideLock: true }]);
  });

  it('does not run when nothing was installed', async () => {
    const w = await installed();
    const calls = watchCleanup(w);

    expect((await w.run()).outcome).toBe('noChange');
    w.server.on('meta', () => respond(500, 'oops', { headers: { 'Content-Type': 'text/plain' } }), { times: 1 });
    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('removes the slices of a replaced pending install and keeps those still referenced', async () => {
    const v1 = makeRelease();
    const w = await installed({ release: v1 });
    const v2 = makeRelease({ content: { b1: 'v2' }, releaseId: 2 });
    w.server.use(v2);
    await w.run();
    expect(await w.holds(hashOf(v2, 'b1', 'en'))).toBe(true);

    const v3 = makeRelease({ content: { b1: 'v3' }, releaseId: 3 });
    w.server.use(v3);
    w.clock.advance(1000);
    await w.run();

    expect(await w.holds(hashOf(v2, 'b1', 'en'))).toBe(false);
    expect(await w.holds(hashOf(v1, 'b1', 'en'))).toBe(true);
    expect(await w.holds(hashOf(v3, 'b1', 'en'))).toBe(true);
  });
});
