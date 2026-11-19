# Vector index

Status: **flat index implemented** in `0.2.0-alpha.0` (Sprint 4), reused unchanged by the documents API of
`0.3.0-alpha.0` (Sprint 5; [vector-index-format.md](vector-index-format.md) section 8), and **HNSW added** as an
optional approximate index in `0.4.0-alpha.0` (Sprint 6, section 6 below; [hnsw-format.md](hnsw-format.md)).
The flat index is unchanged and stays the default and the fallback. The on-disk format of the flat index is in
[vector-index-format.md](vector-index-format.md); the behaviour is the normative part of Storage API 0.2.0,
0.3.0 and 0.4.0 (`runtime/spec/storage-api.md`, committed; public after the owner's push). The measured figures are in the README Benchmarks block, generated from
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

- HNSW for `queryChunks` (the documents API stays a flat scan in 0.4.0). HNSW for `query` exists since Sprint 6
  and is section 6; recall is judged against this flat index on the same data.
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

## 6. HNSW (Storage API 0.4.0, Sprint 6)

An optional approximate index over the same stored vectors. The decision is TD-65 (the TD-17 build-or-adopt
note, `research/plan-addendum-2026-11-19.md`): built in-house inside the Rust `ldvec` crate that is already
compiled to WebAssembly, with zero new dependencies. The byte layout, every validation check and the level
rule are in [hnsw-format.md](hnsw-format.md); this section is the design and the rules a user must know.

**Memory model.** HNSW does not replace the flat index, it sits on it. A graph query scores candidates from the
vectors the flat index holds in WebAssembly memory, so those stay resident exactly as for a flat query, and the
graph adds its own bytes on top: `nodes * (2m + 1) * 4` for layer 0 (a fixed stride, so an insert never moves
a link), a few percent for the upper layers, `nodes * 14` for the per-node tables (ordinal, level, flags, upper-layer
offset and the visited stamp), plus `ef` entries of scratch during a search. The serialised graph is smaller than the
resident one because unused link slots are not written. The graph build needs the whole flat index resident.
The README benchmark table reports the graph bytes and the whole WebAssembly memory it measured; nothing is
estimated there.

**Liveness comes from the flat HEAD.** The graph keeps a deleted flag per node, but a query never reads it:
the flat HEAD's tombstone bitset says which rows are live, the graph's candidate ordinals are each checked
against the HEAD row count, and the row-ordinal-to-key map is the flat index's. A deleted key therefore cannot
be returned, even by a stale or forged graph, and a graph can only lower recall.

**Scores and order.** Every candidate is scored by the kernel with the same function the flat scan uses
(`scan::score_one`: four accumulators, no fused multiply-add, SIMD and scalar agree bit for bit), so a hit's
score is the flat scan's score for that row, and hits are ordered as flat orders them. The kernel returns every
live result it found (up to `ef`) and the TypeScript layer keeps the best `k` with the flat tie rule.

**Currency.** A graph is current only when its generation equals the flat HEAD generation. `putVectors`
inserts the new rows into a current graph and marks a replaced row's node deleted; `delete` marks the node
deleted; both write the graph in the same writer lock after the flat commit, so a crash or a failed graph write
leaves the flat index right and the graph stale. A stale graph is never used (the flat scan answers, with
`fallback: 'stale'`); `buildIndex` makes it current again. Deleting the last live row removes the graph.

**The rebuild rule.** A graph that fails validation on read is removed and rebuilt from the stored vectors with
the stored params, under the writer lock, before the query answers (`storage.index.build`, reason
`rebuild`), and the rebuilt graph is read back through the same validation. At most one rebuild runs per
namespace and HEAD generation per open store. If the rebuilt graph is refused again, or the params record is
refused (it is a separate 28-byte record with its own CRC), the index is dropped and queries answer with the
flat scan (`fallback: 'refused'`) until `buildIndex` is called again: there is no rebuild loop.

**Short answers (identical vectors).** A graph can return fewer than `k` hits when many stored vectors are
identical (repeated boilerplate chunks embed identically): T2 measured 34 hits for `k` = 50 with 60, 200 or
1,000 exact copies of one vector, at `ef` 64 and 500, where the flat scan returns 50. A `k` above `ef`
(`HNSW_EF_MAX` is 1,000) can never be filled either. After the liveness and ordinal checks, an answer with
fewer than min(`k`, live rows) hits is discarded and the exact flat scan answers (same scoring function and
order as a flat query), with `fallback: 'short'` and `index: 'flat'` in the `storage.query` event. The check
lives in the TypeScript layer; the kernel root cause is Sprint 7 and the graph bytes, the determinism fixture
and the generator are unchanged.

**The 64-graph cap.** One kernel instance serves a store, and its handle table holds 64 graphs
(`HNSW_MAX_GRAPHS`, one per namespace). The kernel reports a full table with the code it uses for an exhausted
heap, so the SDK counts the live handles on that failure path only (`Kernel.hnswLiveHandles`). Of the calls
that need a handle, only `buildIndex` is capped: when the table is full it reports `quota_exceeded` with `details.reason: 'max_graphs'`
(`'wasm_memory'` when the heap, not the table, is exhausted) and writes nothing. `dropIndex(ns, 'hnsw')` frees a
slot; rebuilding a namespace whose graph is loaded releases that graph's handle first, so a replace works at
the cap.

A load never throws `max_graphs` (BUG-T2-S6-08). A query with `index: 'hnsw'`, a put or a delete that must
load a persisted graph into a full table releases the least-recently-used resident graph of another namespace
(`AnnManager.retryAfterEviction`) and loads again. The use order is per store: every hnsw query, load, build
and write touches it. A namespace is never chosen while the store is running or has queued any operation on it
(`Entry.active`: a query, a writer holding the Web Lock, a build, a rebuild), so a handle that an in-flight
build, insert or serialise is using is never released. Releasing frees the handle only: the stored records are
not deleted, rewritten or rebuilt, and the next query of that namespace loads them again (one
`storage.index.open` event of kind `hnsw` each time). In the one case where every resident graph is in use at
that moment, the query is answered by the exact flat scan with `fallback: 'absent'` and `index: 'flat'`, and the
stored graph is left alone: this is the one case where `absent` means "not loadable in this store right now"
rather than "no graph stored". A put or delete in the same situation goes on without a graph update and leaves
the stored graph stale (flat answers until `buildIndex`), and `indexInfo(ns).ann` is omitted for that call.
The rebuild of a refused graph follows the same rule: with the table full and every other graph in use it
builds nothing, drops nothing and answers flat with `fallback: 'absent'`. The contract is unchanged:
`BuildIndexResult`, the fallback values and the error reasons of Storage API 0.4.0 stay as they were.

**Replaced rows and duplicate-heavy data.** A graph keeps the nodes of rows that were replaced or deleted
(compaction is not built), so after most rows of a namespace are replaced, or after a graph is built over
duplicate-heavy data such as boilerplate chunks, its recall can fall below a fresh build's with nothing in a
query to say so (a query still returns k live hits, so no fallback fires). `indexInfo(ns).ann` shows it:
`nodes` counts every node the graph holds, `liveNodes` the live ones. One full replace of a graph gives
`liveNodes / nodes` of exactly 0.5 and a second one a third; call `buildIndex` again (a fresh graph over the
live rows) when the ratio is 0.5 or lower. `test/ann-churn.test.ts` reproduces the condition on a small seeded
set (identical vectors, then two full replaces) and shows `buildIndex` restoring recall@10 against the flat
scan to 1.0; no figure for the degraded recall is quoted because it depends on the data (not measured on 8 GB,
like every figure here).

**Deletes do not batch.** With a current graph every `delete` marks one node and then writes the whole graph
record, and there is no batched delete (deferred to Sprint 7). `npm run bench:delete-cost` measures it
(`docs/benchmarks/delete-cost.csv`: Apple M5 Pro with 48 GB, installed Chrome on OPFS, 200 single deletes per
run, median of 3 runs; not measured on 8 GB): at 100,000 x 32, 22.80 ms per delete against 2.60 ms flat-only
(at 20,000 rows, 8.70 ms against 2.00 ms), so a million single deletes at the 100,000-row rate would take
about 6.3 hours. Puts do batch (one `putVectors` call writes the graph once). For a bulk delete, call
`dropIndex`, delete the keys, then `buildIndex`: queries that ask for `hnsw` answer flat
(`fallback: 'absent'`) in between.

**What is not built.** Quantisation, compaction (deleted and replaced nodes stay until `buildIndex` replaces
the graph), encryption at rest, HNSW for `queryChunks`, a graph shared between namespaces, an incremental
write of the graph (every change that keeps a graph current writes the whole record again, about 10 MB at
100,000 rows), a batched delete, and any parallel build.
