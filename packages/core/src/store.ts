import type { Manifest } from './types.js';
import { sha256Hex } from './verifier.js';

export const BUSY: unique symbol = Symbol('tarjim.busy');

export interface Install {
  checksum: string;
  releaseId: string | number;
  manifest: Manifest;
  /** "<bundleId>\n<locale>" → hash */
  slots: Record<string, string>;
  /** Slot names with no slice held. */
  owed: string[];
  manifestUrl: string;
  slicesBaseUrl: string;
  authenticated: boolean;
  signedQuery?: string;
  sdkVersion: string;
  installedAt: number;
}

export interface State {
  active?: Install;
  pending?: Install;
  lastCheck?: number;
  lastPollAfter?: number;
  backoffStep?: number;
  notBefore?: number;
  checkNowAt?: number;
  languageOverride?: string;
  installId?: string;
  rejectedChecksums?: string[];
  reported?: Record<string, number>;
}

export interface Store {
  readonly id: string;
  readonly degraded: boolean;
  withLock<T>(fn: () => Promise<T>): Promise<T | typeof BUSY>;
  /** Never throws; an unreadable record reads as empty. */
  readState(): Promise<State>;
  /** One read-modify-write. */
  updateState(change: (state: State) => State): Promise<State>;
  /** A hash already held is never overwritten. */
  putSlice(hash: string, bytes: Uint8Array): Promise<'stored' | 'held' | 'quota'>;
  /** Re-hashed on read: a missing or altered slice is absent from the result. */
  readSlices(hashes: string[]): Promise<Map<string, Uint8Array>>;
  /** Writes nothing and returns false unless every hash the install names is held. */
  writeInstall(install: Install, as: 'active' | 'pending'): Promise<boolean>;
  /** Removes this store's slices that no install in its own state references. */
  cleanup(): Promise<void>;
  close(): void;
}

export function slotName(bundleId: string, locale: string): string {
  return `${bundleId}\n${locale}`;
}

export async function storeId(deliveryUrl: string, apiKey: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`${deliveryUrl}\n${apiKey}`));
}

export function composeSlots(
  previous: Install | undefined,
  wanted: string[],
  verified: Map<string, string>,
): { slots: Record<string, string>; owed: string[] } {
  const slots: Record<string, string> = {};
  const owed: string[] = [];
  for (const slot of wanted) {
    const hash = verified.get(slot) ?? previous?.slots[slot];
    if (hash === undefined) owed.push(slot);
    else slots[slot] = hash;
  }
  return { slots, owed };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// Stored data is only ever a clone of what was written, but a record that was damaged or written by
// something else must not be able to exhaust the stack.
function freezeCopy(value: unknown, depth = 0): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (depth > 32) throw new RangeError('too deep');
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeCopy(item, depth + 1)));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== '__proto__') copy[key] = freezeCopy(item, depth + 1);
  }
  return Object.freeze(copy);
}

/** A deep, frozen copy of an install, or undefined when the value is not shaped like one. */
export function sanitiseInstall(raw: unknown): Install | undefined {
  if (!isRecord(raw) || !isRecord(raw.manifest) || !isRecord(raw.slots)) return undefined;
  const { checksum, releaseId, slots, owed, manifestUrl, slicesBaseUrl, authenticated, signedQuery, sdkVersion, installedAt } = raw;
  if (
    typeof checksum !== 'string' ||
    (typeof releaseId !== 'string' && typeof releaseId !== 'number') ||
    !Object.values(slots).every((hash) => typeof hash === 'string') ||
    !isStrings(owed) ||
    typeof manifestUrl !== 'string' ||
    typeof slicesBaseUrl !== 'string' ||
    typeof authenticated !== 'boolean' ||
    (signedQuery !== undefined && typeof signedQuery !== 'string') ||
    typeof sdkVersion !== 'string' ||
    typeof installedAt !== 'number'
  ) {
    return undefined;
  }
  try {
    return Object.freeze({
      checksum,
      releaseId,
      manifest: freezeCopy(raw.manifest) as Manifest,
      slots: freezeCopy(slots) as Record<string, string>,
      owed: Object.freeze([...owed]) as string[],
      manifestUrl,
      slicesBaseUrl,
      authenticated,
      ...(signedQuery === undefined ? {} : { signedQuery }),
      sdkVersion,
      installedAt,
    });
  } catch {
    return undefined;
  }
}

