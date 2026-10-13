/** A slice as the server sends it, and as `embedded` takes it. */
export interface Slice {
  schemaVersion: number;
  bundle: string;
  locale: string;
  keys?: Record<string, unknown>;
  namespaces?: Record<string, Record<string, unknown>>;
}

export interface Leaf {
  id: string;
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
  byId: Map<string, { key: string; leaf: Leaf }>;
}

/** Null for anything but a readable version-1 slice. Never throws. */
export function decodeSlice(_value: unknown): DecodedSlice | null {
  throw new Error('not implemented');
}
