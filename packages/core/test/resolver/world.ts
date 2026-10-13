import { createSnapshot } from '../../src/index.js';
import type { BundleRef, Install, Slice, Snapshot, SnapshotInput, SnapshotReport } from '../../src/index.js';
import { makeInstall } from '../helpers/store-contract.js';

export const DEFAULT: BundleRef = { type: 'namespace', name: 'default' };

export interface BundleSpec {
  type: string;
  name: string;
  layout?: string;
  namespaces?: string[];
}

export interface World {
  install: Install;
  slices: Map<string, Uint8Array>;
}

export function leaf(id: number | string, value: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: String(id), value, tags: [], ...extra };
}

/** A plural parent plus one child per form, ids counted up from `firstId`. */
export function pluralKeys(key: string, firstId: number, forms: Record<string, string>, parentValue = '') {
  const names = Object.keys(forms);
  const keys: Record<string, Record<string, unknown>> = {
    [key]: leaf(firstId, parentValue, { plural_child_keys: names.map((_, i) => firstId + 1 + i) }),
  };
  names.forEach((form, i) => {
    keys[`${key}.${form}`] = leaf(firstId + 1 + i, forms[form]);
  });
  return keys;
}

/** A string-array parent plus its children, ids counted up from `firstId`. */
export function arrayKeys(key: string, firstId: number, values: string[]) {
  const keys: Record<string, Record<string, unknown>> = {
    [key]: leaf(firstId, '', { string_array_child_keys: values.map((_, i) => firstId + 1 + i) }),
  };
  values.forEach((value, i) => {
    keys[`${key}.${i}`] = leaf(firstId + 1 + i, value);
  });
  return keys;
}

export function flatSlice(bundle: string, locale: string, keys: Record<string, unknown>): Slice {
  return { schemaVersion: 1, bundle, locale, keys };
}

const encode = (body: unknown): Uint8Array =>
  body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));

/**
 * An install whose manifest lists `bundles` and whose slots hold `slices` (bundle id → locale →
 * slice object, text or bytes). The hashes are made up: the snapshot only looks them up.
 */
export function world(bundles: Record<string, BundleSpec>, slices: Record<string, Record<string, unknown>>): World {
  const slots: Record<string, string> = {};
  const held = new Map<string, Uint8Array>();
  const manifestSlices: Record<string, Record<string, { hash: string; size: number }>> = {};
  for (const [bundleId, byLocale] of Object.entries(slices)) {
    manifestSlices[bundleId] = {};
    for (const [locale, body] of Object.entries(byLocale)) {
      const bytes = encode(body);
      const hash = `hash-${bundleId}-${locale}`;
      slots[`${bundleId}\n${locale}`] = hash;
      held.set(hash, bytes);
      manifestSlices[bundleId]![locale] = { hash, size: bytes.length };
    }
  }
  const manifestBundles: Record<string, { type: string; name: string; layout?: string; namespaces: string[] }> = {};
  for (const [id, spec] of Object.entries(bundles)) {
    manifestBundles[id] = { ...spec, namespaces: spec.namespaces ?? [] };
  }
  return {
    install: makeInstall(slots, { manifest: { schemaVersion: 1, bundles: manifestBundles, slices: manifestSlices } }),
    slices: held,
  };
}

/** One default bundle `ns1` holding the same keys in each locale. */
export function oneBundle(keys: Record<string, unknown>, locales: string[] = ['en']): World {
  const slices: Record<string, unknown> = {};
  for (const locale of locales) slices[locale] = flatSlice('ns1', locale, keys);
  return world({ ns1: DEFAULT }, { ns1: slices });
}

export function snapshotOf(held: World | null, extra: Partial<SnapshotInput> = {}): Snapshot {
  return createSnapshot({
    ...(held ? { install: held.install } : {}),
    slices: held ? held.slices : new Map(),
    embedded: [],
    locale: 'en',
    defaultBundle: DEFAULT,
    ...extra,
  });
}

/** Snapshot of one default bundle with these keys in each of `locales`; the first is selected. */
export function snapshotWith(
  keys: Record<string, unknown>,
  options: { locales?: string[]; locale?: string } & Partial<SnapshotInput> = {},
): Snapshot {
  const { locales = ['en'], locale = locales[0], ...rest } = options;
  return snapshotOf(oneBundle(keys, locales), { locale: locale ?? 'en', ...rest });
}

export function reporter() {
  const reports: SnapshotReport[] = [];
  return { reports, report: (r: SnapshotReport) => void reports.push(r), codes: () => reports.map((r) => r.code) };
}
