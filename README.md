# localdata

Offline-first browser storage SDK: `set`/`get`/`delete` over OPFS with an IndexedDB fallback, a flat
vector index (`putVectors`/`query`) and a documents API (`putDocument`/`queryChunks`/`deleteDocument`)
persisted beside the values. It implements the Airplane Mode Labs Storage API contract 0.3.0.

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the handles are
reserved; nothing is published yet.

## Status

Sprint 5 (18 Nov 2026): Working: a documents API (putDocument, queryChunks returning chunk text and source page, deleteDocument; all-or-nothing, with clear(ns) removing a document namespace physically), prototype-safe keys and values, size-checked OPFS reads, a sweep of unreferenced records on open, all on OPFS, IndexedDB and memory in Chrome on an Apple M5 Pro with 48 GB (not measured on 8 GB). Not yet: HNSW, quantisation, compaction, encryption at rest, an 8 GB measurement.

alpha = locally built, untagged 0.3.0-alpha.0 (the version moves from 0.2.0-alpha.0 in Sprint 5; the
architect dates the CHANGELOG entry at wrap-up). Sprint 5 added the documents API (Storage API 0.3.0)
for the dockit pipeline: `putDocument` stores a document and its chunks, each with a vector, the chunk
text and its source pages, in one all-or-nothing commit; `queryChunks` returns the nearest chunks with
their text and page range; `deleteDocument` hides a whole document in one commit; and `clear(ns)` removes
a document namespace physically (an application that keeps one namespace per document gets a Delete
that frees the bytes). It also closed S1-100 and S1-101 (a key or a stored value named `__proto__` is now
an ordinary member; stored bytes can no longer set a prototype), S1-092 (the OPFS driver checks a file's
size before it reads it, and an unparseable `keys.json` of a vector or document namespace is `corrupt`)
and T1-S4-08 (records no HEAD references are swept when an index is opened, and counted in
`storage.index.open`). `cargo doc -D warnings` is green for `ldvec` and a `doc` CI job runs it. No HNSW
(Sprint 6, after a note that records the build-or-adopt decision, TD-17).

All timings come from an Apple M5 Pro with 48 GB (see Benchmarks): **not measured on 8 GB**, the owner's
step. Process state: tests-first evidence Done (red and green logs in `evidence/sprint-5/D4/`); local
macOS green in Node and in Chrome on OPFS and IndexedDB; CI at the pushed head 39d59a0 (15 Nov 2026) was green on all three OSes; the Sprint 5 changes are awaiting the owner's
push and no CI run of them has been read. Not published, not tagged; signed artifacts and the release manifest are open (owner key). The live
demo at the Pages URL changes only after the owner pushes; the Sprint 5 demo is proven on a local build
served at `/localdata/`.

## What it does

Offline-first browser storage in one SDK, implementing the Airplane Mode Labs Storage API contract 0.3.0:

- key-value: `set`/`get`/`delete`/`list` over OPFS with an IndexedDB fallback, with TTL and a soft quota;
- a flat vector index: `putVectors`/`query`, exact top-k by cosine or dot product, scanned by Rust
  compiled to WebAssembly (SIMD and scalar builds with bit-identical scores);
- documents (new in 0.3.0): `putDocument`, `getDocument`, `listDocuments`, `deleteDocument` and
  `queryChunks`, which store a document with its chunks (text, page references and a vector each) and
  answer "which chunks, from which pages, are nearest this vector", all behind the same drivers;
- opt-in `storage.*` events that never carry a key, a docId, a title, chunk text, a vector or a score.

Nothing here makes a network request; data stays in the browser's origin storage.

### How it works

