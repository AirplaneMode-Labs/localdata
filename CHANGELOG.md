# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0-alpha.0] - 2026-11-14 (untagged)

Nothing has ever been tagged or published, so everything since the first commit ships in this one
version; the Sprint 4 items come first in each section. Ids: `D4-0x` are Sprint 4 items (plus a few
Sprint 2 ones); `S3-D4-0x` are Sprint 3 items. Tester and product-owner finding ids (`T3-S3-001`,
`BUG-T1-S3-04`) are named where a line closes one. Storage API 0.2.0 and Event 0.1.3 are vendored from
spec release 0.4.0 in runtime/spec (committed; public after the owner's push).

### Added

- A flat vector index, persisted beside the values: `putVectors(ns, rows)`, `query(ns, vector, k, opts)`
  (cosine or dot, `filterPrefix`, `values`), `indexInfo(ns)`, `UsageResult.vectorRows` and `vectorBytes`,
  `StorageError` code `corrupt`, and the `createStore` options `maxIndexBytes` and `vectorKernel`.
  `query()` no longer throws `not_implemented`: the 13 `test/query.behaviour.ts` cases that were skipped
  since Sprint 2 now run, unchanged except for a `put()` helper that calls `putVectors`. (D4-03)
- `crates/ldvec`, a zero-dependency Rust crate compiled to two WebAssembly modules (SIMD and scalar,
  each under 100 KB, path-remapped, embedded in `dist/index.js`): CRC-32C, validation of the on-disk
  HEAD and META records with checked `u64` arithmetic, inverse norms, and a scan whose scores are
  bit-identical between the two modules and to a `Math.fround` reference. `ldv_simd()` says which one
  is running; the scalar build has no `0xFD` opcode and neither build has a relaxed-simd instruction
  (decoded from the module bytes, not grepped). `npm run build:wasm`, `cargo test --locked` (a
  200,000-iteration SplitMix64 mutation harness included), `clippy -D warnings`, `fmt --check`. (D4-02)
- The on-disk format v1 with a versioned HEAD, CRC-32C on every part, tombstones and segments, written
  crash-safely (parts first, HEAD last, new segments never overwrite a committed record) and read with
  bounds (`maxIndexBytes` is checked before any allocation, memory grows only after a part has its
  expected length). Documented in `docs/vector-index-format.md`; a golden fixture is written by the
  TypeScript writer and parsed by the Rust crate. (D4-02, D4-03)
- Cross-tab safety: the writer holds the Web Lock `airplanemode-localdata:vec:<ns>` from before the HEAD
  re-read to after the HEAD put and drops the OPFS driver's cached `keys.json` first (the internal
  `refreshIndex` hook; the `StorageDriver` contract is unchanged). Two pages writing the same namespace
  and different namespaces at once, then a third page reopening, give every row, 0 `corrupt` and hits
  bit-identical to the reference. (D4-03)
- Events: `storage.query`, `storage.index.open` and `storage.index.write` (Event 0.1.3), never carrying a
  key, `filterPrefix`, vector, score or value. (D4-03)
- `bench/synth.ts` (deterministic synthetic vectors and chunks; no real documents, no model),
  `npm run bench:vectors` (10k and 100k indexes at 256-byte and 2,048-byte chunks on OPFS, 10k and
  100k on IndexedDB, 5 cold runs plus a browser relaunch each, precise JS heap, write time, query
  p50 and p95) writing `docs/benchmarks/vector-index.csv` with a generated commit, machine and Chrome
  version, and `scripts/bench-readme.mjs`, which writes the README Benchmarks block from the CSV and
  nothing else (`test/readme-bench.test.ts` fails on any difference). (D4-04)
- Demo: a Vector index section that builds 10,000 or 100,000 synthetic rows in the page, reloads, runs a
  cold query and shows the measured time, kernel, memory and a match against the naive reference, with
  a storage warning before the build and a Delete index button. The CSP gains only
  `'wasm-unsafe-eval'` (pinned by `test/demo-csp.test.ts`). (D4-05)
- `docs/release.md` with the definition-of-done rows, `docs/vector-index-format.md`, and
  `scripts/pack-check.mjs` checks that the embedded modules equal a fresh remapped build, that no
  builder path is in the tarball, and a fresh-directory install that writes three vectors and queries
  them. (D4-05)

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

