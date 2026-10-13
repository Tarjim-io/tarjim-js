import { describe, expect, it } from 'vitest';
import { fetchHeldLocale, runCycle, slotName } from '../../src/index.js';
import { hashOf, installed, makeRelease, makeWorld } from '../helpers/cycle-world.js';
import { ROTATED_SIGNED_QUERY, SIGNED_QUERY, fixtureResponse, respond } from '../support.js';

describe('the locale a visitor switches to', () => {
  it('is fetched from the held manifest without reading meta, and applies at once', async () => {
    const w = await installed();
    const release = w.server.current;
    w.clock.advance(-900);
    w.selection.locale = 'fr';
    const metas = w.server.count('meta');

    const result = await fetchHeldLocale(w.ctx);
    expect(result.outcome).toBe('activated');
    expect(w.server.count('meta')).toBe(metas);
    expect(w.server.count('manifest')).toBe(1);
    expect(w.server.objectCount(hashOf(release, 'b1', 'fr'))).toBe(1);
    expect(w.server.requests('object').slice(-1)[0]?.url).toContain(SIGNED_QUERY);

    const state = await w.state();
    expect(state.active?.checksum).toBe(release.meta.checksum);
    expect(state.active?.slots[slotName('b1', 'fr')]).toBe(hashOf(release, 'b1', 'fr'));
    expect(state.active?.slots[slotName('b1', 'en')]).toBe(hashOf(release, 'b1', 'en'));
    expect(state.pending).toBeUndefined();
    expect(result.install).toEqual(state.active);
    expect(state.localeFetched).toBe(`${release.meta.checksum}\nfr`);
  });

  it('is fetched inside a cycle that is not due, before any meta request', async () => {
    const w = await installed();
    w.clock.advance(-900);
    w.selection.locale = 'fr';
    const metas = w.server.count('meta');

    const result = await runCycle(w.ctx, 'scheduled');
    expect(['activated', 'notDue']).toContain(result.outcome);
    expect(w.server.count('meta')).toBe(metas);
    expect((await w.state()).active?.slots[slotName('b1', 'fr')]).toBe(hashOf(w.server.current, 'b1', 'fr'));
  });

  it('is fetched once for one change of selection', async () => {
    const w = await installed();
    w.selection.locale = 'fr';
    await runCycle(w.ctx, 'scheduled');
    const fr = hashOf(w.server.current, 'b1', 'fr');
    expect(w.server.objectCount(fr)).toBe(1);

    for (let i = 0; i < 3; i++) {
      w.clock.advance(1000);
      await runCycle(w.ctx, 'scheduled');
      await fetchHeldLocale(w.ctx);
    }
    expect(w.server.objectCount(fr)).toBe(1);
  });

  it('extends the install for each new locale in turn', async () => {
    const w = await installed({ release: makeRelease({ locales: ['en', 'fr', 'de'] }) });
    w.selection.locale = 'fr';
    await fetchHeldLocale(w.ctx);
    w.selection.locale = 'de';
    await fetchHeldLocale(w.ctx);

    const state = await w.state();
    expect(state.active?.slots[slotName('b1', 'de')]).toBe(hashOf(w.server.current, 'b1', 'de'));
    expect(state.active?.slots[slotName('b1', 'fr')]).toBe(hashOf(w.server.current, 'b1', 'fr'));
  });

  it('is fetched with the signature the install recorded, after a reload, without reading meta first', async () => {
    const w = await installed();
    w.server.current.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    w.selection.locale = 'fr';
    const metas = w.server.count('meta');

    const result = await fetchHeldLocale(w.tab());
    expect(result.outcome).toBe('activated');
    expect(w.server.count('meta')).toBe(metas);
    const request = w.server.requests('object').slice(-1)[0]!;
    expect(request.url).toContain(SIGNED_QUERY);
    expect(request.url).not.toContain(ROTATED_SIGNED_QUERY);
  });

  it('does nothing when the held manifest does not list the locale', async () => {
    const w = await installed();
    w.selection.locale = 'de';
    const requests = w.server.log.length;

    const result = await fetchHeldLocale(w.ctx);
    expect(result.install).toBeUndefined();
    expect(w.server.log.length).toBe(requests);
    expect((await w.state()).active?.slots[slotName('b1', 'de')]).toBeUndefined();
  });

  it('does nothing when the locale is already held', async () => {
    const w = await installed();
    const requests = w.server.log.length;
    const result = await fetchHeldLocale(w.ctx);
    expect(result.install).toBeUndefined();
    expect(w.server.log.length).toBe(requests);
  });

  it('is fetched in a due cycle whose meta is unchanged, and not downloaded twice', async () => {
    const w = await installed();
    w.selection.locale = 'fr';
    const fr = hashOf(w.server.current, 'b1', 'fr');
    const metas = w.server.count('meta');

    await runCycle(w.ctx, 'scheduled');
    expect(w.server.count('meta')).toBe(metas + 1);
    expect(w.server.objectCount(fr)).toBe(1);
    expect((await w.state()).active?.slots[slotName('b1', 'fr')]).toBe(fr);
  });

  it('goes to the pending install when the pending manifest is the held one', async () => {
    const w = await installed();
    const first = w.server.current;
    const next = makeRelease({ content: { b1: 'v1', b2: 'v1' }, releaseId: 2 });
    w.server.use(next);
    await w.run();
    w.selection.locale = 'fr';

    const result = await fetchHeldLocale(w.ctx);
    expect(result.outcome).toBe('activated');
    const state = await w.state();
    expect(state.pending?.slots[slotName('b1', 'fr')]).toBe(hashOf(next, 'b1', 'fr'));
    expect(state.pending?.slots[slotName('b2', 'fr')]).toBe(hashOf(next, 'b2', 'fr'));
    expect(state.active?.releaseId).toBe(1);
    expect(state.active?.slots[slotName('b1', 'fr')]).toBe(hashOf(first, 'b1', 'fr'));
  });

  it('reads the meta once when the recorded signature is refused', async () => {
    const w = await installed();
    w.server.current.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    w.selection.locale = 'fr';
    const fr = hashOf(w.server.current, 'b1', 'fr');
    w.server.on('object', () => fixtureResponse('errors/object-403-cdn-edge.json'), { name: fr, urlIncludes: 'Signature=S1' });
    const metas = w.server.count('meta');

    const result = await fetchHeldLocale(w.ctx);
    expect(result.outcome).toBe('activated');
    expect(w.server.count('meta')).toBe(metas + 1);
    expect(w.server.objectCount(fr)).toBe(2);
    expect(w.server.requests('object').slice(-1)[0]?.url).toContain(ROTATED_SIGNED_QUERY);
  });

  it('stops after one re-read when the new signature is refused as well', async () => {
    const w = await installed();
    w.server.current.setMeta({ signedQuery: ROTATED_SIGNED_QUERY });
    w.selection.locale = 'fr';
    const fr = hashOf(w.server.current, 'b1', 'fr');
    w.server.on('object', () => fixtureResponse('errors/object-403-cdn-edge.json'), { name: fr });
    const metas = w.server.count('meta');

    const result = await fetchHeldLocale(w.ctx);
    expect(result.install).toBeUndefined();
    expect(w.server.count('meta')).toBe(metas + 1);
    expect(w.server.objectCount(fr)).toBe(2);
  });
});

