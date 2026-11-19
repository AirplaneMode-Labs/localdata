// The HNSW graph as the Storage API 0.4.0 sees it: option validation, the two driver records of a
// namespace's graph ('graph' and 'params' under ANN_NS_PREFIX + ns), and the kernel-level operations
// (load, build, insert, delete mark, search, serialise) behind a typed boundary.
//
// Rules this file keeps (docs/hnsw-format.md, storage-api.md "Approximate index"):
//   * The graph is a derived index and untrusted input: it is validated by the kernel before use, and
//     what fails is refused, never trusted. The stored vectors stay the source of truth.
//   * The kernel holds no vectors and no keys. Its distances come from the flat index's resident blocks,
//     lent through a block table for the length of one call, with the flat scan's own scoring function.
//   * Nothing here knows a key, a query vector or the seed outside the kernel call it is passed to; no
//     message, detail or event carries one.
//   * Every kernel call can trap: the caller treats KernelTrapError as "discard the instance".
import {
  ANN_NS_PREFIX,
  HNSW_EF_CONSTRUCTION_DEFAULT,
  HNSW_EF_CONSTRUCTION_MAX,
  HNSW_EF_MAX,
  HNSW_M_DEFAULT,
  HNSW_M_MAX,
  HNSW_M_MIN,
  HNSW_MAX_GRAPHS,
  StorageError,
  type StorageDriver,
  type VectorIndexKind,
  type VectorMetric,
} from '../contracts/storage-api';
import type { DriverHooks } from '../drivers/types';
import type { StorageEvents } from '../events';
import { E_ARGS, E_HNSW_MEMORY, HNSW_INFO_WORDS, HNSW_REASONS, type Kernel } from './kernel';
import type { OpenIndex } from './reader';

export const GRAPH_KEY = 'graph';
export const PARAMS_KEY = 'params';
/** Size of the params record. */
export const PARAMS_BYTES = 28;

const ENC = new TextEncoder();
const PARAMS_MAGIC = ENC.encode('LDHNSWP1');

/**
 * Why a request for 'hnsw' was answered by the flat scan ('' when the graph answered). 'short' (fix round 1):
 * the graph's live hits were fewer than min(k, live rows), for example with many identical vectors or a k
 * above HNSW_EF_MAX, so the exact flat scan answered.
 */
export type AnnFallback =
  '' | 'absent' | 'stale' | 'filter' | 'metric' | 'short' | 'refused' | 'trap';

/** The build parameters, as the kernel takes them (metric 0 = cosine, 1 = dot). */
export interface AnnParams {
  metric: 0 | 1;
  m: number;
  efConstruction: number;
  seed: number;
}

export function metricName(m: 0 | 1): VectorMetric {
  return m === 1 ? 'dot' : 'cosine';
}

function invalid(reason: string, message: string): StorageError {
  return new StorageError('invalid_value', message, { reason });
}

/**
 * Validates BuildIndexOptions (Storage API 0.4.0) and fills in the defaults. Order: kind, metric, m,
 * efConstruction, seed. Messages and details never echo a value.
 */
export function checkBuildOptions(opts: unknown): AnnParams {
  const o = opts as Record<string, unknown> | null | undefined;
  if (typeof o !== 'object' || o === null || o['kind'] !== 'hnsw') {
    throw invalid('kind', "buildIndex needs options with kind 'hnsw'");
  }
  const metric = o['metric'];
  if (metric !== undefined && metric !== 'cosine' && metric !== 'dot') {
    throw invalid('metric', "metric must be 'cosine' or 'dot'");
  }
  const m = o['m'] ?? HNSW_M_DEFAULT;
  if (typeof m !== 'number' || !Number.isInteger(m) || m < HNSW_M_MIN || m > HNSW_M_MAX) {
    throw invalid('m', `m must be an integer ${HNSW_M_MIN}..${HNSW_M_MAX}`);
  }
  const efc = o['efConstruction'] ?? HNSW_EF_CONSTRUCTION_DEFAULT;
  if (
    typeof efc !== 'number' ||
    !Number.isInteger(efc) ||
    efc < m ||
    efc > HNSW_EF_CONSTRUCTION_MAX
  ) {
    throw invalid(
      'efConstruction',
      `efConstruction must be an integer from m to ${HNSW_EF_CONSTRUCTION_MAX}`,
    );
  }
  const seed = o['seed'] ?? 1;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw invalid('seed', 'seed must be an integer 0..4294967295');
  }
  return { metric: metric === 'dot' ? 1 : 0, m, efConstruction: efc, seed };
}

