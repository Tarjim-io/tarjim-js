import { dueAt } from './cadence.js';
import { fetchHeldLocale, runCycle } from './cycle.js';
import type { CycleContext, CycleOutcome, CycleReason, CycleResult } from './cycle.js';
import { createDeliveryClient } from './delivery-client.js';
import { deliveryUrlProblem } from './delivery-url.js';
import { normaliseAppVersion } from './app-version.js';
import { isRecord } from './json.js';
import { matchLocale, selectLocale } from './locale.js';
import { createSnapshot } from './resolver.js';
import type { BundleRef, FormatArgs, LookupOptions, Snapshot, TarjimEntry } from './resolver.js';
import { createScheduler } from './scheduler.js';
import type { Scheduler, Timers, Visibility } from './scheduler.js';
import type { Slice } from './slice.js';
import { parseSlot, slotName } from './store.js';
import type { Install, State, Store } from './store.js';
import type { FetchFunction } from './types.js';
import { SDK_VERSION } from './version.js';

export interface TarjimConfig {
  deliveryUrl: string;
  apiKey: string;
  appVersion: string;
  defaultBundle: BundleRef;
  fallbackLanguage: string;
  language?: string;
  /** Save a language chosen with setLanguage even when `language` was passed. */
  persistLanguage?: boolean;
  embedded?: Slice[];
  /** Milliseconds start() may wait for the first downloaded release. */
  waitForContent?: number;
  /** Throw on a bad configuration instead of serving only the embedded text. */
  strict?: boolean;
  analytics?: { installId?: boolean };
  legacyPercentPlaceholders?: boolean;
  onReport?: (report: TarjimReport) => void;
  /** Log reports at info level instead of debug. */
  debug?: boolean;
  fetch?: FetchFunction;
}

export interface TarjimReport {
  code: string;
  message: string;
  details?: Record<string, string | number>;
}

export type TarjimEventType = 'downloaded' | 'activated' | 'languageChanged';
export interface TarjimEvent {
  type: TarjimEventType;
}

export type CheckResult = 'noChange' | 'downloaded' | 'notDue' | 'failed';

export interface Tarjim {
  readonly language: string;
  /** True once the local text (held or embedded) is ready to read. */
  readonly ready: boolean;
  t(key: string, args?: FormatArgs, options?: LookupOptions): string;
  tArray(key: string, options?: LookupOptions): string[];
  entry(key: string, options?: LookupOptions): TarjimEntry | null;
  setLanguage(language: string): Promise<void>;
  checkNow(): Promise<CheckResult>;
  activatePendingUpdate(): boolean;
  setInstallId(enabled: boolean): Promise<void>;
  /** Calls the listener on every event; returns a function that removes it. */
  on(type: TarjimEventType, listener: (event: TarjimEvent) => void): () => void;
  updates(): AsyncIterableIterator<TarjimEvent>;
  /** For useSyncExternalStore: the listener runs whenever the text a lookup returns may have changed. */
  subscribe(listener: () => void): () => void;
  /** Changes identity whenever subscribe's listeners are called. */
  getVersion(): number;
  stop(): void;
}

export class TarjimConfigError extends Error {}
export class TarjimLanguageError extends Error {}

/** What the runtime needs from its environment; @tarjim/browser supplies the browser's. */
export interface Platform {
  name: string;
  fetch?: FetchFunction;
  secureContext: boolean;
  openStore(deliveryUrl: string, apiKey: string): Promise<{ store: Store; degradedReason?: string }>;
  browserLanguages(): readonly string[];
  osVersion?(): string | undefined;
  /** Absent in Node: no scheduler runs and only checkNow() checks. */
  timers?: Timers;
  visibility?: Visibility;
  now(): number;
  random(): number;
  randomId(): string;
  log(level: 'debug' | 'info', message: string, details?: Record<string, string | number>): void;
}

type Details = Record<string, string | number>;

interface Served {
  snapshot: Snapshot;
  /** Names the locale and the files behind it, so an unchanged text is not announced as a change. */
  sig: string;
  /** Slots whose file could not be read back. */
  missing: string[];
}

const DAY_MS = 86_400_000;
const NO_BUNDLE: BundleRef = { type: 'namespace', name: '' };
// Server codes look like `delivery.forbidden`; anything else from a server is not copied into a report.
const CODE = /^[\w.-]{1,64}$/;

