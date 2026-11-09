# Vector index design note

Status: design only. Nothing here is implemented. In Storage API 0.1.0 `query()` throws
`StorageError` `not_implemented` naming Sprint 4. The test suite for the flat index is already
written and skipped: `test/query.behaviour.ts` (note: "Sprint 4: flat index"). Every number below is
either shown arithmetic or marked **target** or **not measured**.

## 1. Goals and non-goals

- Goal: `query(ns, vector, k, { filterPrefix? })` over the vectors a namespace holds, persisted in
  OPFS (IndexedDB fallback), reloaded cold after a browser restart.
- Target (Sprint 4 done-when): a 100,000-chunk index reloads cold and answers its first query in
  **under 2 seconds on an 8 GB laptop**. **Target, not measured.** No measurement exists yet on the
  8 GB Windows no-GPU laptop.
- Non-goals now: quantisation, multi-vector documents, cross-tab writers, encryption at rest.

## 2. Phase 1: flat index (Sprint 4)

Exact search: score every candidate, keep the top k. Exact results make it the correctness oracle
for the later approximate index.

- Metrics: cosine (default) and dot. Vectors are stored as written. For cosine, a unit-norm copy is
  not stored; the query is normalised once and each row's inverse norm is kept in a side array so
  scoring is one dot product per row.
- Scoring uses `Float32Array`. Accumulate in f32 in a fixed order (index 0 upward) so results are
  reproducible on one engine; cross-engine bit equality is not promised.
- Top-k: a bounded min-heap of size k. Ties break by key in UTF-8 byte order (ascending), so output
  is deterministic. `k = 0` returns `[]`; `k` above the count returns every candidate; non-integer,
  negative or non-finite `k` throws `invalid_value`.
- Zero vector under cosine: score 0, never NaN.
- Dimension is fixed per namespace by the first vector written; a different length throws
  `invalid_value`.
- `filterPrefix` is applied while scanning (rows whose key lacks the prefix are skipped).
- Cost: O(n x d) per query. At n = 100,000 and d = 384 that is 38,400,000 multiply-adds, which is
  the expected order of tens of milliseconds in plain JS or WASM SIMD. **Not measured.**

## 3. Phase 2: HNSW in Rust compiled to WASM (Sprint 6)

Approximate search for namespaces where the flat scan is too slow.

- Implementation: a Rust crate compiled to `wasm32-unknown-unknown`, built with the lab's pinned
  `wasm-bindgen` and `wasm-opt`. No threads (Pages cannot send COOP/COEP). The crate follows the
  lab's Rust determinism rules: no `HashMap`/`HashSet`, no clock, environment or filesystem reads.
- Seeded level draw: each node's level is drawn from a seeded PRNG (a fixed algorithm such as
  SplitMix64 stored in `header.json` together with the seed), with `level = floor(-ln(u) * mL)`
  and `mL = 1 / ln(M)`. Same seed plus same insertion order gives the same graph, which makes the
  index testable and the file reproducible. The logarithm is computed in integer or fixed-point
  arithmetic, or from a pinned table, rather than platform libm.
- Parameters (starting points, to be tuned): M = 16, efConstruction = 200, efSearch = 64.
- Recall is judged against the flat index on the same data. The recall figure is **not measured**.
- Graph memory, shown: level 0 keeps up to 2M = 32 neighbours of 4 bytes each, so 32 x 4 = 128 B
  per node, 100,000 x 128 B = 12.8 MB. Upper levels hold about 1/(M-1) = 1/15 of the nodes, adding
  roughly 6 percent, so about 13.6 MB in total.

## 4. On-disk layout

### OPFS

Under the existing root `airplanemode-localdata/v1/`:

```
<ns>/vectors/v1/
  header.json      format version, dim, metric default, count, live count, seed (HNSW), checksum
  vectors.f32      count x dim little-endian float32, row-major
  keys.bin         u32 LE offsets (count + 1) followed by UTF-8 key bytes
  tombstones.bin   bitset, 1 bit per row, 1 = deleted
```

- Rows are append-only. `set` of a new key appends a row; `set` of an existing key tombstones the
  old row and appends a new one (the cheap overwrite). `delete` flips a tombstone bit.
- Compaction rewrites the files without tombstoned rows when the dead fraction passes a threshold
  (starting point 25 percent). It writes `v2` beside `v1` and swaps by updating `header.json` last,
  so a crash leaves a readable `v1`.
- `header.json` is written last on every commit and carries the row count it vouches for; a reader
  ignores any bytes past that count. That makes append recovery crash-safe without a journal.
- Reads use `FileSystemSyncAccessHandle` inside a worker where available (fast, no copies), and
  `getFile().arrayBuffer()` otherwise. A sync access handle takes an exclusive lock per file, so the
  index is single-writer; cross-tab coordination stays out of scope until it is designed.
