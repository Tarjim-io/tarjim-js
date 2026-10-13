import { isRecord, parseJson } from './json.js';
import { localeKey } from './locale.js';
import { decodeSlice } from './slice.js';
import type { DecodedSlice, Leaf, Slice } from './slice.js';
import { slotName } from './store.js';
import type { Install } from './store.js';
import type { ManifestBundle } from './types.js';

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

export interface FormatOptions {
  /** The value was chosen through a plural form, so a lone printf placeholder takes `count`. */
  plural?: boolean;
  count?: number;
  legacyPercentPlaceholders?: boolean;
}

const NAMED_PLACEHOLDER = /\{([^{}]+)\}/y;
const LEGACY_PLACEHOLDER = /%%([^%\s]+)%%/y;
const PRINTF_PLACEHOLDER = /%(?:(\d+)\$)?([sd@])/y;

// Sticky patterns match only at the given position, so no copy of the rest of the text is made.
function matchAt(pattern: RegExp, text: string, position: number): RegExpExecArray | null {
  pattern.lastIndex = position;
  return pattern.exec(text);
}

const hasOwn = (object: object, name: string): boolean => Object.prototype.hasOwnProperty.call(object, name);

/**
 * One left-to-right scan; what is inserted is never scanned again.
 *   {name}           object arguments
 *   %s %d %@ %1$s    array arguments; %% is a literal percent sign
 *   %%name%%         object arguments, only with legacyPercentPlaceholders
 */
export function format(text: string, args: FormatArgs, options: FormatOptions = {}): string {
  try {
    return formatText(text, args, options);
  } catch {
    return typeof text === 'string' ? text : '';
  }
}

function formatText(text: string, args: FormatArgs, options: FormatOptions): string {
  const named = isRecord(args) ? args : null;
  let positional = Array.isArray(args) ? (args as readonly unknown[]) : null;
  // Inside a plural value the count stands in for every printf argument.
  const countOnly = named !== null && options.plural === true && options.count !== undefined;
  if (countOnly) positional = [options.count];
  if (named === null && positional === null) return text;

  let out = '';
  let next = 0;
  let i = 0;
  // Plain text is copied in runs, from `copied` up to the next placeholder.
  let copied = 0;
  while (i < text.length) {
    let match: RegExpExecArray | null;
    let length = 0;
    let replacement: string | undefined;
    const char = text.charAt(i);
    if (char === '{') {
      if (named && (match = matchAt(NAMED_PLACEHOLDER, text, i)) && hasOwn(named, match[1]!)) {
        length = match[0].length;
        replacement = stringify(named[match[1]!]);
      }
    } else if (char === '%') {
      if (options.legacyPercentPlaceholders && named && (match = matchAt(LEGACY_PLACEHOLDER, text, i)) && hasOwn(named, match[1]!)) {
        length = match[0].length;
        replacement = stringify(named[match[1]!]);
      } else if (positional && (match = matchAt(PRINTF_PLACEHOLDER, text, i))) {
        const index = match[1] ? Number(match[1]) - 1 : countOnly ? 0 : next++;
        length = match[0].length;
        if (index >= 0 && index < positional.length) replacement = stringify(positional[index]);
      } else if (positional && text.charAt(i + 1) === '%') {
        length = 2;
        replacement = '%';
      }
    }
    if (length === 0) {
      i += 1;
    } else if (replacement === undefined) {
      i += length;
    } else {
      out += text.slice(copied, i) + replacement;
      i += length;
      copied = i;
    }
  }
  return out + text.slice(copied);
}

