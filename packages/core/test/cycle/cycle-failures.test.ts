import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, fetchHeldLocale, runCycle, slotName } from '../../src/internal.js';
import { hashOf, installed, makeRelease, makeWorld } from '../helpers/cycle-world.js';
import type { World } from '../helpers/cycle-world.js';
import { fixtureResponse, problem, respond, sha256Hex } from '../support.js';

const serverError = () => respond(500, 'oops', { headers: { 'Content-Type': 'text/plain' } });
const edgeDown = () => respond(503, '<html>busy</html>', { headers: { 'Content-Type': 'text/html' } });
const throttled = () => fixtureResponse('errors/meta-429-too-many-requests.json');
const offline = () => new TypeError('Failed to fetch');
const waitedFor = (seconds: number) => () =>
  respond(503, 'busy', { headers: { 'Content-Type': 'text/plain', 'Retry-After': String(seconds) } });

async function delayAfterFailure(w: World): Promise<number> {
  const result = await w.run();
  expect(result.outcome).toBe('failed');
  const state = await w.state();
  return state.notBefore! - w.clock.now();
}

describe('a meta request that fails', () => {
  it.each([
    ['a server error', serverError],
    ['an unavailable edge', edgeDown],
    ['too many requests', throttled],
    ['no network', offline],
  ])('keeps what is held after %s, and recovers on the next try', async (_label, answer) => {
    const w = await installed();
    const held = (await w.state()).active!;
    w.server.on('meta', answer, { times: 1 });

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.install).toBeUndefined();
    const state = await w.state();
    expect(state.active).toEqual(held);
    expect(state.pending).toBeUndefined();
    expect(state.backoffStep).toBe(1);
    expect(state.notBefore!).toBeGreaterThan(w.clock.now());
    expect(await w.holds(hashOf(w.server.current, 'b1', 'en'))).toBe(true);
    expect(w.server.count('manifest')).toBe(1);

    w.clock.set(state.notBefore! + 1);
    expect((await w.run()).outcome).toBe('noChange');
    expect((await w.state()).backoffStep ?? 0).toBe(0);
  });

  it('leaves an empty store empty', async () => {
    const w = makeWorld();
    w.server.on('meta', serverError);
    expect((await w.run()).outcome).toBe('failed');
    const state = await w.state();
    expect(state.active).toBeUndefined();
    expect(state.pending).toBeUndefined();
  });

  it('waits longer after each failure, never past the poll interval', async () => {
    const w = await installed();
    w.server.on('meta', serverError);

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      delays.push(await delayAfterFailure(w));
      w.clock.set((await w.state()).notBefore! + 1);
    }

    expect((await w.state()).backoffStep).toBe(8);
    for (let i = 1; i < 4; i++) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    expect(delays[0]!).toBeGreaterThan(0);
    expect(delays[7]).toBe(900_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(900_000);
  });

  it('waits at least as long as the server asked, even beyond the poll interval', async () => {
    const w = await installed();
    w.server.on('meta', waitedFor(1200), { times: 1 });
    expect(await delayAfterFailure(w)).toBeGreaterThanOrEqual(1_200_000);
  });

  it('honours Retry-After on a throttled answer', async () => {
    const w = await installed();
    w.server.on('meta', () => respond(429, 'slow down', { headers: { 'Content-Type': 'text/plain', 'Retry-After': '600' } }), { times: 1 });
    expect(await delayAfterFailure(w)).toBeGreaterThanOrEqual(600_000);
  });

  it('sends nothing before the backoff is over, then tries again', async () => {
    const w = await installed();
    w.server.on('meta', waitedFor(600), { times: 1 });
    await w.run();
    const before = w.server.count('meta');

    w.clock.advance(599);
    expect((await w.run()).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(before);

    w.clock.advance(2);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(before + 1);
  });

  it('is not shortened by a manual check, but a manual check goes ahead once the wait is over', async () => {
    const w = await installed();
    w.server.on('meta', waitedFor(600), { times: 1 });
    await w.run();
    const before = w.server.count('meta');

    w.clock.advance(120);
    expect((await w.run('checkNow')).outcome).toBe('notDue');
    expect((await runCycle(w.tab(), 'checkNow')).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(before);

    w.clock.advance(481);
    expect((await w.run('checkNow')).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(before + 1);
  });
});

describe('a manifest request that fails', () => {
  it('keeps what is held and backs off', async () => {
    const w = await installed();
    const held = (await w.state()).active!;
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    w.server.on('manifest', edgeDown, { times: 1 });

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    const state = await w.state();
    expect(state.active).toEqual(held);
    expect(state.pending).toBeUndefined();
    expect(state.backoffStep).toBe(1);
    expect(state.notBefore!).toBeGreaterThan(w.clock.now());

    w.clock.set(state.notBefore! + 1);
    expect((await w.run()).outcome).toBe('downloaded');
  });

  it('writes nothing on a first install that cannot read its manifest', async () => {
    const w = makeWorld();
    w.server.on('manifest', offline);
    expect((await w.run()).outcome).toBe('failed');
    expect((await w.state()).active).toBeUndefined();
  });
});

describe('a release that is not there yet', () => {
  it('keeps what is held, reads nothing else, and polls again at the answer pollAfter', async () => {
    const w = await installed();
    const held = (await w.state()).active!;
    w.server.on('meta', () => problem(404, 'delivery.stage_unreleased', { pollAfter: 700 }), { times: 1 });
    const requests = w.server.log.length;

    const result = await w.run();
    expect(result.outcome).toBe('noChange');
    expect(w.server.log.length).toBe(requests + 1);
    const state = await w.state();
    expect(state.active).toEqual(held);
    expect(state.lastPollAfter).toBe(700);
    expect(state.lastCheck).toBe(w.clock.now());
    expect(await w.holds(hashOf(w.server.current, 'b1', 'en'))).toBe(true);

    w.clock.advance(699);
    expect((await w.run()).outcome).toBe('notDue');
    w.clock.advance(2);
    expect((await w.run()).outcome).toBe('noChange');
  });

  it('polls again after 60 seconds when the answer gives no interval', async () => {
    const w = await installed();
    w.server.on('meta', () => problem(404, 'delivery.stage_unreleased'), { times: 1 });
    await w.run();
    expect((await w.state()).lastPollAfter).toBe(60);

    w.clock.advance(59);
    expect((await w.run()).outcome).toBe('notDue');
    w.clock.advance(2);
    expect((await w.run()).outcome).toBe('noChange');
  });

  it('does not back off', async () => {
    const w = await installed();
    w.server.on('meta', () => problem(404, 'delivery.stage_unreleased', { pollAfter: 700 }), { times: 1 });
    await w.run();
    const state = await w.state();
    expect(state.backoffStep ?? 0).toBe(0);
    expect(state.notBefore === undefined || state.notBefore <= w.clock.now()).toBe(true);
  });

  it('keeps what is held when the track is not found, and polls again at the answer pollAfter', async () => {
    const w = await installed();
    const held = (await w.state()).active!;
    w.server.on('meta', () => problem(404, 'delivery.track_not_found', { pollAfter: 700 }), { times: 1 });
    const requests = w.server.log.length;

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(w.server.log.length).toBe(requests + 1);
    const state = await w.state();
    expect(state.active).toEqual(held);
    expect(state.lastPollAfter).toBe(700);
    expect(await w.holds(hashOf(w.server.current, 'b1', 'en'))).toBe(true);

    w.clock.advance(699);
    expect((await w.run()).outcome).toBe('notDue');
    w.clock.advance(2);
    expect((await w.run()).outcome).toBe('noChange');
  });
});

describe('a refused key or request', () => {
  it.each([
    [400, 'validation'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('keeps polling at the last interval after a %s', async (status, code) => {
    const w = await installed();
    const held = (await w.state()).active!;
    w.server.on('meta', () => problem(status, code), { times: 3 });

    for (let i = 0; i < 3; i++) {
      const before = w.server.count('meta');
      const result = await w.run();
      expect(result.outcome).toBe('failed');
      expect(result.conditions).toContainEqual(expect.objectContaining({ code: 'configuration', status }));
      expect(w.server.count('meta')).toBe(before + 1);
      expect(w.server.count('manifest')).toBe(1);
      expect((await w.state()).lastPollAfter).toBe(900);

      w.clock.advance(899);
      expect((await w.run()).outcome).toBe('notDue');
      w.clock.advance(2);
    }

    expect((await w.run()).outcome).toBe('noChange');
    expect((await w.state()).active).toEqual(held);
  });

  it('takes the interval from the answer when it gives one', async () => {
    const w = await installed();
    w.server.on('meta', () => problem(403, 'forbidden', { pollAfter: 700 }), { times: 1 });
    await w.run();
    expect((await w.state()).lastPollAfter).toBe(700);
  });

  it('polls every 1800 seconds when nothing is known and the answer gives no interval', async () => {
    const w = makeWorld();
    w.server.on('meta', () => problem(401, 'unauthorized'), { times: 1 });
    expect((await w.run()).outcome).toBe('failed');
    const state = await w.state();
    expect(state.lastPollAfter).toBe(1800);
    expect(state.lastCheck).toBe(w.clock.now());

    w.clock.advance(1799);
    expect((await w.run()).outcome).toBe('notDue');
    w.clock.advance(2);
    expect((await w.run()).outcome).toBe('activated');
  });
});

describe('a key bound to nothing', () => {
  it('reports unbound and reads nothing more', async () => {
    const w = makeWorld();
    w.server.on('meta', () => respond(200, { ...w.server.current.meta, track: null }), { times: 1 });

    const result = await w.run();
    expect(result.outcome).toBe('unbound');
    expect(result.conditions).toContainEqual({ code: 'unbound-key' });
    expect(w.server.log.map((request) => request.kind)).toEqual(['meta']);
    expect((await w.state()).lastCheck).toBe(w.clock.now());
  });

  it('keeps what is held', async () => {
    const w = await installed();
    const held = (await w.state()).active!;
    w.server.on('meta', () => respond(200, { ...w.server.current.meta, track: null }), { times: 1 });

    expect((await w.run()).outcome).toBe('unbound');
    expect((await w.state()).active).toEqual(held);
    expect(await w.holds(hashOf(w.server.current, 'b1', 'en'))).toBe(true);
  });
});

describe('storage that cannot be used', () => {
  it('fails with a storage condition and sends no request when the store is degraded', async () => {
    const w = makeWorld({ store: new MemoryStore('degraded-store', { degraded: true }) });
    const result = await w.run();

    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'storage' });
    expect(w.server.log).toHaveLength(0);
  });

  it('checks normally when the store is not degraded', async () => {
    const w = makeWorld({ store: new MemoryStore('healthy-store', { degraded: false }) });
    const result = await w.run();
    expect(result.outcome).toBe('activated');
    expect(result.conditions).not.toContainEqual({ code: 'storage' });
  });

  it.each(['quota', 'unavailable'] as const)('stops without an install when a slice cannot be stored (%s)', async (answer) => {
    const w = makeWorld();
    vi.spyOn(w.store, 'putSlice').mockResolvedValue(answer);

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'storage' });
    expect(result.install).toBeUndefined();
    const state = await w.state();
    expect(state.active).toBeUndefined();
    expect(state.pending).toBeUndefined();
  });

  it('keeps the active install when a newer release cannot be stored', async () => {
    const w = await installed();
    const held = (await w.state()).active!;
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));
    vi.spyOn(w.store, 'putSlice').mockResolvedValue('quota');

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'storage' });
    const state = await w.state();
    expect(state.active).toEqual(held);
    expect(state.pending).toBeUndefined();
  });
});

