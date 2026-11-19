// Browser harness bundled by test/browser/serve.mjs. It exposes window.__localdata so the
// Playwright spec can run the shared behavioural suite against the OPFS and IndexedDB drivers,
// check persistence across reload, and measure write throughput. No network access.
import {
  createStore,
  IndexedDbDriver,
  OpfsDriver,
  STORAGE_EVENT_NAMES,
  STORAGE_ROOT,
  type Event,
  type LocalData,
  type StorageApi,
  type StorageDriver,
} from '../../src/index';
import { f32Bits, topKRef, type RefRow } from '../../src/vec/reference';
import {
  ClusteredStream,
  DIM,
  clusteredCentres,
  clusteredPoints,
  clusteredSet,
  synthKey,
  synthQuery,
  synthRow,
  synthRows,
  synthValue,
  synthVector,
} from '../../bench/synth';
import { collectSuite, type MakeStoreOptions, type SuiteResult } from '../storage.behaviour';
import { queryCases } from '../query.behaviour';
import { collectVectorSuite, type VectorEnv, type VectorSuiteResult } from '../vector.behaviour';
import { protoCases } from '../proto.behaviour';
import {
  documentCases,
  makeChunks,
  docInput,
  refQueryChunks,
  type RefChunk,
} from '../documents.behaviour';
import { collectPersistCases, type PersistEnv, type PersistResult } from '../persist-env';
import { annCases, type AnnEnv } from '../ann.behaviour';

type DriverName = 'opfs' | 'indexeddb';

interface BenchRow {
  n: number;
  bytesEach: number;
  ms: number;
  opsPerSec: number;
  mbPerSec: number;
}

export interface BenchResult {
  driver: DriverName;
  set1k: BenchRow;
  get1k: BenchRow;
  set5m: BenchRow;
  get5m: BenchRow;
}

function log(line: string): void {
  const el = document.getElementById('log');
  if (el) el.textContent += `${line}\n`;
}

async function reset(driver: DriverName): Promise<void> {
  if (driver === 'opfs') {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(STORAGE_ROOT, { recursive: true });
    } catch (e) {
      if ((e as { name?: string }).name !== 'NotFoundError') throw e;
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase(STORAGE_ROOT);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error ?? new Error('deleteDatabase failed'));
    r.onblocked = () => log('indexedDB.deleteDatabase blocked; waiting for connections to close');
  });
}

function makeStoreFor(driver: DriverName) {
  return async (opts?: MakeStoreOptions): Promise<StorageApi> => {
    await reset(driver);
    return createStore({ driver, ...(opts ?? {}) });
  };
}

async function runSuite(driver: DriverName): Promise<SuiteResult[]> {
  log(`suite: ${driver}`);
  const results = await collectSuite(makeStoreFor(driver));
  for (const r of results)
    log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` -- ${r.error}` : ''}`);
  return results;
}

const PERSIST_NS = 'persist';

function fixtureBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function persistWrite(driver: DriverName): Promise<void> {
  await reset(driver);
  const store = await createStore({ driver });
  await store.set(PERSIST_NS, 'text', 'survives reload');
  await store.set(PERSIST_NS, 'bytes', fixtureBytes(4096));
  await store.set(PERSIST_NS, 'date', new Date(Date.UTC(2026, 10, 9)));
  await store.set(PERSIST_NS, 'nested', { a: [1, NaN, -0], b: { c: null } });
  await store.set(PERSIST_NS, 'blob', new Blob([fixtureBytes(100)], { type: 'text/plain' }));
  await store.close();
}

async function persistCheck(
  driver: DriverName,
): Promise<{ ok: boolean; problems: string[]; items: number }> {
  const store = await createStore({ driver });
  const problems: string[] = [];
  try {
    if ((await store.get(PERSIST_NS, 'text')) !== 'survives reload') problems.push('text');
    const bytes = (await store.get(PERSIST_NS, 'bytes')) as Uint8Array | undefined;
    const expected = fixtureBytes(4096);
    if (!(bytes instanceof Uint8Array) || bytes.length !== expected.length)
      problems.push('bytes length');
    else
      for (let i = 0; i < bytes.length; i++)
        if (bytes[i] !== expected[i]) {
          problems.push(`bytes[${i}]`);
          break;
        }
    const date = (await store.get(PERSIST_NS, 'date')) as Date | undefined;
    if (!(date instanceof Date) || date.getTime() !== Date.UTC(2026, 10, 9)) problems.push('date');
    const nested = (await store.get(PERSIST_NS, 'nested')) as
      { a: number[]; b: { c: null } } | undefined;
    if (
      !nested ||
      nested.a[0] !== 1 ||
      !Number.isNaN(nested.a[1]) ||
      !Object.is(nested.a[2], -0) ||
      nested.b.c !== null
    ) {
      problems.push('nested');
    }
    const blob = (await store.get(PERSIST_NS, 'blob')) as Blob | undefined;
    if (!(blob instanceof Blob) || blob.type !== 'text/plain' || blob.size !== 100)
      problems.push('blob');
    const usage = await store.usage(PERSIST_NS);
    if (usage.items !== 5) problems.push(`usage.items=${usage.items}`);
    const listed = await store.list(PERSIST_NS);
    if (listed.keys.join(',') !== 'blob,bytes,date,nested,text')
      problems.push(`list=${listed.keys.join(',')}`);
    return { ok: problems.length === 0, problems, items: usage.items };
  } finally {
    await store.close();
  }
}

function row(n: number, bytesEach: number, ms: number): BenchRow {
  return {
    n,
    bytesEach,
    ms: Math.round(ms * 100) / 100,
    opsPerSec: Math.round((n / ms) * 1000 * 10) / 10,
    mbPerSec: Math.round(((n * bytesEach) / (1024 * 1024) / ms) * 1000 * 100) / 100,
  };
}

async function bench(driver: DriverName): Promise<BenchResult> {
  await reset(driver);
  const store = await createStore({ driver });
  try {
    const small = fixtureBytes(1024);
    const big = fixtureBytes(5 * 1024 * 1024);
    let t0 = performance.now();
    for (let i = 0; i < 1000; i++) await store.set('bench-small', `k${i}`, small);
    const set1k = row(1000, 1024, performance.now() - t0);
    t0 = performance.now();
    for (let i = 0; i < 1000; i++) await store.get('bench-small', `k${i}`);
    const get1k = row(1000, 1024, performance.now() - t0);
    t0 = performance.now();
    for (let i = 0; i < 10; i++) await store.set('bench-big', `k${i}`, big);
    const set5m = row(10, big.byteLength, performance.now() - t0);
    t0 = performance.now();
    for (let i = 0; i < 10; i++) await store.get('bench-big', `k${i}`);
    const get5m = row(10, big.byteLength, performance.now() - t0);
    const result: BenchResult = { driver, set1k, get1k, set5m, get5m };
    log(`bench ${driver}: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await store.close();
    await reset(driver);
  }
}

const EVENT_SENTINELS = ['SENTINEL-KEY-4e8b', 'SENTINEL-VALUE-91d0'];

