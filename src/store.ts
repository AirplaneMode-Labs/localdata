import { decode, encode } from './codec';
import {
  STORAGE_KEY_MAX,
  STORAGE_NS_PATTERN,
  StorageError,
  type BuildIndexOptions,
  type BuildIndexResult,
  type ChunkHit,
  type ChunkInput,
  type DocumentInfo,
  type DocumentInput,
  type ListOptions,
  type ListResult,
  type PutDocumentResult,
  type PutVectorsResult,
  type QueryChunksOptions,
  type QueryHit,
  type QueryOptions,
  type SetOptions,
  type StorableValue,
  type StorageApi,
  type StorageDriver,
  type StorageDriverName,
  type UsageResult,
  type VectorIndexInfo,
  type VectorRow,
} from './contracts/storage-api';
import { META_NS } from './drivers/types';
import { toStorageError } from './errors';
import { nullRecord, setOwn } from './own';
import { VectorStore } from './vec';
import { DocStore, type PutProbe, type QueryProbe } from './docs/store';
import type { KernelChoice } from './vec/kernel';
import { DEFAULT_MAX_INDEX_BYTES } from './vec/files';
import type { EventSink } from './contracts/event';
import {
  StorageEvents,
  eventOptionProblem,
  outcomeOf,
  type DeleteOutcome,
  type DocDeleteOutcome,
  type DocPutOutcome,
  type GetOutcome,
  type SetOutcome,
} from './events';

export interface LocalDataOptions {
  driver: StorageDriver;
  /** Soft quota enforced by the SDK before any write. Undefined = only the browser's own quota applies. */
  quotaBytes?: number;
  /** Injectable clock (epoch ms) used for TTL. Defaults to Date.now. */
  clock?: () => number;
  /**
   * Optional sink for the storage.* events (Event 0.1.4, source "localdata"). Called synchronously
   * inside try/catch and never awaited. Events never carry a key, a prefix, a value, a docId, a title or
   * chunk text; the namespace does appear (as prefix + '*' under a registered prefix, 'dockit.d' by
   * default), so do not encode personal data in namespace names.
   */
  events?: EventSink;
  /** Session id stamped on events (1..64 chars): pass the runtime's sessionId() to share one id. */
  eventSession?: string;
  /** Largest vector index (vectors plus META and keys) this store will write or open; default 1 GiB. */
  maxIndexBytes?: number;
  /** Scan kernel: 'auto' picks SIMD when WebAssembly SIMD is available, otherwise scalar. */
  vectorKernel?: KernelChoice;
}

interface IndexEntry {
  size: number;
  expiresAt?: number;
}

/** Shape of one accounting record stored under META_NS/<ns>. */
interface MetaRecord {
  v: 1;
  /** key -> [size, expiresAt or 0] */
  k: Record<string, [number, number]>;
}

/** Namespaces starting with this prefix belong to the SDK ('__ld_meta', '__ld_vec.<ns>'). */
export const RESERVED_NS_PREFIX = '__ld_';

export function validateNamespace(ns: string): void {
  if (
    typeof ns !== 'string' ||
    !STORAGE_NS_PATTERN.test(ns) ||
    ns === META_NS ||
    ns.startsWith(RESERVED_NS_PREFIX)
  ) {
    throw new StorageError(
      'invalid_namespace',
      `invalid namespace ${JSON.stringify(ns)}: must match ^[a-z0-9][a-z0-9._-]{0,63}$ and not be reserved (the prefix ${RESERVED_NS_PREFIX} is reserved)`,
      { ns: typeof ns === 'string' ? ns : String(ns) },
    );
  }
}

export function validateKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length < 1 ||
    key.length > STORAGE_KEY_MAX ||
    key.includes('\u0000')
  ) {
    throw new StorageError(
      'invalid_key',
      `invalid key: must be 1..${STORAGE_KEY_MAX} UTF-16 code units without U+0000`,
      { length: typeof key === 'string' ? key.length : -1 },
    );
  }
}

/**
 * The Storage API implementation. It validates inputs, encodes values with the LD1 codec, keeps
 * per-namespace accounting under the reserved namespace `__ld_meta`, enforces an optional soft
 * quota before writing, and delegates byte storage to a StorageDriver.
 */
