import type { State } from './store.js';

// The edge caches meta for this long, so a faster check could not see anything newer.
export const CHECK_FLOOR_SECONDS = 60;
export const MAX_WAIT_SECONDS = 86400;

const nonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function clampRetryAfter(value: unknown): number {
  return nonNegative(value) ? Math.min(MAX_WAIT_SECONDS, value) : 0;
}

/** A wait written under a clock that has since moved back must not hold checks off for more than a day. */
export function notBeforeOf(state: State, now: number): number {
  const notBefore = state.notBefore ?? 0;
  // No wait is longer than a day, so one ending further ahead was written before the clock moved back.
  return notBefore > now + MAX_WAIT_SECONDS * 1000 ? 0 : notBefore;
}

/** Milliseconds since the epoch from when a check may read meta again. */
export function dueAt(state: State, now: number): number {
  const floor = Math.max(now, notBeforeOf(state, now));
  // A last check in the future (clock moved back) must not postpone checks.
  if (state.lastCheck === undefined || state.lastCheck > now) return floor;
  return Math.max(state.lastCheck + CHECK_FLOOR_SECONDS * 1000, floor);
}

/** Seconds to wait after a failed check. */
export function failureWaitSeconds(retryAfter?: number): number {
  return Math.max(CHECK_FLOOR_SECONDS, retryAfter ?? 0);
}