/** Runs set, get (hit, miss), delete (removed, absent) and a soft-quota refusal with an EventSink. */
async function runEvents(driver: DriverName): Promise<{
  names: string[];
  outcomes: Array<string | undefined>;
  drivers: Array<string | undefined>;
  problems: string[];
  leaked: string[];
  sinkThrewButStoreWorked: boolean;
}> {
  await reset(driver);
  const events: Event[] = [];
  const store = await createStore({
    driver,
    quotaBytes: 2048,
    events: { emit: (e) => void events.push(e) },
  });
  const [key, value] = EVENT_SENTINELS as [string, string];
  try {
    await store.set('events', key, { v: value });
    await store.get('events', key);
    await store.get('events', `${key}-missing`);
    await store.delete('events', key);
    await store.delete('events', key);
    try {
      await store.set('events', 'big', new Uint8Array(4096));
    } catch {
      // expected: quota_exceeded
    }
  } finally {
    await store.close();
  }
  const problems: string[] = [];
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const e of events) {
    if (e.spec !== 'airplanemode.event/0.1') problems.push(`${e.name}: spec`);
    if (!UUID_V4.test(e.id)) problems.push(`${e.name}: id`);
    if (e.source !== 'localdata') problems.push(`${e.name}: source`);
    if (!Number.isInteger(e.ts)) problems.push(`${e.name}: ts`);
    if (typeof e.session !== 'string' || e.session.length < 1 || e.session.length > 64)
      problems.push(`${e.name}: session`);
    if (!(STORAGE_EVENT_NAMES as readonly string[]).includes(e.name))
      problems.push(`${e.name}: name`);
    if (e.name !== 'storage.quota' && !(typeof e.durationMs === 'number' && e.durationMs >= 0))
      problems.push(`${e.name}: durationMs`);
    for (const [k, v] of Object.entries(e.attrs))
      if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null))
        problems.push(`${e.name}: attr ${k}`);
  }
  const wire = JSON.stringify(events);
  const leaked = EVENT_SENTINELS.filter((s) => wire.includes(s));
  // A sink that throws must not break the store.
  const bad = await createStore({
    driver: 'memory',
    events: {
      emit: () => {
        throw new Error('sink exploded');
      },
    },
  });
  await bad.set('events', 'k', 1);
  const sinkThrewButStoreWorked = (await bad.get('events', 'k')) === 1;
  await bad.close();
  await reset(driver);
  return {
    names: events.map((e) => e.name),
    outcomes: events.map((e) => e.attrs['outcome'] as string | undefined),
    drivers: events.map((e) => e.attrs['driver'] as string | undefined),
    problems,
    leaked,
    sinkThrewButStoreWorked,
  };
}

// ---- vector index ----------------------------------------------------------------------------------

function vectorEnvFor(driver: DriverName): VectorEnv {
  return {
    makeStore: async (opts) => {
      await reset(driver);
      return createStore({ driver, ...(opts ?? {}) });
    },
    reopen: async (opts) => createStore({ driver, ...(opts ?? {}) }),
    raw: async (): Promise<StorageDriver> => {
      const d = driver === 'opfs' ? new OpfsDriver() : new IndexedDbDriver();
      await d.open();
      return d;
    },
  };
}

async function runVectorSuite(driver: DriverName): Promise<VectorSuiteResult[]> {
  log(`vector suite: ${driver}`);
  const results = await collectVectorSuite(vectorEnvFor(driver));
  for (const r of results)
    log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` -- ${r.error}` : ''}`);
  return results;
}

// ---- HNSW (Storage API 0.4.0) ------------------------------------------------------------------------

function annEnvFor(driver: DriverName): AnnEnv {
  return {
    makeStore: async (opts) => {
      await reset(driver);
      const { wrap: _wrap, ...rest } = opts ?? {};
      return createStore({ driver, ...rest });
    },
    reopen: async (opts) => {
      const { wrap: _wrap, ...rest } = opts ?? {};
      return createStore({ driver, ...rest });
    },
    raw: async (): Promise<StorageDriver> => {
      const d = driver === 'opfs' ? new OpfsDriver() : new IndexedDbDriver();
      await d.open();
      return d;
    },
  };
}

interface AnnSuiteResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

async function runAnnSuite(driver: DriverName): Promise<AnnSuiteResult[]> {
  log(`hnsw suite: ${driver}`);
  const env = annEnvFor(driver);
  const out: AnnSuiteResult[] = [];
  for (const c of annCases) {
    const t0 = performance.now();
    try {
      await c.run(env);
      out.push({ name: c.name, ok: true, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      out.push({
        name: c.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ms: Math.round(performance.now() - t0),
      });
    }
    const r = out[out.length - 1]!;
    log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` -- ${r.error}` : ''}`);
  }
  return out;
}

const ANN_SMOKE = { ns: 'annsmoke', seed: 31, centres: 12, dim: 64 };

/** Browser smoke, step 1: writes rows, builds the graph, queries it, and returns what it answered. */
async function annPersistWrite(driver: DriverName, rows: number) {
  await reset(driver);
  const set = clusteredSet(ANN_SMOKE.seed, ANN_SMOKE.centres, ANN_SMOKE.dim, rows, 8);
  const store = await createStore({ driver });
  try {
    await store.putVectors(
      ANN_SMOKE.ns,
      (function* () {
        for (let i = 0; i < rows; i++)
          yield {
            key: `a${i}`,
            vector: set.rows.slice(i * ANN_SMOKE.dim, (i + 1) * ANN_SMOKE.dim),
          };
      })(),
    );
    const built = await store.buildIndex(ANN_SMOKE.ns, { kind: 'hnsw', m: 12, efConstruction: 80 });
    const q = set.queries.slice(0, ANN_SMOKE.dim);
    const hits = await store.query(ANN_SMOKE.ns, q, 10, { index: 'hnsw', ef: 64, values: false });
    const flat = await store.query(ANN_SMOKE.ns, q, 10, { values: false });
    return {
      built,
      hnsw: hits.map((h) => h.key),
      flat: flat.map((h) => h.key),
      bits: hits.map((h) => Array.from(new Uint32Array(new Float32Array([h.score]).buffer))[0]!),
    };
  } finally {
    await store.close();
  }
}

/** Browser smoke, step 2 (after reload or relaunch): the same query from the stored graph. */
async function annPersistCheck(driver: DriverName, rows: number) {
  const set = clusteredSet(ANN_SMOKE.seed, ANN_SMOKE.centres, ANN_SMOKE.dim, rows, 8);
  const events: Event[] = [];
  const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
  try {
    const t0 = performance.now();
    const info = await store.indexInfo(ANN_SMOKE.ns);
    const q = set.queries.slice(0, ANN_SMOKE.dim);
    const hits = await store.query(ANN_SMOKE.ns, q, 10, { index: 'hnsw', ef: 64, values: false });
    const coldMs = Math.round((performance.now() - t0) * 100) / 100;
    const last = events.filter((e) => e.name === 'storage.query').pop();
    return {
      info,
      hnsw: hits.map((h) => h.key),
      bits: hits.map((h) => Array.from(new Uint32Array(new Float32Array([h.score]).buffer))[0]!),
      answeredBy: last?.attrs['index'] ?? null,
      fallback: last?.attrs['fallback'] ?? null,
      rebuilds: events.filter(
        (e) => e.name === 'storage.index.build' && e.attrs['reason'] === 'rebuild',
      ).length,
      coldMs,
    };
  } finally {
    await store.close();
  }
}

