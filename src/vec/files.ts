// Records of one vector index. Everything lives in the reserved driver namespace '__ld_vec.' + ns, so
// each index has its own OPFS directory (and its own keys.json):
//   head                    the HEAD record (the only mutable record; written last, atomically)
//   vec-<segId>/<part>      f32 row-major, rowsPerPart = max(1, floor(8388608 / (dim * 4))) rows
//   meta-<segId>/<part>     8 MiB parts of the META blob
//   val-<segId>/<part>      1 MiB parts of the concatenated LD1 values
// Part numbers are 5 digits. Layout and invariants: docs/vector-index-format.md.
import { StorageError, type DriverRecord, type StorageDriver } from '../contracts/storage-api';
import { VEC_NS_PREFIX, type DriverHooks, type ReadLimit } from '../drivers/types';

export { VEC_NS_PREFIX };
/** A HEAD record longer than this is refused before it is read or parsed (64 + 32 * 4096 + 524288 + 4). */
export const HEAD_MAX_BYTES = 64 + 32 * 4096 + 524_288 + 4;
export const HEAD_KEY = 'head';
export const VEC_PART_BYTES = 8 * 1024 * 1024;
export const META_PART_BYTES = 8 * 1024 * 1024;
export const VAL_PART_BYTES = 1024 * 1024;
export const SEGMENT_ROWS_MAX = 131_072;
export const MAX_SEGMENTS = 4096;
export const MAX_ROWS = 4_194_304;
export const GENERATION_MAX = 0xffff_fffe;
export const DEFAULT_MAX_INDEX_BYTES = 1_073_741_824;
/** A segment is also cut before its value stream would pass this, so valueBytesLen fits a u32. */
export const SEGMENT_VALUE_BYTES_MAX = 0x7fff_ffff;

export type PartKind = 'vec' | 'meta' | 'val';

export function vecNs(ns: string, prefix: string = VEC_NS_PREFIX): string {
  return prefix + ns;
}

export function partName(kind: PartKind, segId: number, part: number): string {
  return `${kind}-${segId}/${String(part).padStart(5, '0')}`;
}

export function rowsPerVecPart(dim: number): number {
  return Math.max(1, Math.floor(VEC_PART_BYTES / (dim * 4)));
}

/** Expected byte length of each part when `total` bytes are cut into parts of `size`. */
export function splitLengths(total: number, size: number): number[] {
  const out: number[] = [];
  for (let left = total; left > 0; left -= size) out.push(Math.min(size, left));
  return out;
}

export function vecPartLengths(rows: number, dim: number): number[] {
  const per = rowsPerVecPart(dim);
  const out: number[] = [];
  for (let left = rows; left > 0; left -= per) out.push(Math.min(per, left) * dim * 4);
  return out;
}

/** The META blob length of a segment (rows * 16 + 8 + keyBytesLen). */
export function metaLength(rows: number, keyBytesLen: number): number {
  return rows * 16 + 8 + keyBytesLen;
}

/** A corrupt-index error. `file` is a record name (never a key), `reason` a short code. */
export function corrupt(ns: string, file: string, reason: string): StorageError {
  return new StorageError(
    'corrupt',
    `the vector index of namespace ${JSON.stringify(ns)} failed validation (${reason} in ${file})`,
    { ns, file, reason },
  );
}

const PART_RE = /^(vec|meta|val)-(\d+)\/\d{5}$/;

/** The segment id a part record belongs to, or undefined for HEAD and anything else. */
export function segIdOfRecord(name: string): number | undefined {
  const m = PART_RE.exec(name);
  return m ? Number(m[2]) : undefined;
}

/** What a committed HEAD says about one segment (the fields the part list is derived from). */
export interface SegmentShape {
  segId: number;
  rows: number;
  keyBytesLen: number;
  valueBytesLen: number;
}

/**
 * Every part record a committed HEAD references (HEAD itself excluded): the vector, META and value
 * parts of each of its segments. Anything else with a part name in the namespace belongs to a write
 * that never committed.
 */
