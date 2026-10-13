import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { API_KEY, SIGNED_QUERY, problem, respond, simpleRelease } from '../support.js';
import { DAY_MS, makeWorld, settle, until } from './world.js';
import type { World } from './world.js';

let world = makeWorld();
afterEach(() => world.stopAll());

const FLOOR = 61_000;

/** A manual check after the pause that checkNow() insists on. */
async function again(runtime: { checkNow(): Promise<unknown> }, w: World = world): Promise<void> {
  w.clock.set(w.clock.now() + FLOOR);
  await runtime.checkNow();
}

const forbid = (text: string) => {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(SIGNED_QUERY);
  expect(text).not.toContain('Signature=');
  expect(text).not.toContain('Key-Pair-Id');
  expect(text.toLowerCase()).not.toContain('x-tarjim-apikey');
};

describe('what is reported, once', () => {
  it('says nothing at all in a normal state', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    await again(runtime);
    await again(runtime);
    world.release({ content: { b1: 'v2' }, releaseId: 2 });
    await again(runtime);
    await runtime.setLanguage('fr');

    expect(world.reports).toEqual([]);
    expect(world.logs).toEqual([]);
  });

  it('reports a refused key once however many checks see it', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'));
    const runtime = await world.start();
    await until(() => world.reportsOf('configuration').length === 1, 'the report');
    await again(runtime);
    await again(runtime);
    await world.timers.advance(3_600_000);
    await settle();

    expect(world.metaCount()).toBeGreaterThanOrEqual(3);
    expect(world.reportsOf('configuration')).toHaveLength(1);
    expect(world.reportsOf('configuration')[0]!.details).toEqual({ status: 403, problemCode: 'delivery.forbidden' });
  });

  it('reports again the next day', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'));
    const runtime = await world.start();
    await until(() => world.reportsOf('configuration').length === 1, 'the report');

    world.clock.set(world.clock.now() + DAY_MS + 1000);
    await runtime.checkNow();
    expect(world.reportsOf('configuration')).toHaveLength(2);
    await again(runtime);
    expect(world.reportsOf('configuration')).toHaveLength(2);
  });

  it('reports a different condition separately', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'), { times: 1 });
    const runtime = await world.start();
    await until(() => world.reportsOf('configuration').length === 1, 'the first report');

    world.server.on('meta', () => problem(401, 'delivery.unauthorized'), { times: 1 });
    await again(runtime);
    expect(world.reportsOf('configuration').map((report) => report.details)).toEqual([
      { status: 403, problemCode: 'delivery.forbidden' },
      { status: 401, problemCode: 'delivery.unauthorized' },
    ]);
  });

  it('does not repeat itself in a new page load on the same day', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'));
    const first = await world.start();
    await until(() => world.reportsOf('configuration').length === 1, 'the report');
    first.stop();

    const second = await world.start();
    await again(second);
    expect(world.reportsOf('configuration')).toHaveLength(1);
    expect(Object.keys((await world.state()).reported ?? {})).toHaveLength(1);
  });

  it('is reported again after the condition went away and came back the next day', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'), { times: 1 });
    const runtime = await world.start();
    await until(() => world.reportsOf('configuration').length === 1, 'the report');
    await again(runtime);

    world.clock.set(world.clock.now() + DAY_MS);
    world.server.on('meta', () => problem(403, 'delivery.forbidden'), { times: 1 });
    await runtime.checkNow();
    expect(world.reportsOf('configuration')).toHaveLength(2);
  });
});

describe('what each condition is called', () => {
  const cases: Array<[string, () => void, string, Record<string, number> | undefined]> = [
    ['an unknown meta version', () => world.release({ metaOverrides: { schemaVersion: 2 } }), 'meta-schema', { schemaVersion: 2 }],
    ['an unknown manifest version', () => world.release({ manifestOverrides: { schemaVersion: 2 } }), 'manifest-schema', { schemaVersion: 2 }],
    ['a manifest that does not match its checksum', () => world.release({ tamper: { manifest: true } }), 'manifest-integrity', undefined],
    ['a slice that does not match its hash', () => world.release({ tamper: { slices: { 'b1/en': 'hash' } } }), 'slice-integrity', undefined],
  ];

  it.each(cases)('reports %s', async (_name, arrange, code, details) => {
    world = makeWorld();
    arrange();
    const runtime = await world.start();
    await until(() => world.reportsOf(code).length > 0, 'the report');
    await again(runtime);

    expect(world.reportsOf(code)).toHaveLength(1);
    if (details) expect(world.reportsOf(code)[0]!.details).toEqual(details);
    expect(runtime.t('a')).toBe('embedded a');
  });

  it('reports a manifest it cannot read', async () => {
    // The junk must match the meta's checksum, or it is an integrity failure instead.
    const junk = '{ not json';
    world = makeWorld({ release: { metaOverrides: { checksum: createHash('sha256').update(junk).digest('hex') } } });
    world.server.on('manifest', () => respond(200, junk));
    const runtime = await world.start();
    await until(() => world.reportsOf('manifest-unreadable').length > 0, 'the report');
    await again(runtime);
    expect(world.reportsOf('manifest-unreadable')).toHaveLength(1);
  });
});

