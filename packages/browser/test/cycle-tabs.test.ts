import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCycle } from '@tarjim/core/internal';
import type { Store } from '@tarjim/core';
import { hashOf, makeContext, makeRelease, makeWorld } from '../../core/test/helpers/cycle-world.js';
import { createIdbWorld } from './helpers/idb-world.js';

// A fresh database per test: every test opens the same store name.
let world = createIdbWorld();
beforeEach(() => {
  world = createIdbWorld();
});
afterEach(() => world.dispose());

/** Two tabs: separate store instances over one IndexedDB, one lock manager, one clock and one server. */
async function twoTabs(options: { locale?: string } = {}) {
  const a = await world.open('shared');
  const b = await world.open('shared');
  const w = makeWorld({ store: a, ...options });
  const tabA = w.ctx;
  const tabB = makeContext(w.server, b, w.clock, w.selection);
  return { w, a, b, tabA, tabB };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

function watchCleanup(store: Store) {
  const calls: { insideLock: boolean }[] = [];
  const original = store.cleanup.bind(store);
  vi.spyOn(store, 'cleanup').mockImplementation(async () => {
    calls.push({ insideLock: (await store.withLock(async () => true)) !== true });
    await original();
  });
  return calls;
}

describe('two tabs sharing one store', () => {
  it('send one meta request and one download when both are due at once', async () => {
    const { w, tabA, tabB } = await twoTabs();
    const gate = w.server.hold('meta');

    const first = runCycle(tabA, 'scheduled');
    const second = runCycle(tabB, 'scheduled');
    for (const started of [first, second]) started.catch(() => undefined);
    await wait();
    gate.release();
    const outcomes = [(await first).outcome, (await second).outcome].sort();

    expect(outcomes).toEqual(['activated', 'busy']);
    expect(w.server.count('meta')).toBe(1);
    expect(w.server.count('manifest')).toBe(1);
    expect(w.server.objectCount(hashOf(w.server.current, 'b1', 'en'))).toBe(1);
  });

  it('see the install the other tab wrote and stay quiet until the interval passes', async () => {
    const { w, b, tabA, tabB } = await twoTabs();
    expect((await runCycle(tabA, 'scheduled')).outcome).toBe('activated');
    const metas = w.server.count('meta');

    expect((await b.readState()).active?.checksum).toBe(w.server.current.meta.checksum);
    w.clock.advance(300);
    expect((await runCycle(tabB, 'scheduled')).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);

    w.clock.advance(601);
    expect((await runCycle(tabB, 'scheduled')).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(metas + 1);
    w.clock.advance(1);
    expect((await runCycle(tabA, 'scheduled')).outcome).toBe('notDue');
  });

  it('stay quiet in a tab opened later', async () => {
    const { w, tabA } = await twoTabs();
    await runCycle(tabA, 'scheduled');
    const later = makeContext(w.server, await world.open('shared'), w.clock, w.selection);
    const metas = w.server.count('meta');
    w.clock.advance(100);

    expect((await runCycle(later, 'scheduled')).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);
  });

  it('share the 60 second floor on manual checks', async () => {
    const { w, tabA, tabB } = await twoTabs();
    await runCycle(tabA, 'scheduled');
    w.clock.advance(10);
    expect((await runCycle(tabA, 'checkNow')).outcome).toBe('noChange');
    const metas = w.server.count('meta');

    w.clock.advance(30);
    expect((await runCycle(tabB, 'checkNow')).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);

    w.clock.advance(31);
    expect((await runCycle(tabB, 'checkNow')).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(metas + 1);
  });

  it('share a backoff that no manual check can shorten', async () => {
    const { w, tabA, tabB } = await twoTabs();
    await runCycle(tabA, 'scheduled');
    w.clock.advance(1000);
    w.server.on('meta', () => new Response('busy', { status: 503, headers: { 'Retry-After': '600' } }), { times: 1 });
    expect((await runCycle(tabA, 'scheduled')).outcome).toBe('failed');
    const metas = w.server.count('meta');

    w.clock.advance(120);
    expect((await runCycle(tabB, 'checkNow')).outcome).toBe('notDue');
    expect((await runCycle(tabB, 'scheduled')).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);

    w.clock.advance(481);
    expect((await runCycle(tabB, 'checkNow')).outcome).toBe('noChange');
  });

  it('never clean up while the other tab holds the lock, and clean up inside it otherwise', async () => {
    const { w, a, b, tabA, tabB } = await twoTabs();
    const callsA = watchCleanup(a);
    const callsB = watchCleanup(b);
    const gate = w.server.hold('meta');

    const first = runCycle(tabA, 'scheduled');
    first.catch(() => undefined);
    await wait();
    expect((await runCycle(tabB, 'scheduled')).outcome).toBe('busy');
    expect((await runCycle(tabB, 'checkNow')).outcome).toBe('busy');
    expect(callsB).toHaveLength(0);
    expect(callsA).toHaveLength(0);

    gate.release();
    expect((await first).outcome).toBe('activated');
    expect(callsA).toEqual([{ insideLock: true }]);
    expect(callsB).toHaveLength(0);
  });

  it('keep a slice the other tab still needs when one of them installs a newer release', async () => {
    const { w, a, b, tabA, tabB } = await twoTabs();
    const v1 = w.server.current;
    await runCycle(tabA, 'scheduled');
    const v2 = makeRelease({ content: { b1: 'v2' }, releaseId: 2 });
    w.server.use(v2);
    w.clock.advance(1000);

    expect((await runCycle(tabB, 'scheduled')).outcome).toBe('downloaded');
    expect((await a.readSlices([hashOf(v1, 'b1', 'en')])).size).toBe(1);
    expect((await a.readSlices([hashOf(v2, 'b1', 'en')])).size).toBe(1);
    expect((await b.readState()).pending?.checksum).toBe(v2.meta.checksum);
  });
});
