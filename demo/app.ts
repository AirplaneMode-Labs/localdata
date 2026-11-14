// Public demo for @airplanemode/localdata. Bundled by demo/build.mjs into demo/dist/app.js. It
// exercises the SDK's set/get/delete/list/usage surface against the OPFS, IndexedDB and memory
// drivers, lists the storage.* events the SDK emits to an EventSink, shows
// navigator.storage.estimate() and persist(), builds and queries a flat vector index of synthetic rows
// (namespace demo-vectors) with a cold-query measurement and a check against the naive reference, and
// fills quota with synthetic data under the namespace demo-fill.
// It makes no network request and touches no storage outside localdata's own OPFS directory and
// IndexedDB database (airplanemode-localdata).
import {
  createStore,
  indexedDbAvailable,
  opfsAvailable,
  STORAGE_EVENT_NAMES,
  StorageError,
  type Event,
  type EventSink,
  type LocalData,
  type StorableValue,
} from '../src/index.ts';
import { topKRef } from '../src/vec/reference.ts';
import { DIM, synthKey, synthQuery, synthRows, synthVector } from '../bench/synth.ts';

type DriverName = 'opfs' | 'indexeddb' | 'memory';

const FILL_NS = 'demo-fill';
const FILL_CHUNK_BYTES = 4 * 1024 * 1024;
const FILL_CEILING_BYTES = 512 * 1024 * 1024;
const BINARY_BYTES = 1024 * 1024;