export class LocalData implements StorageApi {
  readonly driver: StorageDriverName;
  private readonly d: StorageDriver;
  private readonly quotaBytes: number | undefined;
  private readonly clock: () => number;
  private readonly ev: StorageEvents;
  private readonly vec: VectorStore;
  private readonly docs: DocStore;
  private readonly index = new Map<string, Map<string, IndexEntry>>();
  private closed = false;

  private constructor(opts: LocalDataOptions) {
    this.d = opts.driver;
    this.driver = opts.driver.name;
    this.quotaBytes = opts.quotaBytes;
    this.clock = opts.clock ?? (() => Date.now());
    this.ev = new StorageEvents(opts.events, opts.driver.name, opts.eventSession);
    this.vec = new VectorStore({
      driver: opts.driver,
      events: this.ev,
      kernel: opts.vectorKernel ?? 'auto',
      maxIndexBytes: opts.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES,
      checkSoft: (ns, additional) => this.checkSoftQuota(ns, additional),
    });
    this.docs = new DocStore({
      driver: opts.driver,
      events: this.ev,
      kernel: opts.vectorKernel ?? 'auto',
      maxIndexBytes: opts.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES,
      checkSoft: (ns, additional) => this.checkSoftQuota(ns, additional),
    });
  }

  static async open(opts: LocalDataOptions): Promise<LocalData> {
    if (
      opts.quotaBytes !== undefined &&
      !(Number.isFinite(opts.quotaBytes) && opts.quotaBytes >= 0)
    ) {
      throw new StorageError('invalid_value', 'quotaBytes must be a non-negative finite number');
    }
    const eventProblem = eventOptionProblem(opts);
    if (eventProblem !== undefined) throw new StorageError('invalid_value', eventProblem);
    if (
      opts.maxIndexBytes !== undefined &&
      !(
        Number.isInteger(opts.maxIndexBytes) &&
        opts.maxIndexBytes >= 1 &&
        opts.maxIndexBytes <= 2 ** 31
      )
    ) {
      throw new StorageError('invalid_value', 'maxIndexBytes must be an integer from 1 to 2^31');
    }
    if (
      opts.vectorKernel !== undefined &&
      !['auto', 'simd', 'scalar'].includes(opts.vectorKernel)
    ) {
      throw new StorageError('invalid_value', "vectorKernel must be 'auto', 'simd' or 'scalar'");
    }
    const store = new LocalData(opts);
    try {
      await opts.driver.open();
      await store.loadIndex();
    } catch (e) {
      throw toStorageError(e, 'open');
    }
    return store;
  }

  // ----- accounting -------------------------------------------------------------------------

  private async loadIndex(): Promise<void> {
    const namespaces = await this.d.keys(META_NS);
    for (const ns of namespaces) {
      if (ns.startsWith(RESERVED_NS_PREFIX)) continue;
      const rec = await this.d.getBytes(META_NS, ns);
      const parsed = rec ? parseMeta(rec.bytes) : undefined;
      if (parsed) {
        const m = new Map<string, IndexEntry>();
        for (const [key, [size, exp]] of Object.entries(parsed.k)) {
          const e: IndexEntry = { size };
          if (exp > 0) e.expiresAt = exp;
          m.set(key, e);
        }
        this.index.set(ns, m);
      } else {
        await this.rebuild(ns);
      }
    }
  }

  /** Rebuilds one namespace's accounting from the driver (missing or corrupt meta record). */
  private async rebuild(ns: string): Promise<Map<string, IndexEntry>> {
    const m = new Map<string, IndexEntry>();
    for (const key of await this.d.keys(ns)) {
      const rec = await this.d.getBytes(ns, key);
      if (!rec) continue;
      const e: IndexEntry = { size: rec.meta.size };
      if (rec.meta.expiresAt !== undefined) e.expiresAt = rec.meta.expiresAt;
      m.set(key, e);
    }
    this.index.set(ns, m);
    await this.persist(ns);
    return m;
  }

