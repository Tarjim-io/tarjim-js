// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TarjimProvider } from '../src/index.js';
import { Reader, act, capture, commitRecorder, memoReader, mount, rig, useCleanSlate } from './helpers/rig.js';

vi.mock('node:url', () => import('./helpers/node-url-mock.js'));

useCleanSlate();

async function untilText(testId: string, text: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId(testId).textContent).toBe(text), { timeout: 1000 });
}

describe('the text a component reads', () => {
  it('keeps the same t until a release is activated, then hands out a new one', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });
    const first = api.latest().t;

    expect(await r.downloadNext('v2', 2)).toBe('downloaded');
    expect(api.latest().t).toBe(first);
    expect(api.latest().t('a')).toBe('v1 b1 en');

    await act(async () => {
      r.runtime().activatePendingUpdate();
    });
    expect(api.latest().t).not.toBe(first);
    expect(api.latest().t('a')).toBe('v2 b1 en');
  });

  it('hands out a new t, tArray and entry when the language changes', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });
    const before = api.latest();

    await act(async () => {
      await before.setLanguage('fr');
    });

    const after = api.latest();
    expect(after.language).toBe('fr');
    expect(after.t).not.toBe(before.t);
    expect(after.tArray).not.toBe(before.tArray);
    expect(after.entry).not.toBe(before.entry);
    expect(after.t('a')).toBe('v1 b1 fr');
    expect(after.entry('a')?.value).toBe('v1 b1 fr');
  });

  it('keeps t when the parent re-renders and nothing about the text changed', async () => {
    const r = rig();
    const api = capture();
    const config = r.world.config({ language: 'en' });
    const view = mount(
      <TarjimProvider config={config} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });
    const before = api.latest().t;

    view.rerender(
      <TarjimProvider config={config} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );

    expect(api.latest().t).toBe(before);
  });

  it('recomputes a memo keyed on t after an activation and after a language change, and only then', async () => {
    const r = rig();
    const counter = { runs: 0 };
    const Memo = memoReader(counter);
    const api = capture();
    const config = r.world.config({ language: 'en' });
    const tree = () => (
      <TarjimProvider config={config} start={r.start}>
        <Memo />
        <api.Capture />
      </TarjimProvider>
    );
    const view = mount(tree());
    await untilText('memo', 'V1 B1 EN');

    const afterFirst = counter.runs;
    view.rerender(tree());
    expect(counter.runs).toBe(afterFirst);

    await r.downloadNext('v2', 2);
    expect(counter.runs).toBe(afterFirst);
    await act(async () => {
      r.runtime().activatePendingUpdate();
    });
    await untilText('memo', 'V2 B1 EN');
    const afterActivation = counter.runs;
    expect(afterActivation).toBeGreaterThan(afterFirst);

    await act(async () => {
      await api.latest().setLanguage('fr');
    });
    await untilText('memo', 'V2 B1 FR');
    expect(counter.runs).toBeGreaterThan(afterActivation);
  });
});

describe('a commit never mixes two releases', () => {
  it('shows one release and one language in every reader at every commit, across an activation and a language change', async () => {
    const r = rig();
    const recorder = commitRecorder();
    const api = capture();
    mount(
      <recorder.Frame>
        <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
          <Reader id="header" />
          <section>
            <Reader id="body" />
            <div>
              <Reader id="footer" />
            </div>
          </section>
          <api.Capture />
        </TarjimProvider>
      </recorder.Frame>,
    );
    await untilText('footer', 'v1 b1 en|en');

    await r.downloadNext('v2', 2);
    await act(async () => {
      r.runtime().activatePendingUpdate();
    });
    await untilText('footer', 'v2 b1 en|en');
    await act(async () => {
      await api.latest().setLanguage('fr');
    });
    await untilText('footer', 'v2 b1 fr|fr');

    // Each reader is compared against the others in the same commit; the sightings prove the loop saw the changes.
    expect(recorder.mixed()).toEqual([]);
    const seen = recorder.seen();
    expect(seen.has('v1 b1 en|en')).toBe(true);
    expect(seen.has('v2 b1 en|en')).toBe(true);
    expect(seen.has('v2 b1 fr|fr')).toBe(true);
  });

  it('puts a reader that mounts later on the same release as the others', async () => {
    const r = rig();
    const recorder = commitRecorder();
    const config = r.world.config({ language: 'en' });
    const tree = (withLate: boolean) => (
      <recorder.Frame>
        <TarjimProvider config={config} start={r.start}>
          <Reader id="early" />
          {withLate ? <Reader id="late" /> : null}
        </TarjimProvider>
      </recorder.Frame>
    );
    const view = mount(tree(false));
    await untilText('early', 'v1 b1 en|en');
    await r.downloadNext('v2', 2);
    await act(async () => {
      r.runtime().activatePendingUpdate();
    });
    await untilText('early', 'v2 b1 en|en');

    view.rerender(tree(true));

    await untilText('late', 'v2 b1 en|en');
    expect(recorder.mixed()).toEqual([]);
  });
});