// ---- HNSW benchmark (bench/ann-bench.spec.ts, docs/benchmarks/ann.csv) -----------------------------------

interface AnnBenchData {
  data: 'clustered' | 'uniform';
  rows: number;
  dim: number;
  centres: number;
  seed: number;
}
const ANN_BENCH_NS = 'annbench';

/** The rows of a benchmark set, one at a time: nothing is held beyond the row being yielded. */
function annBenchRows(d: AnnBenchData): Generator<{ key: string; vector: Float32Array }> {
  return (function* () {
    if (d.data === 'uniform') {
      for (let i = 0; i < d.rows; i++) yield { key: synthKey(i), vector: synthVector(i, d.dim) };
      return;
    }
    const stream = new ClusteredStream(
      clusteredCentres(d.seed, d.centres, d.dim),
      d.dim,
      d.seed,
      'data',
    );
    for (let i = 0; i < d.rows; i++) {
      const vector = new Float32Array(d.dim);
      stream.nextInto(vector);
      yield { key: synthKey(i), vector };
    }
  })();
}

function annBenchQueries(d: AnnBenchData, count: number): Float32Array[] {
  if (d.data === 'uniform') return Array.from({ length: count }, (_, j) => synthQuery(j, d.dim));
  const flat = clusteredPoints(
    clusteredCentres(d.seed, d.centres, d.dim),
    d.dim,
    d.seed,
    'query',
    count,
  );
  return Array.from({ length: count }, (_, j) => flat.slice(j * d.dim, (j + 1) * d.dim));
}

/** Step 1 of a run: writes the flat index (timed), then builds the graph (timed). Closes the store. */
async function annBenchBuild(
  driver: DriverName,
  d: AnnBenchData,
  hnsw: { m: number; efConstruction: number; seed: number },
  maxIndexBytes: number,
) {
  await reset(driver);
  const store = await createStore({ driver, maxIndexBytes });
  try {
    let t0 = performance.now();
    await store.putVectors(ANN_BENCH_NS, annBenchRows(d));
    const flatWriteMs = performance.now() - t0;
    t0 = performance.now();
    const built = await store.buildIndex(ANN_BENCH_NS, { kind: 'hnsw', ...hnsw });
    const buildMs = performance.now() - t0;
    return { flatWriteMs, buildMs, graphBytes: built.bytes, nodes: built.rows };
  } finally {
    await store.close();
  }
}

/** Step 2, in a fresh page: the cold open and the query latencies of one index kind. */
async function annBenchCold(
  driver: DriverName,
  d: AnnBenchData,
  kind: 'flat' | 'hnsw',
  efs: number[],
  queries: number,
  maxIndexBytes: number,
) {
  const mem = (performance as unknown as HeapMemory).memory;
  const heap = { peak: mem?.usedJSHeapSize ?? 0 };
  const sample = () => {
    const m = (performance as unknown as HeapMemory).memory?.usedJSHeapSize ?? 0;
    if (m > heap.peak) heap.peak = m;
  };
  const timer = setInterval(sample, 10);
  // The sink only counts which index answered: a graph query that fell back to the flat scan would be a
  // wrong benchmark row, so the spec refuses any fallback.
  const answered = { hnsw: 0, flat: 0, fallbacks: 0 };
  const events = {
    emit: (e: Event) => {
      if (e.name !== 'storage.query') return;
      if (e.attrs['index'] === 'hnsw') answered.hnsw++;
      else answered.flat++;
      if (e.attrs['fallback'] !== '') answered.fallbacks++;
    },
  };
  const qs = annBenchQueries(d, queries);
  const t0 = performance.now();
  const store = await createStore({ driver, maxIndexBytes, events });
  const first =
    kind === 'flat'
      ? await store.query(ANN_BENCH_NS, qs[0]!, 10, { values: false })
      : await store.query(ANN_BENCH_NS, qs[0]!, 10, { values: false, index: 'hnsw', ef: efs[0]! });
  const coldOpenMs = performance.now() - t0;
  sample();
  const percentile = (lat: number[], q: number) => {
    const sorted = [...lat].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  };
  const run = async (ef: number | null) => {
    const lat: number[] = [];
    const keys: string[][] = [];
    for (const q of qs) {
      const a = performance.now();
      const hits =
        ef === null
          ? await store.query(ANN_BENCH_NS, q, 10, { values: false })
          : await store.query(ANN_BENCH_NS, q, 10, { values: false, index: 'hnsw', ef });
      lat.push(performance.now() - a);
      keys.push(hits.map((h) => h.key));
      sample();
    }
    return { lat, keys };
  };
  const variants: Array<{ ef: number | null; p50: number; p95: number; recall: number }> = [];
  if (kind === 'hnsw') {
    const results: Array<{ ef: number; lat: number[]; keys: string[][] }> = [];
    for (const ef of efs) results.push({ ef, ...(await run(ef)) });
    // Ground truth: the flat scan of the same store, outside the timings above.
    const truth = (await run(null)).keys;
    for (const r of results) {
      let sum = 0;
      for (let i = 0; i < r.keys.length; i++)
        sum +=
          r.keys[i]!.filter((k) => truth[i]!.includes(k)).length / Math.max(1, truth[i]!.length);
      variants.push({
        ef: r.ef,
        p50: percentile(r.lat, 0.5),
        p95: percentile(r.lat, 0.95),
        recall: sum / r.keys.length,
      });
    }
  } else {
    const r = await run(null);
    variants.push({
      ef: null,
      p50: percentile(r.lat, 0.5),
      p95: percentile(r.lat, 0.95),
      recall: 1,
    });
  }
  // Memory is read BEFORE indexInfo: indexInfo loads the graph to report it, which would put the graph into
  // a flat run's WebAssembly memory and heap sample.
  const wasm = store.vectorWasmBytes();
  sample();
  clearInterval(timer);
  const info = await store.indexInfo(ANN_BENCH_NS);
  const usage = await store.usage(ANN_BENCH_NS);
  const kernel = info?.kernel ?? '';
  await store.close();
  return {
    kernel,
    coldOpenMs,
    firstHits: first.length,
    variants,
    answered,
    jsHeapPeak: heap.peak,
    wasmBytes: wasm,
    indexBytes: info?.bytes ?? 0,
    annBytes: info?.ann?.bytes ?? 0,
    annCurrent: info?.ann?.current ?? false,
    annNodes: info?.ann?.nodes ?? 0,
    liveRows: info?.rows ?? 0,
    storageUsage: usage.bytes,
    precise: mem !== undefined,
  };
}

