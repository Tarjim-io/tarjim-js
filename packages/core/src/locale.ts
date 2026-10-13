export type LocaleSource = 'explicit' | 'saved' | 'browser' | 'fallback';

export interface LocaleChoice {
  explicit?: string;
  saved?: string;
  browser: readonly string[];
  fallback: string;
  /** The held manifest's locales and the embedded slices' locales. */
  universe: readonly string[];
  /** Whether a manifest is held. Until one is, an explicit language is taken as given. */
  manifestHeld?: boolean;
}

/** One locale for the whole visitor. */
export function selectLocale(choice: LocaleChoice): { locale: string; source: LocaleSource } {
  const { explicit, saved, browser, fallback, universe, manifestHeld = false } = choice;
  if (explicit) {
    const match = matchLocale(explicit, universe);
    if (match !== null) return { locale: match, source: 'explicit' };
    // Before a manifest arrives the universe is at most the embedded slices, which must not veto the page's choice.
    if (!manifestHeld) return { locale: explicit, source: 'explicit' };
  }
  const savedMatch = saved ? matchLocale(saved, universe) : null;
  if (savedMatch !== null) return { locale: savedMatch, source: 'saved' };
  for (const wanted of browser) {
    const match = matchLocale(wanted, universe);
    if (match !== null) return { locale: match, source: 'browser' };
  }
  return { locale: fallback, source: 'fallback' };
}

interface Parsed {
  tag: string;
  base: string;
  language: string;
  script: string;
}

function parse(tag: string): Parsed | null {
  try {
    const locale = new Intl.Locale(tag);
    // The likely script keeps zh-Hans apart from zh-Hant, and sr (Cyrillic) from sr-Latn, without a table.
    const script = locale.maximize().script ?? '';
    return { tag, base: locale.baseName.toLowerCase(), language: locale.language, script };
  } catch {
    return null;
  }
}

/** The entry of `available` that serves `wanted`, spelled as `available` spells it, or null. */
export function matchLocale(wanted: string, available: readonly string[]): string | null {
  const target = parse(wanted);
  if (target === null) return null;

  const candidates: Parsed[] = [];
  for (const tag of available) {
    const parsed = parse(tag);
    if (parsed !== null && parsed.language === target.language && parsed.script === target.script) candidates.push(parsed);
  }
  // The exact tag first, then the least specific one; sorted order settles what is left.
  const rank = (candidate: Parsed): [number, number] => [candidate.base === target.base ? 0 : 1, candidate.base.split('-').length];
  candidates.sort((a, b) => {
    const [exactA, partsA] = rank(a);
    const [exactB, partsB] = rank(b);
    return exactA - exactB || partsA - partsB || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
  });
  return candidates[0]?.tag ?? null;
}
