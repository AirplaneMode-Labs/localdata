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
  ANN_NS_PREFIX,
  HNSW_EF_DEFAULT_MIN,
  HNSW_EF_MAX,
  StorageError,
  type AnnIndexInfo,
  type BuildIndexOptions,
  type BuildIndexResult,
  type PutVectorsResult,
  type QueryHit,
  type QueryOptions,
  type StorageDriver,
  type StorableValue,
  type VectorIndexInfo,
  type VectorMetric,
  type VectorRow,
} from '../contracts/storage-api';
import { DOC_NS_PREFIX, VEC_NS_PREFIX, type DriverHooks } from '../drivers/types';
import { toStorageError } from '../errors';
import type { QueryAnnAttrs, StorageEvents } from '../events';
import {
  AnnManager,
  AnnRefusedError,
  PARAMS_BYTES,
  annRowEstimate,
  checkAnnQueryOptions,
  checkBuildOptions,
  encodeParams,
  metricName,
  type AnnFallback,
  type AnnLoaded,
  type AnnParams,
} from './ann';
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

/** What a graph-aware write carries from before the flat commit to after it. */
interface AnnWrite {
  g: AnnLoaded;
  /** The flat HEAD generation the graph was current for before the write. */
  headGen: number;
}

/** The answer of the graph path of a query: hits, or the reason the flat scan must answer. */
interface AnnAnswer {
  found?: { top: Array<{ row: number; score: number }>; candidates: number };
  fallback: AnnFallback;
  ef: number | null;
}

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
  /** Operations on this namespace running or queued in this store: its resident graph handle may be in use. */
  active: number;
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
  /** The HNSW graphs of this store (Storage API 0.4.0). Only the generic vector store has them. */
  protected readonly ann: AnnManager;
  protected readonly annOn: boolean;

  constructor(protected readonly o: VectorStoreOptions) {
    this.d = o.driver as StorageDriver & DriverHooks;
    this.prefix = o.prefix ?? VEC_NS_PREFIX;
    this.annOn = this.prefix === VEC_NS_PREFIX;
    this.ann = new AnnManager({
      driver: this.d,
      events: o.events,
      maxBytes: o.maxIndexBytes,
      kernelKind: () => this.kernelKind(),
      busy: (ns) => (this.entries.get(ns)?.active ?? 0) > 0,
    });
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
        active: 0,
        ext: undefined,
      };
      this.entries.set(ns, e);
    }
    return e;
  }

  /** Serialises work on one namespace inside this store. */
  protected exclusive<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    // Counted from the call, not from when fn starts: a queued operation protects its graph from eviction too.
    e.active++;
    const guarded = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        e.active--;
      }
    };
    const run = e.chain.then(guarded, guarded);
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
    this.ann.onKernelDiscarded();
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
    let annAttrs: QueryAnnAttrs = { requested: 'flat', index: 'flat', fallback: '', ef: null };
    try {
      checkK(k);
      checkQueryVector(vector);
      if (opts?.filterPrefix !== undefined) checkFilterPrefix(opts.filterPrefix);
      if (opts?.metric !== undefined) checkMetric(opts.metric);
      const { requested, ef: efOpt } = checkAnnQueryOptions(opts);
      annAttrs = { ...annAttrs, requested };
      const metric = opts?.metric ?? 'cosine';
      metricName = metric;
      const prefix = opts?.filterPrefix;
      const wantValues = opts?.values !== false;
      const e = this.entry(ns);
      let answer: AnnAnswer | undefined;
      const idx = await this.exclusive(e, async () => {
        let i = await this.ensure(e, 'full');
        if (requested === 'hnsw' && this.annOn) {
          if (i !== undefined && vector.length !== i.dim) {
            throw new StorageError(
              'invalid_value',
              'the query vector length differs from the index dim',
              { reason: 'dim' },
            );
          }
          if (i === undefined) answer = { fallback: 'absent', ef: null };
          else {
            try {
              answer = await this.annQuery(e, i, vector, k, metric, prefix, efOpt);
            } catch (err) {
              if (!(err instanceof KernelTrapError)) throw err;
              // A trap: this instance and everything that pointed into it are gone. The flat scan runs
              // on a fresh one, never on the trapped instance.
              this.discardKernel();
              answer = { fallback: 'trap', ef: null };
            }
            // A rebuild may have reloaded the index, and a trap discarded it: the flat path needs it whole.
            i = await this.ensure(e, 'full');
          }
        }
        return i;
      });
      if (answer !== undefined) {
        annAttrs = {
          requested,
          index: answer.found !== undefined ? 'hnsw' : 'flat',
          fallback: answer.fallback,
          ef: answer.found !== undefined ? answer.ef : null,
        };
      }
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
      const found =
        (answer as AnnAnswer | undefined)?.found ??
        this.scan(idx, vector, k, metric === 'dot' ? 1 : 0, prefix);
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
      this.o.events.query(t0, ns, outcome, k, candidates, metricName, this.kernelKind(), annAttrs);
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
          // With a current graph the new rows are inserted into it in the same lock: the vectors must be
          // resident, and the graph's bytes count toward the pre-write quota checks.
          const w = this.annOn ? await this.annPrepareWrite(e, idx) : undefined;
          const out = await this.commitRows(
            e,
            idx,
            rows,
            w === undefined
              ? undefined
              : {
                  annBytes: w.g.bytes + PARAMS_BYTES,
                  annPerRow: annRowEstimate(w.g.params.m),
                },
          );
          stats = {
            rows: out.result.rows,
            replaced: out.result.replaced,
            segments: out.segments,
            bytes: out.bytes,
          };
          if (w !== undefined) await this.annApplyPut(e, w, out);
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
      const info: VectorIndexInfo = {
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
      if (this.annOn) {
        const ann = await this.exclusive(e, () => this.annInfo(e, idx));
        if (ann !== undefined) info.ann = ann;
      }
      return info;
    } catch (err) {
      throw this.convert(err, ns, false, 'indexInfo');
    }
  }

  // ---- HNSW (Storage API 0.4.0) -------------------------------------------------------------------

  /**
   * buildIndex: builds a graph over the live rows in stored order and replaces any existing one, in one
   * commit under the writer lock. The graph is built and sized in memory first, so a quota refusal happens
   * before anything is written.
   */
  async buildIndex(ns: string, opts: BuildIndexOptions): Promise<BuildIndexResult> {
    const t0 = this.o.events.start();
    let outcome = 'ok';
    let reason: 'build' | 'replace' = 'build';
    const st: {
      rows: number;
      liveRows: number;
      dim: number;
      m: number;
      efc: number;
      bytes?: number;
    } = {
      rows: 0,
      liveRows: 0,
      dim: 0,
      m: 0,
      efc: 0,
    };
    try {
      if (!this.annOn) {
        throw new StorageError('not_implemented', 'this index kind has no HNSW graph');
      }
      const p = checkBuildOptions(opts);
      st.m = p.m;
      st.efc = p.efConstruction;
      const e = this.entry(ns);
      return await this.exclusive(e, () =>
        withWebLock(this.lockName(ns), async () => {
          const head = await this.refreshForWrite(e);
          if (head !== undefined) await this.ensure(e, 'full', true);
          const idx = head === undefined ? undefined : e.idx;
          st.dim = idx?.dim ?? 0;
          const kernel = await this.getKernel();
          const state = this.ann.state(ns);
          this.d.refreshIndex?.(state.files.ans);
          const existed = await state.files.exists();
          reason = existed ? 'replace' : 'build';
          // A cheap lower bound first, so a hopeless build is refused before it runs.
          this.annQuotaCheck(ns, idx, 60 + 12 * (idx?.liveRows ?? 0));
          const handle = this.ann.build(kernel, idx, ns, p);
          let adopted = false;
          try {
            const bytes = this.ann.serialize(kernel, handle);
            const info = this.ann.info(kernel, handle);
            st.rows = info.nodes;
            st.liveRows = info.liveNodes;
            // The exact size, still before any write.
            this.annQuotaCheck(ns, idx, bytes.byteLength);
            try {
              // Params first, then the graph: a crash between leaves params alone, which is no graph.
              await state.files.putParams(encodeParams(p));
              await state.files.putGraph(bytes);
            } catch (err) {
              this.ann.release(ns);
              throw err;
            }
            this.ann.adopt(ns, kernel, handle, p, bytes.byteLength);
            adopted = true;
            st.bytes = bytes.byteLength;
            return {
              kind: 'hnsw' as const,
              rows: info.nodes,
              liveRows: info.liveNodes,
              bytes: bytes.byteLength,
              generation: info.generation,
              replaced: existed,
            };
          } finally {
            if (!adopted) kernel.hnswFree(handle);
          }
        }),
      );
    } catch (err) {
      const se = this.convert(err, ns, true, 'buildIndex');
      outcome = se.code;
      throw se;
    } finally {
      this.o.events.indexBuild(
        t0,
        ns,
        outcome,
        reason,
        st.rows,
        st.liveRows,
        st.dim,
        st.m,
        st.efc,
        st.bytes,
      );
    }
  }

  /** dropIndex: removes the graph (both records). True when one existed. */
  async dropIndex(ns: string, kind: 'hnsw'): Promise<boolean> {
    try {
      if ((kind as string) !== 'hnsw') {
        throw new StorageError('invalid_value', "dropIndex only knows the kind 'hnsw'", {
          reason: 'kind',
        });
      }
      if (!this.annOn) return false;
      const e = this.entry(ns);
      return await this.exclusive(e, () =>
        withWebLock(this.lockName(ns), async () => {
          this.d.refreshIndex?.(this.ann.state(ns).files.ans);
          return this.ann.remove(ns);
        }),
      );
    } catch (err) {
      throw this.convert(err, ns, true, 'dropIndex');
    }
  }

  /**
   * The exact pre-write checks for a graph of `graphBytes` bytes: the flat index plus the graph must fit
   * maxIndexBytes, and the growth over the resident graph must fit the soft quota. Throws quota_exceeded
   * with details.reason 'max_index_bytes' or 'quota'.
   */
  private annQuotaCheck(ns: string, idx: OpenIndex | undefined, graphBytes: number): void {
    const flat = idx === undefined ? 0 : idx.vecBytes + idx.metaBytes;
    if (flat + graphBytes + PARAMS_BYTES > this.o.maxIndexBytes) {
      throw new StorageError(
        'quota_exceeded',
        'the graph would push the index past maxIndexBytes; raise the option or use the flat index',
        { reason: 'max_index_bytes', maxIndexBytes: this.o.maxIndexBytes },
      );
    }
    try {
      this.o.checkSoft(ns, Math.max(0, graphBytes + PARAMS_BYTES - this.ann.residentBytesOf(ns)));
    } catch (err) {
      if (err instanceof StorageError && err.code === 'quota_exceeded') {
        throw new StorageError('quota_exceeded', err.message, { ...err.details, reason: 'quota' });
      }
      throw err;
    }
  }

  /** Drops the graph for good (until buildIndex): both records go and queries answer flat with 'refused'. */
  private async annDrop(ns: string): Promise<void> {
    await this.ann.remove(ns);
    this.ann.state(ns).status = 'dropped';
  }

  /**
   * The graph path of a query, inside the namespace mutex. Resolves the graph (loading, validating,
   * rebuilding a refused one once) and searches it, or says why the flat scan must answer. A kernel trap
   * propagates to the caller.
   */
  private async annQuery(
    e: Entry,
    idx: OpenIndex,
    vector: Float32Array,
    k: number,
    metric: VectorMetric,
    prefix: string | undefined,
    efOpt: number | undefined,
  ): Promise<AnnAnswer> {
    const res = await this.annResolve(e, idx, metric === 'dot' ? 1 : 0, prefix);
    if (!res.ok) return { fallback: res.fallback, ef: null };
    const cur = res.idx;
    const ef = Math.min(HNSW_EF_MAX, Math.max(efOpt ?? Math.max(HNSW_EF_DEFAULT_MIN, k), k));
    if (k === 0 || cur.liveRows === 0) {
      return { found: { top: [], candidates: 0 }, fallback: '', ef };
    }
    let hits;
    try {
      hits = this.ann.search(cur.kernel, cur, res.g, vector, ef);
    } catch (err) {
      if (err instanceof AnnRefusedError) {
        await this.annDrop(e.ns);
        return { fallback: 'refused', ef: null };
      }
      throw err;
    }
    // Liveness is the flat HEAD's, whatever the graph says: a candidate that is not a live row below the
    // HEAD row count is never returned.
    const want = Math.min(k, cur.liveRows);
    const top = new TopK(want, (row) => cur.keys[row]!);
    for (const h of hits)
      if (h.row < cur.totalRows && !cur.isDeleted(h.row)) top.push(h.score, h.row);
    // A graph can return fewer than min(k, live rows) hits (many identical vectors collapse its links, and a
    // k above ef can never be filled): an answer that is short is not an answer. The exact flat scan runs
    // instead, with the same scoring function and order, and the event says why (fallback 'short').
    if (top.size < want) return { fallback: 'short', ef: null };
    return { found: { top: top.result(), candidates: hits.length }, fallback: '', ef };
  }

  /** Finds the usable graph for a query: filter, refused, absent, stale and metric are the fallbacks. */
  private async annResolve(
    e: Entry,
    idx: OpenIndex,
    metric: 0 | 1,
    prefix: string | undefined,
  ): Promise<{ ok: true; g: AnnLoaded; idx: OpenIndex } | { ok: false; fallback: AnnFallback }> {
    if (prefix !== undefined) return { ok: false, fallback: 'filter' };
    const st = this.ann.state(e.ns);
    if (st.status === 'dropped') return { ok: false, fallback: 'refused' };
    this.ann.touch(e.ns);
    let g = st.status === 'loaded' && st.g?.kernel === idx.kernel ? st.g : undefined;
    if (g === undefined) {
      const r = await this.ann.load(e.ns, idx, idx.kernel);
      if (r.kind === 'absent') return { ok: false, fallback: 'absent' };
      // The stored graph cannot be loaded right now (every handle in use): the exact flat scan answers and
      // the stored record is left alone. The one case where 'absent' means "not loadable in this store now".
      if (r.kind === 'busy') return { ok: false, fallback: 'absent' };
      if (r.kind === 'params_refused') {
        await this.annDrop(e.ns);
        return { ok: false, fallback: 'refused' };
      }
      if (r.kind === 'refused') {
        const rebuilt = await this.annRebuild(e, r.params);
        if (rebuilt === 'busy') return { ok: false, fallback: 'absent' };
        if (rebuilt === undefined) return { ok: false, fallback: 'refused' };
        g = rebuilt;
      } else g = r.g;
    }
    const cur = e.idx ?? idx;
    if (g.generation < cur.generation) return { ok: false, fallback: 'stale' };
    if (g.params.metric !== metric) return { ok: false, fallback: 'metric' };
    return { ok: true, g, idx: cur };
  }

  /**
   * Rebuilds a refused graph from the stored vectors with the stored params, under the writer lock. At most
   * one rebuild runs per (namespace, HEAD generation) per open store; a rebuild whose result is refused again,
   * or that cannot be written, drops the index. Returns the loaded graph, undefined when dropped, or 'busy'
   * when the handle table is full and every other graph is in use (BUG-T2-S6-08): nothing is dropped then, and
   * the rebuild does not count against the one-per-generation rule.
   */
  private async annRebuild(e: Entry, params: AnnParams): Promise<AnnLoaded | undefined | 'busy'> {
    const st = this.ann.state(e.ns);
    const gen = e.idx?.generation ?? 0;
    if (st.rebuiltAt.has(gen)) {
      await this.annDrop(e.ns);
      return undefined;
    }
    st.rebuiltAt.add(gen);
    st.rebuilds++;
    const t0 = this.o.events.start();
    let outcome = 'ok';
    const stats = { rows: 0, live: 0, dim: 0, bytes: undefined as number | undefined };
    try {
      return await withWebLock(this.lockName(e.ns), async () => {
        const head = await this.refreshForWrite(e);
        if (head === undefined) {
          await this.ann.remove(e.ns);
          return undefined;
        }
        await this.ensure(e, 'full', true);
        const idx = e.idx!;
        const kernel = await this.getKernel();
        // Built in memory first, so that a full handle table with every other graph in use is found out
        // before any stored record is touched.
        let handle: number;
        try {
          handle = this.ann.build(kernel, idx, e.ns, params, true);
        } catch (err) {
          if (err instanceof StorageError && err.details?.['reason'] === 'max_graphs') {
            outcome = err.code;
            st.rebuiltAt.delete(gen);
            st.rebuilds--;
            return 'busy' as const;
          }
          throw err;
        }
        try {
          // The refused records go; the params come from memory (they were validated), the graph is built anew.
          await st.files.clear();
          const bytes = this.ann.serialize(kernel, handle);
          const info = this.ann.info(kernel, handle);
          stats.rows = info.nodes;
          stats.live = info.liveNodes;
          stats.dim = info.dim;
          this.annQuotaCheck(e.ns, idx, bytes.byteLength);
          await st.files.putParams(encodeParams(params));
          await st.files.putGraph(bytes);
          stats.bytes = bytes.byteLength;
        } finally {
          kernel.hnswFree(handle);
        }
        // Read back through the validating path: a rebuilt graph is trusted no more than any other.
        const r = await this.ann.load(e.ns, idx, kernel, true);
        if (r.kind === 'ok') return r.g;
        if (r.kind === 'busy') return 'busy' as const;
        outcome = 'corrupt';
        await this.annDrop(e.ns);
        return undefined;
      });
    } catch (err) {
      if (err instanceof KernelTrapError) {
        outcome = 'io';
        throw err;
      }
      // A rebuild that could not finish (quota, memory, the driver): the index is dropped, the query answers flat.
      outcome = err instanceof StorageError ? err.code : 'io';
      await this.annDrop(e.ns).catch(() => undefined);
      return undefined;
    } finally {
      this.o.events.indexBuild(
        t0,
        e.ns,
        outcome,
        'rebuild',
        stats.rows,
        stats.live,
        stats.dim,
        params.m,
        params.efConstruction,
        stats.bytes,
      );
    }
  }

  /**
   * Before a write: the graph of the namespace if it is current for the HEAD this write extends, with the
   * vectors resident so the new rows can be inserted. A refused graph is removed (it would otherwise
   * look current again once HEAD catches up with a forged generation); a stale or absent one is left alone.
   */
  private async annPrepareWrite(
    e: Entry,
    idx: OpenIndex | undefined,
  ): Promise<AnnWrite | undefined> {
    const st = this.ann.state(e.ns);
    if (st.status === 'dropped') return undefined;
    const kernel = await this.getKernel();
    this.ann.touch(e.ns);
    let g = st.status === 'loaded' && st.g?.kernel === kernel ? st.g : undefined;
    if (g === undefined) {
      const r = await this.ann.load(e.ns, idx, kernel);
      // Absent, or not loadable right now (every handle in use): the write goes on without a graph update and
      // the stored graph, left alone, is stale from the new generation on.
      if (r.kind === 'absent' || r.kind === 'busy') return undefined;
      if (r.kind !== 'ok') {
        await this.ann.remove(e.ns);
        return undefined;
      }
      g = r.g;
    }
    const headGen = idx?.generation ?? 0;
    if (g.generation !== headGen) return undefined;
    if (idx !== undefined) await this.ensure(e, 'full', true);
    return { g, headGen };
  }

  /**
   * After the flat commit: marks the replaced rows' nodes deleted, inserts the new rows, stamps the new HEAD
   * generation and writes the graph. A failure here leaves the graph on the driver at its old generation,
   * which makes it stale; the write itself has already succeeded and is not undone.
   */
  private async annApplyPut(e: Entry, w: AnnWrite, out: PutOutcome): Promise<void> {
    if (out.result.written === 0) return;
    const st = this.ann.state(e.ns);
    try {
      // The writer extends the resident index in place when the vectors were resident. When it could not
      // (the namespace had no index before this call), the committed rows are read back whole.
      if (e.idx === undefined || !e.idx.vecLoaded) await this.ensure(e, 'full', true);
      const idx = e.idx;
      if (idx === undefined || !idx.vecLoaded) throw new AnnRefusedError(0);
      const kernel = w.g.kernel;
      let g = w.g;
      let fresh: number | undefined;
      if (g.dim !== idx.dim) {
        // A graph made while the namespace had no dimension: build over every row now.
        fresh = this.ann.build(kernel, idx, e.ns, g.params);
      } else {
        for (const row of out.replacedRows) this.ann.markDeleted(kernel, g, row);
        this.ann.insert(kernel, idx, g, out.firstNewRow, out.newRows);
        this.ann.setGeneration(kernel, g, idx.generation);
      }
      const handle = fresh ?? g.handle;
      try {
        const bytes = this.ann.serialize(kernel, handle);
        this.annQuotaCheck(e.ns, idx, bytes.byteLength);
        await st.files.putGraph(bytes);
        if (fresh !== undefined) {
          g = this.ann.adopt(e.ns, kernel, fresh, g.params, bytes.byteLength);
          fresh = undefined;
        } else {
          const i = this.ann.info(kernel, handle);
          g.generation = i.generation;
          g.nodes = i.nodes;
          g.liveNodes = i.liveNodes;
          g.bytes = bytes.byteLength;
        }
      } finally {
        if (fresh !== undefined) kernel.hnswFree(fresh);
      }
    } catch (err) {
      this.annAbandon(e.ns, err);
    }
  }

  /** After a delete's flat commit: marks the node deleted and writes the graph at the new generation. */
  private async annApplyDelete(e: Entry, idx: OpenIndex, row: number | undefined): Promise<void> {
    const st = this.ann.state(e.ns);
    try {
      if (idx.liveRows === 0) {
        // The last live row went: the graph goes with it.
        await this.ann.remove(e.ns);
        return;
      }
      if (st.status === 'dropped') return;
      const kernel = await this.getKernel();
      this.ann.touch(e.ns);
      let g = st.status === 'loaded' && st.g?.kernel === kernel ? st.g : undefined;
      if (g === undefined) {
        const r = await this.ann.load(e.ns, idx, kernel);
        if (r.kind === 'absent' || r.kind === 'busy') return;
        if (r.kind !== 'ok') {
          await this.ann.remove(e.ns);
          return;
        }
        g = r.g;
      }
      if (g.generation !== idx.generation - 1) return; // not current before this delete: it stays stale
      if (row !== undefined) this.ann.markDeleted(kernel, g, row);
      this.ann.setGeneration(kernel, g, idx.generation);
      const bytes = this.ann.serialize(kernel, g.handle);
      await st.files.putGraph(bytes);
      const i = this.ann.info(kernel, g.handle);
      g.generation = i.generation;
      g.nodes = i.nodes;
      g.liveNodes = i.liveNodes;
      g.bytes = bytes.byteLength;
    } catch (err) {
      this.annAbandon(e.ns, err);
    }
  }

  /** A graph update failed after the flat commit: forget the resident graph (the driver's copy is stale). */
  private annAbandon(ns: string, err: unknown): void {
    if (err instanceof KernelTrapError) this.discardKernel();
    else this.ann.release(ns);
  }

  /** VectorIndexInfo.ann: the stored graph if it validates (a refused one is not reported, nor repaired here). */
  private async annInfo(e: Entry, idx: OpenIndex): Promise<AnnIndexInfo | undefined> {
    const st = this.ann.state(e.ns);
    if (st.status === 'dropped') return undefined;
    let g = st.status === 'loaded' && st.g?.kernel === idx.kernel ? st.g : undefined;
    if (g === undefined) {
      const r = await this.ann.load(e.ns, idx, idx.kernel);
      if (r.kind !== 'ok') return undefined;
      g = r.g;
    }
    return {
      kind: 'hnsw',
      metric: metricName(g.params.metric),
      m: g.params.m,
      efConstruction: g.params.efConstruction,
      seed: g.params.seed,
      nodes: g.nodes,
      liveNodes: g.liveNodes,
      bytes: g.bytes,
      generation: g.generation,
      current: g.generation === idx.generation,
    };
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
          const row = idx.live.get(key);
          const removed = await tombstoneKey(this.wctx(e, kernel), idx, key);
          wrote = removed;
          rows = idx.liveRows;
          if (removed && this.annOn) await this.annApplyDelete(e, idx, row);
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
          // The graph goes first: with the vectors gone a graph would only be refused later.
          if (this.annOn) await this.ann.remove(ns);
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
  protected async usageOne(
    ns: string,
  ): Promise<{ rows: number; bytes: number; annBytes?: number } | undefined> {
    const e = this.entry(ns);
    try {
      const idx = await this.exclusive(e, () => this.ensure(e, 'meta', true));
      // The graph's records, asked of the driver without reading them (0.4.0): counted beside the flat index.
      const annBytes = this.annOn ? await this.ann.state(ns).files.size() : 0;
      if (idx) {
        return annBytes > 0
          ? { rows: idx.liveRows, bytes: idx.bytes, annBytes }
          : { rows: idx.liveRows, bytes: idx.bytes };
      }
      return annBytes > 0 ? { rows: 0, bytes: 0, annBytes } : undefined;
    } catch (err) {
      if (err instanceof StorageError && err.code === 'corrupt') return undefined;
      throw this.convert(err, ns, false, 'usage');
    }
  }

  /**
   * Vector usage for one namespace, or summed over every namespace the driver can list (plus the
   * ones this store opened). KV operations and usage never reject because an index is corrupt.
   */
  async usage(
    ns?: string,
  ): Promise<{ rows: number; bytes: number; annBytes?: number } | undefined> {
    if (ns !== undefined) return this.usageOne(ns);
    const names = new Set<string>();
    for (const n of (await this.d.namespaces?.()) ?? []) {
      if (n.startsWith(this.prefix)) names.add(n.slice(this.prefix.length));
      if (this.annOn && n.startsWith(ANN_NS_PREFIX)) names.add(n.slice(ANN_NS_PREFIX.length));
    }
    for (const e of this.entries.values()) if (e.idx !== undefined) names.add(e.ns);
    let rows = 0;
    let bytes = 0;
    let annBytes = 0;
    let any = false;
    for (const n of names) {
      const u = await this.usageOne(n);
      if (u) {
        rows += u.rows;
        bytes += u.bytes;
        annBytes += u.annBytes ?? 0;
        any = true;
      }
    }
    if (!any) return undefined;
    return annBytes > 0 ? { rows, bytes, annBytes } : { rows, bytes };
  }

  /** Namespaces this store has a resident index for. */
  protected openNamespaces(): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.idx !== undefined) out.push(e.ns);
    return out;
  }

  /** Bytes the vector indexes this store has resident hold on the driver (for the soft quota). */
  residentBytes(except?: string): number {
    let n = this.ann.residentBytes(except);
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

  close(): void {
    this.closed = true;
    this.ann.dispose();
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
