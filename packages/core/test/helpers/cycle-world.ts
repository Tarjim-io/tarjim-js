import { MemoryStore, runCycle } from '../../src/index.js';
import type { CycleContext, CycleReason, Store } from '../../src/index.js';
import { DELIVERY_URL, clientFor, queryOf, simpleRelease } from '../support.js';
import type { Release, ReleaseOptions } from '../support.js';

export const START = 1_700_000_000_000;

export interface ReleaseSpec {
  /** bundle id → a tag that ends up in the slice text; a different tag is a different hash. */
  content?: Record<string, string>;
  locales?: string[];
  releaseId?: number;
  pollAfter?: number;
  metaOverrides?: Record<string, unknown>;
  manifestOverrides?: Record<string, unknown>;
  tamper?: ReleaseOptions['tamper'];
}

/** A CDN release with real hashes. The same spec always builds the same checksum. */
export function makeRelease(spec: ReleaseSpec = {}): Release {
  const content = spec.content ?? { b1: 'v1' };
  const locales = spec.locales ?? ['en', 'fr'];
  const bundles = Object.fromEntries(Object.keys(content).map((id) => [id, { type: 'namespace', name: id }]));
  const slices = Object.fromEntries(
    Object.entries(content).map(([id, tag]) => [
      id,
      Object.fromEntries(
        locales.map((locale) => [locale, { schemaVersion: 1, keys: { a: { id: '1', value: `${tag} ${id} ${locale}`, tags: [] } } }]),
      ),
    ]),
  );
  const options: ReleaseOptions = {
    bundles,
    slices,
    metaOverrides: { releaseId: spec.releaseId ?? 1, pollAfter: spec.pollAfter ?? 900, ...spec.metaOverrides },
  };
  if (spec.manifestOverrides) options.manifestOverrides = spec.manifestOverrides;
  if (spec.tamper) options.tamper = spec.tamper;
  return simpleRelease(options);
}

export const hashOf = (release: Release, bundle: string, locale: string): string => release.manifest.slices[bundle]![locale]!.json.hash;

export type Kind = 'meta' | 'manifest' | 'object';
export interface Logged {
  kind: Kind;
  url: string;
  /** For an object, its file name (`<hash>.json`). */
  name: string;
}
type Answer = Response | Error | undefined;
interface Rule {
  match(request: Logged): boolean;
  answer(request: Logged): Answer | Promise<Answer>;
  left: number;
}
export interface RuleOptions {
  /** Only objects whose file name contains this. */
  name?: string;
  urlIncludes?: string;
  times?: number;
}

/** One fetch in front of whichever release is current, so a test can move the meta from release to release. */
export function makeServer(initial: Release) {
  let current = initial;
  const log: Logged[] = [];
  const rules: Rule[] = [];

  const classify = (url: string): Logged => {
    const bare = url.split('?')[0]!;
    if (bare === DELIVERY_URL) return { kind: 'meta', url, name: 'meta' };
    if (bare.endsWith('manifest.json')) return { kind: 'manifest', url, name: 'manifest' };
    return { kind: 'object', url, name: bare.slice(bare.lastIndexOf('/') + 1) };
  };

  async function fetch(input: string, init: RequestInit): Promise<Response> {
    const request = classify(String(input));
    log.push(request);
    for (const rule of rules) {
      if (rule.left <= 0 || !rule.match(request)) continue;
      rule.left -= 1;
      const answer = await rule.answer(request);
      if (answer instanceof Error) throw answer;
      if (answer) return answer;
    }
    return current.fetch(input, init);
  }

  const server = {
    fetch,
    log,
    get current() {
      return current;
    },
    use(release: Release) {
      current = release;
    },
    on(kind: Kind, answer: () => Answer | Promise<Answer>, options: RuleOptions = {}) {
      rules.push({
        match: (request) =>
          request.kind === kind &&
          (options.name === undefined || request.name.includes(options.name)) &&
          (options.urlIncludes === undefined || request.url.includes(options.urlIncludes)),
        answer,
        left: options.times ?? Infinity,
      });
    },
    /** Holds the next request of this kind until `release()`, then lets it through. */
    hold(kind: Kind) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      server.on(kind, async () => {
        await gate;
        return undefined;
      }, { times: 1 });
      return { release };
    },
    clearRules() {
      rules.length = 0;
    },
    requests(kind: Kind) {
      return log.filter((request) => request.kind === kind);
    },
    count(kind: Kind) {
      return log.filter((request) => request.kind === kind).length;
    },
    objectCount(hash: string) {
      return log.filter((request) => request.kind === 'object' && request.name === `${hash}.json`).length;
    },
    metaQuery(index = -1): Record<string, string> {
      const metas = log.filter((request) => request.kind === 'meta');
      return queryOf(metas[index < 0 ? metas.length + index : index]!.url);
    },
  };
  return server;
}
export type Server = ReturnType<typeof makeServer>;

export function makeClock(start = START) {
  let time = start;
  return {
    now: () => time,
    advance(seconds: number) {
      time += seconds * 1000;
    },
    set(ms: number) {
      time = ms;
    },
  };
}
export type Clock = ReturnType<typeof makeClock>;

export interface Selection {
  locale: string | undefined;
  random: number;
  identity: ReturnType<CycleContext['identity']>;
}

/** A context over a fresh client, as a reloaded page or another tab would build one. */
export function makeContext(server: Server, store: Store, clock: Clock, selection: Selection): CycleContext {
  return {
    store,
    client: clientFor(server.fetch),
    sdkVersion: '0.1.0',
    now: clock.now,
    random: () => selection.random,
    locale: () => selection.locale,
    identity: () => selection.identity,
  };
}

let storeCount = 0;

export function makeWorld(options: { release?: Release; store?: Store; locale?: string; random?: number } = {}) {
  const server = makeServer(options.release ?? makeRelease());
  const clock = makeClock();
  const store = options.store ?? new MemoryStore(`cycle-store-${++storeCount}`);
  const selection: Selection = { locale: options.locale ?? 'en', random: options.random ?? 0, identity: {} };
  const tab = () => makeContext(server, store, clock, selection);
  const ctx = tab();
  return {
    server,
    clock,
    store,
    selection,
    ctx,
    /** Another context over the same store and clock. */
    tab,
    run: (reason: CycleReason = 'scheduled') => runCycle(ctx, reason),
    state: () => store.readState(),
    /** Is a slice with this hash held and intact? */
    async holds(hash: string) {
      return (await store.readSlices([hash])).size === 1;
    },
  };
}
export type World = ReturnType<typeof makeWorld>;

/** Runs the first check against an empty store, then moves the clock past the poll interval. */
export async function installed(options: Parameters<typeof makeWorld>[0] = {}): Promise<World> {
  const world = makeWorld(options);
  await world.run();
  world.clock.advance(1000);
  return world;
}
