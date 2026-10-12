import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DELIVERY_URL = 'https://delivery.example.invalid/t/1/projects/1/delivery/meta';
export const API_KEY = 'tarjim-0-0-0-testkey';
export const SIGNED_QUERY = 'Policy=P1&Signature=S1&Key-Pair-Id=K1';
export const ROTATED_SIGNED_QUERY = 'Policy=P2&Signature=S2&Key-Pair-Id=K2';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const FILE_EXTENSIONS = { json: 'json', strings: 'strings', stringsdict: 'stringsdict', xml: 'xml' };

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBytes(body) {
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
}

// `redirected` and `type` are read-only getters on a real Response, so the ones a test needs to
// fake are defined on the instance.
export function respond(status, body = null, { headers = JSON_HEADERS, redirected, type } = {}) {
  const response = new Response(body === null || status === 204 ? null : toBytes(body), { status, headers });
  if (redirected !== undefined) Object.defineProperty(response, 'redirected', { value: redirected });
  if (type !== undefined) Object.defineProperty(response, 'type', { value: type });
  return response;
}

export function problem(status, code, extra = {}) {
  return respond(status, { type: `https://api.example.com/problems/${code}`, title: 'Problem', status, code, ...extra }, {
    headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
  });
}

// Rejects the way fetch does when its signal fires, for a hook that wants a request to hang.
export function hangUntilAborted(init) {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener('abort', abort);
  });
}

export function headersOf(init) {
  const out = {};
  const headers = init?.headers;
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  for (const [name, value] of entries) out[name.toLowerCase()] = value;
  return out;
}

export function queryOf(url) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

function stripQuery(url) {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
}

/**
 * Shared fetch fake. `resolve(url)` returns `{ kind, name, answer() }` for a known URL, or null (404).
 * Hooks run first, in order: `({ url, init, kind, name, nth, requests })` may return a Response to
 * answer instead, an Error to make fetch reject, a promise of either, or nothing to carry on. `nth`
 * counts earlier requests with the same kind and name.
 */
function createFetchFake(resolve, hooks = []) {
  const requests = [];
  const counts = new Map();

  async function fetch(input, init) {
    const url = String(input);
    requests.push({ url, init });
    const target = resolve(url);
    const kind = target?.kind ?? 'unknown';
    const name = target?.name ?? stripQuery(url);
    const countKey = `${kind}:${name}`;
    const nth = counts.get(countKey) ?? 0;
    counts.set(countKey, nth + 1);

    // Every hook runs, so one that only has a side effect still fires after another has answered.
    let answer;
    for (const hook of hooks) {
      const result = await hook({ url, init, kind, name, nth, requests });
      if (answer === undefined && (result instanceof Error || result instanceof Response)) answer = result;
    }
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    if (!target) return problem(404, 'delivery.not_found');
    return target.answer();
  }

  return { fetch, requests, hook: (fn) => hooks.push(fn) };
}

/** Serves a directory made by the capture script: its meta, manifest and objects. */
export function serveRecording(dir, { deliveryUrl = DELIVERY_URL, mode = 'cdn', hooks = [] } = {}) {
  const envelope = JSON.parse(readFileSync(path.join(dir, `meta.${mode}.json`), 'utf8'));
  const meta = JSON.parse(envelope.body);
  const manifestBytes = readFileSync(path.join(dir, 'manifest.json'));

  const resolve = (url) => {
    const bare = stripQuery(url);
    if (bare === stripQuery(deliveryUrl)) {
      return { kind: 'meta', name: 'meta', answer: () => respond(envelope.status, envelope.body, { headers: envelope.headers }) };
    }
    if (bare === stripQuery(new URL(meta.manifestUrl, deliveryUrl).href)) {
      return { kind: 'manifest', name: 'manifest', answer: () => respond(200, manifestBytes) };
    }
    const base = new URL(meta.slicesBaseUrl, deliveryUrl).href;
    if (bare.startsWith(base)) {
      const name = bare.slice(base.length);
      const file = path.join(dir, 'objects', name);
      if (/^[0-9a-f]{64}\.[a-z]+$/.test(name) && existsSync(file)) {
        return { kind: 'object', name, answer: () => respond(200, readFileSync(file)) };
      }
      return { kind: 'object', name, answer: () => problem(404, 'delivery.object_not_found') };
    }
    return null;
  };

  const fake = createFetchFake(resolve, [...hooks]);
  return { fetch: fake.fetch, requests: fake.requests, hook: fake.hook, deliveryUrl, meta };
}

