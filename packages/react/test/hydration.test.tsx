// @vitest-environment jsdom
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TarjimConfig } from '@tarjim/core';
import { TarjimProvider, useTarjim } from '../src/index.js';
import type { TarjimContextValue } from '../src/index.js';
import { act, embedded, rig, settle, useCleanSlate } from './helpers/rig.js';

vi.mock('node:url', () => import('./helpers/node-url-mock.js'));

useCleanSlate();

interface Rendered {
  text: string;
  ready: boolean;
  language: string;
}

/** Every render of the probe, in order, so the first one can be compared with the server's. */
function probe() {
  const renders: Rendered[] = [];
  let latest: TarjimContextValue | undefined;
  function Probe() {
    const value = useTarjim();
    latest = value;
    renders.push({ text: value.t('a'), ready: value.ready, language: value.language });
    return <p id="probe">{value.t('a')}</p>;
  }
  return {
    Probe,
    renders,
    api: () => {
      if (!latest) throw new Error('the probe has not rendered');
      return latest;
    },
  };
}

interface Setup {
  config: TarjimConfig;
  start: ReturnType<typeof rig>['start'];
  fetch: ReturnType<typeof vi.fn>;
}

function setup(overrides: Record<string, unknown> = {}): Setup {
  const r = rig();
  const fetch = vi.fn(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  return { config: r.world.config({ language: 'en', fetch, ...overrides }), start: r.start, fetch };
}

/** Server-renders `tree`, puts the HTML in the page and hydrates it, as a prebuilt page does. */
async function hydrate(tree: () => ReactNode) {
  const html = renderToString(tree());
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  const recoverable = vi.fn();
  await act(async () => {
    hydrateRoot(container, tree(), { onRecoverableError: recoverable });
  });
  return { html, container, recoverable };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('a provider mounted on server-rendered HTML', () => {
  it('renders the embedded text on the server and on the client, with nothing to reconcile', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { config, start } = setup();
    const server = probe();
    const client = probe();
    const tree = (p: ReturnType<typeof probe>) => () => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    );

    const html = renderToString(tree(server)());
    expect(html).toContain('embedded a');
    expect(server.renders[0]).toEqual({ text: 'embedded a', ready: true, language: 'en' });

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, tree(client)(), { onRecoverableError: recoverable });
    });

    expect(client.renders[0]).toEqual(server.renders[0]);
    expect(container.innerHTML).toBe(html);
    expect(recoverable).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('reports a mismatch when the server drew different text, so the checks above can fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { config, start } = setup();
    const client = probe();
    const container = document.createElement('div');
    container.innerHTML = '<p id="probe">something else</p>';
    document.body.append(container);
    const recoverable = vi.fn();

    await act(async () => {
      hydrateRoot(
        container,
        <TarjimProvider hydrating config={config} start={start}>
          <client.Probe />
        </TarjimProvider>,
        { onRecoverableError: recoverable },
      );
    });

    expect(client.renders[0]?.text).toBe('embedded a');
    expect(error.mock.calls.length + recoverable.mock.calls.length).toBeGreaterThan(0);
  });

  it('uses the fallback language, not the browser language, when none was configured', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { config, start } = setup({ language: undefined, fallbackLanguage: 'fr' });
    const p = probe();

    const { html, recoverable } = await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));

    expect(html).toContain('embedded a fr');
    expect(p.renders.map((render) => render.text)).toEqual(expect.arrayContaining(['embedded a fr']));
    expect(p.renders[0]).toEqual({ text: 'embedded a fr', ready: true, language: 'fr' });
    expect(recoverable).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('never starts the SDK and never asks the network for anything', async () => {
    const { config, start, fetch } = setup();
    const p = probe();

    const { container } = await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));
    await settle(100);

    expect(container.textContent).toBe('embedded a');
    expect(start).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(p.api().pendingUpdate).toBe(false);
  });

  it('starts the SDK for the same tree when it is not hydrating', async () => {
    const { config, start } = setup();
    const p = probe();
    const container = document.createElement('div');
    document.body.append(container);

    await act(async () => {
      hydrateRoot(
        container,
        <TarjimProvider config={config} start={start}>
          <p.Probe />
        </TarjimProvider>,
      );
    });
    await settle(50);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('refuses an embedded that is not an array, draws the keys and does not throw', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { config, start } = setup({ embedded: { en: {} } });
    const p = probe();

    const { container } = await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));

    expect(error).toHaveBeenCalled();
    expect(container.textContent).toBe('a');
    expect(start).not.toHaveBeenCalled();
  });

  it('reports a bad embedded once through onReport, however often the effect runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onReport = vi.fn();
    const { config, start } = setup({ embedded: { en: {} }, onReport });
    const p = probe();

    await act(async () => {
      render(
        <StrictMode>
          <TarjimProvider hydrating config={config} start={start}>
            <p.Probe />
          </TarjimProvider>
        </StrictMode>,
      );
    });
    await settle(50);

    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport.mock.calls[0]?.[0]).toMatchObject({ code: 'embedded-invalid' });
  });

  it('does not report anything when embedded is an array', async () => {
    const onReport = vi.fn();
    const { config, start } = setup({ onReport });
    const p = probe();

    await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));

    expect(onReport).not.toHaveBeenCalled();
  });

  it('skips entries that are not slices instead of throwing, and uses the rest', async () => {
    const { config, start } = setup({ embedded: [null, 7, 'text', [], { locale: 3 }, { schemaVersion: 1 }, embedded('en'), embedded('fr')] });
    const p = probe();

    const { container, recoverable } = await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));
    expect(container.textContent).toBe('embedded a');
    expect(recoverable).not.toHaveBeenCalled();

    await act(async () => {
      await p.api().setLanguage('fr');
    });
    expect(container.textContent).toBe('embedded a fr');
  });

  it('ignores waitForContent, warning once in the browser however often it renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { config, start } = setup({ waitForContent: 5000 });
    const p = probe();
    const tree = () => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    );
    const html = renderToString(tree());
    expect(html).toContain('embedded a');
    warn.mockClear();
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);

    await act(async () => {
      hydrateRoot(container, tree());
    });
    await act(async () => {
      await p.api().setLanguage('fr');
    });
    await settle(50);

    expect(container.textContent).toBe('embedded a fr');
    expect(p.renders[0]?.ready).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when waitForContent is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { config, start } = setup();
    const p = probe();

    await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));

    expect(p.renders[0]?.text).toBe('embedded a');
    expect(warn).not.toHaveBeenCalled();
  });

  it('switches between the embedded languages and no others, with no request', async () => {
    const { config, start, fetch } = setup();
    const p = probe();
    const { container } = await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));

    await act(async () => {
      await p.api().setLanguage('fr');
    });
    expect(container.textContent).toBe('embedded a fr');
    expect(p.api().language).toBe('fr');

    await act(async () => {
      await expect(p.api().setLanguage('de')).rejects.toThrow();
    });
    expect(container.textContent).toBe('embedded a fr');
    expect(p.api().language).toBe('fr');
    expect(start).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives a new t after switching language, and no update is ever pending', async () => {
    const { config, start } = setup();
    const p = probe();
    await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));
    const before = p.api().t;

    await act(async () => {
      await p.api().setLanguage('fr');
    });

    expect(p.api().t).not.toBe(before);
    expect(p.api().pendingUpdate).toBe(false);
    await expect(p.api().checkNow()).resolves.toMatch(/^(noChange|notDue|failed)$/);
  });

  it('puts no marker or invisible character in what a lookup returns', async () => {
    const { config, start } = setup();
    const p = probe();
    const { container } = await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <p.Probe />
      </TarjimProvider>
    ));

    const { t, tArray, entry } = p.api();
    const invisible = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿-]/u;
    expect(t('a')).toBe('embedded a');
    expect(t('a')).not.toMatch(invisible);
    expect(entry('a')?.value).toBe('embedded a');
    for (const value of tArray('a')) expect(value).not.toMatch(invisible);
    expect(container.innerHTML).not.toMatch(invisible);
  });
});

describe('keyCase on a hydrating mount', () => {
  it("applies 'lower' to the embedded text on the server and on the client", async () => {
    const { config, start } = setup({ keyCase: 'lower' });
    function Upper() {
      return <p id="probe">{useTarjim().t('A')}</p>;
    }
    const { html, container, recoverable } = await hydrate(() => (
      <TarjimProvider hydrating config={config} start={start}>
        <Upper />
      </TarjimProvider>
    ));
    expect(html).toContain('embedded a');
    expect(container.innerHTML).toBe(html);
    expect(recoverable).not.toHaveBeenCalled();
  });
});