describe('a store that refuses to write the install', () => {
  it('backs off after a first install, like any transient failure', async () => {
    const w = makeWorld();
    vi.spyOn(w.store, 'writeInstall').mockResolvedValue(false);

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'storage' });
    const state = await w.state();
    expect(state.backoffStep).toBe(1);
    expect(state.notBefore!).toBeGreaterThan(w.clock.now());
    expect(state.active).toBeUndefined();
  });

  it('backs off after extending the install for a new locale', async () => {
    const w = await installed();
    vi.spyOn(w.store, 'writeInstall').mockResolvedValue(false);
    w.selection.locale = 'fr';

    const result = await fetchHeldLocale(w.ctx);
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'storage' });
    const state = await w.state();
    expect(state.backoffStep).toBe(1);
    expect(state.notBefore!).toBeGreaterThan(w.clock.now());
  });

  it('backs off after retrying an owed slot', async () => {
    const bad = makeRelease({ content: { b1: 'v1' }, tamper: { slices: { 'b1/en': 'hash' } } });
    const w = makeWorld({ release: bad });
    await w.run();
    w.clock.advance(1000);
    w.server.use(makeRelease({ content: { b1: 'v1' } }));
    vi.spyOn(w.store, 'writeInstall').mockResolvedValue(false);

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'storage' });
    expect((await w.state()).backoffStep).toBe(1);
  });
});