- Validation: namespaces match `^[a-z0-9][a-z0-9._-]{0,63}$`; keys are 1..1024 UTF-16 code units
  without U+0000; the prefix `__ld_` is reserved for the SDK (`__ld_meta` accounting, `__ld_vec.<ns>`
  vector indexes, `__ld_doc.<ns>` documents). Errors are `StorageError` instances with a `code` (`not_implemented` (never thrown by
  0.2), `quota_exceeded`, `invalid_key`, `invalid_namespace`, `invalid_value`, `driver_unavailable`, `io`,
  `closed`, `corrupt`) and optional `details`. A vector row's problem is identified by `details.row`, its
  0-based position in the call; no error ever contains a key, a `filterPrefix`, a vector component, a score
  or a value. Documents add `invalid_value` reasons `title`, `sha256`, `bytes`, `pages`, `meta`, `reserved_key`
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
- Events (optional): with `createStore({ events })` the SDK emits the ten names below, source
  `localdata`, shaped by the vendored Event contract 0.1.4. With no sink nothing is built and no clock
  is read.

  | Name                  | Kind   | Level                                   | attrs                                                                                                                                                           | Top level                            |
  | --------------------- | ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
  | `storage.set`         | timing | `debug`; `warn` on a failed set         | `ns`, `driver`, `outcome`: `ok` or a `StorageError` code                                                                                                        | `bytes` (encoded size), `durationMs` |
  | `storage.get`         | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `hit`, `miss`, `expired` or a `StorageError` code                                                                                    | `bytes` on a hit, `durationMs`       |
  | `storage.delete`      | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `removed`, `absent` or a `StorageError` code                                                                                         | `durationMs`                         |
  | `storage.quota`       | log    | `warn` on a refused write; else `debug` | `driver`, `ns` (`''` = all), `usage`, `quota` (number or `null`), `needed`                                                                                      |                                      |
  | `storage.query`       | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`, `k`, `candidates`, `metric`, `kernel` (`simd`, `scalar` or `none`)                                                                   | `durationMs`                         |
  | `storage.index.open`  | timing | `debug`; `warn` on corrupt              | `ns`, `driver`, `outcome` (`ok`, `absent` or a code), `rows`, `segments`, `reason` (`''` or a corrupt reason), `kernel`, `swept` (records deleted by this open) | `bytes`, `durationMs`                |
  | `storage.index.write` | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`, `rows` (live, after the call), `replaced`, `segments` (after the call)                                                               | `bytes`, `durationMs`                |
  | `storage.doc.put`     | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`, `chunks`, `replaced` (boolean), `rows` (live chunk rows after the call)                                                              | `bytes`, `durationMs`                |
  | `storage.doc.delete`  | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `removed`, `absent` or a `StorageError` code                                                                                         | `durationMs`                         |
  | `storage.doc.query`   | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`, `k`, `candidates`, `metric`, `kernel`                                                                                                | `durationMs`                         |

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
  reported as `driver: 'custom'`. Never the query vector, `filterPrefix`, keys, scores or values.

- Drivers only move bytes. OPFS: `airplanemode-localdata/v1/<ns>/<hex sha-256(key)>` holds one
  value per file and `<ns>/keys.json` is the namespace index, written whole with
  `createWritable({ keepExistingData: false })`. IndexedDB: database `airplanemode-localdata`
  version 1, object store `kv` with keyPath `[ns, key]` and an index on `ns`, values stored whole
  as `ArrayBuffer`. Memory: a `Map` of `Map`s, bytes copied in and out. A vector index uses the same drivers
  under the namespace `__ld_vec.<ns>` (documents: `__ld_doc.<ns>`), one record per part. The OPFS driver also
  offers three optional, non-contract hooks the index uses when a driver has them (`refreshIndex(ns)` to see
  another tab's writes, `namespaces()` to total usage, and `getBytesBounded(ns, key, limit)` to refuse a file
  by its size before reading it); the `StorageDriver` contract is unchanged and a custom driver without
  them is single-writer.

### Contracts

Implements Storage API `0.3.0` (draft) from `AirplaneMode-Labs/runtime` `spec/storage-api.ts` (prose, the
normative vector semantics and the normative Documents (0.3.0) section in `spec/storage-api.md`):
`putVectors`, `query`, `indexInfo`, the `corrupt` error, the scoring and ordering rules, and
`putDocument`, `getDocument`, `listDocuments`, `deleteDocument`, `queryChunks` and `redactNamespacePrefix`. The contract is vendored at `src/contracts/storage-api.ts` and
never edited here: `npm run sync-contracts` copies it from the sibling `../runtime/spec` checkout and
`test/contracts-sync.test.ts` fails on drift (and skips when the sibling is absent).

The shape of the `storage.*` events is the Event contract `0.1.4` (wire string
`airplanemode.event/0.1`), vendored at `src/contracts/event.ts` the same way. Both come from spec release
0.5.0 in runtime/spec (committed; public after the owner's push). `sync-contracts` is gated on the spec
release's `SPEC-LANDED.txt` (its lines are `<sha256>  spec/<path>`; the older bare `<path>` form is read
too): every source file must hash (sha256) to its recorded value, otherwise
nothing is copied. The file is looked up in this order: the `SPEC_LANDED` environment variable (an error if it
names a missing file), then the highest-numbered `../evidence/sprint-<n>/D1/SPEC-LANDED.txt`; with neither the script
exits 1 and copies nothing. Events are outside the Storage API contract. This package does not use the
manifest contract; manifest spec v0.1 published in runtime/spec (committed; public after the owner's push).

## Install

Not published yet: the npm scope @airplanemode and the PyPI and crates.io names are not reserved. The commands below were proven from locally built artifacts on macOS arm64 (an npm pack tarball installed offline into a fresh empty directory, a wheel installed into a fresh venv); publishing to the registries is the owner's step. This package is `0.3.0-alpha.0`, not tagged.

### From a locally built tarball

The WebAssembly kernel is built from Rust (`rust-toolchain.toml` pins 1.98 with the
`wasm32-unknown-unknown` target) and embedded in `dist/index.js`, so the tarball has no `.wasm` file and
the library has no runtime dependencies.

```sh
npm ci --ignore-scripts
npm run build:wasm                 # cargo build --release --locked, twice (SIMD and scalar), path-remapped
npm run build                      # dist/index.js + dist/index.d.ts (ESM, ES2022, no source map)
npm pack                           # writes airplanemode-localdata-0.3.0-alpha.0.tgz (git-ignored via *.tgz)
mkdir fresh && cd fresh && npm init -y
npm i ../airplanemode-localdata-0.3.0-alpha.0.tgz --ignore-scripts --offline --no-audit --no-fund
node -e "import('@airplanemode/localdata').then(async m => { const s = await m.createStore({ driver: 'memory' }); await s.putVectors('docs', [{ key: 'a', vector: new Float32Array([1, 0]) }, { key: 'b', vector: new Float32Array([0, 1]) }]); console.log((await s.query('docs', new Float32Array([1, 0.1]), 2)).map(h => h.key)); })"
```

`npm run pack:check` does all of this in a scratch directory with an empty npm cache and fails on any
packaging rule (the embedded modules equal a fresh remapped build, no builder path in the tarball, under
5 MB, LICENSE and NOTICE present), then installs offline into a fresh directory and runs real calls from it: a
key-value round trip, a vector query, and a document put, query, delete and clear. Node 22+ is required for the toolchain; the library itself targets Chrome (OPFS) with an
IndexedDB fallback, and Node only through the `memory` driver.

### After the owner publishes

Not available today; these will work only once the owner has reserved the scope and published:

```sh
npm i @airplanemode/localdata
```

## Usage

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
bytes together). `maxIndexBytes` (default 1 GiB) bounds the vector, META and key bytes of one index, on
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

