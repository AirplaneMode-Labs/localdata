# Benchmarks: raw results

Every benchmark run for this repository is committed here as raw data (CSV or JSON), one row per run, with the date, the
commit and the machine on the row (and the command, except in `vector-index.csv`, whose columns are pinned by tests, and
in `ann-notes.json`, a note the same run as `ann.csv` writes). The README tables are generated from these files
(`scripts/bench-*-readme.mjs`), the prose figures in the README, the CHANGELOG, `docs/*.md` and the demo are checked
against them (`npm run bench:check`, `test/benchmarks-index.test.ts`), and the Pages demo links here. A figure quoted
anywhere without a committed raw file is not done: it is either listed under "Figures with no raw data" below, with
"raw data not kept" beside it wherever it is quoted, or it is a bug.

Nothing in this folder was measured on an 8 GB laptop. Every figure is from one development machine, an Apple M5 Pro
with 48 GB (model and memory only), and every laptop cell in the README reads "not measured on 8 GB". The 8 GB
measurement is the owner's step (`docs/RELEASING.md`): the same commands, on that machine, appended as new rows.

How to read a row:

- `commit` is `git describe --always --dirty` when the run started. A `-dirty` suffix means the working tree had
  uncommitted changes on top of that commit, which is how every run in this folder was made (the files were committed
  afterwards), so the commit names the base of the tree, not the whole tree.
- `machine` is generated from `os.cpus()` and `os.totalmem()` (the native runs take it from the environment), and the
  Chrome version comes from the browser itself. Nothing in a file is typed by hand.
- The OS file cache cannot be dropped from a page, so a "cold" run is cold for the page, the JS heap and the
  WebAssembly instance, not for the disk.
- Latency rows of `ann.csv` and `ann-duplicates.csv` carry the host's 1-minute load average at the start and the end of
  the run; the README labels a latency cell "(measured under load)" when either exceeds 4. The Sprint 7 run of
  `ann.csv` was not quiet, so its latency cells are labelled; its recall, graph size and memory cells do not depend on
  that.
- A file is a **current** measurement when it was made at the Sprint 7 build (graph format `LDHNSW02`) or later, and a
  **historical baseline** when it was made at an earlier build and has not been re-measured since: it is kept because
  a README or document figure rests on it, and it says what build it measured.

## Files

| File                                                                 | Status              | Date (UTC)          | Commit              | Machine             |
| -------------------------------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| [`ann-duplicates.csv`](ann-duplicates.csv)                           | current             | 2026-11-19          | `8abd87b-dirty`     | Apple M5 Pro, 48 GB |
| [`ann-near-duplicates.csv`](ann-near-duplicates.csv)                 | current             | 2026-11-19          | `8abd87b-dirty`     | Apple M5 Pro, 48 GB |
| [`ann-notes.json`](ann-notes.json)                                   | current             | same run as ann.csv | same run as ann.csv | same run as ann.csv |
| [`ann-s6-format-v1.csv`](ann-s6-format-v1.csv)                       | historical baseline | 2026-11-19          | `da39477-dirty`     | Apple M5 Pro, 48 GB |
| [`ann-scale-duplicates-native.csv`](ann-scale-duplicates-native.csv) | current             | 2026-11-20          | `496dd02-dirty`     | Apple M5 Pro, 48 GB |
| [`ann.csv`](ann.csv)                                                 | current             | 2026-11-19          | `8abd87b-dirty`     | Apple M5 Pro, 48 GB |
| [`delete-cost.csv`](delete-cost.csv)                                 | historical baseline | 2026-11-19          | `da39477-dirty`     | Apple M5 Pro, 48 GB |
| [`documents.csv`](documents.csv)                                     | historical baseline | 2026-11-18          | `39d59a0-dirty`     | Apple M5 Pro, 48 GB |
| [`vector-index.csv`](vector-index.csv)                               | historical baseline | 2026-11-14          | `0390d65-dirty`     | Apple M5 Pro, 48 GB |
| [`wasm-size.csv`](wasm-size.csv)                                     | current             | 2026-11-20          | `496dd02-dirty`     | Apple M5 Pro, 48 GB |

### `vector-index.csv`

- What: cold open plus first query, write time, query p50 and p95, JS heap, WebAssembly memory, index bytes and storage
  usage of the flat vector index at 10,000 and 100,000 x 384, with 256-byte and 2,048-byte chunks, on OPFS and
  IndexedDB; five cold runs per configuration and one after a browser restart.
