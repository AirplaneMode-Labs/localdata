// Crash-safe, all-or-nothing writer for the vector index (Storage API 0.2.0 putVectors, delete).
//
// Write order (docs/vector-index-format.md): vector parts as blocks fill, then each segment's value
// parts and META parts, and the new HEAD LAST in a single put. New segments always take ids
// >= the committed nextSegId, so no record the committed HEAD references is ever overwritten: until
// the HEAD put lands, readers (and a crash) see exactly the previous index. On any error this call's
// parts are deleted (best effort) and the previous HEAD was never touched.
//
// Peak memory is the caller's rows, plus the resident index, plus one part: rows stream into one
// vector block of at most 8 MiB, which is checked, normalised, checksummed and put before the next
// block starts.
import { encode } from '../codec';
import {
  StorageError,
  VECTOR_VALUE_BYTES_MAX,
  type PutVectorsResult,
  type StorableValue,
  type VectorRow,
} from '../contracts/storage-api';
import { checkRowKey } from './validate';
import { E_ARGS, assertU32, type Kernel } from './kernel';
import {
  GENERATION_MAX,
  MAX_ROWS,
  MAX_SEGMENTS,
  META_PART_BYTES,
  SEGMENT_ROWS_MAX,
  SEGMENT_VALUE_BYTES_MAX,
  VAL_PART_BYTES,
  HEAD_KEY,
  metaLength,
  partName,
  rowsPerVecPart,
  splitLengths,
  type VecFiles,
} from './files';
import { parseHead, OpenIndex, type Block, type LoadCtx, type Segment } from './reader';

// The format is little-endian and the writer fills typed arrays directly.
if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
  throw new StorageError(
    'driver_unavailable',
    'the vector index format needs a little-endian host',
  );
}

const ENCODER = new TextEncoder();

export interface WriteCtx extends LoadCtx {
  /** Throws quota_exceeded when `additionalBytes` more bytes would pass the soft quota. */
  checkSoft(additionalBytes: number): void;
}

export interface PutOutcome {
  result: PutVectorsResult;
  /** Segments in the index after this call. */
  segments: number;
  /** Bytes written by this call (parts and HEAD). */
  bytes: number;
  /** True when the caller must drop its resident copy (it could not be extended in place). */
  invalidate: boolean;
}

function invalidValue(reason: string, row: number): StorageError {
  return new StorageError('invalid_value', `row ${row}: invalid ${reason}`, { row, reason });
}

