import { createDeliveryClient } from './delivery-client.js';
import { deliveryUrlProblem } from './delivery-url.js';
import { parseJson } from './json.js';
import { localeKey } from './locale.js';
import { compareBundleIds } from './manifest.js';
import type { Slice } from './slice.js';
import type { FetchFunction, ManifestOutcome, MetaOutcome, SliceFile, SliceOutcome } from './types.js';

export interface PullOptions {
  deliveryUrl: string;
  apiKey: string;
  /** Bundle names, as the console shows them. Absent or empty: every bundle in the release. */
  bundles?: readonly string[];
  /** Locale tags, matched whatever their case. Absent or empty: every locale of each chosen bundle. */
  locales?: readonly string[];
  appVersion?: string;
  fetch: FetchFunction;
}

/** What a pull wrote, per bundle name, in the order of `slices`. */
export interface PulledBundle {
  bundle: string;
  locales: string[];
}

export type PullResult =
  | { ok: true; slices: Slice[]; contents: PulledBundle[]; releaseId: string; checksum: string }
  | { ok: false; reason: string };

const fail = (reason: string): PullResult => ({ ok: false, reason });

function metaFailure(outcome: Exclude<MetaOutcome, { kind: 'received' }>): string {
  switch (outcome.kind) {
    case 'unreleased':
      return 'the stage has no release for this app version yet';
    case 'configuration':
      return `the delivery server refused the request (${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}); check the URL and key`;
    case 'throttled':
      return 'the delivery server is throttling this key; try again later';
    case 'server':
      return `the delivery server answered ${outcome.status}; try again later`;
    case 'unreadable':
      return 'the meta answer is not readable';
    case 'network':
      return 'a network error stopped the meta request';
  }
}

function fetchFailure(what: string, outcome: Exclude<ManifestOutcome | SliceOutcome, { kind: 'verified' }>): string {
  switch (outcome.kind) {
    case 'checksumMismatch':
      return `the ${what} does not match its checksum`;
    case 'hashMismatch':
      return `the ${what} does not match its hash`;
    case 'sizeMismatch':
      return `the ${what} does not have the size the manifest lists`;
    case 'unreadable':
      return `the ${what} is not readable`;
    case 'throttled':
      return `the ${what} request was throttled; try again later`;
    case 'network':
      return `a network error stopped the ${what} request`;
    case 'refused':
      return `the ${what} request was refused`;
    case 'unfetchable':
    case 'server':
      return `the ${what} request answered ${outcome.status}`;
  }
}

/**
 * Downloads slices of the stage's current release, verified the same way the SDK verifies them,
 * for use as `embedded`. Either every requested slice is returned or none is.
 */
export async function pull(options: PullOptions): Promise<PullResult> {
  const urlProblem = deliveryUrlProblem(options.deliveryUrl);
  if (urlProblem !== null) return fail(`the delivery URL is not usable: ${urlProblem}`);
  if (!options.apiKey) return fail('no key: set TARJIM_APIKEY to the stage key');

  try {
    const client = createDeliveryClient({
      deliveryUrl: options.deliveryUrl,
      apiKey: options.apiKey,
      platform: 'cli',
      fetch: options.fetch,
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    });

    const meta = await client.fetchMeta({});
    if (meta.kind !== 'received') return fail(metaFailure(meta));
    const manifest = await client.fetchManifest(meta.meta);
    if (manifest.kind !== 'verified') return fail(fetchFailure('manifest', manifest));
    const { bundles, slices } = manifest.manifest;

    const wantedNames = options.bundles?.length ? options.bundles : undefined;
    const bundleIds = Object.keys(bundles).filter((id) => wantedNames === undefined || wantedNames.includes(bundles[id]!.name));
    for (const name of wantedNames ?? []) {
      if (!bundleIds.some((id) => bundles[id]!.name === name)) return fail(`bundle "${name}" is not in the release`);
    }

    const wantedLocales = options.locales?.length ? options.locales : undefined;
    const chosen: { bundle: string; locale: string; file: SliceFile }[] = [];
    for (const id of bundleIds) {
      const byLocale = slices[id] ?? {};
      for (const tag of wantedLocales ?? Object.keys(byLocale)) {
        const locale = Object.keys(byLocale).find((name) => localeKey(name) === localeKey(tag));
        if (locale === undefined) return fail(`locale "${tag}" is not in bundle "${bundles[id]!.name}"`);
        chosen.push({ bundle: id, locale, file: byLocale[locale]! });
      }
    }
    chosen.sort((a, b) => compareBundleIds(a.bundle, b.bundle) || (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));

    const fetched = await client.fetchSlices(meta.meta, chosen.map(({ file }) => file), {});
    const pulled: Slice[] = [];
    for (const { bundle, locale, file } of chosen) {
      const outcome = fetched.results.get(file.hash) ?? { kind: 'network' as const };
      if (outcome.kind !== 'verified') return fail(fetchFailure(`slice ${bundle}/${locale}`, outcome));
      const value = parseJson(outcome.bytes);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(`the slice ${bundle}/${locale} is not readable`);
      pulled.push(value as Slice);
    }
    const contents: PulledBundle[] = [];
    for (const { bundle, locale } of chosen) {
      const name = bundles[bundle]!.name;
      const last = contents[contents.length - 1];
      if (last?.bundle === name) last.locales.push(locale);
      else contents.push({ bundle: name, locales: [locale] });
    }
    return { ok: true, slices: pulled, contents, releaseId: String(meta.meta.releaseId), checksum: meta.meta.checksum };
  } catch {
    return fail('the download stopped unexpectedly');
  }
}