export function referencedRecords(dim: number, segs: readonly SegmentShape[]): Set<string> {
  const out = new Set<string>();
  for (const s of segs) {
    for (let i = 0; i < vecPartLengths(s.rows, dim).length; i++)
      out.add(partName('vec', s.segId, i));
    const metaParts = splitLengths(metaLength(s.rows, s.keyBytesLen), META_PART_BYTES).length;
    for (let i = 0; i < metaParts; i++) out.add(partName('meta', s.segId, i));
    for (let i = 0; i < splitLengths(s.valueBytesLen, VAL_PART_BYTES).length; i++)
      out.add(partName('val', s.segId, i));
  }
  return out;
}

/** The driver-facing operations on one index's records. */
export class VecFiles {
  readonly vns: string;

  constructor(
    private readonly d: StorageDriver,
    readonly ns: string,
    prefix: string = VEC_NS_PREFIX,
  ) {
    this.vns = vecNs(ns, prefix);
  }

  /**
   * One record. A driver that can say a record's size before reading it (S1-092) is asked to; a record
   * outside `limit` is refused as corrupt with `sizeReason` and its bytes are never read.
   */
  private async read(
    name: string,
    limit: ReadLimit,
    sizeReason: string,
  ): Promise<DriverRecord | undefined> {
    const hooked = this.d as StorageDriver & DriverHooks;
    if (typeof hooked.getBytesBounded === 'function') {
      const r = await hooked.getBytesBounded(this.vns, name, limit);
      if (r.kind === 'size') throw corrupt(this.ns, name, sizeReason);
      return r.kind === 'ok' ? r.record : undefined;
    }
    return this.d.getBytes(this.vns, name);
  }

  async head(): Promise<Uint8Array | undefined> {
    return (await this.read(HEAD_KEY, { max: HEAD_MAX_BYTES }, 'too_large'))?.bytes;
  }

  /** One part with its exact expected length. A missing part or a wrong length is corrupt. */
  async part(kind: PartKind, segId: number, part: number, expected: number): Promise<Uint8Array> {
    const name = partName(kind, segId, part);
    const rec = await this.read(name, { exact: expected }, 'length');
    if (!rec) throw corrupt(this.ns, name, 'missing_part');
    if (rec.bytes.byteLength !== expected) throw corrupt(this.ns, name, 'length');
    return rec.bytes;
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    await this.d.put(this.vns, name, bytes, { size: bytes.byteLength });
  }

  async del(name: string): Promise<void> {
    await this.d.del(this.vns, name);
  }

  /** Part records whose segment id is >= `minSegId` (leftovers of a write that never committed). */
  async leftovers(minSegId: number): Promise<string[]> {
    const out: string[] = [];
    for (const name of await this.d.keys(this.vns)) {
      const id = segIdOfRecord(name);
      if (id !== undefined && id >= minSegId) out.push(name);
    }
    return out;
  }

  /**
   * T1-S4-08: deletes the part records `referenced` does not list (see referencedRecords). Records that
   * are not parts (no part name) are left alone. Best effort: a delete that fails is skipped. Returns how
   * many records were deleted. The caller holds the writer lock and has checked HEAD.
   */
  async sweep(referenced: ReadonlySet<string>): Promise<number> {
    let deleted = 0;
    for (const name of await this.d.keys(this.vns)) {
      if (segIdOfRecord(name) === undefined || referenced.has(name)) continue;
      try {
        if (await this.d.del(this.vns, name)) deleted++;
      } catch {
        // never fail a read because tidying failed
      }
    }
    return deleted;
  }

  /**
   * Removes the index: HEAD first (the index disappears at that instant), then every record. Works on
   * a namespace whose keys.json is damaged: nothing is parsed, the namespace is simply removed.
   */
  async clear(): Promise<void> {
    try {
      await this.d.del(this.vns, HEAD_KEY);
    } catch (e) {
      if (!(e instanceof StorageError && e.code === 'corrupt')) throw e;
    }
    await this.d.clear(this.vns);
  }
}
