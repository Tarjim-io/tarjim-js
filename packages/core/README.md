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

## Producing `embedded` text: `tarjim-pull`

`tarjim-pull` downloads slices of a stage's current release and writes them to a file as one JSON
array, ready to pass as `embedded`. It checks the manifest against `meta.checksum` and every slice
against its hash, as the SDK does in the browser. Use it to commit a snapshot of your text for
end-to-end tests, or for a first visit before anything has downloaded.

```sh
TARJIM_APIKEY=tj_prod_… npx -p @tarjim/core@alpha tarjim-pull \
  --delivery-url https://<host>/delivery/<public id>/meta \
  --bundle spa --locale en --out src/i18n/embedded-en.json
```

```js
import embeddedEn from './i18n/embedded-en.json';
Tarjim.start({ /* … */ defaultBundle: { type: 'custom', name: 'spa' }, embedded: embeddedEn });
```

| Option | |
|---|---|
| `--delivery-url <url>` | the distribution's Delivery URL. Or set `TARJIM_DELIVERY_URL`. |
| `--out <file>` | required. The file to write. |
| `--bundle <name>` | a bundle to include, by its name in the console. Repeat for more. Default: every bundle. |
| `--locale <tag>` | a locale to include, matched whatever its case. Repeat for more. Default: every locale of each bundle. |
| `--app-version <x.y.z>` | the app version to ask for. Default: none, which is served as the newest app. |
| `--help` | print the usage. |

- **The key comes from `TARJIM_APIKEY` only**, never from an argument, and is never printed.
- **It always takes the stage's current release.** There is no way to pin an older one.
- **The output diffs cleanly:** slices are sorted by bundle id, then locale, and kept exactly as the
  server sent them. A second pull of the same release writes the same bytes.
- **On success** it prints one line naming the release and what it wrote, such as
  `release 5 checksum 4fb6… · spa: ar, en`, and exits 0. Check that line when you expected fewer locales.
- **On any failure it writes nothing and exits 1**, with one line on stderr: a refused key or URL, a
  stage with nothing released, a manifest or slice that fails its check, a bundle or locale the
  release does not have, or a network error. An existing file is left as it was.

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
