import type { State } from './store.js';

export const MIN_POLL_SECONDS = 60;
export const MAX_WAIT_SECONDS = 86400;
export const DEFAULT_POLL_SECONDS = 1800;
export const CHECK_NOW_FLOOR_SECONDS = 60;

const nonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function clampPollAfter(value: unknown, fallback: number = DEFAULT_POLL_SECONDS): number {
  if (!nonNegative(value)) return fallback;
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_POLL_SECONDS, value));
}

export function clampRetryAfter(value: unknown): number {
  return nonNegative(value) ? Math.min(MAX_WAIT_SECONDS, value) : 0;
}

/** A wait written under a clock that has since moved back must not hold checks off for more than a day. */
export function notBeforeOf(state: State, now: number): number {
  const notBefore = state.notBefore ?? 0;
  // No backoff is longer than a day, so one ending further ahead was written before the clock moved back.
  return notBefore > now + MAX_WAIT_SECONDS * 1000 ? 0 : notBefore;
}

/** Milliseconds since the epoch when the next scheduled check is due. */
export function dueAt(state: State, now: number, random: number): number {
  const floor = Math.max(now, notBeforeOf(state, now));
  // A last check in the future (clock moved back) must not postpone checks.
  if (state.lastCheck === undefined || state.lastCheck > now) return floor;
  const jitter = 1 + 0.2 * Math.min(1, Math.max(0, random));
  // Rounded because 900 * 1.1 is not exactly 990 in floating point.
  const wait = Math.round(clampPollAfter(state.lastPollAfter) * 1000 * jitter);
  return Math.max(state.lastCheck + wait, floor);
}

/** Seconds to wait after a failed check. */
export function backoffSeconds(step: number, pollAfter: number, retryAfter?: number): number {
  const exponent = Number.isFinite(step) && step > 0 ? Math.min(step, 20) : 0;
  const own = Math.min(MIN_POLL_SECONDS * 2 ** exponent, pollAfter);
  return Math.min(MAX_WAIT_SECONDS, Math.max(own, retryAfter ?? 0));
}
