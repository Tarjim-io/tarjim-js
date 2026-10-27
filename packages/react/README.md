# @tarjim/react

React bindings for the Tarjim web SDK: a provider and a hook.

> **Pre-release, not yet for customers.** The version is `0.x`, the package is published to npm on the
> `alpha` and `beta` tags only, and the API may still change. Install it with
> `npm install @tarjim/react@alpha`.

Needs React 18 or newer. [`examples/react`](../../examples/react) is a complete app.

## Before you start

To try it, set up delivery in the console:

1. Create a track, and a stage in it with **Follow latest** turned on, so the stage serves your
   latest translations without a manual release.
2. Create a key bound to that stage.
3. Copy the delivery URL the console shows for it.

Use only a key bound to a stage. A key bound to no track and stage can act as its creator
everywhere, so the SDK serves only the embedded text with it and reports `unbound-key`.

## Use it

Create the config once, outside any component, and wrap the app:

```tsx
import { TarjimProvider, useTarjim } from '@tarjim/react';
import type { TarjimConfig } from '@tarjim/react';

const config: TarjimConfig = {
  deliveryUrl: 'https://…/delivery/meta', // copied from the console
  apiKey: 'YOUR-DELIVERY-KEY', // a key bound to a track and stage
  appVersion: '1.0.0',
  defaultBundle: { type: 'namespace', name: 'default' },
  fallbackLanguage: 'en',
};

root.render(
  <TarjimProvider config={config} fallback={<p>Loading…</p>}>
    <App />
  </TarjimProvider>,
);

function Cart({ count }: { count: number }) {
  const { t } = useTarjim();
  return <p>{t('cart.items', { count })}</p>;
}
```

### `<TarjimProvider>`

| prop | |
|---|---|
| `config` | required. The SDK's configuration. Read once; see rule 3. |
| `fallback` | rendered until the local text is ready, for at most about a second. Default: nothing. |
| `activateImmediately` | `true` to show a downloaded release as soon as it arrives. Default `false`: it shows at the next page load. |
| `setDocumentLanguage` | `false` to leave `<html lang>` and `dir` alone. Default `true`. The provider puts back the values the page had when it unmounts or this is switched off. |
| `hydrating` | `true` when the provider mounts on server- or build-rendered HTML; see below. |
| `start` | replaces how the SDK is started (for tests). Defaults to `Tarjim.start` from `@tarjim/browser`. |

### `useTarjim()`

Returns `{ t, tArray, entry, language, setLanguage, checkNow, activatePendingUpdate, ready, pendingUpdate }`.

- `t(key, args?, options?)`, `tArray(key)` and `entry(key)` behave as in the core client.
- `setLanguage(language)` switches language; it rejects when there is no text for it. Called before the
  SDK has started, it waits for it.
- `checkNow()` asks the server for a newer release now. It waits for the SDK the same way.
- `activatePendingUpdate()` shows a downloaded release now and returns `true`, or returns `false` when none is
  waiting. Switching `activateImmediately` on while a release is waiting shows it too.
- `ready` is `true` once the local text is available.
- `pendingUpdate` is `true` while a release is downloaded and waiting to be shown.

Outside a `<TarjimProvider>` the hook throws an error that names the provider.

The package also exports the SDK's types (`TarjimConfig`, `TarjimEntry`, `FormatArgs`, `LookupOptions`, `BundleRef`,
`Slice`, `TarjimReport`, `CheckResult`) and its error classes `TarjimConfigError` and `TarjimLanguageError`, so an app
needs no direct dependency on `@tarjim/browser`.

## The four rules

1. **`ready` never waits on the network.** The provider starts the SDK with `waitForContent: 0`, whatever
   the config says, so `ready` means the text already on the device (a stored release, else the
   embedded text) can be read. Until then the provider renders `fallback`; after about a second it
   renders its children anyway, and until the SDK answers, lookups return the text in `config.embedded`
   (the key name for anything it does not hold) while `ready` stays `false`.
2. **`t` changes identity** whenever the text it returns could change: a release is shown, or the
   language changes. A `useMemo` or `useCallback` that lists `t` recomputes exactly then. One commit
   never mixes two releases or two languages: every component under the provider reads the same one.
   `tArray` and `entry` change with it.
3. **The config is read once**, at the first render. Passing a new config object later starts nothing
   and, in development, logs one warning. Only `config.language` is followed: when it changes the
   provider calls `setLanguage`. StrictMode starts one SDK, not two, and unmounting the provider stops it.
4. **`activateImmediately`** decides when a downloaded release shows. By default it waits for the next
   page load, so the text on screen never changes under the reader; `pendingUpdate` tells you one is
   waiting. With `activateImmediately` it shows at once.

## Pages built ahead of time

Mount the provider with `hydrating` when its HTML was rendered on a server or at build time:

```tsx
hydrateRoot(document.getElementById('root')!, (
  <TarjimProvider hydrating config={config}>
    <App />
  </TarjimProvider>
));
```

A hydrating provider is **embedded-only for the life of the page**. `config.embedded` must be an array
of slices, and the provider answers from it alone, from the first render on, so the client's first
render is identical to the server's. It starts no SDK, opens no store, makes no request and never
shows a newer release; `ready` is `true` at once, `pendingUpdate` is always `false`, and `checkNow()`
resolves to `'notDue'`. `setLanguage` works between the embedded languages only. `waitForContent` is
ignored (with a development warning). An `embedded` that is not an array is also reported once through
`config.onReport` with the code `embedded-invalid`, and the keys are drawn.

A prebuilt page therefore gets no in-browser updates: **rebuild the site when you release.**

## Values are untrusted text

Render what `t` returns as React text, which React escapes, and never through `dangerouslySetInnerHTML`.
This package has no helper that writes HTML, and its lookups return plain text with no markers.

## Development warnings

The warnings (a changed config, `waitForContent` while hydrating, a bad `embedded`, a `config.language` that
cannot be set) are stripped from production builds: each sits behind `process.env.NODE_ENV !== 'production'`,
so a bundler that replaces that expression leaves none of their text in the bundle. Where nothing defines
`process` at all, there are no warnings.
