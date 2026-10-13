import { CHECK_NOW_FLOOR_SECONDS, MIN_POLL_SECONDS, backoffSeconds, clampPollAfter, clampRetryAfter, dueAt } from './cadence.js';
import { BUSY, composeSlots, slotName } from './store.js';
import type { Install, State, Store } from './store.js';
import type { DeliveryClient, Manifest, Meta, MetaIdentity, SliceFile } from './types.js';

export type CycleReason = 'scheduled' | 'checkNow';

export type CycleOutcome =
  | 'busy'
  | 'notDue'
  | 'noChange'
  | 'downloaded'
  | 'activated'
  | 'failed'
  | 'unbound';

/** Something the page owner may need to hear about; the caller decides whether and how often to report it. */
export type CycleCondition =
  | { code: 'unbound' }
  | { code: 'configuration'; status: number; problemCode?: string }
  | { code: 'metaSchema'; schemaVersion: unknown }
  | { code: 'manifestSchema'; schemaVersion: unknown }
  | { code: 'manifestIntegrity' }
  | { code: 'sliceIntegrity' }
  | { code: 'storage' };

export interface CycleResult {
  outcome: CycleOutcome;
  /** The install written by this cycle, if any. */
  install?: Install;
  conditions: CycleCondition[];
}

export interface CycleContext {
  store: Store;
  client: DeliveryClient;
  sdkVersion: string;
  now(): number;
  random(): number;
  /** The locale the visitor is served; undefined before one can be chosen. */
  locale(): string | undefined;
  /** Identity fields the cycle does not own (install id, OS version, app build). */
  identity(): Pick<MetaIdentity, 'installId' | 'osVersion' | 'appBuild'>;
}

const KNOWN_SCHEMA = 1;
const MAX_REJECTED = 16;

type Role = 'active' | 'pending';

const none = (): CycleResult => ({ outcome: 'noChange', conditions: [] });
const storageFailure = (): CycleResult => ({ outcome: 'failed', conditions: [{ code: 'storage' }] });
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

function lookup(manifest: Manifest, bundle: string, locale: string): SliceFile | undefined {
  const files = own(manifest.slices, bundle) ? manifest.slices[bundle] : undefined;
  return files && own(files, locale) ? files[locale] : undefined;
}

// The held install carries its own URLs and signature, so its slices can be fetched without reading meta.
function metaOf(install: Install): Meta {
  return {
    checksum: install.checksum,
    schemaVersion: KNOWN_SCHEMA,
    manifestUrl: install.manifestUrl,
    slicesBaseUrl: install.slicesBaseUrl,
    authenticated: install.authenticated,
    ...(install.signedQuery === undefined ? {} : { signedQuery: install.signedQuery }),
    track: '',
    releaseId: install.releaseId,
    pollAfter: 0,
  };
}

function identityOf(context: CycleContext, state: State): MetaIdentity {
  const language = context.locale();
  return {
    ...context.identity(),
    release: (state.pending ?? state.active)?.releaseId ?? 0,
    ...(state.lastPollAfter === undefined ? {} : { pollSeconds: state.lastPollAfter }),
    ...(language === undefined ? {} : { language }),
  };
}

/** Records a completed check, which also ends any backoff. */
function settle(context: CycleContext, pollAfter: number, edit?: (state: State) => void): Promise<State> {
  return context.store.updateState((state) => {
    const next: State = { ...state, lastCheck: context.now(), lastPollAfter: pollAfter };
    delete next.backoffStep;
    delete next.notBefore;
    edit?.(next);
    return next;
  });
}

// lastCheck is left alone so the retry falls due at notBefore rather than a whole poll interval later.
function backOff(context: CycleContext, retryAfter?: number): Promise<State> {
  return context.store.updateState((state) => {
    const step = state.backoffStep ?? 0;
    const wait = backoffSeconds(step, clampPollAfter(state.lastPollAfter), clampRetryAfter(retryAfter));
    return { ...state, backoffStep: step + 1, notBefore: context.now() + wait * 1000 };
  });
}

