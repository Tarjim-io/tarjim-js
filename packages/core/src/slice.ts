import { entriesOf, isRecord } from './json.js';

// Key and namespace names go into Maps, where "__proto__" is just a name, so they are read with Object.entries.

/** A slice as the server sends it, and as `embedded` takes it. */
export interface Slice {
  schemaVersion: number;
  bundle: string;
  locale: string;
  keys?: Record<string, unknown>;
  namespaces?: Record<string, Record<string, unknown>>;
}

export interface Leaf {
  /** Missing when the server's id is neither a string nor a finite number. */
  id?: string;
  /** Missing when the server's value is not a string. */
  value?: string;
  type?: string;
  attributes: Record<string, unknown> | null;
  className?: string;
  pluralChildIds?: string[];
  arrayChildIds?: string[];
}

export interface DecodedSlice {
  bundle: string;
  locale: string;
  /** Flat slices have one namespace, keyed ''. */
  namespaces: Map<string, Map<string, Leaf>>;
  /** The first leaf with each id, for finding the children a parent lists. */
  byId: Map<string, { key: string; leaf: Leaf }>;
}

const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : undefined;

const idList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.map(idOf).filter((id): id is string => id !== undefined) : undefined;

function decodeLeaf(raw: unknown): Leaf | null {
  if (!isRecord(raw)) return null;
  const leaf: Leaf = { attributes: isRecord(raw['attributes']) ? Object.fromEntries(entriesOf(raw['attributes'])) : null };
  const id = idOf(raw['id']);
  if (id !== undefined) leaf.id = id;
  if (typeof raw['value'] === 'string') leaf.value = raw['value'];
  if (typeof raw['type'] === 'string') leaf.type = raw['type'];
  // The class ends up in an attribute, so anything that could close it is dropped here, once.
  if (typeof raw['class'] === 'string' && /^[A-Za-z0-9_ -]*$/.test(raw['class'])) leaf.className = raw['class'];
  const pluralChildIds = idList(raw['plural_child_keys']);
  if (pluralChildIds) leaf.pluralChildIds = pluralChildIds;
  const arrayChildIds = idList(raw['string_array_child_keys']);
  if (arrayChildIds) leaf.arrayChildIds = arrayChildIds;
  return leaf;
}

function decodeLeaves(raw: unknown): Map<string, Leaf> {
  const leaves = new Map<string, Leaf>();
  if (!isRecord(raw)) return leaves;
  for (const [key, value] of Object.entries(raw)) {
    const leaf = decodeLeaf(value);
    if (leaf) leaves.set(key, leaf);
  }
  return leaves;
}

/** Null for anything but a readable version-1 slice. Never throws. */
export function decodeSlice(value: unknown): DecodedSlice | null {
  try {
    if (!isRecord(value) || value['schemaVersion'] !== 1) return null;
    const namespaces = new Map<string, Map<string, Leaf>>();
    if (isRecord(value['namespaces'])) {
      for (const [name, keys] of Object.entries(value['namespaces'])) {
        if (isRecord(keys)) namespaces.set(name, decodeLeaves(keys));
      }
    } else {
      namespaces.set('', decodeLeaves(value['keys']));
    }
    const byId = new Map<string, { key: string; leaf: Leaf }>();
    for (const leaves of namespaces.values()) {
      for (const [key, leaf] of leaves) {
        if (leaf.id !== undefined && !byId.has(leaf.id)) byId.set(leaf.id, { key, leaf });
      }
    }
    return {
      bundle: typeof value['bundle'] === 'string' ? value['bundle'] : '',
      locale: typeof value['locale'] === 'string' ? value['locale'] : '',
      namespaces,
      byId,
    };
  } catch {
    return null;
  }
}
