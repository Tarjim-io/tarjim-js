import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/index.js';
import { problem } from '../support.js';
import { makeWorld, settle, stillPending, until, within } from './world.js';
import type { World } from './world.js';

let world = makeWorld();
afterEach(() => world.stopAll());

const THREE = { release: { locales: ['en', 'fr', 'de'] } };
const V2 = { content: { b1: 'v2' }, releaseId: 2 };

async function again(runtime: { checkNow(): Promise<unknown> }, w: World = world): Promise<void> {
  w.clock.set(w.clock.now() + 61_000);
  await runtime.checkNow();
}

/** Starts a check that stays inside the delivery request until the gate is released. */
async function checkInFlight(runtime: { checkNow(): Promise<unknown> }) {
  const gate = world.server.hold('meta');
  const before = world.metaCount();
  world.clock.set(world.clock.now() + 61_000);
  const check = runtime.checkNow();
  await until(() => world.metaCount() > before, 'the check to reach the server');
  return { gate, check };
}

describe('two runtimes on one store', () => {
  it('both show the first release when only one of them could check', async () => {
    world = makeWorld();
    const gate = world.server.hold('meta');
    const a = await world.start();
    const b = await world.start();
    await settle();
    gate.release();

    await until(() => a.t('a') === 'v1 b1 en' && b.t('a') === 'v1 b1 en', 'both runtimes to show the release');
  });

  it('lets the one that lost the lock end its wait for content when the release lands', async () => {
    world = makeWorld();
    const gate = world.server.hold('meta');
    await world.start();
    const waiting = world.start({ waitForContent: 5000 });
    expect(await stillPending(waiting)).toBe(true);
    gate.release();

    const runtime = await within(waiting);
    expect(runtime.t('a')).toBe('v1 b1 en');
  });

  it('picks up the release in a check that is not yet due', async () => {
    world = makeWorld({ node: true });
    const gate = world.server.hold('meta');
    const a = await world.start();
    const b = await world.start();
    const first = a.checkNow();
    await until(() => world.metaCount() === 1, 'the first request');
    expect(await b.checkNow()).toBe('notDue');
    gate.release();
    await first;

    expect(await b.checkNow()).toBe('notDue');
    expect(b.t('a')).toBe('v1 b1 en');
  });
});

describe('setLanguage with a download waiting', () => {
  it('shows the new language from the text that is showing, not the one waiting', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    world.release({ ...V2, locales: ['en', 'fr', 'de'] });
    await runtime.checkNow();
    expect((await world.state()).pending?.releaseId).toBe(2);

    await runtime.setLanguage('fr');

    expect(runtime.language).toBe('fr');
    expect(runtime.t('a')).toBe('v1 b1 fr');
    const state = await world.state();
    expect(state.active?.releaseId).toBe(1);
    expect(state.pending?.releaseId).toBe(2);
  });

  it('has the new language in the waiting release too once it takes over', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    world.release({ ...V2, locales: ['en', 'fr', 'de'] });
    await runtime.checkNow();
    await runtime.setLanguage('fr');

    expect(runtime.activatePendingUpdate()).toBe(true);
    expect(runtime.t('a')).toBe('v2 b1 fr');
  });
});

describe('setLanguage while a check is running', () => {
  it('waits for the check and then fetches the language', async () => {
    world = makeWorld(THREE);
    const runtime = await world.startActive();
    const { gate, check } = await checkInFlight(runtime);

    const change = runtime.setLanguage('fr');
    expect(await stillPending(change)).toBe(true);
    gate.release();
    await check;

    await within(change);
    expect(runtime.language).toBe('fr');
    expect(runtime.t('a')).toBe('v1 b1 fr');
  });
});

describe('a configuration that is not an object', () => {
  it.each([['undefined', undefined], ['null', null], ['a string', 'https://delivery.example.invalid'], ['a number', 7]])(
    'serves only what it can for %s, with one report',
    async (_name, bad) => {
      world = makeWorld();
      const runtime = await within(createRuntime(bad as never, world.platform()));

      expect(runtime.t('a')).toBe('a');
      expect(runtime.language).toEqual(expect.any(String));
      await runtime.setLanguage('fr').catch(() => undefined);
      expect(world.logs).toHaveLength(1);
      expect(world.fetched).toEqual([]);
      runtime.stop();
    },
  );
});

