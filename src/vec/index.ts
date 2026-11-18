// The vector index as the Storage API sees it: per-namespace state, cross-tab locking with index
// refresh, trap-safe kernel use, events, and the corruption rules.
//
//   * One resident OpenIndex per namespace, loaded lazily. A per-namespace in-process mutex orders
//     loads and commits; writers also hold the Web Lock 'airplanemode-localdata:vec:<ns>' (a no-op
//     without navigator.locks) from before the HEAD re-read to after the HEAD put.
//   * A corrupt result is sticky for that HEAD: every vector call keeps rejecting until clear(ns) or a
//     new HEAD (another tab's write) is seen. Wrong results are never returned.
//   * Any trap discards the kernel instance and every pointer into it; the next call starts fresh.
//   * Errors and events never carry a key, filterPrefix, vector component, score or value.
import {
  StorageError,
  type PutVectorsResult,
  type QueryHit,
  type QueryOptions,
  type StorageDriver,
  type StorableValue,
  type VectorIndexInfo,
  type VectorRow,
} from '../contracts/storage-api';
import { DOC_NS_PREFIX, VEC_NS_PREFIX, type DriverHooks } from '../drivers/types';
import { toStorageError } from '../errors';
import type { StorageEvents } from '../events';
import { Kernel, KernelTrapError, type KernelChoice, type KernelKind } from './kernel';
import { VecFiles, corrupt, referencedRecords } from './files';
import { OpenIndex, loadMeta, loadVec, readValue, type LoadCtx } from './reader';
import { TopK } from './topk';
import { checkFilterPrefix, checkK, checkMetric, checkQueryVector } from './validate';
import {
  putVectors as writePutVectors,
  tombstoneKey,
  type PutOptions,
  type PutOutcome,
  type WriteCtx,
} from './writer';

export interface VectorStoreOptions {
  driver: StorageDriver;
  events: StorageEvents;
  kernel: KernelChoice;
  maxIndexBytes: number;
  /** Throws quota_exceeded when `additionalBytes` more bytes in `ns` would pass the soft quota. */
  checkSoft(ns: string, additionalBytes: number): void;
  /**
   * The reserved driver namespace prefix this store's indexes live under: '__ld_vec.' (the default, the
   * generic vector index) or '__ld_doc.' (the documents API, src/docs).
   */
  prefix?: string;
}

type State = 'unknown' | 'absent' | 'meta' | 'full' | 'corrupt';

export interface Entry {
  ns: string;
  files: VecFiles;
  state: State;
  idx: OpenIndex | undefined;
  /** Signature of the HEAD bytes last read (for the sticky-corrupt recovery check). */
  headSig: string;
  stuck: StorageError | undefined;
  chain: Promise<unknown>;
  /** Derived state a subclass keeps beside the index (the documents view); dropped with the entry. */
  ext: unknown;
}