- The HNSW graph (Sprint 6) adds `graph.bin` beside these files; the flat layout is unchanged.

### IndexedDB fallback

Database `airplanemode-localdata`, a new object store `vec` (a version 2 upgrade of the database),
keyPath `[ns, part]`. Parts: `header` (the JSON object), `keys` (one ArrayBuffer), `tombstones`
(one ArrayBuffer) and `vectors:<n>` chunks of 4 MiB each (`4,194,304 / (384 x 4) = 2,730` rows per
chunk at d = 384). Chunking avoids one 154 MB structured clone per commit.

## 5. Quota accounting

The vector files count against the namespace like any value. `usage(ns)` adds
`vectors.f32 + keys.bin + tombstones.bin + header.json` (plus `graph.bin` later) to `bytes`, and the
accounting record under `__ld_meta` gains a `vectorBytes` field. A `set` whose new row would exceed
`quotaBytes` throws `quota_exceeded` before writing, as for any value. Compaction needs room for
the new copy, so it reserves the live-row size first and aborts with `quota_exceeded` rather than
leaving a half-written `v2`.

## 6. Cold-load target and its arithmetic

Reference corpus: 100,000 chunks, d = 384 (a common small sentence-embedding width).

| Item                 | Arithmetic                       | Size                                    |
| -------------------- | -------------------------------- | --------------------------------------- |
| `vectors.f32`        | 100,000 x 384 x 4 B              | 153,600,000 B (about 154 MB; 146.5 MiB) |
| `keys.bin` offsets   | (100,000 + 1) x 4 B              | 400,004 B                               |
| `keys.bin` key bytes | 100,000 x 32 B (assumed average) | 3,200,000 B                             |
| `tombstones.bin`     | ceil(100,000 / 8) B              | 12,500 B                                |
| Flat total           |                                  | about 157.2 MB                          |

Time budget at 2,000 ms, **target**: reading 154 MB in 2 s needs 154 MB / 2 s = 77 MB/s sustained,
leaving the whole budget for I/O. A real budget should hold the read to about 1,000 ms (about
154 MB/s) and spend the rest on header parse, key table build and the first query. Typical NVMe
laptop storage exceeds these rates by a wide margin, but browser OPFS overhead, antivirus on
Windows and the 8 GB memory ceiling are the unknowns, so all of this is **not measured**.

Memory: the flat index holds `vectors.f32` as one `Float32Array` (154 MB) plus keys; on an 8 GB
laptop with a browser tab budget that is acceptable, but it is why quantisation (f16 or int8 would
halve or quarter it) is a recorded follow-up, not a Sprint 4 item.

Measurement command (to be added in Sprint 4; does not exist yet):

```sh
LOCALDATA_BENCH_OUT=<dir> npm run test:browser -- --grep "vector cold load"
```

It will build a synthetic 100,000 x 384 index with a seeded generator, close the store, reopen it in
a fresh browser context (cold: new page, no JS heap reuse; the OS file cache cannot be dropped from
a page, so the report states warm-OS-cache versus the first run after boot separately), and record
open time, first-query time and `performance.memory`-class heap figures, with Chrome version and
machine in the log line. The README Benchmarks table will cite that log. The 8 GB Windows no-GPU
column stays `not measured` until the owner runs it.

## 7. Proposed contract changes

Storage API 0.1.0 is frozen; these are proposals for the architect, which would be a 0.2.0 change
published from `runtime/spec` and re-vendored. Until then `test/query.behaviour.ts` uses a local
helper type and never edits `src/contracts`.

1. `QueryOptions.metric?: 'cosine' | 'dot'`, default `'cosine'`.
2. Specify that `query()` throws `invalid_value` for an invalid `k` and for a dimension mismatch
   (0.1.0 only freezes the `not_implemented` behaviour).
3. Specify tie-breaking (key byte order) and that `score` is the metric value, higher is better.
4. Optionally `set()` accepting `Float32Array` as a first-class vector value; today a
   `Float32Array` is stored as an ordinary typed array, so the index must decide which keys are
   vectors (proposal: a namespace becomes a vector namespace when its first value is a
   `Float32Array`, and then rejects other value types).
5. A `createIndex(ns, { dim, metric })` call may be cleaner than inferring dimension from the first
   write; open question.

## 8. What is measured, and when

| Item                                   | Status               | When                                        |
| -------------------------------------- | -------------------- | ------------------------------------------- |
| Flat query behaviour (13 cases)        | written, skipped     | live in Sprint 4                            |
| Flat scan time at 100k x 384           | not measured         | Sprint 4                                    |
| Cold load of 100k x 384 (target < 2 s) | target, not measured | Sprint 4, on the 8 GB Windows no-GPU laptop |
| HNSW recall against flat               | not measured         | Sprint 6                                    |
| HNSW build time and graph size         | not measured         | Sprint 6                                    |