function persistEnvFor(driver: DriverName): PersistEnv {
  return {
    makeStore: async (opts) => {
      await reset(driver);
      return createStore({ driver, ...(opts ?? {}) });
    },
    reopen: async (opts) => createStore({ driver, ...(opts ?? {}) }),
    raw: async (): Promise<StorageDriver> => {
      const d = driver === 'opfs' ? new OpfsDriver() : new IndexedDbDriver();
      await d.open();
      return d;
    },
  };
}

/** S1-100 and S1-101 (prototype-safe keys and values) against a real driver, each across a reopen. */
async function runProtoCases(driver: DriverName): Promise<PersistResult[]> {
  log(`proto cases: ${driver}`);
  const results = await collectPersistCases(protoCases, persistEnvFor(driver));
  for (const r of results)
    log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` -- ${r.error}` : ''}`);
  return results;
}

/** The 13 query() cases of Sprint 2, now live, against a real driver. */
async function runQueryCases(driver: DriverName): Promise<SuiteResult[]> {
  const make = makeStoreFor(driver);
  const out: SuiteResult[] = [];
  for (const c of queryCases) {
    const t0 = performance.now();
    try {
      await c.run(make);
      out.push({ name: c.name, ok: true, ms: performance.now() - t0 });
    } catch (e) {
      out.push({
        name: c.name,
        ok: false,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        ms: performance.now() - t0,
      });
    }
  }
  return out;
}

const VEC_NS = 'vecpersist';
const CHUNK = 128;

function refRowsOf(ranges: ReadonlyArray<readonly [number, number]>): RefRow[] {
  const rows: RefRow[] = [];
  for (const [from, count] of ranges)
    for (let i = from; i < from + count; i++)
      rows.push({ key: synthKey(i), vector: synthVector(i) });
  return rows;
}

interface HitsView {
  keys: string[];
  bits: number[];
}

function viewOf(hits: Array<{ key: string; score: number }>): HitsView {
  return { keys: hits.map((h) => h.key), bits: hits.map((h) => f32Bits(h.score)) };
}

/** Writes `rows` synthetic rows (dim 384, 128-byte chunks) into a fresh index and returns its hits. */
async function vecPersistWrite(driver: DriverName, rows: number) {
  await reset(driver);
  const store = await createStore({ driver });
  const t0 = performance.now();
  await store.putVectors(VEC_NS, synthRows(0, rows, { chunkBytes: CHUNK }));
  const writeMs = performance.now() - t0;
  const hits = await store.query(VEC_NS, synthQuery(0), 10);
  const info = await store.indexInfo(VEC_NS);
  await store.close();
  return { writeMs, hits: viewOf(hits), info };
}

/** Opens the store as a reload or a relaunch would: no reset, cold, then checks the answer. */
async function vecPersistCheck(driver: DriverName, rows: number) {
  const t0 = performance.now();
  const store = await createStore({ driver });
  const hits = await store.query(VEC_NS, synthQuery(0), 10);
  const coldMs = performance.now() - t0;
  const info = await store.indexInfo(VEC_NS);
  const want = viewOf(topKRef(refRowsOf([[0, rows]]), synthQuery(0), 10, 'cosine'));
  const got = viewOf(hits);
  const values = hits.every((h) => typeof h.value === 'string' && h.value.length === CHUNK);
  await store.close();
  return {
    coldMs,
    info,
    match: JSON.stringify(got) === JSON.stringify(want),
    values,
    kernel: info?.kernel,
  };
}

/** No index at all (a fresh profile): query resolves [], indexInfo is undefined, nothing is corrupt. */
async function vecFreshProfileCheck(driver: DriverName) {
  const store = await createStore({ driver });
  try {
    const hits = await store.query(VEC_NS, synthQuery(0), 10);
    return { hits: hits.length, info: (await store.indexInfo(VEC_NS)) ?? null };
  } finally {
    await store.close();
  }
}

interface WriterPlan {
  ns: string;
  from: number;
  count: number;
  batch: number;
}

/** One page's share of a multi-writer run: its own store, batches interleaved across its plan. */
async function vecWriterRun(driver: DriverName, plan: WriterPlan[]) {
  const store = await createStore({ driver });
  const errors: string[] = [];
  let written = 0;
  try {
    const cursors = plan.map((p) => p.from);
    let live = true;
    while (live) {
      live = false;
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i]!;
        if (cursors[i]! >= p.from + p.count) continue;
        live = true;
        const n = Math.min(p.batch, p.from + p.count - cursors[i]!);
        try {
          const r = await store.putVectors(p.ns, synthRows(cursors[i]!, n, { chunkBytes: 32 }));
          written += r.written;
        } catch (e) {
          errors.push(`${p.ns}: ${(e as { code?: string }).code}`);
        }
        cursors[i] = cursors[i]! + n;
      }
    }
  } finally {
    await store.close();
  }
  return { written, errors };
}

/** Reopens and verifies every namespace holds exactly the expected rows, bit-identical to the reference. */
async function vecVerify(
  driver: DriverName,
  expected: Record<string, ReadonlyArray<readonly [number, number]>>,
) {
  const store = await createStore({ driver });
  const problems: string[] = [];
  let corrupt = 0;
  try {
    for (const [ns, ranges] of Object.entries(expected)) {
      const total = ranges.reduce((n, r) => n + r[1], 0);
      try {
        const info = await store.indexInfo(ns);
        if (info?.rows !== total) problems.push(`${ns}: rows ${info?.rows} != ${total}`);
        const rows = refRowsOf(ranges);
        for (const j of [0, 1, 2]) {
          const q = synthQuery(j);
          for (const metric of ['cosine', 'dot'] as const) {
            const want = viewOf(topKRef(rows, q, 25, metric));
            const got = viewOf(await store.query(ns, q, 25, { metric }));
            if (JSON.stringify(got) !== JSON.stringify(want))
              problems.push(`${ns}: q${j} ${metric}`);
          }
        }
      } catch (e) {
        if ((e as { code?: string }).code === 'corrupt') corrupt++;
        problems.push(`${ns}: ${(e as { code?: string }).code ?? String(e)}`);
      }
    }
  } finally {
    await store.close();
  }
  return { problems, corrupt };
}

/** Builds a small base index and returns what a later write must not change. */
async function vecQuotaBase(driver: DriverName, rows: number) {
  await reset(driver);
  const store = await createStore({ driver });
  await store.putVectors(VEC_NS, synthRows(0, rows, { chunkBytes: CHUNK }));
  const hits = viewOf(await store.query(VEC_NS, synthQuery(0), 10));
  await store.close();
  const est = await navigator.storage.estimate();
  return { hits, usage: est.usage ?? 0 };
}

/** IndexedDB with the browser's QuotaExceededError thrown on the n-th put into a vector namespace. */
class FailingIdb extends IndexedDbDriver {
  seen = 0;
  constructor(private readonly failOn: number) {
    super();
  }
  override async put(ns: string, key: string, bytes: Uint8Array, meta: { size: number }) {
    if (ns.startsWith('__ld_vec.') && ++this.seen === this.failOn) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    return super.put(ns, key, bytes, meta);
  }
}

/**
 * A write expected to fail: returns the StorageError code and reason, or 'resolved'.
 *   plain  the browser's own quota decides (the spec overrides it through CDP)
 *   soft   the SDK soft quota, set to the index's current size plus 1 MB
 *   kth    a real DOMException QuotaExceededError on the 3rd vector put
 */
async function vecTryWrite(
  driver: DriverName,
  from: number,
  count: number,
  mode: 'plain' | 'soft' | 'kth' = 'plain',
) {
  let opts: Parameters<typeof createStore>[0] = { driver };
  if (mode === 'soft') {
    const probe = await createStore({ driver });
    const used = (await probe.usage(VEC_NS)).bytes;
    await probe.close();
    opts = { driver, quotaBytes: used + 1_000_000 };
  } else if (mode === 'kth') {
    opts = { driver: new FailingIdb(3) };
  }
  const store = await createStore(opts);
  try {
    await store.putVectors(VEC_NS, synthRows(from, count, { chunkBytes: CHUNK }));
    return { outcome: 'resolved' as const };
  } catch (e) {
    const err = e as { code?: string; details?: Record<string, unknown>; name?: string };
    return {
      outcome: 'rejected' as const,
      name: err.name,
      code: err.code,
      reason: (err.details?.['reason'] as string | undefined) ?? null,
      cause: (err.details?.['cause'] as string | undefined) ?? null,
      causeName: (err.details?.['causeName'] as string | undefined) ?? null,
    };
  } finally {
    await store.close();
  }
}

/**
 * Starts a long write and does not wait for it: the spec closes the page underneath it. The row
 * stream publishes how far it got in window.__rows so the spec can close while the write is genuinely
 * mid-flight (parts written, HEAD not yet).
 */
function vecStartWrite(driver: DriverName, from: number, count: number): void {
  const w = window as unknown as { __rows?: number };
  w.__rows = 0;
  async function* rows() {
    for (let i = 0; i < count; i++) {
      if (i % 250 === 0) w.__rows = i;
      yield synthRow(from + i, { chunkBytes: CHUNK });
    }
    w.__rows = count;
  }
  void (async () => {
    const store: LocalData = await createStore({ driver });
    await store.putVectors(VEC_NS, rows());
    await store.close();
  })().catch(() => undefined);
}

/** The IndexedDB fallback: OPFS is removed from the page, then 'auto' must pick IndexedDB. */
async function vecFallbackCheck(rows: number) {
  Object.defineProperty(navigator.storage, 'getDirectory', {
    value: undefined,
    configurable: true,
  });
  const idb = await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase(STORAGE_ROOT);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error ?? new Error('deleteDatabase failed'));
  });
  void idb;
  const store = await createStore({ driver: 'auto' });
  const driver = store.driver;
  const t0 = performance.now();
  await store.putVectors(VEC_NS, synthRows(0, rows, { chunkBytes: CHUNK }));
  const writeMs = performance.now() - t0;
  await store.close();
  const t1 = performance.now();
  const again = await createStore({ driver: 'auto' });
  const hits = viewOf(await again.query(VEC_NS, synthQuery(0), 10));
  const coldMs = performance.now() - t1;
  const want = viewOf(topKRef(refRowsOf([[0, rows]]), synthQuery(0), 10, 'cosine'));
  const info = await again.indexInfo(VEC_NS);
  await again.close();
  return {
    driver,
    opfsAvailable: typeof navigator.storage.getDirectory === 'function',
    match: JSON.stringify(hits) === JSON.stringify(want),
    rows: info?.rows,
    writeMs,
    coldMs,
  };
}

/** The harness's view of the origin's storage, for the quota tests. */
async function storageEstimate() {
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

// ---- benchmark (bench/vector-bench.spec.ts) --------------------------------------------------------

const BENCH_NS = 'vecbench';

/** Builds an index of `rows` synthetic rows with `chunkBytes`-byte chunks into an emptied driver. */
async function benchBuild(driver: DriverName, rows: number, chunkBytes: number) {
  await reset(driver);
  const store = await createStore({ driver });
  const t0 = performance.now();
  await store.putVectors(BENCH_NS, synthRows(0, rows, { chunkBytes }));
  const writeMs = performance.now() - t0;
  const info = await store.indexInfo(BENCH_NS);
  await store.close();
  return { writeMs, indexBytes: info?.bytes ?? 0, rows: info?.rows ?? 0 };
}

interface HeapMemory {
  memory?: { usedJSHeapSize: number };
}

/**
 * One cold measurement, meant for a fresh page: createStore + indexInfo (HEAD and META: the
 * structural open) = cold_open_ms, then the first query(k = 10) = first_query_ms (vectors load lazily
 * here, so it includes reading and checksumming them and the 10 values it returns), then 50 more
 * queries for p50 and p95. The JS heap peak is sampled every 10 ms across all of it.
 */
async function benchCold(driver: DriverName, rows: number, chunkBytes: number) {
  const mem = (performance as unknown as HeapMemory).memory;
  const heap = { peak: mem?.usedJSHeapSize ?? 0, start: mem?.usedJSHeapSize ?? 0 };
  const sample = () => {
    const m = (performance as unknown as HeapMemory).memory?.usedJSHeapSize ?? 0;
    if (m > heap.peak) heap.peak = m;
  };
  const timer = setInterval(sample, 10);
  const t0 = performance.now();
  const store = await createStore({ driver });
  const info = await store.indexInfo(BENCH_NS);
  const t1 = performance.now();
  const first = await store.query(BENCH_NS, synthQuery(0), 10);
  const t2 = performance.now();
  sample();
  const lat: number[] = [];
  for (let j = 1; j <= 50; j++) {
    const a = performance.now();
    await store.query(BENCH_NS, synthQuery(j), 10);
    lat.push(performance.now() - a);
    sample();
  }
  lat.sort((x, y) => x - y);
  const wasm = store.vectorWasmBytes();
  const est = await navigator.storage.estimate();
  clearInterval(timer);
  sample();
  const kernel = info?.kernel ?? '';
  // Correctness, outside the timing: the first query's hits against the naive reference.
  const want = viewOf(
    topKRef(
      (function* () {
        for (let i = 0; i < rows; i++) yield { key: synthKey(i), vector: synthVector(i) };
      })(),
      synthQuery(0),
      10,
      'cosine',
    ),
  );
  const got = viewOf(first);
  const valuesOk =
    chunkBytes === 0 ||
    first.every((h) => typeof h.value === 'string' && h.value.length === chunkBytes);
  await store.close();
  return {
    coldOpenMs: t1 - t0,
    firstQueryMs: t2 - t1,
    p50: lat[Math.floor(lat.length * 0.5)] ?? 0,
    p95: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? 0,
    jsHeapPeak: heap.peak,
    jsHeapStart: heap.start,
    wasmBytes: wasm,
    indexBytes: info?.bytes ?? 0,
    liveRows: info?.rows ?? 0,
    storageUsage: est.usage ?? 0,
    kernel,
    match: JSON.stringify(got) === JSON.stringify(want) && valuesOk && info?.rows === rows,
    precise: mem !== undefined,
  };
}

// ---- S1-092 and the open-time sweep (T1-S4-08) in real Chrome ----------------------------------------

const HARDEN_NS = 'hardening';
const HARDEN_VNS = `__ld_vec.${HARDEN_NS}`;

function newDriver(driver: DriverName): StorageDriver {
  return driver === 'opfs' ? new OpfsDriver() : new IndexedDbDriver();
}

async function hardenBuild(driver: DriverName, rows = 200): Promise<void> {
  await reset(driver);
  const store = await createStore({ driver });
  await store.putVectors(HARDEN_NS, synthRows(0, rows, { chunkBytes: 40 }));
  await store.close();
}

async function plantRecord(driver: DriverName, name: string, bytes: Uint8Array): Promise<void> {
  const d = newDriver(driver);
  await d.open();
  await d.put(HARDEN_VNS, name, bytes, { size: bytes.byteLength });
  await d.close();
}

async function recordLength(driver: DriverName, name: string): Promise<number> {
  const d = newDriver(driver);
  await d.open();
  const rec = await d.getBytes(HARDEN_VNS, name);
  await d.close();
  return rec?.bytes.byteLength ?? -1;
}

async function queryOutcome(driver: DriverName, opts: Record<string, unknown> = {}) {
  const store = await createStore({ driver, ...opts });
  try {
    const hits = await store.query(HARDEN_NS, synthQuery(0), 5);
    return { hits: hits.length, code: null as string | null, reason: null as string | null };
  } catch (e) {
    const err = e as { code?: string; details?: Record<string, unknown> };
    return {
      hits: -1,
      code: err.code ?? null,
      reason: (err.details?.['reason'] as string | undefined) ?? null,
      file: (err.details?.['file'] as string | undefined) ?? null,
    };
  } finally {
    await store.close();
  }
}

/**
 * S1-092 on a real file system: an index is built, one record is replaced by `plant` bytes, and the next
 * query runs with Blob.prototype.arrayBuffer instrumented. Reports what was refused and which blob sizes
 * were ever read into memory.
 */
async function hardenOversize(driver: DriverName, record: string, extraBytes: number) {
  await hardenBuild(driver);
  const good = await recordLength(driver, record);
  const planted = good + extraBytes;
  await plantRecord(driver, record, new Uint8Array(planted));
  const sizes: number[] = [];
  const orig = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = function (this: Blob) {
    sizes.push(this.size);
    return orig.call(this);
  };
  try {
    const out = await queryOutcome(driver);
    return { ...out, good, planted, readPlanted: sizes.includes(planted), reads: sizes.length };
  } finally {
    Blob.prototype.arrayBuffer = orig;
    await reset(driver);
  }
}

/** A real OPFS keys.json of the vector namespace overwritten with `text`, then a query and a clear. */
async function hardenKeysJson(text: string) {
  await hardenBuild('opfs');
  const top = await navigator.storage.getDirectory();
  const app = await top.getDirectoryHandle(STORAGE_ROOT);
  const v1 = await app.getDirectoryHandle('v1');
  const dir = await v1.getDirectoryHandle(HARDEN_VNS);
  const fh = await dir.getFileHandle('keys.json');
  const w = await fh.createWritable({ keepExistingData: false });
  await w.write(text);
  await w.close();
  const refused = await queryOutcome('opfs');
  const store = await createStore({ driver: 'opfs' });
  await store.clear(HARDEN_NS);
  const afterClear = await store.query(HARDEN_NS, synthQuery(0), 5);
  await store.putVectors(HARDEN_NS, synthRows(0, 5, { chunkBytes: 8 }));
  const rebuilt = (await store.query(HARDEN_NS, synthQuery(0), 5)).length;
  await store.close();
  await reset('opfs');
  return { refused, afterClear: afterClear.length, rebuilt };
}

const ORPHAN_NAMES = ['vec-9/00000', 'meta-9/00000', 'val-9/00001', 'vec-0/00007'];

/** Orphan records planted next to a committed index are swept on open and counted in the event. */
async function sweepProbe(driver: DriverName) {
  await hardenBuild(driver);
  const d = newDriver(driver);
  await d.open();
  const before = await d.keys(HARDEN_VNS);
  for (const n of ORPHAN_NAMES) await d.put(HARDEN_VNS, n, new Uint8Array(8), { size: 8 });
  const planted = await d.keys(HARDEN_VNS);
  await d.close();
  const events: Event[] = [];
  const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
  const hits = viewOf(await store.query(HARDEN_NS, synthQuery(0), 10));
  await store.close();
  const check = newDriver(driver);
  await check.open();
  const after = await check.keys(HARDEN_VNS);
  await check.close();
  const want = viewOf(topKRef(refRowsOf([[0, 200]]), synthQuery(0), 10, 'cosine'));
  const opens = events.filter((e) => e.name === 'storage.index.open');
  return {
    before,
    planted,
    after,
    swept: opens.map((e) => e.attrs['swept']),
    match: JSON.stringify(hits) === JSON.stringify(want),
  };
}

/** Holds the writer lock of the hardening namespace until releaseLock() (another tab's writer). */
let releaseHeld: (() => void) | undefined;
async function holdWriterLock(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void navigator.locks.request(
      `airplanemode-localdata:vec:${HARDEN_NS}`,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((release) => {
          releaseHeld = release;
          resolve(true);
        }),
    );
  });
}
function releaseWriterLock(): void {
  releaseHeld?.();
  releaseHeld = undefined;
}

/** Plants orphans (no reset), opens with events and reports swept and whether the read waited. */
async function sweepWhileLocked(driver: DriverName) {
  const d = newDriver(driver);
  await d.open();
  for (const n of ORPHAN_NAMES) await d.put(HARDEN_VNS, n, new Uint8Array(8), { size: 8 });
  await d.close();
  const events: Event[] = [];
  const t0 = performance.now();
  const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
  const hits = (await store.query(HARDEN_NS, synthQuery(0), 5)).length;
  const ms = performance.now() - t0;
  await store.close();
  const check = newDriver(driver);
  await check.open();
  const remaining = (await check.keys(HARDEN_VNS)).filter((n) => ORPHAN_NAMES.includes(n));
  await check.close();
  return {
    hits,
    ms,
    remaining,
    swept: events.filter((e) => e.name === 'storage.index.open').map((e) => e.attrs['swept']),
  };
}

// ---- documents API (Storage API 0.3.0) in real Chrome -------------------------------------------------

/** The shared documents cases against a real driver, each across a reopen. */
async function runDocumentCases(driver: DriverName): Promise<PersistResult[]> {
  log(`document cases: ${driver}`);
  const results = await collectPersistCases(documentCases, persistEnvFor(driver));
  for (const r of results)
    log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` -- ${r.error}` : ''}`);
  return results;
}