describe('a locale whose slices cannot be used', () => {
  const edge403 = () => fixtureResponse('errors/object-403-cdn-edge.json');

  it('is owed in full, without an event, when every slice fails verification', async () => {
    const bad = makeRelease({ content: { b1: 'v1', b2: 'v1' }, tamper: { slices: { 'b1/fr': 'hash', 'b2/fr': 'hash' } } });
    const w = await installed({ release: bad });
    w.selection.locale = 'fr';

    const result = await fetchHeldLocale(w.ctx);
    expect(result.outcome).toBe('noChange');
    expect(result.install).toBeUndefined();
    expect(result.conditions).toContainEqual({ code: 'sliceIntegrity' });
    const state = await w.state();
    expect([...(state.active?.owed ?? [])].sort()).toEqual([slotName('b1', 'fr'), slotName('b2', 'fr')]);
    expect(state.active?.slots[slotName('b1', 'fr')]).toBeUndefined();
    expect(state.localeFetched).toBe(`${bad.meta.checksum}\nfr`);

    w.server.use(makeRelease({ content: { b1: 'v1', b2: 'v1' } }));
    w.clock.advance(1000);
    const retried = await w.run();
    expect(retried.install?.owed).toEqual([]);
    expect((await w.state()).active?.slots[slotName('b2', 'fr')]).toBeDefined();
  });

  it('is owed, and the polls go on every period, while its object stays refused', async () => {
    const w = await installed();
    w.selection.locale = 'fr';
    w.server.on('object', edge403, { name: hashOf(w.server.current, 'b1', 'fr') });

    for (let period = 0; period < 3; period++) {
      const result = await runCycle(w.ctx, 'scheduled');
      expect(result.outcome).not.toBe('failed');
      const state = await w.state();
      expect(state.lastCheck).toBe(w.clock.now());
      expect(state.backoffStep).toBeUndefined();
      expect(state.notBefore).toBeUndefined();
      expect(state.active?.owed).toEqual([slotName('b1', 'fr')]);
      w.clock.advance(901);
    }
    expect(w.server.count('meta')).toBeGreaterThanOrEqual(4);
  });

  it('takes the active file for a slot owed in the pending install', async () => {
    const v1 = makeRelease({ releaseId: 1 });
    const w = await installed({ release: v1 });
    w.selection.locale = 'fr';
    await fetchHeldLocale(w.ctx);
    w.selection.locale = 'en';
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2, tamper: { slices: { 'b1/fr': 'hash' } } }));
    await w.run();
    expect(Object.keys((await w.state()).pending?.slots ?? {})).toEqual([slotName('b1', 'en')]);

    w.selection.locale = 'fr';
    const result = await fetchHeldLocale(w.ctx);
    expect(result.install).toBeUndefined();
    const state = await w.state();
    expect(state.pending?.slots[slotName('b1', 'fr')]).toBe(hashOf(v1, 'b1', 'fr'));
    expect(state.pending?.owed).toEqual([slotName('b1', 'fr')]);
  });
});

