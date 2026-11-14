// Resident state of one vector index and the bounded, validating reader that builds it.
//
// Loading is staged so a writer never has to read vectors: loadMeta() reads HEAD and every META blob
// (keys, norms, value tables); loadVec() reads the vector parts into WebAssembly memory. Nothing is
// queried until both stages finished: a partially loaded index is never exposed.
//
// Bounds: the HEAD record is size-checked before it is copied anywhere; the whole index is checked
// against maxIndexBytes BEFORE any block is allocated; WebAssembly memory only grows after a part's
// actual length equals the length the (validated) HEAD says it must have; every length that reaches
// the kernel is a safe u32.
import { decode } from '../codec';
import { StorageError, type StorableValue } from '../contracts/storage-api';
import {
  E_ARGS,
  HEAD_OUT_BYTES,
  HEAD_OUT_WORDS,
  KERNEL_REASONS,
  SEG_OUT_WORDS,
  type Kernel,
} from './kernel';
import {
  META_PART_BYTES,
  VAL_PART_BYTES,
  corrupt,
  metaLength,
  partName,
  rowsPerVecPart,
  splitLengths,
  vecPartLengths,
  type VecFiles,
} from './files';

/** A HEAD record longer than this is refused before parsing (64 + 32 * 4096 + 524288 + 4). */
export const HEAD_MAX_BYTES = 64 + 32 * 4096 + 524_288 + 4;
const VALUE_CACHE_PARTS = 16;
const TEXT = new TextDecoder('utf-8', { ignoreBOM: true });

export interface Block {
  ptr: number;
  rows: number;
  /** Bytes allocated at ptr (rows * dim * 4). */
  bytes: number;
  /** First row of this block within its segment. */
  start: number;
}

export interface Segment {
  segId: number;
  rows: number;
  /** Global row number of this segment's first row. */
  firstRow: number;
  keyBytesLen: number;
  valueBytesLen: number;
  vecCrc: number;
  metaCrc: number;
  /** The segment's META blob in WebAssembly memory (norms are its first rows * 4 bytes). */
  metaPtr: number;
  metaLen: number;
  /** Empty until loadVec() has verified every vector part of the segment. */
  blocks: Block[];
}

export interface ParsedHead {
  dim: number;
  totalRows: number;
  liveRows: number;
  nextSegId: number;
  generation: number;
  vecBytes: number;
  metaBytes: number;
  segs: Array<Omit<Segment, 'metaPtr' | 'metaLen' | 'blocks'>>;
  tomb: Uint8Array;
}

export interface LoadCtx {
  kernel: Kernel;
  files: VecFiles;
  ns: string;
  maxIndexBytes: number;
}

function internal(what: string): StorageError {
  return new StorageError('io', `the vector kernel rejected its arguments (${what})`);
}

/** Validates a HEAD record with the kernel and returns its fields. Throws corrupt on any failure. */
export function parseHead(ctx: LoadCtx, bytes: Uint8Array): ParsedHead {
  const { kernel, ns } = ctx;
  if (bytes.byteLength > HEAD_MAX_BYTES) throw corrupt(ns, 'head', 'too_large');
  const inPtr = bytes.byteLength > 0 ? kernel.alloc(bytes.byteLength) : 0;
  const outPtr = kernel.alloc(HEAD_OUT_BYTES);
  try {
    if (inPtr !== 0) kernel.u8(inPtr, bytes.byteLength).set(bytes);
    const rc = kernel.parseHead(inPtr, bytes.byteLength, outPtr);
    if (rc === E_ARGS) throw internal('head');
    if (rc < 0) throw corrupt(ns, 'head', KERNEL_REASONS[rc] ?? 'head');
    const segCount = kernel.u32(outPtr, HEAD_OUT_WORDS)[1]!;
    const w = kernel.u32(outPtr, HEAD_OUT_WORDS + SEG_OUT_WORDS * segCount);
    const segs: ParsedHead['segs'] = [];
    for (let i = 0; i < segCount; i++) {
      const o = HEAD_OUT_WORDS + SEG_OUT_WORDS * i;
      segs.push({
        segId: w[o]!,
        rows: w[o + 1]!,
        firstRow: w[o + 2]!,
        keyBytesLen: w[o + 3]!,
        valueBytesLen: w[o + 4]!,
        vecCrc: w[o + 5]!,
        metaCrc: w[o + 6]!,
      });
    }
    const tombOff = w[10]!;
    return {
      dim: w[0]!,
      totalRows: w[2]!,
      liveRows: w[3]!,
      nextSegId: w[4]!,
      generation: w[5]!,
      vecBytes: w[6]! + w[7]! * 2 ** 32,
      metaBytes: w[8]! + w[9]! * 2 ** 32,
      segs,
      tomb: bytes.slice(tombOff, bytes.byteLength - 4),
    };
  } finally {
    kernel.free(inPtr, bytes.byteLength);
    kernel.free(outPtr, HEAD_OUT_BYTES);
  }
}