const MESSAGES: Record<string, string> = {
  'insecure-context': 'Downloads need a secure context; only the embedded text is served.',
  'storage-unavailable': 'Storage is unavailable; only the embedded text is served.',
  'embedded-invalid': 'embedded must be an array of slices; it was ignored.',
  'app-version-normalised': 'appVersion was reduced to a plain major.minor.patch version.',
  'unbound-key': 'The key is bound to no release; only the embedded text is served.',
  configuration: 'The delivery server refused the request; check the delivery URL and the key.',
  'meta-schema': 'The delivery server uses a newer format than this SDK reads; the held text is kept.',
  'manifest-schema': 'A release uses a newer manifest format than this SDK reads; it was not installed.',
  'manifest-integrity': 'A manifest did not match its checksum and was rejected.',
  'manifest-unreadable': 'A manifest could not be read.',
  'slice-integrity': 'A slice did not match its hash and was not used.',
  'slice-schema': 'A slice uses a newer format than this SDK reads; it was not used.',
  storage: 'Writing to storage failed.',
  'attribute-dropped': 'Attributes outside the allowed list were dropped from an entry.',
  'media-url-rejected': 'A media URL that is not https was rejected.',
};

const RESULT: Record<CycleOutcome, CheckResult> = {
  busy: 'notDue',
  notDue: 'notDue',
  noChange: 'noChange',
  downloaded: 'downloaded',
  // The text that arrived is already showing, but the caller asked for news and this is it.
  activated: 'downloaded',
  failed: 'failed',
  unbound: 'failed',
};

const safe = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // A listener's own error is not the runtime's.
  }
};