/** Validates the 0.4.0 query options `index` and `ef`; returns the index kind asked for. */
export function checkAnnQueryOptions(opts: { index?: unknown; ef?: unknown } | undefined): {
  requested: VectorIndexKind;
  ef: number | undefined;
} {
  const index = opts?.index;
  if (index !== undefined && index !== 'flat' && index !== 'hnsw') {
    throw invalid('kind', "index must be 'flat' or 'hnsw'");
  }
  const ef = opts?.ef;
  if (
    ef !== undefined &&
    (typeof ef !== 'number' || !Number.isInteger(ef) || ef < 1 || ef > HNSW_EF_MAX)
  ) {
    throw invalid('ef', `ef must be an integer 1..${HNSW_EF_MAX}`);
  }
  return { requested: index === 'hnsw' ? 'hnsw' : 'flat', ef };
}

/** An upper bound on the bytes one more row adds to a graph (layer 0 full plus an upper layer). */
export function annRowEstimate(m: number): number {
  return 8 + 4 * (1 + 2 * m) + 4 * (1 + m);
}

// ---- the params record -----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32C of a few bytes (the params record is 28 bytes; the kernel does the large records). */
function crc32cSmall(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export function encodeParams(p: AnnParams): Uint8Array {
  const out = new Uint8Array(PARAMS_BYTES);
  const dv = new DataView(out.buffer);
  out.set(PARAMS_MAGIC, 0);
  dv.setUint16(8, 1, true);
  out[10] = p.metric;
  dv.setUint32(12, p.m, true);
  dv.setUint32(16, p.efConstruction, true);
  dv.setUint32(20, p.seed, true);
  dv.setUint32(24, crc32cSmall(out.subarray(0, 24)), true);
  return out;
}

/** The params of a record, or undefined when the record is not exactly what encodeParams writes. */
export function decodeParams(b: Uint8Array): AnnParams | undefined {
  if (b.byteLength !== PARAMS_BYTES) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < 8; i++) if (b[i] !== PARAMS_MAGIC[i]) return undefined;
  if (dv.getUint16(8, true) !== 1 || b[10]! > 1 || b[11] !== 0) return undefined;
  if (dv.getUint32(24, true) !== crc32cSmall(b.subarray(0, 24))) return undefined;
  const m = dv.getUint32(12, true);
  const efConstruction = dv.getUint32(16, true);
  if (
    m < HNSW_M_MIN ||
    m > HNSW_M_MAX ||
    efConstruction < m ||
    efConstruction > HNSW_EF_CONSTRUCTION_MAX
  )
    return undefined;
  return { metric: b[10] as 0 | 1, m, efConstruction, seed: dv.getUint32(20, true) };
}

// ---- the two driver records -------------------------------------------------------------------------

export type GraphRead = { kind: 'ok'; bytes: Uint8Array } | { kind: 'absent' } | { kind: 'size' };

/** The driver-facing operations on one namespace's graph records. */
export class AnnFiles {
  readonly ans: string;

  constructor(
    private readonly d: StorageDriver & DriverHooks,
    readonly ns: string,
  ) {
    this.ans = ANN_NS_PREFIX + ns;
  }