/** What the browser itself says is stored for a namespace, without going through the SDK. */
async function rawNamespaceListing(driver: DriverName, driverNs: string) {
  if (driver === 'opfs') {
    const top = await navigator.storage.getDirectory();
    const names: string[] = [];
    let app: FileSystemDirectoryHandle | undefined;
    try {
      app = await top.getDirectoryHandle(STORAGE_ROOT);
    } catch {
      return { namespaces: [] as string[], files: [] as string[], records: 0 };
    }
    const v1 = await app.getDirectoryHandle('v1');
    for await (const n of v1.keys()) names.push(n);
    const files: string[] = [];
    if (names.includes(driverNs)) {
      const dir = await v1.getDirectoryHandle(driverNs);
      for await (const n of dir.keys()) files.push(n);
    }
    return { namespaces: names, files, records: files.length };
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(STORAGE_ROOT);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('open failed'));
  });
  try {
    const tx = db.transaction('kv', 'readonly');
    const store = tx.objectStore('kv');
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const q = store.getAllKeys(IDBKeyRange.bound([driverNs], [driverNs, []]));
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error ?? new Error('getAllKeys failed'));
    });
    const all = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const q = store.index('ns').getAllKeys();
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error ?? new Error('index failed'));
    });
    const namespaces = [...new Set(all.map((k) => String(k)))];
    return { namespaces, files: [] as string[], records: keys.length };
  } finally {
    db.close();
  }
}

