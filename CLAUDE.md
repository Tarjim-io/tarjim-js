# Tarjim JavaScript SDK

The web runtime half of the Tarjim SDK. Today it holds the reference client: one readable,
dependency-free file (`reference/tarjim-reference.js`) that fetches a stage's released translations,
verifies them and answers lookups. It loads as a classic script (`globalThis.TarjimReference`) and is
self-hosted by the site that uses it. MIT licensed. Versions stay `0.x` until the first public release.

## Commands

- Install: `pnpm install` (pnpm 10, Node 20.19+ or 22.12+)
- Test: `pnpm build` first (the script-tag tests read the built file), then `pnpm test`
- Record fixtures from a live server: `scripts/capture-fixtures.sh --help`
- Fill a fixtures-only project with invented keys: `scripts/seed-fixture-project.sh --help`
- Scan for keys, signatures, real hosts and ticket ids (CI runs it): `scripts/secret-scan.sh`
- Script-tag build: `pnpm build` writes `packages/browser/dist/tarjim-browser.iife.js`. Whenever it changes, regenerate the `integrity` in `examples/plain-html/with-package.html` with `node scripts/sri.mjs <file>` (`test/script-tag.test.js` fails when it is stale).
- Release: push a tag `reference-v<x.y.z>` matching `VERSION` in the file. `.github/workflows/release.yml`
  publishes it as a pre-release with its sha256, only from a commit on `main`. Making a release
  customer-facing is a separate, deliberate step: rewrite its notes without the pre-release warning
  (`gh release edit <tag> --notes-file …`), then `gh release edit <tag> --prerelease=false --latest`.
- Release the npm packages (`@tarjim/core`, `@tarjim/browser`, `@tarjim/react`, always one shared
  version): `node scripts/set-version.mjs <version>`, commit it as `chore(release): v<version>`, open a
  PR, merge, then tag the merge commit `v<version>` and push the tag. `.github/workflows/release-packages.yml`
  tests and packs the packages in a job that holds no secret, then a second job, which installs
  nothing, re-checks the tag against the files (`scripts/release-packages.sh --tag v<version>` prints
  the channel), publishes the packed tarballs core, browser, react in that order with provenance,
  and opens a GitHub release carrying `tarjim-browser.iife.js` and its sha384.
  - Channels: `v0.2.0-alpha.1` publishes to npm dist-tag `alpha`, `v0.2.0-beta.1` to `beta`, plain
    `v0.2.0` to `latest`. Alpha and beta are GitHub pre-releases. No package release is marked
    "Latest" on GitHub; that is a deliberate step, like the reference client's.
  - Only admins can push `v*` and `reference-v*` tags (a tag ruleset), and `main` takes changes only
    through a pull request with green CI (a branch ruleset), so the "tag is on main" check means reviewed code.
  - npm points `latest` at a package's first publish even when it is published with `--tag alpha`
    (and forbids removing `latest`). Until `0.1.0` ships, a plain `npm install @tarjim/browser` gets
    that alpha: always install with `@alpha` or `@beta`.
  - Publishing uses npm Trusted Publishing: each package on npmjs.com lists `Tarjim-io/tarjim-js` and
    `release-packages.yml` as its trusted publisher (a maintainer setting), and the publish job swaps
    its short-lived OIDC identity for npm access. There is no npm token in the repository. The packages
    are set to require 2FA and disallow tokens (also a maintainer setting).
  - The account may hold a publish for 2FA approval on npmjs.com (staged publishing). If a release
    shows `0.0.0-stage`, approve the staged versions on npmjs.com.
  - A publish that stops half-way (core is out, browser is not) cannot be undone on npm. Do not
    re-run it: bump the counter (`-alpha.1` to `-alpha.2`, or the patch number for a plain version),
    and release again.
  - If every publish step succeeded and only the GitHub release step failed, do not re-run the
    workflow either (the versions are already on npm). Create the release by hand with
    `gh release create v<version> --verify-tag --latest=false` (add `--prerelease` for alpha and
    beta), attaching `tarjim-browser.iife.js` and its `.sha384` from the workflow run's `release`
    artifact (kept one day).

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
