import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from '../../src/internal.js';
import type { Visibility } from '../../src/index.js';
import type { Scheduler } from '../../src/internal.js';

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
  setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  visibility: ReturnType<typeof fakeVisibility>;
}

function rig(options: { dueIn?: number; visible?: boolean; noVisibility?: boolean; check?: () => Promise<unknown>; nextDue?: () => number } = {}): Rig {
  let due = Date.now() + (options.dueIn ?? 0);
  const visibility = fakeVisibility(options.visible ?? true);
  const check = vi.fn(async () => {
    if (options.check) await options.check();
    // A real check moves the next due time on.
    due = Date.now() + 60_000;
  });
  const scheduler = createScheduler({
    check,
    nextDueAt: async () => (options.nextDue ? options.nextDue() : due),
    now: () => Date.now(),
    ...(options.noVisibility ? {} : { visibility: visibility.port }),
  });
  return { scheduler, check, setDue: (ms) => (due = ms), setTimeoutSpy: vi.spyOn(globalThis, 'setTimeout'), visibility };
}

const leaveAndReturn = async (r: Rig): Promise<void> => {
  r.visibility.set(false);
  r.visibility.set(true);
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('at launch', () => {
  it('checks at once when a check is due', async () => {
    const r = rig({ dueIn: -5_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('does not check when nothing is due, and does not wait for it', async () => {
    const r = rig({ dueIn: 30_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(r.check).not.toHaveBeenCalled();
    r.scheduler.stop();
  });

  it('checks with no visibility port too', async () => {
    const r = rig({ dueIn: 0, noVisibility: true });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('makes no check while hidden, and one on the first return', async () => {
    const r = rig({ dueIn: 0, visible: false });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(r.check).not.toHaveBeenCalled();

    r.visibility.set(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('survives a store that cannot be read, and checks on the next return', async () => {
    let readable = false;
    const r = rig({
      nextDue: () => {
        if (!readable) throw new Error('no');
        return 0;
      },
    });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.check).not.toHaveBeenCalled();

    readable = true;
    await leaveAndReturn(r);

    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });
});

describe('with no timer', () => {
  it('sets none when nothing is due at launch', async () => {
    const r = rig({ dueIn: 30_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect((r.setTimeoutSpy.mock.calls as unknown[][]).filter((call) => (call[1] as number) > 0)).toEqual([]);
    r.scheduler.stop();
  });

  it('does not check again while a page stays open', async () => {
    const r = rig({ dueIn: 0 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('does not retry a check that throws until the next return', async () => {
    const r = rig({
      dueIn: 0,
      nextDue: () => 0,
      check: async () => {
        throw new Error('no');
      },
    });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(r.check).toHaveBeenCalledTimes(1);

    await leaveAndReturn(r);

    expect(r.check).toHaveBeenCalledTimes(2);
    r.scheduler.stop();
  });
});

describe('on return to the foreground', () => {
  it('checks when a check is due', async () => {
    const r = rig({ dueIn: 0 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(Date.now() + 60_000);
    await leaveAndReturn(r);

    expect(r.check).toHaveBeenCalledTimes(2);
    r.scheduler.stop();
  });

  it('does not check inside the floor', async () => {
    const r = rig({ dueIn: 0 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(Date.now() + 59_000);
    await leaveAndReturn(r);

    expect(r.check).toHaveBeenCalledTimes(1);
    r.scheduler.stop();
  });

  it('does nothing when the page is going away', async () => {
    const r = rig({ dueIn: 30_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    r.setDue(0);

    r.visibility.set(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(r.check).not.toHaveBeenCalled();
    r.scheduler.stop();
  });

  it('never runs two checks at once', async () => {
    const gate = deferred();
    const r = rig({ dueIn: 0, nextDue: () => 0, check: () => gate.promise });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    await leaveAndReturn(r);
    expect(r.check).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    r.scheduler.stop();
  });
});

describe('stopping', () => {
  it('removes the visibility listener', async () => {
    const r = rig({ dueIn: 30_000 });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.visibility.listeners.size).toBe(1);

    r.scheduler.stop();

    expect(r.visibility.listeners.size).toBe(0);
  });

  it('skips a check it was still deciding on', async () => {
    const r = rig({ dueIn: 0 });
    r.scheduler.start();
    r.scheduler.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(r.check).not.toHaveBeenCalled();
  });

  it('checks no more after a check that was running when it stopped', async () => {
    const gate = deferred();
    const r = rig({ dueIn: 0, nextDue: () => 0, check: () => gate.promise });
    r.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    r.scheduler.stop();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(r.check).toHaveBeenCalledTimes(1);
  });
});
