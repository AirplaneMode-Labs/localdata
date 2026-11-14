// Browser harness bundled by test/browser/serve.mjs. It exposes window.__localdata so the
// Playwright spec can run the shared behavioural suite against the OPFS and IndexedDB drivers,
// check persistence across reload, and measure write throughput. No network access.
import {
  createStore,
  STORAGE_EVENT_NAMES,
  STORAGE_ROOT,
  type Event,
  type StorageApi,
} from '../../src/index';
import { collectSuite, type MakeStoreOptions, type SuiteResult } from '../storage.behaviour';

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

const api = {
  ready: true,
  reset,
  runSuite,
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
log(`ready: ${JSON.stringify(api.features())}`);
