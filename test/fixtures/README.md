# Fixtures

Server answers the tests replay. Nothing here is fetched at test time.

- `errors/` holds answers a client has to handle, one envelope per file.
- `recorded/<name>/` holds a recording made by `scripts/capture-fixtures.sh`: `meta.<mode>.json`,
  `manifest.json` (the raw manifest bytes), `objects/<sha256>.<fileType>` (every object the manifest
  lists, as decoded bytes), `recording.json` and its own `errors/`.
- `cors/` holds the CORS options the API applies to the delivery routes.

An envelope is `{provenance, status, headers, body}`; `body` is the response body as a string, or null.

## Provenance

`errors/` is HAND-BUILT from the server's documented response shapes. `cors/` is read from the server
source until a live preflight is recorded. Recordings are made from a project created only for
fixtures, filled by `scripts/seed-fixture-project.sh`: their manifest and objects are hash-chained and
cannot be edited, so they must never come from a project with real content or users.

The capture rewrites `meta`: hosts become `*.invalid`, the signature a placeholder, and the tenant and
project ids in its URLs `1`; the recorded error bodies get the same id rewrite. The manifest and the
objects are kept byte for byte, so any id inside them is the fixtures project's own. Bodies are stored decoded, so object hashes are those of the decoded bytes
and no `Content-Encoding` header is kept.

## Before committing a recording

Run `pnpm test`. The leak scan and the hash-chain check must pass. If the scan flags a recording,
capture again; never edit it.
