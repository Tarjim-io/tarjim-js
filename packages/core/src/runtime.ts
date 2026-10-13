import type { BundleRef, FormatArgs, LookupOptions, TarjimEntry } from './resolver.js';
import type { Slice } from './slice.js';
import type { Store } from './store.js';
import type { FetchFunction } from './types.js';
import type { Timers, Visibility } from './scheduler.js';

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

/** Never rejects for a condition it can degrade from, unless `strict` is set. */
export async function createRuntime(_config: TarjimConfig, _platform: Platform): Promise<Tarjim> {
  throw new Error('not implemented');
}