const DOC_PERSIST_NS = 'docpersist';

async function docPersistWrite(driver: DriverName): Promise<void> {
  await reset(driver);
  const store = await createStore({ driver, clock: () => 1_700_000_000_000 });
  await store.putDocument(DOC_PERSIST_NS, docInput('survivor', 6), makeChunks(1, 24, 384));
  await store.putDocument(DOC_PERSIST_NS, docInput('other', 3), makeChunks(2, 8, 384));
  await store.deleteDocument(DOC_PERSIST_NS, 'other');
  await store.close();
}

async function docPersistCheck(driver: DriverName) {
  const store = await createStore({ driver });
  try {
    const list = await store.listDocuments(DOC_PERSIST_NS);
    const hits = await store.queryChunks(DOC_PERSIST_NS, synthVector(1000 + 7, 384), 3);
    return {
      docs: list.map((d) => d.docId),
      chunks: list.map((d) => d.chunks),
      createdAt: list.map((d) => d.createdAt),
      top: hits.map((h) => ({ docId: h.docId, ordinal: h.ordinal, page: h.pageStart })),
      text: hits[0]?.text.slice(0, 20) ?? null,
    };
  } finally {
    await store.close();
  }
}

/** Starts a putDocument that is slow to read its chunks, so the spec can close the page mid-write. */
function docStartWrite(driver: DriverName, count: number): void {
  const w = window as unknown as { __chunks?: number };
  w.__chunks = 0;
  async function* chunks() {
    const all = makeChunks(3, count, 384, 200);
    for (let i = 0; i < all.length; i++) {
      w.__chunks = i;
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5));
      yield all[i]!;
    }
    w.__chunks = all.length;
  }
  void (async () => {
    const store: LocalData = await createStore({ driver });
    await store.putDocument(DOC_PERSIST_NS, docInput('halfway', 600), chunks());
    await store.close();
  })().catch(() => undefined);
}