describe('an object that cannot be fetched while a release is installed', () => {
  const both = (tag: string) => ({ b1: tag, b2: tag });
  const gone = () => respond(404, 'gone', { headers: { 'Content-Type': 'text/plain' } });

  async function nextRelease() {
    const v1 = makeRelease({ content: both('v1') });
    const w = await installed({ release: v1 });
    const v2 = makeRelease({ content: both('v2'), releaseId: 2 });
    w.server.use(v2);
    return { w, v1, v2, b1: slotName('b1', 'en') };
  }

  it('is owed while the rest installs, and the check settles without a backoff', async () => {
    const { w, v1, v2, b1 } = await nextRelease();
    w.server.on('object', gone, { name: hashOf(v2, 'b1', 'en') });
    const before = (await w.state()).lastCheck;

    const result = await w.run();
    expect(result.outcome).toBe('downloaded');
    const state = await w.state();
    expect(state.pending?.slots[b1]).toBe(hashOf(v1, 'b1', 'en'));
    expect(state.pending?.slots[slotName('b2', 'en')]).toBe(hashOf(v2, 'b2', 'en'));
    expect(state.pending?.owed).toEqual([b1]);
    expect(state.lastCheck).toBe(w.clock.now());
    expect(state.lastCheck).not.toBe(before);
    expect(state.backoffStep).toBeUndefined();
    expect(state.notBefore).toBeUndefined();

    w.server.clearRules();
    w.clock.advance(1000);
    const retried = await w.run();
    expect(retried.install?.owed).toEqual([]);
    expect((await w.state()).pending?.slots[b1]).toBe(hashOf(v2, 'b1', 'en'));
  });

  it('is owed while the rest installs, and a network failure backs off', async () => {
    const { w, v1, v2, b1 } = await nextRelease();
    w.server.on('object', offline, { name: hashOf(v2, 'b1', 'en') });
    const before = (await w.state()).lastCheck;

    const result = await w.run();
    expect(result.outcome).toBe('downloaded');
    const state = await w.state();
    expect(state.pending?.slots[b1]).toBe(hashOf(v1, 'b1', 'en'));
    expect(state.pending?.slots[slotName('b2', 'en')]).toBe(hashOf(v2, 'b2', 'en'));
    expect(state.pending?.owed).toEqual([b1]);
    expect(state.lastCheck).toBe(before);
    expect(state.backoffStep).toBe(1);
    expect(state.notBefore!).toBeGreaterThan(w.clock.now());

    w.server.clearRules();
    w.clock.set(state.notBefore! + 1);
    expect((await w.run()).install?.owed).toEqual([]);
  });
});

