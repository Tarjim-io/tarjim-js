import { describe, expect, it } from 'vitest';
import { runCycle, slotName } from '../../src/internal.js';
import { hashOf, installed, makeRelease, makeWorld } from '../helpers/cycle-world.js';
import { respond } from '../support.js';

describe('the first check', () => {
  it('installs the release at once as the active one and records the check', async () => {
    const w = makeWorld();
    const result = await w.run();

    expect(result.outcome).toBe('activated');
    const state = await w.state();
    expect(state.active?.checksum).toBe(w.server.current.meta.checksum);
    expect(state.pending).toBeUndefined();
    expect(state.active?.slots[slotName('b1', 'en')]).toBe(hashOf(w.server.current, 'b1', 'en'));
    expect(state.active?.owed).toEqual([]);
    expect(result.install).toEqual(state.active);
    expect(state.lastCheck).toBe(w.clock.now());
    expect(await w.holds(hashOf(w.server.current, 'b1', 'en'))).toBe(true);
  });

  it('downloads only the selected locale', async () => {
    const w = makeWorld({ locale: 'fr' });
    await w.run();
    const state = await w.state();
    expect(Object.keys(state.active?.slots ?? {})).toEqual([slotName('b1', 'fr')]);
    expect(w.server.objectCount(hashOf(w.server.current, 'b1', 'fr'))).toBe(1);
    expect(w.server.objectCount(hashOf(w.server.current, 'b1', 'en'))).toBe(0);
  });
});

describe('the 60 second floor between checks', () => {
  it('sends no meta request before 60 seconds have passed since the last check', async () => {
    const w = await installed();
    w.clock.advance(-1000 + 59);
    const before = w.server.count('meta');

    expect((await w.run()).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(before);

    w.clock.advance(1);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(before + 1);
  });

  it('stays quiet after a reload, which builds a new client over the same store', async () => {
    const w = await installed();
    w.clock.advance(-1000 + 30);
    const before = w.server.count('meta');

    expect((await runCycle(w.tab())).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(before);

    w.clock.advance(30);
    expect((await runCycle(w.tab())).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(before + 1);
  });

  it('stays quiet in a second tab that shares the store', async () => {
    const w = await installed();
    expect((await w.run()).outcome).toBe('noChange');
    const before = w.server.count('meta');
    w.clock.advance(30);

    expect((await runCycle(w.tab())).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(before);
  });

  it('treats a last check in the future as now, so checks are not blocked', async () => {
    const w = await installed();
    await w.store.updateState((state) => ({ ...state, lastCheck: w.clock.now() + 1_000_000_000 }));
    const before = w.server.count('meta');

    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(before + 1);
    expect((await w.state()).lastCheck).toBeLessThanOrEqual(w.clock.now());
  });
});

describe('two checks at once', () => {
  it('sends one meta request when two contexts are due together', async () => {
    const w = makeWorld();
    const gate = w.server.hold('meta');

    const first = w.run();
    const second = runCycle(w.tab());
    for (const started of [first, second]) started.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    gate.release();
    const outcomes = [(await first).outcome, (await second).outcome].sort();

    expect(outcomes).toEqual(['activated', 'busy']);
    expect(w.server.count('meta')).toBe(1);
    expect(w.server.count('manifest')).toBe(1);
  });

  it('answers busy for a manual check too, and sends nothing', async () => {
    const w = makeWorld();
    const gate = w.server.hold('meta');
    const first = w.run();
    first.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect((await runCycle(w.tab())).outcome).toBe('busy');
    expect(w.server.count('meta')).toBe(1);

    gate.release();
    expect((await first).outcome).toBe('activated');
  });
});

describe('the identity sent with the meta request', () => {
  it('sends the release 0, the language and the identity on the first check', async () => {
    const w = makeWorld({ locale: 'fr' });
    w.selection.identity = { installId: 'install-1', osVersion: '14.2' };
    await w.run();

    const query = w.server.metaQuery();
    expect(query).toMatchObject({ release: '0', language: 'fr', installId: 'install-1', osVersion: '14.2' });
  });

  it('sends the held release afterwards', async () => {
    const w = await installed({ release: makeRelease({ releaseId: 12 }) });
    await w.run();
    expect(w.server.metaQuery()).toMatchObject({ release: '12', language: 'en' });
  });

  it('sends the newest known release, which is the pending one when there is one', async () => {
    const w = await installed({ release: makeRelease({ releaseId: 3 }) });
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 4 }));
    await w.run();
    expect((await w.state()).pending?.releaseId).toBe(4);

    w.clock.advance(1000);
    await w.run();
    expect(w.server.metaQuery()).toMatchObject({ release: '4' });
  });

  it('sends no language while none is chosen', async () => {
    const w = makeWorld();
    w.selection.locale = undefined;
    await w.run();
    expect(w.server.metaQuery()).not.toHaveProperty('language');
  });

  it('asks for no manifest while no language is chosen, and installs once one is', async () => {
    const w = makeWorld();
    w.selection.locale = undefined;
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('manifest')).toBe(0);
    expect((await w.state()).active).toBeUndefined();

    w.selection.locale = 'en';
    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('activated');
  });
});

describe('a manual check', () => {
  it('is held to the same floor as a launch check, in every context of one store', async () => {
    const w = await installed();
    w.clock.advance(-1000 + 10);
    const before = w.server.count('meta');

    expect((await w.run()).outcome).toBe('notDue');
    expect((await runCycle(w.tab())).outcome).toBe('notDue');
    w.clock.advance(49);
    expect((await runCycle(w.tab())).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(before);

    w.clock.advance(1);
    expect((await runCycle(w.tab())).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(before + 1);
  });

  it('does not postpone the next check when it is refused', async () => {
    const w = await installed();
    w.clock.advance(-1000 + 30);
    expect((await w.run()).outcome).toBe('notDue');

    w.clock.advance(30);
    expect((await w.run()).outcome).toBe('noChange');
  });

  it('cannot be hurried past a Retry-After', async () => {
    const w = await installed();
    w.server.on('meta', () => respond(503, 'busy', { headers: { 'Content-Type': 'text/plain', 'Retry-After': '600' } }), { times: 1 });
    await w.run();

    w.clock.advance(599);
    expect((await w.run()).outcome).toBe('notDue');
    w.clock.advance(1);
    expect((await w.run()).outcome).toBe('noChange');
  });

  it('goes ahead after the clock moved back past a wait it had written', async () => {
    const w = await installed();
    w.server.on('meta', () => respond(503, 'busy', { headers: { 'Content-Type': 'text/plain', 'Retry-After': '600' } }), { times: 1 });
    await w.run();
    const before = w.server.count('meta');

    w.clock.advance(-7 * 86_400_000);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(before + 1);
  });
});
