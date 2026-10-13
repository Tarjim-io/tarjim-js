import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Tarjim } from '@tarjim/browser';
import { TarjimLanguageError } from '@tarjim/core';
import type { CheckResult, Tarjim as Runtime, TarjimConfig } from '@tarjim/core';
import { createSnapshot, matchLocale, selectLocale } from '@tarjim/core/internal';

export interface TarjimProviderProps {
  config: TarjimConfig;
  children?: ReactNode;
  /** Rendered until the local text is ready, for at most about a second. */
  fallback?: ReactNode;
  /** Apply a downloaded release as soon as it arrives instead of at the next page load. */
  activateImmediately?: boolean;
  /** Set `<html lang>` and `dir` from the language. */
  setDocumentLanguage?: boolean;
  /** The provider mounts on server- or build-rendered HTML: serve the embedded text only, for the page's whole life. */
  hydrating?: boolean;
  /** Starts the SDK; defaults to `Tarjim.start` from @tarjim/browser. */
  start?: (config: TarjimConfig) => Promise<Runtime>;
}

export interface TarjimContextValue {
  t: Runtime['t'];
  tArray: Runtime['tArray'];
  entry: Runtime['entry'];
  language: string;
  setLanguage(language: string): Promise<void>;
  checkNow(): Promise<CheckResult>;
  ready: boolean;
  pendingUpdate: boolean;
}

/** What the provider reads from either the running SDK or, on a hydrating page, the embedded text. */
type Source = Pick<Runtime, 'language' | 'ready' | 't' | 'tArray' | 'entry' | 'setLanguage' | 'checkNow' | 'subscribe' | 'getVersion'>;

const WAIT_MS = 1000;
const RTL = ['ar', 'fa', 'he', 'ur', 'ps', 'yi', 'dv', 'ckb'];

// Bundlers replace `process.env.NODE_ENV`; where nothing does, the read throws and there is no dev mode.
function dev(): boolean {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

function direction(language: string): 'rtl' | 'ltr' {
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & { getTextInfo?(): { direction: string }; textInfo?: { direction: string } };
    const info = locale.getTextInfo?.() ?? locale.textInfo;
    if (info) return info.direction === 'rtl' ? 'rtl' : 'ltr';
  } catch {
    // An unparseable tag falls through to the list.
  }
  return RTL.includes(language.split('-')[0]?.toLowerCase() ?? '') ? 'rtl' : 'ltr';
}

/**
 * A page built ahead of time shows the release it was built with, so its text comes from `embedded`
 * alone: no store, no request, and a language switch only between the embedded locales.
 */
function embeddedOnly(config: TarjimConfig): Source {
  const slices = Array.isArray(config.embedded) ? config.embedded : [];
  if (!Array.isArray(config.embedded) && dev()) console.error('[tarjim] hydrating needs `embedded` to be an array of slices; rendering the keys.');
  // As in the SDK: an entry that is not a record with a string locale takes no part in choosing the language.
  const locales = slices.flatMap((slice) => (typeof slice?.locale === 'string' ? [slice.locale] : []));
  const listeners = new Set<() => void>();
  let version = 0;
  const open = (locale: string) =>
    createSnapshot({
      slices: new Map(),
      embedded: slices,
      locale,
      defaultBundle: config.defaultBundle,
      legacyPercentPlaceholders: config.legacyPercentPlaceholders === true,
    });
  // The browser's languages are left out: the server render cannot know them, and the two must agree.
  let snapshot = open(
    selectLocale({ ...(config.language ? { explicit: config.language } : {}), browser: [], fallback: config.fallbackLanguage, universe: locales, manifestHeld: true }).locale,
  );

  return {
    ready: true,
    get language() {
      return snapshot.language;
    },
    get t() {
      return snapshot.t;
    },
    get tArray() {
      return snapshot.tArray;
    },
    get entry() {
      return snapshot.entry;
    },
    async setLanguage(language) {
      const match = matchLocale(language, locales);
      if (match === null) throw new TarjimLanguageError('There is no text for that language.');
      if (match === snapshot.language) return;
      snapshot = open(match);
      version += 1;
      for (const listener of [...listeners]) listener();
    },
    checkNow: async () => 'notDue',
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getVersion: () => version,
  };
}

const Context = createContext<TarjimContextValue | null>(null);

const never = () => () => undefined;
const zero = () => 0;
const keyOnly: Runtime['t'] = (key) => key;
const noArray: Runtime['tArray'] = () => [];
const noEntry: Runtime['entry'] = () => null;