describe('unknown versions', () => {
  it('keeps the held text and keeps polling when the meta version is unknown', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    const before = world.metaCount();
    world.release({ content: { b1: 'v2' }, releaseId: 2, metaOverrides: { schemaVersion: 2 } });

    await again(runtime);
    await again(runtime);

    expect(world.metaCount()).toBe(before + 2);
    expect(runtime.t('a')).toBe('v1 b1 en');
    expect((await world.state()).pending).toBeUndefined();
    expect(world.reportsOf('meta-schema')).toHaveLength(1);
  });

  it('reports each unknown version once', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.release({ metaOverrides: { schemaVersion: 2 } });
    await again(runtime);
    await again(runtime);
    world.release({ metaOverrides: { schemaVersion: 3 } });
    await again(runtime);
    await again(runtime);

    expect(world.reportsOf('meta-schema').map((report) => report.details)).toEqual([{ schemaVersion: 2 }, { schemaVersion: 3 }]);
  });

  it('picks the release up once the meta version is known again', async () => {
    world = makeWorld();
    const runtime = await world.startActive();
    world.release({ content: { b1: 'v2' }, releaseId: 2, metaOverrides: { schemaVersion: 2 } });
    await again(runtime);
    world.release({ content: { b1: 'v2' }, releaseId: 2 });
    await again(runtime);
    expect(runtime.activatePendingUpdate()).toBe(true);
    expect(runtime.t('a')).toBe('v2 b1 en');
  });

  const NEWER_SLICE = { schemaVersion: 2, keys: { a: { id: '1', value: 'from the future', tags: [] } } };

  it('does not decode a slice with an unknown version, falls back and reports once', async () => {
    world = makeWorld({ release: { content: { b1: 'v1' } } });
    world.server.use(
      simpleRelease({
        bundles: { b1: { type: 'namespace', name: 'b1' } },
        slices: { b1: { en: NEWER_SLICE, fr: NEWER_SLICE } },
      }),
    );
    const runtime = await world.start();
    await until(async () => (await world.state()).active !== undefined, 'the install');
    await again(runtime);

    expect(runtime.t('a')).toBe('embedded a');
    expect(runtime.t('a')).not.toBe('from the future');
    expect(world.reportsOf('slice-schema')).toHaveLength(1);
    expect(world.reportsOf('slice-schema')[0]!.details).toEqual({ schemaVersion: 2 });
  });
});

describe('where reports go', () => {
  it('is the report callback and the quiet log level, each once per report', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'));
    await world.start({ appVersion: 'v2-beta' });
    await until(() => world.reportsOf('configuration').length === 1, 'the report');

    expect(world.reports).toHaveLength(2);
    expect(world.logs.map((entry) => entry.level)).toEqual(['debug', 'debug']);
    for (const report of world.reports) {
      expect(report).toEqual({ code: expect.any(String), message: expect.any(String), ...(report.details ? { details: report.details } : {}) });
    }
    expect(world.logs.map((entry) => entry.message)).toEqual(world.reports.map((report) => report.message));
  });

  it('uses the info level instead when debug is on', async () => {
    world = makeWorld();
    await world.start({ appVersion: 'v2-beta', debug: true });
    expect(world.logs.map((entry) => entry.level)).toEqual(['info']);
  });

  it('logs even when there is no report callback', async () => {
    world = makeWorld();
    await world.start({ appVersion: 'v2-beta', onReport: undefined });
    expect(world.logs).toHaveLength(1);
    expect(world.logs[0]!.level).toBe('debug');
  });

  it('makes no request of its own', async () => {
    world = makeWorld();
    world.server.on('meta', () => problem(403, 'delivery.forbidden'));
    const runtime = await world.start({ appVersion: 'v2-beta' });
    await until(() => world.reportsOf('configuration').length === 1, 'the report');
    await again(runtime);
    for (const url of world.fetched) expect(url.startsWith('https://delivery.example.invalid/')).toBe(true);
    expect(world.fetched).toHaveLength(world.metaCount());
  });

  it('never carries the key, a signature or a header value', async () => {
    world = makeWorld();
    world.release({ tamper: { slices: { 'b1/en': 'hash' } } });
    const runtime = await world.start({ appVersion: 'v2-beta' });
    await until(() => world.reportsOf('slice-integrity').length === 1, 'the report');
    world.server.on('meta', () => problem(401, 'delivery.unauthorized'), { times: 1 });
    await again(runtime);
    world.release({ metaOverrides: { schemaVersion: 2 } });
    await again(runtime);
    world.release({ tamper: { manifest: true } });
    await again(runtime);

    expect(world.reports.length).toBeGreaterThanOrEqual(4);
    forbid(JSON.stringify(world.reports));
    forbid(JSON.stringify(world.logs));
    for (const report of world.reports) {
      for (const value of Object.values(report.details ?? {})) expect(['number', 'string']).toContain(typeof value);
    }
  });
});