  /** The graph record; one longer than `max` bytes is reported as 'size' without being read. */
  async readGraph(max: number): Promise<GraphRead> {
    try {
      if (typeof this.d.getBytesBounded === 'function') {
        const r = await this.d.getBytesBounded(this.ans, GRAPH_KEY, { max });
        if (r.kind === 'size') return { kind: 'size' };
        return r.kind === 'ok' ? { kind: 'ok', bytes: r.record.bytes } : { kind: 'absent' };
      }
      const rec = await this.d.getBytes(this.ans, GRAPH_KEY);
      if (!rec) return { kind: 'absent' };
      return rec.bytes.byteLength > max ? { kind: 'size' } : { kind: 'ok', bytes: rec.bytes };
    } catch (e) {
      // A damaged keys.json of the graph namespace is corruption of a derived index: refuse it.
      if (e instanceof StorageError && e.code === 'corrupt') return { kind: 'size' };
      throw e;
    }
  }

  /** The params record, or undefined when it is absent. A record longer than 64 bytes reads as empty (refused). */
  async readParams(): Promise<Uint8Array | undefined> {
    try {
      if (typeof this.d.getBytesBounded === 'function') {
        const r = await this.d.getBytesBounded(this.ans, PARAMS_KEY, { max: 64 });
        if (r.kind === 'size') return new Uint8Array(0);
        return r.kind === 'ok' ? r.record.bytes : undefined;
      }
      const rec = await this.d.getBytes(this.ans, PARAMS_KEY);
      if (!rec) return undefined;
      return rec.bytes.byteLength > 64 ? new Uint8Array(0) : rec.bytes;
    } catch (e) {
      if (e instanceof StorageError && e.code === 'corrupt') return new Uint8Array(0);
      throw e;
    }
  }

  /** Bytes the two records occupy, asked of the driver without reading them where it can say. */
  async size(): Promise<number> {
    let total = 0;
    for (const key of [GRAPH_KEY, PARAMS_KEY]) {
      try {
        if (typeof this.d.getBytesBounded === 'function') {
          const r = await this.d.getBytesBounded(this.ans, key, { max: 0 });
          if (r.kind === 'size') total += r.actual;
        } else {
          total += (await this.d.getBytes(this.ans, key))?.bytes.byteLength ?? 0;
        }
      } catch (e) {
        if (!(e instanceof StorageError && e.code === 'corrupt')) throw e;
      }
    }
    return total;
  }

  async exists(): Promise<boolean> {
    try {
      return (await this.d.keys(this.ans)).length > 0;
    } catch (e) {
      if (e instanceof StorageError && e.code === 'corrupt') return true;
      throw e;
    }
  }

  async putParams(bytes: Uint8Array): Promise<void> {
    await this.d.put(this.ans, PARAMS_KEY, bytes, { size: bytes.byteLength });
  }

  async putGraph(bytes: Uint8Array): Promise<void> {
    await this.d.put(this.ans, GRAPH_KEY, bytes, { size: bytes.byteLength });
  }

  /** Removes both records, and whatever else the namespace holds. Works on a damaged namespace. */
  async clear(): Promise<void> {
    await this.d.clear(this.ans);
  }
}

// ---- resident state ---------------------------------------------------------------------------------

/** A graph resident in a kernel instance. */
export interface AnnLoaded {
  handle: number;
  kernel: Kernel;
  params: AnnParams;
  dim: number;
  nodes: number;
  liveNodes: number;
  generation: number;
  /** The graph record's length on the driver. */
  bytes: number;
}

export type AnnStatus = 'unknown' | 'absent' | 'loaded' | 'dropped';

export interface AnnState {
  readonly files: AnnFiles;
  status: AnnStatus;
  g: AnnLoaded | undefined;
  /** HEAD generations a rebuild already ran for (at most one per generation per open store). */
  readonly rebuiltAt: Set<number>;
  rebuilds: number;
  /** Position in the store's use order (BUG-T2-S6-08): set by every hnsw query, load, build and write. */
  used: number;
}

export type LoadResult =
  | { kind: 'ok'; g: AnnLoaded }
  | { kind: 'absent' }
  /**
   * The stored graph is fine but cannot be loaded into this store right now: the handle table is full and
   * every other resident graph is in use. Nothing was read as bad, deleted or rebuilt (BUG-T2-S6-08).
   */
  | { kind: 'busy' }
  | { kind: 'refused'; reason: string; params: AnnParams }
  | { kind: 'params_refused' };