describe('applying a downloaded release', () => {
  it('leaves it pending, and says so, until it is activated', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <Reader />
        <api.Capture />
      </TarjimProvider>,
    );
    await untilText('reader', 'v1 b1 en|en');
    expect(api.latest().pendingUpdate).toBe(false);

    await r.downloadNext('v2', 2);
    await waitFor(() => expect(api.latest().pendingUpdate).toBe(true), { timeout: 1000 });
    expect(screen.getByTestId('reader').textContent).toBe('v1 b1 en|en');

    await act(async () => {
      r.runtime().activatePendingUpdate();
    });
    expect(api.latest().pendingUpdate).toBe(false);
    await untilText('reader', 'v2 b1 en|en');
  });

  it('activates it at once with activateImmediately, with no pending state left behind', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start} activateImmediately>
        <Reader />
        <api.Capture />
      </TarjimProvider>,
    );
    await untilText('reader', 'v1 b1 en|en');

    await r.downloadNext('v2', 2);

    await untilText('reader', 'v2 b1 en|en');
    expect(api.latest().pendingUpdate).toBe(false);
  });

  it('activates it on request through the hook, which says whether there was one', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });
    let none: boolean | undefined;
    await act(async () => {
      none = api.latest().activatePendingUpdate();
    });
    expect(none).toBe(false);

    await r.downloadNext('v2', 2);
    await waitFor(() => expect(api.latest().pendingUpdate).toBe(true), { timeout: 1000 });
    let activated: boolean | undefined;
    await act(async () => {
      activated = api.latest().activatePendingUpdate();
    });

    expect(activated).toBe(true);
    expect(api.latest().t('a')).toBe('v2 b1 en');
    expect(api.latest().pendingUpdate).toBe(false);
  });

  it('activates a release that is already pending when activateImmediately is switched on', async () => {
    const r = rig();
    const api = capture();
    const config = r.world.config({ language: 'en' });
    const tree = (immediately: boolean) => (
      <TarjimProvider config={config} start={r.start} activateImmediately={immediately}>
        <api.Capture />
      </TarjimProvider>
    );
    const view = mount(tree(false));
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });
    await r.downloadNext('v2', 2);
    await waitFor(() => expect(api.latest().pendingUpdate).toBe(true), { timeout: 1000 });

    view.rerender(tree(true));

    await waitFor(() => expect(api.latest().t('a')).toBe('v2 b1 en'), { timeout: 1000 });
    expect(api.latest().pendingUpdate).toBe(false);
  });

  it('keeps it waiting for the next page load by default', async () => {
    const r = rig();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <Reader />
      </TarjimProvider>,
    );
    await untilText('reader', 'v1 b1 en|en');

    await r.downloadNext('v2', 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByTestId('reader').textContent).toBe('v1 b1 en|en');
  });
});

describe('what a lookup returns', () => {
  it('carries no marker or invisible character, only the text of the release', async () => {
    const r = rig();
    const api = capture();
    mount(
      <TarjimProvider config={r.world.config({ language: 'en' })} start={r.start}>
        <api.Capture />
      </TarjimProvider>,
    );
    await waitFor(() => expect(api.latest().t('a')).toBe('v1 b1 en'), { timeout: 1000 });

    const { t, tArray, entry } = api.latest();
    const invisible = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿-]/u;
    expect(t('a')).toBe('v1 b1 en');
    expect(t('a')).not.toMatch(invisible);
    expect(t('missing.key')).toBe('missing.key');
    expect(entry('a')?.value).toBe('v1 b1 en');
    for (const value of [...tArray('a'), entry('a')?.value ?? '']) expect(value).not.toMatch(invisible);
  });
});
