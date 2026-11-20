# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0-alpha.1] - 2026-11-20 (untagged)

Sprint 7 (D4), release readiness. Ids: `D4-0x` are Sprint 7 items; `S1-1xx` are security-consultant findings;
`BUG-T2-S6-xx` are Sprint 6 tester bugs; `TD-xxx` are team decisions under owner delegation (TD-109 the HNSW duplicate
fix and the format `LDHNSW02`, TD-110 idle eviction at the cap, TD-111 the stored-params check, TD-112 Dependabot,
TD-115 the quick-start convention, TD-116 the live demo line, TD-117 issue forms, TD-118 rehearsal artefacts, TD-124 the
quiet slot for the ANN benchmark, TD-125 the lock-3 pattern of the publish workflows, TD-126 the near-duplicate rule,
TD-127 no recount of the duplicate statistic at load). Storage API 0.4.1 and Event 0.1.6 are vendored from spec release 0.6.1 in
runtime/spec; the release tool is vendored from the same release. No runtime dependency was added: `crates/ldvec/Cargo.toml`
still has an empty `[dependencies]` and `NOTICE` is unchanged. Nothing is tagged or published.

### Added

- Exact-duplicate handling in the HNSW kernel (D4-01, TD-109; BUG-T2-S6-14, S1-124): neighbour selection prunes a
  candidate whose vector bytes equal an already kept neighbour's, refills free slots from the pruned candidates
  (keepPrunedConnections), prefers the newest node on a score tie and widens a search whose result list repeats a
  score. The floors stated before measuring (at ef 64, at least 99 of 100 queries with the flat scan's ten scores and
  a mean recall@10 by score of at least 0.99) are asserted by `crates/ldvec/tests/hnsw_dup.rs` and
  `test/ann-duplicates.test.ts` on the uniform probe, clustered boilerplate sets at 10, 50 and 500 copies (dims 32 and 384),
  1,000 vectors x 10 copies, one vector x 1,000, every row identical and one-ulp near-duplicates.
- A degenerate-graph rule (TD-109, plan B kept as the second line of defence): a graph whose largest group of identical
  live rows is larger than `2 * m` (32 at the default `m` 16, the capacity of a layer-0 list) is answered by the exact flat scan, with `fallback: 'duplicates'`.
  The count (`dupMax`) is in the graph header, counted at build and recounted after every put.
