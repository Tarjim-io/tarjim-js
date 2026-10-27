import { afterEach, describe, expect, it } from 'vitest';
import { slotName } from '../../src/internal.js';
import { hashOf } from '../helpers/cycle-world.js';
import { respond } from '../support.js';
import { makeWorld, settle, stillPending, until, within } from './world.js';

let world = makeWorld();
afterEach(() => world.stopAll());

const V2 = { content: { b1: 'v2' }, releaseId: 2 };

describe('the first start with nothing held', () => {
  it('answers from the embedded text at once and from the first release when it lands', async () => {
    world = makeWorld();
    const runtime = await within(world.start());

    expect(runtime.ready).toBe(true);
    expect(runtime.t('a')).toBe('embedded a');
    expect(runtime.t('e')).toBe('embedded e');
    expect(runtime.t('nowhere')).toBe('nowhere');
    await until(() => runtime.t('a') === 'v1 b1 en', 'the first release');
    expect(runtime.t('e')).toBe('embedded e');
    expect(runtime.entry('a')).toMatchObject({ value: 'v1 b1 en', id: '1' });
    expect(runtime.entry('nowhere')).toBeNull();
  });

  it('checks straight away, without waiting for a timer', async () => {
    world = makeWorld();
    await world.start();
    await until(() => world.metaCount() === 1, 'the first check');
    expect(world.timers.count).toBeLessThanOrEqual(1);
  });

  it('fires one activated event and no downloaded event', async () => {
    world = makeWorld();
    const runtime = await world.start();
    const activated: string[] = [];
    const downloaded: string[] = [];
    runtime.on('activated', (event) => activated.push(event.type));
    runtime.on('downloaded', (event) => downloaded.push(event.type));

    await until(() => activated.length > 0, 'the activated event');
    await settle();
    expect(activated).toEqual(['activated']);
    expect(downloaded).toEqual([]);
  });

  it('keeps the first release in the store as the active install', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const state = await world.state();
    expect(state.active?.slots[slotName('b1', 'en')]).toBe(hashOf(world.server.current, 'b1', 'en'));
    expect(state.pending).toBeUndefined();
    expect(runtime.language).toBe('en');
  });
});

describe('a later release', () => {
  it('downloads as pending and leaves the text alone', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const downloaded: string[] = [];
    runtime.on('downloaded', (event) => downloaded.push(event.type));
    world.release(V2);

    expect(await runtime.checkNow()).toBe('downloaded');

    expect(downloaded).toEqual(['downloaded']);
    expect(runtime.t('a')).toBe('v1 b1 en');
    const state = await world.state();
    expect(state.pending?.releaseId).toBe(2);
    expect(state.active?.releaseId).toBe(1);
  });

  it('activates when the next page loads', async () => {
    world = makeWorld();
    const first = await world.startActive();
    world.release(V2);
    await first.checkNow();
    first.stop();
    world.server.on('meta', () => new Error('offline'));

    const second = await within(world.start());

    expect(second.t('a')).toBe('v2 b1 en');
    const state = await world.state();
    expect(state.active?.releaseId).toBe(2);
    expect(state.pending).toBeUndefined();
  });

  it('is not activated by a new runtime that still finds nothing pending', async () => {
    world = makeWorld();
    const first = await world.startActive();
    first.stop();
    const second = await world.start();
    expect(second.t('a')).toBe('v1 b1 en');
    expect((await world.state()).active?.releaseId).toBe(1);
  });

  it('activates on request, once, and says so', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.release(V2);
    await runtime.checkNow();
    const activated: string[] = [];
    runtime.on('activated', (event) => activated.push(event.type));

    expect(runtime.activatePendingUpdate()).toBe(true);

    expect(runtime.t('a')).toBe('v2 b1 en');
    expect(activated).toEqual(['activated']);
    expect(runtime.activatePendingUpdate()).toBe(false);
    await until(async () => (await world.state()).active?.releaseId === 2, 'the stored active install');
    expect((await world.state()).pending).toBeUndefined();
  });

  it('has nothing to activate when nothing is pending', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    expect(runtime.activatePendingUpdate()).toBe(false);
    expect(runtime.t('a')).toBe('v1 b1 en');
  });

  it('serves the old text for a slice that went missing, and owes it', async () => {
    world = makeWorld();
    const first = await world.startActive();
    world.release(V2);
    await first.checkNow();
    first.stop();
    const pendingHash = hashOf(world.server.current, 'b1', 'en');
    (world.store as unknown as { hidden: Set<string> }).hidden.add(pendingHash);
    world.server.on('meta', () => new Error('offline'));

    const second = await within(world.start());

    expect(second.t('a')).toBe('v1 b1 en');
    await until(async () => (await world.state()).active?.owed.includes(slotName('b1', 'en')) === true, 'the owed slot');
  });

  it('fetches the owed slice again at the next check and then shows it', async () => {
    world = makeWorld();
    const first = await world.startActive();
    world.release(V2);
    await first.checkNow();
    first.stop();
    const hidden = (world.store as unknown as { hidden: Set<string> }).hidden;
    hidden.add(hashOf(world.server.current, 'b1', 'en'));
    world.server.on('meta', () => new Error('offline'), { times: 1 });
    const second = await world.start();
    await until(async () => (await world.state()).active?.owed.length === 1, 'the owed slot');

    hidden.clear();
    await world.timers.advance(3_600_000);
    await until(() => second.t('a') === 'v2 b1 en', 'the repaired text');
  });
});

