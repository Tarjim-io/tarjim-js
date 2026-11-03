import { HEX64, entriesOf, isRecord } from './json.js';
import type { Manifest, ManifestBundle, SliceFile } from './types.js';

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

// Lenient on purpose: an entry that is not understood is dropped, never reported. Only the JSON
// file of a slice is kept; no other file type is ever read, so a native bundle, which lists none,
// is dropped whole. Left in, it could shadow a JSON bundle of the same type and name.
/** Every bundle id, the last one winning a shared key. A bundle the list omits goes first, so it never beats a listed one. */
export function bundleOrderOf(manifest: Manifest): string[] {
  const listed = [...new Set(manifest.bundleOrder ?? [])].filter((id) => own(manifest.bundles, id));
  return [...Object.keys(manifest.bundles).filter((id) => !listed.includes(id)), ...listed];
}

export function decodeManifest(value: unknown): Manifest | null {
  return decode(value, (files) => (isRecord(files) ? files['json'] : undefined));
}

// A stored manifest is already reduced to the JSON file of each slice, so decoding it again with
// `decodeManifest` would drop every slice.
export function decodeStoredManifest(value: unknown): Manifest | null {
  return decode(value, (file) => file);
}

function decode(value: unknown, jsonFileOf: (files: unknown) => unknown): Manifest | null {
  try {
    if (!isRecord(value) || typeof value['schemaVersion'] !== 'number') return null;
    const { bundles, slices } = value;
    if (!isRecord(bundles) || !isRecord(slices)) return null;

    const manifest: Manifest = { schemaVersion: value['schemaVersion'], bundles: {}, slices: {} };
    for (const [id, bundle] of entriesOf(bundles)) {
      if (!isRecord(bundle) || typeof bundle['type'] !== 'string' || typeof bundle['name'] !== 'string') continue;
      const entry: ManifestBundle = {
        type: bundle['type'],
        name: bundle['name'],
        namespaces: Array.isArray(bundle['namespaces']) ? bundle['namespaces'].filter((n) => typeof n === 'string') : [],
      };
      if (typeof bundle['layout'] === 'string') entry.layout = bundle['layout'];
      manifest.bundles[id] = entry;
    }
    for (const [id, locales] of entriesOf(slices)) {
      if (!isRecord(locales)) continue;
      const decoded: Record<string, SliceFile> = {};
      for (const [locale, files] of entriesOf(locales)) {
        const json = jsonFileOf(files);
        if (!isRecord(json)) continue;
        const { hash, size } = json;
        if (typeof hash === 'string' && HEX64.test(hash) && Number.isSafeInteger(size) && (size as number) >= 0) {
          decoded[locale] = { hash, size: size as number };
        }
      }
      if (Object.keys(decoded).length) manifest.slices[id] = decoded;
      else delete manifest.bundles[id];
    }
    const order = value['bundleOrder'];
    const named = Array.isArray(order) ? order.filter((id): id is string => typeof id === 'string') : [];
    if (named.length) manifest.bundleOrder = named;
    return manifest;
  } catch {
    return null;
  }
}
