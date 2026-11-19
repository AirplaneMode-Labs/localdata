# localdata

Offline-first browser storage SDK: `set`/`get`/`delete` over OPFS with an IndexedDB fallback, a flat
vector index (`putVectors`/`query`) with an optional HNSW graph (`buildIndex`, `query({ index: 'hnsw' })`)
and a documents API (`putDocument`/`queryChunks`/`deleteDocument`) persisted beside the values. It
implements the Airplane Mode Labs Storage API contract 0.4.0.

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the handles are
reserved. Nothing is published and nothing is tagged: the names are not reserved.

## Status

Sprint 6 (19 Nov 2026): Working: an optional HNSW graph behind the Storage API (buildIndex, query with index "hnsw" and ef; flat stays the default and the fallback; the graph is stored on OPFS, IndexedDB or memory, validated on every read and rebuilt from the stored vectors when it is refused), built in-house in the Rust ldvec crate with no new dependency and shown here against the flat scan on the same seeded data, in Chrome on an Apple M5 Pro with 48 GB (not measured on 8 GB). Not yet: quantisation, compaction, encryption at rest, HNSW for queryChunks, an 8 GB measurement.

alpha = locally built, untagged 0.4.0-alpha.0 (the version moves from 0.3.0-alpha.0 in Sprint 6, TD-69; the
architect dates the CHANGELOG entry at wrap-up). Sprint 6 added the approximate index of Storage API 0.4.0:
`buildIndex(ns, { kind: 'hnsw', ... })` builds an HNSW graph over the stored vectors, `query(..., { index:
'hnsw', ef })` searches it, and `dropIndex` removes it. The caller chooses the index kind per query; flat
is the default and the fallback, so a query that asks for HNSW and cannot be answered by a current,
valid graph is answered by the flat scan, with the same results and a reason in the event. The graph is
built in-house inside the existing Rust `ldvec` crate (TD-65, the TD-17 note of 19 Nov 2026) with no new
dependency: `crates/ldvec/Cargo.toml` still has an empty `[dependencies]` and `NOTICE` is unchanged. It is a
derived index: the stored vectors stay the source of truth, the graph file holds no vectors and no keys,
it is validated byte by byte on every read, and a graph that fails any check is refused and rebuilt from
the vectors. It also closed S1-120 (the privacy test's needle can no longer occur in a random id).

All timings come from an Apple M5 Pro with 48 GB (see Benchmarks): **not measured on 8 GB**, the owner's
step. Process state: tests-first evidence in `evidence/sprint-6/D4/` (red and green logs); local macOS
green in Node and in Chrome on OPFS and IndexedDB; CI at the pushed head da39477 was green on all three
OSes, and the Sprint 6 changes await the owner's push, so no CI run of them has been read. Not published,
not tagged; signed artifacts and the release manifest are open (owner key). The live demo at the Pages URL
changes only after the owner pushes; the Sprint 6 demo is proven on a local build served at `/localdata/`.

## Install

Not published yet: the npm scope @airplanemode and the PyPI and crates.io names are not reserved. The commands below were proven from locally built artifacts on macOS arm64 (an npm pack tarball installed offline into a fresh empty directory, a wheel installed into a fresh venv); publishing to the registries is the owner's step. This package is `0.4.0-alpha.0`, not tagged.

### From a locally built tarball

The WebAssembly kernel is built from Rust (`rust-toolchain.toml` pins 1.98 with the
`wasm32-unknown-unknown` target) and embedded in `dist/index.js`, so the tarball has no `.wasm` file and
the library has no runtime dependencies.

```sh
npm ci --ignore-scripts
npm run build:wasm                 # cargo build --release --locked, twice (SIMD and scalar), path-remapped
npm run build                      # dist/index.js + dist/index.d.ts (ESM, ES2022, no source map)
npm pack                           # writes airplanemode-localdata-0.4.0-alpha.0.tgz (git-ignored via *.tgz)
mkdir fresh && cd fresh && npm init -y
npm i ../airplanemode-localdata-0.4.0-alpha.0.tgz --ignore-scripts --offline --no-audit --no-fund
node -e "import('@airplanemode/localdata').then(async m => { const s = await m.createStore({ driver: 'memory' }); await s.putVectors('docs', [{ key: 'a', vector: new Float32Array([1, 0]) }, { key: 'b', vector: new Float32Array([0, 1]) }]); await s.buildIndex('docs', { kind: 'hnsw', m: 4, efConstruction: 8 }); console.log((await s.query('docs', new Float32Array([1, 0.1]), 2, { index: 'hnsw' })).map(h => h.key)); })"
```

`npm run pack:check` does all of this in a scratch directory with an empty npm cache and fails on any
packaging rule (the embedded modules equal a fresh remapped build, no builder path in the tarball, under
5 MB, LICENSE and NOTICE present), then installs offline into a fresh directory and runs real calls from it: a
key-value round trip, a vector query, an HNSW build and graph query (`buildIndex` then `query({ index: 'hnsw' })`), and a document put, query, delete and clear. Node 22+ is required for the toolchain; the library itself targets Chrome (OPFS) with an
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
const info = await store.indexInfo('chunks'); // { dim, rows, totalRows, segments, bytes, generation, kernel, ann?, ... }

// HNSW (Storage API 0.4.0): an optional graph over the stored vectors, chosen per query. Flat stays the default.
await store.buildIndex('chunks', { kind: 'hnsw', m: 16, efConstruction: 200, seed: 1 }); // deterministic for these
const approx = await store.query('chunks', queryVector, 10, { index: 'hnsw', ef: 64 });
// same score and key order as flat for every hit; a current, valid graph answers, otherwise the flat scan does
// (the storage.query event says which: index, fallback). putVectors and delete keep a current graph current.
await store.dropIndex('chunks', 'hnsw'); // flat is unchanged

// documents (Storage API 0.3.0): a document and its chunks in ONE all-or-nothing commit
await store.putDocument(
  'policies',
  {
    docId: 'policy-3p',
    title: 'Policy 3P',
    sha256,
    bytes: file.size,
    pages: 12,
    meta: { source: 'upload' },
  },
  chunks(), // Iterable or AsyncIterable of { ordinal, pageStart, pageEnd, text, vector: Float32Array, gate? }
);
const found = await store.queryChunks('policies', questionVector, 5);
// [{ docId, title, ordinal, pageStart, pageEnd, text, score }], best first: the chunk text and where it came from
await store.deleteDocument('policies', 'policy-3p'); // hides the chunks from every query, in one commit
// one namespace per document makes Delete physical: clear(ns) removes every file or record of it
store.redactNamespacePrefix('dockit.d'); // events show 'dockit.d*', never the docId (the SDK also does this itself)
await store.putDocument('dockit.dabc123', doc, chunks());
await store.clear('dockit.dabc123');

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
bytes together). `maxIndexBytes` (default 1 GiB) bounds the vector, META and key bytes of one index, plus its graph, on
write and on read. `vectorKernel` is `'auto'` (SIMD when WebAssembly SIMD is available), `'simd'` or
`'scalar'`; `clock` (epoch milliseconds, also stamped as a document's `createdAt`) is injectable for tests.

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

## How it works

Offline-first browser storage in one SDK, implementing the Airplane Mode Labs Storage API contract 0.4.0:

- key-value: `set`/`get`/`delete`/`list` over OPFS with an IndexedDB fallback, with TTL and a soft quota;
- a flat vector index: `putVectors`/`query`, exact top-k by cosine or dot product, scanned by Rust
  compiled to WebAssembly (SIMD and scalar builds with bit-identical scores);
- an optional HNSW graph (new in 0.4.0): `buildIndex`, `query({ index: 'hnsw', ef })` and `dropIndex`, a
  derived approximate index over the same stored vectors, in the same Rust and WebAssembly kernel, with flat
  as the default and the fallback;
- documents (0.3.0): `putDocument`, `getDocument`, `listDocuments`, `deleteDocument` and
  `queryChunks`, which store a document with its chunks (text, page references and a vector each) and
  answer "which chunks, from which pages, are nearest this vector", all behind the same drivers;
- opt-in `storage.*` events that never carry a key, a docId, a title, chunk text, a vector or a score.

Nothing here makes a network request; data stays in the browser's origin storage.

- Validation: namespaces match `^[a-z0-9][a-z0-9._-]{0,63}$`; keys are 1..1024 UTF-16 code units
  without U+0000; the prefix `__ld_` is reserved for the SDK (`__ld_meta` accounting, `__ld_vec.<ns>`
  vector indexes, `__ld_ann.<ns>` HNSW graphs, `__ld_doc.<ns>` documents). Errors are `StorageError` instances with a `code` (`not_implemented` (never thrown by
  0.2), `quota_exceeded`, `invalid_key`, `invalid_namespace`, `invalid_value`, `driver_unavailable`, `io`,
  `closed`, `corrupt`) and optional `details`. A vector row's problem is identified by `details.row`, its
  0-based position in the call; no error ever contains a key, a `filterPrefix`, a vector component, a score
  or a value. `buildIndex` and the `index`/`ef` options add `invalid_value` reasons `kind`, `m`, `efConstruction`, `seed`,
  `metric` and `ef`, and `quota_exceeded` reasons `quota`, `max_index_bytes`, `wasm_memory` and `max_graphs`. Documents add `invalid_value` reasons `title`, `sha256`, `bytes`, `pages`, `meta`, `reserved_key`
  (a document field) and, with `details.row`, `ordinal`, `duplicate_ordinal`, `page`, `text`, `vector`, `dim`,
  `gate`, `reserved_key` (a chunk); no docId, title or text is ever in an error.
- Codec: every value becomes one `LD1` envelope: magic `LD1`, a flags byte, a little-endian u32 JSON
  length, the JSON tree, then a binary section. `ArrayBuffer`, every typed array and `Blob` (with its
  MIME type) are hoisted out of the tree as `{ "$ld": kind, "i", "o", "n" }` leaves and stored
  byte-exact; `Date` becomes `{ "$ld": "date" }`; `NaN`, `Infinity`, `-Infinity` and `-0` become
  `{ "$ld": "num" }`; a plain object that owns a `$ld` key is escaped as `{ "$ld": "obj", "o": ... }`.
  Functions, symbols, `Map`, `Set`, class instances, `undefined`, `bigint`, `DataView`, sparse
  arrays and circular references are rejected with `invalid_value` before anything is written. Objects are
  built with own-property definition, never `obj[key] =`, in both directions: a member named `__proto__`
  (encode) or stored bytes that name it (decode) become an ordinary own member and never set a prototype
  (S1-101); the per-namespace accounting record does the same, so a key `__proto__` is listed, counted and
  expires like any other (S1-100). A
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
- The HNSW graph (Storage API 0.4.0, [docs/hnsw-format.md](docs/hnsw-format.md), TD-65). `buildIndex` builds
  a graph over the live rows in stored order (Malkov and Yashunin, with the diversity heuristic; defaults m
  16, efConstruction 200, seed 1) inside the `ldvec` WebAssembly module, which is the build-or-adopt decision
  of the TD-17 note: built in-house, zero dependencies, so the graph is deterministic (the same rows, order,
  metric, m, efConstruction and seed give the same bytes in Rust and WebAssembly, SIMD and scalar:
  `test/fixtures/hnsw-determinism.json` pins the sha256 values) and a buyer audits one more module of our own
  code. The graph lives in two records of the reserved driver namespace `__ld_ann.<ns>` (`graph` and
  `params`) beside the flat index, and holds no vectors and no keys: only row ordinals, levels, deleted
  flags and links, bound to the namespace by its bytes and to the flat HEAD by its generation. Every
  distance is computed by the kernel from the vectors the flat index already holds in WebAssembly memory
  with the flat scan's own scoring function, so a hit carries the flat scan's score, bit for bit, and hits are
  ordered as flat orders them (score descending, then key by UTF-8 bytes); the only difference from flat is
  recall. A query that asks for `index: 'hnsw'` is answered by the graph only when it exists, its
  generation equals the flat HEAD, the metric matches, no `filterPrefix` is set and it returns at least
  min(`k`, live rows) hits; otherwise the flat scan answers and the `storage.query` event says why
  (`fallback`: `absent`, `stale`, `filter`, `metric`, `short`, `refused` or `trap`). Liveness never comes from the graph: the flat HEAD's tombstones decide, and every
  candidate ordinal is checked against the HEAD row count, so a deleted key is never returned, even by a
  forged graph. `putVectors` inserts new rows into a current graph and marks a replaced row's node deleted,
  and `delete` marks the node deleted, inside the same writer lock; a failed graph write after the flat
  commit leaves the graph stale (flat answers). A graph is untrusted input: the kernel validates length,
  magic, version, dimension, parameters, namespace bytes, generation, ordinals, levels, links and a
  CRC-32C before use, and a refused graph is removed and rebuilt from the stored vectors with the stored
  params, once per namespace and HEAD generation per open store; a second refusal drops the index and
  queries answer flat (`fallback: 'refused'`). A kernel trap re-creates the module and answers flat.
  Graph bytes count in `usage()` (`annBytes`, included in `bytes`) and toward the pre-write quota checks.
- Documents (Storage API 0.3.0). A document is stored in the document index of its namespace,
  `__ld_doc.<ns>`, which uses the vector index format unchanged: one record row (title, sha256, bytes,
  pages, meta) and one row per chunk (`<docId>/<8-digit ordinal>`, with the text, the page range and the
  vector). `putDocument` streams the chunks, validates each (reasons above), and commits the record and every
  chunk in ONE new HEAD, retiring the replaced document's rows in the same commit: a failure, a closed page
  or a quota error at any chunk leaves the previous state, including after a reopen. `deleteDocument`
  tombstones the record and all chunks in one generation. `queryChunks` scans only the chunk rows and orders
  by score, then docId (UTF-8 bytes), then ordinal; it is exact and matches a naive reference in the tests.
  Everything read back is re-validated and rebuilt member by member; a stored record that is not what the
  SDK wrote is `corrupt`. `clear(ns)` removes `__ld_doc.<ns>` entirely (an OPFS directory, the IndexedDB
  rows), which is the only physical delete: an application that wants Delete to free the bytes keeps one
  namespace per document (dockit does: `dockit.d<docId>`). Layout and the rest:
  [docs/vector-index-format.md](docs/vector-index-format.md), section 8.
- Reads are bounded (S1-092): the OPFS driver compares `File.size` with the length a HEAD or part must have
  before it calls `arrayBuffer()`, so a planted oversize or truncated file is refused as `corrupt` without
  being read into memory; an unparseable `keys.json` in a vector or document namespace is `corrupt` with
  reason `keys_json`, never an empty index.
- Sweep on open (T1-S4-08): when an index is loaded, the part records no HEAD references (a write that never
  committed, the old segments after a dim change) are deleted and counted in the `swept` attr of
  `storage.index.open`. The sweep never waits: it takes the writer's Web Lock only if it is free, so a writer
  in another tab is never raced.
- Events (optional): with `createStore({ events })` the SDK emits the eleven names below, source
  `localdata`, shaped by the vendored Event contract 0.1.5. With no sink nothing is built and no clock
  is read.

  | Name                 | Kind   | Level                                   | attrs                                                                                                                                                                                                                                                                | Top level                            |
  | -------------------- | ------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
  | `storage.set`        | timing | `debug`; `warn` on a failed set         | `ns`, `driver`, `outcome`: `ok` or a `StorageError` code                                                                                                                                                                                                             | `bytes` (encoded size), `durationMs` |
  | `storage.get`        | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `hit`, `miss`, `expired` or a `StorageError` code                                                                                                                                                                                         | `bytes` on a hit, `durationMs`       |
  | `storage.delete`     | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `removed`, `absent` or a `StorageError` code                                                                                                                                                                                              | `durationMs`                         |
  | `storage.quota`      | log    | `warn` on a refused write; else `debug` | `driver`, `ns` (`''` = all), `usage`, `quota` (number or `null`), `needed`                                                                                                                                                                                           |                                      |
  | `storage.query`      | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`, `k`, `candidates`, `metric`, `kernel` (`simd`, `scalar` or `none`), `requested` and `index` (`flat` or `hnsw`), `fallback` (`''` or why flat answered), `ef` (number or `null`)                                                           | `durationMs`                         |
  | `storage.index.open` | timing | `debug`; `warn` on corrupt              | `ns`, `driver`, `outcome` (`ok`, `absent` or a code), `rows`, `segments`, `reason` (`''` or a corrupt reason; for a refused graph `magic`, `version`, `length`, `dim`, `ns`, `generation`, `bounds`, `links` or `crc`), `kernel`, `swept`, `kind` (`flat` or `hnsw`) | `bytes`, `durationMs`                |

| `storage.index.build` | timing | `debug`; `warn` on a failure | `ns`, `driver`, `kind` (`hnsw`), `reason` (`build`, `replace` or `rebuild`), `outcome`, `rows`, `liveRows`, `dim`, `m`, `efConstruction` | `bytes` (graph bytes), `durationMs` |
| `storage.index.write` | timing | `debug`; `warn` on a failure | `ns`, `driver`, `outcome`, `rows` (live, after the call), `replaced`, `segments` (after the call) | `bytes`, `durationMs` |
| `storage.doc.put` | timing | `debug`; `warn` on a failure | `ns`, `driver`, `outcome`, `chunks`, `replaced` (boolean), `rows` (live chunk rows after the call) | `bytes`, `durationMs` |
| `storage.doc.delete` | timing | `debug`; `warn` on a failure | `ns`, `driver`, `outcome`: `removed`, `absent` or a `StorageError` code | `durationMs` |
| `storage.doc.query` | timing | `debug`; `warn` on a failure | `ns`, `driver`, `outcome`, `k`, `candidates`, `metric`, `kernel` | `durationMs` |

`storage.index.open` is emitted by a vector call that loads an index (`query`, `indexInfo`, a write),
once per load, including `absent`; `usage()`, `delete()` and the KV calls emit none and create no kernel.
The document calls emit only the three `storage.doc.*` events (no `storage.index.open`, so a document
namespace's sweep count is not reported). A namespace that starts with a registered prefix is emitted as
`prefix*`: the SDK registers `dockit.d` itself and `redactNamespacePrefix(prefix)` adds up to 16 more,
so an app with one namespace per document never shows a docId in an event. None of the three document
events carries a docId, title, sha256, meta, chunk text, vector component or score.
`usage()` emits a `debug` `storage.quota` with `needed: 0`. A write the soft quota refuses emits
`storage.quota` (`warn`) and then the write's own event with `outcome: 'quota_exceeded'`; `needed` is
the exact shortfall. When the browser refuses a write (a `QuotaExceededError`), `quota` is `null`
because the browser does not say what its limit is. `list`, `clear` and `close` emit nothing. The sink
is called synchronously inside `try`/`catch` and its return value is never awaited, so a sink that throws
or returns a rejecting promise cannot break a storage call; events emitted from inside a sink call on
the same store, or by an operation that started there, are dropped, so a sink cannot recurse into itself.
`session` is a random id per page load; pass `eventSession` (1..64 characters, never user-derived) to
share the runtime's `sessionId()`. A custom driver whose name is not `opfs`, `indexeddb` or `memory` is
reported as `driver: 'custom'`. Never the query vector, `filterPrefix`, keys, scores, values or the graph seed.

- Drivers only move bytes. OPFS: `airplanemode-localdata/v1/<ns>/<hex sha-256(key)>` holds one
  value per file and `<ns>/keys.json` is the namespace index, written whole with
  `createWritable({ keepExistingData: false })`. IndexedDB: database `airplanemode-localdata`
  version 1, object store `kv` with keyPath `[ns, key]` and an index on `ns`, values stored whole
  as `ArrayBuffer`. Memory: a `Map` of `Map`s, bytes copied in and out. A vector index uses the same drivers
  under the namespace `__ld_vec.<ns>` (graph: `__ld_ann.<ns>`, documents: `__ld_doc.<ns>`), one record per part. The OPFS driver also
  offers three optional, non-contract hooks the index uses when a driver has them (`refreshIndex(ns)` to see
  another tab's writes, `namespaces()` to total usage, and `getBytesBounded(ns, key, limit)` to refuse a file
  by its size before reading it); the `StorageDriver` contract is unchanged and a custom driver without
  them is single-writer.

## Contracts

Implements Storage API `0.4.0` (draft) from `AirplaneMode-Labs/runtime` `spec/storage-api.ts` (prose, the
normative vector semantics, the normative Documents (0.3.0) section and the normative Approximate index
(0.4.0) section in `spec/storage-api.md`): `putVectors`, `query`, `indexInfo`, the `corrupt` error, the
scoring and ordering rules, `putDocument`, `getDocument`, `listDocuments`, `deleteDocument`, `queryChunks`,
`redactNamespacePrefix`, and `buildIndex`, `dropIndex`, `QueryOptions.index` and `ef`, `VectorIndexInfo.ann`
and `UsageResult.annBytes`. The contract is vendored at `src/contracts/storage-api.ts` and
never edited here: `npm run sync-contracts` copies it from the sibling `../runtime/spec` checkout and
`test/contracts-sync.test.ts` fails on drift (and skips when the sibling is absent).

The shape of the `storage.*` events is the Event contract `0.1.5` (wire string
`airplanemode.event/0.1`), vendored at `src/contracts/event.ts` the same way. Both come from spec release
0.6.0 in runtime/spec (committed; public after the owner's push). `sync-contracts` is gated on the spec
release's `SPEC-LANDED.txt` (its lines are `<sha256>  spec/<path>`; the older bare `<path>` form is read
too): every source file must hash (sha256) to its recorded value, otherwise
nothing is copied. The file is looked up in this order: the `SPEC_LANDED` environment variable (an error if it
names a missing file), then the highest-numbered `../evidence/sprint-<n>/D1/SPEC-LANDED.txt`; with neither the script
exits 1 and copies nothing. Events are outside the Storage API contract. This package does not use the
manifest contract; manifest spec v0.1 published in runtime/spec (committed; public after the owner's push).

## Demo

Live demo: <https://airplanemode-labs.github.io/localdata/>. Built from `main` by
`.github/workflows/pages.yml` on every push; it shows only what works today and has a box titled
"What this demo does not do yet". It runs entirely in the browser: no upload, no analytics, no
third-party scripts or fonts. The live page changes only after the owner pushes the Sprint 6 commits; the Sprint 6 refresh is proven on a
local build of `demo/dist` served at `/localdata/`.

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

The **Documents** section (Sprint 5) puts three synthetic documents (seeded vectors, no real text) into a
document namespace with `putDocument`, queries them with `queryChunks` and shows each hit with its chunk text
and source page range, deletes one document, lets you reload the page and see it gone, and finally clears the
namespace and shows that the browser's own listing then holds 0 files or records for it. The `storage.doc.*`
events the page receives are listed (namespace, outcome, counts and timing; never a docId, title or text).

The **Flat or HNSW** section (Sprint 6) builds a seeded clustered set of 20,000 x 384 rows (the integer-only
generator shared with the tests, no real documents) into the namespace `demo-ann`, builds the graph with
`buildIndex`, and lets you flip `query()` between `index: 'flat'` and `index: 'hnsw'` over 50 seeded
queries. It shows the build times, the query p50 and p95, the recall@10 of the graph against the flat scan
(measured in the tab, after the timings) and the graph bytes (`usage().annBytes`), all as text.
"Corrupt the graph" truncates the graph record of `demo-ann` only, never the vectors; the next HNSW query
shows the SDK refusing the graph (the reason), rebuilding it from the stored vectors (the
`storage.index.build` event with reason `rebuild`) and still answering. The page's CSP is unchanged (only
`'wasm-unsafe-eval'` beyond the strict default). The "What this demo does not do yet" box lists
quantisation, compaction, encryption at rest, HNSW for `queryChunks` and an 8 GB measurement.

## Benchmarks

<!-- prettier-ignore-start -->
<!-- bench:begin (generated by scripts/bench-readme.mjs from docs/benchmarks/vector-index.csv) -->

Measured on Apple M5 Pro, 48 GB (darwin arm64 27.2.0), Chrome/157.0.8103.79, simd kernel, on the uncommitted Sprint 4 working tree based on 0390d65 (CSV commit column `0390d65-dirty`). Every figure below is computed from [docs/benchmarks/vector-index.csv](docs/benchmarks/vector-index.csv) by `scripts/bench-readme.mjs`; `npm run bench:vectors` writes the CSV. The 8 GB Windows no-GPU laptop column is not measured (owner step): nothing here is an 8 GB figure, and the OS file cache cannot be dropped from a page, so a "cold" run is cold for the page, the JS heap and the WebAssembly instance, not for the disk cache. Chrome was launched with `--enable-precise-memory-info`.

Cold open plus first query (`createStore` through the resolved first `query`, k = 10), milliseconds:

| Index | Driver | Runs | Median | Worst | After a browser restart | Headroom (2000 ms / worst) | 8 GB Windows no-GPU laptop |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 10,000 x 384, 256-byte chunks | opfs | 5 | 29.0 | 29.3 | 29.7 | 68.3x | not measured on 8 GB |
| 100,000 x 384, 256-byte chunks | opfs | 5 | 186 | 195 | 182 | 10.2x | not measured on 8 GB |
| 100,000 x 384, 2,048-byte chunks | opfs | 5 | 181 | 183 | 182 | 11.0x | not measured on 8 GB |
| 10,000 x 384, 256-byte chunks | indexeddb | 5 | 26.3 | 27.0 | 26.9 | 74.1x | not measured on 8 GB |
| 100,000 x 384, 256-byte chunks | indexeddb | 5 | 179 | 194 | 180 | 10.3x | not measured on 8 GB |

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
| 10,000 x 384, 256-byte chunks | opfs | 18.3 MB / 18.3 MB | 17.1 MB / 17.1 MB | 24.6 MB / 24.6 MB | 18.3 MB / 18.3 MB | not measured on 8 GB |
| 100,000 x 384, 256-byte chunks | opfs | 183.0 MB / 183.0 MB | 157.8 MB / 157.8 MB | 230.7 MB / 230.7 MB | 183.0 MB / 183.0 MB | not measured on 8 GB |
| 100,000 x 384, 2,048-byte chunks | opfs | 362.2 MB / 362.2 MB | 157.8 MB / 157.8 MB | 278.1 MB / 278.1 MB | 362.3 MB / 362.3 MB | not measured on 8 GB |
| 10,000 x 384, 256-byte chunks | indexeddb | 18.3 MB / 18.3 MB | 17.1 MB / 17.1 MB | 24.5 MB / 24.6 MB | 18.0 MB / 18.0 MB | not measured on 8 GB |
| 100,000 x 384, 256-byte chunks | indexeddb | 183.0 MB / 183.0 MB | 157.8 MB / 157.8 MB | 141.6 MB / 141.6 MB | 179.5 MB / 179.5 MB | not measured on 8 GB |

Done-when (100,000 chunks persist and reload cold in under 2 seconds): passes on this machine for OPFS at both chunk sizes; 256-byte chunks: median 186 ms, worst 195 ms, headroom 10.2x; 2,048-byte chunks: median 181 ms, worst 183 ms, headroom 11.0x. Apple M5 Pro, 48 GB; not measured on 8 GB.

<!-- bench:end -->
<!-- prettier-ignore-end -->

### Documents

The vector-index figures above were measured in Sprint 4 on the Sprint 4 tree and are not re-measured here.
The documents API has its own, measured in Sprint 5:

<!-- prettier-ignore-start -->
<!-- docs-bench:begin (generated by scripts/bench-docs-readme.mjs from docs/benchmarks/documents.csv) -->

Measured on Apple M5 Pro, 48 GB (darwin arm64 27.2.0), Chrome/157.0.8103.79, simd kernel, on the uncommitted Sprint 5 working tree based on 39d59a0 (CSV commit column `39d59a0-dirty`). Command: `npm run bench:documents`. Corpus: 100 documents x 200 chunks x 384 dims, 400-byte chunk texts, one namespace, synthetic (`bench/synth.ts`; no real document, no model). Every figure below is computed from [docs/benchmarks/documents.csv](docs/benchmarks/documents.csv) by `scripts/bench-docs-readme.mjs`. **not measured on 8 GB**: nothing here is an 8 GB figure, and the OS file cache cannot be dropped from a page, so a "cold" run is cold for the page, the JS heap and the WebAssembly instance, not for the disk cache. Chrome was launched with `--enable-precise-memory-info`; "JS heap peak" is the main-thread `performance.memory.usedJSHeapSize` sampled every 10 ms during the operation (it is not process memory).

| Operation | Driver | Runs | Operations per run | Total, median (ms) | Per operation, median (ms) | p50 (ms) | p95 (ms) | After a browser restart (ms) | JS heap peak, median / worst | WASM memory, median / worst | 8 GB laptop |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| putDocument, one document of 200 chunks | opfs | 3 | 100 | 2769 | 27.7 | 28.1 | 44.7 | - | 57.7 MB / 59.3 MB | - | not measured on 8 GB |
| queryChunks, k = 5, index resident | opfs | 3 | 50 | 122 | 2.43 | 2.40 | 3.20 | - | 39.1 MB / 56.4 MB | 32.7 MB / 32.7 MB | not measured on 8 GB |
| createStore + first queryChunks, k = 5 (fresh page) | opfs | 3 | 1 | 116 | 116 | 116 | 116 | 125 | 38.7 MB / 38.8 MB | 33.0 MB / 33.0 MB | not measured on 8 GB |
| deleteDocument, one document | opfs | 3 | 50 | 169 | 3.37 | 3.20 | 4.40 | - | 46.3 MB / 48.2 MB | - | not measured on 8 GB |
| clear(ns), the whole namespace | opfs | 3 | 1 | 33.8 | 33.8 | 33.8 | 33.8 | - | 59.3 MB / 59.6 MB | - | not measured on 8 GB |
| putDocument, one document of 200 chunks | indexeddb | 3 | 100 | 1135 | 11.3 | 11.1 | 17.5 | - | 78.6 MB / 81.2 MB | - | not measured on 8 GB |
| queryChunks, k = 5, index resident | indexeddb | 3 | 50 | 102 | 2.03 | 1.80 | 2.40 | - | 79.3 MB / 94.5 MB | 32.7 MB / 32.7 MB | not measured on 8 GB |
| createStore + first queryChunks, k = 5 (fresh page) | indexeddb | 3 | 1 | 66.3 | 66.3 | 66.3 | 66.3 | 73.0 | 31.7 MB / 34.5 MB | 33.0 MB / 33.0 MB | not measured on 8 GB |
| deleteDocument, one document | indexeddb | 3 | 50 | 74.3 | 1.49 | 1.40 | 2.20 | - | 48.6 MB / 50.0 MB | - | not measured on 8 GB |
| clear(ns), the whole namespace | indexeddb | 3 | 1 | 16.0 | 16.0 | 16.0 | 16.0 | - | 69.0 MB / 69.6 MB | - | not measured on 8 GB |

Every query and every post-delete query in the table returned the same top 5 as a naive reference computed outside the timing; every `clear(ns)` row found 0 files or records, and 0 hits, afterwards.

<!-- docs-bench:end -->
<!-- prettier-ignore-end -->

The 13 `query()` cases and the vector suite are correctness tests, not benchmarks. Before Sprint 4 the
only figures were the key-value ones from `LOCALDATA_BENCH_OUT=<dir> npm run test:browser`
(`evidence/sprint-3/D4/bench/raw.log`); they are unchanged and say nothing about the vector index.

### HNSW against flat

Measured in Sprint 6 (TD-76: the flat-against-HNSW rows have their own CSV because the columns of
`vector-index.csv` are pinned by tests). The recall target was fixed before measuring and is reported as
measured.

<!-- prettier-ignore-start -->
<!-- ann-bench:begin (generated by scripts/bench-ann-readme.mjs from docs/benchmarks/ann.csv) -->

Measured on Apple M5 Pro, 48 GB (darwin arm64 27.2.0), Chrome/157.0.8103.79, simd kernel, OPFS, with the command `npm run bench:ann` on commit `da39477-dirty`. Every figure below is computed from [docs/benchmarks/ann.csv](docs/benchmarks/ann.csv) by `scripts/bench-ann-readme.mjs`; the CSV holds one row per run and per index kind, with the machine and the command on every row. The 8 GB Windows no-GPU laptop column is not measured on 8 GB (owner step): nothing here is an 8 GB figure. Chrome was launched with `--enable-precise-memory-info`.

The data is the integer-only clustered generator of `bench/synth.ts` (the same bytes in Rust and TypeScript; 1,000 centres for 100,000 rows) or, for the "uniform" rows, the uniform generator of the flat benchmark, which is the worst case for any graph index. 384 dimensions, cosine, k = 10, 200 queries per run; HNSW with m = 16, efConstruction = 200, seed = 1. Recall@10 is the overlap of the HNSW top 10 with the flat scan top 10 of the same store. Medians over the runs; `build` is the `putVectors` write time for flat rows and the `buildIndex` time (on top of the write) for HNSW rows; `cold open` is `createStore` plus the first query of the kind in a fresh page (it includes loading the vectors, and the graph for HNSW). The flat rows are measured in a page that never loads the graph, so their WASM memory and JS heap columns are the flat index alone; `storage_usage_bytes` in the CSV is the whole namespace (flat index and graph) on every row.

| Data | Rows | Index | ef | Runs | Build (ms) | Cold open (ms) | Query p50 (ms) | Query p95 (ms) | Recall@10 | Graph (MB) | Flat index (MB) | WASM memory (MB) | JS heap peak (MB) | 8 GB Windows no-GPU laptop |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| clustered | 100,000 | flat | - | 3 | 855 | 186 | 3.60 | 3.70 | 1.000 | - | 156.4 | 157.8 | 92.0 | not measured on 8 GB |
| clustered | 100,000 | hnsw | 32 | 3 | 41466 | 208 | 0.10 | 0.20 | 0.997 | 10.6 | 156.4 | 183.6 | 92.0 | not measured on 8 GB |
| clustered | 100,000 | hnsw | 64 | 3 | 41466 | 208 | 0.10 | 0.20 | 1.000 | 10.6 | 156.4 | 183.6 | 92.0 | not measured on 8 GB |
| clustered | 100,000 | hnsw | 128 | 3 | 41466 | 208 | 0.20 | 0.40 | 1.000 | 10.6 | 156.4 | 183.6 | 92.0 | not measured on 8 GB |
| clustered | 1,000,000 | flat | - | 1 | 8464 | 2474 | 37.90 | 40.60 | 1.000 | - | 1564.1 | 1566.0 | 550.9 | not measured on 8 GB |
| clustered | 1,000,000 | hnsw | 32 | 1 | 800452 | 2364 | 0.20 | 0.40 | 0.903 | 107.5 | 1564.1 | 1824.4 | 583.6 | not measured on 8 GB |
| clustered | 1,000,000 | hnsw | 64 | 1 | 800452 | 2364 | 0.30 | 0.50 | 0.980 | 107.5 | 1564.1 | 1824.4 | 583.6 | not measured on 8 GB |
| clustered | 1,000,000 | hnsw | 128 | 1 | 800452 | 2364 | 0.50 | 0.80 | 1.000 | 107.5 | 1564.1 | 1824.4 | 583.6 | not measured on 8 GB |
| uniform | 100,000 | flat | - | 1 | 717 | 176 | 3.60 | 3.70 | 1.000 | - | 156.4 | 157.8 | 92.0 | not measured on 8 GB |
| uniform | 100,000 | hnsw | 32 | 1 | 83769 | 197 | 0.20 | 0.30 | 0.045 | 11.6 | 156.4 | 184.6 | 92.0 | not measured on 8 GB |
| uniform | 100,000 | hnsw | 64 | 1 | 83769 | 197 | 0.30 | 0.40 | 0.075 | 11.6 | 156.4 | 184.6 | 92.0 | not measured on 8 GB |
| uniform | 100,000 | hnsw | 128 | 1 | 83769 | 197 | 0.60 | 0.70 | 0.138 | 11.6 | 156.4 | 184.6 | 92.0 | not measured on 8 GB |

Recall target (stated before measuring: at least 0.90 at ef = 128 on the 100,000 x 384 clustered set): median 1.000, lowest run 1.000, so the target is met. The generator was not changed after the numbers were seen.

1,000,000 x 384: ran once to completion (the 100,000 x 384 graph build took 41.5 s, under the 120 s gate); its rows are in the table above, 10,000 centres, the same parameters.

All of this is Apple M5 Pro, 48 GB; not measured on 8 GB. Quantisation, compaction and encryption at rest are not done, so the graph sits on top of the full-precision vectors and the memory columns show it.

<!-- ann-bench:end -->
<!-- prettier-ignore-end -->

Memory model: HNSW keeps the full-precision vectors resident in WebAssembly memory exactly as flat does (a
graph query needs them to score every candidate), so the graph's bytes come on top: the `Graph (MB)` column
is what the serialised graph occupies and the `WASM memory` column is the kernel instance's whole linear
memory, vectors, graph and scratch. The graph is rewritten whole on every `putVectors` or `delete` that
changes a current graph, so put many rows in one `putVectors` call; deletes cannot be batched (see
Limitations).

## Limitations

- Alpha, not published and not tagged; the tarball install is proven only from a locally built artifact on
  macOS arm64. CI at the pushed head da39477 was green on all three OSes; the Sprint 6 changes await the
  owner's push, so no Sprint 6 CI result is claimed here; the byte-reproducibility of the WebAssembly
  modules, and the native-against-WebAssembly equality of the graph bytes, are proven on macOS only.
- Not measured on 8 GB: every figure above (the vector index, the documents and the HNSW benchmark) is from an
  Apple M5 Pro with 48 GB, a development machine, and is not an 8 GB figure. Windows Defender scanning of OPFS and IndexedDB files, memory pressure (tab discard,
  WebAssembly memory growth failing near the 160 MB a 100,000 x 384 index needs) and Windows Chrome eviction
  are unmeasured. The OS file cache cannot be dropped from a page, so cold means cold for the page, not for
  the disk.
- HNSW is optional and approximate: a query scores every row (O(rows x dim)) unless it asks for
  `index: 'hnsw'`, and `queryChunks` stays a flat scan in 0.4.0. A graph query can miss rows (recall is
  measured above, not promised), searches at most 1,000 candidates (`ef` at most 1,000), and falls back to
  the flat scan, whose answer is exact, with a `filterPrefix`, another metric than the graph was built for, a
  stale, absent or refused graph, or a `k` the graph cannot fill (above 1,000, or more than it reaches: see the
  next item). There is no quantisation (f32 only), no compaction (deleted and replaced nodes stay in the
  graph until `buildIndex` replaces it) and no HNSW for documents. A namespace holds one vector index of
  one `dim`, at most one graph, and one document index of one `dim`.
- Many identical vectors can make the graph return fewer than `k` hits. Repeated boilerplate chunks (a page
  header, a licence paragraph) embed to identical vectors, and T2 measured 34 hits for `k` = 50 with 60, 200
  or 1,000 exact copies of one vector, at `ef` 64 and at `ef` 500, where the flat scan returns 50. The SDK
  detects a short answer (fewer live hits than min(`k`, live rows)) and answers with the exact flat scan
  instead: the `storage.query` event reports `index: 'flat'` and `fallback: 'short'`, and that query costs a
  flat scan. The kernel root cause is not fixed (the graph bytes are unchanged this sprint): Sprint 7.
- At most 64 graphs (`HNSW_MAX_GRAPHS`) are loaded per open store, one per namespace, because the kernel's
  handle table holds 64, and only `buildIndex` is capped. The 65th `buildIndex` throws `quota_exceeded` with
  `details.reason: 'max_graphs'` (not `wasm_memory`) and writes nothing; `dropIndex(ns, 'hnsw')` on one
  namespace frees a slot, and rebuilding a namespace that already has a loaded graph replaces it without
  needing a free slot. A store whose driver holds more than 64 persisted graphs keeps working: a query with
  `index: 'hnsw'` (or a put or delete) that must load another graph into a full table releases the
  least-recently-used resident graph of an idle namespace and loads again, so it no longer throws
  `max_graphs`. The released graph's stored record is neither deleted nor rewritten; it is read again the next
  time that namespace is queried (a `storage.index.open` event each time). A namespace with an operation
  running or queued in the store is never chosen. In the one case where every resident graph is in use at
  that moment (64 namespaces busy at once), the query is answered by the exact flat scan with
  `fallback: 'absent'` and the stored graph is left alone: here `absent` means "not loadable in this store
  right now", not "no graph stored", and a put or delete in the same situation leaves the stored graph stale
  (flat answers) until `buildIndex` is called again.
- A graph keeps the nodes of replaced rows (there is no compaction), so after most rows of a namespace are
  replaced, or after a graph is built over duplicate-heavy data such as boilerplate chunks (a page header, a
  licence paragraph), its recall can fall below a fresh build's with nothing in the query to say so: a query
  still returns k live hits, so no fallback fires. `indexInfo(ns).ann` shows the condition: `nodes` counts every
  node the graph holds and `liveNodes` the live ones. One full replace of a graph gives `liveNodes / nodes` of
  exactly 0.5 and a second one a third, so call `buildIndex` again, which builds a fresh graph over the live
  rows, when `liveNodes / nodes` is 0.5 or lower. `test/ann-churn.test.ts` reproduces the condition on a small
  seeded set (identical vectors, then two full replaces) and shows `buildIndex` restoring recall@10 against
  the flat scan to 1.0. No recall figure for the degraded graph is quoted: it depends on the data (and, like
  every figure here, is not measured on 8 GB). Compaction stays not built.
- The graph sits on top of the full-precision vectors: memory is the flat index plus the graph (and the build needs
  the whole index resident). A put or delete that keeps a graph current writes the whole graph record again
  (about 10 MB at 100,000 rows), so many small writes to a namespace with a graph are slow. Puts batch: pass
  many rows to one `putVectors` call and the graph is written once. Deletes do not batch: there is no
  `deleteMany` (a batched delete is deferred to Sprint 7), so with a current graph every `delete` rewrites
  the whole graph record. `npm run bench:delete-cost` measures it (`docs/benchmarks/delete-cost.csv`: Apple M5
  Pro with 48 GB, installed Chrome on OPFS, 200 single deletes per run, median of 3 runs; not measured on 8
  GB): at 100,000 x 32 that is 22.80 ms per delete against 2.60 ms for a flat-only namespace, so a million
  single deletes at that rate would take about 6.3 hours; at 20,000 rows, 8.70 ms against 2.00 ms. The
  spread between runs is in the CSV. For a bulk delete, call `dropIndex(ns, 'hnsw')`, delete the keys, then
  `buildIndex` again (queries with `index: 'hnsw'` answer flat, `fallback: 'absent'`, in between). A graph
  write that fails after the flat commit leaves the graph stale (flat answers) until `buildIndex` is called
  again. The graph build is single-threaded; its time at 100,000 x 384 is in the benchmark table, and the
  1,000,000 outcome is stated there.
- The graph is a derived artefact that is validated, not authenticated: a CRC-32C detects accidents, and
  a graph forged by someone who can write the origin's storage can only lower recall (hits are scored from
  the stored vectors and liveness comes from the flat HEAD), never add a row or change a score. It does
  hold row ordinals and link structure, which leak how similar rows are to anyone who can read the origin.
- No compaction: rows replaced or deleted stay on disk. deleteDocument hides a document's chunks from every
  query, but their bytes remain in the driver, and a replaced document's old rows remain too; only clear(ns) removes
  them physically (an OPFS directory, the IndexedDB rows, the memory map). An application that needs
  Delete to free the bytes keeps one namespace per document. At most 4,194,304 rows (dead ones included)
  and 4,096 segments per index; every `putVectors` and every `putDocument` adds at least one segment, so a
  document namespace takes at most 4,096 `putDocument` calls (replaces count) and batch writes are better.
- No encryption at rest, for documents either: chunk text, titles, meta and vectors are readable by any
  script on the origin and by anyone with the browser profile.
- Single writer per namespace: writers in different tabs are serialised by a Web Lock (`airplanemode-localdata:vec:<ns>`
  for the vector index, `airplanemode-localdata:doc:<ns>` for documents) and the OPFS driver is refreshed under
  it, but a custom driver without the `refreshIndex` hook is single-writer. Readers in other tabs are stale: a
  tab that has already opened an index does not see another tab's later writes until it reopens the store, and
  a tab that saw no vector index does not look again for a vector `delete`.
- CRC-32C detects accidental corruption, truncation and torn writes; it does not detect a deliberate edit by anyone who can write the browser profile, who can recompute it.
- Embeddings, keys and chunk values are stored unencrypted in this origin's OPFS or IndexedDB; anyone with access to the OS account or browser profile, and any script running on the same origin (on GitHub Pages all Airplane Mode Labs demos share one origin, S1-041), can read or rewrite them. `clear(ns)` removes the index; clearing the browser's site data removes everything.
- A flat index has no defence against poisoning: a document crafted to rank first for many queries will rank first. An HNSW graph has none either.
- Driver `auto` follows the browser's capability at open time. The OPFS and IndexedDB stores are independent and nothing migrates between them, so a profile that switches driver sees an empty index: pin the driver or rebuild.
- A write interrupted by a closed page leaves unreferenced records in the driver. The next open of that index
  sweeps them (T1-S4-08), but only when the writer's Web Lock is free: with another tab holding it (or with a
  custom driver and no `navigator.locks`, in a page with a second writer) nothing is deleted until a later open.
  A sweep that fails to delete a record skips it. The count is reported only for vector indexes
  (`storage.index.open` attr `swept`), not for document namespaces. The records occupy origin storage meanwhile.
- S1-092 covers OPFS. IndexedDB hands back a whole value, so an oversize row there is read before its length is
  checked; a script that can write your origin's IndexedDB can also exhaust its memory without the SDK, so this
  is Info. An unparseable `keys.json` is `corrupt` only in a vector or document namespace: in a key-value
  namespace it is still read as empty (the values are then unreachable, and the next `set` writes a fresh
  index over it).
- Documents: at most 20,000 chunks per document (ordinals 0..19999), 16,384 UTF-8 bytes of text per chunk, 16
  meta keys and 8 gate keys per document or chunk, `k` at most 1,000. `gate` is stored with the chunk for the
  application's audit and is not returned by `queryChunks`. A document's `dim` is the namespace's: the first
  document with chunks fixes it, and a chunk of another dim is refused (`dim`) unless no other document holds
  chunks, in which case the index is restarted with the new dim. `queryChunks` on a namespace whose documents
  all have zero chunks returns `[]` for any vector length.
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
- `usage()` without a namespace totals the vector indexes, the graphs and the document indexes of every namespace the
  driver can list (the three built-in drivers can); a custom driver without `namespaces()` contributes only the
  indexes this store opened. `usage().documents` counts live documents; `bytes` includes the document index's
  bytes, dead rows included.
- Storage events are opt-in; localdata has no panel of its own. The runtime's DevTools panel shows them when
  the app passes the runtime's event bus as the sink. The cost of events on a
  large workload has not been measured. This README makes no compliance claim of any kind: nothing here is
  an audit, DPDP, RBI or model-inventory statement. Nothing here is an inference-cost claim either.

## Security and privacy

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

Sprint 5 hardening, each with tests in `test/` (memory driver, a fake OPFS, and Chrome on OPFS and IndexedDB):

- A key, a stored value or a document field that names `__proto__`, `constructor` or `prototype` can no longer
  corrupt accounting or set a prototype: objects are built with own-property definition in the codec, the
  accounting record and the documents layer, and every decoded record is rebuilt member by member (S1-100,
  S1-101). The documents API refuses only `__proto__`, `constructor` and `prototype` as `meta` and `gate` keys
  (reason `reserved_key`); `toString`, `valueOf` and the like are ordinary keys and the docId `constructor` is an
  ordinary id.
- The OPFS driver refuses an oversize or truncated HEAD or part by its `File.size` before reading it, and a
  damaged `keys.json` of an index is `corrupt` (S1-092).
- Document events never carry a docId, title, sha256, meta, chunk text, vector component or score, and a
  namespace under a registered prefix (the SDK registers `dockit.d`) is emitted as `prefix*`.
- `deleteDocument` hides chunks; it does not erase bytes. The physical delete is `clear(ns)` on a per-document
  namespace. Nothing here is a secure-erase claim: the browser and the file system may keep copies.

Sprint 6 hardening (HNSW), each with tests in `test/` and `crates/ldvec/tests/`:

- The graph is untrusted input. Every truncation offset, every flipped byte, an out-of-range or self link, a
  level above 16, an over-large declared count with a short file, another namespace's graph (the namespace is
  bound by its bytes, not a checksum, and a test finds two names with the same CRC-32C), another dimension's
  graph and a graph from the future are refused with a negative code and no panic or trap; 10,000 seeded
  mutations cause 0 panics. Every allocation sized from a file field or a caller count uses `try_reserve`, so
  memory exhaustion is `quota_exceeded` (`wasm_memory`), never a WebAssembly trap.
- A forged graph that links to a deleted row never returns it, a graph ahead of the flat HEAD is refused, and a
  refused graph is rebuilt at most once per HEAD generation, so a hostile or damaged record cannot loop the
  SDK. The graph file holds no vector and no key (a test searches its bytes), and `storage.*` events never
  carry a key, a vector, a score or the graph seed.
- The kernel's `[dependencies]` section is still empty and `NOTICE` is unchanged: no crate was added.

## Develop

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci` from the committed lockfile needs no flag.

```sh
npm ci --ignore-scripts  # install scripts are disabled (.npmrc ignore-scripts=true; CI passes the flag too)
npm run build:wasm       # the two ldvec modules into src/wasm/ldvec.gen.ts (git-ignored); needs cargo 1.98
npm run ci               # build:wasm, fmt:check, typecheck, vitest (memory driver, corruption, HNSW, scale), build
cargo test --locked      # the Rust crate: CRC-32C, format validation, scan, HNSW (recall, determinism, validation, 10,000-mutation fuzz)
cargo clippy --locked --workspace --all-targets -- -D warnings && cargo fmt --all -- --check
npm run test:browser     # Playwright on installed Chrome (channel "chrome"); builds test/browser/dist
npm run bench:vectors    # writes docs/benchmarks/vector-index.csv (see Benchmarks); then: npm run bench:readme
npm run bench:documents  # writes docs/benchmarks/documents.csv; then: npm run bench:docs-readme
npm run bench:ann        # writes docs/benchmarks/ann.csv (flat against HNSW); then: npm run bench:ann-readme
npm run bench:delete-cost # writes docs/benchmarks/delete-cost.csv (one delete with and without a graph; the README and docs/vector-index.md quote it)
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --locked   # the CI doc job (BUG-T2-S4-22)
npm run demo:build       # bundle the public demo into demo/dist (what .github/workflows/pages.yml deploys)
npm run sync-contracts   # refresh src/contracts (storage-api 0.4.0, event 0.1.5) from ../runtime/spec, sha256-gated
npm run pack:check       # npm pack, tarball rules, offline fresh-directory install, real round trip
npm run pack:check -- --out <dir>   # same, keeping the tarball, the fresh install and pack-check.json in <dir>
```

`pack:check` builds first (a clean checkout works), then works in a new directory under `os.tmpdir()`
(set `TMPDIR` to move it), which it removes on success; nothing in the repository names a scratch
path. `test/portability.test.ts` fails if a sprint scratch path or a home directory is hard-coded
in a public file. The Windows branch of `pack-check` (`npm.cmd` through a shell) runs only on the
owner's `windows-latest` CI read and has not been executed locally.

Tests are written before implementation: the shared behavioural suites live in
`test/storage.behaviour.ts`, `test/query.behaviour.ts`, `test/vector.behaviour.ts`,
`test/proto.behaviour.ts` (S1-100 and S1-101) and `test/documents.behaviour.ts` (the documents API) and
run in Vitest against the memory driver and in Chrome against OPFS and IndexedDB, each across a close and
reopen of the store; the red logs are in `evidence/sprint-5/D4/`. `test/fake-env.ts` is an in-memory OPFS
and Web Locks for Node tests that must spy on a read or hold a lock; real OPFS is covered in Chrome.

The HNSW tests: `crates/ldvec/tests/hnsw.rs` (native: recall floor, determinism, validation, fuzz, with the
integer-only generator in `crates/ldvec/tests/support/synth.rs`), `test/hnsw-wasm.test.ts` (the same
bytes through WebAssembly, SIMD and scalar), `test/ann.behaviour.ts` (the shared suite: memory, the OPFS driver
over the in-memory OPFS, and Chrome on OPFS and IndexedDB), `test/ann-corrupt.test.ts`, `test/ann-quota.test.ts`
and `test/ann.test.ts`. The fixed 10,000 x 384 recall floor (0.95 at m 16, efConstruction 200, ef 100) and the
generator were fixed before the first measurement and are not changed after seeing a number.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): tests first, zero runtime dependencies, the vendored contracts are never
edited here (propose changes in `runtime`, then `npm run sync-contracts`), and `npm run ci` plus
`npm run test:browser` before a pull request. Security issues: `SECURITY.md`, not a public issue.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
