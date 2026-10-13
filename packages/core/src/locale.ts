export type LocaleSource = 'explicit' | 'saved' | 'browser' | 'fallback';

export interface LocaleChoice {
  explicit?: string;
  saved?: string;
  browser: readonly string[];
  fallback: string;
  /** The held manifest's locales and the embedded slices' locales. */
  universe: readonly string[];
}

/** One locale for the whole visitor. */
export function selectLocale(_choice: LocaleChoice): { locale: string; source: LocaleSource } {
  throw new Error('not implemented');
}

/** The entry of `available` that serves `wanted`, spelled as `available` spells it, or null. */
export function matchLocale(_wanted: string, _available: readonly string[]): string | null {
  throw new Error('not implemented');
}
