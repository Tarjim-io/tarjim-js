import './jsdom-compat.js';
import { Component, Profiler, useMemo } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { createRuntime } from '@tarjim/core';
import type { Tarjim, TarjimConfig } from '@tarjim/core';
import { makeWorld, settle } from '../../../core/test/runtime/world.js';
import type { WorldOptions } from '../../../core/test/runtime/world.js';
import { useTarjim } from '../../src/index.js';
import type { TarjimContextValue } from '../../src/index.js';

export { act };
export { embedded, settle, until, within } from '../../../core/test/runtime/world.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Registers the clean-up every file needs; call once at the top of a test file. */
export function useCleanSlate(): void {
  beforeEach(() => {
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? <p data-testid="render-error">{this.state.error.message}</p> : this.props.children;
  }
}

function assertNoRenderError(): void {
  const failed = screen.queryByTestId('render-error');
  if (failed) throw new Error(`rendering threw: ${failed.textContent}`);
}

/**
 * Renders inside an error boundary, so a provider that throws fails the test that rendered it
 * with the thrown message instead of tearing the file down.
 */
export function mount(ui: ReactNode) {
  const view = render(<Boundary>{ui}</Boundary>);
  assertNoRenderError();
  return {
    ...view,
    rerender(next: ReactNode) {
      view.rerender(<Boundary>{next}</Boundary>);
      assertNoRenderError();
    },
  };
}

/** A real runtime over the fake delivery server and clock of the core tests. */
export function rig(worldOptions: WorldOptions = {}) {
  const world = makeWorld(worldOptions);
  const runtimes: Tarjim[] = [];
  const configs: TarjimConfig[] = [];
  const stops: Array<ReturnType<typeof vi.spyOn>> = [];
  let gate: Promise<void> | undefined;

  const start = vi.fn(async (config: TarjimConfig): Promise<Tarjim> => {
    configs.push(config);
    await gate;
    const runtime = await createRuntime(config, world.platform());
    stops.push(vi.spyOn(runtime, 'stop'));
    runtimes.push(runtime);
    return runtime;
  });

  afterEach(() => {
    for (const runtime of runtimes) runtime.stop();
  });

  const api = {
    world,
    start,
    runtimes,
    configs,
    /** Makes every start wait until the returned function is called. */
    holdStart() {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return open;
    },
    /** How many times a started runtime has been stopped. */
    stopCount: () => stops.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
    runtime: () => {
      const runtime = runtimes[0];
      if (!runtime) throw new Error('no runtime was started');
      return runtime;
    },
    /** A release that replaces the held text, downloaded and left pending. */
    async downloadNext(tag: string, releaseId: number): Promise<string> {
      world.release({ content: { b1: tag }, releaseId });
      let result = '';
      await act(async () => {
        result = await api.runtime().checkNow();
      });
      return result;
    },
  };
  return api;
}

/** Shows `t('a')` and the language, so one row of text shows which snapshot a component read. */
export function Reader({ id = 'reader', k = 'a' }: { id?: string; k?: string }) {
  const { t, language } = useTarjim();
  return (
    <span data-id={id} data-testid={id}>
      {`${t(k)}|${language}`}
    </span>
  );
}

/** Keeps every value the hook returned, newest last. */
export function capture() {
  const seen: TarjimContextValue[] = [];
  function Capture() {
    seen.push(useTarjim());
    return null;
  }
  return {
    Capture,
    seen,
    latest(): TarjimContextValue {
      const value = seen[seen.length - 1];
      if (!value) throw new Error('nothing rendered under the provider');
      return value;
    },
  };
}

/** Counts how often a memo keyed on `t` recomputes. */
export function memoReader(counter: { runs: number }) {
  return function MemoReader() {
    const { t } = useTarjim();
    const upper = useMemo(() => {
      counter.runs += 1;
      return t('a').toUpperCase();
    }, [t]);
    return <span data-testid="memo">{upper}</span>;
  };
}

/** Records, for every commit under it, the text of every `[data-id]` element as the DOM shows it. */
export function commitRecorder() {
  const commits: string[][] = [];
  function Frame({ children }: { children: ReactNode }) {
    return (
      <Profiler
        id="frame"
        onRender={() => {
          // The commit has been applied to the DOM by the time the profiler reports it.
          commits.push(Array.from(document.querySelectorAll('[data-id]')).map((node) => node.textContent ?? ''));
        }}
      >
        {children}
      </Profiler>
    );
  }
  return {
    Frame,
    commits,
    /** Commits whose readers disagree with each other. */
    mixed: () => commits.filter((row) => new Set(row).size > 1),
    seen: () => new Set(commits.flat()),
  };
}