/** The kernel refused to search a loaded graph against these rows (a graph that does not fit them). */
export class AnnRefusedError extends Error {
  override readonly name = 'AnnRefusedError';
  constructor(readonly code: number) {
    super('the HNSW graph does not fit the stored rows');
  }
}

function memoryError(): StorageError {
  return new StorageError(
    'quota_exceeded',
    'the vector kernel could not allocate WebAssembly memory for the graph',
    { reason: 'wasm_memory' },
  );
}

/**
 * The kernel keeps at most HNSW_MAX_GRAPHS graphs per instance (one instance per store) and reports a full
 * handle table with the same code as an exhausted heap. When this instance holds that many handles the
 * refusal is 'max_graphs'; otherwise it is the memory error it always was (BUG-T2-S6-03). Only a build
 * (buildIndex) refuses with it: a load makes room or reports 'busy' (BUG-T2-S6-08).
 */
function exhaustedError(kernel: Kernel): StorageError {
  if (kernel.hnswLiveHandles(HNSW_MAX_GRAPHS) >= HNSW_MAX_GRAPHS) return maxGraphsError();
  return memoryError();
}

function maxGraphsError(): StorageError {
  return new StorageError(
    'quota_exceeded',
    `this store already holds ${HNSW_MAX_GRAPHS} loaded HNSW graphs; drop the index of one namespace first`,
    { reason: 'max_graphs', maxGraphs: HNSW_MAX_GRAPHS },
  );
}

/** A block table (and the tombstone bitset) written into kernel memory for one call. */
export interface Lent {
  tablePtr: number;
  nBlocks: number;
  tombPtr: number;
  tombLen: number;
  free(): void;
}

/**
 * Lends the resident vectors of `idx` to the kernel: the block table `[firstRow, rows, vecPtr, normsPtr]`
 * for every loaded block, and, when any row is tombstoned, the HEAD bitset.
 */
export function lend(kernel: Kernel, idx: OpenIndex, withTomb: boolean): Lent {
  let n = 0;
  for (const s of idx.segments) n += s.blocks.length;
  const tableLen = n * 16;
  const tablePtr = n === 0 ? 0 : kernel.alloc(tableLen);
  let tombPtr = 0;
  const tombLen = withTomb && idx.liveRows !== idx.totalRows ? idx.tomb.byteLength : 0;
  try {
    if (n > 0) {
      const w = kernel.u32(tablePtr, n * 4);
      let i = 0;
      for (const s of idx.segments) {
        for (const b of s.blocks) {
          w[i++] = s.firstRow + b.start;
          w[i++] = b.rows;
          w[i++] = b.ptr;
          w[i++] = s.metaPtr + b.start * 4;
        }
      }
    }
    if (tombLen > 0) {
      tombPtr = kernel.alloc(tombLen);
      kernel.u8(tombPtr, tombLen).set(idx.tomb);
    }
  } catch (e) {
    if (tablePtr !== 0) kernel.free(tablePtr, tableLen);
    throw e;
  }
  return {
    tablePtr,
    nBlocks: n,
    tombPtr,
    tombLen,
    free: () => {
      if (tablePtr !== 0) kernel.free(tablePtr, tableLen);
      if (tombPtr !== 0) kernel.free(tombPtr, tombLen);
    },
  };
}

export interface AnnInfoWords {
  metric: number;
  m: number;
  efConstruction: number;
  seed: number;
  dim: number;
  nodes: number;
  liveNodes: number;
  generation: number;
  entry: number;
  maxLevel: number;
  serialisedBytes: number;
}

export interface AnnHit {
  row: number;
  score: number;
}