describe('waiting for content', () => {
  it('does not wait by default, even with the delivery server stalled', async () => {
    world = makeWorld();
    world.server.hold('meta');
    const runtime = await within(world.start());
    expect(runtime.t('a')).toBe('embedded a');
  });

  it('takes the first release when it arrives before the time is up', async () => {
    world = makeWorld();
    const runtime = await within(world.start({ waitForContent: 5000 }));
    expect(runtime.t('a')).toBe('v1 b1 en');
  });

  it('gives up at the time limit and serves the embedded text, then the release when it comes', async () => {
    world = makeWorld();
    const gate = world.server.hold('meta');
    const pending = world.start({ waitForContent: 500 });
    pending.catch(() => undefined);

    expect(await stillPending(pending)).toBe(true);
    await world.timers.advance(500);
    const runtime = await within(pending);
    expect(runtime.t('a')).toBe('embedded a');

    gate.release();
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
  });

  it('does not hold the page back when text is already held', async () => {
    world = makeWorld();
    const first = await world.startActive();
    first.stop();
    world.server.hold('meta');
    const runtime = await within(world.start({ waitForContent: 5000 }));
    expect(runtime.t('a')).toBe('v1 b1 en');
  });

  it('is not cut short by the time limit before it has passed', async () => {
    world = makeWorld();
    world.server.hold('meta');
    const pending = world.start({ waitForContent: 5000 });
    pending.catch(() => undefined);
    await world.timers.advance(4000);
    expect(await stillPending(pending)).toBe(true);
    await world.timers.advance(1000);
    await within(pending);
  });

  it('resolves at the time limit when the delivery server keeps failing', async () => {
    world = makeWorld();
    world.server.on('meta', () => respond(502, 'bad gateway'));
    const pending = world.start({ waitForContent: 300 });
    pending.catch(() => undefined);
    await world.timers.advance(300);
    const runtime = await within(pending);
    expect(runtime.t('a')).toBe('embedded a');
  });
});

describe('without timers (Node)', () => {
  it('starts no scheduler: nothing is requested until checkNow', async () => {
    world = makeWorld({ node: true });
    const runtime = await within(world.start());
    await settle(80);

    expect(world.fetched).toEqual([]);
    expect(runtime.t('a')).toBe('embedded a');
    await runtime.checkNow();
    await until(() => runtime.t('a') === 'v1 b1 en', 'the release');
    expect(world.metaCount()).toBe(1);
  });

  it('checks again only when asked, and respects the pause between asks', async () => {
    world = makeWorld({ node: true });
    const runtime = await world.start();
    await runtime.checkNow();
    expect(await runtime.checkNow()).toBe('notDue');
    world.clock.advance(61);
    expect(await runtime.checkNow()).toBe('noChange');
    await settle(80);
    expect(world.metaCount()).toBe(2);
  });

  it('works with waitForContent and no way to time out', async () => {
    world = makeWorld({ node: true });
    const runtime = await within(world.start({ waitForContent: 0 }));
    expect(runtime.ready).toBe(true);
  });
});

