import type { Manifest } from './types.js';

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

export async function storeId(_deliveryUrl: string, _apiKey: string): Promise<string> {
  throw new Error('not implemented');
}

export function composeSlots(
  _previous: Install | undefined,
  _wanted: string[],
  _verified: Map<string, string>,
): { slots: Record<string, string>; owed: string[] } {
  throw new Error('not implemented');
}

export class MemoryStore implements Store {
  readonly id: string;
  degraded: boolean;

  constructor(id: string, options: { degraded?: boolean } = {}) {
    this.id = id;
    this.degraded = options.degraded ?? false;
  }

  withLock<T>(_fn: () => Promise<T>): Promise<T | typeof BUSY> {
    throw new Error('not implemented');
  }
  readState(): Promise<State> {
    throw new Error('not implemented');
  }
  updateState(_change: (state: State) => State): Promise<State> {
    throw new Error('not implemented');
  }
  putSlice(_hash: string, _bytes: Uint8Array): Promise<'stored' | 'held' | 'quota'> {
    throw new Error('not implemented');
  }
  readSlices(_hashes: string[]): Promise<Map<string, Uint8Array>> {
    throw new Error('not implemented');
  }
  writeInstall(_install: Install, _as: 'active' | 'pending'): Promise<boolean> {
    throw new Error('not implemented');
  }
  cleanup(): Promise<void> {
    throw new Error('not implemented');
  }
  close(): void {}
}
