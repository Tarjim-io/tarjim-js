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

    const first = runCycle(tabA);
    const second = runCycle(tabB);
    for (const started of [first, second]) started.catch(() => undefined);
    await wait();
    gate.release();
    const outcomes = [(await first).outcome, (await second).outcome].sort();

    expect(outcomes).toEqual(['activated', 'busy']);
    expect(w.server.count('meta')).toBe(1);
    expect(w.server.count('manifest')).toBe(1);
    expect(w.server.objectCount(hashOf(w.server.current, 'b1', 'en'))).toBe(1);
  });

  it('see the install the other tab wrote and stay quiet until 60 seconds have passed', async () => {
    const { w, b, tabA, tabB } = await twoTabs();
    expect((await runCycle(tabA)).outcome).toBe('activated');
    const metas = w.server.count('meta');

    expect((await b.readState()).active?.checksum).toBe(w.server.current.meta.checksum);
    w.clock.advance(30);
    expect((await runCycle(tabB)).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);

    w.clock.advance(30);
    expect((await runCycle(tabB)).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(metas + 1);
    w.clock.advance(1);
    expect((await runCycle(tabA)).outcome).toBe('notDue');
  });

  it('stay quiet in a tab opened later', async () => {
    const { w, tabA } = await twoTabs();
    await runCycle(tabA);
    const later = makeContext(w.server, await world.open('shared'), w.clock, w.selection);
    const metas = w.server.count('meta');
    w.clock.advance(30);

    expect((await runCycle(later)).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);
  });

  it('share the one 60 second floor, whichever tab asks and however', async () => {
    const { w, tabA, tabB } = await twoTabs();
    await runCycle(tabA);
    const metas = w.server.count('meta');

    w.clock.advance(10);
    expect((await runCycle(tabA)).outcome).toBe('notDue');
    w.clock.advance(49);
    expect((await runCycle(tabB)).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);

    w.clock.advance(1);
    expect((await runCycle(tabB)).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(metas + 1);
  });

  it('share the wait after a failure, which no later check can shorten', async () => {
    const { w, tabA, tabB } = await twoTabs();
    await runCycle(tabA);
    w.clock.advance(1000);
    w.server.on('meta', () => new Response('busy', { status: 503, headers: { 'Retry-After': '600' } }), { times: 1 });
    expect((await runCycle(tabA)).outcome).toBe('failed');
    const metas = w.server.count('meta');

    w.clock.advance(120);
    expect((await runCycle(tabB)).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(metas);

    w.clock.advance(481);
    expect((await runCycle(tabB)).outcome).toBe('noChange');
  });

  it('never clean up while the other tab holds the lock, and clean up inside it otherwise', async () => {
    const { w, a, b, tabA, tabB } = await twoTabs();
    const callsA = watchCleanup(a);
    const callsB = watchCleanup(b);
    const gate = w.server.hold('meta');

    const first = runCycle(tabA);
    first.catch(() => undefined);
    await wait();
    expect((await runCycle(tabB)).outcome).toBe('busy');
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
    await runCycle(tabA);
    const v2 = makeRelease({ content: { b1: 'v2' }, releaseId: 2 });
    w.server.use(v2);
    w.clock.advance(1000);

    expect((await runCycle(tabB)).outcome).toBe('downloaded');
    expect((await a.readSlices([hashOf(v1, 'b1', 'en')])).size).toBe(1);
    expect((await a.readSlices([hashOf(v2, 'b1', 'en')])).size).toBe(1);
    expect((await b.readState()).pending?.checksum).toBe(v2.meta.checksum);
  });
});