async function docVisible(driver: DriverName) {
  const store = await createStore({ driver });
  try {
    const info = await store.getDocument(DOC_PERSIST_NS, 'halfway');
    const hits = await store.queryChunks(DOC_PERSIST_NS, synthVector(3000, 384), 1000);
    return {
      doc: info !== undefined,
      hits: hits.length,
      docs: (await store.listDocuments(DOC_PERSIST_NS)).length,
    };
  } finally {
    await store.close();
  }
}

// ---- documents benchmark (bench/documents-bench.spec.ts) -----------------------------------------------

const DOCB_NS = 'docbench';
/** 100 documents of 200 chunks each, 384 dims, 400-byte chunk texts: 20,000 chunks. */
const DOCB = { docs: 100, chunks: 200, dim: DIM, text: 400 };

function docbSeed(doc: number, chunk: number): number {
  return doc * 1000 + chunk;
}

function* docbChunks(doc: number) {
  for (let j = 0; j < DOCB.chunks; j++) {
    const seed = docbSeed(doc, j);
    const page = 1 + Math.floor(j / 4);
    yield {
      ordinal: j,
      pageStart: page,
      pageEnd: page,
      text: synthValue(seed, DOCB.text),
      vector: synthVector(seed, DOCB.dim),
    };
  }
}

const docbId = (doc: number): string => `bench-${String(doc).padStart(3, '0')}`;

function docbReference(live: number[], q: Float32Array, k: number) {
  const corpus: RefChunk[] = [];
  for (const d of live)
    for (let j = 0; j < DOCB.chunks; j++)
      corpus.push({ docId: docbId(d), ordinal: j, vector: synthVector(docbSeed(d, j), DOCB.dim) });
  return refQueryChunks(corpus, q, k, 'cosine').map((h) => `${h.docId}#${h.ordinal}`);
}

/** A sampler of the main thread JS heap every 10 ms (precise when Chrome has --enable-precise-memory-info). */
function heapSampler() {
  const read = () => (performance as unknown as HeapMemory).memory?.usedJSHeapSize ?? 0;
  const state = { peak: read() };
  const timer = setInterval(() => {
    const m = read();
    if (m > state.peak) state.peak = m;
  }, 10);
  return {
    stop: () => {
      clearInterval(timer);
      const m = read();
      if (m > state.peak) state.peak = m;
      return state.peak;
    },
  };
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

let docbStore: LocalData | undefined;

/** Builds the corpus with 100 sequential putDocument calls, then 50 warm queries. Leaves nothing open. */
async function docBenchBuild(driver: DriverName) {
  await reset(driver);
  const store = await createStore({ driver });
  const heap = heapSampler();
  const lat: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < DOCB.docs; i++) {
    const a = performance.now();
    await store.putDocument(
      DOCB_NS,
      {
        docId: docbId(i),
        title: `Benchmark document ${i}`,
        sha256: ('0123456789abcdef'.repeat(4) as string).slice(0, 64),
        bytes: 1_000_000 + i,
        pages: 50,
      },
      docbChunks(i),
    );
    lat.push(performance.now() - a);
  }
  const putMs = performance.now() - t0;
  const putHeap = heap.stop();
  const usage = await store.usage(DOCB_NS);
  // warm: the first query loads the vectors; the 50 after it run against the resident index
  const warmHeap = heapSampler();
  await store.queryChunks(DOCB_NS, synthQuery(0), 5);
  const warm: number[] = [];
  const warmT0 = performance.now();
  for (let j = 1; j <= 50; j++) {
    const a = performance.now();
    await store.queryChunks(DOCB_NS, synthQuery(j), 5);
    warm.push(performance.now() - a);
  }
  const warmTotal = performance.now() - warmT0;
  const warmPeak = warmHeap.stop();
  const wasm = store.vectorWasmBytes();
  const est = await navigator.storage.estimate();
  const hits = (await store.queryChunks(DOCB_NS, synthQuery(0), 5)).map(
    (h) => `${h.docId}#${h.ordinal}`,
  );
  const match =
    JSON.stringify(hits) ===
    JSON.stringify(
      docbReference(
        Array.from({ length: DOCB.docs }, (_, i) => i),
        synthQuery(0),
        5,
      ),
    );
  const kernel = store.documentsKernel();
  await store.close();
  return {
    put: {
      totalMs: putMs,
      p50: pct(lat, 0.5),
      p95: pct(lat, 0.95),
      heapPeak: putHeap,
      indexBytes: usage.bytes,
      documents: usage.documents ?? 0,
    },
    warm: {
      totalMs: warmTotal,
      p50: pct(warm, 0.5),
      p95: pct(warm, 0.95),
      heapPeak: warmPeak,
      wasm,
    },
    storageUsage: est.usage ?? 0,
    match,
    kernel,
  };
}

