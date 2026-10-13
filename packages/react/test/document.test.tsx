// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TarjimProvider } from '../src/index.js';
import { Reader, act, capture, embedded, mount, rig, settle, useCleanSlate } from './helpers/rig.js';

vi.mock('node:url', () => import('./helpers/node-url-mock.js'));

useCleanSlate();

const root = document.documentElement;

function arabicRig() {
  const r = rig({ release: { locales: ['en', 'ar'] } });
  return { r, config: (language: string) => r.world.config({ language, embedded: [embedded('en'), embedded('ar')] }) };
}

describe('the document language', () => {
  it('is set to the language, with right-to-left for Arabic', async () => {
    const { r, config } = arabicRig();
    mount(
      <TarjimProvider config={config('ar')} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );

    await waitFor(() => expect(root.lang).toBe('ar'), { timeout: 1000 });
    expect(root.dir).toBe('rtl');
  });

  it('is set to left-to-right for English', async () => {
    const { r, config } = arabicRig();
    mount(
      <TarjimProvider config={config('en')} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );

    await waitFor(() => expect(root.lang).toBe('en'), { timeout: 1000 });
    expect(root.dir).toBe('ltr');
  });

  it('follows setLanguage in both directions', async () => {
    const { r, config } = arabicRig();
    const api = capture();
    mount(
      <TarjimProvider config={config('en')} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(root.lang).toBe('en'), { timeout: 1000 });
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });

    await act(async () => {
      await api.latest().setLanguage('ar');
    });
    expect([root.lang, root.dir]).toEqual(['ar', 'rtl']);

    await act(async () => {
      await api.latest().setLanguage('en');
    });
    expect([root.lang, root.dir]).toEqual(['en', 'ltr']);
  });

  it('is left alone with setDocumentLanguage={false}', async () => {
    const { r, config } = arabicRig();
    root.lang = 'xx';
    const api = capture();
    mount(
      <TarjimProvider config={config('ar')} start={r.start} setDocumentLanguage={false}>
        <Reader />
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toBe('v1 b1 ar|ar'), { timeout: 1000 });
    await act(async () => {
      await api.latest().setLanguage('en');
    });
    await settle();

    expect(root.lang).toBe('xx');
    expect(root.hasAttribute('dir')).toBe(false);
  });
});