{
  const node = document.getElementById('build-sha');
  const sha = node?.getAttribute('data-sha') ?? '';
  if (node) node.textContent = /^([0-9a-f]{12}|local)$/.test(sha) ? sha : 'local';
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const ui = {
  driver: el<HTMLSelectElement>('driver'),
  quota: el<HTMLInputElement>('quota'),
  open: el<HTMLButtonElement>('open'),
  close: el<HTMLButtonElement>('close'),
  storeStatus: el<HTMLParagraphElement>('store-status'),
  ns: el<HTMLInputElement>('ns'),
  key: el<HTMLInputElement>('key'),
  value: el<HTMLTextAreaElement>('value'),
  binary: el<HTMLInputElement>('binary'),
  set: el<HTMLButtonElement>('set'),
  get: el<HTMLButtonElement>('get'),
  del: el<HTMLButtonElement>('delete'),
  list: el<HTMLButtonElement>('list'),
  usage: el<HTMLButtonElement>('usage'),
  kvOut: el<HTMLPreElement>('kv-out'),
  estUsage: el<HTMLTableCellElement>('est-usage'),
  estQuota: el<HTMLTableCellElement>('est-quota'),
  estPct: el<HTMLTableCellElement>('est-pct'),
  persisted: el<HTMLTableCellElement>('persisted'),
  persist: el<HTMLButtonElement>('persist'),
  persistResult: el<HTMLSpanElement>('persist-result'),
  vecRows: el<HTMLSelectElement>('vec-rows'),
  vecBuild: el<HTMLButtonElement>('vec-build'),
  vecReload: el<HTMLButtonElement>('vec-reload'),
  vecCold: el<HTMLButtonElement>('vec-cold'),
  vecDelete: el<HTMLButtonElement>('vec-delete'),
  vecStatus: el<HTMLParagraphElement>('vec-status'),
  vecFacts: el<HTMLTableElement>('vec-facts'),
  vecWhich: el<HTMLTableCellElement>('vec-which'),
  vecTime: el<HTMLTableCellElement>('vec-time'),
  vecKernel: el<HTMLTableCellElement>('vec-kernel'),
  vecHeap: el<HTMLTableCellElement>('vec-heap'),
  vecWasm: el<HTMLTableCellElement>('vec-wasm'),
  vecBytes: el<HTMLTableCellElement>('vec-bytes'),
  vecMatch: el<HTMLTableCellElement>('vec-match'),
  vecHits: el<HTMLOListElement>('vec-hits'),
  fillStart: el<HTMLButtonElement>('fill-start'),
  fillStop: el<HTMLButtonElement>('fill-stop'),
  fillClear: el<HTMLButtonElement>('fill-clear'),
  fillProgress: el<HTMLParagraphElement>('fill-progress'),
  fillOut: el<HTMLPreElement>('fill-out'),
  eventsList: el<HTMLOListElement>('events-list'),
  eventsCount: el<HTMLSpanElement>('events-count'),
  eventsClear: el<HTMLButtonElement>('events-clear'),
};

// ----- feature detection ---------------------------------------------------------------------

interface Features {
  opfs: boolean;
  indexeddb: boolean;
  estimate: boolean;
  persist: boolean;
}

function detectFeatures(): Features {
  const storage = (navigator as { storage?: Partial<StorageManager> }).storage;
  return {
    opfs: opfsAvailable() && isSecureContext,
    indexeddb: indexedDbAvailable(),
    estimate: typeof storage?.estimate === 'function',
    persist: typeof storage?.persist === 'function' && typeof storage?.persisted === 'function',
  };
}

function renderRequirements(features: Features): void {
  for (const li of document.querySelectorAll<HTMLLIElement>('#req-list li[data-req]')) {
    const name = li.dataset['req'] as keyof Features | undefined;
    const mark = li.querySelector<HTMLSpanElement>('.mark');
    if (!name || !mark) continue;
    const ok = features[name];
    mark.textContent = ok ? '✓' : '✗';
    mark.classList.toggle('ok', ok);
    mark.classList.toggle('bad', !ok);
    li.setAttribute('data-ok', ok ? '1' : '0');
    li.setAttribute(
      'aria-label',
      `${ok ? 'available' : 'missing'}: ${li.textContent?.trim() ?? name}`,
    );
  }
  for (const opt of ui.driver.options) {
    if (opt.value === 'opfs') opt.disabled = !features.opfs;
    if (opt.value === 'indexeddb') opt.disabled = !features.indexeddb;
  }
  if (ui.driver.selectedOptions[0]?.disabled) {
    ui.driver.value = features.indexeddb ? 'indexeddb' : 'memory';
  }
  ui.persist.disabled = !features.persist;
}

// ----- formatting ----------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function describeValue(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v instanceof Uint8Array) {
    const head = Array.from(v.subarray(0, 8));
    return { $type: 'Uint8Array', byteLength: v.byteLength, first8: head };
  }
  if (ArrayBuffer.isView(v)) {
    return { $type: v.constructor.name, byteLength: v.byteLength };
  }
  if (v instanceof ArrayBuffer) return { $type: 'ArrayBuffer', byteLength: v.byteLength };
  if (v instanceof Blob) return { $type: 'Blob', size: v.size, type: v.type };
  if (v instanceof Date) return { $type: 'Date', iso: v.toISOString() };
  if (Array.isArray(v)) return v.map(describeValue);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = describeValue(x);
    return out;
  }
  return v;
}

function show(v: unknown): string {
  if (v === undefined) return 'undefined';
  return JSON.stringify(describeValue(v), null, 2);
}