- `query()` is implemented: Storage API 0.2.0 (vendored from spec release 0.4.0, committed; public after
  the owner's push) replaces 0.1.0, and Event 0.1.3 replaces 0.1.2. A `Float32Array` passed to `set()` is
  still an ordinary value and is not indexed. The two tests that pinned 0.1.0 (`test/events.test.ts` and
  `test/storage.behaviour.ts`: "query rejects with not_implemented") now assert the 0.2.0 behaviour.
  (D4-01, D4-03)
- `scripts/sync-contracts.mjs` looks for `SPEC-LANDED.txt` in the `SPEC_LANDED` environment variable,
  then in the highest-numbered `../evidence/sprint-<n>/D1/SPEC-LANDED.txt` (numbers compared as numbers),
  and exits 1 when neither exists; `--spec-dir` and `--evidence-root` exist for the tests. (D4-01)
- `validateNamespace` rejects the reserved prefix `__ld_` for callers. (D4-01)
- `usage()` includes the vector index: `bytes` includes `vectorBytes`, `items` still counts key-value rows
  only, and `vectorRows` and `vectorBytes` appear when an index is in scope. The soft quota counts key-value
  and vector bytes together. `usage()`, `delete()` and the key-value calls create no kernel and emit no
  `storage.index.*` event on a namespace without an index. (D4-03)
- `delete(ns, key)` removes the vector row as well as the value and resolves true if either existed; a
  corrupt index rejects it with `corrupt` before any value is touched. `clear(ns)` removes both. (D4-03)
- `package.json`: version `0.2.0-alpha.0`; `npm run ci` now starts with `npm run build:wasm`; the CI three-OS
  job installs the Rust 1.98 toolchain and caches it (both actions already in the conventions table, no new
  action), runs `cargo fmt`, `clippy -D warnings` and `cargo test --locked`; the Pages build job builds the
  WebAssembly before the demo, with `contents: read`. `test/workflows.test.ts` pins the pins and the rules.
  (D4-05)
- README restructured to the nine mandated sections in order (Develop and Security and privacy moved
  under Quick start and How it works); Benchmarks is generated from the CSV; Limitations rewritten. (D4-04)
- `docs/vector-index.md` is now the implemented design (flat index), no longer a proposal; the proposed
  contract changes became Storage API 0.2.0. (D4-05)
- The browser harness page's CSP gains `'wasm-unsafe-eval'`, as the demo's does, and nothing else. (D4-03)

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

- `Version` and the kernel's argument-error code could not collide: format errors are -1 to -14 and an
  invalid pointer is -100 (found while writing the `a future format version` corruption case).
  (D4-02)

- `npm run pack:check` and `npm run test:browser` (through `install.spec.ts`) no longer need a sprint
  scratch directory, a pre-built `dist/` (the CI browser job does not build) or POSIX path handling:
  they build first, use `os.tmpdir()` and `path.relative`, and were proven with `TMPDIR` pointing at a
  fresh directory and from a copy of the repository with no `dist/` and no sibling repositories.
  (T3-S3-001)
- Browser benchmark cases write their figures only when `LOCALDATA_BENCH_OUT` names a directory;
  the machine-specific scratch path is gone from `test/browser/drivers.spec.ts`.
- Vendored `src/contracts/storage-api.ts` re-synced from `runtime/spec` (`npm run sync-contracts`).

### Security

- Vector operations never put a key, `filterPrefix`, vector component, score or value in an error message,
  `details` or event: a bad row is identified by `details.row`. A sentinel test checks every failure path
  (`test/vector-errors.test.ts`). (D4-03)
- The reader treats every byte from storage as untrusted: the HEAD record is size-checked before it is
  copied, counts are range-checked before they size anything, arithmetic is checked `u64`, the whole index is
  checked against `maxIndexBytes` before any block is allocated, WebAssembly memory only grows after a part
  has the length the HEAD implies, and a 200,000-iteration SplitMix64 mutation harness plus a differential
  validator check the kernel's parsers (T2 runs 1,000,000 native and 10,000 WebAssembly cases). A trap
  discards the instance. (D4-02, D4-03)
- Builder paths: both embedded modules are built with `--remap-path-prefix` for the repository, the cargo
  home and the rustup home, release profile `debug = false`, `strip = true`; `test/builder-paths.test.ts` and
  `pack:check` fail on a macOS or Linux home-directory prefix, a Windows drive path, the cargo registry or
  the rustup directory in the tarball, the generated module or the decoded WebAssembly (S1-088). (D4-02,
  D4-05)
- CRC-32C is documented as detecting accidental corruption only, and data in OPFS and IndexedDB as
  unencrypted and readable by same-origin scripts (README Limitations). (D4-04)
- The demo's CSP is `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'
  data:; connect-src 'none'; base-uri 'none'; form-action 'none'`, pinned by a test: no `unsafe-eval`, no
  `unsafe-inline`, no `blob:`, no new origin. (D4-05)

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