interface Acquired {
  /** slot → hash for every wanted slot that is now held and intact. */
  verified: Map<string, string>;
  /** The meta whose signature the downloads ended up using. */
  meta: Meta;
  integrity: boolean;
  storage: boolean;
  transient: boolean;
  retryAfter?: number;
}

async function acquire(context: CycleContext, wanted: Map<string, SliceFile>, meta: Meta, identity: MetaIdentity): Promise<Acquired> {
  const { store } = context;
  const got: Acquired = { verified: new Map(), meta, integrity: false, storage: false, transient: false };
  const held = await store.readSlices([...wanted.values()].map((file) => file.hash));
  const missing: [string, SliceFile][] = [];
  for (const [slot, file] of wanted) {
    if (held.has(file.hash)) got.verified.set(slot, file.hash);
    else missing.push([slot, file]);
  }
  if (!missing.length) return got;

  const fetched = await context.client.fetchSlices(meta, missing.map(([, file]) => file), identity);
  got.meta = fetched.meta;
  const stored = new Set<string>();
  for (const [slot, file] of missing) {
    const outcome = fetched.results.get(file.hash);
    if (outcome?.kind === 'verified') {
      if (!stored.has(file.hash)) {
        const put = await store.putSlice(file.hash, outcome.bytes);
        if (put !== 'stored' && put !== 'held') return { ...got, storage: true };
        stored.add(file.hash);
      }
      got.verified.set(slot, file.hash);
    } else if (outcome?.kind === 'hashMismatch' || outcome?.kind === 'sizeMismatch') {
      got.integrity = true;
    } else {
      got.transient = true;
      if (outcome && 'retryAfter' in outcome && outcome.retryAfter !== undefined) {
        got.retryAfter = Math.max(got.retryAfter ?? 0, outcome.retryAfter);
      }
    }
  }
  return got;
}

function build(
  context: CycleContext,
  from: Pick<Install, 'checksum' | 'releaseId' | 'manifest'>,
  previous: Install | undefined,
  names: string[],
  got: Acquired,
): Install {
  const { slots, owed } = composeSlots(previous, names, got.verified);
  const { meta } = got;
  return {
    checksum: from.checksum,
    releaseId: from.releaseId,
    manifest: from.manifest,
    slots,
    owed,
    manifestUrl: meta.manifestUrl,
    slicesBaseUrl: meta.slicesBaseUrl,
    authenticated: meta.authenticated === true,
    ...(meta.signedQuery === undefined ? {} : { signedQuery: meta.signedQuery }),
    sdkVersion: context.sdkVersion,
    installedAt: context.now(),
  };
}

async function commit(context: CycleContext, install: Install, role: Role): Promise<boolean> {
  if (!(await context.store.writeInstall(install, role))) return false;
  try {
    await context.store.cleanup();
  } catch {
    // Leftover slices are removed by the next install.
  }
  return true;
}

const installedOutcome = (role: Role): CycleOutcome => (role === 'active' ? 'activated' : 'downloaded');
const integrityConditions = (got: Acquired): CycleCondition[] => (got.integrity ? [{ code: 'sliceIntegrity' }] : []);