/** Never rejects for a condition it can degrade from, unless `strict` is set. */
export async function createRuntime(config: TarjimConfig, platform: Platform): Promise<Tarjim> {
  const { deliveryUrl, apiKey, defaultBundle, fallbackLanguage } = config;
  const now = (): number => platform.now();
  const bundleOk =
    isRecord(defaultBundle) && (defaultBundle.type === 'namespace' || defaultBundle.type === 'custom') && typeof defaultBundle.name === 'string';
  const problem =
    deliveryUrlProblem(deliveryUrl) ??
    (apiKey && typeof apiKey === 'string' ? null : 'apiKey is required') ??
    (bundleOk ? null : 'defaultBundle needs a type and a name') ??
    (fallbackLanguage && typeof fallbackLanguage === 'string' ? null : 'fallbackLanguage is required');
  if (problem !== null && config.strict) throw new TarjimConfigError(problem);

  let offline = problem !== null ? 'invalid-configuration' : platform.secureContext ? undefined : 'insecure-context';
  let opened: Store | undefined;
  if (offline === undefined) {
    try {
      const attempt = await platform.openStore(deliveryUrl, apiKey);
      if (attempt.degradedReason === undefined && !attempt.store.degraded) opened = attempt.store;
      else attempt.store.close();
    } catch {
      // Treated like storage that cannot be used.
    }
    if (opened === undefined) offline = 'storage-unavailable';
  }
  const store = opened;

  const reportedToday: Record<string, number> = {};
  async function report(code: string, details?: Details, message: string = MESSAGES[code] ?? code): Promise<void> {
    try {
      const identity = [code, ...Object.values(details ?? {})].join(':');
      const today = Math.floor(now() / DAY_MS);
      let fresh = reportedToday[identity] !== today;
      reportedToday[identity] = today;
      if (fresh && store) {
        await store.updateState((state) => {
          fresh = state.reported?.[identity] !== today;
          const kept = Object.entries(state.reported ?? {}).filter(([, day]) => day === today);
          return fresh ? { ...state, reported: { ...Object.fromEntries(kept), [identity]: today } } : state;
        });
      }
      if (!fresh) return;
      platform.log(config.debug ? 'info' : 'debug', message, details);
      config.onReport?.({ code, message, ...(details ? { details } : {}) });
    } catch {
      // A failing log or callback must not reach the lookup that triggered the report.
    }
  }

  if (offline !== undefined) await report(offline, undefined, problem ?? undefined);
  const embedded = (Array.isArray(config.embedded) ? config.embedded : []).filter(isRecord) as Slice[];
  if (config.embedded !== undefined && !Array.isArray(config.embedded)) await report('embedded-invalid');
  const appVersion = normaliseAppVersion(config.appVersion);
  if (appVersion !== config.appVersion) await report('app-version-normalised', { from: String(config.appVersion).slice(0, 32), to: appVersion });

  let state: State = {};
  let previous: Install | undefined;
  if (store) {
    state = await store.readState();
    if (state.sdkVersion !== SDK_VERSION) {
      state = await store.updateState((current) => {
        const next = { ...current, sdkVersion: SDK_VERSION };
        delete next.rejectedChecksums;
        return next;
      });
    }
    const pending = state.pending;
    if (pending && (await store.withLock(() => store.writeInstall(pending, 'active'))) === true) {
      previous = state.active;
      state = await store.readState();
    }
  }

  let activeInstall = state.active;
  const localesOf = (install: Install | undefined): string[] => [
    ...Object.values(install?.manifest.slices ?? {}).flatMap((files) => Object.keys(files)),
    ...embedded.map((slice) => slice.locale).filter((locale) => typeof locale === 'string'),
  ];
  const bundle = isRecord(defaultBundle) ? defaultBundle : NO_BUNDLE;

  async function load(install: Install | undefined, locale: string, fallback?: Install): Promise<Served> {
    const slots: Record<string, string> = {};
    const bytes = new Map<string, Uint8Array>();
    const missing: string[] = [];
    if (install && store) {
      const mine = Object.entries(install.slots).filter(([slot]) => parseSlot(slot)?.locale === locale);
      const held = await store.readSlices(mine.flatMap(([slot, hash]) => [hash, fallback?.slots[slot] ?? hash]));
      for (const [slot, hash] of mine) {
        // A file that cannot be read back is served from the install it replaces, and owed.
        const use = [hash, fallback?.slots[slot]].find((candidate) => candidate !== undefined && held.has(candidate));
        if (use !== hash) missing.push(slot);
        if (use !== undefined) {
          slots[slot] = use;
          bytes.set(use, held.get(use)!);
        }
      }
    }
    const snapshot = createSnapshot({
      ...(install ? { install: { ...install, slots } } : {}),
      slices: bytes,
      embedded,
      locale,
      defaultBundle: bundle,
      legacyPercentPlaceholders: config.legacyPercentPlaceholders === true,
      report: ({ code, details }) => void report(code, details as Details | undefined),
    });
    return { snapshot, sig: [locale, ...Object.values(slots).sort()].join(), missing };
  }

  const explicit = typeof config.language === 'string' && config.language ? { explicit: config.language } : {};
  const saved = state.languageOverride === undefined ? {} : { saved: state.languageOverride };
  let target = selectLocale({
    ...explicit,
    ...saved,
    browser: platform.browserLanguages(),
    fallback: typeof fallbackLanguage === 'string' ? fallbackLanguage : '',
    universe: localesOf(activeInstall),
    manifestHeld: activeInstall !== undefined,
  }).locale;
  let current = await load(activeInstall, target, previous);
  if (store && activeInstall && current.missing.length) {
    const { checksum } = activeInstall;
    const owed = current.missing;
    await store.withLock(() =>
      store.updateState((s) =>
        s.active?.checksum === checksum ? { ...s, active: { ...s.active, owed: [...new Set([...s.active.owed, ...owed])] } } : s,
      ),
    );
  }

  const handlers = new Set<(event: TarjimEvent) => void>();
  const subscribers = new Set<() => void>();
  const emit = (type: TarjimEventType): void => {
    for (const handler of [...handlers]) safe(() => handler({ type }));
  };
  let version = 0;
  const bind = (): Pick<Tarjim, 't' | 'tArray' | 'entry'> => ({
    t: (key, args, options) => current.snapshot.t(key, args, options),
    tArray: (key, options) => current.snapshot.tArray(key, options),
    entry: (key, options) => current.snapshot.entry(key, options),
  });
  let lookups = bind();
  function swap(next: Served): boolean {
    if (next.sig === current.sig) return false;
    current = next;
    version += 1;
    lookups = bind();
    for (const subscriber of [...subscribers]) safe(subscriber);
    return true;
  }

  let prepared: { install: Install; served: Served } | undefined;
  async function prepare(install: Install | undefined): Promise<void> {
    prepared = install && { install, served: await load(install, current.snapshot.language, activeInstall) };
  }

  let analytics = config.analytics?.installId !== false;
  let installId = state.installId;
  const osVersion = platform.osVersion?.();
  // One value per poll, so the scheduler and the cycle agree on when the next check is due.
  let jitter = platform.random();
  const send = config.fetch ?? platform.fetch;
  let live: CycleContext | undefined =
    store && send
      ? {
          store,
          client: createDeliveryClient({ deliveryUrl, apiKey, appVersion: config.appVersion, platform: platform.name, fetch: send }),
          sdkVersion: SDK_VERSION,
          now,
          random: () => jitter,
          locale: () => target,
          identity: () => ({
            ...(analytics && installId ? { installId } : {}),
            ...(osVersion === undefined ? {} : { osVersion }),
          }),
        }
      : undefined;

  let scheduler: Scheduler | undefined;
  let firstDone = (): void => undefined;

  async function reportAll(result: CycleResult): Promise<void> {
    for (const { code, ...rest } of result.conditions) {
      const details = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => typeof value === 'number' || (typeof value === 'string' && CODE.test(value))),
      ) as Details;
      await report(
        code === 'unbound' ? 'unbound-key' : code.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        Object.keys(details).length ? details : undefined,
      );
    }
  }

  async function apply(result: CycleResult): Promise<void> {
    const { outcome, active, install } = result;
    await reportAll(result);
    if (outcome === 'unbound') {
      scheduler?.stop();
      live = undefined;
      prepared = undefined;
      activeInstall = undefined;
      swap(await load(undefined, current.snapshot.language));
    } else {
      if (active) {
        activeInstall = active;
        if (swap(await load(active, current.snapshot.language)) && outcome === 'activated') emit('activated');
      }
      if (outcome === 'downloaded' && install) {
        await prepare(install);
        emit('downloaded');
      }
    }
    if (analytics && !installId && store && store.durable !== false && outcome !== 'busy' && outcome !== 'notDue') {
      installId = (await store.updateState((s) => (s.installId ? s : { ...s, installId: platform.randomId() }))).installId;
    }
  }

  async function run(reason: CycleReason): Promise<CheckResult> {
    const cycle = live;
    if (!cycle) return 'failed';
    try {
      const result = await runCycle(cycle, reason);
      await apply(result);
      if (result.outcome !== 'failed' && result.outcome !== 'busy') firstDone();
      return RESULT[result.outcome];
    } catch {
      return 'failed';
    } finally {
      jitter = platform.random();
    }
  }

  const { timers, visibility } = platform;
  if (live && store && timers) {
    scheduler = createScheduler({
      check: () => run('scheduled'),
      nextDueAt: async () => dueAt(await store.readState(), now(), jitter),
      now,
      timers,
      ...(visibility ? { visibility } : {}),
    });
  }
  const wait = Number(config.waitForContent);
  const gate =
    scheduler && timers && wait > 0 && !activeInstall
      ? new Promise<void>((resolve) => {
          const handle = timers.set(resolve, wait);
          firstDone = () => {
            timers.clear(handle);
            resolve();
          };
        })
      : undefined;
  scheduler?.start();
  await gate;

  const persist = config.persistLanguage ?? config.language === undefined;
  const lacks = (install: Install | undefined, locale: string): boolean =>
    Object.entries(install?.manifest.slices ?? {}).some(
      ([id, files]) => Object.keys(files).includes(locale) && install?.slots[slotName(id, locale)] === undefined,
    );

  return {
    get language() {
      return current.snapshot.language;
    },
    ready: true,
    get t() {
      return lookups.t;
    },
    get tArray() {
      return lookups.tArray;
    },
    get entry() {
      return lookups.entry;
    },

    async setLanguage(language) {
      const match = typeof language === 'string' ? matchLocale(language, localesOf(activeInstall)) : null;
      if (match === null) throw new TarjimLanguageError('There is no text for that language.');
      if (match === current.snapshot.language) return;
      const before = target;
      target = match;
      try {
        const cycle = live;
        if (cycle && store) {
          const result = await fetchHeldLocale(cycle);
          await reportAll(result);
          state = await store.readState();
          if (result.outcome === 'failed' || lacks(state.pending ?? state.active, match)) throw new Error('The text for that language could not be downloaded.');
          activeInstall = state.active;
        }
        const next = await load(activeInstall, match);
        if (store && persist) await store.updateState((s) => ({ ...s, languageOverride: match }));
        swap(next);
        await prepare(state.pending);
        emit('languageChanged');
      } catch (error) {
        target = before;
        throw error;
      }
    },

    checkNow: () => run('checkNow'),

    activatePendingUpdate() {
      const next = prepared;
      if (!next || !store) return false;
      prepared = undefined;
      activeInstall = next.install;
      void store.withLock(() => store.writeInstall(next.install, 'active')).catch(() => undefined);
      if (swap(next.served)) emit('activated');
      return true;
    },

    async setInstallId(enabled) {
      analytics = enabled;
      if (enabled || !store) return;
      installId = undefined;
      await store.updateState((s) => {
        const next = { ...s };
        delete next.installId;
        return next;
      });
    },

    on(type, listener) {
      const handler = (event: TarjimEvent): void => {
        if (event.type === type) listener(event);
      };
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },

    updates() {
      const queue: TarjimEvent[] = [];
      let wake = (): void => undefined;
      const feed = (event: TarjimEvent): void => {
        queue.push(event);
        wake();
      };
      handlers.add(feed);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          while (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
          return { done: false, value: queue.shift()! };
        },
        async return() {
          handlers.delete(feed);
          return { done: true, value: undefined };
        },
      };
    },

    subscribe(listener) {
      subscribers.add(listener);
      return () => void subscribers.delete(listener);
    },
    getVersion: () => version,
    stop: () => scheduler?.stop(),
  };
}
