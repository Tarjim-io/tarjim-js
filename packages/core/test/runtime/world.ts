import { createRuntime } from '../../src/index.js';
import { MemoryStore, storeId } from '../../src/internal.js';
import type { Platform, Slice, Store, Tarjim, TarjimConfig, TarjimReport } from '../../src/index.js';
import type { Install, State } from '../../src/internal.js';
import { makeClock, makeRelease, makeServer } from '../helpers/cycle-world.js';
import type { Clock, ReleaseSpec, Server } from '../helpers/cycle-world.js';
import { API_KEY, DELIVERY_URL } from '../support.js';
import type { Release } from '../support.js';

export { API_KEY, DELIVERY_URL };

export const DAY_MS = 86_400_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until the condition holds; fails the test (with the caller's line) after about 800 ms. */
// Bounded by real time, not by a count of polls: under a busy full-suite run each poll takes far longer than its sleep.
export async function until(condition: () => boolean | Promise<boolean>, what = 'the condition', ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Lets already-started work run to the end, for tests that assert something did not happen. */
export const settle = (ms = 40) => sleep(ms);

/** Resolves with the promise's value, or fails when it is still pending after `ms` of real time. */
export async function within<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** True while the promise has not settled after a short real wait. */
export async function stillPending(promise: Promise<unknown>, ms = 40): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([promise.then(() => 'settled', () => 'settled'), sleep(ms).then(() => marker)]);
  return winner === marker;
}

/**
 * A store that looks durable to the runtime (it is not a MemoryStore) while keeping everything in
 * memory, with a way to make a held slice unreadable.
 */
export class DurableStore implements Store {
  readonly hidden = new Set<string>();
  constructor(readonly inner: MemoryStore) {}
  get id() {
    return this.inner.id;
  }
  get degraded() {
    return this.inner.degraded;
  }
  withLock<T>(fn: () => Promise<T>) {
    return this.inner.withLock(fn);
  }
  readState() {
    return this.inner.readState();
  }
  updateState(change: (state: State) => State) {
    return this.inner.updateState(change);
  }
  putSlice(hash: string, bytes: Uint8Array) {
    return this.inner.putSlice(hash, bytes);
  }
  async readSlices(hashes: string[]) {
    const held = await this.inner.readSlices(hashes);
    for (const hash of this.hidden) held.delete(hash);
    return held;
  }
  writeInstall(install: Install, as: 'active' | 'pending') {
    return this.inner.writeInstall(install, as);
  }
  cleanup() {
    return this.inner.cleanup();
  }
  close() {}
}

export function fakeTimers(clock: Clock) {
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 0;
  const timers = {
    set(callback: () => void, delayMs: number) {
      const handle = ++next;
      pending.set(handle, { at: clock.now() + delayMs, callback });
      return handle;
    },
    clear(handle: unknown) {
      pending.delete(handle as number);
    },
    get count() {
      return pending.size;
    },
    /** Moves the clock forward and runs what fell due, oldest first. */
    async advance(ms: number) {
      clock.set(clock.now() + ms);
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= clock.now()).sort((a, b) => a[1].at - b[1].at);
      for (const [handle, timer] of due) {
        if (!pending.delete(handle)) continue;
        timer.callback();
      }
      await settle(20);
    },
  };
  return timers;
}
export type FakeTimers = ReturnType<typeof fakeTimers>;

