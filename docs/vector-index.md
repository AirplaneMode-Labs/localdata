# Vector index

Status: **flat index implemented** in `0.2.0-alpha.0` (Sprint 4). HNSW is not built (Sprint 6, after a
build-or-adopt note). The on-disk format is in [vector-index-format.md](vector-index-format.md); the
behaviour is the normative part of Storage API 0.2.0 (`runtime/spec/storage-api.md`, committed; public
after the owner's push). The measured figures are in the README Benchmarks block, generated from
`docs/benchmarks/vector-index.csv`; this page quotes none of them.

## 1. What is implemented

- `putVectors(ns, rows)`: all-or-nothing, streaming (an `Iterable` or `AsyncIterable` of
  `{ key, vector: Float32Array, value? }`), replace-on-key, `dim` fixed by the first successful call.
- `query(ns, vector, k, { metric?, filterPrefix?, values? })`: exact top-k by cosine (default) or dot,
  score descending then key ascending by UTF-8 bytes, `[]` for a namespace without an index.
- `indexInfo(ns)`, `usage(ns)` with `vectorRows` and `vectorBytes`, `delete(ns, key)` (a tombstone),
  `clear(ns)`.
- Scores are IEEE binary32, four accumulators, no fused multiply-add: the SIMD WebAssembly module, the
  scalar module and the `Math.fround` reference (`src/vec/reference.ts`) agree bit for bit, so a result is
  reproducible across machines and browsers.
- Crash safety and corruption handling: parts first, HEAD last; every part is checksummed (CRC-32C) and
  size-checked; a failed check rejects with `corrupt` and never returns a wrong answer.
- Cross-tab writers are serialised by a Web Lock per namespace, with the OPFS driver's cache refreshed under
  it.
- `maxIndexBytes` (default 1 GiB) bounds what is written and what is opened, checked before any allocation.

## 2. Design decisions and why

| Decision                                              | Reason                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact flat scan first                                 | Exact results are the correctness oracle for the later approximate index, and 100,000 x 384 is small enough to scan in single-digit milliseconds with SIMD (see the benchmark).                                                                            |
| Scan in Rust compiled to WebAssembly, no wasm-bindgen | Raw `extern "C"` exports keep the module under 100 KB and the boundary a handful of integers; determinism rules (no clock, no hash maps, checked `u64` arithmetic) are easy to hold in about 300 lines with zero dependencies (build-or-adopt rule TD-17). |
| SIMD and scalar from one source                       | `cfg(target_feature = "simd128")` picks the kernel; both keep lane `j` of four accumulators equal to element `4k + j`, so results are bit-identical and the scalar module is a true fallback.                                                              |
| Segments, parts and a HEAD written last               | No in-place update means a crash or a quota error can never leave a half-written index visible; the previous HEAD stays valid. 8 MiB parts bound one write and one read at a time.                                                                         |
| CRC-32C on every part                                 | Detects truncation, torn writes and bit rot cheaply (about the speed of a memory copy with slicing-by-8). It is not a MAC: anyone who can write the profile can recompute it (README Limitations).                                                         |
| Tombstones, no compaction                             | Keeps writes append-only. Replaced and deleted rows stay on disk until `clear(ns)`, bounded by 4,194,304 rows and 4,096 segments per namespace. Compaction is a recorded follow-up, not a Sprint 4 item.                                                   |
| Vectors load on the first query                       | `createStore` stays fast and a write-only page never pays for a read. The first query reads and checksums the vector parts (that is what the benchmark's first-query column contains).                                                                     |
| Values lazy per hit                                   | A 100,000 x 2,048-byte index is 200 MB of text the scan never needs; only the k hits' parts are read (a 16-part LRU).                                                                                                                                      |

## 3. Not built

- HNSW or any approximate search (Sprint 6, after a written build-or-adopt note). Recall would be judged
  against this flat index on the same data.
- Quantisation (f16 or int8 would halve or quarter the resident size), compaction, multi-vector documents,
  encryption at rest, a TTL for vector rows.
- Reading with `FileSystemSyncAccessHandle` in a worker (the index is read through `getFile()`), and any
  threaded WebAssembly (GitHub Pages cannot send COOP/COEP).
- Storage events in the Airplane Mode DevTools panel (Sprint 5), embeddings through the worker host
  (Sprint 5).

## 4. How it was measured, and what is not measured

`npm run bench:vectors` (`bench/vector-bench.spec.ts`) builds 10,000 and 100,000 x 384 indexes from
deterministic synthetic vectors and chunks (`bench/synth.ts`: no real documents, no model download), closes
the page, and times a cold `createStore` plus first `query(k = 10)` in fresh pages, five times, then once
after relaunching Chrome on the same profile, then fifty more queries for p50 and p95. Chrome runs with
`--enable-precise-memory-info`. The CSV's `commit` is `git describe --always --dirty`, its `machine` is
generated from `os.cpus()` and `os.totalmem()`, and nothing in it or in the README numbers is typed by hand.

Not measured: anything on an 8 GB Windows no-GPU laptop (the owner's step: the same command there), the
effect of Windows Defender on OPFS and IndexedDB files, behaviour under memory pressure, and the OS file
cache (it cannot be dropped from a page, so a "cold" run is cold for the page and not for the disk).

## 5. Memory

Resident while a store lives: the vectors (rows x dim x 4 bytes) in WebAssembly linear memory, which does
not shrink until the store is closed, plus the keys, the live-key map and a few bytes per row of tables.
Writing streams rows through one block of at most 8 MiB, so a write holds the caller's rows, the resident
index and one part, never two copies of the index. The README memory table (index bytes, WebAssembly memory,
JS heap peak, storage usage) is the measured budget, from the CSV, for the machine named there.
