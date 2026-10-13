import { afterEach, describe, expect, it } from 'vitest';
import { queryOf } from '../support.js';
import { makeWorld } from './world.js';
import type { World } from './world.js';

let world = makeWorld();
afterEach(() => world.stopAll());

async function again(runtime: { checkNow(): Promise<unknown> }, w: World = world): Promise<void> {
  w.clock.set(w.clock.now() + 61_000);
  await runtime.checkNow();
}

const metaIds = (w: World = world) => w.server.requests('meta').map((request) => queryOf(request.url)['installId']);

describe('the install id', () => {
  it('is created with the first check, stored, and sent on the checks that follow', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const stored = (await world.state()).installId;
    expect(stored).toEqual(expect.any(String));
    expect(stored).not.toBe('');

    await again(runtime);
    await again(runtime);
    const ids = metaIds();
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids.slice(1)).toEqual(ids.slice(1).map(() => stored));
    expect((await world.state()).installId).toBe(stored);
  });

  it('is sent on meta only, never with a manifest or slice request', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.release({ content: { b1: 'v2' }, releaseId: 2 });
    await again(runtime);
    await again(runtime);

    const others = world.server.log.filter((request) => request.kind !== 'meta');
    expect(others.length).toBeGreaterThan(2);
    for (const request of others) expect(request.url).not.toContain('installId');
    expect(world.server.requests('meta').some((request) => request.url.includes('installId='))).toBe(true);
  });

  it('is the same in the next page load', async () => {
    world = makeWorld();
    const first = await world.startActive();
    await again(first);
    const stored = (await world.state()).installId;
    first.stop();

    const second = await world.start();
    await again(second);
    expect((await world.state()).installId).toBe(stored);
    expect(metaIds().slice(-1)[0]).toBe(stored);
  });

  it('is never created or sent when analytics are off', async () => {
    world = makeWorld();
    const runtime = await world.startActive({ analytics: { installId: false } });
    await again(runtime);
    await again(runtime);

    expect((await world.state()).installId).toBeUndefined();
    expect(metaIds().every((id) => id === undefined)).toBe(true);
    expect(world.server.requests('meta').length).toBeGreaterThanOrEqual(3);
  });

  it('is never sent from a store that does not outlive the page', async () => {
    world = makeWorld({ memoryOnly: true });
    const runtime = await world.startActive();
    await again(runtime);
    await again(runtime);

    expect((await world.state()).installId).toBeUndefined();
    expect(metaIds().every((id) => id === undefined)).toBe(true);
  });

  it('is deleted by setInstallId(false) and stays gone', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    await again(runtime);
    expect((await world.state()).installId).toBeDefined();

    await runtime.setInstallId(false);
    expect((await world.state()).installId).toBeUndefined();

    await again(runtime);
    await again(runtime);
    expect((await world.state()).installId).toBeUndefined();
    expect(metaIds().slice(-2)).toEqual([undefined, undefined]);
  });

  it('is created again by setInstallId(true) with the next check, as a new id', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    await again(runtime);
    const old = (await world.state()).installId;
    await runtime.setInstallId(false);
    await again(runtime);

    await runtime.setInstallId(true);
    await again(runtime);
    await again(runtime);

    const fresh = (await world.state()).installId;
    expect(fresh).toEqual(expect.any(String));
    expect(fresh).not.toBe(old);
    expect(metaIds().slice(-1)[0]).toBe(fresh);
  });

  it('can be switched on at runtime by a page that started with analytics off', async () => {
    world = makeWorld();
    const runtime = await world.startActive({ analytics: { installId: false } });
    await runtime.setInstallId(true);
    await again(runtime);
    await again(runtime);
    expect((await world.state()).installId).toEqual(expect.any(String));
  });

  it('does nothing, and asks nothing, when the store is degraded', async () => {
    world = makeWorld({ degraded: true });
    const runtime = await world.start();
    await runtime.setInstallId(true);
    await runtime.checkNow();
    expect(world.server.log).toEqual([]);
  });
});
