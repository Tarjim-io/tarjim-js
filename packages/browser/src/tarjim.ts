import type { Platform, Tarjim as Instance, TarjimConfig } from '@tarjim/core';

/** The browser's environment for the runtime. */
export function browserPlatform(): Platform {
  throw new Error('not implemented');
}

export const Tarjim = {
  start(_config: TarjimConfig): Promise<Instance> {
    throw new Error('not implemented');
  },
};