/** The resident index. Mutated in place by the writer after a commit; disposed on reload or close. */
export class OpenIndex {
  dim = 0;
  totalRows = 0;
  liveRows = 0;
  nextSegId = 0;
  generation = 0;
  vecBytes = 0;
  metaBytes = 0;
  valueBytes = 0;
  headBytes: Uint8Array = new Uint8Array(0);
  tomb: Uint8Array = new Uint8Array(0);
  segments: Segment[] = [];
  /** Global row -> key (tombstoned rows included). */
  keys: string[] = [];
  /** Live key -> global row. */
  live = new Map<string, number>();
  vecLoaded = false;
  private readonly valueCache = new Map<string, Uint8Array>();
  private disposed = false;

  constructor(readonly kernel: Kernel) {}

  /** Bytes on the driver for this index: HEAD, vector, META (with keys) and value parts. */
  get bytes(): number {
    return this.headBytes.byteLength + this.vecBytes + this.metaBytes + this.valueBytes;
  }

  isDeleted(row: number): boolean {
    return (this.tomb[row >> 3]! & (1 << (row & 7))) !== 0;
  }

  /** The segment holding a global row (binary search on firstRow). */
  segmentOf(row: number): Segment {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid]!.firstRow <= row) lo = mid;
      else hi = mid - 1;
    }
    return this.segments[lo]!;
  }

  cacheGet(key: string): Uint8Array | undefined {
    const v = this.valueCache.get(key);
    if (v !== undefined) {
      this.valueCache.delete(key);
      this.valueCache.set(key, v);
    }
    return v;
  }

  cachePut(key: string, bytes: Uint8Array): void {
    this.valueCache.set(key, bytes);
    while (this.valueCache.size > VALUE_CACHE_PARTS) {
      const oldest = this.valueCache.keys().next().value as string;
      this.valueCache.delete(oldest);
    }
  }

  /** Frees every block this index holds in WebAssembly memory. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.segments) {
      this.kernel.free(s.metaPtr, s.metaLen);
      for (const b of s.blocks) this.kernel.free(b.ptr, b.bytes);
      s.blocks = [];
    }
    this.segments = [];
    this.keys = [];
    this.live.clear();
    this.valueCache.clear();
  }
}

/** Decodes the keys of one segment out of its resident META blob and returns them in row order. */
function decodeKeys(kernel: Kernel, seg: Segment): string[] {
  const rows = seg.rows;
  const ko = kernel.u32(seg.metaPtr + rows * 4, rows + 1);
  const kbBase = seg.metaPtr + rows * 16 + 8;
  const blob = kernel.u8(kbBase, seg.keyBytesLen);
  let ascii = true;
  for (let i = 0; i < blob.length; i++)
    if (blob[i]! >= 0x80) {
      ascii = false;
      break;
    }
  const keys = new Array<string>(rows);
  if (ascii) {
    const all = TEXT.decode(blob);
    for (let i = 0; i < rows; i++) keys[i] = all.slice(ko[i]!, ko[i + 1]!);
  } else {
    for (let i = 0; i < rows; i++) keys[i] = TEXT.decode(blob.subarray(ko[i]!, ko[i + 1]!));
  }
  return keys;
}

async function loadSegmentMeta(
  ctx: LoadCtx,
  idx: OpenIndex,
  s: ParsedHead['segs'][number],
): Promise<void> {
  const { kernel, files, ns } = ctx;
  const metaLen = metaLength(s.rows, s.keyBytesLen);
  const lens = splitLengths(metaLen, META_PART_BYTES);
  const file = `meta-${s.segId}`;
  let ptr = 0;
  try {
    let off = 0;
    let crc = 0;
    for (let i = 0; i < lens.length; i++) {
      const bytes = await files.part('meta', s.segId, i, lens[i]!);
      // Memory only grows now that the first part exists with the length the HEAD implies.
      if (i === 0) ptr = kernel.alloc(metaLen);
      kernel.u8(ptr + off, bytes.byteLength).set(bytes);
      crc = kernel.crc32c(crc, ptr + off, bytes.byteLength);
      off += bytes.byteLength;
    }
    if (crc !== s.metaCrc) throw corrupt(ns, file, 'crc');
    const rc = kernel.checkMeta(ptr, metaLen, s.rows, s.keyBytesLen, s.valueBytesLen);
    if (rc === E_ARGS) throw internal('meta');
    if (rc < 0) throw corrupt(ns, file, KERNEL_REASONS[rc] ?? 'meta');
  } catch (e) {
    kernel.free(ptr, metaLen);
    throw e;
  }
  const seg: Segment = { ...s, metaPtr: ptr, metaLen, blocks: [] };
  idx.segments.push(seg);
  const keys = decodeKeys(kernel, seg);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const row = s.firstRow + i;
    idx.keys[row] = key;
    if (!idx.isDeleted(row)) {
      if (idx.live.has(key)) throw corrupt(ns, file, 'duplicate_key');
      idx.live.set(key, row);
    }
  }
}