// An argument whose own conversion throws leaves its placeholder as authored.
function stringify(value: unknown): string | undefined {
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

// Bundle ids compare by their number ("ns7" before "ns10"), then as text.
function compareBundleIds(a: string, b: string): number {
  const x = a.replace(/\D/g, '').replace(/^0+/, '');
  const y = b.replace(/\D/g, '').replace(/^0+/, '');
  if (x.length !== y.length) return x.length - y.length;
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const bundleKey = (type: unknown, name: unknown): string =>
  typeof type === 'string' && typeof name === 'string' ? `${type}\n${name}` : '';

/** A decoded slice with the namespaces in the order they are searched. */
interface Source {
  slice: DecodedSlice;
  order: string[];
  flat: boolean;
}

// Namespaces are searched in the order the manifest lists them, then any others, sorted; the order
// of the keys inside the slice plays no part.
function sourceOf(slice: DecodedSlice, listed: readonly string[]): Source {
  const names = [...slice.namespaces.keys()];
  const flat = names.length === 1 && names[0] === '';
  const others = names.filter((name) => !listed.includes(name)).sort();
  return { slice, flat, order: flat ? [''] : [...listed, ...others] };
}

function pluralRulesFor(locale: string): Intl.PluralRules | null {
  try {
    // A well-formed tag with no data would otherwise take the rules of the runtime's own locale.
    return Intl.PluralRules.supportedLocalesOf(locale).length > 0 ? new Intl.PluralRules(locale) : null;
  } catch {
    return null;
  }
}

const MEDIA_TYPES = ['image', 'audio/video', 'file'] as const;
const ALLOWED_ATTRIBUTES = ['alt', 'title', 'width', 'height', 'loading'];

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function createSnapshot(input: SnapshotInput): Snapshot {
  const { install, locale, defaultBundle, legacyPercentPlaceholders = false } = input;
  const report = (found: SnapshotReport): void => {
    try {
      input.report?.(found);
    } catch {
      // A reporter that throws must not take a lookup down with it.
    }
  };

  const wantedKey = localeKey(locale);
  const embedded: DecodedSlice[] = [];
  for (const raw of Array.isArray(input.embedded) ? input.embedded : []) {
    const slice = decodeSlice(raw);
    if (slice !== null && localeKey(slice.locale) === wantedKey) embedded.push(slice);
  }

  const readSlot = (bundleId: string): DecodedSlice | null => {
    // The slot is named with the manifest's spelling of the locale, which may differ in case from ours.
    const spelling = Object.keys(install?.manifest.slices[bundleId] ?? {}).find((name) => localeKey(name) === wantedKey) ?? locale;
    const hash = install?.slots[slotName(bundleId, spelling)];
    if (hash === undefined) return null;
    const value = parseJson(input.slices.get(hash));
    const slice = decodeSlice(value);
    if (slice === null && isRecord(value) && value['schemaVersion'] !== 1) {
      const version = value['schemaVersion'];
      report(typeof version === 'number' && Number.isFinite(version) ? { code: 'slice-schema', details: { schemaVersion: version } } : { code: 'slice-schema' });
    }
    return slice;
  };

  // What answers for each bundle, downloaded copy first. With an install only the bundles its
  // manifest lists are served, and of those sharing a type and name only the lowest id, even when
  // that one has nothing for this locale: a lookup never moves on to another bundle of the name.
  const served = new Map<string, Source[]>();
  const listed = new Set<string>();
  if (install) {
    const chosen = new Map<string, { id: string; bundle: ManifestBundle }>();
    for (const [id, bundle] of Object.entries(install.manifest.bundles)) {
      listed.add(id);
      const key = bundleKey(bundle.type, bundle.name);
      const current = chosen.get(key);
      if (current === undefined || compareBundleIds(id, current.id) < 0) chosen.set(key, { id, bundle });
    }
    for (const [key, { id, bundle }] of chosen) {
      const downloaded = readSlot(id);
      const copies = embedded.filter((slice) => slice.bundle === id);
      served.set(key, (downloaded ? [downloaded, ...copies] : copies).map((slice) => sourceOf(slice, bundle.namespaces)));
    }
  }
  // An embedded slice the manifest does not list has nothing to match it to a bundle, so it answers
  // the default one, after every source that was matched; that keeps a dropped or renumbered default
  // bundle readable.
  const defaultKey = bundleKey(defaultBundle.type, defaultBundle.name);
  const unmatched = embedded.filter((slice) => !listed.has(slice.bundle)).map((slice) => sourceOf(slice, []));
  served.set(defaultKey, [...(served.get(defaultKey) ?? []), ...unmatched]);

  const pluralRules = pluralRulesFor(locale);

  // Runs `read` over each source that holds the key, downloaded first; a source answers by
  // returning anything but undefined.
  function find<T>(
    key: string,
    options: LookupOptions | undefined,
    read: (leaf: Leaf, ids: ReadonlyMap<string, { key: string; leaf: Leaf }>) => T | undefined,
  ): T | undefined {
    const requested: unknown = options?.bundle;
    const bundle = isRecord(requested) ? requested : defaultBundle;
    const namespace: unknown = options?.namespace;
    for (const source of served.get(bundleKey(bundle['type'], bundle['name'])) ?? []) {
      const names = typeof namespace === 'string' && !source.flat ? [namespace] : source.order;
      for (const name of names) {
        const leaf = source.slice.namespaces.get(name)?.get(key);
        if (leaf === undefined) continue;
        const answer = read(leaf, source.slice.byId.get(name) ?? new Map());
        if (answer !== undefined) return answer;
        break;
      }
    }
    return undefined;
  }

  // A listed child counts only when its name is "<key>.<form>"; a key that merely has such a name
  // is not a plural form.
  function pluralChild(ids: ReadonlyMap<string, { key: string; leaf: Leaf }>, leaf: Leaf, key: string, form: string): Leaf | null {
    for (const id of leaf.pluralChildIds ?? []) {
      const child = ids.get(id);
      if (child !== undefined && child.key === `${key}.${form}`) return child.leaf;
    }
    return null;
  }

  function translate(key: string, args: FormatArgs | undefined, options: LookupOptions | undefined): string {
    const count = isRecord(args) ? args['count'] : undefined;
    const answer = find(key, options, (leaf, ids) => {
      if (leaf.pluralChildIds && args !== undefined && typeof count === 'number') {
        const form = count === 0 && pluralChild(ids, leaf, key, 'zero') ? 'zero' : pluralRules?.select(count) ?? 'other';
        const value = pluralChild(ids, leaf, key, form)?.value || pluralChild(ids, leaf, key, 'other')?.value || leaf.value;
        return value ? format(value, args, { plural: true, count, legacyPercentPlaceholders }) : undefined;
      }
      if (!leaf.value) return undefined;
      return args === undefined ? leaf.value : format(leaf.value, args, { legacyPercentPlaceholders });
    });
    return answer ?? key;
  }

  function translateArray(key: string, options: LookupOptions | undefined): string[] {
    return (
      find(key, options, (leaf, ids) => {
        const values: string[] = [];
        for (const id of leaf.arrayChildIds ?? []) {
          const value = ids.get(id)?.leaf.value;
          if (value !== undefined) values.push(value);
        }
        return values.length > 0 ? values : undefined;
      }) ?? []
    );
  }

  function entryOf(key: string, options: LookupOptions | undefined): TarjimEntry | null {
    return (
      find(key, options, (leaf): TarjimEntry | null | undefined => {
        if (!leaf.value || leaf.id === undefined) return undefined;
        const attributes: Record<string, string> = {};
        let dropped = 0;
        for (const [name, value] of Object.entries(leaf.attributes ?? {})) {
          if (ALLOWED_ATTRIBUTES.includes(name) && typeof value === 'string') attributes[name] = value;
          else dropped++;
        }
        // Only a count: a dropped name comes from the server and may carry anything.
        if (dropped > 0) report({ code: 'attribute-dropped', details: { count: dropped } });
        const type = leaf.type === undefined || leaf.type === 'text' ? 'text' : MEDIA_TYPES.find((media) => media === leaf.type);
        // The page puts a media value into src or href, where a script or data URL would run. A type
        // this client does not know is refused too, rather than served as text.
        if (type !== 'text' && (type === undefined || !isHttpsUrl(leaf.value))) {
          report({ code: 'media-url-rejected' });
          return null;
        }
        return {
          value: leaf.value,
          id: leaf.id,
          type,
          attributes: Object.keys(attributes).length > 0 ? attributes : null,
          className: leaf.className ?? null,
        };
      }) ?? null
    );
  }

  // No lookup throws, whatever the slices or the arguments hold.
  const snapshot: Snapshot = {
    language: locale,
    t(key, args, options) {
      try {
        return translate(String(key), args, options);
      } catch {
        return typeof key === 'string' ? key : '';
      }
    },
    tArray(key, options) {
      try {
        return translateArray(String(key), options);
      } catch {
        return [];
      }
    },
    entry(key, options) {
      try {
        return entryOf(String(key), options);
      } catch {
        return null;
      }
    },
  };
  return Object.freeze(snapshot);
}
