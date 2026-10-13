import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDeliveryClient } from '../src/index.js';
import type { DeliveryClientOptions, Meta, SliceFile } from '../src/index.js';
import * as fake from '../../../test/helpers/fake-delivery.js';

export const { API_KEY, DELIVERY_URL, SIGNED_QUERY, ROTATED_SIGNED_QUERY } = fake as unknown as Record<
  'API_KEY' | 'DELIVERY_URL' | 'SIGNED_QUERY' | 'ROTATED_SIGNED_QUERY',
  string
>;

// The helpers are plain JavaScript; these are the shapes the tests rely on.
export interface Recorded {
  fetch: DeliveryClientOptions['fetch'];
  requests: { url: string; init: RequestInit | undefined }[];
  hook(fn: (call: { url: string; init: RequestInit | undefined; kind: string; name: string; nth: number }) => unknown): void;
  deliveryUrl: string;
  meta: Meta;
}
export interface Release extends Omit<Recorded, 'meta'> {
  meta: Meta;
  manifest: { slices: Record<string, Record<string, { json: SliceFile }>> };
  setMeta(overrides: Record<string, unknown>): void;
  objectName(bundleId: string, locale: string): string;
}
export interface ReleaseOptions {
  mode?: 'cdn' | 'origin';
  bundles?: Record<string, unknown>;
  slices?: Record<string, Record<string, unknown>>;
  extraTypes?: string[];
  metaOverrides?: Record<string, unknown>;
  manifestOverrides?: Record<string, unknown>;
  tamper?: Record<string, unknown>;
}
const buildRelease = fake.buildRelease as unknown as (options: ReleaseOptions) => Release;
const serveRecording = fake.serveRecording as unknown as (dir: string, options: { mode: string }) => Recorded;
export const respond = fake.respond as unknown as (
  status: number,
  body?: unknown,
  options?: { headers?: Record<string, string>; redirected?: boolean; type?: string },
) => Response;
export const problem = fake.problem as unknown as (status: number, code: string, extra?: Record<string, unknown>) => Response;

export const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));

interface Envelope {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function envelope(relativePath: string): Envelope {
  return JSON.parse(readFileSync(FIXTURES + relativePath, 'utf8')) as Envelope;
}

/** A hand-built or recorded status row from the fixtures, as a fetch Response. */
export function fixtureResponse(relativePath: string, extraHeaders: Record<string, string> = {}): Response {
  const row = envelope(relativePath);
  return respond(row.status, row.body, { headers: { ...row.headers, ...extraHeaders } });
}

export function recording(name: string, mode: 'cdn' | 'origin' = 'cdn'): Recorded {
  return serveRecording(`${FIXTURES}recorded/${name}`, { mode });
}

export function clientFor(fetchFn: DeliveryClientOptions['fetch'], overrides: Partial<DeliveryClientOptions> = {}) {
  return createDeliveryClient({
    deliveryUrl: DELIVERY_URL,
    apiKey: API_KEY,
    appVersion: '1.4.0',
    platform: 'web',
    fetch: fetchFn,
    timeoutMs: 200,
    ...overrides,
  });
}

/** Two bundles' worth of slices with real hashes; CDN by default. */
export function simpleRelease(options: ReleaseOptions = {}): Release {
  return buildRelease({
    bundles: { b1: { type: 'namespace', name: 'default' } },
    slices: {
      b1: {
        en: { schemaVersion: 1, keys: { a: { id: '1', value: 'A', tags: [] } } },
        fr: { schemaVersion: 1, keys: { a: { id: '1', value: 'Un', tags: [] } } },
      },
    },
    ...options,
  });
}

export function jsonFiles(release: Release): SliceFile[] {
  return Object.values(release.manifest.slices).flatMap((byLocale) =>
    Object.values(byLocale).map((entry) => ({ hash: entry.json.hash, size: entry.json.size })),
  );
}

/** A response whose body the test feeds by hand, to model stalls and slow bodies. */
export function controlledStream(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  return {
    response,
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
    fail: (reason: unknown) => controller.error(reason),
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON for leak checks: Maps become entries, byte arrays become their length. */
export function serialise(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v instanceof Map) return [...v.entries()];
    if (v instanceof Uint8Array) return `bytes:${v.length}`;
    return v;
  });
}

export const headersOf = fake.headersOf as unknown as (init: RequestInit | undefined) => Record<string, string>;
export const queryOf = fake.queryOf as unknown as (url: string) => Record<string, string>;
export const hangUntilAborted = fake.hangUntilAborted as unknown as (init: RequestInit | undefined) => Promise<never>;
export const sha256Hex = fake.sha256Hex as unknown as (bytes: Uint8Array | string) => string;