/** Builds a leaf the way the server writes one; extra fields (type, plural_child_keys, …) go in `extra`. */
export function leaf(id, value, extra = {}) {
  return { id: String(id), value, tags: [], ...extra };
}

export function makeSlice(bundleId, locale, keys, extra = {}) {
  return { schemaVersion: 1, bundle: bundleId, locale, keys, ...extra };
}

/** A plural parent plus one child per form, ids counted up from `firstId`. */
export function pluralKeys(key, firstId, forms, parentValue = '') {
  const names = Object.keys(forms);
  const keys = {
    [key]: leaf(firstId, parentValue, { plural_child_keys: names.map((_, i) => firstId + 1 + i) }),
  };
  names.forEach((form, i) => {
    keys[`${key}.${form}`] = leaf(firstId + 1 + i, forms[form]);
  });
  return keys;
}

/** A string-array parent plus its children, ids counted up from `firstId`. */
export function arrayKeys(key, firstId, values) {
  const keys = { [key]: leaf(firstId, '', { string_array_child_keys: values.map((_, i) => firstId + 1 + i) }) };
  values.forEach((value, i) => {
    keys[`${key}.${i}`] = leaf(firstId + 1 + i, value);
  });
  return keys;
}

/**
 * Builds a release in memory with real hashes and sizes.
 *
 * - `bundles`: `{ id: { type, name, layout?, namespaces? } }`, listed in the manifest in this order.
 * - `slices`: `{ bundleId: { locale: sliceObject | string | Uint8Array } }`; a string or byte array
 *   is served as given.
 * - `extraTypes`: other file types (`strings`, `stringsdict`, `xml`) to list and serve per slice.
 * - `metaOverrides` / `manifestOverrides`: merged over the generated meta / manifest (the checksum
 *   is computed after the manifest overrides).
 * - `tamper`: `{ manifest: true }` serves manifest bytes that no longer match the checksum;
 *   `{ slices: { 'bundleId/locale': 'hash' | 'size' } }` serves a body with a wrong hash, or lists a
 *   wrong size.
 * - `hooks`: see createFetchFake; more can be added later with `release.hook(fn)`.
 *
 * `release.setMeta(overrides)` changes the meta served from then on (a new signature, say).
 */
