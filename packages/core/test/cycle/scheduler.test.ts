import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from '../../src/index.js';
import type { Scheduler, Visibility } from '../../src/index.js';

const DAY_MS = 86_400_000;

function fakeVisibility(initial = true) {
  let visible = initial;
  const listeners = new Set<() => void>();
  const port: Visibility = {
    visible: () => visible,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    listeners,
    set(next: boolean) {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

interface Rig {
  scheduler: Scheduler;
  check: ReturnType<typeof vi.fn>;
  setDue(ms: number): void;
  setTimer: ReturnType<typeof vi.fn>;
  visibility: ReturnType<typeof fakeVisibility>;
}

function rig(options: { dueIn?: number; visible?: boolean; noVisibility?: boolean; check?: () => Promise<unknown>; nextDue?: () => number } = {}): Rig {
  let due = Date.now() + (options.dueIn ?? 0);
  const visibility = fakeVisibility(options.visible ?? true);
  const setTimer = vi.fn((callback: () => void, delay: number) => setTimeout(callback, delay));
  const check = vi.fn(async () => {
    if (options.check) await options.check();
    // A real check moves the next due time on.
    due = Date.now() + 300_000;
  });
  const scheduler = createScheduler({
    check,
    nextDueAt: async () => (options.nextDue ? options.nextDue() : due),
    now: () => Date.now(),
    timers: { set: setTimer, clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    ...(options.noVisibility ? {} : { visibility: visibility.port }),
  });
  return { scheduler, check, setDue: (ms) => (due = ms), setTimer, visibility };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => vi.useRealTimers());

describe('starting', () => {
  it('checks at once when a check is due, with no delay', async () => {
    const r = rig({ dueIn: -5_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('waits for the due time when nothing is due yet', async () => {
    const r = rig({ dueIn: 60_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('keeps one timer armed, and re-arms for the next due time after a check', async () => {
    const r = rig({ dueIn: 60_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(299_000);
    expect(r.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(r.check).toHaveBeenCalledTimes(3);
    r.scheduler.stop();
  });

  it('still runs on its timer when there is no visibility port', async () => {
    const r = rig({ dueIn: 60_000, noVisibility: true });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });
});

describe('a hidden tab', () => {
  it('does not check when its timer fires while hidden', async () => {
    const r = rig({ dueIn: 60_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    r.visibility.set(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.check).not.toHaveBeenCalled();
    r.scheduler.stop();
  });

  it('checks as soon as it becomes visible with a check overdue', async () => {
    const r = rig({ dueIn: 60_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    r.visibility.set(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    r.visibility.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('does not check on becoming visible when nothing is overdue', async () => {
    const r = rig({ dueIn: 600_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    r.visibility.set(false);
    await vi.advanceTimersByTimeAsync(60_000);
    r.visibility.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.check).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(540_000);
    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('goes back to its timer after the check made on becoming visible', async () => {
    const r = rig({ dueIn: 60_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    r.visibility.set(false);
    await vi.advanceTimersByTimeAsync(120_000);
    r.visibility.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(r.check).toHaveBeenCalledTimes(2);
    r.scheduler.stop();
  });
});

describe('overlapping checks', () => {
  it('never runs two checks at once', async () => {
    const gate = deferred();
    let running = 0;
    let most = 0;
    const r = rig({
      dueIn: -1,
      check: async () => {
        running += 1;
        most = Math.max(most, running);
        await gate.promise;
        running -= 1;
      },
    });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.check).toHaveBeenCalledTimes(1);

    r.setDue(Date.now() - 1_000);
    r.visibility.set(false);
    r.visibility.set(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.check).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(most).toBe(1);
    r.scheduler.stop();
  });
});

describe('stopping', () => {
  it('clears the timer and the visibility listener', async () => {
    const r = rig({ dueIn: 60_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(r.visibility.listeners.size).toBe(1);

    r.scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(r.visibility.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.check).not.toHaveBeenCalled();
  });

  it('does not re-arm after a check that was running when it stopped', async () => {
    const gate = deferred();
    const r = rig({ dueIn: -1, check: () => gate.promise });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.check).toHaveBeenCalledTimes(1);

    r.scheduler.stop();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a far-off due time', () => {
  it('arms no timer for longer than a day, and arms again until the time comes', async () => {
    const thirtyDays = 30 * DAY_MS;
    const r = rig({ dueIn: thirtyDays });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.setTimer).toHaveBeenCalledTimes(1);
    expect(r.setTimer.mock.calls[0]![1]).toBe(DAY_MS);

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(r.check).not.toHaveBeenCalled();
    expect(r.setTimer).toHaveBeenCalledTimes(2);
    for (const call of r.setTimer.mock.calls) expect(call[1]).toBeLessThanOrEqual(DAY_MS);

    await vi.advanceTimersByTimeAsync(thirtyDays - DAY_MS);
    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });
});