function sig(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return `${bytes.length}:${h.toString(16)}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function withWebLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (locks && typeof locks.request === 'function') {
    return locks.request(lockName, { mode: 'exclusive' }, fn) as Promise<T>;
  }
  return fn();
}

/**
 * Like withWebLock, but never waits: when another writer holds the lock, `fn` is skipped and undefined is
 * returned. Used by the open-time sweep, which must not block a reader behind a long write and must not
 * delete parts a writer in another tab has put but not yet committed.
 */
function tryWebLock<T>(lockName: string, fn: () => Promise<T>): Promise<T | undefined> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (locks && typeof locks.request === 'function') {
    return locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, async (lock) =>
      lock === null ? undefined : fn(),
    ) as Promise<T | undefined>;
  }
  return fn();
}

/** A row filter for scan(): which rows are candidates, how many results to keep at most, and the tie key. */
export interface ScanFilter {
  /** True for a row that is a candidate (tombstoned rows are already skipped). */
  row(row: number): boolean;
  /** Upper bound on the candidates: the result keeps min(k, capacity). */
  capacity: number;
  /** Maps a stored key to the string whose UTF-8 order breaks exact score ties. */
  tieKey?(key: string): string;
}

export class VectorStore {
  protected readonly d: StorageDriver & DriverHooks;
  private readonly entries = new Map<string, Entry>();
  protected kernel: Kernel | undefined;
  private kernelP: Promise<Kernel> | undefined;
  private closed = false;
  /** The reserved driver namespace prefix of this store's indexes. */
  protected readonly prefix: string;

  constructor(protected readonly o: VectorStoreOptions) {
    this.d = o.driver as StorageDriver & DriverHooks;
    this.prefix = o.prefix ?? VEC_NS_PREFIX;
  }

  /** The Web Lock name the writers of one index take: one lock per namespace and kind of index. */
  protected lockName(ns: string): string {
    return `airplanemode-localdata:${this.prefix === DOC_NS_PREFIX ? 'doc' : 'vec'}:${ns}`;
  }

  // ---- plumbing -----------------------------------------------------------------------------

  protected entry(ns: string): Entry {
    let e = this.entries.get(ns);
    if (!e) {
      e = {
        ns,
        files: new VecFiles(this.o.driver, ns, this.prefix),
        state: 'unknown',
        idx: undefined,
        headSig: '',
        stuck: undefined,
        chain: Promise.resolve(),
        ext: undefined,
      };
      this.entries.set(ns, e);
    }
    return e;
  }

  /** Serialises work on one namespace inside this store. */
  protected exclusive<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const run = e.chain.then(fn, fn);
    e.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  protected async getKernel(): Promise<Kernel> {
    if (this.kernel?.alive) return this.kernel;
    if (this.kernel) this.discardKernel();
    this.kernelP ??= Kernel.create(this.o.kernel).then(
      (k) => (this.kernel = k),
      (e: unknown) => {
        this.kernelP = undefined;
        throw e;
      },
    );
    return this.kernelP;
  }

  /** Forgets the kernel and every resident index (their pointers died with the instance). */
  private discardKernel(): void {
    this.kernel = undefined;
    this.kernelP = undefined;
    for (const e of this.entries.values()) {
      e.idx?.dispose();
      e.idx = undefined;
      if (e.state !== 'corrupt') e.state = 'unknown';
    }
  }

  private freshen(e: Entry): void {
    if (e.idx && e.idx.kernel !== this.kernel) {
      e.idx = undefined;
      if (e.state !== 'corrupt') e.state = 'unknown';
    }
  }

  private kernelKind(): string {
    return this.kernel?.kind ?? 'none';
  }

  protected convert(e: unknown, ns: string, write: boolean, context: string): StorageError {
    if (e instanceof KernelTrapError) {
      this.discardKernel();
      return write
        ? new StorageError('io', 'the vector kernel trapped; the operation was abandoned', {
            reason: 'wasm_trap',
          })
        : corrupt(ns, 'kernel', 'wasm_trap');
    }
    if (e instanceof RangeError) {
      return new StorageError(
        'quota_exceeded',
        'the page could not allocate the memory this index operation needs',
        { reason: 'wasm_memory' },
      );
    }
    return toStorageError(e, context);
  }

  protected ctx(e: Entry, kernel: Kernel): LoadCtx {
    return { kernel, files: e.files, ns: e.ns, maxIndexBytes: this.o.maxIndexBytes };
  }

  protected wctx(e: Entry, kernel: Kernel): WriteCtx {
    return { ...this.ctx(e, kernel), checkSoft: (n) => this.o.checkSoft(e.ns, n) };
  }

  protected stick(e: Entry, err: StorageError): void {
    e.idx?.dispose();
    e.idx = undefined;
    e.state = 'corrupt';
    e.stuck = err;
  }

  /**
   * Makes the resident index available to the depth asked for. Inside e's mutex. Undefined when
   * the namespace has no index (decided from HEAD alone: no kernel is created for it). A corrupt
   * namespace keeps rejecting until its HEAD changes. `quiet` suppresses the storage.index.open event
   * (usage() and delete() are KV-flavoured calls and must not add events of their own).
   */
  protected async ensure(
    e: Entry,
    need: 'meta' | 'full',
    quiet = false,
  ): Promise<OpenIndex | undefined> {
    this.freshen(e);
    if (e.state === 'corrupt') {
      const head = await e.files.head();
      if (head !== undefined && sig(head) !== e.headSig) {
        e.state = 'unknown';
        e.stuck = undefined;
      } else if (head === undefined) {
        e.state = 'absent';
        e.stuck = undefined;
      } else throw e.stuck!;
    }
    if (e.state === 'absent') return undefined;
    if (e.state === 'meta' && need === 'meta') return e.idx;
    if (e.state === 'full') return e.idx;
    const t0 = this.o.events.start();
    let outcome = 'ok';
    let reason = '';
    let swept = 0;
    try {
      if (e.state === 'unknown') {
        const head = await e.files.head();
        if (head === undefined) {
          e.state = 'absent';
          outcome = 'absent';
          swept = await this.sweepUnreferenced(e, undefined);
          return undefined;
        }
        const kernel = await this.getKernel();
        e.headSig = sig(head);
        e.idx = await loadMeta(this.ctx(e, kernel), head);
        e.state = 'meta';
        swept = await this.sweepUnreferenced(e, e.idx);
      }
      if (need === 'full' && e.idx !== undefined) {
        await loadVec(this.ctx(e, e.idx.kernel), e.idx);
        e.state = 'full';
      }
      return e.idx;
    } catch (err) {
      if (err instanceof StorageError && err.code === 'corrupt') {
        outcome = 'corrupt';
        reason = String(err.details?.['reason'] ?? '');
        this.stick(e, err);
      } else if (err instanceof KernelTrapError) {
        outcome = 'corrupt';
        reason = 'wasm_trap';
      } else outcome = err instanceof StorageError ? err.code : 'io';
      throw err;
    } finally {
      if (!quiet) {
        this.o.events.indexOpen(
          t0,
          e.ns,
          outcome,
          e.idx?.liveRows ?? 0,
          e.idx?.segments.length ?? 0,
          reason,
          this.kernelKind(),
          e.idx?.bytes ?? 0,
          swept,
        );
      }
    }
  }

  /**
   * T1-S4-08: deletes this namespace's part records that no committed HEAD references (parts of a write
   * that never committed) and returns how many. Runs once per load of the index, only if the writer lock
   * is free (a writer in another tab is never raced) and only if HEAD is still the one just read; any
   * failure leaves the records for the next open. Inside e's mutex.
   */
  private async sweepUnreferenced(e: Entry, idx: OpenIndex | undefined): Promise<number> {
    try {
      const n = await tryWebLock(this.lockName(e.ns), async () => {
        this.d.refreshIndex?.(e.files.vns);
        const head = await e.files.head();
        if (
          idx === undefined
            ? head !== undefined
            : head === undefined || !sameBytes(head, idx.headBytes)
        )
          return 0;
        return e.files.sweep(
          idx === undefined ? new Set() : referencedRecords(idx.dim, idx.segments),
        );
      });
      return n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * For writers, under the Web Lock: drop cached driver state, re-read HEAD, and reload the resident
   * index when its HEAD changed (another tab wrote). Returns the up-to-date resident index (meta
   * loaded), or undefined for a namespace without an index.
   */
  protected async refreshForWrite(e: Entry): Promise<OpenIndex | undefined> {
    this.d.refreshIndex?.(e.files.vns);
    this.freshen(e);
    const head = await e.files.head();
    if (head === undefined) {
      e.idx?.dispose();
      e.idx = undefined;
      e.state = 'absent';
      e.stuck = undefined;
      return undefined;
    }
    if (e.state === 'corrupt') {
      if (sig(head) === e.headSig) throw e.stuck!;
      e.state = 'unknown';
      e.stuck = undefined;
    }
    if (e.idx && sameBytes(head, e.idx.headBytes)) return e.idx;
    e.idx?.dispose();
    e.idx = undefined;
    e.state = 'unknown';
    const kernel = await this.getKernel();
    const t0 = this.o.events.start();
    try {
      e.headSig = sig(head);
      e.idx = await loadMeta(this.ctx(e, kernel), head);
      e.state = 'meta';
      this.o.events.indexOpen(
        t0,
        e.ns,
        'ok',
        e.idx?.liveRows ?? 0,
        e.idx?.segments.length ?? 0,
        '',
        kernel.kind,
        e.idx?.bytes ?? 0,
      );
      return e.idx;
    } catch (err) {
      if (err instanceof StorageError && err.code === 'corrupt') {
        this.stick(e, err);
        this.o.events.indexOpen(
          t0,
          e.ns,
          'corrupt',
          0,
          0,
          String(err.details?.['reason'] ?? ''),
          kernel.kind,
          0,
        );
      }
      throw err;
    }
  }

  // ---- StorageApi surface ---------------------------------------------------------------------

  async query(
    ns: string,
    vector: Float32Array,
    k: number,
    opts?: QueryOptions,
  ): Promise<QueryHit[]> {
    const t0 = this.o.events.start();
    let outcome = 'ok';
    let candidates = 0;
    let metricName = 'cosine';
    try {
      checkK(k);
      checkQueryVector(vector);
      if (opts?.filterPrefix !== undefined) checkFilterPrefix(opts.filterPrefix);
      if (opts?.metric !== undefined) checkMetric(opts.metric);
      const metric = opts?.metric ?? 'cosine';
      metricName = metric;
      const prefix = opts?.filterPrefix;
      const wantValues = opts?.values !== false;
      const e = this.entry(ns);
      const idx = await this.exclusive(e, () => this.ensure(e, 'full'));
      if (idx === undefined) return [];
      if (vector.length !== idx.dim) {
        throw new StorageError(
          'invalid_value',
          'the query vector length differs from the index dim',
          {
            reason: 'dim',
          },
        );
      }
      if (k === 0 || idx.liveRows === 0) return [];
      const found = this.scan(idx, vector, k, metric === 'dot' ? 1 : 0, prefix);
      candidates = found.candidates;
      const hits: QueryHit[] = [];
      const ctx = this.ctx(e, idx.kernel);
      for (const { row, score } of found.top) {
        const hit: QueryHit = { key: idx.keys[row]!, score };
        if (wantValues) {
          const seg = idx.segmentOf(row);
          const v = await readValue(ctx, idx, seg, row - seg.firstRow);
          if (v !== undefined) hit.value = v as StorableValue;
        }
        hits.push(hit);
      }
      return hits;
    } catch (err) {
      const se = this.convert(err, ns, false, 'query');
      if (se.code === 'corrupt' && se.details?.['reason'] !== 'wasm_trap') {
        const e = this.entry(ns);
        if (e.state !== 'corrupt') this.stick(e, se);
      }
      outcome = se.code;
      throw se;
    } finally {
      this.o.events.query(t0, ns, outcome, k, candidates, metricName, this.kernelKind());
    }
  }

  /** Scores every block and keeps the best min(k, candidates). Synchronous: the index cannot change. */
  protected scan(
    idx: OpenIndex,
    q: Float32Array,
    k: number,
    metric: 0 | 1,
    prefix: string | undefined,
    accept?: ScanFilter,
  ): { top: Array<{ row: number; score: number }>; candidates: number } {
    const kernel = idx.kernel;
    const dim = idx.dim;
    const qPtr = kernel.alloc(dim * 4);
    const qn = kernel.alloc(4);
    let maxRows = 0;
    for (const s of idx.segments) for (const b of s.blocks) maxRows = Math.max(maxRows, b.rows);
    const outBytes = maxRows * 4;
    const outPtr = kernel.alloc(outBytes);
    try {
      kernel.f32(qPtr, dim).set(q);
      if (kernel.invNorms(qPtr, 1, dim, qn) !== 0) throw new StorageError('io', 'kernel arguments');
      const qInv = kernel.f32(qn, 1)[0]!;
      const top = new TopK(
        Math.min(k, accept?.capacity ?? idx.liveRows),
        accept?.tieKey ? (row) => accept.tieKey!(idx.keys[row]!) : (row) => idx.keys[row]!,
      );
      const hasTomb = idx.liveRows !== idx.totalRows;
      let candidates = 0;
      for (const s of idx.segments) {
        for (const b of s.blocks) {
          const rc = kernel.scan(
            b.ptr,
            b.rows,
            dim,
            s.metaPtr + b.start * 4,
            qPtr,
            qInv,
            metric,
            outPtr,
          );
          if (rc !== 0) throw new StorageError('io', 'kernel arguments');
          const scores = kernel.f32(outPtr, b.rows);
          const base = s.firstRow + b.start;
          if (!hasTomb && prefix === undefined && accept === undefined) {
            candidates += b.rows;
            for (let i = 0; i < b.rows; i++) top.push(scores[i]!, base + i);
          } else {
            for (let i = 0; i < b.rows; i++) {
              const row = base + i;
              if (hasTomb && idx.isDeleted(row)) continue;
              if (prefix !== undefined && !idx.keys[row]!.startsWith(prefix)) continue;
              if (accept !== undefined && !accept.row(row)) continue;
              candidates++;
              top.push(scores[i]!, row);
            }
          }
        }
      }
      return { top: top.result(), candidates };
    } finally {
      kernel.free(qPtr, dim * 4);
      kernel.free(qn, 4);
      kernel.free(outPtr, outBytes);
    }
  }

  async putVectors(
    ns: string,
    rows: Iterable<VectorRow> | AsyncIterable<VectorRow>,
  ): Promise<PutVectorsResult> {
    const t0 = this.o.events.start();
    let outcome = 'ok';
    let stats = { rows: 0, replaced: 0, segments: 0, bytes: 0 };
    try {
      if (
        typeof rows !== 'object' ||
        rows === null ||
        !(Symbol.iterator in rows || Symbol.asyncIterator in rows)
      ) {
        throw new StorageError(
          'invalid_value',
          'putVectors needs an iterable or async iterable of rows',
          {
            reason: 'rows',
          },
        );
      }
      const e = this.entry(ns);
      return await this.exclusive(e, () =>
        withWebLock(this.lockName(ns), async () => {
          const idx = await this.refreshForWrite(e);
          const out = await this.commitRows(e, idx, rows);
          stats = {
            rows: out.result.rows,
            replaced: out.result.replaced,
            segments: out.segments,
            bytes: out.bytes,
          };
          return out.result;
        }),
      );
    } catch (err) {
      const se = this.convert(err, ns, true, 'putVectors');
      outcome = se.code;
      throw se;
    } finally {
      this.o.events.indexWrite(
        t0,
        ns,
        outcome,
        stats.rows,
        stats.replaced,
        stats.segments,
        stats.bytes,
      );
    }
  }

  /**
   * Writes `rows` as one all-or-nothing commit on top of `idx` (the up-to-date resident index from
   * refreshForWrite, or undefined) and drops the resident copy when it could not be extended in place.
   * Inside e's mutex and the writer lock.
   */
  protected async commitRows(
    e: Entry,
    idx: OpenIndex | undefined,
    rows: Iterable<VectorRow> | AsyncIterable<VectorRow>,
    opts?: PutOptions,
  ): Promise<PutOutcome> {
    const kernel = await this.getKernel();
    const out = await writePutVectors(this.wctx(e, kernel), idx, rows, this.o.maxIndexBytes, opts);
    if (out.invalidate) {
      e.idx?.dispose();
      e.idx = undefined;
      e.state = out.result.written > 0 ? 'unknown' : e.state;
    }
    return out;
  }

  async indexInfo(ns: string): Promise<VectorIndexInfo | undefined> {
    try {
      const e = this.entry(ns);
      const idx = await this.exclusive(e, () => this.ensure(e, 'meta'));
      if (idx === undefined) return undefined;
      return {
        formatVersion: 1,
        dtype: 'f32',
        dim: idx.dim,
        rows: idx.liveRows,
        totalRows: idx.totalRows,
        segments: idx.segments.length,
        bytes: idx.bytes,
        generation: idx.generation,
        kernel: idx.kernel.kind,
      };
    } catch (err) {
      throw this.convert(err, ns, false, 'indexInfo');
    }
  }

  /** Tombstones the live row of `key`. Resolves false when the namespace has no such row. */
  async deleteKey(ns: string, key: string): Promise<boolean> {
    const t0 = this.o.events.start();
    let outcome = 'ok';
    let wrote = false;
    let rows = 0;
    try {
      const e = this.entry(ns);
      return await this.exclusive(e, async () => {
        if (e.state === 'absent') return false;
        if (e.state === 'unknown' && (await e.files.head()) === undefined) {
          e.state = 'absent';
          return false;
        }
        return withWebLock(this.lockName(ns), async () => {
          const idx = await this.refreshForWrite(e);
          if (idx === undefined) return false;
          const kernel = await this.getKernel();
          const removed = await tombstoneKey(this.wctx(e, kernel), idx, key);
          wrote = removed;
          rows = idx.liveRows;
          return removed;
        });
      });
    } catch (err) {
      const se = this.convert(err, ns, true, 'delete');
      outcome = se.code;
      throw se;
    } finally {
      if (wrote || outcome !== 'ok') this.o.events.indexWrite(t0, ns, outcome, rows, 0, 0, 0);
    }
  }

  /** Removes the index and resets dim. Works on a corrupt index: nothing is parsed. */
  async clear(ns: string): Promise<void> {
    try {
      const e = this.entry(ns);
      await this.exclusive(e, () =>
        withWebLock(this.lockName(ns), async () => {
          this.d.refreshIndex?.(e.files.vns);
          e.idx?.dispose();
          e.idx = undefined;
          await e.files.clear();
          e.state = 'absent';
          e.stuck = undefined;
          e.headSig = '';
          e.ext = undefined;
        }),
      );
    } catch (err) {
      throw this.convert(err, ns, true, 'clear');
    }
  }

  /** Index rows and bytes of one namespace, or undefined (no index, or an index that is corrupt). */
  protected async usageOne(ns: string): Promise<{ rows: number; bytes: number } | undefined> {
    const e = this.entry(ns);
    try {
      const idx = await this.exclusive(e, () => this.ensure(e, 'meta', true));
      return idx ? { rows: idx.liveRows, bytes: idx.bytes } : undefined;
    } catch (err) {
      if (err instanceof StorageError && err.code === 'corrupt') return undefined;
      throw this.convert(err, ns, false, 'usage');
    }
  }

  /**
   * Vector usage for one namespace, or summed over every namespace the driver can list (plus the
   * ones this store opened). KV operations and usage never reject because an index is corrupt.
   */
  async usage(ns?: string): Promise<{ rows: number; bytes: number } | undefined> {
    if (ns !== undefined) return this.usageOne(ns);
    const names = new Set<string>();
    for (const n of (await this.d.namespaces?.()) ?? [])
      if (n.startsWith(this.prefix)) names.add(n.slice(this.prefix.length));
    for (const e of this.entries.values()) if (e.idx !== undefined) names.add(e.ns);
    let rows = 0;
    let bytes = 0;
    let any = false;
    for (const n of names) {
      const u = await this.usageOne(n);
      if (u) {
        rows += u.rows;
        bytes += u.bytes;
        any = true;
      }
    }
    return any ? { rows, bytes } : undefined;
  }

  /** Namespaces this store has a resident index for. */
  protected openNamespaces(): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.idx !== undefined) out.push(e.ns);
    return out;
  }

  /** Bytes the vector indexes this store has resident hold on the driver (for the soft quota). */
  residentBytes(except?: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.idx && e.ns !== except) n += e.idx.bytes;
    return n;
  }

  /** Index bytes of one namespace as last seen, 0 when unknown. */
  residentBytesOf(ns: string): number {
    return this.entries.get(ns)?.idx?.bytes ?? 0;
  }

  /** WebAssembly linear memory in bytes (0 before a kernel exists). For benchmarks and the demo. */
  wasmMemoryBytes(): number {
    return this.kernel?.memoryBytes() ?? 0;
  }

  /** The kernel in use, or undefined before one was created. */
  kernelInUse(): KernelKind | undefined {
    return this.kernel?.kind;
  }

  /** Test hook: arm a real trap in the next kernel call. */
  armTrapForTest(afterCalls = 0): void {
    this.kernel?.armTrapForTest(afterCalls);
  }

  close(): void {
    this.closed = true;
    for (const e of this.entries.values()) {
      e.idx?.dispose();
      e.idx = undefined;
    }
    this.entries.clear();
    this.kernel = undefined;
    this.kernelP = undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
