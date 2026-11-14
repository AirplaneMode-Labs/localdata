# localdata

Offline-first browser storage SDK: `set`/`get`/`delete`/`query` over OPFS with an IndexedDB fallback,
implementing the Airplane Mode Labs Storage API contract.

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the handles are
reserved; nothing is published yet.

## Status

Alpha skeleton, `0.1.0-dev`, not tagged. Sprint 1 built the key-value surface: `set`, `get`,
`delete`, `list`, `usage`, `clear`, TTL and a soft quota over three drivers (OPFS, IndexedDB,
in-memory), and one shared behavioural suite passes in Node and in Chrome. Sprint 2 added the 13
skipped `query()` cases and the vector-index design note, with no feature change. Sprint 3 added the
packaging proof (a tarball from `npm pack`, installed offline into a fresh directory) and optional
`storage.set`, `storage.get`, `storage.delete` and `storage.quota` events (Event contract 0.1.2)
through an `events` sink, listed live in the demo. The events are opt-in through
`createStore({ events })`; the sink is called synchronously inside try/catch and never awaited, and an
event never carries a key, prefix, value, driver message or stack. `query()` is still a frozen signature that
rejects with `not_implemented` until the vector index lands in Sprint 4, and its 13 test cases stay
skipped. No release has been tagged.

## Install

Not published yet: the npm scope @airplanemode and the PyPI and crates.io names are not reserved. The commands below were proven from locally built artifacts on macOS arm64 (an npm pack tarball installed offline into a fresh empty directory, a wheel installed into a fresh venv); publishing to the registries is the owner's step. This package is `0.1.0-dev`, not tagged.

### From a locally built tarball

```sh
npm ci
npm run build                      # dist/index.js + dist/index.d.ts (ESM, ES2022, no source map)
npm pack                           # writes airplanemode-localdata-0.1.0-dev.tgz (git-ignored via *.tgz)
mkdir fresh && cd fresh && npm init -y
npm i ../airplanemode-localdata-0.1.0-dev.tgz --ignore-scripts --offline --no-audit --no-fund
node -e "import('@airplanemode/localdata').then(async m => { const s = await m.createStore({ driver: 'memory' }); await s.set('docs','k',1); console.log(await s.get('docs','k')); })"
```

`npm run pack:check` does all of this in a scratch directory with an empty npm cache and fails on any
packaging rule (see Develop). The library has no runtime dependencies, so the offline install works.
Node 22+ is required for the toolchain; the library itself targets Chrome (OPFS) with an IndexedDB
fallback, and Node only through the `memory` driver.

### After the owner publishes

Not available today; these will work only once the owner has reserved the scope and published:

```sh
npm i @airplanemode/localdata
```

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

Storage events are opt-in. Pass any `EventSink` (an object with `emit(event)`, such as the runtime's
`EventBus`) and the SDK reports each `set`, `get` and `delete`, and each quota decision:

```ts
import { createStore, type Event } from '@airplanemode/localdata';

const seen: Event[] = [];
const store = await createStore({ driver: 'auto', events: { emit: (e) => seen.push(e) } });
await store.set('docs', 'invoice-42', { pages: 3 });
// seen[0]: name 'storage.set', source 'localdata', attrs { ns: 'docs', driver: 'opfs', outcome: 'ok' },
// bytes (the encoded size) and durationMs. The key 'invoice-42' and the value are not in the event.
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
- Events (optional): with `createStore({ events })` the SDK emits the four names below, source
  `localdata`, shaped by the vendored Event contract 0.1.2. With no sink nothing is built and no clock
  is read.

  | Name             | Kind   | Level                                   | attrs                                                                        | Top level                            |
  | ---------------- | ------ | --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
  | `storage.set`    | timing | `debug`; `warn` on a failed set         | `ns`, `driver`, `outcome`: `ok` or a `StorageError` code                     | `bytes` (encoded size), `durationMs` |
  | `storage.get`    | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `hit`, `miss`, `expired` or a `StorageError` code | `bytes` on a hit, `durationMs`       |
  | `storage.delete` | timing | `debug`; `warn` on a failure            | `ns`, `driver`, `outcome`: `removed`, `absent` or a `StorageError` code      | `durationMs`                         |
  | `storage.quota`  | log    | `warn` on a refused `set`; else `debug` | `driver`, `ns` (`''` = all), `usage`, `quota` (number or `null`), `needed`   |                                      |

  `usage()` emits a `debug` `storage.quota` with `needed: 0`. A `set` the soft quota refuses emits
  `storage.quota` (`warn`) and then `storage.set` with `outcome: 'quota_exceeded'`; `needed` is then
  the exact shortfall (projected total minus `quota`). When the browser refuses a write (a
  `QuotaExceededError`), `quota` is `null` because the browser does not say what its limit is, and
  `needed` is the size of the write, an upper bound for what did not fit. `list`, `clear`, `close`
  and the `query()` stub emit nothing. The sink is called synchronously inside `try`/`catch` and its
  return value is never awaited, so a sink that throws or returns a rejecting promise cannot break a
  storage call; events emitted from inside a sink call on the same store are dropped, so a sink cannot
  recurse into itself. `session` is a random id per page load; pass `eventSession` (1..64 characters,
  never user-derived) to share the runtime's `sessionId()`. A custom driver whose name is not
  `opfs`, `indexeddb` or `memory` is reported as `driver: 'custom'`.

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

The shape of the `storage.*` events is the Event contract `0.1.2` (wire string
`airplanemode.event/0.1`), vendored at `src/contracts/event.ts` the same way. `sync-contracts` is
gated on the spec release's `SPEC-LANDED.txt`: every source file must hash (sha256) to its recorded
value, otherwise nothing is copied. The file is looked up in this order: the `SPEC_LANDED`
environment variable (an error if it names a missing file), then `../evidence/sprint-3/D1/`; with
neither the script exits 1 and copies nothing. Events are outside the Storage API contract, which is unchanged at
`0.1.0`.

## Demo

Live demo: <https://airplanemode-labs.github.io/localdata/>. Built from `main` by
`.github/workflows/pages.yml` on every push; it shows only what works today and has a box titled
"What this demo does not do yet". It runs entirely in the browser: no upload, no analytics, no
third-party scripts or fonts.

The page lets you pick a driver (OPFS, IndexedDB or memory), open a store with an optional SDK soft
quota, `set`/`get`/`delete`/`list` values by namespace and key (JSON, plain strings or a 1 MiB
binary pattern), watch `navigator.storage.estimate()` and `persisted()` live, request `persist()`,
call `query()` to see the `not_implemented` error verbatim, watch the last 50 `storage.*` events the
page's own `EventSink` receives (namespace, driver, outcome, bytes, duration; never a key or a
value), and fill quota with synthetic 4 MiB chunks under the namespace `demo-fill` until the SDK soft
quota or the browser refuses the write. It writes only under localdata's own OPFS directory and IndexedDB database
(`airplanemode-localdata`). `npm run demo:build` produces the same `demo/dist/` the workflow
deploys; nothing built is committed.

## Benchmarks

Produced on the Apple-silicon development machine by `LOCALDATA_BENCH_OUT=<dir> npm run test:browser`
(the two `benchmark:` cases in `test/browser/drivers.spec.ts`) with Chrome 157.0.8103.79, Playwright
channel `chrome`, headless, no `events` sink configured. The Apple-silicon figures below are the
`raw.log` lines stamped `2026-11-14T04:12:18.928Z` (opfs) and `2026-11-14T04:12:19.376Z` (indexeddb)
in `evidence/sprint-3/D4/bench/raw.log`. When `LOCALDATA_BENCH_OUT` is unset the benchmark cases still
run but write nothing. Each `set` includes codec, accounting record rewrite and the driver write.

| Operation          | OPFS, Apple silicon     | IndexedDB, Apple silicon | 8 GB Windows no-GPU laptop |
| ------------------ | ----------------------- | ------------------------ | -------------------------- |
| 1000 x 1 KiB `set` | 2266.7 ms (441.2 ops/s) | 214.9 ms (4653.3 ops/s)  | not measured               |
| 1000 x 1 KiB `get` | 308.1 ms (3245.7 ops/s) | 50.3 ms (19880.7 ops/s)  | not measured               |
| 10 x 5 MiB `set`   | 86.1 ms (580.72 MB/s)   | 49.3 ms (1014.2 MB/s)    | not measured               |
| 10 x 5 MiB `get`   | 27.3 ms (1831.5 MB/s)   | 20 ms (2500 MB/s)        | not measured               |

Small OPFS writes are slower than IndexedDB because every `set` opens and closes two
`FileSystemWritableFileStream`s (the value file and `keys.json`) plus the accounting record; large
values favour OPFS less than expected on this machine. These are single-run placeholder figures from
a development machine, not a claim about the target laptop, and they say nothing about the cost of
turning events on.

## Limitations

- `storage.set`, `storage.get`, `storage.delete` and `storage.quota` events exist but are opt-in through
  `createStore({ events })`; with no sink nothing is emitted. The sink is called synchronously inside
  try/catch and never awaited, so a slow or throwing sink cannot stall or fail a storage call, and an
  event never carries a key, prefix, value, driver message or stack. Storage events reach only the sink you pass. The demo lists them; the Airplane Mode DevTools panel
  does not read localdata directly, it shows what the runtime's event bus holds. Passing the runtime's
  `EventBus` as the sink puts the events in `__airplanemodeDevtools.snapshot()`: checked in Node
  against the built runtime (`evidence/sprint-3/D4/runtime-bus-interop.log`), not in the real DevTools
  panel. The cost of events on a large workload has not been measured. There is no event for `list`,
  `clear` or `close`, and the namespace appears in every event (see Security and privacy).
- Not published and not tagged; the tarball install is proven only from a locally built artifact on macOS arm64.
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

This library makes no network requests and sends no telemetry. It accepts no URLs at all: the only
I/O is to the browser's origin storage (OPFS or IndexedDB) of the page that calls it, or to process
memory with the `memory` driver. `test/browser/drivers.spec.ts` asserts that every request made by the browser harness stays
on its own `127.0.0.1` origin.

Data is stored unencrypted in origin storage and is as private as the origin: any script running on
the same origin can read it. Nothing is persisted outside the browser profile. See `SECURITY.md`
for the disclosure policy.

Event 0.1.2 note: the namespace (attr `ns`) appears in events and in the runtime DevTools snapshot; do
not encode personal data or document identifiers in namespace names. Events are opt-in
(`createStore({ events })`), the sink is called synchronously inside try/catch and never awaited, and
events never carry a key, prefix, value, driver message or stack.

Namespaces appear in events. The namespace (attribute `ns`) is in every `storage.*` event, and in the
runtime's DevTools snapshot when you pass its bus as the sink. Do not encode personal data or document
identifiers in namespace names: use `docs`, not `invoice-for-<customer>`. Keys, prefixes and values
never appear in an event, nor does a driver error message or stack; a namespace that fails validation
is reported as `''`, never as the string you passed. The SDK itself has no network sink: events go to
the sink you provide and nowhere else.

## Develop

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci` from the committed lockfile needs no flag. We revisit this when vitest's peer range is updated.

