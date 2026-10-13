# Tarjim delivery protocol for clients

This is what a client sees on the wire when it downloads a project's released translations, and
what it must do with each answer. `reference/tarjim-reference.js` implements all of it in one
readable file. If you write your own client, read both.

## 1. What a client is given

- **A delivery URL**, copied from the console: `https://<host>/…/delivery/meta`. Treat it as opaque.
  Use it exactly as given, never build it from parts, never parse its path, and never add a trailing
  slash.
- **A delivery key**, bound to one track and one stage.

> ⚠ **Any key in a web page is public.** Anyone can read it with View Source. The only key to put in a
> page is a delivery key bound to a track and a stage, which can do nothing but read that stage's
> release. Never put any other key in a page. An unbound key acts with its creator's full rights.

## 2. Reading `meta`

```
GET <delivery URL>?appVersion=<MAJOR.MINOR.PATCH>[&<identity>…]
X-Tarjim-Apikey: <delivery key>
X-Tarjim-Api-Version: 2026-07-29
```

- The key travels **only** in `X-Tarjim-Apikey`: never in a URL, a log line or an error message.
- `appVersion` is required, exactly once, and raw (not percent-encoded). Its value is
  `MAJOR.MINOR.PATCH` with no leading zeros, at most 32 characters. A missing or malformed value
  answers `400 delivery.app_version_required`, so normalise before sending:
  - strip a leading `v`;
  - keep up to three leading numeric parts and drop leading zeros;
  - pad with `.0`;
  - send `0.0.0` if nothing parses.

  `appVersion` is the version of YOUR site or app, not of the client. It must change with every
  release you ship.
- Optional identity parameters, all ignored if malformed: `platform` (e.g. `web`), `sdkVersion`,
  `release` (the release id you hold, `0` for none), `language` (the locale you serve). Two more need
  care:
  - Send `pollSeconds` only if your client really waits that long between checks. A client that
    checks on every page load must not send it.
  - Send `installId` only with a stored per-browser identifier, and only where your consent rules
    allow it.
- Do not follow redirects. A redirect would carry the key to another host; treat it as a network
  failure.
- In a browser, the two headers make the request preflighted. The delivery routes allow
  the two headers from any origin without credentials, and expose `Retry-After`. Send no cookies
  (`credentials: 'omit'`).

A `200` answer is JSON. The fields a client uses:

| field | meaning |
|---|---|
| `schemaVersion` | `1`. An unknown value: keep what you hold, do not read further. |
| `checksum` | sha256 (hex) of the manifest's bytes |
| `manifestUrl`, `slicesBaseUrl` | where the manifest and the slices are (see section 4) |
| `authenticated` | `true`: origin mode; anything else: CDN mode (section 4) |
| `signedQuery` | CDN mode only: the query string to append to every object URL |
| `track`, `stage` | the binding. `track: null` means the key is NOT bound, and a web client must stop. |
| `releaseId` | the release the stage points at |
| `pollAfter` | the minimum number of seconds before the next `meta` check |

Other fields are informational. Ignore what you do not know.

### Answers other than 200

The body of an error is `application/problem+json` with a `code`.

| status · `code` | meaning | what to do |
|---|---|---|
| 400 `delivery.app_version_required` | `appVersion` missing or malformed | configuration error. Fix the client. |
| 401 `unauthorized` | key missing, malformed or revoked | configuration error |
| 403 `delivery.apikey_project_mismatch`, `forbidden` | the key belongs to another project, or may not read delivery | configuration error |
| 404 `delivery.track_not_found`, `delivery.stage_not_found` | the binding names something that no longer exists | configuration error. Wait `pollAfter` (in the body) before checking again. |
| 404 `delivery.stage_unreleased` | nothing released to this stage yet | normal. Wait `pollAfter` (in the body). |
| 404 `not-found` | no such project | configuration error |
| 429 | throttled | back off; wait at least `Retry-After` if present |
| 5xx, network failure | server or network trouble | back off and keep what you hold. Never discard text because a check failed. |

A browser cannot read a failed response without CORS headers: it sees a network failure. Treat a
network failure exactly like a 5xx.

## 3. The manifest

`GET manifestUrl` (see section 4 for the URL and headers). Verify that the sha256 of the **bytes received**
(after any transfer decoding) equals `meta.checksum`. A mismatch is a failed download, not a manifest.

```json
{
  "schemaVersion": 1,
  "baseLocale": "en",
  "bundles": {
    "ns7":  { "type": "namespace", "name": "default" },
    "b3":   { "type": "custom", "name": "checkout-screen", "layout": "nested", "namespaces": ["default", "checkout"] }
  },
  "slices": {
    "ns7": { "en": { "json": { "hash": "<sha256>", "size": 311, "transferSize": 245 }, "strings": { … } } }
  }
}
```

- `slices[bundleId][locale][fileType]` names one file. A JSON client reads only `json` and ignores
  every other type (`strings`, `stringsdict`, `xml` are for native apps).
- Locale keys are BCP 47 tags spelled as the project spells them. Match them case-insensitively, and
  request only a locale the manifest lists, never one you constructed.
