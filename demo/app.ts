// Public demo for @airplanemode/localdata. Bundled by demo/build.mjs into demo/dist/app.js. It
// exercises the SDK's set/get/delete/list/usage surface against the OPFS, IndexedDB and memory
// drivers, shows navigator.storage.estimate() and persist(), calls the not-yet-implemented query()
// so the error is visible, and fills quota with synthetic data under the namespace demo-fill.
// It makes no network request and touches no storage outside localdata's own OPFS directory and
// IndexedDB database (airplanemode-localdata).
import {
  createStore,
  indexedDbAvailable,
  opfsAvailable,
  StorageError,
  type LocalData,
  type StorableValue,
} from '../src/index.ts';

type DriverName = 'opfs' | 'indexeddb' | 'memory';

const FILL_NS = 'demo-fill';
const FILL_CHUNK_BYTES = 4 * 1024 * 1024;
const FILL_CEILING_BYTES = 512 * 1024 * 1024;
const BINARY_BYTES = 1024 * 1024;

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
  queryBtn: el<HTMLButtonElement>('query-btn'),
  queryOut: el<HTMLPreElement>('query-out'),
  fillStart: el<HTMLButtonElement>('fill-start'),
  fillStop: el<HTMLButtonElement>('fill-stop'),
  fillClear: el<HTMLButtonElement>('fill-clear'),
  fillProgress: el<HTMLParagraphElement>('fill-progress'),
  fillOut: el<HTMLPreElement>('fill-out'),
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
  for (const b of [ui.set, ui.get, ui.del, ui.list, ui.usage, ui.queryBtn, ui.fillClear])
    b.disabled = !open;
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
    const opts: { driver: DriverName; quotaBytes?: number } = { driver };
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

function wireQuery(): void {
  ui.queryBtn.addEventListener('click', () =>
    withStore(ui.queryOut, async (s) => {
      const ns = ui.ns.value;
      const hits = await s.query(ns, new Float32Array(4), 1);
      return `unexpected: query() resolved with ${hits.length} hit(s)`;
    }),
  );
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
  wireQuery();
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
}

renderRequirements(detectFeatures());
wire();
setStoreButtons();
void refreshStoragePanel();
setInterval(() => void refreshStoragePanel(), 2000);
document.body.dataset['ready'] = '1';