function showError(e: unknown): string {
  if (e instanceof StorageError || (e as { name?: unknown } | null)?.name === 'StorageError') {
    const err = e as StorageError;
    return `StorageError ${JSON.stringify(
      { code: err.code, message: err.message, details: err.details ?? null },
      null,
      2,
    )}`;
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function print(target: HTMLElement, text: string): void {
  target.textContent = `[${stamp()}] ${text}`;
}

// ----- storage.* events panel ----------------------------------------------------------------

// The sink the demo passes to createStore({ events }). It keeps the last EVENT_LIMIT events and
// renders them with createElement and textContent only (attribute values come from fixed enums).
// Events never carry a key, a prefix or a value, so nothing here can show one.

const EVENT_LIMIT = 50;
const LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];
const recentEvents: Event[] = [];
let eventsReceived = 0;
let eventsRenderQueued = false;

function formatEvent(e: Event): string {
  const attrs = Object.entries(e.attrs)
    .map(([k, v]) => `${k}=${v === null ? 'null' : typeof v === 'string' ? `'${v}'` : String(v)}`)
    .join(' ');
  const bytes = e.bytes !== undefined ? ` bytes=${e.bytes}` : '';
  const ms = e.durationMs !== undefined ? ` ${e.durationMs.toFixed(2)} ms` : '';
  return `${new Date(e.ts).toISOString().slice(11, 23)} ${e.level} ${e.name} ${attrs}${bytes}${ms}`;
}

function renderEvents(): void {
  const items = recentEvents.map((e) => {
    const li = document.createElement('li');
    li.setAttribute(
      'data-event',
      (STORAGE_EVENT_NAMES as readonly string[]).includes(e.name) ? e.name : 'other',
    );
    li.setAttribute('data-level', LEVELS.includes(e.level) ? e.level : 'info');
    li.textContent = formatEvent(e);
    return li;
  });
  ui.eventsList.replaceChildren(...items);
  ui.eventsCount.textContent = `${eventsReceived} event(s) received, newest ${items.length} shown`;
}

const eventSink: EventSink = {
  emit(e: Event): void {
    eventsReceived++;
    recentEvents.unshift(e);
    if (recentEvents.length > EVENT_LIMIT) recentEvents.length = EVENT_LIMIT;
    if (!eventsRenderQueued) {
      eventsRenderQueued = true;
      queueMicrotask(() => {
        eventsRenderQueued = false;
        renderEvents();
      });
    }
  },
};

// ----- navigator.storage panel ---------------------------------------------------------------

async function refreshStoragePanel(): Promise<void> {
  const features = detectFeatures();
  if (features.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const usage = est.usage ?? NaN;
      const quota = est.quota ?? NaN;
      ui.estUsage.textContent = `${fmtBytes(usage)} (${usage} bytes)`;
      ui.estQuota.textContent = `${fmtBytes(quota)} (${quota} bytes)`;
      ui.estPct.textContent =
        Number.isFinite(usage) && Number.isFinite(quota) && quota > 0
          ? `${((usage / quota) * 100).toFixed(4)} %`
          : 'n/a';
    } catch (e) {
      ui.estUsage.textContent = `error: ${showError(e)}`;
      ui.estQuota.textContent = '-';
      ui.estPct.textContent = '-';
    }
  } else {
    ui.estUsage.textContent = 'estimate() unavailable';
    ui.estQuota.textContent = '-';
    ui.estPct.textContent = '-';
  }
  if (features.persist) {
    try {
      ui.persisted.textContent = String(await navigator.storage.persisted());
    } catch (e) {
      ui.persisted.textContent = `error: ${showError(e)}`;
    }
  } else {
    ui.persisted.textContent = 'persisted() unavailable';
  }
}

// ----- store lifecycle -----------------------------------------------------------------------

let store: LocalData | undefined;

function setStoreButtons(): void {
  const open = store !== undefined;
  ui.open.disabled = open;
  ui.close.disabled = !open;
  ui.driver.disabled = open;
  ui.quota.disabled = open;
  for (const b of [ui.set, ui.get, ui.del, ui.list, ui.usage, ui.fillClear]) b.disabled = !open;
  ui.fillStart.disabled = !open || filling;
}

function requireStore(): LocalData {
  if (!store) throw new StorageError('closed', 'no store is open; press "Open store" first');
  return store;
}

function parseQuota(): number | undefined {
  const raw = ui.quota.value.trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new StorageError(
      'invalid_value',
      `SDK soft quota must be a non-negative number, got ${raw}`,
    );
  }
  return n;
}