export function fakeVisibility(initial = true) {
  let visible = initial;
  const listeners = new Set<() => void>();
  return {
    visible: () => visible,
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get listenerCount() {
      return listeners.size;
    },
    set(value: boolean) {
      visible = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

export interface Logged {
  level: string;
  message: string;
  details?: Record<string, string | number> | undefined;
}

export interface WorldOptions {
  release?: ReleaseSpec;
  /** Reuse the store of an earlier world, as a reloaded page would. */
  store?: Store;
  /** A plain MemoryStore, which the runtime must not treat as stable. */
  memoryOnly?: boolean;
  degraded?: boolean;
  /** No timers and no visibility: the platform of Node. */
  node?: boolean;
  secureContext?: boolean;
  languages?: string[];
  osVersion?: string | undefined;
  hidden?: boolean;
}

let worlds = 0;

/** One page's worth of environment around `createRuntime`; `start` can be called again for the next page load. */
export function makeWorld(options: WorldOptions = {}) {
  const server: Server = makeServer(makeRelease(options.release));
  const clock = makeClock();
  const timers = fakeTimers(clock);
  const visibility = fakeVisibility(!options.hidden);
  const logs: Logged[] = [];
  const reports: TarjimReport[] = [];
  const fetched: string[] = [];
  const past: Release[] = [];
  const opened: Array<[string, string]> = [];
  let ids = 0;

  const durable = new DurableStore(new MemoryStore(`runtime-store-${++worlds}`));
  const store: Store =
    options.store ??
    (options.degraded
      ? new MemoryStore(`runtime-degraded-${worlds}`, { degraded: true })
      : options.memoryOnly
        ? new MemoryStore(`runtime-memory-${worlds}`)
        : durable);

  const platform = (overrides: Partial<Platform> = {}): Platform => ({
    name: 'web',
    secureContext: options.secureContext ?? true,
    fetch: async (input, init) => {
      fetched.push(input);
      const answer = await server.fetch(input, init);
      if (answer.ok || !input.includes('/slices/')) return answer;
      // A CDN keeps the files of earlier releases.
      for (const old of past) {
        const earlier = await old.fetch(input, init);
        if (earlier.ok) return earlier;
      }
      return answer;
    },
    async openStore(deliveryUrl, apiKey) {
      opened.push([deliveryUrl, apiKey]);
      return options.degraded ? { store, degradedReason: 'unavailable' } : { store };
    },
    browserLanguages: () => options.languages ?? ['en'],
    ...(options.osVersion === undefined ? {} : { osVersion: () => options.osVersion }),
    ...(options.node ? {} : { timers, visibility }),
    now: clock.now,
    random: () => 0,
    randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    log: (level, message, details) => void logs.push({ level, message, details }),
    ...overrides,
  });

  const config = (overrides: Record<string, unknown> = {}): TarjimConfig => ({
    deliveryUrl: DELIVERY_URL,
    apiKey: API_KEY,
    appVersion: '1.4.0',
    defaultBundle: { type: 'namespace', name: 'b1' },
    fallbackLanguage: 'en',
    embedded: [embedded('en'), embedded('fr')],
    onReport: (report) => void reports.push(report),
    ...overrides,
  } as TarjimConfig);

  const running: Tarjim[] = [];
  const world = {
    server,
    clock,
    timers,
    visibility,
    logs,
    reports,
    fetched,
    opened,
    store,
    platform,
    config,
    codes: () => reports.map((report) => report.code),
    reportsOf: (code: string) => reports.filter((report) => report.code === code),
    state: () => store.readState(),
    /** Starts a runtime; every one started here is stopped by `stopAll`. */
    async start(configOverrides: Record<string, unknown> = {}, platformOverrides: Partial<Platform> = {}): Promise<Tarjim> {
      const runtime = await createRuntime(config(configOverrides), platform(platformOverrides));
      running.push(runtime);
      return runtime;
    },
    /** Starts and waits for the first release to be the text that answers. */
    async startActive(configOverrides: Record<string, unknown> = {}): Promise<Tarjim> {
      const runtime = await world.start(configOverrides);
      await until(() => !runtime.t('a').startsWith('embedded') && runtime.t('a') !== 'a', 'the first release');
      return runtime;
    },
    stopAll() {
      for (const runtime of running.splice(0)) runtime.stop();
    },
    metaCount: () => server.count('meta'),
    storeIdValue: () => storeId(DELIVERY_URL, API_KEY),
    /** Makes the next check go to a different release. */
    release(spec: ReleaseSpec) {
      past.push(server.current);
      server.use(makeRelease(spec));
    },
  };
  return world;
}
export type World = ReturnType<typeof makeWorld>;

/** An embedded slice for the default bundle: key `a` and key `e`. */
export function embedded(locale: string, extra: Record<string, unknown> = {}): Slice {
  return {
    schemaVersion: 1,
    bundle: 'embedded',
    locale,
    keys: {
      a: { id: '901', value: `embedded a ${locale}`.replace(/ en$/, ''), tags: [] },
      e: { id: '902', value: `embedded e ${locale}`.replace(/ en$/, ''), tags: [] },
      ...extra,
    },
  } as unknown as Slice;
}
