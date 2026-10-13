# Tarjim JavaScript SDK

The web runtime half of the Tarjim SDK. Today it holds the reference client: one readable,
dependency-free file (`reference/tarjim-reference.js`) that fetches a stage's released translations,
verifies them and answers lookups. It loads as a classic script (`globalThis.TarjimReference`) and is
self-hosted by the site that uses it. MIT licensed. Versions stay `0.x` until the first public release.

## Commands

- Install: `pnpm install` (pnpm 10, Node 20.19+ or 22.12+)
- Test: `pnpm test`
- Record fixtures from a live server: `scripts/capture-fixtures.sh --help`
- Fill a fixtures-only project with invented keys: `scripts/seed-fixture-project.sh --help`
- Scan for keys and signatures (CI runs it): `scripts/secret-scan.sh`
- Release: push a tag `reference-v<x.y.z>` matching `VERSION` in the file. `.github/workflows/release.yml`
  publishes it as a pre-release with its sha256; making a release customer-facing is a separate,
  deliberate `gh release edit <tag> --prerelease=false --latest`.

## Layout

- `reference/tarjim-reference.js`: the reference client. No `export`, no dependencies; configuration
  lives in the page, never in the file, so a self-hosted copy stays identical to the release asset.
- `test/`: Vitest. `test/helpers/load-reference.js` runs the file as a classic script in a fresh
  context, as a browser would.
- `test/fixtures/`: hand-built server answers and, under `recorded/<name>/`, recordings (see the
  README there).
- `scripts/`: fixture, scan and release tooling.
- `examples/plain-html`: the embed snippet, tested by `test/examples.test.js`.
- `PROTOCOL.md`: the public wire contract. Wire-facing only: no internal host, id, cache or rate-limit
  detail. Change it in the same PR as any change to what the client sends or reads.

## Rules

- This repository is public. Never commit an API key, a signature, a signed URL, a real hostname (use
  `*.invalid`, `example.com` and its subdomains), a staging or production URL, an internal ticket id,
  or a reference to private planning documents. Describe what the code does, not how it was decided.
- Tests first. A test must be seen failing for the right reason before the code that satisfies it.
- Fixtures are recorded or hand-built and never edited after recording; editing breaks the hashes.
  Record only from a project made for fixtures — a slice cannot be scrubbed.
- Scripts take keys from environment variables only, never from arguments, files in the repo or output.
- A commit message is a single line — no body, no trailers such as `Co-Authored-By` — at most
  50 characters, `type(scope): description`.
- Pull requests follow `.claude/skills/pr/SKILL.md`; `.github/PULL_REQUEST_TEMPLATE.md` mirrors it.
- The API key only travels in the `X-Tarjim-Apikey` header, never in a URL, a log line, a report or an
  error.
- Values are untrusted text. The reference client never writes HTML.