  private async nsIndex(ns: string): Promise<Map<string, IndexEntry>> {
    let m = this.index.get(ns);
    if (m) return m;
    // Not seen at open: the namespace may have been written by another instance. Check the driver.
    const keys = await this.d.keys(ns);
    if (keys.length > 0) return this.rebuild(ns);
    m = new Map();
    this.index.set(ns, m);
    return m;
  }

  private async persist(ns: string): Promise<void> {
    const m = this.index.get(ns);
    if (!m || m.size === 0) {
      this.index.delete(ns);
      await this.d.del(META_NS, ns);
      return;
    }
    // A null-prototype record filled with setOwn: the key '__proto__' is an ordinary member, so it is
    // serialised like every other key instead of being swallowed by the prototype setter (S1-100).
    const rec: MetaRecord = { v: 1, k: nullRecord<[number, number]>() };
    for (const [key, e] of m) setOwn(rec.k, key, [e.size, e.expiresAt ?? 0]);
    const bytes = new TextEncoder().encode(JSON.stringify(rec));
    await this.d.put(META_NS, ns, bytes, { size: bytes.byteLength });
  }

  private totalBytes(): number {
    let total = 0;
    for (const m of this.index.values()) for (const e of m.values()) total += e.size;
    return total;
  }

  /** KV bytes plus the vector and document indexes this store has resident: what the soft quota is measured against. */
  private usedBytes(): number {
    return this.totalBytes() + this.vec.residentBytes() + this.docs.residentBytes();
  }

  /** Throws quota_exceeded when `additionalBytes` more bytes of vector data would pass the soft quota. */
  private checkSoftQuota(ns: string, additionalBytes: number): void {
    if (this.quotaBytes === undefined) return;
    const used = this.usedBytes();
    const needed = used + additionalBytes;
    if (needed > this.quotaBytes) {
      this.ev.quota(ns, used, this.quotaBytes, needed - this.quotaBytes, 'warn');
      throw new StorageError(
        'quota_exceeded',
        `writing the vector index would bring usage to ${needed} bytes, above the configured quota of ${this.quotaBytes}`,
        { quotaBytes: this.quotaBytes, usage: used, needed, bytes: additionalBytes },
      );
    }
  }

  private isExpired(e: IndexEntry): boolean {
    return e.expiresAt !== undefined && e.expiresAt <= this.clock();
  }

  private ensureOpen(): void {
    if (this.closed) throw new StorageError('closed', 'store is closed');
  }

  private async removeRow(ns: string, key: string, m: Map<string, IndexEntry>): Promise<boolean> {
    const existed = await this.d.del(ns, key);
    const indexed = m.delete(key);
    if (indexed) await this.persist(ns);
    return existed || indexed;
  }

  // ----- StorageApi -------------------------------------------------------------------------

  async set(ns: string, key: string, value: StorableValue, opts?: SetOptions): Promise<void> {
    const t0 = this.ev.start();
    const probe: { bytes?: number } = {};
    let outcome: SetOutcome = 'ok';
    try {
      await this.setCore(ns, key, value, opts, probe);
    } catch (e) {
      outcome = outcomeOf(e);
      throw e;
    } finally {
      this.ev.set(t0, ns, outcome, probe.bytes);
    }
  }