export interface AnnManagerOptions {
  driver: StorageDriver & DriverHooks;
  events: StorageEvents;
  /** The largest graph record this store will read. */
  maxBytes: number;
  kernelKind(): string;
  /**
   * True while the store is running, or has queued, any operation on `ns` (a query, a write holding the
   * writer lock, a build, a rebuild): its resident graph handle may be in use and is never evicted.
   */
  busy(ns: string): boolean;
}

/** Per-store registry of graphs and the kernel-level operations on them. */
export class AnnManager {
  private readonly states = new Map<string, AnnState>();
  private tick = 0;
  /**
   * One-shot seam, run with the kernel before the next kernel call of the graph code and then cleared.
   * Only the test hook module sets it (BUG-T2-S6-07, -12); it is not part of the package.
   */
  beforeGraphCall: ((kernel: Kernel) => void) | undefined;

  constructor(private readonly o: AnnManagerOptions) {}

  state(ns: string): AnnState {
    let s = this.states.get(ns);
    if (!s) {
      s = {
        files: new AnnFiles(this.o.driver, ns),
        status: 'unknown',
        g: undefined,
        rebuiltAt: new Set(),
        rebuilds: 0,
        used: 0,
      };
      this.states.set(ns, s);
    }
    return s;
  }

  /** Runs the one-shot seam (if set) before a kernel call of the graph code. */
  private arm(kernel: Kernel): void {
    const hook = this.beforeGraphCall;
    if (hook !== undefined) {
      this.beforeGraphCall = undefined;
      hook(kernel);
    }
  }

  /** Marks `ns` as the most recently used graph of this store. */
  touch(ns: string): void {
    this.state(ns).used = ++this.tick;
  }

  /**
   * The namespace whose resident graph (in `kernel`) is least recently used and idle, never `except`; undefined
   * when every resident graph belongs to a namespace with an operation running or queued.
   */
  private lruVictim(except: string, kernel: Kernel): string | undefined {
    let victim: string | undefined;
    let oldest = Infinity;
    for (const [ns, s] of this.states) {
      if (ns === except || s.g === undefined || s.g.kernel !== kernel || this.o.busy(ns)) continue;
      if (s.used < oldest) {
        victim = ns;
        oldest = s.used;
      }
    }
    return victim;
  }

  /**
   * `call` (a kernel call that needs a handle) answered E_HNSW_MEMORY. While the handle table is full, releases
   * the least recently used idle graph of another namespace and calls again. Releasing keeps the stored
   * record: the next query of that namespace loads it again. Returns the last answer, which is still
   * E_HNSW_MEMORY when nothing could be released (every resident graph is in use) or when the heap, not the
   * table, is exhausted.
   */
  private retryAfterEviction(ns: string, kernel: Kernel, call: () => number): number {
    let h = E_HNSW_MEMORY;
    while (h === E_HNSW_MEMORY && kernel.hnswLiveHandles(HNSW_MAX_GRAPHS) >= HNSW_MAX_GRAPHS) {
      const victim = this.lruVictim(ns, kernel);
      if (victim === undefined) break;
      this.release(victim);
      h = call();
    }
    return h;
  }

  /** Frees the resident graph of a namespace, if its kernel is still alive. The state becomes 'unknown'. */
  release(ns: string): void {
    const s = this.states.get(ns);
    if (!s) return;
    if (s.g) s.g.kernel.hnswFree(s.g.handle);
    s.g = undefined;
    if (s.status === 'loaded') s.status = 'unknown';
  }

  /** The kernel instance was discarded: every handle died with it. Sticky refusals stay. */
  onKernelDiscarded(): void {
    for (const s of this.states.values()) {
      s.g = undefined;
      if (s.status === 'loaded') s.status = 'unknown';
    }
  }

  dispose(): void {
    for (const ns of [...this.states.keys()]) this.release(ns);
    this.states.clear();
  }

  /** Bytes of the graphs resident in this store (record bytes plus the params record), optionally except one ns. */
  residentBytes(except?: string): number {
    let n = 0;
    for (const [ns, s] of this.states) if (s.g && ns !== except) n += s.g.bytes + PARAMS_BYTES;
    return n;
  }

