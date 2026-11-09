# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `test/query.behaviour.ts`: 13 `query()` cases for the Sprint 4 flat index (cosine, dot, k bounds,
  namespace isolation, empty store, deleted and overwritten keys, `filterPrefix`, dimension
  mismatch, zero vector, tie order), skipped with the note "Sprint 4: flat index", plus one live
  case asserting `not_implemented` naming Sprint 4. Wired into `test/memory.test.ts`. (D4-02)
- `docs/vector-index.md`: design note for the flat index, HNSW in Rust compiled to WASM, the OPFS
  and IndexedDB layout, quota accounting, the under-2-second cold-load target for 100k x 384 and
  proposed contract changes. (D4-03)
- Demo: build id shown from a validated 40-hex `GITHUB_SHA`, else `local`, rendered with
  `textContent`; not-yet box links the design note. (D4-04)

### Changed

- README: evidence citations point to `evidence/sprint-1/D4/`, Limitations links
  `docs/vector-index.md`, Develop carries the Vitest peer-dependency decision. (D4-04)
- Contract re-sync check: Storage API 0.1.0 unchanged and in sync. (D4-01)

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
- `.npmrc`: removed the global `legacy-peer-deps=true`; `npm ci` from the committed lockfile and
  `npm run ci` pass without it, and `package-lock.json` is unchanged. Matches runtime and dockit and
  the per-command guidance in README Develop. (T3-S2-R1-03)

### Fixed

- Browser benchmark cases write their figures only when `LOCALDATA_BENCH_OUT` names a directory;
  the machine-specific scratch path is gone from `test/browser/drivers.spec.ts`.
- Vendored `src/contracts/storage-api.ts` re-synced from `runtime/spec` (`npm run sync-contracts`).

### Security

- Install scripts are disabled (`ignore-scripts=true` in `.npmrc`). `esbuild` (via tsup) is the
  only dev dependency carrying an install script (`npm run deps:scripts` lists it alone); it is not
  executed. Playwright uses the installed Chrome via `channel: "chrome"`, so no browser download happens
  locally; CI on Linux uses the runner's preinstalled Chrome (see S1-064 below).
- No runtime dependencies. No network requests, no telemetry.
- CI `browser` job: removed `npx playwright install --with-deps chrome` (unpinned apt Chrome). It
  now runs `google-chrome --version` and fails when Chrome is missing; Playwright keeps channel
  `chrome`. Configured, not yet executed (runs only after the owner pushes). (S1-064)