async function openStore(): Promise<void> {
  try {
    const driver = ui.driver.value as DriverName;
    const quotaBytes = parseQuota();
    const opts: { driver: DriverName; quotaBytes?: number; events: EventSink } = {
      driver,
      events: eventSink,
    };
    if (quotaBytes !== undefined) opts.quotaBytes = quotaBytes;
    store = await createStore(opts);
    const total = await store.usage();
    ui.storeStatus.textContent =
      `Open on driver ${store.driver}` +
      (quotaBytes !== undefined
        ? `, SDK soft quota ${fmtBytes(quotaBytes)} (${quotaBytes} bytes)`
        : ', no SDK soft quota (only the browser quota applies)') +
      `; SDK usage ${fmtBytes(total.bytes)} in ${total.items} item(s).`;
    print(ui.kvOut, `store opened (${store.driver})`);
  } catch (e) {
    store = undefined;
    ui.storeStatus.textContent = `Open failed: ${showError(e)}`;
  }
  setStoreButtons();
  void refreshStoragePanel();
}

async function closeStore(): Promise<void> {
  stopRequested = true;
  if (store) {
    try {
      await store.close();
      print(ui.kvOut, 'store closed');
    } catch (e) {
      print(ui.kvOut, showError(e));
    }
  }
  store = undefined;
  ui.storeStatus.textContent = 'No store open.';
  setStoreButtons();
  void refreshStoragePanel();
}

// ----- set / get / delete / list / usage -----------------------------------------------------

function parseValue(): StorableValue {
  if (ui.binary.checked) {
    const bytes = new Uint8Array(BINARY_BYTES);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    return bytes;
  }
  const raw = ui.value.value;
  try {
    return JSON.parse(raw) as StorableValue;
  } catch {
    return raw;
  }
}

async function withStore(
  target: HTMLElement,
  fn: (s: LocalData) => Promise<string>,
): Promise<void> {
  try {
    const text = await fn(requireStore());
    print(target, text);
  } catch (e) {
    print(target, showError(e));
  }
  void refreshStoragePanel();
}

function wireKv(): void {
  ui.set.addEventListener('click', () =>
    withStore(ui.kvOut, async (s) => {
      const ns = ui.ns.value;
      const key = ui.key.value;
      const value = parseValue();
      const t0 = performance.now();
      await s.set(ns, key, value);
      const ms = (performance.now() - t0).toFixed(1);
      const u = await s.usage(ns);
      return `set ${ns}/${key} ok in ${ms} ms (${ui.binary.checked ? `${BINARY_BYTES} bytes binary` : 'JSON/string'}); usage(${ns}) = ${u.bytes} bytes, ${u.items} item(s)`;
    }),
  );
  ui.get.addEventListener('click', () =>
    withStore(ui.kvOut, async (s) => {
      const ns = ui.ns.value;
      const key = ui.key.value;
      const t0 = performance.now();
      const v = await s.get(ns, key);
      const ms = (performance.now() - t0).toFixed(1);
      return `get ${ns}/${key} in ${ms} ms ->\n${show(v)}`;
    }),
  );
  ui.del.addEventListener('click', () =>
    withStore(ui.kvOut, async (s) => {
      const ns = ui.ns.value;
      const key = ui.key.value;
      const removed = await s.delete(ns, key);
      return `delete ${ns}/${key} -> ${removed}`;
    }),
  );
  ui.list.addEventListener('click', () =>
    withStore(ui.kvOut, async (s) => {
      const ns = ui.ns.value;
      const { keys, cursor } = await s.list(ns);
      const u = await s.usage(ns);
      const rows = await Promise.all(
        keys.map(async (k) => {
          const v = await s.get(ns, k);
          return `  ${k}  ${sizeOf(v)} bytes`;
        }),
      );
      return (
        `list(${ns}): ${keys.length} key(s)${cursor ? `, cursor ${cursor}` : ''}; usage(${ns}) = ${u.bytes} bytes` +
        (rows.length ? `\n${rows.join('\n')}` : '')
      );
    }),
  );
  ui.usage.addEventListener('click', () =>
    withStore(ui.kvOut, async (s) => {
      const ns = ui.ns.value;
      const u = await s.usage(ns);
      const all = await s.usage();
      return `usage(${ns}) = ${JSON.stringify(u)}\nusage() (all namespaces) = ${JSON.stringify(all)}`;
    }),
  );
}

