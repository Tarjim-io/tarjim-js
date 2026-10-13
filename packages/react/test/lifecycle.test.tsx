// @vitest-environment jsdom
import { Activity, StrictMode, version } from 'react';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TarjimProvider } from '../src/index.js';
import { Reader, act, capture, mount, rig, settle, until, useCleanSlate } from './helpers/rig.js';

vi.mock('node:url', () => import('./helpers/node-url-mock.js'));

useCleanSlate();

const POLL_MS = 1_000_000;

describe('the configuration', () => {
  it('is read once: a new config object on a re-render starts nothing and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = rig();
    const tree = (config: ReturnType<typeof r.world.config>) => (
      <TarjimProvider config={config} start={r.start}>
        <Reader />
      </TarjimProvider>
    );
    const view = mount(tree(r.world.config({ language: 'en' })));
    await screen.findByTestId('reader');
    expect(warn).not.toHaveBeenCalled();

    view.rerender(tree(r.world.config({ language: 'en' })));
    view.rerender(tree(r.world.config({ language: 'en' })));
    await settle();

    expect(r.start).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the same config object comes back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = rig();
    const config = r.world.config({ language: 'en' });
    const tree = () => (
      <TarjimProvider config={config} start={r.start}>
        <Reader />
      </TarjimProvider>
    );
    const view = mount(tree());
    await screen.findByTestId('reader');

    view.rerender(tree());
    view.rerender(tree());

    expect(warn).not.toHaveBeenCalled();
    expect(r.start).toHaveBeenCalledTimes(1);
  });

  it('ignores a changed apiKey or appVersion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = rig();
    const first = r.world.config({ language: 'en' });
    const view = mount(
      <TarjimProvider config={first} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );
    await screen.findByTestId('reader');

    view.rerender(
      <TarjimProvider config={{ ...first, apiKey: 'tarjim-0-0-0-other', appVersion: '9.9.9' }} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );
    await settle();

    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.runtimes).toHaveLength(1);
    expect(r.stopCount()).toBe(0);
    expect(r.world.opened).toHaveLength(1);
  });

  it('applies a changed language through setLanguage, without starting another runtime', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = rig();
    const first = r.world.config({ language: 'en' });
    const tree = (config: typeof first) => (
      <TarjimProvider config={config} start={r.start}>
        <Reader />
      </TarjimProvider>
    );
    const view = mount(tree(first));
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v1 b1 en|en'), { timeout: 1000 });

    view.rerender(tree({ ...first, language: 'fr' }));

    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v1 b1 fr|fr'), { timeout: 1000 });
    expect(r.runtime().language).toBe('fr');
    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.stopCount()).toBe(0);
  });
});

describe('the runtime behind the provider', () => {
  it('is started once under StrictMode and keeps polling', async () => {
    const r = rig();
    mount(
      <StrictMode>
        <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
          <Reader />
        </TarjimProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v1 b1 en|en'), { timeout: 1000 });
    await settle();

    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.runtimes).toHaveLength(1);
    expect(r.stopCount()).toBe(0);

    const checks = r.world.metaCount();
    await act(async () => {
      await r.world.timers.advance(POLL_MS);
    });
    await until(() => r.world.metaCount() > checks, 'the next scheduled check');
  });

  it('is stopped when the provider unmounts, and checks nothing afterwards', async () => {
    const r = rig();
    const view = mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v1 b1 en|en'), { timeout: 1000 });
    expect(r.stopCount()).toBe(0);

    view.unmount();

    expect(r.stopCount()).toBe(1);
    const checks = r.world.metaCount();
    await r.world.timers.advance(POLL_MS);
    await settle();
    expect(r.world.metaCount()).toBe(checks);
  });

  it('is stopped when it finishes starting after the provider is already gone', async () => {
    const r = rig();
    const open = r.holdStart();
    const view = mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );
    view.unmount();

    open();

    await until(() => r.runtimes.length === 1, 'the late runtime');
    await until(() => r.stopCount() === 1, 'the late runtime to be stopped');
  });

  it('is stopped under StrictMode only once the provider really unmounts', async () => {
    const r = rig();
    const view = mount(
      <StrictMode>
        <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
          <Reader />
        </TarjimProvider>
      </StrictMode>,
    );
    await screen.findByTestId('reader');
    await settle();
    expect(r.stopCount()).toBe(0);

    view.unmount();

    expect(r.stopCount()).toBe(1);
  });

  it('runs setLanguage and checkNow through the hook', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(api.latest().ready).toBe(true), { timeout: 1000 });

    await act(async () => {
      await api.latest().setLanguage('fr');
    });
    expect(api.latest().language).toBe('fr');
    await act(async () => {
      expect(await api.latest().checkNow()).toMatch(/^(noChange|notDue)$/);
    });
  });
});

// Activity arrived in React 19; it is how a provider's effects are cleaned up and run again without a remount.
describe.skipIf(Number(version.split('.')[0]) < 19)('a provider whose effects are cleaned up and run again', () => {
  const tree = (r: ReturnType<typeof rig>, config: ReturnType<ReturnType<typeof rig>['world']['config']>, mode: 'visible' | 'hidden', api: ReturnType<typeof capture>) => (
    <Activity mode={mode}>
      <TarjimProvider config={config} start={r.start}>
        <Reader />
        <api.Capture />
      </TarjimProvider>
    </Activity>
  );

  it('stops a runtime that finished starting while it was hidden and starts a fresh one when shown', async () => {
    const r = rig();
    const config = r.world.config({ language: 'en' });
    const api = capture();
    const open = r.holdStart();
    const view = mount(tree(r, config, 'visible', api));
    view.rerender(tree(r, config, 'hidden', api));

    open();
    await until(() => r.runtimes.length === 1, 'the runtime that started while hidden');
    await until(() => r.stopCount() === 1, 'that runtime to be stopped');

    view.rerender(tree(r, config, 'visible', api));
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v1 b1 en|en'), { timeout: 1000 });
    expect(r.start).toHaveBeenCalledTimes(2);
    expect(r.runtimes).toHaveLength(2);
    expect(r.stopCount()).toBe(1);
  });

  it('forgets a pending update when it is hidden, because the runtime that held it is stopped', async () => {
    const r = rig();
    const config = r.world.config({ language: 'en' });
    const api = capture();
    const view = mount(tree(r, config, 'visible', api));
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });
    expect(await r.downloadNext('v2', 2)).toBe('downloaded');
    await waitFor(() => expect(api.latest().pendingUpdate).toBe(true), { timeout: 1000 });

    view.rerender(tree(r, config, 'hidden', api));
    view.rerender(tree(r, config, 'visible', api));

    await until(() => r.runtimes.length === 2, 'the second runtime');
    await waitFor(() => expect(api.latest().ready).toBe(true), { timeout: 1000 });
    expect(api.latest().pendingUpdate).toBe(false);
  });
});