- Look a bundle up by `type` AND `name`, since a custom bundle may share a namespace's name. If two
  bundles share both, the lowest numeric id wins (`ns7` before `ns10`).

## 4. Delivery modes and object URLs

| | origin mode (`authenticated === true`) | CDN mode (anything else) |
|---|---|---|
| `manifestUrl`, `slicesBaseUrl` | relative to the delivery URL: resolve them against it (`new URL(ref, deliveryUrl)`). If the result's origin is not the delivery URL's origin, do not send the request. | absolute `https` URLs; refuse anything else |
| request headers | the same two headers as `meta` | **none**. A simple `GET`, no credentials. |
| query string | none | append `?` + `signedQuery`, verbatim |

The object URL of a file is `slicesBaseUrl + hash + "." + fileType`, plus the signed query in CDN mode.
Build it only when `hash` is 64 lowercase hex characters. **Never send the key headers to any origin but
the delivery URL's**, whatever a response says.

- In CDN mode, a 403 on an object means the signature expired or the object is gone; the two cannot
  be told apart. Re-read `meta` **once**. If its `checksum` is unchanged, retry with the new
  `signedQuery`; if the checksum changed, the stage moved to another release: give up on these files.
  If the retry fails too, keep what you hold for that file and try again at the next check. A browser
  may see the failure as a network error; treat that the same way.
- In origin mode, a 403, 404 or 503 on an object means the file cannot be fetched this time. Keep what
  you hold.
- Objects are immutable (content-addressed), so an HTTP cache may keep them.

## 5. Slices

Verify each file: the sha256 of the bytes received equals `hash`, and its length equals `size`.
`transferSize` is advisory. A file that fails verification is never used.

A JSON slice:

```json
{
  "schemaVersion": 1,
  "bundle": "ns7",
  "locale": "en",
  "keys": {
    "app.title":        { "id": "101", "value": "Tarjim" },
    "cart.items":       { "id": "102", "value": "", "plural_child_keys": [103, 104] },
    "cart.items.one":   { "id": "103", "value": "One item" },
    "cart.items.other": { "id": "104", "value": "%d items" },
    "menu":             { "id": "105", "value": "", "string_array_child_keys": [106, 107] },
    "menu.0":           { "id": "106", "value": "Home" },
    "menu.1":           { "id": "107", "value": "About" },
    "hero":             { "id": "108", "value": "https://…/hero.png", "type": "image", "attributes": { "alt": "…" } }
  }
}
```

- A slice whose `schemaVersion` you do not know must not be decoded.
- A custom bundle with `layout: "nested"` has `namespaces: { <namespace>: { <key>: leaf } }` instead
  of `keys`. Search its namespaces in the order of the manifest entry's `namespaces` array, never in
  the JSON object's key order, then any other namespace present.
- **Plurals.** A parent lists its forms by id in `plural_child_keys`. Each child is a sibling leaf
  named `<parent>.<form>` (`zero`, `one`, `two`, `few`, `many`, `other`):
  - Find children by id, never by name alone.
  - Choose the form with the plural rules of the text's locale, not the device's.
  - If the count is `0` and a `zero` child exists, use it in every language.
  - If the chosen form is missing, use `other`.
- **String arrays.** A parent lists its items by id, in order, in `string_array_child_keys`.
- **Media.** `type` is `image`, `audio/video` or `file`, and `value` is the file's URL. Like any value
  it is written by a translator: use it only after checking it is an `https:` URL, and never assign an
  unchecked value to `href` or `src` (a `javascript:` or `data:` URL there runs script).
- An empty `value` means "not translated". A key with no value in a locale may be absent.
- Keys match exactly and are case-sensitive.
- Values are text written by translators. Treat them as **untrusted**: never insert one into a page as
  HTML. The same goes for `attributes`: copy only the attribute names you expect (e.g. `alt`, `title`,
  `width`, `height`) and never spread the object onto an element.
- Leaves carry fields not listed here. Ignore them.

## 6. Choosing what to serve

- Serve ONE locale per user: the one asked for if the manifest lists it, otherwise your fallback
  language, as a whole. A key missing in that locale shows its fallback text (or its name). It is
  never taken from another locale, which would mix languages on one screen.
- A client that holds a previous release switches to a new one only when every file it needs from it
  is verified, so a failed download never changes what is shown. A client that holds nothing (such
  as the reference client) may serve the files that verified and show key names for the rest.
- Values pass through as authored. Placeholder conventions a client may implement: `{name}` from
  named arguments; `%s`, `%d`, `%@`, `%1$s`, `%%` from positional arguments; and, as a legacy form,
  `%%name%%`.

## 7. When to check again

- `pollAfter` is the minimum interval between `meta` checks. A client that keeps state should check no
  sooner, add a little random jitter, and share one check across tabs.
- On a 5xx, a 429 or a network failure, back off exponentially from 60 seconds up to `pollAfter`, and
  wait at least `Retry-After` when it is present.
- A client with no storage (such as the reference client) checks once per page load and therefore
  must not send `pollSeconds`.

## 8. Compatibility

- Fields, parameters and codes not listed here may be added at any time. Ignore what you do not know.
- A change a client cannot ignore comes with a new `schemaVersion`. When you see one you do not know,
  keep what you hold and report it.
