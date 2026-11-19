// The ldvec WASM kernel behind a typed boundary. One instance per store, instantiated lazily; never
// shared between stores and never reused after a trap.
//
// Rules this file enforces (Storage API 0.2.0, D4-03):
//   * Views are re-taken from memory.buffer on every use: any allocation may grow memory and detach
//     the old ArrayBuffer.
//   * ldv_alloc returning 0 is a StorageError quota_exceeded with reason 'wasm_memory'.
//   * Any WebAssembly.RuntimeError (a trap) marks the instance dead and surfaces as KernelTrapError;
//     the caller discards everything that pointed into this instance's memory.
//   * Offsets and lengths handed to WASM are u32: callers check Number.isSafeInteger and range first
//     (assertU32); values that come back from WASM are used as returned.
import { StorageError } from '../contracts/storage-api';
import { LDVEC_SCALAR_B64, LDVEC_SIMD_B64 } from '../wasm/ldvec.gen';

export type KernelKind = 'simd' | 'scalar';
export type KernelChoice = 'auto' | KernelKind;

/** The kernel error codes returned by ldv_parse_head and ldv_check_meta. */
export const KERNEL_REASONS: Readonly<Record<number, string>> = Object.freeze({
  [-1]: 'magic',
  [-2]: 'version',
  [-3]: 'dtype',
  [-4]: 'dim',
  [-5]: 'length',
  [-6]: 'crc',
  [-7]: 'reserved',
  [-8]: 'count',
  [-9]: 'segment_order',
  [-10]: 'tombstone_padding',
  [-11]: 'offsets',
  [-12]: 'utf8',
  [-13]: 'key_length',
  [-14]: 'too_large',
});

/** Returned by the kernel for an out-of-range or misaligned pointer; no format code uses it. */
export const E_ARGS = -100;

/**
 * The HNSW graph error codes (docs/hnsw-format.md). The reasons are the `reason` values of a
 * storage.index.open event for a refused graph (-30 is memory exhaustion, not a refusal).
 */
export const HNSW_REASONS: Readonly<Record<number, string>> = Object.freeze({
  [-20]: 'magic',
  [-21]: 'version',
  [-22]: 'length',
  [-23]: 'dim',
  [-24]: 'ns',
  [-25]: 'generation',
  [-26]: 'bounds',
  [-27]: 'links',
  [-28]: 'crc',
});
/** Returned when an allocation inside the kernel failed (reported as quota_exceeded, 'wasm_memory'). */
export const E_HNSW_MEMORY = -30;
/** u32 words ldv_hnsw_info writes. */
export const HNSW_INFO_WORDS = 12;

/** u32 words ldv_parse_head writes before the segment entries, and per entry. */
export const HEAD_OUT_WORDS = 12;
export const SEG_OUT_WORDS = 8;
export const SEG_MAX = 4096;
export const HEAD_OUT_BYTES = (HEAD_OUT_WORDS + SEG_OUT_WORDS * SEG_MAX) * 4;

/** A trap inside the module: the instance is dead and must be discarded. */
export class KernelTrapError extends Error {
  override readonly name = 'KernelTrapError';
  constructor() {
    super('the vector kernel trapped; its WebAssembly instance was discarded');
  }
}