### Develop

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci` from the committed lockfile needs no flag.

```sh
npm ci --ignore-scripts  # install scripts are disabled (.npmrc ignore-scripts=true; CI passes the flag too)
npm run build:wasm       # the two ldvec modules into src/wasm/ldvec.gen.ts (git-ignored); needs cargo 1.98
npm run ci               # build:wasm, fmt:check, typecheck, vitest (memory driver, corruption, scale), build
cargo test --locked      # the Rust crate: CRC-32C, format validation, scan, 200,000-iteration mutation test
cargo clippy --locked --workspace --all-targets -- -D warnings && cargo fmt --all -- --check
npm run test:browser     # Playwright on installed Chrome (channel "chrome"); builds test/browser/dist
npm run bench:vectors    # writes docs/benchmarks/vector-index.csv (see Benchmarks); then: npm run bench:readme
npm run bench:documents  # writes docs/benchmarks/documents.csv; then: npm run bench:docs-readme
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --locked   # the CI doc job (BUG-T2-S4-22)
npm run demo:build       # bundle the public demo into demo/dist (what .github/workflows/pages.yml deploys)
npm run sync-contracts   # refresh src/contracts (storage-api 0.3.0, event 0.1.4) from ../runtime/spec, sha256-gated
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

## Demo

Live demo: <https://airplanemode-labs.github.io/localdata/>. Built from `main` by
`.github/workflows/pages.yml` on every push; it shows only what works today and has a box titled
"What this demo does not do yet". It runs entirely in the browser: no upload, no analytics, no
third-party scripts or fonts. The live page shows the Sprint 4 build and changes only after the owner pushes
the Sprint 5 commits; the Sprint 5 refresh is proven on a local build of `demo/dist` served at `/localdata/`.

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

## Limitations

- Alpha, not published and not tagged; the tarball install is proven only from a locally built artifact on
  macOS arm64. CI at the pushed head 39d59a0 (15 Nov 2026) was green on all three OSes; the Sprint 5 changes and the new `doc` job await the owner's push, so no Sprint 5 CI
  result is claimed here; the byte-reproducibility of the
  WebAssembly modules across operating systems is proven on macOS only.
- Not measured on 8 GB: every figure above (the vector index and the documents benchmark) is from an Apple M5
  Pro with 48 GB, a development machine, and is not an 8 GB figure. Windows Defender scanning of OPFS and IndexedDB files, memory pressure (tab discard,
  WebAssembly memory growth failing near the 160 MB a 100,000 x 384 index needs) and Windows Chrome eviction
  are unmeasured. The OS file cache cannot be dropped from a page, so cold means cold for the page, not for
  the disk.
- No HNSW: every `query` and every `queryChunks` scores every row (O(rows x dim)). HNSW is Sprint 6 and
  needs the TD-17 build-or-adopt note first; there is no quantisation either (f32 only). A namespace holds
  one vector index of one `dim` and one document index of one `dim`.
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
- A flat index has no defence against poisoning: a document crafted to rank first for many queries will rank first.
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
- `usage()` without a namespace totals the vector indexes and the document indexes of every namespace the
  driver can list (the three built-in drivers can); a custom driver without `namespaces()` contributes only the
  indexes this store opened. `usage().documents` counts live documents; `bytes` includes the document index's
  bytes, dead rows included.
- Storage events are opt-in; localdata has no panel of its own. The runtime's DevTools panel shows them when
  the app passes the runtime's event bus as the sink. The cost of events on a
  large workload has not been measured. This README makes no compliance claim of any kind: nothing here is
  an audit, DPDP, RBI or model-inventory statement.

## Security

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

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): tests first, zero runtime dependencies, the vendored contracts are never
edited here (propose changes in `runtime`, then `npm run sync-contracts`), and `npm run ci` plus
`npm run test:browser` before a pull request. Security issues: `SECURITY.md`, not a public issue.
