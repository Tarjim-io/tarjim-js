import { describe, expect, it } from 'vitest';
import { problem, respond } from '../support.js';
import { makeRelease, makeWorld } from '../helpers/cycle-world.js';

const NO_INTERVAL = { metaOverrides: { pollAfter: undefined } };

describe('a check against a meta with no polling interval', () => {
  it('installs the release', async () => {
    const w = makeWorld({ release: makeRelease(NO_INTERVAL) });

    const result = await w.run();

    expect(result.outcome).toBe('activated');
  });

  it('is due again after 60 seconds and not before', async () => {
    const w = makeWorld({ release: makeRelease(NO_INTERVAL) });
    await w.run();

    w.clock.advance(59);
    expect((await w.run()).outcome).toBe('notDue');
    expect(w.server.count('meta')).toBe(1);

    w.clock.advance(1);
    expect((await w.run()).outcome).toBe('noChange');
    expect(w.server.count('meta')).toBe(2);
  });
});

describe('a pollAfter the server still sends', () => {
  it('does not stretch the wait between checks', async () => {
    const w = makeWorld({ release: makeRelease({ pollAfter: 86400 }) });
    await w.run();

    w.clock.advance(60);
    await w.run();

    expect(w.server.count('meta')).toBe(2);
  });

  it('is not sent back as pollSeconds', async () => {
    const w = makeWorld({ release: makeRelease({ pollAfter: 900 }) });
    await w.run();

    w.clock.advance(60);
    await w.run();

    expect(w.server.metaQuery()).not.toHaveProperty('pollSeconds');
  });
});

describe('a failed check', () => {
  it.each([
    ['a 5xx', () => respond(500, 'no')],
    ['a network failure', () => new Error('offline')],
  ])('after %s keeps what is held and is due again after 60 seconds, however many times it fails', async (_label, answer) => {
    const w = makeWorld();
    await w.run();
    const held = (await w.state()).active?.checksum;
    w.server.on('meta', answer);

    for (let failures = 1; failures <= 6; failures++) {
      w.clock.advance(60);
      expect((await w.run()).outcome).toBe('failed');
      expect(w.server.count('meta')).toBe(1 + failures);
      expect((await w.state()).active?.checksum).toBe(held);
    }
    w.clock.advance(59);
    expect((await w.run()).outcome).toBe('notDue');
  });

  it('after a 429 waits as long as Retry-After says', async () => {
    const w = makeWorld();
    await w.run();
    w.server.on('meta', () => respond(429, 'slow', { headers: { 'Retry-After': '300' } }), { times: 1 });
    w.clock.advance(60);
    await w.run();

    w.clock.advance(299);
    expect((await w.run()).outcome).toBe('notDue');

    w.clock.advance(1);
    expect((await w.run()).outcome).toBe('noChange');
  });
});

describe('answers that mean there is nothing to fetch', () => {
  it('waits only the 60 second floor after a stage with nothing for this version', async () => {
    const w = makeWorld();
    w.server.on('meta', () => problem(404, 'delivery.stage_unreleased', { appVersion: '1.4.0' }), { times: 1 });
    await w.run();

    w.clock.advance(60);
    await w.run();

    expect(w.server.count('meta')).toBe(2);
  });
});