/** A growable little-endian u32 array. */
class GrowU32 {
  a = new Uint32Array(64);
  n = 0;
  push(x: number): void {
    if (this.n === this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
}

/** A growable byte buffer. */
class GrowBytes {
  a = new Uint8Array(1024);
  n = 0;
  push(b: Uint8Array): void {
    if (this.n + b.length > this.a.length) {
      let cap = this.a.length;
      while (cap < this.n + b.length) cap *= 2;
      const x = new Uint8Array(cap);
      x.set(this.a.subarray(0, this.n));
      this.a = x;
    }
    this.a.set(b, this.n);
    this.n += b.length;
  }
}

function crcOf(kernel: Kernel, bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  const ptr = kernel.alloc(bytes.byteLength);
  try {
    kernel.u8(ptr, bytes.byteLength).set(bytes);
    return kernel.crc32c(0, ptr, bytes.byteLength);
  } finally {
    kernel.free(ptr, bytes.byteLength);
  }
}

interface SegFields {
  segId: number;
  rows: number;
  firstRow: number;
  keyBytesLen: number;
  valueBytesLen: number;
  vecCrc: number;
  metaCrc: number;
}

export interface HeadFields {
  dim: number;
  generation: number;
  nextSegId: number;
  totalRows: number;
  liveRows: number;
  segs: SegFields[];
  tomb: Uint8Array;
}

/** Serialises a HEAD record (layout in docs/vector-index-format.md) with both checksums. */
export function buildHead(kernel: Kernel, h: HeadFields): Uint8Array {
  const n = 64 + 32 * h.segs.length + h.tomb.length + 4;
  const out = new Uint8Array(n);
  const dv = new DataView(out.buffer);
  out.set([0x4c, 0x44, 0x58, 0x31], 0); // 'LDX1'
  dv.setUint16(4, 1, true);
  dv.setUint16(6, 1, true);
  dv.setUint32(8, h.dim, true);
  dv.setUint32(12, h.segs.length, true);
  dv.setUint32(16, h.totalRows, true);
  dv.setUint32(20, h.liveRows, true);
  dv.setUint32(24, h.nextSegId, true);
  dv.setUint32(28, h.generation, true);
  dv.setUint32(60, crcOf(kernel, out.subarray(0, 60)), true);
  h.segs.forEach((s, i) => {
    const o = 64 + 32 * i;
    dv.setUint32(o, s.segId, true);
    dv.setUint32(o + 4, s.rows, true);
    dv.setUint32(o + 8, s.firstRow, true);
    dv.setUint32(o + 12, s.keyBytesLen, true);
    dv.setUint32(o + 16, s.valueBytesLen, true);
    dv.setUint32(o + 20, s.vecCrc, true);
    dv.setUint32(o + 24, s.metaCrc, true);
    dv.setUint32(o + 28, 0, true);
  });
  out.set(h.tomb, 64 + 32 * h.segs.length);
  dv.setUint32(n - 4, crcOf(kernel, out.subarray(64, n - 4)), true);
  return out;
}

function segFieldsOf(idx: OpenIndex): SegFields[] {
  return idx.segments.map((s) => ({
    segId: s.segId,
    rows: s.rows,
    firstRow: s.firstRow,
    keyBytesLen: s.keyBytesLen,
    valueBytesLen: s.valueBytesLen,
    vecCrc: s.vecCrc,
    metaCrc: s.metaCrc,
  }));
}

function nextGeneration(idx: OpenIndex | undefined): number {
  const g = (idx?.generation ?? 0) + 1;
  if (g > GENERATION_MAX) {
    throw new StorageError(
      'invalid_value',
      'the index generation counter is exhausted; clear the namespace to start again',
      { reason: 'generation' },
    );
  }
  return g;
}

/** Puts a HEAD record after proving the reader would accept it (a writer bug must never commit). */
async function commitHead(ctx: WriteCtx, head: Uint8Array): Promise<void> {
  parseHead(ctx, head);
  await ctx.files.put(HEAD_KEY, head);
}

/**
 * Tombstones the live rows of `keys` in ONE new HEAD (generation + 1). Keys without a live row are
 * skipped. Returns how many rows were tombstoned (0 writes nothing). The resident index is updated in
 * place after the HEAD lands.
 */
export async function tombstoneKeys(
  ctx: WriteCtx,
  idx: OpenIndex,
  keys: Iterable<string>,
): Promise<number> {
  const hit = new Map<string, number>();
  for (const key of keys) {
    const row = idx.live.get(key);
    if (row !== undefined) hit.set(key, row);
  }
  if (hit.size === 0) return 0;
  const generation = nextGeneration(idx);
  const tomb = idx.tomb.slice();
  for (const row of hit.values()) tomb[row >> 3] = tomb[row >> 3]! | (1 << (row & 7));
  const head = buildHead(ctx.kernel, {
    dim: idx.dim,
    generation,
    nextSegId: idx.nextSegId,
    totalRows: idx.totalRows,
    liveRows: idx.liveRows - hit.size,
    segs: segFieldsOf(idx),
    tomb,
  });
  await commitHead(ctx, head);
  idx.headBytes = head;
  idx.tomb = tomb;
  idx.generation = generation;
  idx.liveRows -= hit.size;
  for (const key of hit.keys()) idx.live.delete(key);
  return hit.size;
}

/**
 * Tombstones the live row of `key`: a new HEAD with one more bit set and generation + 1. Returns false
 * when the key has no live row.
 */
export async function tombstoneKey(ctx: WriteCtx, idx: OpenIndex, key: string): Promise<boolean> {
  return (await tombstoneKeys(ctx, idx, [key])) > 0;
}

/** Options of putVectors beyond the rows themselves (used by the documents layer). */
export interface PutOptions {
  /**
   * Keys whose live rows are tombstoned in the SAME commit as the new rows, in addition to the rows the
   * call replaces by key (a document replaced by one with fewer chunks must retire the chunks it no
   * longer has).
   */
  retire?: readonly string[];
  /**
   * Starts a new index (a new dim, none of the old segments) instead of extending the committed one. New
   * segments still take ids from the committed nextSegId and the generation still rises, so the committed
   * HEAD stays valid until the new HEAD lands; the old segments' parts become unreferenced and the sweep
   * on open removes them.
   */
  restart?: boolean;
}

class SegmentBuilder {
  rows = 0;
  readonly keyBytes = new GrowBytes();
  readonly keyOffsets = new GrowU32();
  readonly valueOffsets = new GrowU32();
  readonly valueCrcs = new GrowU32();
  invNorms = new Float32Array(1024);
  valueBytes = 0;
  vecCrc = 0;
  vecParts = 0;
  valParts = 0;
  valBuf = new Uint8Array(0);
  valFill = 0;
  readonly blocks: Block[] = [];
  constructor(readonly segId: number) {
    this.keyOffsets.push(0);
    this.valueOffsets.push(0);
  }
  ensureNorms(n: number): void {
    if (n <= this.invNorms.length) return;
    let cap = this.invNorms.length;
    while (cap < n) cap *= 2;
    const x = new Float32Array(Math.min(cap, SEGMENT_ROWS_MAX));
    x.set(this.invNorms);
    this.invNorms = x;
  }
}

interface FinishedSegment extends SegFields {
  blocks: Block[];
  /** The META blob kept in WebAssembly memory when the resident index is extended in place. */
  metaPtr: number;
  metaLen: number;
  keys: string[];
}

interface OpenBlock {
  ptr: number;
  cap: number;
  n: number;
  firstCallRow: number;
}

/**
 * putVectors: validates rows as they stream, writes parts, commits one new HEAD. `idx` is the
 * resident (meta-loaded) index or undefined for a namespace without one.
 */
export async function putVectors(
  ctx: WriteCtx,
  idx: OpenIndex | undefined,
  rows: Iterable<VectorRow> | AsyncIterable<VectorRow>,
  maxIndexBytes: number,
  opts: PutOptions = {},
): Promise<PutOutcome> {
  const { kernel, files } = ctx;
  // `idx` supplies the generation and the next segment id (the committed HEAD must stay valid until the new
  // one lands); `base` is what the new HEAD extends: the committed index, or nothing for a restart.
  const base = opts.restart === true ? undefined : idx;
  const generation = nextGeneration(idx);
  const adopt = base?.vecLoaded === true;
  const oldRows = base?.totalRows ?? 0;
  const oldSegs = base?.segments.length ?? 0;
  const oldIndexBytes = (base?.vecBytes ?? 0) + (base?.metaBytes ?? 0);
  let dim = base?.dim ?? 0;

  const seen = new Set<string>();
  const finished: FinishedSegment[] = [];
  const written: string[] = [];
  let writtenBytes = 0;
  let newVecBytes = 0;
  let newMetaBytes = 0;
  let newValueBytes = 0;
  let callRow = 0;
  let seg: SegmentBuilder | undefined;
  let block: OpenBlock | undefined;
  let scratch = { ptr: 0, len: 0 };
  let nextSegId = idx?.nextSegId ?? 0;
  let committed = false;

  const put = async (name: string, bytes: Uint8Array): Promise<void> => {
    await files.put(name, bytes);
    written.push(name);
    writtenBytes += bytes.byteLength;
  };

  const ensureScratch = (len: number): number => {
    if (scratch.len < len) {
      if (scratch.ptr !== 0) kernel.free(scratch.ptr, scratch.len);
      scratch = { ptr: 0, len: 0 };
      scratch = { ptr: kernel.alloc(len), len };
    }
    return scratch.ptr;
  };

  const quota = (vecAdd: number, builder: SegmentBuilder): void => {
    const proj = metaLength(builder.rows, builder.keyBytes.n);
    if (oldIndexBytes + newVecBytes + newMetaBytes + vecAdd + proj > maxIndexBytes) {
      throw new StorageError(
        'quota_exceeded',
        'the index would exceed maxIndexBytes; raise the option or split the data across namespaces',
        { reason: 'max_index_bytes', maxIndexBytes },
      );
    }
    ctx.checkSoft(writtenBytes + vecAdd + proj);
  };

  const flushBlock = async (): Promise<void> => {
    if (block === undefined || seg === undefined) return;
    const b = block;
    const s = seg;
    block = undefined;
    const bytes = b.n * dim * 4;
    let keep = false;
    try {
      const bad = kernel.checkRows(b.ptr, b.n, dim);
      if (bad === E_ARGS) throw new StorageError('io', 'the vector kernel rejected its arguments');
      if (bad >= 0) throw invalidValue('vector', b.firstCallRow + bad);
      const out = kernel.alloc(b.n * 4);
      try {
        const rc = kernel.invNorms(b.ptr, b.n, dim, out);
        if (rc !== 0) throw new StorageError('io', 'the vector kernel rejected its arguments');
        s.invNorms.set(kernel.f32(out, b.n), s.rows - b.n);
      } finally {
        kernel.free(out, b.n * 4);
      }
      s.vecCrc = kernel.crc32c(s.vecCrc, b.ptr, bytes);
      quota(bytes, s);
      await put(partName('vec', s.segId, s.vecParts), kernel.u8(b.ptr, bytes).slice());
      s.vecParts++;
      newVecBytes += bytes;
      if (adopt) {
        let ptr = b.ptr;
        if (bytes !== b.cap * dim * 4) {
          // The last, partial block: re-home it in an exactly sized block so it can be freed later.
          ptr = kernel.alloc(bytes);
          kernel.u8(ptr, bytes).set(kernel.u8(b.ptr, bytes));
        } else keep = true;
        s.blocks.push({ ptr, rows: b.n, bytes, start: s.rows - b.n });
      }
    } finally {
      if (!keep) kernel.free(b.ptr, b.cap * dim * 4);
    }
  };

  const putValuePart = async (s: SegmentBuilder): Promise<void> => {
    const part = s.valBuf.slice(0, s.valFill);
    await put(partName('val', s.segId, s.valParts), part);
    s.valParts++;
    s.valFill = 0;
  };

  const appendValue = async (s: SegmentBuilder, v: Uint8Array): Promise<void> => {
    if (s.valBuf.length === 0) s.valBuf = new Uint8Array(VAL_PART_BYTES);
    let off = 0;
    while (off < v.length) {
      const take = Math.min(VAL_PART_BYTES - s.valFill, v.length - off);
      s.valBuf.set(v.subarray(off, off + take), s.valFill);
      s.valFill += take;
      off += take;
      if (s.valFill === VAL_PART_BYTES) await putValuePart(s);
    }
  };

  const finishSegment = async (): Promise<void> => {
    if (seg === undefined) return;
    await flushBlock();
    const s = seg;
    seg = undefined;
    if (s.rows === 0) return;
    if (s.valFill > 0) await putValuePart(s);
    newValueBytes += s.valueBytes;
    const rowsN = s.rows;
    const keyLen = s.keyBytes.n;
    const metaLen = metaLength(rowsN, keyLen);
    assertU32(metaLen, 'segment META length');
    const metaPtr = kernel.alloc(metaLen);
    let keepMeta = false;
    try {
      const m = kernel.u8(metaPtr, metaLen);
      // invNorms | keyOffsets | valueOffsets | valueCrcs | keyBytes, each section 4-byte aligned.
      new Float32Array(m.buffer, metaPtr, rowsN).set(s.invNorms.subarray(0, rowsN));
      let o = metaPtr + rowsN * 4;
      new Uint32Array(m.buffer, o, rowsN + 1).set(s.keyOffsets.a.subarray(0, rowsN + 1));
      o += (rowsN + 1) * 4;
      new Uint32Array(m.buffer, o, rowsN + 1).set(s.valueOffsets.a.subarray(0, rowsN + 1));
      o += (rowsN + 1) * 4;
      new Uint32Array(m.buffer, o, rowsN).set(s.valueCrcs.a.subarray(0, rowsN));
      o += rowsN * 4;
      new Uint8Array(m.buffer, o, keyLen).set(s.keyBytes.a.subarray(0, keyLen));
      const rc = kernel.checkMeta(metaPtr, metaLen, rowsN, keyLen, s.valueBytes);
      if (rc !== 0)
        throw new StorageError('io', 'the writer produced a META blob the reader refuses');
      const metaCrc = kernel.crc32c(0, metaPtr, metaLen);
      const lens = splitLengths(metaLen, META_PART_BYTES);
      let off = 0;
      for (let i = 0; i < lens.length; i++) {
        await put(partName('meta', s.segId, i), kernel.u8(metaPtr + off, lens[i]!).slice());
        off += lens[i]!;
      }
      newMetaBytes += metaLen;
      const keys: string[] = [];
      if (adopt) {
        const dec = new TextDecoder('utf-8', { ignoreBOM: true });
        const ko = s.keyOffsets.a;
        const kb = new Uint8Array(s.keyBytes.a.buffer, 0, keyLen);
        for (let i = 0; i < rowsN; i++) keys.push(dec.decode(kb.subarray(ko[i]!, ko[i + 1]!)));
        keepMeta = true;
      }
      finished.push({
        segId: s.segId,
        rows: rowsN,
        firstRow: oldRows + finished.reduce((n, f) => n + f.rows, 0),
        keyBytesLen: keyLen,
        valueBytesLen: s.valueBytes,
        vecCrc: s.vecCrc,
        metaCrc,
        blocks: s.blocks,
        metaPtr: keepMeta ? metaPtr : 0,
        metaLen,
        keys,
      });
    } finally {
      if (!keepMeta) kernel.free(metaPtr, metaLen);
    }
  };

  const startSegment = (): SegmentBuilder => {
    if (oldSegs + finished.length + 1 > MAX_SEGMENTS) {
      throw new StorageError(
        'quota_exceeded',
        `a namespace holds at most ${MAX_SEGMENTS} index segments (each putVectors call adds at least one and there is no compaction); batch rows into fewer calls or clear the namespace`,
        { reason: 'max_segments' },
      );
    }
    return new SegmentBuilder(nextSegId++);
  };

  const process = async (r: VectorRow): Promise<void> => {
    if (typeof r !== 'object' || r === null) throw invalidValue('row', callRow);
    checkRowKey(r.key, callRow);
    const v = r.vector;
    if (!(v instanceof Float32Array) || v.length < 1 || v.length > 4096)
      throw invalidValue('vector', callRow);
    if (dim === 0) dim = v.length;
    else if (v.length !== dim) throw invalidValue('dim', callRow);
    if (seen.has(r.key)) throw invalidValue('duplicate_key', callRow);
    if (oldRows + callRow + 1 > MAX_ROWS) {
      throw new StorageError(
        'quota_exceeded',
        `an index holds at most ${MAX_ROWS} rows including replaced and deleted ones (no compaction)`,
        { reason: 'max_rows' },
      );
    }
    let value: Uint8Array | undefined;
    if (r.value !== undefined) {
      try {
        value = await encode(r.value as StorableValue);
      } catch (e) {
        if (e instanceof StorageError && e.code === 'quota_exceeded') throw e;
        throw invalidValue('value', callRow);
      }
      if (value.byteLength > VECTOR_VALUE_BYTES_MAX) throw invalidValue('value_size', callRow);
    }
    seen.add(r.key);

    if (
      seg !== undefined &&
      (seg.rows === SEGMENT_ROWS_MAX ||
        (value !== undefined && seg.valueBytes + value.byteLength > SEGMENT_VALUE_BYTES_MAX))
    ) {
      await finishSegment();
    }
    seg ??= startSegment();
    const s = seg;
    if (block === undefined) {
      const cap = Math.min(rowsPerVecPart(dim), SEGMENT_ROWS_MAX - s.rows);
      block = { ptr: kernel.alloc(cap * dim * 4), cap, n: 0, firstCallRow: callRow };
    }
    kernel.f32(block.ptr + block.n * dim * 4, dim).set(v);
    block.n++;
    s.rows++;
    s.ensureNorms(s.rows);
    const keyEnc = ENCODER.encode(r.key);
    s.keyBytes.push(keyEnc);
    s.keyOffsets.push(s.keyBytes.n);
    if (value !== undefined) {
      const ptr = ensureScratch(value.byteLength);
      kernel.u8(ptr, value.byteLength).set(value);
      s.valueCrcs.push(kernel.crc32c(0, ptr, value.byteLength));
      s.valueBytes += value.byteLength;
      await appendValue(s, value);
    } else {
      s.valueCrcs.push(0);
    }
    s.valueOffsets.push(s.valueBytes);
    callRow++;
    if (block.n === block.cap) await flushBlock();
  };

  const free = (): void => {
    if (block !== undefined) kernel.free(block.ptr, block.cap * dim * 4);
    for (const f of finished) {
      for (const b of f.blocks) kernel.free(b.ptr, b.bytes);
      kernel.free(f.metaPtr, f.metaLen);
    }
    if (seg !== undefined) for (const b of seg.blocks) kernel.free(b.ptr, b.bytes);
    if (scratch.ptr !== 0) kernel.free(scratch.ptr, scratch.len);
    scratch = { ptr: 0, len: 0 };
  };

  try {
    // Leftovers of a write that never committed: only records the committed HEAD cannot reference.
    for (const name of await files.leftovers(idx?.nextSegId ?? 0)) await files.del(name);

    if (Symbol.asyncIterator in (rows as object)) {
      for await (const r of rows as AsyncIterable<VectorRow>) await process(r);
    } else {
      for (const r of rows as Iterable<VectorRow>) await process(r);
    }
    if (callRow === 0) {
      free();
      return {
        result: { written: 0, replaced: 0, rows: idx?.liveRows ?? 0 },
        segments: 0,
        bytes: 0,
        invalidate: false,
      };
    }
    await finishSegment();

    // Replaced rows: every key of this call that has a live row in the committed index, and every key the
    // caller retires in the same commit (each row once).
    const replacedSet = new Set<number>();
    if (base !== undefined) {
      for (const k of seen) {
        const old = base.live.get(k);
        if (old !== undefined) replacedSet.add(old);
      }
      for (const k of opts.retire ?? []) {
        const old = base.live.get(k);
        if (old !== undefined) replacedSet.add(old);
      }
    }
    const replacedRows = [...replacedSet];
    const totalRows = oldRows + callRow;
    const tomb = new Uint8Array(Math.ceil(totalRows / 8));
    if (base !== undefined) tomb.set(base.tomb);
    for (const row of replacedRows) tomb[row >> 3] = tomb[row >> 3]! | (1 << (row & 7));
    const liveRows = (base?.liveRows ?? 0) - replacedRows.length + callRow;
    const segs: SegFields[] = [...(base ? segFieldsOf(base) : []), ...finished];
    const head = buildHead(kernel, {
      dim,
      generation,
      nextSegId,
      totalRows,
      liveRows,
      segs,
      tomb,
    });
    ctx.checkSoft(writtenBytes + head.byteLength);
    await commitHead(ctx, head);
    committed = true;
    writtenBytes += head.byteLength;

    // Committed. Extend the resident index in place when it holds vectors (their blocks are already
    // in WebAssembly memory); otherwise the caller drops it and reloads lazily.
    let invalidate = true;
    if (base !== undefined && adopt) {
      const idx = base;
      for (const row of replacedRows) idx.live.delete(idx.keys[row]!);
      let first = oldRows;
      for (const f of finished) {
        const segment: Segment = {
          segId: f.segId,
          rows: f.rows,
          firstRow: first,
          keyBytesLen: f.keyBytesLen,
          valueBytesLen: f.valueBytesLen,
          vecCrc: f.vecCrc,
          metaCrc: f.metaCrc,
          metaPtr: f.metaPtr,
          metaLen: f.metaLen,
          blocks: f.blocks,
        };
        idx.segments.push(segment);
        f.keys.forEach((k, i) => {
          idx.keys[first + i] = k;
          idx.live.set(k, first + i);
        });
        first += f.rows;
      }
      idx.totalRows = totalRows;
      idx.liveRows = liveRows;
      idx.generation = generation;
      idx.nextSegId = nextSegId;
      idx.vecBytes += newVecBytes;
      idx.metaBytes += newMetaBytes;
      idx.valueBytes += newValueBytes;
      idx.headBytes = head;
      idx.tomb = tomb;
      finished.length = 0; // ownership of blocks and META moved to the resident index
      invalidate = false;
    }
    free();
    return {
      result: { written: callRow, replaced: replacedRows.length, rows: liveRows },
      segments: segs.length,
      bytes: writtenBytes,
      invalidate,
    };
  } catch (e) {
    free();
    if (!committed) {
      // Best effort: this call's parts. The previous HEAD is untouched whatever happens here.
      for (const name of written) await files.del(name).catch(() => undefined);
    }
    throw e;
  }
}
