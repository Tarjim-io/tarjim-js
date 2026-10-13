import type { DeliveryClient, MetaIdentity } from './types.js';
import type { Install, Store } from './store.js';

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

export async function runCycle(_context: CycleContext, _reason: CycleReason): Promise<CycleResult> {
  throw new Error('not implemented');
}

/**
 * Fetches the selected locale's slices from the install already held, without reading meta, when that
 * install's manifest lists them and they are not held yet.
 */
export async function fetchHeldLocale(_context: CycleContext): Promise<CycleResult> {
  throw new Error('not implemented');
}