describe('the scheduler', () => {
  it('checks again when the poll interval has passed', async () => {
    world = makeWorld();
    await world.startActive();
    const before = world.metaCount();
    await world.timers.advance(10 * 60 * 1000);
    await settle();
    expect(world.metaCount()).toBe(before);

    await world.timers.advance(10 * 60 * 1000);
    await until(() => world.metaCount() === before + 1, 'the next check');
  });

  it('does not check while the page is hidden, and does once it shows', async () => {
    world = makeWorld({ hidden: true });
    await world.start();
    await settle(80);
    expect(world.metaCount()).toBe(0);

    world.visibility.set(true);
    await until(() => world.metaCount() === 1, 'the check on becoming visible');
  });

  it('stops the timers and the visibility listener on stop()', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    await settle();
    expect(world.timers.count).toBe(1);
    expect(world.visibility.listenerCount).toBe(1);

    runtime.stop();
    expect(world.timers.count).toBe(0);
    expect(world.visibility.listenerCount).toBe(0);
    const before = world.metaCount();
    await world.timers.advance(86_400_000);
    await settle();
    expect(world.metaCount()).toBe(before);
  });

  it('can be stopped twice and still answers lookups', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    runtime.stop();
    runtime.stop();
    expect(runtime.t('a')).toBe('v1 b1 en');
  });

  it('stops a runtime that is still waiting for its first check', async () => {
    world = makeWorld();
    world.server.hold('meta');
    const runtime = await world.start();
    runtime.stop();
    expect(world.timers.count).toBe(0);
    expect(world.visibility.listenerCount).toBe(0);
  });
});

describe('a key bound to nothing', () => {
  const unbound = () =>
    world.server.on('meta', () => respond(200, { ...world.server.current.meta, track: null }));

  it('stops polling, serves only the embedded text and reports it once', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    unbound();

    await runtime.checkNow();
    await until(() => runtime.t('a') === 'embedded a', 'the embedded text');

    const metas = world.metaCount();
    await world.timers.advance(3 * 86_400_000);
    await settle();
    expect(world.metaCount()).toBe(metas);
    expect(world.timers.count).toBe(0);
    expect(world.reportsOf('unbound-key')).toHaveLength(1);
  });

  it('serves no downloaded text even though some is held', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    unbound();
    await runtime.checkNow();
    await until(() => runtime.t('a') === 'embedded a', 'the embedded text');
    expect(runtime.entry('a')?.value).toBe('embedded a');
    expect((await world.state()).active).toBeDefined();
  });

  it('is the same on a first start with nothing held', async () => {
    world = makeWorld();
    unbound();
    const runtime = await world.start();
    await until(() => world.reportsOf('unbound-key').length === 1, 'the report');
    await world.timers.advance(86_400_000);
    await settle();
    expect(world.metaCount()).toBe(1);
    expect(runtime.t('a')).toBe('embedded a');
  });

  it('says how to fix it in the report', async () => {
    world = makeWorld();
    unbound();
    await world.start();
    await until(() => world.reportsOf('unbound-key').length === 1, 'the report');
    expect(world.reportsOf('unbound-key')[0]?.message).toBe(
      'This key is not bound to a track and stage, so it can act as its creator everywhere. ' +
        'Use a key bound to a stage. For the latest translations, turn on Follow latest on that stage.'
    );
  });

  it('keeps polling for a key that is bound (twin)', async () => {
    world = makeWorld();
    await world.startActive();
    await world.timers.advance(86_400_000);
    await until(() => world.metaCount() >= 2, 'a later check');
    expect(world.reportsOf('unbound-key')).toEqual([]);
  });
});

describe('runtimes are independent', () => {
  it('start() twice gives two instances that do not share a language', async () => {
    world = makeWorld();
    const a = await world.start({ language: 'en' });
    const b = await world.start({ language: 'en' });
    expect(a).not.toBe(b);

    await a.setLanguage('fr');
    expect(a.language).toBe('fr');
    expect(b.language).toBe('en');
    expect(a.t('a')).toMatch(/ fr$/);
    expect(b.t('a')).not.toMatch(/ fr$/);
  });

  it('keeps events and stopping apart', async () => {
    world = makeWorld();
    const a = await world.start({ language: 'en' });
    const b = await world.start({ language: 'en' });
    const heard: string[] = [];
    b.on('languageChanged', () => heard.push('b'));
    a.on('languageChanged', () => heard.push('a'));

    await a.setLanguage('fr');
    expect(heard).toEqual(['a']);
    a.stop();
    await expect(b.setLanguage('fr')).resolves.toBeUndefined();
    expect(heard).toEqual(['a', 'b']);
  });

  it('different configurations hold different stores and texts', async () => {
    world = makeWorld();
    const other = makeWorld({ release: { content: { b1: 'other' } } });
    const a = await world.startActive();
    const b = await other.startActive();
    expect(a.t('a')).toBe('v1 b1 en');
    expect(b.t('a')).toBe('other b1 en');
    other.stopAll();
  });
});
