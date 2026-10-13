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
  /** Runs one scheduled check; resolves when it is over. */
  check(): Promise<unknown>;
  /** When the next check is due, in ms since the epoch, read from the store. */
  nextDueAt(): Promise<number>;
  now(): number;
  timers: Timers;
  visibility?: Visibility;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

const MAX_TIMER_MS = 86_400_000;
// Used when the store cannot be read, and as the pause after a check that left a check still due.
const RETRY_DELAY_MS = 60_000;

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { timers, visibility } = options;
  let active = false;
  let running = false;
  let handle: unknown;
  let armed = false;
  let sequence = 0;
  let unsubscribe: (() => void) | undefined;

  const clearTimer = (): void => {
    if (!armed) return;
    armed = false;
    try {
      timers.clear(handle);
    } catch {
      // A failing clear must not stop the scheduler.
    }
  };

  const arm = (delayMs: number): void => {
    try {
      handle = timers.set(onTimer, Math.min(MAX_TIMER_MS, Math.max(0, delayMs)));
      armed = true;
    } catch {
      armed = false;
    }
  };

  const onTimer = (): void => {
    armed = false;
    if (visibility && !visibility.visible()) return;
    void tick(false);
  };

  async function runCheck(): Promise<void> {
    running = true;
    try {
      await options.check();
    } catch {
      // The check reports its own failures; the loop must go on.
    } finally {
      running = false;
    }
    if (active) await tick(true);
  }

  // A tick that finds a newer tick (or a stop) after its await gives up, so only one timer is ever armed.
  async function tick(afterCheck: boolean): Promise<void> {
    if (!active || running) return;
    const mine = ++sequence;
    clearTimer();
    let due: number;
    try {
      due = await options.nextDueAt();
    } catch {
      due = options.now() + RETRY_DELAY_MS;
    }
    if (!active || running || mine !== sequence) return;
    if (visibility && !visibility.visible()) return;

    const wait = Number.isFinite(due) ? due - options.now() : RETRY_DELAY_MS;
    if (wait <= 0 && !afterCheck) {
      await runCheck();
      return;
    }
    arm(wait <= 0 ? RETRY_DELAY_MS : wait);
  }

  return {
    start() {
      if (active) return;
      active = true;
      unsubscribe = visibility?.onChange(() => {
        if (visibility.visible()) void tick(false);
      });
      void tick(false);
    },
    stop() {
      active = false;
      sequence += 1;
      clearTimer();
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
