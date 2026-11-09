# localdata

Offline-first browser storage SDK: `set`/`get`/`delete`/`query` over OPFS with an IndexedDB fallback,
implementing the Airplane Mode Labs Storage API contract.

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the handles are
reserved; nothing is published yet.

## Install

Not published yet. From a checkout:

```sh
npm ci
npm run build          # dist/index.js + dist/index.d.ts (ESM, ES2022)
```

Then import `./dist/index.js`, or `npm pack` and install the tarball. Node 22+ is required for the
toolchain; the library itself targets Chrome (OPFS) with an IndexedDB fallback.

## Quick start

```ts
import { createStore, StorageError } from '@airplanemode/localdata';

const store = await createStore({ driver: 'auto', quotaBytes: 512 * 1024 * 1024 });

await store.set('docs', 'invoice-42', { pages: 3, scanned: new Date() });
await store.set('docs', 'invoice-42.pdf', new Uint8Array(await file.arrayBuffer()));
await store.set('cache', 'session', 'token', { ttlMs: 60_000 });

const meta = await store.get<{ pages: number; scanned: Date }>('docs', 'invoice-42');
const { keys, cursor } = await store.list('docs', { prefix: 'invoice-', limit: 100 });
const { bytes, items, quotaBytes } = await store.usage('docs');

try {
  await store.query('docs', new Float32Array(384), 10);
} catch (e) {
  if (e instanceof StorageError && e.code === 'not_implemented') {
    // vector search arrives in Sprint 4
  }
}

await store.close();
```

`driver` may be `'auto'` (OPFS when `navigator.storage.getDirectory` exists, otherwise IndexedDB,
otherwise `driver_unavailable`), `'opfs'`, `'indexeddb'`, `'memory'`, or any object implementing
`StorageDriver`. `clock` (epoch milliseconds) is injectable for TTL tests.

## How it works

- Validation: namespaces match `^[a-z0-9][a-z0-9._-]{0,63}$`; keys are 1..1024 UTF-16 code units
  without U+0000; the namespace `__ld_meta` is reserved. Errors are `StorageError` instances with a
  `code` (`not_implemented`, `quota_exceeded`, `invalid_key`, `invalid_namespace`, `invalid_value`,
  `driver_unavailable`, `io`, `closed`) and optional `details`.
- Codec: every value becomes one `LD1` envelope: magic `LD1`, a flags byte, a little-endian u32 JSON
  length, the JSON tree, then a binary section. `ArrayBuffer`, every typed array and `Blob` (with its
  MIME type) are hoisted out of the tree as `{ "$ld": kind, "i", "o", "n" }` leaves and stored
  byte-exact; `Date` becomes `{ "$ld": "date" }`; `NaN`, `Infinity`, `-Infinity` and `-0` become
  `{ "$ld": "num" }`; a plain object that owns a `$ld` key is escaped as `{ "$ld": "obj", "o": ... }`.
  Functions, symbols, `Map`, `Set`, class instances, `undefined`, `bigint`, `DataView`, sparse
  arrays and circular references are rejected with `invalid_value` before anything is written.
- Accounting and quota: the SDK keeps a per-namespace record (key, size, expiry) under the reserved
  namespace `__ld_meta`, rewritten after every mutation, and rebuilds it from the driver if the
  record is missing or corrupt. When `quotaBytes` is configured, a `set` that would push the total
  above it throws `quota_exceeded` before the driver is touched; the browser's own
  `QuotaExceededError` maps to the same code.
- TTL: `set(..., { ttlMs })` stores an expiry; an expired `get` returns `undefined` and deletes the
  row lazily; `list` hides expired keys.
- Drivers only move bytes. OPFS: `airplanemode-localdata/v1/<ns>/<hex sha-256(key)>` holds one
  value per file and `<ns>/keys.json` is the namespace index, written whole with
  `createWritable({ keepExistingData: false })`. IndexedDB: database `airplanemode-localdata`
  version 1, object store `kv` with keyPath `[ns, key]` and an index on `ns`, values stored whole
  as `ArrayBuffer`. Memory: a `Map` of `Map`s, bytes copied in and out.

## Contracts

Implements Storage API `0.1.0` from `AirplaneMode-Labs/runtime` `spec/storage-api.ts` (prose in
`spec/storage-api.md`). The contract is vendored at `src/contracts/storage-api.ts` and never edited
here: `npm run sync-contracts` copies it from the sibling `../runtime/spec` checkout and
`test/contracts-sync.test.ts` fails on drift (and skips when the sibling is absent).

## Demo

Live demo: <https://airplanemode-labs.github.io/localdata/>. Built from `main` by
`.github/workflows/pages.yml` on every push; it shows only what works today and has a box titled
"What this demo does not do yet". It runs entirely in the browser: no upload, no analytics, no
third-party scripts or fonts.

The page lets you pick a driver (OPFS, IndexedDB or memory), open a store with an optional SDK soft
quota, `set`/`get`/`delete`/`list` values by namespace and key (JSON, plain strings or a 1 MiB
binary pattern), watch `navigator.storage.estimate()` and `persisted()` live, request `persist()`,
call `query()` to see the `not_implemented` error verbatim, and fill quota with synthetic 4 MiB
chunks under the namespace `demo-fill` until the SDK soft quota or the browser refuses the write.
It writes only under localdata's own OPFS directory and IndexedDB database
(`airplanemode-localdata`). `npm run demo:build` produces the same `demo/dist/` the workflow
deploys; nothing built is committed.

## Status