const NUMBER_FIELDS = ['lastCheck', 'lastPollAfter', 'backoffStep', 'notBefore', 'checkNowAt'] as const;
const STRING_FIELDS = ['languageOverride', 'installId'] as const;

/** Keeps every field that has the right shape and drops the rest; never throws. */
export function sanitiseState(raw: unknown): State {
  const state: State = {};
  if (!isRecord(raw)) return state;
  const active = sanitiseInstall(raw.active);
  if (active) state.active = active;
  const pending = sanitiseInstall(raw.pending);
  if (pending) state.pending = pending;
  for (const field of NUMBER_FIELDS) {
    const value = raw[field];
    if (typeof value === 'number' && Number.isFinite(value)) state[field] = value;
  }
  for (const field of STRING_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string') state[field] = value;
  }
  if (isStrings(raw.rejectedChecksums)) state.rejectedChecksums = [...raw.rejectedChecksums];
  const reported = raw.reported;
  if (isRecord(reported) && Object.values(reported).every((day) => typeof day === 'number')) {
    state.reported = { ...reported } as Record<string, number>;
  }
  return state;
}

/** The hashes an install names, once each. */
export function installHashes(install: Install): string[] {
  return [...new Set(Object.values(install.slots))];
}

const heldLocks = new Set<string>();

/** The lock for places without a lock manager: one holder per id in this process, the rest told BUSY. */
export async function runWithProcessLock<T>(id: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
  if (heldLocks.has(id)) return BUSY;
  heldLocks.add(id);
  try {
    return await fn();
  } finally {
    heldLocks.delete(id);
  }
}

export class MemoryStore implements Store {
  readonly id: string;
  degraded: boolean;
  private state: State = {};
  private readonly slices = new Map<string, Uint8Array>();

  constructor(id: string, options: { degraded?: boolean } = {}) {
    this.id = id;
    this.degraded = options.degraded ?? false;
  }

  withLock<T>(fn: () => Promise<T>): Promise<T | typeof BUSY> {
    return runWithProcessLock(this.id, fn);
  }

  async readState(): Promise<State> {
    return sanitiseState(this.state);
  }

  async updateState(change: (state: State) => State): Promise<State> {
    this.state = sanitiseState(change(sanitiseState(this.state)));
    return sanitiseState(this.state);
  }

  async putSlice(hash: string, bytes: Uint8Array): Promise<'stored' | 'held' | 'quota'> {
    if (this.slices.has(hash)) return 'held';
    this.slices.set(hash, bytes.slice());
    return 'stored';
  }

  async readSlices(hashes: string[]): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>();
    for (const hash of hashes) {
      const bytes = this.slices.get(hash);
      if (bytes && (await sha256Hex(bytes)) === hash) found.set(hash, bytes.slice());
    }
    return found;
  }

  async writeInstall(install: Install, as: 'active' | 'pending'): Promise<boolean> {
    const clean = sanitiseInstall(install);
    if (!clean || !installHashes(clean).every((hash) => this.slices.has(hash))) return false;
    const next: State = { ...this.state, [as]: clean };
    if (as === 'active') delete next.pending;
    this.state = next;
    return true;
  }

  async cleanup(): Promise<void> {
    const keep = new Set([this.state.active, this.state.pending].flatMap((install) => (install ? installHashes(install) : [])));
    for (const hash of [...this.slices.keys()]) if (!keep.has(hash)) this.slices.delete(hash);
  }

  close(): void {}
}