/** Approximate decoded size of a value for the list view; the SDK's usage() has the exact figure. */
function sizeOf(v: unknown): number {
  if (v === undefined) return 0;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (v instanceof Blob) return v.size;
  if (v instanceof Date) return 24;
  if (typeof v === 'string') return new TextEncoder().encode(v).byteLength;
  return new TextEncoder().encode(JSON.stringify(v)).byteLength;
}

// ----- query() -------------------------------------------------------------------------------

// ----- vector index --------------------------------------------------------------------------

// Its own store (driver 'auto': OPFS, else IndexedDB), independent of the Store section above, closed
// after every action so that a page reload followed by Cold query is a genuinely cold open. Rows
// come from bench/synth.ts, the generator the benchmark and the tests use; the answer is checked
// against src/vec/reference.ts, the Math.fround reference, after the timing.

const VEC_NS = 'demo-vectors';
const VEC_CHUNK_BYTES = 256;
let vecBusy = false;
let vecQueriesSincePageLoad = 0;

function vecSetBusy(busy: boolean): void {
  vecBusy = busy;
  for (const b of [ui.vecBuild, ui.vecReload, ui.vecCold, ui.vecDelete]) b.disabled = busy;
  ui.vecRows.disabled = busy;
}

async function vecOpen(): Promise<LocalData> {
  return createStore({ driver: 'auto', events: eventSink });
}

interface HeapMemory {
  memory?: { usedJSHeapSize: number };
}

function heapNow(): string {
  const m = (performance as unknown as HeapMemory).memory;
  return m ? fmtBytes(m.usedJSHeapSize) : 'n/a (performance.memory is Chrome-only)';
}

async function vecRun(action: () => Promise<void>): Promise<void> {
  if (vecBusy) return;
  vecSetBusy(true);
  try {
    await action();
  } catch (e) {
    ui.vecStatus.textContent = `[${stamp()}] ${showError(e)}`;
  } finally {
    vecSetBusy(false);
    void refreshStoragePanel();
  }
}

async function vecBuild(): Promise<void> {
  const rows = Number(ui.vecRows.value);
  if (![10_000, 100_000].includes(rows)) throw new Error('rows must be 10,000 or 100,000');
  const s = await vecOpen();
  try {
    ui.vecStatus.textContent = `[${stamp()}] building ${rows.toLocaleString('en-US')} rows on ${s.driver} (replaces the previous index)...`;
    await s.clear(VEC_NS);
    const t0 = performance.now();
    const res = await s.putVectors(VEC_NS, synthRows(0, rows, { chunkBytes: VEC_CHUNK_BYTES }));
    const ms = performance.now() - t0;
    const info = await s.indexInfo(VEC_NS);
    ui.vecStatus.textContent =
      `[${stamp()}] built ${res.rows.toLocaleString('en-US')} rows (dim ${DIM}, ${VEC_CHUNK_BYTES}-byte chunks) on ${s.driver} in ${ms.toFixed(0)} ms; ` +
      `index ${fmtBytes(info?.bytes ?? 0)}, ${info?.segments ?? 0} segment(s). ` +
      'Press "Reload page", then "Cold query".';
  } finally {
    await s.close();
  }
}

