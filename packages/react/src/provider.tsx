import type { ReactNode } from 'react';
import type { CheckResult, Tarjim, TarjimConfig } from '@tarjim/core';

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
  start?: (config: TarjimConfig) => Promise<Tarjim>;
}

export interface TarjimContextValue {
  t: Tarjim['t'];
  tArray: Tarjim['tArray'];
  entry: Tarjim['entry'];
  language: string;
  setLanguage(language: string): Promise<void>;
  checkNow(): Promise<CheckResult>;
  ready: boolean;
  pendingUpdate: boolean;
}

export function TarjimProvider(_props: TarjimProviderProps): ReactNode {
  throw new Error('not implemented');
}

export function useTarjim(): TarjimContextValue {
  throw new Error('not implemented');
}