/** Reads and validates HEAD and every META blob. Returns undefined when there is no HEAD. */
export async function loadMeta(
  ctx: LoadCtx,
  headBytes?: Uint8Array,
): Promise<OpenIndex | undefined> {
  const { kernel, files, ns } = ctx;
  const bytes = headBytes ?? (await files.head());
  if (bytes === undefined) return undefined;
  const head = parseHead(ctx, bytes);
  // Before any block is allocated: refuse an index larger than this store is willing to hold.
  if (head.vecBytes + head.metaBytes > ctx.maxIndexBytes) throw corrupt(ns, 'head', 'too_large');
  const idx = new OpenIndex(kernel);
  idx.dim = head.dim;
  idx.totalRows = head.totalRows;
  idx.liveRows = head.liveRows;
  idx.nextSegId = head.nextSegId;
  idx.generation = head.generation;
  idx.vecBytes = head.vecBytes;
  idx.metaBytes = head.metaBytes;
  idx.headBytes = bytes;
  idx.tomb = head.tomb;
  idx.keys = new Array<string>(head.totalRows);
  idx.valueBytes = head.segs.reduce((n, s) => n + s.valueBytesLen, 0);
  try {
    for (const s of head.segs) await loadSegmentMeta(ctx, idx, s);
  } catch (e) {
    idx.dispose();
    throw e;
  }
  return idx;
}

/** Reads and verifies every vector part into WebAssembly memory, one block per part. */
export async function loadVec(ctx: LoadCtx, idx: OpenIndex): Promise<void> {
  if (idx.vecLoaded) return;
  const { kernel, files, ns } = ctx;
  const dim = idx.dim;
  const per = rowsPerVecPart(dim);
  for (const seg of idx.segments) {
    if (seg.blocks.length > 0) continue;
    const lens = vecPartLengths(seg.rows, dim);
    const blocks: Block[] = [];
    let crc = 0;
    try {
      let next = files.part('vec', seg.segId, 0, lens[0]!);
      next.catch(() => undefined);
      for (let i = 0; i < lens.length; i++) {
        const bytes = await next;
        if (i + 1 < lens.length) {
          next = files.part('vec', seg.segId, i + 1, lens[i + 1]!);
          next.catch(() => undefined);
        }
        const ptr = kernel.alloc(bytes.byteLength);
        const rows = bytes.byteLength / (dim * 4);
        blocks.push({ ptr, rows, bytes: bytes.byteLength, start: i * per });
        kernel.u8(ptr, bytes.byteLength).set(bytes);
        crc = kernel.crc32c(crc, ptr, bytes.byteLength);
      }
      // The checksum first: accidental corruption is reported as such, not as whatever bad float
      // it happened to make.
      if (crc !== seg.vecCrc) throw corrupt(ns, `vec-${seg.segId}`, 'crc');
      // A checksum cannot vouch for what a writer put there; the scan needs finite, bounded rows.
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]!;
        const bad = kernel.checkRows(b.ptr, b.rows, dim);
        if (bad === E_ARGS) throw internal('vectors');
        if (bad >= 0) throw corrupt(ns, partName('vec', seg.segId, i), 'bad_vector');
      }
    } catch (e) {
      for (const b of blocks) kernel.free(b.ptr, b.bytes);
      throw e;
    }
    seg.blocks = blocks;
  }
  idx.vecLoaded = true;
}

/** The stored value of one row, or undefined when the row has none. Verifies its checksum. */
export async function readValue(
  ctx: LoadCtx,
  idx: OpenIndex,
  seg: Segment,
  local: number,
): Promise<StorableValue | undefined> {
  const { kernel, files, ns } = ctx;
  const rows = seg.rows;
  const offsets = kernel.u32(seg.metaPtr + rows * 4 + (rows + 1) * 4, rows + 1);
  const a = offsets[local]!;
  const b = offsets[local + 1]!;
  const size = b - a;
  if (size === 0) return undefined;
  const want = kernel.u32(seg.metaPtr + rows * 4 + 2 * (rows + 1) * 4, rows)[local]!;
  const lens = splitLengths(seg.valueBytesLen, VAL_PART_BYTES);
  const p0 = Math.floor(a / VAL_PART_BYTES);
  const p1 = Math.floor((b - 1) / VAL_PART_BYTES);
  const out = new Uint8Array(size);
  for (let p = p0; p <= p1; p++) {
    const cacheKey = `${seg.segId}/${p}`;
    let part = idx.cacheGet(cacheKey);
    if (part === undefined) {
      part = await files.part('val', seg.segId, p, lens[p]!);
      idx.cachePut(cacheKey, part);
    }
    const from = Math.max(a, p * VAL_PART_BYTES) - p * VAL_PART_BYTES;
    const to = Math.min(b, (p + 1) * VAL_PART_BYTES) - p * VAL_PART_BYTES;
    out.set(part.subarray(from, to), p * VAL_PART_BYTES + from - a);
  }
  const scratch = kernel.alloc(size);
  let got: number;
  try {
    kernel.u8(scratch, size).set(out);
    got = kernel.crc32c(0, scratch, size);
  } finally {
    kernel.free(scratch, size);
  }
  const file = partName('val', seg.segId, p0);
  if (got !== want) throw corrupt(ns, file, 'value_crc');
  try {
    return decode(out);
  } catch {
    throw corrupt(ns, file, 'value_decode');
  }
}
