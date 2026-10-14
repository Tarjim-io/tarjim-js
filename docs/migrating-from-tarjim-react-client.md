# Moving from tarjim-react-client to the web SDK

> **Not yet for customers.** The web SDK (`@tarjim/core`, `@tarjim/browser`) is `0.x` and
> pre-release. This note describes what a move will look like; the client you use today keeps
> working.

The old client (`tarjim-react-client`, "v2") is one class you construct and then call. The new SDK
(v3) is started once with `Tarjim.start()`, which gives you an instance. Lookups return plain strings.
The SDK never builds HTML or touches the page.

```js
// before
const client = new TarjimClient({ projectId, tarjimApikey, defaultLanguage, defaultNamespace });

// after
const tarjim = await Tarjim.start({
  deliveryUrl, // from the console; it already identifies your project
  apiKey,
  appVersion: '1.0.0', // your site's release
  defaultBundle: { type: 'namespace', name: 'default' },
  fallbackLanguage: 'en',
});
tarjim.t('app.title');
```

## Calls

| v2 | v3 |
|---|---|
| `new TarjimClient({ projectId, tarjimApikey, defaultLanguage, defaultNamespace, supportedLanguages, additionalNamespaces, cachedTarjimData, useSingleInstance, keyCase })` | `Tarjim.start({ deliveryUrl, apiKey, appVersion, defaultBundle, fallbackLanguage, language?, embedded?, … })`. The project is part of `deliveryUrl`. Namespaces become bundles that the track selects, so there is nothing to list in the page. The languages come from the release. Keep the instance `start()` returns in a module if you want one shared instance. |
| `__T(key, { namespace, mappings, subkey, skipTid, SEO })`, which returns a string or a `<span data-tid>` | `t(key, args?, { bundle?, namespace? })`, which always returns a string. There is no `<span>`. A value is untrusted text: if it may contain HTML, sanitising and rendering it is up to your page. |
| `__TS(key)` | `t(key)` |
| `mappings` with `%%name%%` placeholders | `t(key, { name: 'value' })` fills `{name}`. To keep `%%name%%` while you migrate, start with `legacyPercentPlaceholders: true`; it matches the name case-sensitively, where v2 matched case-insensitively. |
| `keyCase` (default `'lower'`, which lowercased every key; or `'original'`, `'preserve'`) | `keyCase: 'lower'` keeps the default; for `'original'` or `'preserve'`, leave it out, and names match exactly. Namespace names match exactly either way. |
| `__TM(key)` and `__TI(key)`, which return `{ src, data-tid, … }` for media | `entry(key)` returns `{ value, id, type, attributes, className }`. Take a media URL from `entry(key)?.value`, which is `https:` only; `t()` returns the raw value unchecked, so never use it for `src` or `href`. Copy the `attributes` you expect, never all of them. |
| `__TSEO`, `__TTT`, `__TMT`, `__TMD`, which write `document.title` and `<meta>` tags | Removed. Set them yourself: `document.title = tarjim.t('page.title')`. |
| `__TD(key)`, all languages for a key | Removed. One language is downloaded at a time; call `setLanguage()` to change it. |
| `setCurrentLocale(language)` and `getCurrentLocale()` | `setLanguage(language)`, which is async and resolves once the new language is showing, and the `language` property. `setLanguage` rejects when the release has no text for that language. |
| `on('finishedLoadingTranslations')` and `getIsLoadingTranslations()` | `await Tarjim.start()` resolves once the text held in the browser is ready. Add `waitForContent` to wait for the first download on a first visit. `tarjim.on('activated', listener)` tells you when newer text is showing. |
| `cachedTarjimData`, translations you ship inside your page | `embedded`, a list of slices. Include only what you need; lookups try them in the order given, after any downloaded text. |
| `data-tid` on every rendered string, used by the browser extension | Removed. `entry(key).id` is the key's id if you want to rebuild an in-context tool. |
| `keyCase: 'lower'` | Removed. Key names are used exactly as written in Tarjim. |

## Behaviour

- **Network.** v2 downloaded every language and namespace on each page load. v3 checks for a new
  release only when one is due, shares the result between tabs, and downloads one language and only
  the files that changed.
- **Host.** v2 had its address built in. v3 has none; you pass `deliveryUrl`.
- **Failures.** v2 logged to the console and could leave an empty cache. v3 keeps the last good text,
  backs off, reports a problem once a day through `onReport`, and never throws from a lookup.
- **First paint.** v2 read `localStorage` synchronously. v3 stores text in IndexedDB, so it is ready
  after `await Tarjim.start()`; before that there is no instance, so show your embedded text or a placeholder. Before the first release lands, lookups return the `embedded` text, else the key name.
- **Stored data.** v3 does not read or delete the v2 `localStorage` entry, so both can run side by
  side while you migrate.
- **Content Security Policy.** Allow your delivery host and the CDN host in `connect-src`; see the
  [`@tarjim/browser` README](../packages/browser/README.md).