describe('the install id and a check that learned nothing', () => {
  it('is not created after a network failure', async () => {
    world = makeWorld();
    world.server.on('meta', () => new Error('offline'));
    const runtime = await world.start();
    await until(() => world.metaCount() >= 1, 'the first check');
    await again(runtime);

    expect((await world.state()).installId).toBeUndefined();
  });

  it('is not created after a server error', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(500, 'delivery.server_error'));
    const runtime = await world.start();
    await until(() => world.metaCount() >= 1, 'the first check');
    await again(runtime);

    expect((await world.state()).installId).toBeUndefined();
  });

  it('is created once the delivery server has answered, even to refuse the key', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'));
    const runtime = await world.start();
    await until(() => world.reportsOf('configuration').length === 1, 'the refusal');
    await again(runtime);

    expect((await world.state()).installId).toEqual(expect.any(String));
  });
});

describe('activatePendingUpdate while a check is running', () => {
  it('still stores the activation when the lock was taken by that check', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.release(V2);
    await again(runtime);
    const { gate, check } = await checkInFlight(runtime);

    expect(runtime.activatePendingUpdate()).toBe(true);
    expect(runtime.t('a')).toBe('v2 b1 en');
    gate.release();
    await check;

    await until(async () => (await world.state()).active?.releaseId === 2, 'the stored activation');
    expect((await world.state()).pending).toBeUndefined();
  });
});

describe('activation at start while another runtime holds the lock', () => {
  it('waits for the lock and starts on the release that was waiting', async () => {
    world = makeWorld();
    const first = await world.startActive();
    world.release(V2);
    await again(first);
    first.stop();
    let open = (): void => undefined;
    const held = world.store.withLock(() => new Promise<void>((resolve) => (open = resolve)));

    const later = world.start();
    await settle(80);
    open();
    await held;
    const runtime = await within(later);

    expect(runtime.t('a')).toBe('v2 b1 en');
    expect((await world.state()).active?.releaseId).toBe(2);
  });
});

describe('a report that could not be delivered', () => {
  it('is not remembered, so the next occurrence is delivered', async () => {
    world = makeWorld();
    await world.start({ embedded: 'nope' }, {
      log: () => {
        throw new Error('console is gone');
      },
    });
    expect(world.codes()).toEqual([]);
    expect(Object.keys((await world.state()).reported ?? {})).toEqual([]);

    await world.start({ embedded: 'nope' });
    expect(world.codes()).toEqual(['embedded-invalid']);
  });

  it('is remembered when only the callback fails', async () => {
    world = makeWorld();
    await world.start({
      embedded: 'nope',
      onReport: () => {
        throw new Error('boom');
      },
    });
    expect(Object.keys((await world.state()).reported ?? {})).toHaveLength(1);
    expect(world.logs).toHaveLength(1);
  });
});

describe('stop', () => {
  it('ends an updates() iterator that is waiting', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const next = runtime.updates().next();
    expect(await stillPending(next)).toBe(true);

    runtime.stop();

    expect(await within(next)).toEqual({ done: true, value: undefined });
  });

  it('ends every iterator, and every call waiting on the same one', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const one = runtime.updates();
    const two = runtime.updates();
    const pending = [one.next(), one.next(), two.next()];

    runtime.stop();

    for (const result of await within(Promise.all(pending))) expect(result.done).toBe(true);
    expect((await one.next()).done).toBe(true);
  });

  it('stops calling listeners and subscribers', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const heard: string[] = [];
    runtime.on('downloaded', () => heard.push('on'));
    runtime.on('activated', () => heard.push('on'));
    runtime.subscribe(() => heard.push('subscriber'));
    runtime.stop();

    world.release(V2);
    await again(runtime);
    runtime.activatePendingUpdate();

    expect(heard).toEqual([]);
  });
});
