import { describe, expect, it } from 'vitest';
import {
  clientFor,
  controlledStream,
  jsonFiles,
  respond,
  simpleRelease,
  sleep,
} from './support.js';

const MIB = 1024 * 1024;

/** A body that never ends: it hands out a chunk every few milliseconds until it is cancelled. */
function endlessBody(chunk = 1024) {
  const state = { produced: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await sleep(2);
      state.produced += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(120));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, response: () => new Response(body, { status: 200 }) };
}

describe('how much of a body is read', () => {
  it('stops a slice as soon as it passes its listed size, and cancels the stream', async () => {
    const release = simpleRelease();
    const files = jsonFiles(release);
    const endless = endlessBody();
    release.hook(({ kind }) => (kind === 'object' ? endless.response() : undefined));

    const started = Date.now();
    const { results } = await clientFor(release.fetch).fetchSlices(release.meta, files.slice(0, 1));

    expect([...results.values()]).toEqual([{ kind: 'sizeMismatch' }]);
    expect(endless.state.cancelled).toBe(true);
    expect(endless.state.produced).toBeLessThan(files[0]!.size + 8192);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('stops a meta body at one MiB, and cancels the stream', async () => {
    const endless = endlessBody(16 * 1024);
    const outcome = await clientFor(async () => endless.response(), { timeoutMs: 5000 }).fetchMeta({});

    expect(outcome).toEqual({ kind: 'unreadable' });
    expect(endless.state.cancelled).toBe(true);
    expect(endless.state.produced).toBeLessThan(MIB + 32 * 1024);
  });

  it('reads a meta just under one MiB and refuses one just over it', async () => {
    const meta = simpleRelease().meta;
    const padded = (size: number) => JSON.stringify({ ...meta, pad: 'x'.repeat(size - JSON.stringify(meta).length - 9) });

    const under = await clientFor(async () => respond(200, padded(MIB))).fetchMeta({});
    const over = await clientFor(async () => respond(200, padded(MIB + 1))).fetchMeta({});

    expect(under.kind).toBe('received');
    expect(over).toEqual({ kind: 'unreadable' });
  });

  it('stops a manifest body at eight MiB, and cancels the stream', async () => {
    const release = simpleRelease();
    const endless = endlessBody(256 * 1024);
    release.hook(({ kind }) => (kind === 'manifest' ? endless.response() : undefined));

    const outcome = await clientFor(release.fetch, { timeoutMs: 5000 }).fetchManifest(release.meta);

    expect(outcome).toEqual({ kind: 'unreadable' });
    expect(endless.state.cancelled).toBe(true);
    expect(endless.state.produced).toBeLessThan(8 * MIB + 512 * 1024);
  }, 8000);

  it('refuses a manifest that is one byte over eight MiB without checking its hash', async () => {
    const release = simpleRelease();
    release.hook(({ kind }) => (kind === 'manifest' ? respond(200, new Uint8Array(8 * MIB + 1).fill(120)) : undefined));

    expect(await clientFor(release.fetch).fetchManifest(release.meta)).toEqual({ kind: 'unreadable' });
  });
});

describe('a body that stalls mid-stream', () => {
  function stalling(kind: string) {
    const release = simpleRelease();
    release.hook(({ kind: seen, init }) => {
      if (seen !== kind) return undefined;
      const stream = controlledStream();
      init?.signal?.addEventListener('abort', () => stream.fail(new DOMException('aborted', 'AbortError')));
      stream.push('{"schemaVer');
      return stream.response;
    });
    return release;
  }

  it('is network for a manifest', async () => {
    const release = stalling('manifest');
    const outcome = await clientFor(release.fetch, { timeoutMs: 60 }).fetchManifest(release.meta);

    expect(outcome).toEqual({ kind: 'network' });
  });

  it('is network for a slice', async () => {
    const release = stalling('object');
    const files = jsonFiles(release);
    const { results } = await clientFor(release.fetch, { timeoutMs: 60 }).fetchSlices(release.meta, files.slice(0, 1));

    expect([...results.values()]).toEqual([{ kind: 'network' }]);
  });
});
