// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Tarjim } from '@tarjim/core';
import { TarjimProvider, useTarjim } from '../src/index.js';
import { Component, useEffect } from 'react';
import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { Reader, capture, embedded, mount, rig, useCleanSlate, within } from './helpers/rig.js';

vi.mock('node:url', () => import('./helpers/node-url-mock.js'));

useCleanSlate();

describe('before the local text is ready', () => {
  it('shows the fallback, then the children once the runtime has started', async () => {
    const r = rig();
    const open = r.holdStart();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start} fallback={<p>loading</p>}>
        <Reader />
      </TarjimProvider>,
    );

    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByTestId('reader')).toBeNull();

    open();
    await screen.findByTestId('reader');
    expect(screen.queryByText('loading')).toBeNull();
    expect(screen.getByTestId('reader').textContent).toMatch(/^(embedded a|v1 b1 en)\|en$/);
  });

  it('renders nothing by default while it waits', async () => {
    const r = rig();
    const open = r.holdStart();
    const view = mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );
    expect(r.start).toHaveBeenCalledTimes(1);
    expect(view.container.innerHTML).toBe('');

    open();
    await screen.findByTestId('reader');
  });

  it('gives up waiting after about a second and renders the children with the embedded text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = vi.fn(() => new Promise<Tarjim>(() => undefined));
    const api = capture();
    const r = rig();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={never} fallback={<p>loading</p>}>
        <Reader />
        <api.Capture />
      </TarjimProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByTestId('reader')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText('loading')).toBeNull();
    expect(screen.getByTestId('reader').textContent).toBe('embedded a|en');
    expect(api.latest().ready).toBe(false);
  });

  it('answers with the keys after that second when there is no embedded text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = vi.fn(() => new Promise<Tarjim>(() => undefined));
    const r = rig();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en', embedded: undefined })} start={never}>
        <Reader />
      </TarjimProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByTestId('reader').textContent).toBe('a|en');
  });

  it('draws the embedded text without throwing when some embedded entries are not slices', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = vi.fn(() => new Promise<Tarjim>(() => undefined));
    const r = rig();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en', embedded: [null, 3, 'x', { locale: 7 }, embedded('en')] })} start={never}>
        <Reader />
      </TarjimProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByTestId('reader').textContent).toBe('embedded a|en');
  });

  it('does not throw while rendering with a config the SDK will refuse', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = vi.fn(() => new Promise<Tarjim>(() => undefined));
    const r = rig();
    mount(
      <TarjimProvider config={r.world.config({ language: undefined, fallbackLanguage: undefined, defaultBundle: undefined })} start={never}>
        <Reader />
      </TarjimProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByTestId('reader')).toBeTruthy();
  });

  it('keeps ready false and still has the language while only the embedded text answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = vi.fn(() => new Promise<Tarjim>(() => undefined));
    const api = capture();
    const r = rig();
    mount(
      <TarjimProvider config={r.world.config({ language: 'fr' })} start={never}>
        <api.Capture />
      </TarjimProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });

    expect(api.latest().ready).toBe(false);
    expect(api.latest().language).toBe('fr');
    expect(api.latest().t('a')).toBe('embedded a fr');
    expect(api.latest().entry('a')?.value).toBe('embedded a fr');
  });

  it('does not wait for the network, whatever waitForContent the app asked for', async () => {
    const r = rig();
    r.world.server.hold('meta');
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en', waitForContent: 5000 })} start={r.start} fallback={<p>loading</p>}>
        <Reader />
        <api.Capture />
      </TarjimProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('embedded a|en'), { timeout: 1000 });
    expect(api.latest().ready).toBe(true);
    expect(r.configs[0]?.waitForContent).toBe(0);
  });

  it('passes every other setting to the runtime untouched', async () => {
    const r = rig();
    const config = r.world.config({ language: 'fr', appVersion: '2.0.0' });
    mount(
      <TarjimProvider config={config} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );
    await screen.findByTestId('reader');
    expect(r.configs[0]).toMatchObject({ language: 'fr', appVersion: '2.0.0', deliveryUrl: config.deliveryUrl, apiKey: config.apiKey });
  });
});

describe('a call made before the SDK has started', () => {
  it('waits for the start instead of failing, for setLanguage and checkNow', async () => {
    const r = rig();
    const open = r.holdStart();
    const calls: { language?: Promise<void>; check?: Promise<string> } = {};
    // A child's effect runs before the provider's own, so the provider has not started anything yet.
    function Early() {
      const { setLanguage, checkNow } = useTarjim();
      useEffect(() => {
        calls.language = setLanguage('fr');
        calls.check = checkNow();
      }, []);
      return <p>early</p>;
    }
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start} fallback={<Early />}>
        <Reader />
      </TarjimProvider>,
    );
    expect(calls.language).toBeDefined();

    open();
    await act(async () => {
      await calls.language;
      await expect(calls.check).resolves.toMatch(/^(noChange|notDue|downloaded)$/);
    });
    expect(r.runtime().language).toBe('fr');
  });
});

class Catch extends Component<{ children: ReactNode; onError(error: Error): void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

describe('useTarjim outside a provider', () => {
  it('throws an error that names the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: Error[] = [];
    function Lonely() {
      useTarjim();
      return null;
    }
    render(
      <Catch onError={(error) => errors.push(error)}>
        <Lonely />
      </Catch>,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/TarjimProvider/);
  });

  it('works for a component inside one', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await within(waitFor(() => expect(api.seen.length).toBeGreaterThan(0)));
    expect(typeof api.latest().t).toBe('function');
  });
});