```sh
npm ci                   # install scripts are disabled (.npmrc ignore-scripts=true)
npm run ci               # fmt:check, typecheck, vitest (memory driver + codec), build
npm run test:browser     # Playwright on installed Chrome (channel "chrome"); builds test/browser/dist
npm run demo:build       # bundle the public demo into demo/dist (what .github/workflows/pages.yml deploys)
npm run sync-contracts   # refresh src/contracts (storage-api 0.1.0, event 0.1.2) from ../runtime/spec, sha256-gated
npm run deps:scripts     # list dev dependencies that declare install scripts
npm run pack:check       # npm pack, tarball rules, offline fresh-directory install, real round trip
npm run pack:check -- --out <dir>   # same, keeping the tarball, the fresh install and pack-check.json in <dir>
```

`pack:check` builds first (a clean checkout works), then works in a new directory under `os.tmpdir()`
(set `TMPDIR` to move it), which it removes on success; nothing in the repository names a scratch
path. `test/browser/install.spec.ts` does the same with its own `mkdtemp` directory and removes only
that. Both spawn `npm` through `npm_execpath` (or `npm.cmd` through a shell on Windows) and do not use
`tar`. `test/portability.test.ts` fails if a sprint scratch path or a home directory is hard-coded
in a public file. The Windows branch of `pack-check` (`npm.cmd` through a shell) runs only on the
owner's `windows-latest` CI read and has not been executed locally.

On Linux CI the browser job checks the runner's preinstalled Google Chrome with `google-chrome
--version` and fails if it is missing (first ran on GitHub on 9 Nov 2026); nothing is installed or
downloaded. Locally the installed Chrome is used. Tests are written before implementation: the
shared behavioural suite lives in `test/storage.behaviour.ts` and runs in Vitest
(`test/memory.test.ts`) and in Chrome (`test/browser/harness.ts`).

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