- Method: installed Chrome through Playwright with `--enable-precise-memory-info`; deterministic synthetic vectors and
  chunks (`bench/synth.ts`, no real document, no model); a cold run is `createStore` plus the first `query` with k = 10
  in a fresh page, then 50 more queries for p50 and p95; the first top 10 is compared with a naive reference outside the
  timing (`match`). The file has no `command` column (its columns are pinned by tests); the command is below.
- Reproduce: `npm run bench:vectors`, then `npm run bench:readme` to regenerate the README block.
- Quoted in: README Benchmarks (generated block) and Limitations, `docs/vector-index.md` sections 4 and 5, and the demo's
  storage warning (computed at build time by `demo/build.mjs`).

### `documents.csv`

- What: `putDocument`, warm and cold `queryChunks`, `deleteDocument` and `clear(ns)` over 100 documents x 200 chunks x 384
  dimensions on OPFS and IndexedDB: three runs per operation and one run after a browser restart.
- Method: as `vector-index.csv`; every query and every post-delete query is compared with a naive reference outside the
  timing, and every `clear(ns)` row records the files or records the browser still lists afterwards.
- Reproduce: `npm run bench:documents`, then `npm run bench:docs-readme` to regenerate the README block.
- Quoted in: README Benchmarks, Documents (generated block).

### `delete-cost.csv`

- What: the cost of one `delete()` with and without a current HNSW graph, at 20,000 and 100,000 rows of 32 dimensions.
  Measured at the Sprint 6 build and not re-measured at the Sprint 7 build, so a baseline.
- Method: installed Chrome on OPFS; per size and kind three runs, each building a fresh namespace in a fresh page and then
  timing 200 single awaited `delete()` calls; a row is one run (p50 and p95 over its 200 deletes) and the documents quote
  the median over the runs of each run's p50.
- Reproduce: `npm run bench:delete-cost`.
- Quoted in: README Limitations, `docs/vector-index.md` section 6, CHANGELOG.

### `ann.csv`

- What: flat against HNSW (m 16, efConstruction 200, seed 1) on clustered data at 100,000 x 384 (three runs) and
  1,000,000 x 384 (one run) and on uniform data at 100,000 x 384 (one run, the worst case for any graph): build time,
  cold open, query p50 and p95, recall@10 against the flat scan of the same store at ef 32, 64 and 128, flat index
  and graph bytes, JS heap, WebAssembly memory, storage usage and the host load.
- Method: installed Chrome on OPFS with `--enable-precise-memory-info`; the integer-only generator of `bench/synth.ts`
  (the same bytes in Rust and TypeScript); 200 queries per run; each kind is queried in its own fresh page, so the flat
  rows never load the graph; the one million attempt runs only if the 100,000 graph built in under 120 seconds.
- Reproduce: `npm run bench:ann` (it also writes `ann-duplicates.csv` and `ann-notes.json`), then
  `npm run bench:ann-readme` to regenerate the README blocks.
- Quoted in: README "HNSW against flat" (generated block) and Limitations, the write-up draft, and the demo's HNSW
  storage warning (computed at build time by `demo/build.mjs`).

### `ann-duplicates.csv`

- What: HNSW over 100,000 x 384 clustered data in which every vector is stored 30 times in one set and 60 times in the
  other: which path answered (the graph or the exact flat scan with the fallback `duplicates`), queries equal to the flat
  scan, recall@10 counted by score, build time, query p50 and p95, graph bytes and the host load.
- Method: as `ann.csv`; copies of one vector tie, so recall is counted by score; one run per set and ef.
- Reproduce: `npm run bench:ann` (the same run as `ann.csv`), then `npm run bench:ann-readme`.
- Quoted in: README Status, Limitations and "HNSW over duplicate vectors" (generated block), the demo's status line, the
  write-up draft.

### `ann-notes.json`

- What: the note the same bench run writes about the 1,000,000-row attempt (whether it ran and, if not, why), which the
  README block quotes.
- Method: written by `bench/ann-bench.spec.ts` at the end of the `ann.csv` run; it carries no date, commit or machine of
  its own, which is why its table row says "same run as ann.csv".
- Reproduce: `npm run bench:ann` (the same run as `ann.csv`).
- Quoted in: README "HNSW against flat" (generated block).

### `ann-s6-format-v1.csv`

- What: the Sprint 6 rows of `ann.csv`, measured on the first graph format (`LDHNSW01`), kept unchanged so the two
  formats can be compared. They have no host-load columns (those came with Sprint 7), and the column
  `remeasured_in_sprint_7` says which rows were measured again.
- Method: as `ann.csv`, at the Sprint 6 working tree.
- Reproduce: cannot be reproduced at the current commit, because the first graph format is no longer built. The same
  rows were first committed, as `ann.csv`, in commit `c787e10`; `npm run bench:ann` there writes the same columns.