export function TarjimProvider({
  config,
  children,
  fallback = null,
  activateImmediately = false,
  setDocumentLanguage = true,
  hydrating = false,
  start = (given) => Tarjim.start(given),
}: TarjimProviderProps): ReactNode {
  // Everything that must outlive a render without causing one. The configuration is read here, once.
  const [own] = useState(() => {
    const local = hydrating ? embeddedOnly(config) : undefined;
    // Settled by the start effect, which runs after those of the children: an earlier call waits here.
    let open!: (starting: Promise<Source>) => void;
    const wait = new Promise<Source>((resolve) => (open = resolve));
    const state = {
      open,
      config,
      hydrating,
      local,
      language: config.language,
      activateImmediately,
      noted: new Set<string>(),
      reported: false,
      gone: false,
      runtime: undefined as Runtime | undefined,
      started: local && (Promise.resolve(local) as Promise<Source>),
      setLanguage: (language: string): Promise<void> => (state.started ?? wait).then((source) => source.setLanguage(language)),
      checkNow: (): Promise<CheckResult> => (state.started ?? wait).then((source) => source.checkNow()),
    };
    return state;
  });
  const [source, setSource] = useState<Source | undefined>(own.local);
  const [pending, setPending] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // Hydration needs a server snapshot; the embedded text is the same on both sides.
  const version = useSyncExternalStore(source?.subscribe ?? never, source?.getVersion ?? zero, source?.getVersion ?? zero);

  const note = (code: string, message: string): void => {
    if (own.noted.has(code) || !dev()) return;
    own.noted.add(code);
    console.warn(`[tarjim] ${message}`);
  };

  useEffect(() => {
    own.activateImmediately = activateImmediately;
  });

  useEffect(() => {
    if (own.hydrating) {
      if (own.config.waitForContent !== undefined) note('wait', 'waitForContent is ignored while hydrating: the page shows its embedded text.');
      if (own.config.embedded !== undefined && !Array.isArray(own.config.embedded) && !own.reported) {
        own.reported = true;
        try {
          own.config.onReport?.({ code: 'embedded-invalid', message: 'embedded must be an array of slices; ignored.' });
        } catch {
          // A callback that throws must not take the page down.
        }
      }
      return;
    }
    own.gone = false;
    if (!own.started) {
      // StrictMode runs this effect, its clean-up and the effect again before the SDK has answered: the
      // second run finds `started`, and the clean-up in between had no runtime to stop, only a flag to lift.
      const starting = start({ ...own.config, waitForContent: 0 });
      own.started = starting;
      own.open(starting);
      starting.then(
        (runtime) => {
          if (own.gone) {
            // Cleared so that an effect that runs again (a hidden subtree shown) starts a runtime of its own.
            own.started = undefined;
            return runtime.stop();
          }
          own.runtime = runtime;
          runtime.on('downloaded', () => (own.activateImmediately ? runtime.activatePendingUpdate() : setPending(true)));
          runtime.on('activated', () => setPending(false));
          setSource(runtime);
        },
        (error: unknown) => {
          if (own.gone) own.started = undefined;
          else setFailure(error);
        },
      );
    }
    return () => {
      own.gone = true;
      setPending(false);
      if (own.runtime) {
        own.runtime.stop();
        own.runtime = own.started = undefined;
        setSource(undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the SDK is started once per provider
  }, []);

  useEffect(() => {
    if (config !== own.config) note('config', 'The config object changed after the first render and is ignored; only `language` is applied. Create the config once, outside the component.');
  }, [config]);

  useEffect(() => {
    const { language } = config;
    if (!language || language === own.language) return;
    own.language = language;
    own.setLanguage(language).catch(() => note(`language ${language}`, `could not switch to '${language}'.`));
  }, [config.language]);

  useEffect(() => {
    if (source) return;
    const timer = setTimeout(() => setTimedOut(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, [source]);

  const language = source?.language ?? config.language ?? config.fallbackLanguage;
  useEffect(() => {
    if (!source || !setDocumentLanguage) return;
    document.documentElement.lang = language;
    document.documentElement.dir = direction(language);
  }, [source, language, setDocumentLanguage]);

  // `version` is only listed so that a changed snapshot makes a new value, and with it a new `t`.
  const value = useMemo<TarjimContextValue>(
    () => ({
      t: source?.t ?? keyOnly,
      tArray: source?.tArray ?? noArray,
      entry: source?.entry ?? noEntry,
      language: source?.language ?? own.config.language ?? own.config.fallbackLanguage,
      setLanguage: own.setLanguage,
      checkNow: own.checkNow,
      ready: source?.ready ?? false,
      pendingUpdate: pending,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, version, pending],
  );

  if (failure) throw failure;
  return <Context.Provider value={value}>{source || timedOut ? children : fallback}</Context.Provider>;
}

export function useTarjim(): TarjimContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useTarjim must be used inside a <TarjimProvider>.');
  return value;
}