  private async setCore(
    ns: string,
    key: string,
    value: StorableValue,
    opts: SetOptions | undefined,
    probe: { bytes?: number },
  ): Promise<void> {
    this.ensureOpen();
    validateNamespace(ns);
    validateKey(key);
    let expiresAt: number | undefined;
    if (opts?.ttlMs !== undefined) {
      if (typeof opts.ttlMs !== 'number' || !Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new StorageError('invalid_value', 'ttlMs must be a positive finite number', {
          ttlMs: String(opts.ttlMs),
        });
      }
      expiresAt = this.clock() + opts.ttlMs;
    }
    const bytes = await encode(value);
    probe.bytes = bytes.byteLength;
    const m = await this.nsIndex(ns);
    const previous = m.get(key)?.size ?? 0;
    if (this.quotaBytes !== undefined) {
      const needed = this.usedBytes() - previous + bytes.byteLength;
      if (needed > this.quotaBytes) {
        this.ev.quota(ns, this.usedBytes(), this.quotaBytes, needed - this.quotaBytes, 'warn');
        throw new StorageError(
          'quota_exceeded',
          `writing ${bytes.byteLength} bytes would bring usage to ${needed} bytes, above the configured quota of ${this.quotaBytes}`,
          {
            quotaBytes: this.quotaBytes,
            usage: this.usedBytes(),
            needed,
            bytes: bytes.byteLength,
          },
        );
      }
    }
    try {
      const meta: { size: number; expiresAt?: number } = { size: bytes.byteLength };
      if (expiresAt !== undefined) meta.expiresAt = expiresAt;
      await this.d.put(ns, key, bytes, meta);
      const e: IndexEntry = { size: bytes.byteLength };
      if (expiresAt !== undefined) e.expiresAt = expiresAt;
      m.set(key, e);
      await this.persist(ns);
    } catch (e) {
      const err = toStorageError(e, 'set');
      // The browser (not the SDK soft quota) refused: its limit is unknown, so quota is null and
      // needed is the size of the write, an upper bound for what did not fit.
      if (err.code === 'quota_exceeded') {
        this.ev.quota(ns, this.usedBytes(), null, bytes.byteLength, 'warn');
      }
      throw err;
    }
  }

  async get<T extends StorableValue = StorableValue>(
    ns: string,
    key: string,
  ): Promise<T | undefined> {
    const t0 = this.ev.start();
    const probe: { outcome?: GetOutcome; bytes?: number } = {};
    try {
      return await this.getCore<T>(ns, key, probe);
    } catch (e) {
      probe.outcome = outcomeOf(e);
      delete probe.bytes;
      throw e;
    } finally {
      this.ev.get(t0, ns, probe.outcome ?? 'io', probe.bytes);
    }
  }

  private async getCore<T extends StorableValue>(
    ns: string,
    key: string,
    probe: { outcome?: GetOutcome; bytes?: number },
  ): Promise<T | undefined> {
    this.ensureOpen();
    validateNamespace(ns);
    validateKey(key);
    try {
      const m = await this.nsIndex(ns);
      const entry = m.get(key);
      if (entry && this.isExpired(entry)) {
        await this.removeRow(ns, key, m);
        probe.outcome = 'expired';
        return undefined;
      }
      const rec = await this.d.getBytes(ns, key);
      if (!rec) {
        if (entry) {
          m.delete(key);
          await this.persist(ns);
        }
        probe.outcome = 'miss';
        return undefined;
      }
      if (rec.meta.expiresAt !== undefined && rec.meta.expiresAt <= this.clock()) {
        await this.removeRow(ns, key, m);
        probe.outcome = 'expired';
        return undefined;
      }
      if (!entry) {
        // Row exists but accounting missed it (interrupted write); repair.
        const e: IndexEntry = { size: rec.meta.size };
        if (rec.meta.expiresAt !== undefined) e.expiresAt = rec.meta.expiresAt;
        m.set(key, e);
        await this.persist(ns);
      }
      const value = decode(rec.bytes) as T;
      probe.outcome = 'hit';
      probe.bytes = rec.bytes.byteLength;
      return value;
    } catch (e) {
      throw toStorageError(e, 'get');
    }
  }

  async delete(ns: string, key: string): Promise<boolean> {
    const t0 = this.ev.start();
    let outcome: DeleteOutcome = 'absent';
    try {
      const removed = await this.deleteCore(ns, key);
      outcome = removed ? 'removed' : 'absent';
      return removed;
    } catch (e) {
      outcome = outcomeOf(e);
      throw e;
    } finally {
      this.ev.delete(t0, ns, outcome);
    }
  }

  private async deleteCore(ns: string, key: string): Promise<boolean> {
    this.ensureOpen();
    validateNamespace(ns);
    validateKey(key);
    // The vector row first: a corrupt index rejects before any KV value is touched.
    const vectorRemoved = await this.vec.deleteKey(ns, key);
    try {
      const m = await this.nsIndex(ns);
      const entry = m.get(key);
      if (entry && this.isExpired(entry)) {
        await this.removeRow(ns, key, m);
        return vectorRemoved;
      }
      return (await this.removeRow(ns, key, m)) || vectorRemoved;
    } catch (e) {
      throw toStorageError(e, 'delete');
    }
  }

