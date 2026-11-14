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
import { DIM, synthKey, synthQuery, synthRow, synthRows, synthVector } from '../../bench/synth';
import { collectSuite, type MakeStoreOptions, type SuiteResult } from '../storage.behaviour';
import { queryCases } from '../query.behaviour';
import { collectVectorSuite, type VectorEnv, type VectorSuiteResult } from '../vector.behaviour';

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

const api = {
  ready: true,
  benchBuild,
  benchCold,
  reset,
  runSuite,
  runVectorSuite,
  runQueryCases,
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