Alpha skeleton (Sprint 1, `0.1.0-dev`; Sprint 2 added only the skipped `query()` test suite and the design note, no feature change). The key-value surface works against three drivers (OPFS,
IndexedDB, in-memory) and passes one shared behavioural suite in Node and in Chrome. `query()` is a
frozen signature that rejects with `not_implemented` until the vector index lands in Sprint 4. No
release has been tagged.

## Benchmarks

Produced on the development machine by
`LOCALDATA_BENCH_OUT=evidence/sprint-1/D4/bench npm run test:browser` (the two
`benchmark:` cases in `test/browser/drivers.spec.ts`) with Chrome 157.0.8103.38, Playwright channel
`chrome`, headless. The figures below are the `raw.log` lines stamped `2026-11-09T04:20:16.078Z`
(opfs) and `2026-11-09T04:20:16.527Z` (indexeddb) in `evidence/sprint-1/D4/bench/raw.log`;
later runs appended to the same log are not quoted here. When
`LOCALDATA_BENCH_OUT` is unset the benchmark cases still run but write nothing. Each `set` includes
codec, accounting record rewrite and the driver write.

| Operation                      | OPFS                    | IndexedDB               | Machine                                                                                     |
| ------------------------------ | ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| 1000 x 1 KiB `set`             | 2245.6 ms (445.3 ops/s) | 226.7 ms (4411.1 ops/s) | Apple-silicon development machine, placeholder; 8 GB Windows no-GPU laptop not yet measured |
| 1000 x 1 KiB `get`             | 305.6 ms (3272.3 ops/s) | 46.8 ms (21367.5 ops/s) | Apple-silicon development machine, placeholder; 8 GB Windows no-GPU laptop not yet measured |
| 10 x 5 MiB `set`               | 81.7 ms (612 MB/s)      | 38.9 ms (1285.35 MB/s)  | Apple-silicon development machine, placeholder; 8 GB Windows no-GPU laptop not yet measured |
| 10 x 5 MiB `get`               | 24.3 ms (2057.61 MB/s)  | 15.3 ms (3267.97 MB/s)  | Apple-silicon development machine, placeholder; 8 GB Windows no-GPU laptop not yet measured |
| 8 GB Windows laptop, Wi-Fi off | not measured            | not measured            | not measured                                                                                |

Small OPFS writes are slower than IndexedDB because every `set` opens and closes two
`FileSystemWritableFileStream`s (the value file and `keys.json`) plus the accounting record; large
values favour OPFS less than expected on this machine. These are single-run placeholder figures, not
a claim about the target laptop.

## Limitations

- `query()` is not implemented until Sprint 4; there is no vector index. The call rejects with
  `StorageError` code `not_implemented`. The flat-index and HNSW design, the OPFS layout and the
  under-2-second cold-load target (not measured) are in [docs/vector-index.md](docs/vector-index.md);
  its 13 query test cases are written and skipped until Sprint 4.
- OPFS requires Chrome (or another Chromium with the File System Access origin private file system)
  and a secure context (`https:` or `127.0.0.1`/`localhost`). Firefox and Safari are untested.
- The IndexedDB fallback stores whole values, not chunks; a value is held in memory in full during
  `set` and `get`.
- No cross-tab locking. Two tabs writing the same namespace can leave the accounting record stale
  until the next `get` repairs the row it touched. The accounting record is rewritten in full on
  every mutation, so namespaces with very many keys pay a growing per-write cost.
- Values larger than 256 MiB are untested.
- No encryption at rest. Data lives in the origin's OPFS or IndexedDB in clear text, visible to any
  script on the same origin.
- `usage()` reports the encoded value sizes the SDK wrote, not the bytes the browser attributes to
  the origin (`navigator.storage.estimate()`); the two differ by filesystem overhead.
- The driver-level `usage()` of the IndexedDB driver walks a cursor over the records.
- Node is supported only through the `memory` driver (used by the unit tests).

## Security and privacy

This library makes no network requests other than the asset and manifest URLs you pass it, and sends no telemetry.
In fact it accepts no URLs at all: the only I/O is to the browser's origin
storage (OPFS or IndexedDB) of the page that calls it, or to process memory with the `memory`
driver. `test/browser/drivers.spec.ts` asserts that every request made by the browser harness stays
on its own `127.0.0.1` origin.

Data is stored unencrypted in origin storage and is as private as the origin: any script running on
the same origin can read it. Nothing is persisted outside the browser profile. See `SECURITY.md`
for the disclosure policy.

## Develop

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci` from the committed lockfile needs no flag. We revisit this when vitest's peer range is updated.

```sh
npm ci                   # install scripts are disabled (.npmrc ignore-scripts=true)
npm run ci               # fmt:check, typecheck, vitest (memory driver + codec), build
npm run test:browser     # Playwright on installed Chrome (channel "chrome"); builds test/browser/dist
npm run demo:build       # bundle the public demo into demo/dist (what .github/workflows/pages.yml deploys)
npm run sync-contracts   # refresh src/contracts from ../runtime/spec
npm run deps:scripts     # list dev dependencies that declare install scripts
npm pack --dry-run       # dist, LICENSE, NOTICE, README.md, package.json
```

On Linux CI the browser job checks the runner's preinstalled Google Chrome with `google-chrome
--version` and fails if it is missing (first ran on GitHub on 9 Nov 2026); nothing is installed or
downloaded. Locally the installed Chrome is used. Tests are written before implementation: the
shared behavioural suite lives in `test/storage.behaviour.ts` and runs in Vitest
(`test/memory.test.ts`) and in Chrome (`test/browser/harness.ts`).

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