describe('what a cycle reports about the active install', () => {
  it('names the active install it extended even when the poll wrote a pending one', async () => {
    const w = await installed();
    w.selection.locale = 'fr';
    // Keeps b1 as it was, so the object the old manifest lists is still served.
    w.server.use(makeRelease({ content: { b1: 'v1', b2: 'v1' }, releaseId: 2 }));

    const result = await runCycle(w.ctx, 'scheduled');
    const state = await w.state();
    expect(result.outcome).toBe('downloaded');
    expect(result.install).toEqual(state.pending);
    expect(result.active).toEqual(state.active);
    expect(state.active?.slots[slotName('b1', 'fr')]).toBeDefined();
  });

  it('leaves it out when the cycle did not touch the active install', async () => {
    const w = await installed();
    w.server.use(makeRelease({ content: { b1: 'v2' }, releaseId: 2 }));

    const result = await runCycle(w.ctx, 'scheduled');
    expect(result.outcome).toBe('downloaded');
    expect(result.active).toBeUndefined();
  });

  it('is not fetched for a locale while a backoff is running, and says the cycle is not due', async () => {
    const w = await installed();
    w.server.on('meta', () => respond(500, 'oops', { headers: { 'Content-Type': 'text/plain' } }), { times: 1 });
    await w.run();
    w.selection.locale = 'fr';
    const requests = w.server.log.length;

    const result = await fetchHeldLocale(w.ctx);
    expect(result.outcome).toBe('notDue');
    expect(w.server.log.length).toBe(requests);
  });
});

describe('the first install', () => {
  it('holds the selected locale of every bundle', async () => {
    const w = makeWorld({ release: makeRelease({ content: { b1: 'v1', b2: 'v1' } }), locale: 'fr' });
    await w.run();
    const state = await w.state();
    expect(Object.keys(state.active?.slots ?? {}).sort()).toEqual([slotName('b1', 'fr'), slotName('b2', 'fr')]);
  });
});
