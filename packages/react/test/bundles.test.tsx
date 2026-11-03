// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TarjimProvider } from '../src/index.js';
import { Reader, act, capture, embedded, mount, rig, useCleanSlate } from './helpers/rig.js';

vi.mock('node:url', () => import('./helpers/node-url-mock.js'));

useCleanSlate();

const TWO = { release: { content: { b1: 'v1', b2: 'v2' } } };

describe('bundles under the provider', () => {
  it('reads every loaded bundle, merged, when no default bundle is given', async () => {
    const r = rig(TWO);
    mount(
      <TarjimProvider config={r.world.config({ defaultBundle: undefined })} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v2 b2 en|en'), { timeout: 1000 });
  });

  it('loads a further bundle through the hook, and readers follow', async () => {
    const r = rig(TWO);
    const probe = capture();
    mount(
      <TarjimProvider config={r.world.config({ defaultBundle: undefined, bundles: ['b1'] })} start={r.start}>
        <probe.Capture />
        <Reader />
      </TarjimProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v1 b1 en|en'), { timeout: 1000 });

    let loaded = false;
    await act(async () => {
      loaded = await probe.latest().loadBundle('b2');
    });

    expect(loaded).toBe(true);
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v2 b2 en|en'), { timeout: 1000 });
  });

  it('renders embedded text on the server with no default bundle', () => {
    const r = rig();
    const html = renderToString(
      <TarjimProvider config={r.world.config({ defaultBundle: undefined, language: 'en', embedded: [embedded('en')] })} start={r.start} hydrating>
        <Reader />
      </TarjimProvider>,
    );

    expect(html).toContain('embedded a');
  });
});
