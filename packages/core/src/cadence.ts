import type { State } from './store.js';

export const MIN_POLL_SECONDS = 60;
export const MAX_WAIT_SECONDS = 86400;
export const DEFAULT_POLL_SECONDS = 1800;
export const CHECK_NOW_FLOOR_SECONDS = 60;

export function clampPollAfter(_value: unknown, _fallback?: number): number {
  throw new Error('not implemented');
}

export function clampRetryAfter(_value: unknown): number {
  throw new Error('not implemented');
}

/** Milliseconds since the epoch when the next scheduled check is due. */
export function dueAt(_state: State, _now: number, _random: number): number {
  throw new Error('not implemented');
}

/** Seconds to wait after a failed check. */
export function backoffSeconds(_step: number, _pollAfter: number, _retryAfter?: number): number {
  throw new Error('not implemented');
}
