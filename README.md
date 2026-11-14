# localdata

Offline-first browser storage SDK: `set`/`get`/`delete` over OPFS with an IndexedDB fallback, and a
flat vector index (`putVectors`/`query`) persisted beside the values. It implements the Airplane Mode
Labs Storage API contract 0.2.0.

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the handles are
reserved; nothing is published yet.

## Status

alpha = locally built, untagged 0.2.0-alpha.0. Sprint 4 landed the vector index: `putVectors` writes
rows (a key, a Float32Array, an optional value) in a crash-safe, checksummed format; `query` returns the
exact top-k by cosine or dot product, ties broken by key in UTF-8 byte order; the scan is Rust compiled to
WebAssembly, in a SIMD build and a scalar build that give bit-identical scores. The 13 `query()` cases that
were skipped since Sprint 2 now run and pass in Node and in Chrome on OPFS and IndexedDB, and the flat
index meets the done-when on the development machine: 100,000 chunks persist and reload cold in under
2 seconds (see Benchmarks: Apple M5 Pro, 48 GB; **not measured on 8 GB**, the owner's step). Storage events
(`storage.set`, `get`, `delete`, `quota`, and now `query`, `index.open`, `index.write`) are opt-in.

Process state: tests-first evidence Done (red/green logs in `evidence/sprint-4/D4/`); local macOS green;
CI on three OSes configured, pending the owner's push. Not published, not tagged, signed artifacts and the
release manifest are open (owner key). The live demo at the Pages URL still shows the Sprint 2 build until
the owner pushes; the Sprint 4 demo is proven on a local build served at `/localdata/`.

## Install

Not published yet: the npm scope @airplanemode and the PyPI and crates.io names are not reserved. The commands below were proven from locally built artifacts on macOS arm64 (an npm pack tarball installed offline into a fresh empty directory, a wheel installed into a fresh venv); publishing to the registries is the owner's step. This package is `0.2.0-alpha.0`, not tagged.

### From a locally built tarball

The WebAssembly kernel is built from Rust (`rust-toolchain.toml` pins 1.98 with the
`wasm32-unknown-unknown` target) and embedded in `dist/index.js`, so the tarball has no `.wasm` file and
the library has no runtime dependencies.

```sh
npm ci
npm run build:wasm                 # cargo build --release --locked, twice (SIMD and scalar), path-remapped
npm run build                      # dist/index.js + dist/index.d.ts (ESM, ES2022, no source map)
npm pack                           # writes airplanemode-localdata-0.2.0-alpha.0.tgz (git-ignored via *.tgz)
mkdir fresh && cd fresh && npm init -y
npm i ../airplanemode-localdata-0.2.0-alpha.0.tgz --ignore-scripts --offline --no-audit --no-fund
node -e "import('@airplanemode/localdata').then(async m => { const s = await m.createStore({ driver: 'memory' }); await s.putVectors('docs', [{ key: 'a', vector: new Float32Array([1, 0]) }, { key: 'b', vector: new Float32Array([0, 1]) }]); console.log((await s.query('docs', new Float32Array([1, 0.1]), 2)).map(h => h.key)); })"
```

`npm run pack:check` does all of this in a scratch directory with an empty npm cache and fails on any
packaging rule (the embedded modules equal a fresh remapped build, no builder path in the tarball, under
5 MB, LICENSE and NOTICE present), then installs offline into a fresh directory and queries three
vectors. Node 22+ is required for the toolchain; the library itself targets Chrome (OPFS) with an
IndexedDB fallback, and Node only through the `memory` driver.

### After the owner publishes

Not available today; these will work only once the owner has reserved the scope and published:

```sh
npm i @airplanemode/localdata
```

## Quick start

```ts
import { createStore, StorageError } from '@airplanemode/localdata';

const store = await createStore({ driver: 'auto', quotaBytes: 512 * 1024 * 1024 });

// key-value, as before
await store.set('docs', 'invoice-42', { pages: 3, scanned: new Date() });
await store.set('cache', 'session', 'token', { ttlMs: 60_000 });
const meta = await store.get<{ pages: number; scanned: Date }>('docs', 'invoice-42');
const { keys, cursor } = await store.list('docs', { prefix: 'invoice-', limit: 100 });

// the vector index: rows stream in, the call is all-or-nothing, and the index is on disk when it resolves
await store.putVectors(
  'chunks',
  rows(), // any Iterable or AsyncIterable of { key, vector: Float32Array, value? }
);
const hits = await store.query('chunks', queryVector, 10, {
  metric: 'cosine',
  filterPrefix: 'doc-7/',
});
// [{ key, score, value? }], best first; the same query gives the same answer on every machine
const info = await store.indexInfo('chunks'); // { dim, rows, totalRows, segments, bytes, generation, kernel, ... }

try {
  await store.query('chunks', queryVector, 10);
} catch (e) {
  if (e instanceof StorageError && e.code === 'corrupt') {
    // a checksum or structure check failed: no wrong answer was returned; store.clear('chunks') starts over
  }
}

await store.close();
```

`driver` may be `'auto'` (OPFS when `navigator.storage.getDirectory` exists, otherwise IndexedDB,
otherwise `driver_unavailable`), `'opfs'`, `'indexeddb'`, `'memory'`, or any object implementing
`StorageDriver`. `quotaBytes` is a soft quota the SDK enforces before any write (key-value and vector
bytes together). `maxIndexBytes` (default 1 GiB) bounds the vector, META and key bytes of one index, on
write and on read. `vectorKernel` is `'auto'` (SIMD when WebAssembly SIMD is available), `'simd'` or
`'scalar'`; `clock` (epoch milliseconds) is injectable for TTL tests.

Storage events are opt-in. Pass any `EventSink` (an object with `emit(event)`, such as the runtime's
`EventBus`):

```ts
import { createStore, type Event } from '@airplanemode/localdata';

const seen: Event[] = [];
const store = await createStore({ driver: 'auto', events: { emit: (e) => seen.push(e) } });
await store.set('docs', 'invoice-42', { pages: 3 });
// seen[0]: name 'storage.set', source 'localdata', attrs { ns: 'docs', driver: 'opfs', outcome: 'ok' },
// bytes (the encoded size) and durationMs. The key 'invoice-42' and the value are not in the event.
```

### Develop

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci` from the committed lockfile needs no flag.

```sh
npm ci                   # install scripts are disabled (.npmrc ignore-scripts=true)
npm run build:wasm       # the two ldvec modules into src/wasm/ldvec.gen.ts (git-ignored); needs cargo 1.98
npm run ci               # build:wasm, fmt:check, typecheck, vitest (memory driver, corruption, scale), build
cargo test --locked      # the Rust crate: CRC-32C, format validation, scan, 200,000-iteration mutation test
cargo clippy --locked --workspace --all-targets -- -D warnings && cargo fmt --all -- --check
npm run test:browser     # Playwright on installed Chrome (channel "chrome"); builds test/browser/dist
npm run bench:vectors    # writes docs/benchmarks/vector-index.csv (see Benchmarks); then: npm run bench:readme
npm run demo:build       # bundle the public demo into demo/dist (what .github/workflows/pages.yml deploys)
npm run sync-contracts   # refresh src/contracts (storage-api 0.2.0, event 0.1.3) from ../runtime/spec, sha256-gated
npm run pack:check       # npm pack, tarball rules, offline fresh-directory install, real round trip
npm run pack:check -- --out <dir>   # same, keeping the tarball, the fresh install and pack-check.json in <dir>
```

`pack:check` builds first (a clean checkout works), then works in a new directory under `os.tmpdir()`
(set `TMPDIR` to move it), which it removes on success; nothing in the repository names a scratch
path. `test/portability.test.ts` fails if a sprint scratch path or a home directory is hard-coded
in a public file. The Windows branch of `pack-check` (`npm.cmd` through a shell) runs only on the
owner's `windows-latest` CI read and has not been executed locally.

Tests are written before implementation: the shared behavioural suites live in
`test/storage.behaviour.ts`, `test/query.behaviour.ts` and `test/vector.behaviour.ts` and run in Vitest
against the memory driver and in Chrome against OPFS and IndexedDB; the red logs are in
`evidence/sprint-4/D4/`.

## How it works

- Validation: namespaces match `^[a-z0-9][a-z0-9._-]{0,63}$`; keys are 1..1024 UTF-16 code units
  without U+0000; the prefix `__ld_` is reserved for the SDK (`__ld_meta` accounting, `__ld_vec.<ns>`
  vector indexes). Errors are `StorageError` instances with a `code` (`not_implemented` (never thrown by
  0.2), `quota_exceeded`, `invalid_key`, `invalid_namespace`, `invalid_value`, `driver_unavailable`, `io`,
  `closed`, `corrupt`) and optional `details`. A vector row's problem is identified by `details.row`, its
  0-based position in the call; no error ever contains a key, a `filterPrefix`, a vector component, a score
  or a value.
- Codec: every value becomes one `LD1` envelope: magic `LD1`, a flags byte, a little-endian u32 JSON
  length, the JSON tree, then a binary section. `ArrayBuffer`, every typed array and `Blob` (with its
  MIME type) are hoisted out of the tree as `{ "$ld": kind, "i", "o", "n" }` leaves and stored
  byte-exact; `Date` becomes `{ "$ld": "date" }`; `NaN`, `Infinity`, `-Infinity` and `-0` become
  `{ "$ld": "num" }`; a plain object that owns a `$ld` key is escaped as `{ "$ld": "obj", "o": ... }`.
  Functions, symbols, `Map`, `Set`, class instances, `undefined`, `bigint`, `DataView`, sparse
  arrays and circular references are rejected with `invalid_value` before anything is written. A
  vector row's `value` uses the same codec (at most 1 MiB encoded). A `Float32Array` passed to `set()` is
  an ordinary value and is NOT indexed.
- Accounting and quota: the SDK keeps a per-namespace record (key, size, expiry) under the reserved
  namespace `__ld_meta`, rewritten after every mutation, and rebuilds it from the driver if the
  record is missing or corrupt. When `quotaBytes` is configured, a `set` or a `putVectors` that would push
  the total above it throws `quota_exceeded` before the driver is touched (a `putVectors` checks before
  each part it writes); the browser's own `QuotaExceededError` maps to the same code.
- TTL: `set(..., { ttlMs })` stores an expiry; an expired `get` returns `undefined` and deletes the
  row lazily; `list` hides expired keys. Vector rows have no TTL.
- The vector index. `putVectors(ns, rows)` streams rows into one WebAssembly block of at most 8 MiB, checks
  every row (finite components, self dot product at most 1e30), computes inverse norms and a running
  CRC-32C, and writes the block as a part; values go to 1 MiB parts, keys and offsets to a META blob. The new
  HEAD (counts, generation, the segment table, a tombstone bitset, two CRCs) is written last in one put, so
  the call is all-or-nothing: a crash, a closed page or a quota error leaves the previous index readable.
  A 100,000-row index is never held twice in memory. `query` scores every live row with a flat scan and
  keeps the best k in a bounded heap. Scores are IEEE binary32 with four accumulators and no fused
  multiply-add, so the SIMD module, the scalar module and the `Math.fround` reference in
  `src/vec/reference.ts` agree bit for bit; ties break by key in UTF-8 byte order. Opening reads HEAD and META,
  verifies every part's length and CRC-32C, and loads vectors on the first query; a structural or checksum
  failure rejects with `corrupt` (`details { ns, file, reason }`) and keeps rejecting until `clear(ns)`
  or a new HEAD. Layout, invariants and reasons: [docs/vector-index-format.md](docs/vector-index-format.md);
  design and what is not built: [docs/vector-index.md](docs/vector-index.md).
- Events (optional): with `createStore({ events })` the SDK emits the seven names below, source
  `localdata`, shaped by the vendored Event contract 0.1.3. With no sink nothing is built and no clock
  is read.

  | Name                  | Kind   | Level                                   | attrs                                                                                                                   | Top level                            |
  | --------------------- | ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
  | `storage.set`         | timing | `debug`; `warn` on a failed set         | `ns`, `driver`, `outcome`: `ok` or a `StorageError` code                                                                | `bytes` (encoded size), `durationMs` |
  | `storage.get`         | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `hit`, `miss`, `expired` or a `StorageError` code                                            | `bytes` on a hit, `durationMs`       |
  | `storage.delete`      | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `removed`, `absent` or a `StorageError` code                                                 | `durationMs`                         |
  | `storage.quota`       | log    | `warn` on a refused write; else `debug` | `driver`, `ns` (`''` = all), `usage`, `quota` (number or `null`), `needed`                                              |                                      |
  | `storage.query`       | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`, `k`, `candidates`, `metric`, `kernel` (`simd`, `scalar` or `none`)                           | `durationMs`                         |
  | `storage.index.open`  | timing | `debug`; `warn` on corrupt              | `ns`, `driver`, `outcome` (`ok`, `absent` or a code), `rows`, `segments`, `reason` (`''` or a corrupt reason), `kernel` | `bytes`, `durationMs`                |
  | `storage.index.write` | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`, `rows` (live, after the call), `replaced`, `segments` (after the call)                       | `bytes`, `durationMs`                |

  `storage.index.open` is emitted by a vector call that loads an index (`query`, `indexInfo`, a write),
  once per load, including `absent`; `usage()`, `delete()` and the KV calls emit none and create no kernel.
  `usage()` emits a `debug` `storage.quota` with `needed: 0`. A write the soft quota refuses emits
  `storage.quota` (`warn`) and then the write's own event with `outcome: 'quota_exceeded'`; `needed` is
  the exact shortfall. When the browser refuses a write (a `QuotaExceededError`), `quota` is `null`
  because the browser does not say what its limit is. `list`, `clear` and `close` emit nothing. The sink
  is called synchronously inside `try`/`catch` and its return value is never awaited, so a sink that throws
  or returns a rejecting promise cannot break a storage call; events emitted from inside a sink call on
  the same store, or by an operation that started there, are dropped, so a sink cannot recurse into itself.
  `session` is a random id per page load; pass `eventSession` (1..64 characters, never user-derived) to
  share the runtime's `sessionId()`. A custom driver whose name is not `opfs`, `indexeddb` or `memory` is
  reported as `driver: 'custom'`. Never the query vector, `filterPrefix`, keys, scores or values.

- Drivers only move bytes. OPFS: `airplanemode-localdata/v1/<ns>/<hex sha-256(key)>` holds one
  value per file and `<ns>/keys.json` is the namespace index, written whole with
  `createWritable({ keepExistingData: false })`. IndexedDB: database `airplanemode-localdata`
  version 1, object store `kv` with keyPath `[ns, key]` and an index on `ns`, values stored whole
  as `ArrayBuffer`. Memory: a `Map` of `Map`s, bytes copied in and out. A vector index uses the same drivers
  under the namespace `__ld_vec.<ns>`, one record per part. The OPFS driver also offers two optional,
  non-contract hooks the index uses when a driver has them (`refreshIndex(ns)` to see another tab's writes
  and `namespaces()` to total usage); the `StorageDriver` contract is unchanged and a custom driver without
  them is single-writer.

### Security and privacy

This library makes no network requests and sends no telemetry (`test/no-network.test.ts` greps `src/`;
`test/browser/*.spec.ts` assert that every request the page makes stays on its own `127.0.0.1`
origin). It accepts no URLs at all: the only I/O is to the browser's origin storage (OPFS or IndexedDB) of
the page that calls it, or to process memory with the `memory` driver. The WebAssembly modules are
embedded as base64 and compiled from memory (the demo's CSP adds only `'wasm-unsafe-eval'`).

Data is stored unencrypted in origin storage and is as private as the origin: any script running on the
same origin can read it. Nothing is persisted outside the browser profile. See `SECURITY.md` for the
disclosure policy.

Namespaces appear in events. The namespace (attribute `ns`) is in every `storage.*` event, and in the
runtime's DevTools snapshot when you pass its bus as the sink. Do not encode personal data or document
identifiers in namespace names: use `docs`, not `invoice-for-<customer>`. Keys, prefixes, vectors, scores
and values never appear in an event or in a vector `StorageError`, nor does a driver error message or
stack; a namespace that fails validation is reported as `''`, never as the string you passed.

## Contracts

Implements Storage API `0.2.0` (draft) from `AirplaneMode-Labs/runtime` `spec/storage-api.ts` (prose and
the normative vector semantics in `spec/storage-api.md`): `putVectors`, `query`, `indexInfo`, the `corrupt`
error and the scoring and ordering rules. The contract is vendored at `src/contracts/storage-api.ts` and
never edited here: `npm run sync-contracts` copies it from the sibling `../runtime/spec` checkout and
`test/contracts-sync.test.ts` fails on drift (and skips when the sibling is absent).

The shape of the `storage.*` events is the Event contract `0.1.3` (wire string
`airplanemode.event/0.1`), vendored at `src/contracts/event.ts` the same way. Both come from spec release
0.4.0 in runtime/spec (committed; public after the owner's push). `sync-contracts` is gated on the spec
release's `SPEC-LANDED.txt`: every source file must hash (sha256) to its recorded value, otherwise
nothing is copied. The file is looked up in this order: the `SPEC_LANDED` environment variable (an error if it
names a missing file), then the highest-numbered `../evidence/sprint-<n>/D1/SPEC-LANDED.txt`; with neither the script
exits 1 and copies nothing. Events are outside the Storage API contract. This package does not use the
manifest contract; manifest spec v0.1 published in runtime/spec (committed; public after the owner's push).

## Demo

Live demo: <https://airplanemode-labs.github.io/localdata/>. Built from `main` by
`.github/workflows/pages.yml` on every push; it shows only what works today and has a box titled
"What this demo does not do yet". It runs entirely in the browser: no upload, no analytics, no
third-party scripts or fonts. Until the owner pushes the Sprint 3 and 4 commits the live page still shows
Sprint 2; the refresh is proven on a local build of `demo/dist` served at `/localdata/`.

The page lets you pick a driver (OPFS, IndexedDB or memory), open a store with an optional SDK soft
quota, `set`/`get`/`delete`/`list` values by namespace and key (JSON, plain strings or a 1 MiB
binary pattern), watch `navigator.storage.estimate()` and `persisted()` live, request `persist()`,
watch the last 50 `storage.*` events the page's own `EventSink` receives (namespace, driver, outcome,
bytes, duration; never a key or a value), and fill quota with synthetic 4 MiB chunks under the namespace
`demo-fill` until the SDK soft quota or the browser refuses the write.

The **Vector index** section builds 10,000 rows (100,000 is selectable) of deterministic synthetic vectors
(dim 384, 256-byte chunks) with `putVectors`, shows the write time and the index size, and, after a page
reload, a cold query with the measured time, kernel, rows, an approximate JS heap
(`performance.memory`), the WebAssembly memory, the index bytes, the top 10 keys with scores and chunk
previews, and whether the answer matches the naive reference. A storage warning comes before the build
(the figure is computed from the benchmark CSV) and Delete index removes it. It writes only under
localdata's own OPFS directory and IndexedDB database (`airplanemode-localdata`); all Airplane Mode Labs
demos share one browser origin on GitHub Pages. `npm run demo:build` produces the same `demo/dist/` the
workflow deploys; nothing built is committed.

## Benchmarks

<!-- prettier-ignore-start -->
<!-- bench:begin (generated by scripts/bench-readme.mjs from docs/benchmarks/vector-index.csv) -->

Measured on Apple M5 Pro, 48 GB (darwin arm64 27.2.0), Chrome/157.0.8103.79, simd kernel, on the uncommitted Sprint 4 working tree based on 0390d65 (CSV commit column `0390d65-dirty`). Every figure below is computed from [docs/benchmarks/vector-index.csv](docs/benchmarks/vector-index.csv) by `scripts/bench-readme.mjs`; `npm run bench:vectors` writes the CSV. The 8 GB Windows no-GPU laptop column is not measured (owner step): nothing here is an 8 GB figure, and the OS file cache cannot be dropped from a page, so a "cold" run is cold for the page, the JS heap and the WebAssembly instance, not for the disk cache. Chrome was launched with `--enable-precise-memory-info`.

Cold open plus first query (`createStore` through the resolved first `query`, k = 10), milliseconds:

| Index | Driver | Runs | Median | Worst | After a browser restart | Headroom (2000 ms / worst) | 8 GB Windows no-GPU laptop |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 10,000 x 384, 256-byte chunks | opfs | 5 | 29.0 | 29.3 | 29.7 | 68.3x | not measured |
| 100,000 x 384, 256-byte chunks | opfs | 5 | 186 | 195 | 182 | 10.2x | not measured |
| 100,000 x 384, 2,048-byte chunks | opfs | 5 | 181 | 183 | 182 | 11.0x | not measured |
| 10,000 x 384, 256-byte chunks | indexeddb | 5 | 26.3 | 27.0 | 26.9 | 74.1x | not measured |
| 100,000 x 384, 256-byte chunks | indexeddb | 5 | 179 | 194 | 180 | 10.3x | not measured |

Where the time goes, and what a query costs once the index is resident (medians over the runs), milliseconds:

| Index | Driver | Write (`putVectors`) | Open (HEAD and META) | First query | Query p50 | Query p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 x 384, 256-byte chunks | opfs | 108 | 7.1 | 21.9 | 0.4 | 0.6 |
| 100,000 x 384, 256-byte chunks | opfs | 1038 | 20.0 | 167 | 6.5 | 8.1 |
| 100,000 x 384, 2,048-byte chunks | opfs | 2898 | 20.9 | 161 | 9.9 | 10.8 |
| 10,000 x 384, 256-byte chunks | indexeddb | 107 | 5.2 | 20.6 | 0.4 | 0.6 |
| 100,000 x 384, 256-byte chunks | indexeddb | 1081 | 18.8 | 160 | 6.4 | 7.9 |

Memory budget (median / worst over the cold runs). `index bytes` is the index as written (HEAD, vectors, META with keys, value parts); `WASM memory` is the kernel instance's linear memory after the first query; `JS heap peak` is `performance.memory.usedJSHeapSize` sampled every 10 ms (approximate) over the first query plus the 50 queries that follow it, so it depends on GC timing and is not a cold-window peak (T1's probe read about 79.2 MB at the end of the first query on the 256-byte index and 163.8 MB after 50 more queries: `evidence/sprint-4/T1/results/heap-probe-cs256.json`); `storage usage` is `navigator.storage.estimate().usage` for the whole origin:

| Index | Driver | Index bytes | WASM memory | JS heap peak | Storage usage | 8 GB Windows no-GPU laptop |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 10,000 x 384, 256-byte chunks | opfs | 18.3 MB / 18.3 MB | 17.1 MB / 17.1 MB | 24.6 MB / 24.6 MB | 18.3 MB / 18.3 MB | not measured |
| 100,000 x 384, 256-byte chunks | opfs | 183.0 MB / 183.0 MB | 157.8 MB / 157.8 MB | 230.7 MB / 230.7 MB | 183.0 MB / 183.0 MB | not measured |
| 100,000 x 384, 2,048-byte chunks | opfs | 362.2 MB / 362.2 MB | 157.8 MB / 157.8 MB | 278.1 MB / 278.1 MB | 362.3 MB / 362.3 MB | not measured |
| 10,000 x 384, 256-byte chunks | indexeddb | 18.3 MB / 18.3 MB | 17.1 MB / 17.1 MB | 24.5 MB / 24.6 MB | 18.0 MB / 18.0 MB | not measured |
| 100,000 x 384, 256-byte chunks | indexeddb | 183.0 MB / 183.0 MB | 157.8 MB / 157.8 MB | 141.6 MB / 141.6 MB | 179.5 MB / 179.5 MB | not measured |

Done-when (100,000 chunks persist and reload cold in under 2 seconds): passes on this machine for OPFS at both chunk sizes; 256-byte chunks: median 186 ms, worst 195 ms, headroom 10.2x; 2,048-byte chunks: median 181 ms, worst 183 ms, headroom 11.0x. Apple M5 Pro, 48 GB; not measured on 8 GB.

<!-- bench:end -->
<!-- prettier-ignore-end -->

The 13 `query()` cases and the vector suite are correctness tests, not benchmarks. Before Sprint 4 the
only figures were the key-value ones from `LOCALDATA_BENCH_OUT=<dir> npm run test:browser`
(`evidence/sprint-3/D4/bench/raw.log`); they are unchanged and say nothing about the vector index.

## Limitations

- Alpha, not published and not tagged; the tarball install is proven only from a locally built artifact on
  macOS arm64. Three-OS CI is configured and pending the owner's push; the byte-reproducibility of the
  WebAssembly modules across operating systems is proven on macOS only.
- Not measured on 8 GB: every figure above is from an Apple M5 Pro with 48 GB, a development machine, and is
  not an 8 GB figure. Windows Defender scanning of OPFS and IndexedDB files, memory pressure (tab discard,
  WebAssembly memory growth failing near the 160 MB a 100,000 x 384 index needs) and Windows Chrome eviction
  are unmeasured. The OS file cache cannot be dropped from a page, so cold means cold for the page, not for
  the disk.
- Flat index only: every query scores every row (O(rows x dim)). HNSW is planned for Sprint 6 after a
  build-or-adopt note; no quantisation (f32 only), no compaction (rows replaced or deleted stay on disk until
  `clear(ns)`; at most 4,194,304 rows and 4,096 segments per namespace, and each `putVectors` call adds at
  least one segment, so batch rows), no encryption at rest, and a namespace holds one index of one `dim`.
- Single writer per namespace: writers in different tabs are serialised by a Web Lock and the OPFS driver is
  refreshed under it, but a custom driver without the `refreshIndex` hook is single-writer. Readers in other
  tabs are stale: a tab that has already opened an index does not see another tab's later writes until it
  reopens the store, and a tab that saw no index does not look again for `delete`.
- CRC-32C detects accidental corruption, truncation and torn writes; it does not detect a deliberate edit by anyone who can write the browser profile, who can recompute it.
- Embeddings, keys and chunk values are stored unencrypted in this origin's OPFS or IndexedDB; anyone with access to the OS account or browser profile, and any script running on the same origin (on GitHub Pages all Airplane Mode Labs demos share one origin, S1-041), can read or rewrite them. `clear(ns)` removes the index; clearing the browser's site data removes everything.
- A flat index has no defence against poisoning: a document crafted to rank first for many queries will rank first.
- Driver `auto` follows the browser's capability at open time. The OPFS and IndexedDB stores are independent and nothing migrates between them, so a profile that switches driver sees an empty index: pin the driver or rebuild.
- A write interrupted by a closed page leaves unreferenced records that count toward usage until the next successful `putVectors` or `clear(ns)`. Sweep on open is Sprint 5.
- Browser storage eviction removes the whole origin's data, so the index disappears rather than becoming partly corrupt.
- WebAssembly memory does not shrink until the store is closed: opening a 100,000 x 384 index holds about
  its vector size in linear memory for as long as the store lives, and a query vector, scores and the top-k
  heap come on top. Close the store to release it.
- IndexedDB fallback: `driver: 'auto'` picks it when `navigator.storage.getDirectory` is missing, and every
  vector semantic is identical (the browser test removes OPFS from the page and runs the same flow). The
  IndexedDB rows of the benchmark table are its measured cold-open behaviour on this machine. IndexedDB
  stores each 8 MiB part as one value, so a write holds a part twice while it is cloned. Chrome did not
  enforce a CDP `Storage.overrideQuotaForOrigin` limit on IndexedDB writes in `test/browser/vectors.spec.ts`
  (it did on OPFS), so the quota-failure test for IndexedDB uses a real `QuotaExceededError` thrown by a
  wrapper driver and the SDK soft quota instead; Chrome under-reports IndexedDB usage in `estimate()`.
  Firefox and Safari are untested.
- OPFS requires Chrome (or another Chromium with the File System Access origin private file system)
  and a secure context (`https:` or `127.0.0.1`/`localhost`). WebAssembly SIMD is used when present and
  the scalar module otherwise (identical results, slower).
- The key-value side is unchanged: the IndexedDB driver stores whole values, not chunks; values larger than
  256 MiB are untested; the accounting record is rewritten in full on every mutation, so namespaces with very
  many keys pay a growing per-write cost; `usage()` reports the encoded sizes the SDK wrote, not the bytes the
  browser attributes to the origin; Node is supported only through the `memory` driver.
- `usage()` without a namespace totals the vector indexes of every namespace the driver can list (the three
  built-in drivers can); a custom driver without `namespaces()` contributes only the indexes this store opened.
- Storage events are opt-in; the Airplane Mode DevTools panel does not read localdata directly (storage
  events in the panel are Sprint 5), it shows what the runtime's event bus holds. The cost of events on a
  large workload has not been measured. This README makes no compliance claim of any kind: nothing here is
  an audit, DPDP, RBI or model-inventory statement.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