  /** The resident graph bytes of one namespace, 0 when none. */
  residentBytesOf(ns: string): number {
    const g = this.states.get(ns)?.g;
    return g ? g.bytes + PARAMS_BYTES : 0;
  }

  // ---- kernel calls -------------------------------------------------------------------------------

  info(kernel: Kernel, handle: number): AnnInfoWords {
    const p = kernel.alloc(HNSW_INFO_WORDS * 4);
    try {
      const rc = kernel.hnswInfo(handle, p);
      if (rc !== 0)
        throw new StorageError('io', 'the vector kernel rejected its arguments (graph info)');
      const w = kernel.u32(p, HNSW_INFO_WORDS);
      return {
        metric: w[0]!,
        m: w[1]!,
        efConstruction: w[2]!,
        seed: w[3]!,
        dim: w[4]!,
        nodes: w[5]!,
        liveNodes: w[6]!,
        generation: w[7]!,
        entry: w[8]!,
        maxLevel: w[9]!,
        serialisedBytes: w[10]! + w[11]! * 2 ** 32,
      };
    } finally {
      kernel.free(p, HNSW_INFO_WORDS * 4);
    }
  }

  /**
   * Builds a graph over the live rows of `idx` (or an empty graph when the namespace has no flat index).
   * Returns the kernel handle; the caller owns it. A full handle table is refused with 'max_graphs' (the
   * normative buildIndex behaviour); only the SDK's own rebuild of a refused graph passes `evict`, which
   * makes room by releasing the least recently used idle graph of another namespace first.
   */
  build(
    kernel: Kernel,
    idx: OpenIndex | undefined,
    ns: string,
    p: AnnParams,
    evict = false,
  ): number {
    this.arm(kernel);
    const nsb = ENC.encode(ns);
    const nsPtr = kernel.alloc(nsb.length);
    const lent = idx ? lend(kernel, idx, true) : undefined;
    try {
      kernel.u8(nsPtr, nsb.length).set(nsb);
      const call = () =>
        kernel.hnswBuild(
          lent?.tablePtr ?? 0,
          lent?.nBlocks ?? 0,
          idx?.totalRows ?? 0,
          idx?.dim ?? 0,
          lent?.tombPtr ?? 0,
          lent?.tombLen ?? 0,
          nsPtr,
          nsb.length,
          p.metric,
          p.m,
          p.efConstruction,
          p.seed,
          idx?.generation ?? 0,
        );
      let h = call();
      if (
        h === E_HNSW_MEMORY &&
        this.states.get(ns)?.g?.kernel === kernel &&
        kernel.hnswLiveHandles(HNSW_MAX_GRAPHS) >= HNSW_MAX_GRAPHS
      ) {
        // The handle table is full, but this namespace's own resident graph is about to be replaced: let
        // its handle go and try once more. The stored record stays; if this build fails, the next query
        // loads it again.
        this.release(ns);
        h = call();
      }
      if (h === E_HNSW_MEMORY && evict) h = this.retryAfterEviction(ns, kernel, call);
      if (h === E_HNSW_MEMORY) throw exhaustedError(kernel);
      if (h < 0) {
        throw new StorageError('io', 'the vector kernel refused to build the graph', {
          reason: HNSW_REASONS[h] ?? (h === E_ARGS ? 'args' : 'build'),
        });
      }
      return h;
    } finally {
      kernel.free(nsPtr, nsb.length);
      lent?.free();
    }
  }

  serialize(kernel: Kernel, handle: number): Uint8Array {
    const len = kernel.hnswSerializeLen(handle);
    if (len === E_HNSW_MEMORY) throw memoryError();
    if (len <= 0) throw new StorageError('io', 'the vector kernel could not size the graph');
    const p = kernel.alloc(len);
    try {
      const rc = kernel.hnswSerialize(handle, p, len);
      if (rc !== 0) throw new StorageError('io', 'the vector kernel could not serialise the graph');
      return kernel.u8(p, len).slice();
    } finally {
      kernel.free(p, len);
    }
  }

