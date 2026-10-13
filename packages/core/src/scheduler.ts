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

export function createScheduler(_options: SchedulerOptions): Scheduler {
  throw new Error('not implemented');
}
