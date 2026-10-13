import { afterEach, describe, expect, it } from 'vitest';
import { problem, respond } from '../support.js';
import { makeWorld, settle, until, within } from './world.js';

let world = makeWorld();
afterEach(() => world.stopAll());

const V2 = { content: { b1: 'v2' }, releaseId: 2 };
const THREE = { release: { locales: ['en', 'fr', 'de'] } };

describe('events', () => {
  it('are listened to until the returned function is called', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const heard: string[] = [];
    const off = runtime.on('downloaded', (event) => heard.push(event.type));
    world.release(V2);
    await runtime.checkNow();
    off();
    world.release({ content: { b1: 'v3' }, releaseId: 3 });
    world.clock.advance(61);
    await runtime.checkNow();
    expect(heard).toEqual(['downloaded']);
  });

  it('do not fire when a check finds nothing new', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const heard: string[] = [];
    for (const type of ['downloaded', 'activated', 'languageChanged'] as const) runtime.on(type, () => heard.push(type));

    expect(await runtime.checkNow()).toBe('noChange');
    world.clock.advance(61);
    expect(await runtime.checkNow()).toBe('noChange');
    await settle();
    expect(heard).toEqual([]);
  });

  it('reach every listener, and one that throws does not stop the others', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const heard: string[] = [];
    runtime.on('downloaded', () => {
      throw new Error('listener');
    });
    runtime.on('downloaded', () => heard.push('second'));
    world.release(V2);
    await runtime.checkNow();
    expect(heard).toEqual(['second']);
  });

  it('can be read as an async sequence', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const updates = runtime.updates();
    const first = updates.next();
    world.release(V2);
    await runtime.checkNow();
    expect(await within(first)).toEqual({ done: false, value: { type: 'downloaded' } });

    const second = updates.next();
    runtime.activatePendingUpdate();
    expect(await within(second)).toEqual({ done: false, value: { type: 'activated' } });
  });

  it('do not fire for a release that changes no text', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const heard: string[] = [];
    runtime.on('downloaded', () => heard.push('downloaded'));
    world.release({ manifestOverrides: { note: 'same text' } });
    await runtime.checkNow();
    await settle();
    expect(heard).toEqual([]);
  });
});

describe('subscribe and getVersion', () => {
  it('start from a number and stay put while nothing changes', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const version = runtime.getVersion();
    const t = runtime.t;
    let calls = 0;
    runtime.subscribe(() => calls++);

    await runtime.checkNow();
    world.clock.advance(61);
    await runtime.checkNow();
    await settle();

    expect(typeof version).toBe('number');
    expect(runtime.getVersion()).toBe(version);
    expect(runtime.t).toBe(t);
    expect(calls).toBe(0);
  });

  it('change when the first release becomes the text, and t is a new function', async () => {
    world = makeWorld();
    const runtime = await world.start();
    const before = { version: runtime.getVersion(), t: runtime.t, tArray: runtime.tArray, entry: runtime.entry };
    let calls = 0;
    runtime.subscribe(() => calls++);

    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');

    expect(calls).toBe(1);
    expect(runtime.getVersion()).not.toBe(before.version);
    expect(runtime.t).not.toBe(before.t);
    expect(runtime.tArray).not.toBe(before.tArray);
    expect(runtime.entry).not.toBe(before.entry);
  });

  it('do not move for a download that waits, and move once when it is activated', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const version = runtime.getVersion();
    let calls = 0;
    runtime.subscribe(() => calls++);
    world.release(V2);

    await runtime.checkNow();
    expect(calls).toBe(0);
    expect(runtime.getVersion()).toBe(version);

    runtime.activatePendingUpdate();
    expect(calls).toBe(1);
    expect(runtime.getVersion()).not.toBe(version);
    expect(runtime.t('a')).toBe('v2 b1 en');
  });

  it('move when the language changes, once', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const version = runtime.getVersion();
    const t = runtime.t;
    let calls = 0;
    runtime.subscribe(() => calls++);

    await runtime.setLanguage('fr');

    expect(calls).toBe(1);
    expect(runtime.getVersion()).not.toBe(version);
    expect(runtime.t).not.toBe(t);
    expect(runtime.t('a')).toBe('v1 b1 fr');
  });

  it('do not move for a refused or failed language change', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const version = runtime.getVersion();
    let calls = 0;
    runtime.subscribe(() => calls++);
    await runtime.setLanguage('es').catch(() => undefined);
    world.server.on('object', () => problem(500, 'delivery.server_error'));
    await runtime.setLanguage('fr').catch(() => undefined);
    expect(calls).toBe(0);
    expect(runtime.getVersion()).toBe(version);
  });

  it('move when the key is unbound and the text falls back to the embedded one', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const version = runtime.getVersion();
    let calls = 0;
    runtime.subscribe(() => calls++);
    world.server.on('meta', () => respond(200, { ...world.server.current.meta, track: null }));

    await runtime.checkNow();

    expect(calls).toBeGreaterThan(0);
    expect(runtime.getVersion()).not.toBe(version);
    expect(runtime.t('a')).toBe('embedded a');
  });

  it('stop listening when the returned function is called', async () => {
    world = makeWorld();
    const runtime = await world.start();
    let calls = 0;
    const off = runtime.subscribe(() => calls++);
    off();
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    expect(calls).toBe(0);
  });

  it('tell every subscriber, even when one throws', async () => {
    world = makeWorld();
    const runtime = await world.start();
    let calls = 0;
    runtime.subscribe(() => {
      throw new Error('subscriber');
    });
    runtime.subscribe(() => calls++);
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    expect(calls).toBe(1);
  });

  it('are called after the text answers with the new value', async () => {
    world = makeWorld();
    const runtime = await world.start();
    const seen: string[] = [];
    runtime.subscribe(() => seen.push(runtime.t('a')));
    await until(() => seen.length > 0, 'the first notification');
    expect(seen).toEqual(['v1 b1 en']);
  });
});

describe('checkNow', () => {
  it('says noChange when the release is the one held', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    expect(await runtime.checkNow()).toBe('noChange');
  });

  it('says downloaded when a new release was fetched', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.release(V2);
    expect(await runtime.checkNow()).toBe('downloaded');
  });

  it('says notDue when asked again too soon', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    await runtime.checkNow();
    const metas = world.metaCount();
    expect(await runtime.checkNow()).toBe('notDue');
    expect(world.metaCount()).toBe(metas);
  });

  it('says failed when the delivery server could not be read', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.server.on('meta', () => problem(503, 'delivery.unavailable'));
    expect(await runtime.checkNow()).toBe('failed');
    expect(runtime.t('a')).toBe('v1 b1 en');
  });

  it('says failed on a network error, and the text stays', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.server.on('meta', () => new Error('offline'));
    expect(await runtime.checkNow()).toBe('failed');
    expect(runtime.t('a')).toBe('v1 b1 en');
  });

  it('never rejects', async () => {
    world = makeWorld({ degraded: true });
    const runtime = await world.start();
    await expect(runtime.checkNow()).resolves.toEqual(expect.stringMatching(/^(noChange|downloaded|notDue|failed)$/));
  });
});