  /** Makes a freshly built (and written) kernel graph the resident graph of `ns`. */
  adopt(ns: string, kernel: Kernel, handle: number, params: AnnParams, bytes: number): AnnLoaded {
    const s = this.state(ns);
    this.release(ns);
    const i = this.info(kernel, handle);
    const g: AnnLoaded = {
      handle,
      kernel,
      params,
      dim: i.dim,
      nodes: i.nodes,
      liveNodes: i.liveNodes,
      generation: i.generation,
      bytes,
    };
    s.g = g;
    s.status = 'loaded';
    this.touch(ns);
    return g;
  }

  /**
   * Reads, validates and loads the stored graph of `ns` against the flat HEAD (`idx`, or undefined for a
   * namespace without a flat index). Emits one storage.index.open event of kind 'hnsw' for a graph that was
   * present (none when `quiet`). Throws only for a trap, memory exhaustion or a driver failure. A full
   * handle table is never an error here (BUG-T2-S6-08): the least recently used idle graph of another
   * namespace is released to make room, and when every other resident graph is in use the result is 'busy'.
   */
  async load(
    ns: string,
    idx: OpenIndex | undefined,
    kernel: Kernel,
    quiet = false,
  ): Promise<LoadResult> {
    const s = this.state(ns);
    this.release(ns);
    this.o.driver.refreshIndex?.(s.files.ans);
    const t0 = this.o.events.start();
    const graph = await s.files.readGraph(this.o.maxBytes);
    if (graph.kind === 'absent') {
      s.status = 'absent';
      return { kind: 'absent' };
    }
    const raw = await s.files.readParams();
    const params = raw === undefined ? undefined : decodeParams(raw);
    const open = (outcome: string, reason: string, rows: number, bytes: number) => {
      if (!quiet) {
        this.o.events.indexOpen(
          t0,
          ns,
          outcome,
          rows,
          0,
          reason,
          this.o.kernelKind(),
          bytes,
          0,
          'hnsw',
        );
      }
    };
    if (params === undefined) {
      // A graph without usable params cannot be rebuilt: the whole index is refused (reason 'bounds').
      open('corrupt', 'bounds', 0, graph.kind === 'ok' ? graph.bytes.byteLength : 0);
      return { kind: 'params_refused' };
    }
    if (graph.kind === 'size') {
      open('corrupt', 'length', 0, 0);
      return { kind: 'refused', reason: 'length', params };
    }
    const bytes = graph.bytes;
    this.arm(kernel);
    const nsb = ENC.encode(ns);
    const gp = bytes.byteLength > 0 ? kernel.alloc(bytes.byteLength) : 0;
    const np = kernel.alloc(nsb.length);
    let handle: number;
    try {
      if (gp !== 0) kernel.u8(gp, bytes.byteLength).set(bytes);
      kernel.u8(np, nsb.length).set(nsb);
      const call = () =>
        kernel.hnswLoad(
          gp,
          bytes.byteLength,
          idx?.dim ?? 0,
          idx?.totalRows ?? 0,
          idx?.generation ?? 0,
          np,
          nsb.length,
        );
      handle = call();
      if (handle === E_HNSW_MEMORY) handle = this.retryAfterEviction(ns, kernel, call);
    } finally {
      if (gp !== 0) kernel.free(gp, bytes.byteLength);
      kernel.free(np, nsb.length);
    }
    if (handle === E_HNSW_MEMORY) {
      // Still no room. A full table with every other graph in use is not a fault of this graph: it stays
      // stored and untouched. Anything else is the heap running out.
      if (kernel.hnswLiveHandles(HNSW_MAX_GRAPHS) >= HNSW_MAX_GRAPHS) return { kind: 'busy' };
      throw memoryError();
    }
    if (handle < 0) {
      const reason = HNSW_REASONS[handle];
      if (reason === undefined) {
        throw new StorageError('io', 'the vector kernel rejected its arguments (graph load)');
      }
      open('corrupt', reason, 0, bytes.byteLength);
      return { kind: 'refused', reason, params };
    }
    const i = this.info(kernel, handle);
    if (
      i.metric !== params.metric ||
      i.m !== params.m ||
      i.efConstruction !== params.efConstruction ||
      i.seed !== params.seed
    ) {
      kernel.hnswFree(handle);
      open('corrupt', 'bounds', 0, bytes.byteLength);
      return { kind: 'refused', reason: 'bounds', params };
    }
    const g: AnnLoaded = {
      handle,
      kernel,
      params,
      dim: i.dim,
      nodes: i.nodes,
      liveNodes: i.liveNodes,
      generation: i.generation,
      bytes: bytes.byteLength,
    };
    s.g = g;
    s.status = 'loaded';
    this.touch(ns);
    open('ok', '', i.nodes, bytes.byteLength);
    return { kind: 'ok', g };
  }

