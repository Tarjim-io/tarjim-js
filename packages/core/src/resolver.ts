import type { Install } from './store.js';
import type { Slice } from './slice.js';

export interface BundleRef {
  type: 'namespace' | 'custom';
  name: string;
}

export type FormatArgs = Record<string, unknown> | readonly unknown[];

export interface LookupOptions {
  bundle?: BundleRef;
  namespace?: string;
}

export interface TarjimEntry {
  value: string;
  id: string;
  type: 'text' | 'image' | 'audio/video' | 'file';
  attributes: Record<string, string> | null;
  className: string | null;
}

export interface SnapshotReport {
  code: 'attribute-dropped' | 'media-url-rejected' | 'slice-schema';
  details?: Record<string, unknown>;
}

export interface SnapshotInput {
  /** The install to serve, with its verified slice bytes by hash. */
  install?: Install;
  slices: ReadonlyMap<string, Uint8Array>;
  embedded: readonly Slice[];
  locale: string;
  defaultBundle: BundleRef;
  legacyPercentPlaceholders?: boolean;
  report?: (report: SnapshotReport) => void;
}

export interface Snapshot {
  readonly language: string;
  t(key: string, args?: FormatArgs, options?: LookupOptions): string;
  tArray(key: string, options?: LookupOptions): string[];
  entry(key: string, options?: LookupOptions): TarjimEntry | null;
}

export function createSnapshot(_input: SnapshotInput): Snapshot {
  throw new Error('not implemented');
}

export interface FormatOptions {
  /** The value was chosen through a plural form, so a lone printf placeholder takes `count`. */
  plural?: boolean;
  count?: number;
  legacyPercentPlaceholders?: boolean;
}

export function format(_text: string, _args: FormatArgs, _options?: FormatOptions): string {
  throw new Error('not implemented');
}
