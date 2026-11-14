# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Ids: `D4-0x` are Sprint 2 items; `S3-D4-0x` are Sprint 3 items. Tester and product-owner finding ids
(`T3-S3-001`, `BUG-T1-S3-04`) are named where a line closes one.

### Added

- CI: `npm run pack:check` runs in the three-OS `check` job after `npm run ci`. The `npm.cmd` Windows branch of `pack-check` runs only on the owner's `windows-latest` CI read and has not been executed locally. (T3-S3-025)
- `*.tgz` is git-ignored so `npm pack` from a clone leaves no untracked tarball. (T3-S3-024)
- `src/events.ts` and an optional `events` sink on `createStore` (with `eventSession`): `storage.set`,
  `storage.get`, `storage.delete` and `storage.quota` events shaped by Event 0.1.2, source `localdata`,
  with `ns`, `driver`, `outcome`, `bytes` and `durationMs`; never a key, prefix, value, driver message
  or stack, and `ns` is `''` for a namespace that fails validation. The sink is called synchronously in
  `try`/`catch` and never awaited; a throwing or rejecting sink cannot break a call; re-entrant events
  are dropped; with no sink no clock is read. `STORAGE_EVENT_NAMES`, `EVENT_SPEC` and the `Event`,
  `EventSink`, `EventAttrs` types are exported. Tests first: `test/events.test.ts` (29 cases, red log
  before any code), a sentinel key/value test, a validator against the vendored `event.ts` and the
  sibling `event.schema.json`, and `test/browser/drivers.spec.ts` events cases over real OPFS and
  IndexedDB. (S3-D4-02, BUG-T1-S3-04)
- Vendored Event contract 0.1.2 (`src/contracts/event.ts`). `scripts/sync-contracts.mjs` now vendors
  `storage-api.ts` @ 0.1.0 and `event.ts` @ 0.1.2 and is gated on `SPEC-LANDED.txt`: every source file
  must hash to its recorded sha256 or nothing is copied. Lookup order: env `SPEC_LANDED`, then
  `../evidence/sprint-3/D1/`, then the maintainer scratch copy. Tampered-hash, missing-hash and
  lookup-order tests. (S3-D4-01, T3-S3-004)
- Demo: a live list of the last 50 `storage.*` events the page's own sink receives (DOM built with
  `createElement` and `textContent`), a status line naming them, and a not-yet item saying the DevTools
  panel does not read them from this page. (S3-D4-02)
- `test/portability.test.ts`: fails if a sprint scratch path or a home directory is hard-coded in a
  public file (`scripts/sync-contracts.mjs` excepted for its documented last-resort lookup), and checks
  that `pack-check` and `install.spec` use `mkdtemp`, `--out` and a Windows-safe `npm` spawn. (T3-S3-001)
- `scripts/pack-check.mjs` (`npm run pack:check`): `npm pack`, tarball rule checks (LICENSE and NOTICE,
  no source maps, no lifecycle scripts, nothing over 5 MB, honest README, no builder path), offline
  install into a fresh empty directory from an empty cache, and a real round trip from the installed
  copy that also checks the emitted events. (S3-D4-03)
- `test/browser/install.spec.ts`: a bundler-free OPFS page served from that fresh install. (S3-D4-03)
- README Install: "From a locally built tarball", the not-published sentence, "After the owner
  publishes" block. Demo status line "Sprint 3 (14 Nov 2026)". (S3-D4-03, S3-D4-04)

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

- README Status, Limitations and Security and privacy now say the `storage.*` events exist, are opt-in, synchronous and never awaited, and carry no key, prefix, value, driver message or stack; Event 0.1.2 namespace note added. (S1-078)
- `scripts/sync-contracts.mjs` no longer has a sprint-scratch lookup: `$SPEC_LANDED`, then `../evidence/sprint-3/D1/SPEC-LANDED.txt`, else exit 1 and nothing synced. `test/portability.test.ts` allows 0 scratch-path occurrences. (T3-S3-026, BUG-T2-S3-21)
- `scripts/pack-check.mjs` takes `--out <dir>` (default: a new `mkdtemp` directory under `os.tmpdir()`,
  removed on success) instead of a hard-coded sprint scratch path, builds first so a clean checkout
  works, spawns `npm` through `npm_execpath` (or `npm.cmd` through a shell on Windows), reads the
  installed copy instead of shelling out to `tar`, and writes `pack-check.json`. `install.spec.ts`
  uses its own `mkdtemp` scratch, removes only that, and serves files with a separator-safe
  containment check. (T3-S3-001)
- README: Status now follows the title and job, as in the conventions order; the Benchmarks table has
  an "8 GB Windows no-GPU laptop" column reading "not measured" and the Apple-silicon figures are from
  a Sprint 3 run (`evidence/sprint-3/D4/bench/raw.log`); the Limitations and Security sections describe
  the events and say that namespaces appear in them. (T3-S3-016, S3-D4-02)
- This changelog: Sprint 3 ids carry the `S3-` prefix so they no longer collide with the Sprint 2 ids.
  (T3-S3-016)
- `npm run build` no longer emits a source map and `package.json` `files` lists only
  `dist/index.js`, `dist/index.d.ts`, LICENSE, NOTICE and README, so the tarball has no `.map`.
  (S3-D4-03)

- README: the CI Chrome check first ran on GitHub on 9 Nov 2026; it is no longer called "configured, not yet
  executed".
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

- `npm run pack:check` and `npm run test:browser` (through `install.spec.ts`) no longer need a sprint
  scratch directory, a pre-built `dist/` (the CI browser job does not build) or POSIX path handling:
  they build first, use `os.tmpdir()` and `path.relative`, and were proven with `TMPDIR` pointing at a
  fresh directory and from a copy of the repository with no `dist/` and no sibling repositories.
  (T3-S3-001)
- Browser benchmark cases write their figures only when `LOCALDATA_BENCH_OUT` names a directory;
  the machine-specific scratch path is gone from `test/browser/drivers.spec.ts`.
- Vendored `src/contracts/storage-api.ts` re-synced from `runtime/spec` (`npm run sync-contracts`).

### Security

- `storage.*` events are built from fixed fields only: the namespace (or `''` when it fails
  validation), the driver name, an outcome from a closed set, byte counts and a duration. A sentinel
  key, value, prefix and driver error message never appear in an event, over every operation and every
  failure path, in Node and in Chrome. The namespace does appear; README "Security and privacy" tells
  applications not to encode personal data or document identifiers in namespace names. No network
  sink was added. (S3-D4-02)
- Install scripts are disabled (`ignore-scripts=true` in `.npmrc`). `esbuild` (via tsup) is the
  only dev dependency carrying an install script (`npm run deps:scripts` lists it alone); it is not
  executed. Playwright uses the installed Chrome via `channel: "chrome"`, so no browser download happens
  locally; CI on Linux uses the runner's preinstalled Chrome (see S1-064 below).
- No runtime dependencies. No network requests, no telemetry.
- CI `browser` job: removed `npx playwright install --with-deps chrome` (unpinned apt Chrome). It
  now runs `google-chrome --version` and fails when Chrome is missing; Playwright keeps channel
  `chrome`. Configured, not yet executed (runs only after the owner pushes). (S1-064)