  /**
   * Searches `g` for the `ef` best live rows for `q`. Liveness is the flat HEAD tombstone bitset; every
   * ordinal is checked below the HEAD row count here as well. Hits come back best first with the flat
   * scan's score.
   */
  search(kernel: Kernel, idx: OpenIndex, g: AnnLoaded, q: Float32Array, ef: number): AnnHit[] {
    this.arm(kernel);
    const lent = lend(kernel, idx, true);
    const qBytes = q.length * 4;
    const qPtr = kernel.alloc(qBytes);
    const outBytes = ef * 8;
    const outPtr = kernel.alloc(outBytes);
    try {
      kernel.f32(qPtr, q.length).set(q);
      const n = kernel.hnswSearch(
        g.handle,
        lent.tablePtr,
        lent.nBlocks,
        idx.totalRows,
        lent.tombPtr,
        lent.tombLen,
        qPtr,
        ef,
        outPtr,
        ef,
      );
      if (n === E_HNSW_MEMORY) throw memoryError();
      if (n < 0) throw new AnnRefusedError(n);
      const u = kernel.u32(outPtr, n * 2);
      const f = kernel.f32(outPtr, n * 2);
      const hits: AnnHit[] = [];
      for (let i = 0; i < n; i++) {
        const row = u[2 * i]!;
        if (row < idx.totalRows) hits.push({ row, score: f[2 * i + 1]! });
      }
      return hits;
    } finally {
      lent.free();
      kernel.free(qPtr, qBytes);
      kernel.free(outPtr, outBytes);
    }
  }

  /** Marks the node of `row` deleted. True when a live node was marked. */
  markDeleted(kernel: Kernel, g: AnnLoaded, row: number): boolean {
    this.arm(kernel);
    const rc = kernel.hnswMarkDeleted(g.handle, row);
    if (rc < 0) throw new AnnRefusedError(rc);
    return rc === 1;
  }

  /** Inserts the nodes of rows `first .. first + count - 1` (already resident in `idx`). */
  insert(kernel: Kernel, idx: OpenIndex, g: AnnLoaded, first: number, count: number): void {
    this.arm(kernel);
    const lent = lend(kernel, idx, false);
    try {
      const rc = kernel.hnswInsert(
        g.handle,
        lent.tablePtr,
        lent.nBlocks,
        idx.totalRows,
        first,
        count,
      );
      if (rc === E_HNSW_MEMORY) throw memoryError();
      if (rc < 0) throw new AnnRefusedError(rc);
    } finally {
      lent.free();
    }
  }

  setGeneration(kernel: Kernel, g: AnnLoaded, generation: number): void {
    this.arm(kernel);
    const rc = kernel.hnswSetGeneration(g.handle, generation);
    if (rc < 0) throw new AnnRefusedError(rc);
  }

  /** Removes both records of `ns` and forgets the resident graph. True when anything was stored. */
  async remove(ns: string): Promise<boolean> {
    const s = this.state(ns);
    this.release(ns);
    const existed = await s.files.exists();
    if (existed) await s.files.clear();
    s.status = 'absent';
    return existed;
  }
}
