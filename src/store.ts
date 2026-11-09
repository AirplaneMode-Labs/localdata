import { decode, encode } from './codec';
import {
  STORAGE_KEY_MAX,
  STORAGE_NS_PATTERN,
  StorageError,
  type ListOptions,
  type ListResult,
  type QueryHit,
  type QueryOptions,
  type SetOptions,
  type StorableValue,
  type StorageApi,
  type StorageDriver,
  type StorageDriverName,
  type UsageResult,
} from './contracts/storage-api';
import { META_NS } from './drivers/types';
import { toStorageError } from './errors';

export interface LocalDataOptions {
  driver: StorageDriver;
  /** Soft quota enforced by the SDK before any write. Undefined = only the browser's own quota applies. */
  quotaBytes?: number;
  /** Injectable clock (epoch ms) used for TTL. Defaults to Date.now. */
  clock?: () => number;
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

export function validateNamespace(ns: string): void {
  if (typeof ns !== 'string' || !STORAGE_NS_PATTERN.test(ns) || ns === META_NS) {
    throw new StorageError(
      'invalid_namespace',
      `invalid namespace ${JSON.stringify(ns)}: must match ^[a-z0-9][a-z0-9._-]{0,63}$ and not be reserved`,
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
  private readonly index = new Map<string, Map<string, IndexEntry>>();
  private closed = false;

  private constructor(opts: LocalDataOptions) {
    this.d = opts.driver;
    this.driver = opts.driver.name;
    this.quotaBytes = opts.quotaBytes;
    this.clock = opts.clock ?? (() => Date.now());
  }

  static async open(opts: LocalDataOptions): Promise<LocalData> {
    if (
      opts.quotaBytes !== undefined &&
      !(Number.isFinite(opts.quotaBytes) && opts.quotaBytes >= 0)
    ) {
      throw new StorageError('invalid_value', 'quotaBytes must be a non-negative finite number');
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
    const rec: MetaRecord = { v: 1, k: {} };
    for (const [key, e] of m) rec.k[key] = [e.size, e.expiresAt ?? 0];
    const bytes = new TextEncoder().encode(JSON.stringify(rec));
    await this.d.put(META_NS, ns, bytes, { size: bytes.byteLength });
  }

  private totalBytes(): number {
    let total = 0;
    for (const m of this.index.values()) for (const e of m.values()) total += e.size;
    return total;
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
    const m = await this.nsIndex(ns);
    const previous = m.get(key)?.size ?? 0;
    if (this.quotaBytes !== undefined) {
      const needed = this.totalBytes() - previous + bytes.byteLength;
      if (needed > this.quotaBytes) {
        throw new StorageError(
          'quota_exceeded',
          `writing ${bytes.byteLength} bytes would bring usage to ${needed} bytes, above the configured quota of ${this.quotaBytes}`,
          {
            quotaBytes: this.quotaBytes,
            usage: this.totalBytes(),
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
      throw toStorageError(e, 'set');
    }
  }

  async get<T extends StorableValue = StorableValue>(
    ns: string,
    key: string,
  ): Promise<T | undefined> {
    this.ensureOpen();
    validateNamespace(ns);
    validateKey(key);
    try {
      const m = await this.nsIndex(ns);
      const entry = m.get(key);
      if (entry && this.isExpired(entry)) {
        await this.removeRow(ns, key, m);
        return undefined;
      }
      const rec = await this.d.getBytes(ns, key);
      if (!rec) {
        if (entry) {
          m.delete(key);
          await this.persist(ns);
        }
        return undefined;
      }
      if (rec.meta.expiresAt !== undefined && rec.meta.expiresAt <= this.clock()) {
        await this.removeRow(ns, key, m);
        return undefined;
      }
      if (!entry) {
        // Row exists but accounting missed it (interrupted write); repair.
        const e: IndexEntry = { size: rec.meta.size };
        if (rec.meta.expiresAt !== undefined) e.expiresAt = rec.meta.expiresAt;
        m.set(key, e);
        await this.persist(ns);
      }
      return decode(rec.bytes) as T;
    } catch (e) {
      throw toStorageError(e, 'get');
    }
  }

  async delete(ns: string, key: string): Promise<boolean> {
    this.ensureOpen();
    validateNamespace(ns);
    validateKey(key);
    try {
      const m = await this.nsIndex(ns);
      const entry = m.get(key);
      if (entry && this.isExpired(entry)) {
        await this.removeRow(ns, key, m);
        return false;
      }
      return await this.removeRow(ns, key, m);
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
    this.ensureOpen();
    void vector;
    void k;
    void opts;
    throw new StorageError(
      'not_implemented',
      `query() is not implemented in Storage API 0.1; the vector index lands in Sprint 4 (namespace ${JSON.stringify(ns)})`,
      { ns, since: '0.1.0', plannedSprint: 4 },
    );
  }

  async usage(ns?: string): Promise<UsageResult> {
    this.ensureOpen();
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
    if (this.quotaBytes !== undefined) out.quotaBytes = this.quotaBytes;
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
