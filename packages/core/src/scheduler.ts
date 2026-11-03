export interface Visibility {
  visible(): boolean;
  /** Returns a function that removes the listener. */
  onChange(listener: () => void): () => void;
}

export interface Timers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface SchedulerOptions {
  /** Runs one check; resolves when it is over. */
  check(): Promise<unknown>;
  /** From when a check may run, in ms since the epoch, read from the store. */
  nextDueAt(): Promise<number>;
  now(): number;
  visibility?: Visibility;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

// Checks at launch and on each return to the foreground, and at no other time: no timer, so a page
// left open and a failed check both wait for the next of those moments.
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { visibility } = options;
  let active = false;
  let running = false;
  let unsubscribe: (() => void) | undefined;

  async function tick(): Promise<void> {
    if (!active || running || (visibility && !visibility.visible())) return;
    running = true;
    try {
      if ((await options.nextDueAt()) <= options.now() && active) await options.check();
    } catch {
      // The check reports its own failures; an unreadable store waits for the next moment too.
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      unsubscribe = visibility?.onChange(() => void tick());
      void tick();
    },
    stop() {
      active = false;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
