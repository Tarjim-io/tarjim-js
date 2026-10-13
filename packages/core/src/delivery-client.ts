import { HEX64, isRecord, parseJson } from './json.js';
import { decodeManifest } from './manifest.js';
import { sha256Hex, verify } from './verifier.js';
import { API_VERSION, SDK_VERSION } from './version.js';
import type {
  DeliveryClient,
  DeliveryClientOptions,
  Meta,
  MetaIdentity,
  MetaOutcome,
  ManifestOutcome,
  SliceFile,
  SliceOutcome,
  SlicesResult,
} from './types.js';

// Status 0 means no usable answer. `opaque` marks a failure the page cannot see into (a CORS
// failure looks like any other thrown fetch), which is the one kind a fresh signature may fix.
interface Answer {
  status: number;
  retryAfter?: number;
  bytes?: Uint8Array;
  opaque?: boolean;
}

type Failure = Exclude<ManifestOutcome | SliceOutcome, { kind: 'verified' | 'checksumMismatch' | 'unreadable' | 'hashMismatch' | 'sizeMismatch' }>;

const QUERY = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]+$/;
const UNRELEASED = ['delivery.stage_unreleased', 'delivery.track_unreleased', 'delivery.not_published'];
const CONFIGURATION = [400, 401, 403, 404];
const STALE_SIGNATURE = [403, 404, 503];

const opt = <K extends string, V>(name: K, value: V | undefined) =>
  (value === undefined ? {} : { [name]: value }) as { [P in K]?: V };

function parseRetryAfter(value: string | null): number | undefined {
  const seconds = Number(value);
  return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(seconds) ? seconds : undefined;
}