interface Exports {
  memory: WebAssembly.Memory;
  ldv_alloc(len: number): number;
  ldv_free(ptr: number, len: number): void;
  ldv_crc32c(prev: number, ptr: number, len: number): number;
  ldv_check_rows(vecPtr: number, rows: number, dim: number): number;
  ldv_inv_norms(vecPtr: number, rows: number, dim: number, outPtr: number): number;
  ldv_scan(
    vecPtr: number,
    rows: number,
    dim: number,
    normsPtr: number,
    qPtr: number,
    qInvNorm: number,
    metric: number,
    outPtr: number,
  ): number;
  ldv_parse_head(ptr: number, len: number, outPtr: number): number;
  ldv_check_meta(
    ptr: number,
    len: number,
    rows: number,
    keyBytesLen: number,
    valueBytesLen: number,
  ): number;
  ldv_simd(): number;
  ldv_hnsw_build(
    tablePtr: number,
    nBlocks: number,
    total: number,
    dim: number,
    tombPtr: number,
    tombLen: number,
    nsPtr: number,
    nsLen: number,
    metric: number,
    m: number,
    efConstruction: number,
    seed: number,
    generation: number,
  ): number;
  ldv_hnsw_load(
    ptr: number,
    len: number,
    dim: number,
    rows: number,
    headGeneration: number,
    nsPtr: number,
    nsLen: number,
  ): number;
  ldv_hnsw_info(handle: number, outPtr: number): number;
  ldv_hnsw_insert(
    handle: number,
    tablePtr: number,
    nBlocks: number,
    total: number,
    first: number,
    count: number,
  ): number;
  ldv_hnsw_mark_deleted(handle: number, ordinal: number): number;
  ldv_hnsw_set_generation(handle: number, generation: number): number;
  ldv_hnsw_search(
    handle: number,
    tablePtr: number,
    nBlocks: number,
    total: number,
    tombPtr: number,
    tombLen: number,
    qPtr: number,
    ef: number,
    outPtr: number,
    outCap: number,
  ): number;
  ldv_hnsw_serialize_len(handle: number): number;
  ldv_hnsw_serialize(handle: number, outPtr: number, outLen: number): number;
  ldv_hnsw_free(handle: number): void;
}

// A v128 module that only validates when the engine supports WebAssembly SIMD.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

export function simdSupported(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const compiled = new Map<KernelKind, Promise<WebAssembly.Module>>();
function compile(kind: KernelKind): Promise<WebAssembly.Module> {
  let p = compiled.get(kind);
  if (!p) {
    p = WebAssembly.compile(base64ToBytes(kind === 'simd' ? LDVEC_SIMD_B64 : LDVEC_SCALAR_B64));
    // A failed compile must not be cached forever.
    p.catch(() => compiled.delete(kind));
    compiled.set(kind, p);
  }
  return p;
}

export function resolveKernelKind(choice: KernelChoice): KernelKind {
  if (choice === 'scalar') return 'scalar';
  if (choice === 'simd') {
    if (!simdSupported()) {
      throw new StorageError(
        'driver_unavailable',
        'vectorKernel "simd" was requested but this engine does not support WebAssembly SIMD',
      );
    }
    return 'simd';
  }
  return simdSupported() ? 'simd' : 'scalar';
}

/** Throws unless n is a safe integer in [0, 2^32 - 1]. */
export function assertU32(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new StorageError('invalid_value', `${what} does not fit the vector kernel`, { what });
  }
}

export class Kernel {
  private dead = false;
  private trapAfter: number | undefined;
  private trapOnHnsw = false;

  private constructor(
    readonly kind: KernelKind,
    private readonly x: Exports,
  ) {}

  static async create(choice: KernelChoice = 'auto'): Promise<Kernel> {
    const kind = resolveKernelKind(choice);
    const module = await compile(kind);
    const instance = await WebAssembly.instantiate(module, {});
    return new Kernel(kind, instance.exports as unknown as Exports);
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** Total WebAssembly linear memory of this instance, in bytes. */
  memoryBytes(): number {
    return this.x.memory.buffer.byteLength;
  }

  private callHnsw<T>(fn: () => T): T {
    return this.call(() => {
      if (this.trapOnHnsw) {
        this.trapOnHnsw = false;
        this.x.ldv_crc32c(0, 0x7fff_fff0, 64);
      }
      return fn();
    });
  }

  private call<T>(fn: () => T): T {
    if (this.dead) throw new KernelTrapError();
    try {
      if (this.trapAfter !== undefined) {
        if (this.trapAfter === 0) {
          this.trapAfter = undefined;
          // A real trap: a read far beyond linear memory. ldv_crc32c deliberately does not pre-check.
          this.x.ldv_crc32c(0, 0x7fff_fff0, 64);
        } else {
          this.trapAfter--;
        }
      }
      return fn();
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        this.dead = true;
        throw new KernelTrapError();
      }
      throw e;
    }
  }