async function vecColdQuery(): Promise<void> {
  const cold = vecQueriesSincePageLoad === 0;
  vecQueriesSincePageLoad++;
  const t0 = performance.now();
  const s = await vecOpen();
  try {
    const info = await s.indexInfo(VEC_NS);
    if (!info) {
      ui.vecStatus.textContent = `[${stamp()}] no index in this browser: press Build first.`;
      ui.vecFacts.hidden = true;
      ui.vecHits.replaceChildren();
      return;
    }
    const hits = await s.query(VEC_NS, synthQuery(0), 10);
    const ms = performance.now() - t0;
    ui.vecFacts.hidden = false;
    ui.vecWhich.textContent = cold
      ? 'cold: the first thing this page load did (the OS file cache is not dropped)'
      : 'warm: the store was reopened in a page that already ran a query';
    ui.vecTime.textContent = `${ms.toFixed(1)} ms (createStore, index open, first query, k = 10)`;
    ui.vecKernel.textContent = `${info.kernel}, ${info.rows.toLocaleString('en-US')} rows, ${info.segments} segment(s), dim ${info.dim}`;
    ui.vecHeap.textContent = heapNow();
    ui.vecWasm.textContent = fmtBytes(s.vectorWasmBytes());
    ui.vecBytes.textContent = `${fmtBytes(info.bytes)} (${info.bytes} bytes)`;
    ui.vecMatch.textContent = 'checking against the naive reference...';
    const items = hits.map((h) => {
      const li = document.createElement('li');
      const preview = typeof h.value === 'string' ? h.value.slice(0, 40) : '';
      li.textContent = `${h.key}  score ${h.score}  ${JSON.stringify(preview)}`;
      return li;
    });
    ui.vecHits.replaceChildren(...items);
    ui.vecStatus.textContent = `[${stamp()}] query answered; checking it against the reference (slow for 100,000 rows)...`;
    // After the timing: the same query scored by the Math.fround reference, row by row, nothing kept
    // but a key and a score per row.
    await new Promise((r) => setTimeout(r, 0));
    const rows = info.rows;
    const want = topKRef(
      (function* () {
        for (let i = 0; i < rows; i++) yield { key: synthKey(i), vector: synthVector(i) };
      })(),
      synthQuery(0),
      10,
      'cosine',
    );
    const same =
      want.length === hits.length &&
      want.every((w, i) => w.key === hits[i]!.key && Object.is(w.score, hits[i]!.score));
    ui.vecMatch.textContent = same ? 'yes' : 'no';
    ui.vecStatus.textContent = `[${stamp()}] Matches naive reference: ${same ? 'yes' : 'no'}.`;
  } finally {
    await s.close();
  }
}

async function vecDelete(): Promise<void> {
  const s = await vecOpen();
  try {
    const before = await s.indexInfo(VEC_NS);
    await s.clear(VEC_NS);
    ui.vecFacts.hidden = true;
    ui.vecHits.replaceChildren();
    ui.vecStatus.textContent = `[${stamp()}] index deleted${before ? ` (${fmtBytes(before.bytes)} freed)` : ' (there was none)'}.`;
  } finally {
    await s.close();
  }
}

function wireVectors(): void {
  ui.vecBuild.addEventListener('click', () => void vecRun(vecBuild));
  ui.vecReload.addEventListener('click', () => location.reload());
  ui.vecCold.addEventListener('click', () => void vecRun(vecColdQuery));
  ui.vecDelete.addEventListener('click', () => void vecRun(vecDelete));
  if (!opfsAvailable() && !indexedDbAvailable()) {
    ui.vecStatus.textContent = 'Neither OPFS nor IndexedDB is available in this browser.';
    vecSetBusy(true);
  }
}

// ----- quota fill ----------------------------------------------------------------------------

let filling = false;
let stopRequested = false;

function randomChunk(size: number): Uint8Array {
  const out = new Uint8Array(size);
  // getRandomValues caps each call at 65536 bytes.
  for (let off = 0; off < size; off += 65536) {
    crypto.getRandomValues(out.subarray(off, Math.min(size, off + 65536)));
  }
  return out;
}

function fillKey(n: number): string {
  return `fill-${String(n).padStart(6, '0')}`;
}