function failure({ status, retryAfter }: Answer): Failure {
  if (status === 0) return { kind: 'network' };
  if (status === 429) return { kind: 'throttled', ...opt('retryAfter', retryAfter) };
  if (status === 503 || (status >= 400 && status < 500)) return { kind: 'unfetchable', status, ...opt('retryAfter', retryAfter) };
  return { kind: 'server', status, ...opt('retryAfter', retryAfter) };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export function createDeliveryClient(options: DeliveryClientOptions): DeliveryClient {
  const { deliveryUrl, apiKey, appVersion, platform } = options;
  const timeoutMs = options.timeoutMs ?? 20000;
  const send = options.fetch;
  const keyHeaders = { 'X-Tarjim-Apikey': apiKey, 'X-Tarjim-Api-Version': API_VERSION };

  // The timeout is inactivity, not total time: it is re-armed whenever bytes arrive.
  async function get(url: string, extra: RequestInit, readBody: (status: number) => boolean): Promise<Answer> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };
    // A fetch or a body that ignores the signal must not be able to hang the client.
    const cut = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error())));
    cut.catch(() => undefined);
    const guard = <T>(work: Promise<T>) => Promise.race([work, cut]);
    try {
      arm();
      const init = { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', ...extra, signal: controller.signal };
      const response = await guard(Promise.resolve(send(url, init as RequestInit)));
      // A followed redirect would carry the key to another host.
      if (response.redirected || response.type === 'opaqueredirect') return { status: 0 };
      arm();
      const { status } = response;
      const answer: Answer = { status, ...opt('retryAfter', parseRetryAfter(response.headers.get('Retry-After'))) };
      if (!readBody(status)) return answer;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await guard(reader.read());
          if (done) break;
          chunks.push(value);
          arm();
        }
        answer.bytes = concat(chunks);
      } else {
        answer.bytes = new Uint8Array(await guard(response.arrayBuffer()));
      }
      return answer;
    } catch {
      return { status: 0, opaque: true };
    } finally {
      clearTimeout(timer);
    }
  }

  function metaUrl(identity: MetaIdentity): string {
    const fields: [string, unknown][] = [
      ['platform', platform],
      ['sdkVersion', SDK_VERSION],
      ['release', identity.release],
      ['pollSeconds', identity.pollSeconds],
      ['language', identity.language],
      ['osVersion', identity.osVersion],
      ['appBuild', identity.appBuild],
      ['installId', identity.installId],
    ];
    // appVersion is already reduced to digits and dots, so it is sent as is.
    let url = `${deliveryUrl}?appVersion=${appVersion}`;
    for (const [name, value] of fields) {
      if (value !== undefined && value !== null) url += `&${name}=${encodeURIComponent(String(value))}`;
    }
    return url;
  }

  function decodeMeta(bytes: Uint8Array | undefined): MetaOutcome {
    const m = parseJson(bytes);
    if (!isRecord(m)) return { kind: 'unreadable' };
    if (typeof m['track'] !== 'string') return { kind: 'unbound' };
    const complete =
      typeof m['checksum'] === 'string' &&
      HEX64.test(m['checksum']) &&
      typeof m['manifestUrl'] === 'string' &&
      typeof m['slicesBaseUrl'] === 'string' &&
      typeof m['schemaVersion'] === 'number' &&
      typeof m['pollAfter'] === 'number' &&
      (typeof m['releaseId'] === 'string' || typeof m['releaseId'] === 'number') &&
      (m['authenticated'] === true || (typeof m['signedQuery'] === 'string' && m['signedQuery'] !== ''));
    return complete ? { kind: 'received', meta: m as Meta } : { kind: 'unreadable' };
  }

  async function fetchMeta(identity: MetaIdentity = {}): Promise<MetaOutcome> {
    try {
      const answer = await get(metaUrl(identity), { headers: keyHeaders, cache: 'no-store' }, (s) => s === 200 || CONFIGURATION.includes(s));
      const { status } = answer;
      if (status === 200) return decodeMeta(answer.bytes);
      if (status === 0) return { kind: 'network' };
      if (status === 429) return { kind: 'throttled', ...opt('retryAfter', answer.retryAfter) };
      if (!CONFIGURATION.includes(status)) return { kind: 'server', status, ...opt('retryAfter', answer.retryAfter) };

      const body = parseJson(answer.bytes);
      const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : undefined;
      const hint = isRecord(body) && Number.isSafeInteger(body['pollAfter']) && (body['pollAfter'] as number) >= 0 ? (body['pollAfter'] as number) : undefined;
      if (status === 404 && code !== undefined && UNRELEASED.includes(code)) return { kind: 'unreleased', ...opt('pollAfter', hint) };
      return { kind: 'configuration', status, ...opt('code', code), ...opt('pollAfter', hint) };
    } catch {
      return { kind: 'network' };
    }
  }

  // Origin mode (an authenticated meta) resolves against the delivery URL and sends the key, but
  // never to another origin. CDN mode takes an absolute https address plus the signed query and
  // sends no custom header, so the request stays simple.
  function objectRequest(meta: Meta, reference: unknown): { url: string; extra: RequestInit } | null {
    try {
      if (typeof reference !== 'string' || reference === '') return null;
      if (meta.authenticated === true) {
        const url = new URL(reference, deliveryUrl);
        return url.origin === new URL(deliveryUrl).origin ? { url: url.href, extra: { headers: keyHeaders } } : null;
      }
      const query = meta.signedQuery;
      if (!reference.startsWith('https://') || /[?#]/.test(reference) || typeof query !== 'string' || !QUERY.test(query)) return null;
      // A bare host has no path to hold an object, so it cannot be a real reference.
      if (new URL(reference).pathname === '/') return null;
      return { url: `${reference}?${query}`, extra: {} };
    } catch {
      return null;
    }
  }

  async function fetchManifest(meta: Meta): Promise<ManifestOutcome> {
    try {
      const request = objectRequest(meta, meta.manifestUrl);
      if (!request) return { kind: 'refused' };
      const answer = await get(request.url, request.extra, (s) => s === 200);
      if (answer.status !== 200) return failure(answer);
      const bytes = answer.bytes!;
      if ((await sha256Hex(bytes)) !== meta.checksum) return { kind: 'checksumMismatch' };
      const manifest = decodeManifest(parseJson(bytes));
      return manifest ? { kind: 'verified', manifest, bytes } : { kind: 'unreadable' };
    } catch {
      return { kind: 'network' };
    }
  }

  async function fetchSlice(meta: Meta, file: SliceFile): Promise<{ outcome: SliceOutcome; stale: boolean }> {
    try {
      const request = HEX64.test(file.hash) ? objectRequest(meta, typeof meta.slicesBaseUrl === 'string' ? `${meta.slicesBaseUrl}${file.hash}.json` : undefined) : null;
      if (!request) return { outcome: { kind: 'refused' }, stale: false };
      const answer = await get(request.url, request.extra, (s) => s === 200);
      if (answer.status !== 200) {
        const outcome = failure(answer);
        return { outcome, stale: answer.opaque === true || (outcome.kind === 'unfetchable' && STALE_SIGNATURE.includes(outcome.status)) };
      }
      const verdict = await verify(answer.bytes!, file);
      const outcome: SliceOutcome =
        verdict === 'ok' ? { kind: 'verified', bytes: answer.bytes! } : { kind: verdict === 'size' ? 'sizeMismatch' : 'hashMismatch' };
      return { outcome, stale: false };
    } catch {
      return { outcome: { kind: 'network' }, stale: false };
    }
  }

  async function fetchSlices(meta: Meta, files: SliceFile[], identity?: MetaIdentity): Promise<SlicesResult> {
    try {
      const unique = new Map<string, SliceFile>();
      for (const file of files) if (!unique.has(file.hash)) unique.set(file.hash, file);
      const list = [...unique.values()];
      const first = await Promise.all(list.map((file) => fetchSlice(meta, file)));
      const results = new Map<string, SliceOutcome>(list.map((file, i) => [file.hash, first[i]!.outcome]));
      const stale = list.filter((_, i) => first[i]!.stale);
      if (!stale.length || meta.authenticated === true) return { results, meta, reread: false };

      // One re-read per call: an expired signature is the only thing it can fix.
      const again = await fetchMeta(identity);
      if (again.kind !== 'received' || again.meta.checksum !== meta.checksum) return { results, meta, reread: true };
      const signedQuery = again.meta.signedQuery;
      if (typeof signedQuery === 'string' && signedQuery !== '' && signedQuery !== meta.signedQuery) {
        const retried = await Promise.all(stale.map((file) => fetchSlice({ ...meta, signedQuery }, file)));
        stale.forEach((file, i) => results.set(file.hash, retried[i]!.outcome));
      }
      return { results, meta: again.meta, reread: true };
    } catch {
      return { results: new Map(), meta, reread: false };
    }
  }

  return { fetchMeta, fetchManifest, fetchSlices };
}