  // ---- memory -----------------------------------------------------------------------------------

  /** Allocates len bytes; a failure (memory cannot grow) is quota_exceeded 'wasm_memory'. */
  alloc(len: number): number {
    assertU32(len, 'allocation length');
    const ptr = this.call(() => this.x.ldv_alloc(len)) >>> 0;
    if (ptr === 0) {
      throw new StorageError(
        'quota_exceeded',
        'the vector kernel could not allocate WebAssembly memory',
        { reason: 'wasm_memory', bytes: len },
      );
    }
    return ptr;
  }

  free(ptr: number, len: number): void {
    if (this.dead || ptr === 0) return;
    try {
      this.x.ldv_free(ptr, len);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) this.dead = true;
      else throw e;
    }
  }

  u8(ptr: number, len: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.x.memory.buffer as ArrayBuffer, ptr, len);
  }
  f32(ptr: number, n: number): Float32Array<ArrayBuffer> {
    return new Float32Array(this.x.memory.buffer as ArrayBuffer, ptr, n);
  }
  u32(ptr: number, n: number): Uint32Array<ArrayBuffer> {
    return new Uint32Array(this.x.memory.buffer as ArrayBuffer, ptr, n);
  }

  // ---- kernel functions -------------------------------------------------------------------------

  simd(): number {
    return this.call(() => this.x.ldv_simd());
  }

  crc32c(prev: number, ptr: number, len: number): number {
    assertU32(len, 'crc length');
    return this.call(() => this.x.ldv_crc32c(prev >>> 0, ptr, len)) >>> 0;
  }

  /** -1 when every row is finite with selfDot <= 1e30, else the first bad row; E_ARGS for bad arguments. */
  checkRows(ptr: number, rows: number, dim: number): number {
    assertU32(rows, 'rows');
    return this.call(() => this.x.ldv_check_rows(ptr, rows, dim));
  }

  invNorms(vecPtr: number, rows: number, dim: number, outPtr: number): number {
    assertU32(rows, 'rows');
    return this.call(() => this.x.ldv_inv_norms(vecPtr, rows, dim, outPtr));
  }

  scan(
    vecPtr: number,
    rows: number,
    dim: number,
    normsPtr: number,
    qPtr: number,
    qInvNorm: number,
    metric: 0 | 1,
    outPtr: number,
  ): number {
    assertU32(rows, 'rows');
    return this.call(() =>
      this.x.ldv_scan(vecPtr, rows, dim, normsPtr, qPtr, qInvNorm, metric, outPtr),
    );
  }

  parseHead(ptr: number, len: number, outPtr: number): number {
    assertU32(len, 'head length');
    return this.call(() => this.x.ldv_parse_head(ptr, len, outPtr));
  }

  checkMeta(ptr: number, len: number, rows: number, keyBytesLen: number, valueBytesLen: number) {
    assertU32(len, 'meta length');
    return this.call(() => this.x.ldv_check_meta(ptr, len, rows, keyBytesLen, valueBytesLen));
  }

  // ---- HNSW (docs/hnsw-format.md) ---------------------------------------------------------------
  //
  // A graph is an integer handle (> 0) into the instance; a negative return is a code (HNSW_REASONS,
  // E_HNSW_MEMORY, E_ARGS). The vectors are lent through a block table of u32 words
  // [firstRow, rows, vecPtr, normsPtr] covering rows 0..total.

  hnswBuild(
    tablePtr: number,
    nBlocks: number,
    total: number,
    dim: number,
    tombPtr: number,
    tombLen: number,
    nsPtr: number,
    nsLen: number,
    metric: number,
    m: number,
    efConstruction: number,
    seed: number,
    generation: number,
  ): number {
    assertU32(total, 'rows');
    return this.callHnsw(() =>
      this.x.ldv_hnsw_build(
        tablePtr,
        nBlocks,
        total,
        dim,
        tombPtr,
        tombLen,
        nsPtr,
        nsLen,
        metric,
        m,
        efConstruction,
        seed,
        generation,
      ),
    );
  }

  hnswLoad(
    ptr: number,
    len: number,
    dim: number,
    rows: number,
    headGeneration: number,
    nsPtr: number,
    nsLen: number,
  ): number {
    assertU32(len, 'graph length');
    assertU32(rows, 'rows');
    return this.callHnsw(() =>
      this.x.ldv_hnsw_load(ptr, len, dim, rows, headGeneration, nsPtr, nsLen),
    );
  }

  hnswInfo(handle: number, outPtr: number): number {
    return this.callHnsw(() => this.x.ldv_hnsw_info(handle, outPtr));
  }

  /**
   * How many graph handles (1..max) this instance holds right now, found by asking the kernel about each
   * handle number. The kernel answers a full handle table and an exhausted heap with the same code
   * (E_HNSW_MEMORY); the caller uses this on that failure path only, to tell them apart (BUG-T2-S6-03),
   * so the `max` calls cost nothing that matters. Returns -1 when the scratch buffer cannot be allocated
   * (memory really is exhausted). A trap propagates as KernelTrapError.
   */
  hnswLiveHandles(max: number): number {
    let p: number;
    try {
      p = this.alloc(HNSW_INFO_WORDS * 4);
    } catch (e) {
      if (e instanceof StorageError) return -1;
      throw e;
    }
    try {
      let live = 0;
      for (let h = 1; h <= max; h++) if (this.hnswInfo(h, p) === 0) live++;
      return live;
    } finally {
      this.free(p, HNSW_INFO_WORDS * 4);
    }
  }

  hnswInsert(
    handle: number,
    tablePtr: number,
    nBlocks: number,
    total: number,
    first: number,
    count: number,
  ): number {
    assertU32(total, 'rows');
    return this.callHnsw(() =>
      this.x.ldv_hnsw_insert(handle, tablePtr, nBlocks, total, first, count),
    );
  }

  hnswMarkDeleted(handle: number, ordinal: number): number {
    assertU32(ordinal, 'ordinal');
    return this.callHnsw(() => this.x.ldv_hnsw_mark_deleted(handle, ordinal));
  }

  hnswSetGeneration(handle: number, generation: number): number {
    assertU32(generation, 'generation');
    return this.callHnsw(() => this.x.ldv_hnsw_set_generation(handle, generation));
  }

  hnswSearch(
    handle: number,
    tablePtr: number,
    nBlocks: number,
    total: number,
    tombPtr: number,
    tombLen: number,
    qPtr: number,
    ef: number,
    outPtr: number,
    outCap: number,
  ): number {
    assertU32(total, 'rows');
    assertU32(tombLen, 'tombstone length');
    return this.callHnsw(() =>
      this.x.ldv_hnsw_search(
        handle,
        tablePtr,
        nBlocks,
        total,
        tombPtr,
        tombLen,
        qPtr,
        ef,
        outPtr,
        outCap,
      ),
    );
  }

  hnswSerializeLen(handle: number): number {
    return this.callHnsw(() => this.x.ldv_hnsw_serialize_len(handle));
  }

  hnswSerialize(handle: number, outPtr: number, outLen: number): number {
    assertU32(outLen, 'graph length');
    return this.callHnsw(() => this.x.ldv_hnsw_serialize(handle, outPtr, outLen));
  }

  /** Frees a graph. Never throws: a dead instance already lost it. */
  hnswFree(handle: number): void {
    if (this.dead || handle <= 0) return;
    try {
      this.x.ldv_hnsw_free(handle);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) this.dead = true;
      else throw e;
    }
  }
}