async function heldLocale(context: CycleContext): Promise<CycleResult> {
  const { store } = context;
  const state = await store.readState();
  const base = state.pending ?? state.active;
  const locale = context.locale();
  if (!base || locale === undefined) return none();
  const mark = `${base.checksum}\n${locale}`;
  if (state.localeFetched === mark || (state.notBefore ?? 0) > context.now()) return none();

  const wanted = new Map<string, SliceFile>();
  for (const bundle of Object.keys(base.manifest.slices)) {
    const file = lookup(base.manifest, bundle, locale);
    const slot = slotName(bundle, locale);
    // An owed slot belongs to the retry that a fresh meta triggers, which brings a fresh signature.
    if (file && base.slots[slot] === undefined && !base.owed.includes(slot)) wanted.set(slot, file);
  }
  if (!wanted.size) return none();

  const got = await acquire(context, wanted, metaOf(base), identityOf(context, state));
  if (got.storage) return storageFailure();
  const role: Role = state.pending ? 'pending' : 'active';
  let install: Install | undefined;
  if (got.verified.size) {
    const names = [...new Set([...Object.keys(base.slots), ...base.owed, ...wanted.keys()])];
    install = build(context, base, base, names, got);
    if (!(await commit(context, install, role))) return storageFailure();
  }
  // A transient failure leaves the mark unset so a later cycle tries again, after the backoff.
  if (got.transient) await backOff(context, got.retryAfter);
  else await store.updateState((current) => ({ ...current, localeFetched: mark }));

  const conditions = integrityConditions(got);
  if (install) return { outcome: installedOutcome(role), install, conditions };
  return { outcome: got.transient ? 'failed' : 'noChange', conditions };
}

async function retryOwed(
  context: CycleContext,
  known: Install,
  role: Role,
  meta: Meta,
  pollAfter: number,
  identity: MetaIdentity,
): Promise<CycleResult> {
  const wanted = new Map<string, SliceFile>();
  for (const slot of known.owed) {
    const split = slot.indexOf('\n');
    const file = lookup(known.manifest, slot.slice(0, split), slot.slice(split + 1));
    if (file) wanted.set(slot, file);
  }
  if (!wanted.size) {
    await settle(context, pollAfter);
    return none();
  }

  const got = await acquire(context, wanted, meta, identity);
  if (got.storage) {
    await settle(context, pollAfter);
    return storageFailure();
  }
  let install: Install | undefined;
  if (got.verified.size) {
    install = build(context, known, known, [...Object.keys(known.slots), ...known.owed], got);
    if (!(await commit(context, install, role))) return storageFailure();
  }
  if (got.transient) await backOff(context, got.retryAfter);
  else await settle(context, pollAfter);

  const conditions = integrityConditions(got);
  return install ? { outcome: installedOutcome(role), install, conditions } : { outcome: 'noChange', conditions };
}

