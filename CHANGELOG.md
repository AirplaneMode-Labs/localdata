# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Package skeleton for `@airplanemode/localdata` (placeholder scope until the npm handle is
  reserved): tsup ESM + d.ts build, Vitest unit tests, Playwright smoke tests on installed Chrome,
  three-OS CI, Apache-2.0 LICENSE and NOTICE.
- Vendored Storage API contract 0.1.0 (`src/contracts/storage-api.ts`) from `runtime/spec`, with
  `scripts/sync-contracts.mjs` and a drift test that skips when the sibling repository is absent.
- Behavioural suite `test/storage.behaviour.ts` (shared by every driver) and codec round-trip
  property tests, written before the implementation.
- SDK core: namespace and key validation, structured-clone-safe codec (`LD1` envelope),
  per-namespace quota accounting under the reserved namespace `__ld_meta`, TTL with an injectable
  clock, `list` with prefix, limit and cursor, `usage`, `clear`, `close`.
- Drivers: in-memory, OPFS (one file per key named by SHA-256 of the key, per-namespace
  `keys.json` index) and IndexedDB (database `airplanemode-localdata`, store `kv`).
- `query()` signature frozen; it rejects with `StorageError` code `not_implemented` until the
  vector index lands in Sprint 4.
- Public demo at <https://airplanemode-labs.github.io/localdata/> (`demo/`, bundled by
  `demo/build.mjs` with tsup, deployed by `.github/workflows/pages.yml`, built again in CI): driver
  picker, set/get/delete/list/usage, live `navigator.storage.estimate()` and `persist()`, the
  `query()` `not_implemented` error shown verbatim, and a quota fill under namespace `demo-fill`.
  No network requests; strict CSP meta; writes only under `airplanemode-localdata`.

### Fixed

- Browser benchmark cases write their figures only when `LOCALDATA_BENCH_OUT` names a directory;
  the machine-specific scratch path is gone from `test/browser/drivers.spec.ts`.
- Vendored `src/contracts/storage-api.ts` re-synced from `runtime/spec` (`npm run sync-contracts`).

### Security

- Install scripts are disabled (`ignore-scripts=true` in `.npmrc`). `esbuild` (via tsup) is the
  only dev dependency carrying an install script (`npm run deps:scripts` lists it alone); it is not
  executed. Playwright uses the installed Chrome via `channel: "chrome"`, so no browser download happens
  locally; CI on Linux runs `npx playwright install --with-deps chrome` as an explicit step.
- No runtime dependencies. No network requests, no telemetry.
- `.npmrc` sets `legacy-peer-deps=true` because npm 10.9.x aborts with "Cannot read properties of
  null (reading 'edgesOut')" while resolving vitest 4.1.x's optional peer set; vite is also a hard
  dependency of vitest, so nothing is left uninstalled.