- Quoted in: README "HNSW against flat" (as the baseline for the format comparison) and the write-up draft.

### `ann-near-duplicates.csv`

- What: recall only, natively (no latency): a graph over synthetic tight-cluster sets (groups of 500 and 1,000 rows one
  to three ulps apart, Gaussian jitter and all-component float noise, dimensions 32 and 384), the graph alone against the
  flat scan, whether the near-duplicate rule made the build degenerate, and which path would answer.
- Method: `crates/ldvec/tests/hnsw_dup.rs`, the Rust kernel built in release mode; `LDVEC_COMMIT` and `LDVEC_MACHINE` name
  the commit and the machine; 100 queries per row, k = 10, m 16, efConstruction 200, seed 1.
- Reproduce: `LDVEC_WRITE_NEAR_CSV=1 LDVEC_COMMIT="$(git describe --always --dirty)" LDVEC_MACHINE="<model>, <RAM> GB" cargo test --release -p ldvec --test hnsw_dup near_duplicate_figures -- --ignored --nocapture`
  (several minutes).
- Quoted in: README Limitations, `docs/vector-index.md` section 6, `docs/hnsw-format.md`, CHANGELOG, the write-up draft and
  the demo's not-yet box.

### `ann-scale-duplicates-native.csv`

- What: recall only, natively: natively built 100,000 x 384 duplicate sets of the shape of `ann-duplicates.csv` (30 and 60 copies of every
  vector; the same generator, but not its byte-identical sets) built by the Rust kernel at ef 32, 64 and 128, the graph alone against the flat scan, whether the build is
  degenerate and how many nodes a walk from the entry reaches. It is the file behind "the 2m boundary was measured, not
  derived".
- Method: `crates/ldvec/tests/hnsw_dup.rs` in release mode, the same generator, m and efConstruction as the browser bench; 100
  queries per row, k = 10.
- Reproduce: `LDVEC_WRITE_SCALE_CSV=1 LDVEC_COMMIT="$(git describe --always --dirty)" LDVEC_MACHINE="<model>, <RAM> GB" cargo test --release -p ldvec --test hnsw_dup scale_duplicate_figures -- --ignored --nocapture`
  (a few minutes).
- Quoted in: README Limitations, the write-up draft.

### `wasm-size.csv`

- What: the size and sha256 of the two embedded WebAssembly modules (SIMD and scalar) against the 100 KiB budget that
  `test/ldvec-wasm.test.ts` asserts, which is the figure behind "under 100 KB".
- Method: `scripts/bench-wasm-size.mjs` decodes the modules in `src/wasm/ldvec.gen.ts` (written by the build) and records
  their bytes with the commit, the machine and `rustc --version`. The bytes are not compared by a check, because only macOS
  has been shown to rebuild them byte for byte.
- Reproduce: `npm run build:wasm`, then `npm run bench:wasm-size`.
- Quoted in: `docs/vector-index.md` section 2 and CHANGELOG.

## Figures with no raw data

These figures are quoted, and the raw data behind each was not kept. Each is marked "raw data not kept" beside it in every
document that quotes it, and `test/benchmarks-index.test.ts` fails if one loses its mark or a new one appears without an
entry here. None is a headline figure, and none has been re-created: an invented number would be worse than a missing one.

- `70 to 90 ms`, README "HNSW over duplicate vectors": the cost of the second counting pass at 100,000 x 384 natively,
  timed once by hand while fixing the near-duplicate bug; no committed script prints it (raw data not kept).
- `13 of 100` and `33 of 350`, `docs/vector-index.md` section 6 and the write-up draft: the duplicate reproduction against
  the Sprint 6 kernel, which is no longer in the tree, so the current kernel does not show it (raw data not kept).
- `89%`, the write-up draft: one `top` sample taken by hand during the Sprint 7 latency run (raw data not kept).
- `79.2 MB` and `163.8 MB`, README Benchmarks memory budget: a Sprint 4 browser probe of the JS heap during one cold query;
  its output is not in this repository and the probe script is not either (raw data not kept).

## Regenerating and checking

- `npm run bench:check` runs the `--check` mode of every README block generator (it fails if a README table was edited by
  hand or a CSV changed without the table), the wasm size check and `scripts/bench-figures.mjs`, which fails when a
  figure in the README, the CHANGELOG, `docs/*.md` or the demo page has no matching committed row.
- `npm run bench:readme`, `npm run bench:docs-readme` and `npm run bench:ann-readme` rewrite the README blocks from the
  files above.
- A new benchmark adds its file here, its row to the table above and its figures to the register in
  `scripts/bench-figures.mjs`; the test fails until all three are done.