/** One cold measurement for a fresh page: createStore + the first queryChunks (loads and checks the vectors). */
async function docBenchCold(driver: DriverName) {
  const heap = heapSampler();
  const t0 = performance.now();
  const store = await createStore({ driver });
  const hits = await store.queryChunks(DOCB_NS, synthQuery(0), 5);
  const coldMs = performance.now() - t0;
  docbStore = store;
  const peak = heap.stop();
  const usage = await store.usage(DOCB_NS);
  const est = await navigator.storage.estimate();
  const got = hits.map((h) => `${h.docId}#${h.ordinal}`);
  const want = docbReference(
    Array.from({ length: DOCB.docs }, (_, i) => i),
    synthQuery(0),
    5,
  );
  return {
    coldMs,
    heapPeak: peak,
    wasm: store.vectorWasmBytes(),
    indexBytes: usage.bytes,
    storageUsage: est.usage ?? 0,
    documents: usage.documents ?? 0,
    match: JSON.stringify(got) === JSON.stringify(want),
  };
}

/** Deletes the first `count` documents one by one on the store docBenchCold left open. */
async function docBenchDelete(count: number) {
  const store = docbStore!;
  const heap = heapSampler();
  const lat: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    const a = performance.now();
    if (!(await store.deleteDocument(DOCB_NS, docbId(i)))) throw new Error('document was missing');
    lat.push(performance.now() - a);
  }
  const totalMs = performance.now() - t0;
  const peak = heap.stop();
  const live = Array.from({ length: DOCB.docs - count }, (_, i) => i + count);
  const got = (await store.queryChunks(DOCB_NS, synthQuery(0), 5)).map(
    (h) => `${h.docId}#${h.ordinal}`,
  );
  const usage = await store.usage(DOCB_NS);
  return {
    totalMs,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    heapPeak: peak,
    match: JSON.stringify(got) === JSON.stringify(docbReference(live, synthQuery(0), 5)),
    indexBytes: usage.bytes,
    documents: usage.documents ?? 0,
  };
}

/** clear(ns) on the open store, then the browser's own listing and a query: nothing may be left. */
async function docBenchClear(driver: DriverName) {
  const store = docbStore!;
  const heap = heapSampler();
  const t0 = performance.now();
  await store.clear(DOCB_NS);
  const ms = performance.now() - t0;
  const peak = heap.stop();
  const listing = await rawNamespaceListing(driver, `__ld_doc.${DOCB_NS}`);
  const hits = await store.queryChunks(DOCB_NS, synthQuery(0), 5);
  await store.close();
  docbStore = undefined;
  return {
    ms,
    heapPeak: peak,
    records: listing.records,
    namespaces: listing.namespaces.filter((n) => n === `__ld_doc.${DOCB_NS}`).length,
    hits: hits.length,
  };
}

// ---- delete cost (bench/delete-cost.ts, docs/benchmarks/delete-cost.csv) --------------------------------

const DELETE_COST_NS = 'delcost';

/**
 * BUG-T2-S6-13: times `deletes` single delete() calls (one at a time, each awaited) on a namespace of `rows`
 * seeded vectors, with a current HNSW graph or flat only. Returns the per-delete milliseconds.
 */
async function deleteCostBench(
  driver: DriverName,
  rows: number,
  dim: number,
  withGraph: boolean,
  deletes: number,
  hnsw: { m: number; efConstruction: number; seed: number },
) {
  await reset(driver);
  const store = await createStore({ driver, maxIndexBytes: 2 ** 30 });
  try {
    await store.putVectors(
      DELETE_COST_NS,
      (function* () {
        for (let i = 0; i < rows; i++) yield { key: synthKey(i), vector: synthVector(i, dim) };
      })(),
    );
    let graphBytes = 0;
    if (withGraph) {
      graphBytes = (await store.buildIndex(DELETE_COST_NS, { kind: 'hnsw', ...hnsw })).bytes;
    }
    const samples: number[] = [];
    for (let j = 0; j < deletes; j++) {
      const key = synthKey((j * 7919 + 1) % rows);
      const t0 = performance.now();
      const removed = await store.delete(DELETE_COST_NS, key);
      samples.push(performance.now() - t0);
      if (!removed) throw new Error('a delete found no row');
    }
    const info = await store.indexInfo(DELETE_COST_NS);
    return {
      samples,
      graphBytes,
      liveRows: info?.rows ?? 0,
      kernel: info?.kernel ?? 'none',
      annCurrent: info?.ann?.current ?? null,
    };
  } finally {
    await store.close();
  }
}

const api = {
  ready: true,
  benchBuild,
  benchCold,
  reset,
  runSuite,
  runVectorSuite,
  runAnnSuite,
  annPersistWrite,
  annPersistCheck,
  annBenchBuild,
  annBenchCold,
  deleteCostBench,
  runQueryCases,
  runProtoCases,
  openForTest: (driver: DriverName) => createStore({ driver }),
  hardenBuild,
  hardenOversize,
  hardenKeysJson,
  sweepProbe,
  holdWriterLock,
  releaseWriterLock,
  sweepWhileLocked,
  runDocumentCases,
  docBenchBuild,
  docBenchCold,
  docBenchDelete,
  docBenchClear,
  docBenchShape: DOCB,
  makeChunksForSpec: {
    doc: (id: string) => docInput(id, 12),
    chunks: (seed: number, n: number) => makeChunks(seed, n, 16, 300),
  },
  rawNamespaceListing,
  docPersistWrite,
  docPersistCheck,
  docStartWrite,
  docVisible,
  vecPersistWrite,
  vecPersistCheck,
  vecFreshProfileCheck,
  vecWriterRun,
  vecVerify,
  vecQuotaBase,
  vecTryWrite,
  vecStartWrite,
  vecFallbackCheck,
  storageEstimate,
  runEvents,
  persistWrite,
  persistCheck,
  bench,
  features: () => ({
    opfs: typeof navigator.storage?.getDirectory === 'function',
    indexedDb: typeof indexedDB !== 'undefined',
    secureContext: isSecureContext,
  }),
};

declare global {
  interface Window {
    __localdata: typeof api;
  }
}

window.__localdata = api;
document.body.dataset['ready'] = '1';
log(`ready: ${JSON.stringify(api.features())} dim ${DIM}`);
