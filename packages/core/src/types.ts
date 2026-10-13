export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface DeliveryClientOptions {
  /** The meta URL as the console shows it. Validate it with `deliveryUrlProblem` first. */
  deliveryUrl: string;
  apiKey: string;
  /** Normalised by the client with `normaliseAppVersion` before it is sent. */
  appVersion: string;
  platform: string;
  fetch: FetchFunction;
  /** Milliseconds without receiving any bytes before a request is abandoned. */
  timeoutMs?: number;
}

/** Optional identity sent with `meta` only. An absent field is not sent. */
export interface MetaIdentity {
  release?: string | number;
  pollSeconds?: number;
  language?: string;
  osVersion?: string;
  appBuild?: string;
  installId?: string;
}

export interface Meta {
  checksum: string;
  schemaVersion: number;
  manifestUrl: string;
  slicesBaseUrl: string;
  authenticated?: boolean;
  signedQuery?: string;
  track: string;
  releaseId: string | number;
  pollAfter: number;
  [field: string]: unknown;
}

export type MetaOutcome =
  | { kind: 'received'; meta: Meta }
  | { kind: 'unbound' }
  | { kind: 'unreadable' }
  | { kind: 'unreleased'; pollAfter?: number }
  | { kind: 'configuration'; status: number; code?: string; pollAfter?: number }
  | { kind: 'throttled'; retryAfter?: number }
  | { kind: 'server'; status: number; retryAfter?: number }
  | { kind: 'network' };

export interface ManifestBundle {
  type: string;
  name: string;
  layout?: string;
  namespaces: string[];
}

export interface SliceFile {
  hash: string;
  size: number;
}

export interface Manifest {
  schemaVersion: number;
  bundles: Record<string, ManifestBundle>;
  /** bundle id → locale → the JSON file. Only JSON files are kept. */
  slices: Record<string, Record<string, SliceFile>>;
}

type FetchFailure =
  | { kind: 'refused' }
  | { kind: 'unfetchable'; status: number; retryAfter?: number }
  | { kind: 'throttled'; retryAfter?: number }
  | { kind: 'server'; status: number; retryAfter?: number }
  | { kind: 'network' };

export type ManifestOutcome =
  | { kind: 'verified'; manifest: Manifest; bytes: Uint8Array }
  | { kind: 'checksumMismatch' }
  | { kind: 'unreadable' }
  | FetchFailure;

export type SliceOutcome =
  | { kind: 'verified'; bytes: Uint8Array }
  | { kind: 'hashMismatch' }
  | { kind: 'sizeMismatch' }
  | FetchFailure;

export interface SlicesResult {
  results: Map<string, SliceOutcome>;
  /** The meta whose signature later requests must use: the re-read one when it was used. */
  meta: Meta;
  reread: boolean;
}

export interface DeliveryClient {
  fetchMeta(identity?: MetaIdentity): Promise<MetaOutcome>;
  fetchManifest(meta: Meta): Promise<ManifestOutcome>;
  fetchSlices(meta: Meta, files: SliceFile[], identity?: MetaIdentity): Promise<SlicesResult>;
}
