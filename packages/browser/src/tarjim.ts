import { createRuntime } from '@tarjim/core';
import type { Platform, Tarjim as Instance, TarjimConfig } from '@tarjim/core';
import { openStore } from './open-store.js';

// Every global is read when used and inside a guard: a sandboxed frame can throw on the read itself.
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The browser's environment for the runtime. */
export function browserPlatform(): Platform {
  const pageFetch = attempt(() => globalThis.fetch);
  return {
    name: 'web',
    ...(typeof pageFetch === 'function' ? { fetch: pageFetch.bind(globalThis) } : {}),
    get secureContext(): boolean {
      return attempt(() => globalThis.isSecureContext === true && !!globalThis.crypto?.subtle) ?? false;
    },
    openStore: async (deliveryUrl, apiKey) => {
      const { store, degradedReason } = await openStore({ deliveryUrl, apiKey });
      return degradedReason === undefined ? { store } : { store, degradedReason };
    },
    browserLanguages: () => attempt(() => Array.from(globalThis.navigator?.languages ?? [])) ?? [],
    // Only the client-hints value: the user agent string is never parsed.
    osVersion: () => attempt(() => (globalThis.navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform) || undefined,
    timers: {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    visibility: {
      visible: () => attempt(() => globalThis.document.visibilityState) !== 'hidden',
      onChange: (listener) => {
        const target = attempt(() => globalThis.document);
        target?.addEventListener('visibilitychange', listener);
        return () => target?.removeEventListener('visibilitychange', listener);
      },
    },
    now: () => Date.now(),
    random: () => Math.random(),
    randomId: () => globalThis.crypto.randomUUID(),
    log: (level, message, details) => {
      const write = level === 'info' ? console.info : console.debug;
      if (details) write(`[tarjim] ${message}`, details);
      else write(`[tarjim] ${message}`);
    },
  };
}

export const Tarjim = {
  start(config: TarjimConfig): Promise<Instance> {
    return createRuntime(config, browserPlatform());
  },
};
