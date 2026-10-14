# @tarjim/core

The runtime behind the Tarjim web SDK: the delivery protocol, hash verification, locale choice and
lookups, with no dependency on a browser. A platform supplies storage, timers and `fetch`; most sites
want [`@tarjim/browser`](../browser), which supplies the browser's.

> **Not yet for customers.** This package is `0.x` and pre-release, published to npm on the `alpha`
> and `beta` tags only. Its API can still change between versions. Install it with
> `npm install @tarjim/core@alpha`; a plain `npm install @tarjim/core` also gets an alpha until
> `0.1.0` ships.

## What it exports

```ts
import { createRuntime } from '@tarjim/core';

const tarjim = await createRuntime(config, platform);
tarjim.t('app.title');
```

- `createRuntime(config, platform)` resolves to the instance. It never rejects for a condition it can
  degrade from; with `strict: true` a bad configuration throws `TarjimConfigError`.
- `TarjimConfigError`, and `TarjimLanguageError`, which `setLanguage` rejects with when the release has no
  text for that language.
- `TarjimConfig`, the `Platform` a host provides, and the instance type `Tarjim`.
- `SDK_VERSION` and `API_VERSION`.

The options and the instance's methods are described in the [`@tarjim/browser`
README](../browser/README.md); they are the same.

## What to know before you build on it

- **Values are untrusted text.** Show them with `textContent` or a framework's text node, never as
  HTML. `entry().attributes` is an allow-list; copy only the attributes you expect, never spread them.
  Take a media URL from `entry(key)?.value`, which is `https:` only; `t()` returns the raw value
  unchecked, so never use it for `src` or `href`.
- **Content Security Policy.** In a browser, `connect-src` must list the delivery host and the CDN
  host the releases are served from.
- **`appVersion` is the site's release.** It changes on every deploy and is sent with every check.
- **`embedded` holds only what is needed, in search order.** A lookup tries the downloaded text first,
  then each embedded slice in the order given.
- **Prebuilt pages are not updated in the browser.** A statically generated page shows the text it was
  built with; rebuild and redeploy on each release.
- **The install id needs consent.** The SDK stores a random identifier in the visitor's browser and
  sends it with every check so you can count active browsers; it is not linked to a person; sites
  subject to EU ePrivacy rules should start with `installId: false` and call `setInstallId(true)`
  after consent. In the configuration it is `analytics: { installId: false }`.
- **Persistent storage is the site's choice.** Neither package calls `navigator.storage.persist()`;
  call `persist()` yourself to ask the browser not to clear the stored text.

MIT licensed.