async function nextFillIndex(s: LocalData): Promise<number> {
  const { keys } = await s.list(FILL_NS, { prefix: 'fill-' });
  let max = 0;
  for (const k of keys) {
    const n = Number(k.slice('fill-'.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

async function estimateUsage(): Promise<string> {
  if (typeof navigator.storage?.estimate !== 'function') return 'n/a';
  try {
    const est = await navigator.storage.estimate();
    return est.usage !== undefined ? fmtBytes(est.usage) : 'n/a';
  } catch {
    return 'n/a';
  }
}

async function startFill(): Promise<void> {
  if (filling) return;
  let s: LocalData;
  try {
    s = requireStore();
  } catch (e) {
    print(ui.fillOut, showError(e));
    return;
  }
  filling = true;
  stopRequested = false;
  ui.fillStop.disabled = false;
  setStoreButtons();
  ui.fillOut.textContent = '';
  let chunks = 0;
  let written = 0;
  let outcome: string;
  try {
    let index = await nextFillIndex(s);
    for (;;) {
      if (stopRequested) {
        outcome = `stopped by the user after ${chunks} chunk(s), ${fmtBytes(written)} written in this run`;
        break;
      }
      if (written + FILL_CHUNK_BYTES > FILL_CEILING_BYTES) {
        outcome = `hard ceiling reached: ${fmtBytes(written)} written in this run (${chunks} chunks); neither the SDK soft quota nor the browser refused a write`;
        break;
      }
      const chunk = randomChunk(FILL_CHUNK_BYTES);
      try {
        await s.set(FILL_NS, fillKey(index), chunk);
      } catch (e) {
        const err = e as StorageError;
        const code = (err as { code?: string }).code ?? 'unknown';
        if (code === 'quota_exceeded') {
          const fromSdk = err.details?.['quotaBytes'] !== undefined;
          outcome =
            `quota_exceeded after ${chunks} chunk(s), ${fmtBytes(written)} written in this run; ` +
            `the refusal came from ${fromSdk ? 'the SDK soft quota' : 'the browser'}\n${showError(e)}`;
        } else {
          outcome = `write failed with code ${code} after ${chunks} chunk(s), ${fmtBytes(written)} written\n${showError(e)}`;
        }
        break;
      }
      chunks++;
      written += chunk.byteLength;
      index++;
      const u = await s.usage(FILL_NS);
      ui.fillProgress.textContent =
        `chunks ${chunks}, bytes ${written} (${fmtBytes(written)}), ` +
        `estimate().usage ${await estimateUsage()}, SDK usage(${FILL_NS}) ${fmtBytes(u.bytes)} in ${u.items} item(s)`;
      // Yield so Stop and the live panel get a turn.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  } catch (e) {
    outcome = `fill aborted: ${showError(e)}`;
  }
  filling = false;
  ui.fillStop.disabled = true;
  setStoreButtons();
  print(ui.fillOut, outcome);
  void refreshStoragePanel();
}

async function clearFill(): Promise<void> {
  await withStore(ui.fillOut, async (s) => {
    const { keys } = await s.list(FILL_NS);
    let removed = 0;
    for (const k of keys) if (await s.delete(FILL_NS, k)) removed++;
    const u = await s.usage(FILL_NS);
    ui.fillProgress.textContent = '';
    return `cleared ${removed} key(s) from ${FILL_NS}; usage(${FILL_NS}) = ${u.bytes} bytes, ${u.items} item(s)`;
  });
}

// ----- wiring --------------------------------------------------------------------------------

function wire(): void {
  ui.open.addEventListener('click', () => void openStore());
  ui.close.addEventListener('click', () => void closeStore());
  wireKv();
  wireVectors();
  ui.persist.addEventListener('click', async () => {
    try {
      const granted = await navigator.storage.persist();
      ui.persistResult.textContent = `persist() -> ${granted}`;
    } catch (e) {
      ui.persistResult.textContent = `persist() failed: ${showError(e)}`;
    }
    void refreshStoragePanel();
  });
  ui.fillStart.addEventListener('click', () => void startFill());
  ui.fillStop.addEventListener('click', () => {
    stopRequested = true;
  });
  ui.fillClear.addEventListener('click', () => void clearFill());
  ui.eventsClear.addEventListener('click', () => {
    recentEvents.length = 0;
    renderEvents();
  });
}

renderRequirements(detectFeatures());
wire();
setStoreButtons();
void refreshStoragePanel();
setInterval(() => void refreshStoragePanel(), 2000);
document.body.dataset['ready'] = '1';