  async query(
    ns: string,
    vector: Float32Array,
    k: number,
    opts?: QueryOptions,
  ): Promise<QueryHit[]> {
    const t0 = this.ev.start();
    try {
      this.ensureOpen();
      validateNamespace(ns);
    } catch (e) {
      this.ev.query(t0, ns, outcomeOf(e), k, 0, 'cosine', this.vec.kernelInUse() ?? 'none');
      throw e;
    }
    return this.vec.query(ns, vector, k, opts);
  }

  async putVectors(
    ns: string,
    rows: Iterable<VectorRow> | AsyncIterable<VectorRow>,
  ): Promise<PutVectorsResult> {
    const t0 = this.ev.start();
    try {
      this.ensureOpen();
      validateNamespace(ns);
    } catch (e) {
      this.ev.indexWrite(t0, ns, outcomeOf(e), 0, 0, 0, 0);
      throw e;
    }
    return this.vec.putVectors(ns, rows);
  }

  async indexInfo(ns: string): Promise<VectorIndexInfo | undefined> {
    this.ensureOpen();
    validateNamespace(ns);
    return this.vec.indexInfo(ns);
  }

  // ----- HNSW (Storage API 0.4.0) -----------------------------------------------------------------

  async buildIndex(ns: string, opts: BuildIndexOptions): Promise<BuildIndexResult> {
    const t0 = this.ev.start();
    try {
      this.ensureOpen();
      validateNamespace(ns);
    } catch (e) {
      this.ev.indexBuild(t0, ns, outcomeOf(e), 'build', 0, 0, 0, 0, 0);
      throw e;
    }
    return this.vec.buildIndex(ns, opts);
  }

  async dropIndex(ns: string, kind: 'hnsw'): Promise<boolean> {
    this.ensureOpen();
    validateNamespace(ns);
    return this.vec.dropIndex(ns, kind);
  }

  /** @internal WebAssembly memory held by this store's kernels (vector index and documents), in bytes (benchmarks, demo). */
  vectorWasmBytes(): number {
    return this.vec.wasmMemoryBytes() + this.docs.wasmMemoryBytes();
  }

  /** @internal The scan kernel the documents index uses, or 'none' before one exists (benchmarks, demo). */
  documentsKernel(): string {
    return this.docs.kernelInUse() ?? 'none';
  }

  // ----- documents (Storage API 0.3.0) -------------------------------------------------------

  async putDocument(
    ns: string,
    doc: DocumentInput,
    chunks: Iterable<ChunkInput> | AsyncIterable<ChunkInput>,
  ): Promise<PutDocumentResult> {
    const t0 = this.ev.start();
    const probe: PutProbe = { chunks: 0, replaced: false, rows: 0, bytes: undefined };
    let outcome: DocPutOutcome = 'ok';
    try {
      this.ensureOpen();
      validateNamespace(ns);
      return await this.docs.put(ns, doc, chunks, this.clock, probe);
    } catch (e) {
      outcome = outcomeOf(e);
      throw e;
    } finally {
      this.ev.docPut(t0, ns, outcome, probe.chunks, probe.replaced, probe.rows, probe.bytes);
    }
  }

  async getDocument(ns: string, docId: string): Promise<DocumentInfo | undefined> {
    this.ensureOpen();
    validateNamespace(ns);
    return this.docs.get(ns, docId);
  }

  async listDocuments(ns: string): Promise<DocumentInfo[]> {
    this.ensureOpen();
    validateNamespace(ns);
    return this.docs.list(ns);
  }

  async deleteDocument(ns: string, docId: string): Promise<boolean> {
    const t0 = this.ev.start();
    let outcome: DocDeleteOutcome = 'absent';
    try {
      this.ensureOpen();
      validateNamespace(ns);
      const removed = await this.docs.remove(ns, docId);
      outcome = removed ? 'removed' : 'absent';
      return removed;
    } catch (e) {
      outcome = outcomeOf(e);
      throw e;
    } finally {
      this.ev.docDelete(t0, ns, outcome);
    }
  }

