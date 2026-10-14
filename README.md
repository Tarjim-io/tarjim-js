# tarjim-js

JavaScript clients for Tarjim's translation delivery.

> **Not yet for customers.** Versions are `0.x` and published as GitHub pre-releases while we test
> them internally.

## The reference client

`reference/tarjim-reference.js` is one readable file with no dependencies. On each page load it
downloads your stage's released translations, checks them against their hashes, and answers lookups.
Use it two ways:

- **Embed it**: a copy-paste snippet for a site with no build step.
- **Read it**: it is the executable description of the protocol. To write a client in another
  language, port it alongside [PROTOCOL.md](PROTOCOL.md).

### Embed it

1. Download `tarjim-reference.js` from a [release](../../releases). Check it against the sha256 in the
   release notes, then put it next to your page.
2. Add the snippet:

```html
<script src="tarjim-reference.js"></script>
<script>
  TarjimReference.start({
    deliveryUrl: 'https://…/delivery/meta', // copied from the console
    apiKey: 'YOUR-DELIVERY-KEY', // a key bound to a track and stage
    appVersion: '1.0.0', // your site's release; change it on every deploy
    defaultBundle: { type: 'namespace', name: 'default' },
    language: 'ar',
    fallbackLanguage: 'en',
  }).then(function (tarjim) {
    document.querySelector('h1').textContent = tarjim.t('app.title');
  });
</script>
```

[`examples/plain-html`](examples/plain-html) has a complete page, and a variant for a strict
Content Security Policy that keeps the configuration in its own file.

`start()` always resolves, never rejects. When something is wrong (a bad configuration, an insecure
page, a network failure), you get a client whose lookups return the key names, plus one report on
`console.debug` and to `onReport`.

| option | |
|---|---|
| `deliveryUrl` | required. The delivery URL from the console, used as given. |
| `apiKey` | required. A delivery key bound to a track and a stage. |
| `appVersion` | required. Your site's version, `MAJOR.MINOR.PATCH`. A `v` prefix or a suffix is stripped. |
| `defaultBundle` | required. `{ type: 'namespace' \| 'custom', name }`, the bundle lookups read by default. |
| `fallbackLanguage` | required. Served when `language` is not in the release. |
| `language` | the locale to serve; defaults to `fallbackLanguage` |
| `legacyPercentPlaceholders` | `true` to substitute `%%name%%` placeholders from named arguments |
| `onReport` | `function (report) {}`, called once per kind of problem |

| on the client | |
|---|---|
| `t(key, args?, { bundle?, namespace? })` | the text, or the key name when missing. `args` fills `{name}` from an object, or `%s %d %1$s` from an array. `{ count: n }` picks a plural form. |
| `tArray(key)` | a string array's items, in order |
| `entry(key)` | `{ value, id, type, attributes, className }`, or `null`. Use it for media keys: their `value` is an `https:` URL, or the entry is `null`. |
| `language` | the locale being served |
| `active` | whether translations were loaded |

To switch language, call `start()` again.

### What to know before you ship it

- **The key is public.** Anyone can read a key in a web page. Only ever use a delivery key bound to a
  track and a stage, never any other key.
- **Values are untrusted text.** Insert them with `textContent`, never `innerHTML`. Copy only the
  `entry().attributes` you expect; never spread them onto an element. `entry()` returns a media key
  only when its URL is `https:`; never put any other value into `href` or `src`.
- **Every page load waits for the network.** The client keeps nothing between page loads, so key names
  show until the first check finishes. It suits a demo, a small site, or a port to another language.
- **Your copy never updates itself.** Watch this repository's releases for fixes (see
  [SECURITY.md](SECURITY.md)).
- **Content Security Policy:** `connect-src` must list your delivery host and the CDN host your
  releases are served from.
- It needs a secure page (`https`, or `localhost`) to verify downloads, and a browser from 2022 or
  later (Chrome 90, Firefox 96, Safari 15.4).

## Packages

The packages below are `0.x` and not yet for customers. They are published to npm on the `alpha`
and `beta` channels for internal testing, all three always at the same version:

```
npm install @tarjim/browser@alpha
npm install @tarjim/browser@beta
```

To build them from this repository instead, run `pnpm install && pnpm build`.

| package | |
|---|---|
| [`@tarjim/core`](packages/core) | the runtime: delivery protocol, verification, locale choice and lookups |
| [`@tarjim/browser`](packages/browser) | the browser's storage and timers around the core, and the script-tag file `tarjim-browser.iife.js` |
| [`@tarjim/react`](packages/react) | a provider and a hook for React 18 and later |

[`examples/plain-html/with-package.html`](examples/plain-html) loads the script-tag file with a
strict Content Security Policy. Its `integrity` value is the sha384 of the built file, so print a new
one with `node scripts/sri.mjs packages/browser/dist/tarjim-browser.iife.js` and paste it into the
page whenever the file changes. Moving from the older `tarjim-react-client`? See
[the migration note](docs/migrating-from-tarjim-react-client.md).

## Development

```
pnpm install
pnpm test
```

See [CLAUDE.md](CLAUDE.md) for the repository's rules and scripts. MIT licensed.
