# @tarjim/browser

Tarjim translations in a web page: downloads your stage's released text, checks it against its
hashes, keeps it in the browser and answers lookups. It also builds the script-tag file
`tarjim-browser.iife.js`, which puts one global, `Tarjim`, on the page.

> **Not yet for customers.** This package is `0.x` and pre-release, published to npm on the `alpha`
> and `beta` tags only. Its API can still change between versions. Install it with
> `npm install @tarjim/browser@alpha`; a plain `npm install @tarjim/browser` also gets an alpha until
> `0.1.0` ships.

The runtime itself lives in [`@tarjim/core`](../core); this package supplies the browser's storage,
timers and tab coordination.

## Use it from a script tag

Every release on [GitHub](https://github.com/Tarjim-io/tarjim-js/releases) carries
`tarjim-browser.iife.js` and `tarjim-browser.iife.js.sha384`, its integrity value. The same file is in
the npm package, at `dist/tarjim-browser.iife.js`. Self-host it: copy it next to your page and load it
with its integrity value, never from a public CDN URL. To compute the value yourself:

```
openssl dgst -sha384 -binary tarjim-browser.iife.js | openssl base64 -A
```

Prefix the output with `sha384-`.

```html
<script src="tarjim-browser.iife.js" integrity="sha384-…" crossorigin="anonymous"></script>
<script src="tarjim-config.js"></script>
```

```js
// tarjim-config.js
Tarjim.start({
  deliveryUrl: 'https://delivery.example.com/…/delivery/meta', // copied from the console
  apiKey: 'YOUR-DELIVERY-KEY', // a key bound to a track and a stage; it is public in your page
  appVersion: '1.0.0',
  defaultBundle: { type: 'namespace', name: 'default' },
  fallbackLanguage: 'en',
  waitForContent: 3000,
}).then(function (tarjim) {
  document.querySelector('h1').textContent = tarjim.t('app.title');
});
```

`window.Tarjim` is an object whose keys are `start` and `version`; `start()` returns the instance.
[`examples/plain-html/with-package.html`](../../examples/plain-html) is a complete page with a
strict Content Security Policy and a language switch.

The integrity value must be regenerated every time the file changes, or the browser refuses to run
it.

## Use it from a bundler

```js
import { Tarjim } from '@tarjim/browser';

const tarjim = await Tarjim.start({ /* the same options */ });
```

The public API is `Tarjim.start`, the types `TarjimConfig`, `TarjimInstance`, `TarjimEntry`, `TarjimEvent`,
`TarjimEventType`, `TarjimReport`, `CheckResult`, `BundleRef`, `FormatArgs` and `LookupOptions`, and the
error classes `TarjimConfigError` and `TarjimLanguageError` (exported as values, so `instanceof` works).
`@tarjim/browser/internal` is not a public API and may change in any release.

## Options

| option | |
|---|---|
| `deliveryUrl` | required. The delivery URL from the console, used as given. |
| `apiKey` | required. A delivery key bound to a track and a stage. |
| `appVersion` | required. Your site's release, `MAJOR.MINOR.PATCH` (a `v` prefix or a suffix is stripped). Change it on every deploy. |
| `defaultBundle` | required. `{ type: 'namespace' \| 'custom', name }`, the bundle lookups read by default. |
| `fallbackLanguage` | required. Served when no other language matches the release. |
| `language` | the language to serve. Without it, the visitor's saved choice, then the browser's languages, then `fallbackLanguage`. |
| `persistLanguage` | save a language chosen with `setLanguage` even when `language` is set. |
| `embedded` | slices bundled with your page, used until a release is downloaded and as a last resort. |
| `waitForContent` | milliseconds `start()` may wait for the first downloaded release when nothing is held yet. |
| `fetch` | the function used for every request. Defaults to the page's `fetch`; pass your own to add a proxy or a test double. |
| `analytics` | `{ installId: false }` to send no install id (see below). |
| `legacyPercentPlaceholders` | `true` to fill `%%name%%` placeholders from named arguments. |
| `keyCase` | `'lower'` to match key names whatever their case, as tarjim-react-client did by default; `'exact'` (the default) matches them exactly. |
| `strict` | `true` to throw on a bad configuration instead of serving only the embedded text. |
| `onReport`, `debug` | `onReport` is called once per problem (its code and details) per day, and the SDK remembers that across reloads; `debug` logs reports at info level instead of debug. |

`start()` resolves once the text held in the browser is ready, which is usually immediately. Before
the first release lands, lookups return the `embedded` text, else the key name. Before `start()`
resolves there is no instance, so show your embedded text or a placeholder until it does.

## The instance

| | |
|---|---|
| `t(key, args?, { bundle?, namespace? })` | the text, or the key name when missing. `args` fills `{name}` from an object, or `%s %d %1$s` from an array. `{ count: n }` picks a plural form. |
| `tArray(key)` | a string array's items, in order |
| `entry(key)` | `{ value, id, type, attributes, className }`, or `null`. For media keys, `value` is an `https:` URL; take a media URL from `entry(key)?.value` and never from `t()`, which returns the raw value unchecked. |
| `language`, `ready` | the language being served; `ready` is always `true` on a resolved instance |
| `setLanguage(language)` | resolves once the new language is active; rejects when the release has none |
| `on(type, listener)` | `'downloaded'`, `'activated'` or `'languageChanged'`; returns a function that removes the listener |
| `checkNow()`, `activatePendingUpdate()` | check for a release now; switch to a downloaded one |
| `setInstallId(enabled)` | turn the install id on or off |
| `updates()` | the same events as an async iterator |
| `subscribe(listener)`, `getVersion()` | for UI frameworks: the listener fires when lookups may answer differently (a newer release is activated or the language changes, not when one is only `downloaded`), and `getVersion()` is the number that changes with it |
| `stop()` | stop checking for releases |

## What to know before you ship it

- **Values are untrusted text.** Insert them with `textContent`, never as HTML.
  `entry().attributes` is an allow-list of names; copy only the ones you expect onto an element,
  never spread them. `entry()` returns a media key only when its URL is `https:`; never put any other value into `href`
  or `src`. In particular, never use `t()` for `src` or `href`: it returns the raw value unchecked.
- **Content Security Policy.** `connect-src` must list your delivery host and the CDN host your
  releases are served from. For now that CDN host is under `*.cloudfront.net`; this will change to a
  Tarjim host. With `script-src 'self'` and the configuration in its own file, the page needs no inline script.
- **Self-host the script and pin it.** Serve `tarjim-browser.iife.js` from your own origin with an
  `integrity` attribute. Rebuild the hash whenever the file changes.
- **`appVersion` is your site's release.** Change it on every deploy; it is sent with every check.
- **`embedded` holds only what you need, in search order.** A lookup tries the downloaded text first,
  then each embedded slice in the order you list them, and the first one with the key wins. Every
  embedded byte is in your page, so include only the slices a first paint needs.
- **Prebuilt pages are not updated in the browser.** A statically generated page that carries its text
  at build time shows what it was built with; rebuild and redeploy when you release new text.
- **The install id needs consent.** The SDK stores a random identifier in the visitor's browser and
  sends it with every check so you can count active browsers; it is not linked to a person; sites
  subject to EU ePrivacy rules should start with `installId: false` and call `setInstallId(true)`
  after consent. Pass it as `analytics: { installId: false }`.
- **Persistent storage is your choice.** The SDK never calls `navigator.storage.persist()`. Without
  it the browser may clear the stored text under storage pressure, and the next visit downloads it
  again. Call `persist()` yourself if you want to ask for protection from that.
- It needs a secure page (`https`, or `localhost`) to verify downloads and IndexedDB for storage. Without either,
  only the `embedded` text is served.

See [PROTOCOL.md](../../PROTOCOL.md) for the wire contract. MIT licensed.