  async queryChunks(
    ns: string,
    vector: Float32Array,
    k: number,
    opts?: QueryChunksOptions,
  ): Promise<ChunkHit[]> {
    const t0 = this.ev.start();
    const probe: QueryProbe = { candidates: 0, metric: 'cosine' };
    let outcome = 'ok';
    try {
      this.ensureOpen();
      validateNamespace(ns);
      return await this.docs.queryChunks(ns, vector, k, opts, probe);
    } catch (e) {
      outcome = outcomeOf(e);
      throw e;
    } finally {
      this.ev.docQuery(
        t0,
        ns,
        outcome,
        k,
        probe.candidates,
        probe.metric,
        this.docs.kernelInUse() ?? 'none',
      );
    }
  }

  /**
   * Events only: a namespace that starts with `prefix` is emitted in event attrs as prefix + '*', so an
   * application that keeps one namespace per document never shows a docId in an event. The SDK itself
   * registers 'dockit.d'.
   */
  redactNamespacePrefix(prefix: string): void {
    this.ev.redact(prefix);
  }

  async usage(ns?: string): Promise<UsageResult> {
    this.ensureOpen();
    const nested = this.ev.nested;
    let bytes = 0;
    let items = 0;
    if (ns === undefined) {
      for (const m of this.index.values()) {
        for (const e of m.values()) {
          bytes += e.size;
          items++;
        }
      }
    } else {
      validateNamespace(ns);
      const m = await this.nsIndex(ns);
      for (const e of m.values()) {
        bytes += e.size;
        items++;
      }
    }
    const out: UsageResult = { bytes, items };
    const vec = await this.vec.usage(ns);
    if (vec !== undefined) {
      // The graph's bytes are in `bytes` and reported on their own; vectorBytes is the flat index only.
      out.bytes += vec.bytes + (vec.annBytes ?? 0);
      out.vectorRows = vec.rows;
      out.vectorBytes = vec.bytes;
      if (vec.annBytes !== undefined) out.annBytes = vec.annBytes;
    }
    const docs = await this.docs.docUsage(ns);
    if (docs !== undefined) {
      out.bytes += docs.bytes;
      out.documents = docs.documents;
    }
    if (this.quotaBytes !== undefined) out.quotaBytes = this.quotaBytes;
    if (!nested) this.ev.quota(ns ?? '', out.bytes, this.quotaBytes ?? null, 0, 'debug');
    return out;
  }

  async clear(ns: string): Promise<void> {
    this.ensureOpen();
    validateNamespace(ns);
    try {
      await this.d.clear(ns);
      this.index.delete(ns);
      await this.d.del(META_NS, ns);
    } catch (e) {
      throw toStorageError(e, 'clear');
    }
    await this.vec.clear(ns);
    await this.docs.clear(ns);
  }

  async list(ns: string, opts?: ListOptions): Promise<ListResult> {
    this.ensureOpen();
    validateNamespace(ns);
    if (opts?.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit >= 1)) {
      throw new StorageError('invalid_value', 'list limit must be a positive integer');
    }
    const m = await this.nsIndex(ns);
    const now = this.clock();
    const keys: string[] = [];
    for (const [key, e] of m) {
      if (e.expiresAt !== undefined && e.expiresAt <= now) continue;
      if (opts?.prefix !== undefined && !key.startsWith(opts.prefix)) continue;
      if (opts?.cursor !== undefined && key <= opts.cursor) continue;
      keys.push(key);
    }
    keys.sort();
    if (opts?.limit !== undefined && keys.length > opts.limit) {
      const page = keys.slice(0, opts.limit);
      return { keys: page, cursor: page[page.length - 1]! };
    }
    return { keys };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.vec.close();
    this.docs.close();
    try {
      await this.d.close();
    } catch (e) {
      throw toStorageError(e, 'close');
    }
  }
}

function parseMeta(bytes: Uint8Array): MetaRecord | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as MetaRecord).v !== 1 ||
      typeof (parsed as MetaRecord).k !== 'object' ||
      (parsed as MetaRecord).k === null
    ) {
      return undefined;
    }
    for (const v of Object.values((parsed as MetaRecord).k)) {
      if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number')
        return undefined;
    }
    return parsed as MetaRecord;
  } catch {
    return undefined;
  }
}