describe('a manifest that cannot be decoded', () => {
  const oversized = () => respond(200, new Uint8Array(8 * 1024 * 1024 + 1).fill(120));

  function notAManifest(w: World) {
    const text = '{"hello":"world"}';
    w.server.on('meta', () => respond(200, { ...w.server.current.meta, checksum: sha256Hex(text) }));
    w.server.on('manifest', () => respond(200, text));
  }

  it.each([
    ['is over the size cap', (w: World) => w.server.on('manifest', oversized)],
    ['is not a manifest', notAManifest],
  ])('backs off, reports it, and is tried again when it %s', async (_label, arrange) => {
    const w = makeWorld();
    arrange(w);

    const result = await w.run();
    expect(result.outcome).toBe('failed');
    expect(result.conditions).toContainEqual({ code: 'manifest-unreadable' });
    const state = await w.state();
    expect(state.rejectedChecksums ?? []).toEqual([]);
    expect(state.backoffStep).toBe(1);
    expect(state.notBefore!).toBeGreaterThan(w.clock.now());
    expect(state.lastCheck).toBeUndefined();

    w.clock.set(state.notBefore! + 1);
    await w.run();
    expect(w.server.count('manifest')).toBe(2);

    w.server.clearRules();
    w.clock.advance(1000);
    expect((await w.run()).outcome).toBe('activated');
  });
});