async function poll(context: CycleContext, state: State): Promise<CycleResult> {
  const { client } = context;
  const identity = identityOf(context, state);
  const answer = await client.fetchMeta(identity);

  switch (answer.kind) {
    case 'unbound':
      await settle(context, clampPollAfter(state.lastPollAfter));
      return { outcome: 'unbound', conditions: [{ code: 'unbound' }] };
    case 'unreleased':
      await settle(context, clampPollAfter(answer.pollAfter, MIN_POLL_SECONDS));
      return none();
    case 'configuration':
      await settle(context, clampPollAfter(answer.pollAfter, state.lastPollAfter));
      return {
        outcome: 'failed',
        conditions: [{ code: 'configuration', status: answer.status, ...(answer.code === undefined ? {} : { problemCode: answer.code }) }],
      };
    case 'throttled':
    case 'server':
      await backOff(context, answer.retryAfter);
      return { outcome: 'failed', conditions: [] };
    case 'unreadable':
    case 'network':
      await backOff(context);
      return { outcome: 'failed', conditions: [] };
    case 'received':
      break;
  }

  const { meta } = answer;
  const pollAfter = clampPollAfter(meta.pollAfter, state.lastPollAfter);
  const reject = (current: State): void => {
    current.rejectedChecksums = [...(current.rejectedChecksums ?? []), meta.checksum].slice(-MAX_REJECTED);
  };

  if (meta.schemaVersion !== KNOWN_SCHEMA) {
    await settle(context, pollAfter);
    return { outcome: 'noChange', conditions: [{ code: 'metaSchema', schemaVersion: meta.schemaVersion }] };
  }
  if (state.rejectedChecksums?.includes(meta.checksum)) {
    await settle(context, pollAfter);
    return none();
  }

  const known = state.pending ?? state.active;
  const role: Role = state.active ? 'pending' : 'active';
  if (known && known.checksum === meta.checksum) {
    return retryOwed(context, known, state.pending ? 'pending' : 'active', meta, pollAfter, identity);
  }
  if (state.pending && state.active?.checksum === meta.checksum) {
    await settle(context, pollAfter, (current) => {
      delete current.pending;
    });
    return none();
  }

  const fetched = await client.fetchManifest(meta);
  if (fetched.kind !== 'verified') {
    if (fetched.kind === 'checksumMismatch' || fetched.kind === 'unreadable') {
      await settle(context, pollAfter, reject);
      return { outcome: 'failed', conditions: fetched.kind === 'checksumMismatch' ? [{ code: 'manifestIntegrity' }] : [] };
    }
    await backOff(context, 'retryAfter' in fetched ? fetched.retryAfter : undefined);
    return { outcome: 'failed', conditions: [] };
  }
  const { manifest } = fetched;
  if (manifest.schemaVersion !== KNOWN_SCHEMA) {
    await settle(context, pollAfter, reject);
    return { outcome: 'failed', conditions: [{ code: 'manifestSchema', schemaVersion: manifest.schemaVersion }] };
  }

  const locale = context.locale();
  const wanted = new Map<string, SliceFile>();
  for (const bundle of locale === undefined ? [] : Object.keys(manifest.slices)) {
    const file = lookup(manifest, bundle, locale!);
    if (file) wanted.set(slotName(bundle, locale!), file);
  }
  const got = await acquire(context, wanted, meta, identity);
  if (got.storage) {
    await settle(context, pollAfter);
    return storageFailure();
  }

  const names = [...wanted.keys()];
  const install = build(context, { checksum: meta.checksum, releaseId: meta.releaseId, manifest }, known, names, got);
  const changed = names.some((name) => install.slots[name] !== known?.slots[name]);
  if (changed && !(await commit(context, install, role))) return storageFailure();
  if (got.transient) await backOff(context, got.retryAfter);
  else await settle(context, pollAfter);

  const conditions = integrityConditions(got);
  if (changed) return { outcome: installedOutcome(role), install, conditions };
  return { outcome: got.transient ? 'failed' : 'noChange', conditions };
}

async function cycle(context: CycleContext, reason: CycleReason): Promise<CycleResult> {
  const held = await heldLocale(context);
  if (held.outcome === 'failed') return held;
  const notDue: CycleResult = held.install ? held : { outcome: 'notDue', conditions: [] };

  const state = await context.store.readState();
  const now = context.now();
  if (reason === 'checkNow') {
    const last = state.checkNowAt;
    const tooSoon = last !== undefined && last <= now && last + CHECK_NOW_FLOOR_SECONDS * 1000 > now;
    // A manual check never shortens a backoff or a Retry-After.
    if (tooSoon || (state.notBefore ?? 0) > now) return notDue;
    await context.store.updateState((current) => ({ ...current, checkNowAt: now }));
  } else if (dueAt(state, now, context.random()) > now) {
    return notDue;
  }

  const rest = await poll(context, state);
  const conditions = [...held.conditions, ...rest.conditions];
  if (!rest.install && held.install && (rest.outcome === 'noChange' || rest.outcome === 'notDue')) {
    return { outcome: held.outcome, install: held.install, conditions };
  }
  return { ...rest, conditions };
}

async function guarded(context: CycleContext, work: () => Promise<CycleResult>): Promise<CycleResult> {
  try {
    if (context.store.degraded) return storageFailure();
    const result = await context.store.withLock(work);
    return result === BUSY ? { outcome: 'busy', conditions: [] } : result;
  } catch {
    return { outcome: 'failed', conditions: [] };
  }
}

export function runCycle(context: CycleContext, reason: CycleReason): Promise<CycleResult> {
  return guarded(context, () => cycle(context, reason));
}

/**
 * Fetches the selected locale's slices from the install already held, without reading meta, when that
 * install's manifest lists them and they are not held yet.
 */
export function fetchHeldLocale(context: CycleContext): Promise<CycleResult> {
  return guarded(context, () => heldLocale(context));
}