export function buildRelease({
  mode = 'cdn',
  bundles,
  slices,
  extraTypes = [],
  metaOverrides = {},
  manifestOverrides = {},
  tamper = {},
  hooks = [],
  deliveryUrl = DELIVERY_URL,
} = {}) {
  const cdn = mode === 'cdn';
  const objects = new Map();
  const manifestSlices = {};
  const locales = [];

  for (const [bundleId, byLocale] of Object.entries(slices)) {
    manifestSlices[bundleId] = {};
    for (const [locale, slice] of Object.entries(byLocale)) {
      if (!locales.includes(locale)) locales.push(locale);
      const entries = {};
      const files = [['json', toBytes(slice)]];
      for (const type of extraTypes) files.push([type, toBytes(`${type} content for ${bundleId} ${locale}`)]);

      for (const [type, bytes] of files) {
        const hash = sha256Hex(bytes);
        const wrong = tamper.slices?.[`${bundleId}/${locale}`];
        let served = bytes;
        let size = bytes.length;
        if (type === 'json' && wrong === 'hash') {
          served = Uint8Array.from(bytes);
          served[served.length - 1] ^= 1;
        }
        if (type === 'json' && wrong === 'size') size += 1;
        entries[type] = { hash, size, transferSize: size };
        objects.set(`${hash}.${FILE_EXTENSIONS[type]}`, served);
      }
      manifestSlices[bundleId][locale] = entries;
    }
  }

  const manifest = {
    schemaVersion: 1,
    baseLocale: locales[0] ?? 'en',
    bundles,
    slices: manifestSlices,
    ...manifestOverrides,
  };
  const manifestBytes = toBytes(manifest);
  const servedManifestBytes = tamper.manifest ? toBytes(JSON.stringify(manifest).replace('"schemaVersion":1', '"schemaVersion": 1')) : manifestBytes;

  const manifestUrl = cdn
    ? 'https://cdn.example.invalid/releases/1/1/t1/m/abc123/manifest.json'
    : 'releases/7/manifest.json';
  const slicesBaseUrl = cdn ? 'https://cdn.example.invalid/releases/1/1/t1/slices/' : 'releases/7/slices/';

  let meta = {
    projectId: 1,
    generation: 1,
    resultsLastUpdate: 1700000000,
    checksum: sha256Hex(manifestBytes),
    schemaVersion: 1,
    keyCount: 1,
    totalBytes: [...objects.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    files: objects.size,
    truncatedCount: 0,
    builtAt: '2026-01-01T00:00:00.000Z',
    manifestUrl,
    slicesBaseUrl,
    authenticated: !cdn,
    track: 'web',
    stage: 'qa',
    releaseId: 1,
    releasedAt: '2026-01-01T00:00:00.000Z',
    movedAt: '2026-01-01T00:00:00.000Z',
    sequence: 1,
    pollAfter: 900,
    signedQuery: cdn ? SIGNED_QUERY : null,
    signatureExpires: cdn ? 1900000000 : null,
    ...metaOverrides,
  };

  const resolve = (url) => {
    const bare = stripQuery(url);
    if (bare === stripQuery(deliveryUrl)) {
      return { kind: 'meta', name: 'meta', answer: () => respond(200, JSON.stringify(meta)) };
    }
    if (bare === stripQuery(new URL(meta.manifestUrl, deliveryUrl).href)) {
      return { kind: 'manifest', name: 'manifest', answer: () => respond(200, servedManifestBytes) };
    }
    const base = new URL(meta.slicesBaseUrl, deliveryUrl).href;
    if (bare.startsWith(base)) {
      const name = bare.slice(base.length);
      return {
        kind: 'object',
        name,
        answer: () => (objects.has(name) ? respond(200, objects.get(name)) : problem(404, 'delivery.object_not_found')),
      };
    }
    return null;
  };

  const fake = createFetchFake(resolve, [...hooks]);

  return {
    fetch: fake.fetch,
    requests: fake.requests,
    hook: fake.hook,
    deliveryUrl,
    manifest,
    get meta() {
      return meta;
    },
    setMeta(overrides) {
      meta = { ...meta, ...overrides };
    },
    // Object file name (`<hash>.json`) of one bundle's slice, to match in hooks and requests.
    objectName(bundleId, locale, type = 'json') {
      return `${manifest.slices[bundleId][locale][type].hash}.${FILE_EXTENSIONS[type]}`;
    },
  };
}

export function requestsOfKind(release, kind) {
  const meta = release.meta ?? {};
  const deliveryBare = stripQuery(release.deliveryUrl);
  const manifestBare = meta.manifestUrl ? stripQuery(new URL(meta.manifestUrl, release.deliveryUrl).href) : null;
  const slicesBase = meta.slicesBaseUrl ? new URL(meta.slicesBaseUrl, release.deliveryUrl).href : null;
  return release.requests.filter(({ url }) => {
    const bare = stripQuery(url);
    if (kind === 'meta') return bare === deliveryBare;
    if (kind === 'manifest') return bare === manifestBare;
    return slicesBase !== null && bare.startsWith(slicesBase);
  });
}
