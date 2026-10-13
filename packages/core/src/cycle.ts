import { CHECK_NOW_FLOOR_SECONDS, MIN_POLL_SECONDS, backoffSeconds, clampPollAfter, clampRetryAfter, dueAt, notBeforeOf } from './cadence.js';
import { BUSY, composeSlots, parseSlot, slotName } from './store.js';
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
  | { code: 'unbound-key' }
  | { code: 'configuration'; status: number; problemCode?: string }
  | { code: 'meta-schema'; schemaVersion: unknown }
  | { code: 'manifest-schema'; schemaVersion: unknown }
  | { code: 'manifest-integrity' }
  | { code: 'manifest-unreadable' }
  | { code: 'slice-integrity' }
  | { code: 'storage' };

export interface CycleResult {
  outcome: CycleOutcome;
  /** The install the poll wrote, or the one the locale step extended when the poll wrote none. */
  install?: Install;
  /** Set whenever this cycle changed the active install, whatever the poll's outcome. */
  active?: Install;
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

function fileOf(manifest: Manifest, slot: string): SliceFile | undefined {
  const parsed = parseSlot(slot);
  return parsed && lookup(manifest, parsed.bundle, parsed.locale);
}

export function wantedSlots(manifest: Manifest, locale: string): Map<string, SliceFile> {
  const wanted = new Map<string, SliceFile>();
  for (const bundle of Object.keys(manifest.slices)) {
    const file = lookup(manifest, bundle, locale);
    if (file) wanted.set(slotName(bundle, locale), file);
  }
  return wanted;
}

// A slot the newest install lacks is served from the active one, so a new install keeps that file as its previous text.
function previousOf(state: State, known: Install | undefined): Install | undefined {
  if (!known || !state.active || !state.pending) return known;
  return { ...known, slots: { ...state.active.slots, ...known.slots } };
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
    } else if (outcome?.kind !== 'unfetchable' && outcome?.kind !== 'refused') {
      // An object the server will not hand out stays owed without a backoff; the next check asks again.
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
  const { slots } = composeSlots(previous, names, got.verified);
  // A slot that kept its previous text is still owed the manifest's.
  const owed = names.filter((name) => {
    const target = fileOf(from.manifest, name);
    return slots[name] === undefined || (target !== undefined && slots[name] !== target.hash);
  });
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

async function write(context: CycleContext, install: Install, role: Role): Promise<boolean> {
  return context.store.writeInstall(install, role);
}

async function tidy(context: CycleContext): Promise<void> {
  try {
    await context.store.cleanup();
  } catch {
    // Leftover slices are removed by the next install.
  }
}

async function commit(context: CycleContext, install: Install, role: Role): Promise<boolean> {
  if (!(await write(context, install, role))) return false;
  await tidy(context);
  return true;
}

const installedOutcome = (role: Role): CycleOutcome => (role === 'active' ? 'activated' : 'downloaded');
const integrityConditions = (got: Acquired): CycleCondition[] => (got.integrity ? [{ code: 'slice-integrity' }] : []);
const activeOf = (install: Install, role: Role): { active?: Install } => (role === 'active' ? { active: install } : {});

async function writeFailed(context: CycleContext): Promise<CycleResult> {
  await backOff(context);
  return storageFailure();
}

// Extends both the install that is showing and the one waiting, so the language shows at once and survives the switch to the waiting one.
async function heldLocale(context: CycleContext): Promise<CycleResult> {
  const { store } = context;
  const state = await store.readState();
  const top = state.pending ?? state.active;
  const locale = context.locale();
  if (!top || locale === undefined) return none();
  const mark = `${top.checksum}\n${locale}`;
  if (state.localeFetched === mark) return none();

  const plans: Array<{ role: Role; base: Install; wanted: Map<string, SliceFile> }> = [];
  for (const [role, base] of [['active', state.active], ['pending', state.pending]] as Array<[Role, Install | undefined]>) {
    const wanted = new Map<string, SliceFile>();
    for (const [slot, file] of base ? wantedSlots(base.manifest, locale) : []) {
      // An owed slot belongs to the retry that a fresh meta triggers, which brings a fresh signature.
      if (base!.slots[slot] === undefined && !base!.owed.includes(slot)) wanted.set(slot, file);
    }
    if (base && wanted.size) plans.push({ role, base, wanted });
  }
  if (!plans.length) return none();
  if (notBeforeOf(state, context.now()) > context.now()) return { outcome: 'notDue', conditions: [] };

  const made: Partial<Record<Role, { install: Install; fresh: boolean }>> = {};
  const conditions: CycleCondition[] = [];
  let transient = false;
  let retryAfter: number | undefined;
  for (const { role, base, wanted } of plans) {
    const got = await acquire(context, wanted, metaOf(base), identityOf(context, state));
    if (got.storage) return storageFailure();
    conditions.push(...integrityConditions(got));
    transient ||= got.transient;
    if (got.retryAfter !== undefined) retryAfter = Math.max(retryAfter ?? 0, got.retryAfter);
    // Slots that could not be fetched are written as owed, so the install records the attempt.
    if (got.verified.size || !got.transient) {
      const names = [...new Set([...Object.keys(base.slots), ...base.owed, ...wanted.keys()])];
      made[role] = { install: build(context, base, previousOf(state, base), names, got), fresh: got.verified.size > 0 };
    }
  }

  const { active, pending } = made;
  // Writing an active install drops the pending one, so that is written back after it.
  if (active && !(await write(context, active.install, 'active'))) return writeFailed(context);
  const waiting = pending?.install ?? (active ? state.pending : undefined);
  if (waiting && !(await write(context, waiting, 'pending'))) return writeFailed(context);
  if (active || pending) await tidy(context);
  // A transient failure leaves the mark unset so a later cycle tries again, after the backoff.
  if (transient) await backOff(context, retryAfter);
  else await store.updateState((current) => ({ ...current, localeFetched: mark }));

  const extra = active ? { active: active.install } : {};
  const fresh = [pending, active].find((entry) => entry?.fresh);
  if (fresh) return { outcome: active?.fresh ? 'activated' : 'downloaded', install: fresh.install, conditions, ...extra };
  return { outcome: transient ? 'failed' : 'noChange', conditions, ...extra };
}

async function retryOwed(
  context: CycleContext,
  state: State,
  known: Install,
  role: Role,
  meta: Meta,
  pollAfter: number,
  identity: MetaIdentity,
): Promise<CycleResult> {
  const wanted = new Map<string, SliceFile>();
  for (const slot of known.owed) {
    const file = fileOf(known.manifest, slot);
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
    install = build(context, known, previousOf(state, known), [...Object.keys(known.slots), ...known.owed], got);
    if (!(await commit(context, install, role))) return writeFailed(context);
  }
  if (got.transient) await backOff(context, got.retryAfter);
  else await settle(context, pollAfter);

  const conditions = integrityConditions(got);
  return install
    ? { outcome: installedOutcome(role), install, conditions, ...activeOf(install, role) }
    : { outcome: 'noChange', conditions };
}

async function poll(context: CycleContext, state: State): Promise<CycleResult> {
  const { client } = context;
  const identity = identityOf(context, state);
  const answer = await client.fetchMeta(identity);

  switch (answer.kind) {
    case 'unbound':
      await settle(context, clampPollAfter(state.lastPollAfter));
      return { outcome: 'unbound', conditions: [{ code: 'unbound-key' }] };
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
    return { outcome: 'noChange', conditions: [{ code: 'meta-schema', schemaVersion: meta.schemaVersion }] };
  }
  if (state.rejectedChecksums?.includes(meta.checksum)) {
    await settle(context, pollAfter);
    return none();
  }

  const known = state.pending ?? state.active;
  if (known && known.checksum === meta.checksum) {
    return retryOwed(context, state, known, state.pending ? 'pending' : 'active', meta, pollAfter, identity);
  }
  if (state.pending && state.active?.checksum === meta.checksum) {
    await settle(context, pollAfter, (current) => {
      delete current.pending;
    });
    return none();
  }

  // Nothing can be wanted before a locale is chosen, and the next check sees this checksum as new again.
  const locale = context.locale();
  if (locale === undefined) {
    await settle(context, pollAfter);
    return none();
  }

  const fetched = await client.fetchManifest(meta);
  if (fetched.kind !== 'verified') {
    if (fetched.kind === 'checksumMismatch') {
      await settle(context, pollAfter, reject);
      return { outcome: 'failed', conditions: [{ code: 'manifest-integrity' }] };
    }
    await backOff(context, 'retryAfter' in fetched ? fetched.retryAfter : undefined);
    // Not rejected: an oversized proxy page and a bad release look the same from here, and the next meta may differ.
    return { outcome: 'failed', conditions: fetched.kind === 'unreadable' ? [{ code: 'manifest-unreadable' }] : [] };
  }
  const { manifest } = fetched;
  if (manifest.schemaVersion !== KNOWN_SCHEMA) {
    await settle(context, pollAfter, reject);
    return { outcome: 'failed', conditions: [{ code: 'manifest-schema', schemaVersion: manifest.schemaVersion }] };
  }

  const wanted = wantedSlots(manifest, locale);
  const got = await acquire(context, wanted, meta, identity);
  if (got.storage) {
    await settle(context, pollAfter);
    return storageFailure();
  }

  const previous = previousOf(state, known);
  const install = build(context, { checksum: meta.checksum, releaseId: meta.releaseId, manifest }, previous, [...wanted.keys()], got);
  // A dropped bundle or locale changes what is served as much as a new text does.
  const changed =
    Object.keys(known?.slots ?? {}).some((slot) => parseSlot(slot)?.locale === locale && install.slots[slot] === undefined) ||
    Object.entries(install.slots).some(([slot, hash]) => hash !== previous?.slots[slot]);
  // A release that changes nothing served is still adopted, so the next poll does not fetch its manifest again.
  const role: Role = changed ? (state.active ? 'pending' : 'active') : state.pending ? 'pending' : 'active';
  if (!(await commit(context, install, role))) return writeFailed(context);
  if (got.transient) await backOff(context, got.retryAfter);
  else await settle(context, pollAfter);

  const conditions = integrityConditions(got);
  const extra = activeOf(install, role);
  if (changed) return { outcome: installedOutcome(role), install, conditions, ...extra };
  return { outcome: got.transient ? 'failed' : 'noChange', conditions, ...extra };
}

function merge(held: CycleResult, rest: CycleResult): CycleResult {
  const conditions = [...held.conditions, ...rest.conditions];
  const active = rest.active ?? held.active;
  const extra = active ? { active } : {};
  if (rest.install) return { ...rest, conditions, ...extra };
  if (held.install && (rest.outcome === 'noChange' || rest.outcome === 'notDue')) {
    return { outcome: held.outcome, install: held.install, conditions, ...extra };
  }
  // A backoff the locale step just started is the reason the poll did not run.
  if (rest.outcome === 'notDue' && held.outcome === 'failed') return { ...held, conditions, ...extra };
  return { ...rest, conditions, ...extra };
}

async function cycle(context: CycleContext, reason: CycleReason): Promise<CycleResult> {
  const held = await heldLocale(context);
  const notDue: CycleResult = { outcome: 'notDue', conditions: [] };

  const state = await context.store.readState();
  const now = context.now();
  if (reason === 'checkNow') {
    const last = state.checkNowAt;
    const tooSoon = last !== undefined && last <= now && last + CHECK_NOW_FLOOR_SECONDS * 1000 > now;
    // A manual check never shortens a backoff or a Retry-After.
    if (tooSoon || notBeforeOf(state, now) > now) return merge(held, notDue);
    await context.store.updateState((current) => ({ ...current, checkNowAt: now }));
  } else if (dueAt(state, now, context.random()) > now) {
    return merge(held, notDue);
  }

  return merge(held, await poll(context, state));
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