- The near-duplicate rule (fix round 1, TD-126; BUG-T2-S7-02): synthetic groups of 500 and 1,000 rows one to three
  ulps apart at dim 384 were answered with 91 to 98 of 100 queries equal to flat and no fallback, because the exact count
  never saw them. The kernel now also counts the largest group of live rows that share one quantised key (every
  component's bits with the low 12 mantissa bits cleared, compared by those bytes, never by a hash alone) in the same pass
  structure, stores it in a new header word (`nearMax`, offset 56; the header is 60 bytes, the format `LDHNSW02` had
  not shipped), recounts it after every put, and treats a group above `2 * m` of either kind as degenerate. No new event
  attribute and no new wire string: the existing `duplicates` fallback carries it. Tests first:
  `crates/ldvec/tests/hnsw_near.rs`, the `t2_*` tests of `hnsw_dup.rs`, and the tight-cluster tests of
  `test/ann-duplicates.test.ts`. The figures are in `docs/benchmarks/ann-near-duplicates.csv` (recall only, native, written by
  the ignored test `near_duplicate_figures`): every `t2_*` set is degenerate, so the flat scan answers. It is a proxy measured on synthetic sets: wider tight clusters (a relative
  spread of 1e-4 or more per component) are not detected and the graph alone can return scores below the flat scan's there, see the
  README's Limitations. The determinism fixture was re-pinned for the 4 header bytes; the graph structure is unchanged.
- `storage.index.build` carries `duplicateRows` (Event 0.1.6), the live rows whose vector bytes equal an earlier live
  row's, counted in the kernel (`ldv_hnsw_dup_stats`, eight transient bytes per live row).
- The graph format `LDHNSW02`; a graph file of `LDHNSW01` is refused with reason `version` and rebuilt from the stored
  vectors at most once per HEAD generation, guarded by a persisted `rebuilt` marker; the rebuild goes through the same
  quota, `maxIndexBytes` and WebAssembly memory refusals as a fresh build. (D4-01)
- `docs/benchmarks/ann-duplicates.csv` and its README block: HNSW at 100,000 x 384 with every vector stored 30 times (the graph
  answers) and 60 times (degenerate: the flat scan answers), recall counted by score. `host_load_1m_start` and `host_load_1m_end` are the last columns of `ann.csv` and
  `ann-duplicates.csv` (empty on Windows); a row measured under a load above 4 says so in its latency cells. (D4-03,
  TD-124)
- The release path (B1, B2, B4; TD-103 to TD-106, TD-118, TD-123): `scripts/release/rehearse.mjs` and the CI job
  `release-rehearsal (<os>)` (clean install of the packed tarball into a fresh directory on Linux, macOS and Windows,
  asserted calls on the memory backend including an HNSW query, then a `localdata-rehearsal` manifest signed with the
  published RFC 8032 TEST 1 key, verified with the explicit flags, and the refusal proofs by exact exit code and first
  stderr line, with a self-test that turns red against a missing, lying or signalled tool); the vendored release tool
  and the 36 shared release vectors through it (`test/release-vectors.test.ts`); `.github/workflows/publish.yml`
  (owner-only, `workflow_dispatch` only, six locks, three bindings, provenance; never run) and its policy test;
  `docs/RELEASING.md` (the owner's steps only), `docs/release-keys.json` (`keys: []`) and the rows of `docs/release.md`.
  (D4-04, D4-05)
- README: `Live demo:` line in the first lines and a "Try it in two minutes" section whose blocks are executed by
  `test/quickstart.test.ts` from the built tarball in a fresh directory (no model download, no test key). Issue forms with
  a required no-real-documents checkbox, a `SECURITY.md` contact link, and a CONTRIBUTING update. (D4-06, TD-115 to
  TD-117)
- Demo: data choices for the HNSW panel (20,000 distinct rows, every vector stored 20 times, one vector stored 300
  times), the duplicate-row count, an "old-format file" action, and a refreshed not-yet box. (D4-07)

### Changed

- `buildIndex` at the 64-graph cap releases the in-memory instance of the least recently used idle graph instead of
  throwing; `max_graphs` only when every resident graph is busy. `dropIndex` frees a slot only if the graph was
  resident. README, `docs/vector-index.md` and `test/ann-docs.test.ts` say the same (D4-02, TD-110; BUG-T2-S6-15,
  S1-125).
- The ann benchmark was run again on the new format, in quiet slot Q2 (the 1,000,000-row row finished inside its 20-minute box);
  the `README.md` blocks are regenerated from `docs/benchmarks/ann.csv` and `ann-duplicates.csv`. Every Sprint 6 row is kept,
  unchanged and not re-measured, in `docs/benchmarks/ann-s6-format-v1.csv` (format `LDHNSW01`) (D4-03, TD-124).
- Version 0.4.0-alpha.1. `sync-contracts` also reads the spec release's `LANDED.json`.
- README, "Try it in two minutes": the setup block needs the network once (the npm registry for `npm ci`, and rustup when the
  toolchain is missing); the install and run blocks run offline. It said "no network is used after the clone", which was not
  true of the setup block (BUG-T1-S7-02). The Status line and the demo page word the duplicate claim as the measured floor
  (BUG-T1-S7-04). `test/quickstart.test.ts` runs its static pre-check before any block is written or executed (BUG-T3-S7-06).
- `publish.yml` follows the TD-125 lock-3 pattern, regenerated from runtime's (fix round 1; BUG-T3-S7-02, S1-130 to S1-132, S1-135):
  no `vars.` in any job-level `if`, the arming variable and `RELEASE_KEY_ID` are variables of the `release` environment read
  only in step env, the arming step is the first step after checkout, `persist-credentials: false` on every checkout, a refusal
  of a manifest that carries `expiresAt`, a strict SemVer check before `GITHUB_ENV`, `npm publish "./$TARBALL"`, and the
  tag-to-commit binding in `scripts/release/publish-guard.mjs` (`test/publish-guard.test.ts`). `test/workflows-release.test.ts`
  pins each rule and each has a mutation proof. The vendored release tool and `src/contracts/event.ts` were re-vendored from
  the re-landed spec 0.6.1 (comment text and tool fixes only; the 31 release vectors are unchanged).
  `docs/RELEASING.md` has the owner's steps in the single-run order (dispatch, check the candidate, sign, arm just before
  approving, disarm after) and compares the candidate tarball's digest with an independent build of the same commit before
  signing, not only `gh run view` metadata.
- `.gitignore` no longer hides the five vendored release vectors' `release-manifest.json` (BUG-T2-S7-01): a clean checkout
  failed `test/release-vectors.test.ts` and `test/quickstart.test.ts` without them.

### Fixed

- Fix round 2, documentation and a test only; no kernel, rule or graph-format change (the measured recall-probe rule is
  Sprint 8). BUG-T2-S7-07: `docs/benchmarks/ann-near-duplicates.csv` gains eight all-component float-noise rows
  (`noise`: +-256 and +-1024 ulp, relative Gaussian 1e-5 and 1e-4, dims 32 and 384, 30 x 500, `ef` 64; written by the ignored
  test `near_duplicate_figures` with `LDVEC_WRITE_NEAR_CSV=1`). On the synthetic dim-384 set none was detected and the graph
  alone answered 99, 95, 96 and 92 of 100 queries equal to flat; at dim 32 the first three were detected. The README
  Limitations, `docs/vector-index.md`, `docs/hnsw-format.md` and the write-up draft now say that detection depends on the data
  and the dimension, quote those rows and scope the earlier "1e-5 and 1e-6 gave 100 of 100" to the one set it was measured
  on; the flat scan is the way to complete answers. BUG-T2-S7-09: the docs state that while a graph is resident every
  `putVectors` recounts all live rows (two hashing passes and a sort), a cost linear in the row count, with no figure
  quoted. BUG-T1-S7-12, BUG-T2-S7-08: no public prose names a tester role as the subject of a claim
  (`test/ann-docs.test.ts` pins it). The Q2 latency cells stay labelled "measured under load".
- BUG-T2-S6-14 / S1-124 (above), BUG-T2-S6-15 / S1-125 (above), and the README's internal tester label is gone.
- S1-123 / S1-128 (D4-02, TD-111): `Graph::load` takes the stored params record and compares the header with it, and with
  every limit, before anything sized by a header field is reserved. A forged header with `m` 64 over a namespace built
  with `m` 16 and a declared million nodes used to make the kernel reserve and zero-fill 516 MB; under a counting
  allocator (`crates/ldvec/tests/hnsw_header.rs`) the same file is now refused with no allocation at all (reason
  `params`).

### Security

- The stored-params comparison above, the allocation-probe tests, and two header words for the duplicate bounds that the
  loader checks (`dupMax` and `nearMax`: each at most the node count, `nearMax` at least `dupMax`). A forged RAISED bound
  can only force the exact flat path; a forged or lowered bound (kept consistent) can suppress the `duplicates` fallback,
  which costs recall only and never a score: the statistic is not recounted at load (TD-127, S1-134, BUG-T2-S7-03), and the
  forger needs write access to the origin's storage, which already allows replacing the vectors.
- Release rehearsal without a real key: the test key signs only a `-rehearsal` id, `--allow-test-key` exists only on the
  command line, `docs/release-keys.json` trusts nothing until the owner adds the key, and the publish workflow has no
  trigger but `workflow_dispatch`, no `pull_request_target`, no `inputs`, secrets only in the step env of the publish
  step, and `id-token` and `attestations` only in the publish job.

### Deferred

- Batched delete, compaction, quantisation, encryption at rest and HNSW for `queryChunks` (TD-96): none of them closes a tag
  blocker. Reserving the npm scope, the real key, the `release` environment, tagging and publishing are the owner's
  (`docs/RELEASING.md`). The 8 GB laptop figure is the owner's: every 8 GB cell still reads "not measured on 8 GB".

## [0.4.0-alpha.0] - 2026-11-19 (untagged)

Sprint 6 (D4). Ids: `D4-0x` are Sprint 6 items; `S1-1xx` are security-consultant findings; `TD-xx` are team
decisions under owner delegation (TD-65 HNSW build or adopt, TD-69 versions, TD-76 the benchmark CSV).
Storage API 0.4.0 and Event 0.1.5 are vendored from spec release 0.6.0 in runtime/spec. No dependency was
added: `crates/ldvec/Cargo.toml` still has an empty `[dependencies]` and `NOTICE` is unchanged. Nothing is
tagged or published.

### Added

- HNSW behind the Storage API (0.4.0): `buildIndex(ns, { kind: 'hnsw', metric?, m?, efConstruction?, seed? })`,
  `dropIndex(ns, 'hnsw')`, `query(..., { index: 'hnsw', ef })`, `VectorIndexInfo.ann` and
  `UsageResult.annBytes`. Flat stays the default and the fallback: a request for HNSW that cannot be answered
  by a current, valid graph is answered by the flat scan, with the same results, and the reason is in the
  event (`absent`, `stale`, `filter`, `metric`, `refused`, `trap`). The graph lives in the reserved driver
  namespace `__ld_ann.<ns>` (a `graph` and a `params` record), works on the OPFS, IndexedDB and memory
  drivers, and holds no vectors and no keys. (D4-03, D4-04, TD-65)
- The HNSW kernel in `ldvec` (`crates/ldvec/src/hnsw.rs`, format `LDHNSW01` in `docs/hnsw-format.md`):
  deterministic build (integer-only levels, `f32::total_cmp` ties, no hash map or thread), search with the
  flat scan's own scoring function, insert, delete marks, serialise and a validator that refuses every
  truncation, flipped byte, out-of-range or self link, level above 16, over-large declared count, other
  namespace (bound by its bytes, not a checksum), other dimension and a graph from the future, with no panic
  (10,000 seeded mutations) and `try_reserve` for every allocation sized from a file field. FFI in the
  existing raw style with integer handles. (D4-03)
- Tests, written before the code: recall@10 against the flat scan on the fixed 10,000 x 384 clustered set
  (floor 0.95, stated before measuring, in Rust and through the store), graph bytes identical for the same
  seed and order and equal to `test/fixtures/hnsw-determinism.json` on native and WebAssembly (SIMD and scalar),
  persist and cold reload, delete and re-insert, a forged graph linking to a deleted row, a graph ahead of
  HEAD, truncated, flipped, other-namespace and other-dimension graphs refused and rebuilt to the same bytes
  as a fresh build, a rebuild refused again dropping to flat with no loop, refused params, a kernel trap,
  quota (`buildIndex` over quota writes nothing), the reserved prefix, all in Vitest and in Chrome on OPFS
  and IndexedDB. (D4-03, D4-04)
- `npm run bench:ann` (`bench/ann-bench.spec.ts`): flat and HNSW at 100,000 x 384 (clustered and uniform) on
  OPFS, build time, query p50 and p95, recall@10, index and graph bytes, JS heap and WebAssembly memory,
  written to `docs/benchmarks/ann.csv` with machine, command and "not measured on 8 GB" on every row; `npm run
  bench:ann-readme` writes the README block from the CSV and nothing else (`test/readme-ann-bench.test.ts`).
  The integer-only clustered generator is implemented identically in `bench/synth.ts` and
  `crates/ldvec/tests/support/synth.rs`. (D4-05, TD-76)
- `npm run bench:delete-cost` (`bench/delete-cost.ts`, fix round 2): what one `delete()` costs with and without a
  current graph at 20,000 x 32 and 100,000 x 32, in installed Chrome on OPFS, written to
  `docs/benchmarks/delete-cost.csv` with machine, command and "not measured on 8 GB" on every row;
  `test/readme-delete-cost.test.ts` demands that the README and `docs/vector-index.md` quote exactly the CSV's
  figures. (BUG-T2-S6-13)
- The demo's "Flat or HNSW" section: an index-kind switch over seeded data with the measured recall, the graph
  bytes, and a button that truncates the demo's own graph record to show the refusal and the rebuild. (D4-06)
- Events (Event 0.1.5): `storage.index.build`; `requested`, `index`, `fallback` and `ef` on `storage.query`;
  `kind` and, for a refused graph, a `reason` on `storage.index.open`. None carries a key, a vector, a score
  or the seed. (D4-04)

### Changed

- Vendored `src/contracts/storage-api.ts` @ 0.4.0 and `event.ts` @ 0.1.5 (spec release 0.6.0);
  `STORAGE_EVENT_NAMES` has eleven names. The tests that pinned ten names and the contract versions were
  updated with them. (D4-02)
- The README follows the Sprint 6 section order (Status, Install, Quick start, How it works, Contracts, Demo,
  Benchmarks, Limitations, Security and privacy, Develop, Licence). (D4-07)
- `usage()` counts the graph (`annBytes`, included in `bytes`), and graph bytes count toward the pre-write quota
  checks, so a namespace with a graph can refuse a `putVectors` that a flat-only namespace accepts. Flat-only
  quota behaviour is unchanged. (D4-04)
- BUG-T2-S6-04 (documentation only): the README Limitations and `docs/vector-index.md` no longer advise "batch
  them" for deletes. With a current graph every `delete` rewrites the whole graph record and there is no batched
  delete (deferred to Sprint 7); the per-delete cost is quoted from `docs/benchmarks/delete-cost.csv` (see
  BUG-T2-S6-13 below). The bulk-delete workaround is `dropIndex`, delete, `buildIndex`. Both documents
  also state the identical-vector limit and the 64-graph cap.
- BUG-T2-S6-11 (documentation and a test, no API change): the README Limitations and `docs/vector-index.md` say
  that a graph keeps the nodes of replaced rows, so after most rows are replaced, or after building over
  duplicate-heavy data (boilerplate chunks), recall can fall below a fresh build's with no signal in a query;
  `indexInfo(ns).ann` (`nodes`, `liveNodes`) shows it and the caller should call `buildIndex` again when
  `liveNodes / nodes` is 0.5 or lower. Compaction stays not built. `test/ann-churn.test.ts` reproduces the
  condition on a small seeded set and shows `buildIndex` restoring recall@10 to 1.0; no figure for the degraded
  recall is quoted.
- BUG-T2-S6-13 (documentation and a bench): the per-delete cost in the README and `docs/vector-index.md` no longer
  comes from an internal log; it is computed from the committed `docs/benchmarks/delete-cost.csv`
  (22.80 ms per delete with a current graph against 2.60 ms flat-only at 100,000 x 32, Apple M5 Pro, OPFS, not
  measured on 8 GB). Neither document refers to an evidence folder for a figure.
- Re-vendored `src/contracts/storage-api.ts` @ 0.4.0 and `event.ts` @ 0.1.5 from the re-landed spec release 0.6.0
  (fix round 1): `HNSW_MAX_GRAPHS`, the `storage.query` fallback `short` and the `max_graphs` reason. Versions
  are unchanged.
- Cargo: `[profile.test] opt-level = 3`, so the HNSW tests (a 10,000 x 384 build, a 10,000-mutation fuzz) run
  in seconds. Release profile unchanged.

### Fixed

- S1-120: the event privacy test's needle `c0de` is made only of characters a random UUID can contain and
  failed about once in a few hundred runs; every needle now has a character outside `[0-9a-f-]`, with a test
  that shows the old needle collided and a 10,000-run seeded check of 0 false hits. (D4-01)
- BUG-T2-S6-02: with many identical vectors (repeated boilerplate chunks) a graph query returned fewer than `k`
  hits (34 for `k` = 50 with 60, 200 or 1,000 copies) and the event said the graph had answered. A graph answer
  with fewer live hits than min(`k`, live rows) is now discarded and the exact flat scan answers, with the
  `storage.query` event reporting `index: 'flat'` and `fallback: 'short'` (a `k` above 1,000, which the graph
  can never fill, is answered the same way). The kernel, the graph bytes and the determinism fixture are
  unchanged; the count over the 100,000 x 384 benchmark query sets (clustered and uniform, ef 32, 64, 128) is 0
  `short` fallbacks, so `docs/benchmarks/ann.csv` is unchanged. The kernel root cause is Sprint 7.
- BUG-T2-S6-03: the 65th `buildIndex` in one store (the kernel's handle table holds 64 graphs, `HNSW_MAX_GRAPHS`)
  threw `quota_exceeded` with `reason: 'wasm_memory'`; it now throws `reason: 'max_graphs'` and writes nothing.
  `dropIndex` of one namespace frees a slot, and rebuilding a namespace whose graph is already loaded replaces it
  at the cap. (A query that had to load a 65th persisted graph threw the same error in this round; fix round 2,
  BUG-T2-S6-08 below, replaced that with least-recently-used eviction.) No kernel or graph-format change: the SDK
  counts the live handles on the failure path only.
- BUG-T2-S6-08 (fix round 2): a query with `index: 'hnsw'` threw `quota_exceeded` with `reason: 'max_graphs'` when a
  store whose driver held more than 64 persisted graphs had to load another one. Only `buildIndex` is capped now
  (its behaviour is unchanged): a load into a full handle table releases the least-recently-used resident
  graph of an idle namespace and loads again, never one whose namespace has an operation running or queued.
  The released graph's stored record is neither deleted nor rewritten. When every resident graph is in use the
  query is answered by the exact flat scan with `fallback: 'absent'` and the stored graph is left alone; a put
  or delete in that situation no longer throws either. No spec change, no kernel or graph-format change.
- BUG-T2-S6-07: `armAnnTrapForTest` was a public method of `LocalData` and is gone from the class, the typings and
  the bundle. The test hook is `armAnnTrap(store)` in `src/vec/ann-test-hook.ts`, a module nothing shipped
  imports; `test/dist-surface.test.ts` and `npm run pack:check` fail if a hook reaches `dist/`.
- BUG-T3-S6-08: the `ldvec` crate manifest described a flat-only 300-line kernel; its description and comment now
  cover the flat scan plus the in-house HNSW graph (about 1,050 lines in `src/hnsw.rs`) and give TD-17 and TD-65
  as the reason for zero dependencies. `[dependencies]` is still empty; `Cargo.lock` and `NOTICE` are unchanged.

### Security

- BUG-T2-S6-12: `annStatsForTest` and `armVectorTrapForTest` (the latter made the flat kernel trap on demand for any
  holder of a store) are gone from `LocalData`, the typings and the bundle, with the internal `*ForTest` methods
  behind them; the hooks are `annStats`, `armVectorTrap` and `armAnnTrap` in `src/vec/ann-test-hook.ts`, which nothing
  shipped imports, and `test/dist-surface.test.ts` and `npm run pack:check` fail on any `*ForTest` name or hook
  function name in `dist/`.
- The graph file is untrusted input and is refused, never trusted, on any failed check; a crafted graph can only
  lower recall because hits are scored from the stored vectors and liveness comes from the flat HEAD.
- No dependency added; the kernel's `[dependencies]` section is empty.

## [0.3.0-alpha.0] - 2026-11-18 (untagged)

Sprint 5 (D4). Ids: `D4-0x` are Sprint 5 items; `S1-0xx` and `S1-1xx` are security-consultant findings;
`T1-S4-08` and `BUG-T2-S4-22` are Sprint 4 tester findings. Storage API 0.3.0 and Event 0.1.4 are vendored
from spec release 0.5.0 in runtime/spec. Nothing is tagged or published.

### Added

- The documents API (Storage API 0.3.0): `putDocument(ns, doc, chunks)`, `getDocument`, `listDocuments`,
  `deleteDocument`, `queryChunks(ns, vector, k, opts)` and `redactNamespacePrefix(prefix)`, with
  `UsageResult.documents`. A document is stored with its chunks (text, page range, a vector each, an optional
  gate verdict); `queryChunks` returns the nearest chunks with their text and source pages, ordered by score,
  docId (UTF-8 bytes), then ordinal, and matches a naive reference in the tests. `putDocument` is
  all-or-nothing, replace and delete are one commit each, and `clear(ns)` physically removes the document
  namespace (`__ld_doc.<ns>`, the vector index format unchanged: docs/vector-index-format.md section 8).
  Tests: `test/documents.behaviour.ts` (memory, OPFS, IndexedDB, each across a reopen),
  `test/documents.test.ts` (a failure injected at every put of a write, events, locks, concurrency),
  `test/documents-proto.test.ts`, `test/browser/documents.spec.ts` (relaunch, a page closed mid-write, the
  browser's own listing after `clear`). (D4-02)
- Events `storage.doc.put`, `storage.doc.delete` and `storage.doc.query` (Event 0.1.4), never carrying a
  docId, title, sha256, meta, chunk text, vector or score; a namespace under a registered prefix is emitted as
  `prefix*` (the SDK registers `dockit.d`). `storage.index.open` gains the attr `swept`. (D4-02, D4-03)
- `npm run bench:documents`: 100 documents x 200 chunks x 384 dims on OPFS and IndexedDB (put, warm and cold
  query, delete, clear, a browser restart), written to `docs/benchmarks/documents.csv` with generated commit,
  machine, command and Chrome version, a precise JS heap peak (named as that) and the wording "not measured on
  8 GB" on every row; `npm run bench:docs-readme` writes the README block from the CSV and nothing else
  (`test/readme-docs-bench.test.ts` fails on any difference). (D4-05)
- A `doc` CI job: `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --locked`. (BUG-T2-S4-22, D4-04)
- Test scaffolding: `test/fake-env.ts` (an in-memory OPFS and Web Locks for Node), `test/persist-env.ts`
  (suites that close and reopen over the same storage), `test/forge.ts` can write forged rows into a document
  index. (D4-01, D4-02, D4-03)
- Demo: a Documents section (put three synthetic documents, query, see chunk text and source pages, delete one,
  reload, clear the namespace and read the browser's own listing). (D4-06)

### Changed

- `sync-contracts` vendors `storage-api.ts` 0.3.0 and `event.ts` 0.1.4 and reads the spec-release 0.5.0
  `SPEC-LANDED.txt` (paths `spec/<path>`) as well as the older bare listing. (D4-02)
- The OPFS driver gained the optional hook `getBytesBounded(ns, key, limit)` (the `StorageDriver` contract is
  unchanged). `LocalData.vectorWasmBytes()` includes the documents kernel. (D4-03, D4-05)
- CI: every `npm ci` is `npm ci --ignore-scripts` (the lone-copy proof is in `evidence/sprint-5/D4/green/`).
  README sections follow the Sprint 5 order. (D4-04, D4-05)
- `package.json` version `0.3.0-alpha.0`. (D4-05)

### Fixed

- S1-100: a KV key named `__proto__` was dropped from the persisted accounting record, so after a reopen
  `list` and `usage().items` missed it. The record is now built with own-property definition and the key
  round trips with its TTL, on OPFS, IndexedDB and memory. (D4-01)
- S1-101: the value codec dropped an own `__proto__` member on encode and let stored bytes set the prototype
  of the decoded object on decode. Both directions now define an own member; the decoded object always has
  `Object.prototype`. (D4-01)
- S1-092: the OPFS driver checks `File.size` against the length a HEAD or part must have before it calls
  `arrayBuffer()`, so a planted oversize or truncated file is refused as `corrupt` without being read; an
  unparseable or malformed `keys.json` in a `__ld_vec.` or `__ld_doc.` namespace is `corrupt` with reason
  `keys_json` instead of an empty index, and `clear(ns)` still recovers such a namespace. (D4-03)
- T1-S4-08, code part: opening an index sweeps the part records no HEAD references (an interrupted write, the
  old segments after a dim change) and reports the count as `swept`; the sweep takes the writer lock only if it
  is free and never waits. The Limitations wording is updated. (D4-03)
- BUG-T2-S4-22: `cargo doc -D warnings` failed for `ldvec` (unescaped `f32[rows]` and an ambiguous `format`
  link in doc comments). (D4-04)

### Security

- S1-100, S1-101, S1-092 above; the documents API re-validates every decoded record and never returns a prototype
  taken from stored bytes. `deleteDocument` hides chunks and does not erase bytes: README Limitations says so,
  and `clear(ns)` on a per-document namespace is the physical delete. No encryption at rest (README Limitations).

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
  validator check the kernel's parsers (a 1,000,000-case native run and a 10,000-case WebAssembly run were made). A trap
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
