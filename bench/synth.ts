// Deterministic synthetic data shared by the benchmark, the demo and the tests. No real documents,
// no model download: every vector and every chunk is a function of its row index.
//
//   row i      seed (0x9E3779B9 * (i + 1)) >>> 0, mulberry32, component ((u32 >>> 8) / 16777216) * 2 - 1
//   query j    the same generator with seed 1e9 + j
//   key        'chunk-' + a 6-digit index
//   value      an ASCII string of chunkBytes characters starting 'synthetic chunk <i> ', padded from a
//              second PRNG stream so the text does not compress to nothing
import type { VectorRow } from '../src/contracts/storage-api';

export const DIM = 384;

/** mulberry32 returning the raw u32 sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function fromSeed(seed: number, dim: number): Float32Array {
  const next = mulberry32(seed);
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = ((next() >>> 8) / 16777216) * 2 - 1;
  return v;
}

export function rowSeed(i: number): number {
  return Math.imul(0x9e3779b9, i + 1) >>> 0;
}

export function synthVector(i: number, dim = DIM): Float32Array {
  return fromSeed(rowSeed(i), dim);
}

export function synthQuery(j: number, dim = DIM): Float32Array {
  return fromSeed(1_000_000_000 + j, dim);
}

export function synthKey(i: number): string {
  return `chunk-${String(i).padStart(6, '0')}`;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz      ';

export function synthValue(i: number, chunkBytes: number): string {
  const head = `synthetic chunk ${i} `;
  if (chunkBytes <= head.length) return head.slice(0, chunkBytes);
  const next = mulberry32((rowSeed(i) ^ 0xa5a5a5a5) >>> 0);
  let s = head;
  while (s.length < chunkBytes) s += ALPHABET[next() % ALPHABET.length]!;
  return s;
}

export interface SynthOptions {
  dim?: number;
  /** Attach a synthetic chunk of this many ASCII bytes as the row value; omit for no value. */
  chunkBytes?: number;
}

export function synthRow(i: number, o: SynthOptions = {}): VectorRow {
  const row: VectorRow = { key: synthKey(i), vector: synthVector(i, o.dim ?? DIM) };
  if (o.chunkBytes !== undefined) row.value = synthValue(i, o.chunkBytes);
  return row;
}

/** Rows [from, from + count) as a generator: nothing is held beyond the row being yielded. */
export function* synthRows(
  from: number,
  count: number,
  o: SynthOptions = {},
): Generator<VectorRow> {
  for (let i = from; i < from + count; i++) yield synthRow(i, o);
}

// ---- the integer-only clustered generator (HNSW tests, benchmark and demo) --------------------------
//
// ONE generator, implemented identically in Rust (crates/ldvec/tests/support/synth.rs) and here. It uses
// integers only: SplitMix64 draws give integer centre coordinates and integer noise (an Irwin-Hall sum
// of four 16-bit integer terms) as int32, and each component is int32 / 2^16, which is exact in binary32
// because every |int32| is below 2^24. There is no Math.log, Math.cos, Math.sqrt or float random draw
// (the last bit of those differs between engines and libm implementations), so both languages produce
// the same bytes. test/fixtures/hnsw-determinism.json pins the sha256 of a 2,000 x 64 input (seed 7).
//
//   centres   state = seed; for c in 0..C, j in 0..dim: z = next(); centre[c][j] = (z >> 43) - 2^20
//   points    state = seed ^ STREAM; per point: z = next(); c = (z >> 32) % C; then for each j: z = next();
//             noise = ((z & 0xFFFF) + ((z >> 16) & 0xFFFF) + ((z >> 32) & 0xFFFF) + (z >> 48) - 131070) * 8;
//             component = (centre[c][j] + noise) / 65536
//   streams   'data' for stored rows, 'query' for queries (separate draws, the same centres)
//
// SplitMix64 is done on two uint32 halves (no BigInt): about 30 operations per draw.

const GAMMA_HI = 0x9e3779b9;
const GAMMA_LO = 0x7f4a7c15;
const STREAM_HI = { data: 0xd1b54a32, query: 0x8cb92ba7 } as const;
const STREAM_LO = { data: 0xd192ed03, query: 0x2f3d8dd7 } as const;

/** High 32 bits of the unsigned 32 x 32 product. */
function mulhi32(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  return (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
}

export class SplitMix64 {
  /** The last draw, high and low 32 bits. */
  zh = 0;
  zl = 0;
  constructor(
    private hi: number,
    private lo: number,
  ) {
    this.hi >>>= 0;
    this.lo >>>= 0;
  }
  next(): void {
    const sum = this.lo + GAMMA_LO;
    this.lo = sum >>> 0;
    this.hi = (this.hi + GAMMA_HI + (sum > 0xffffffff ? 1 : 0)) >>> 0;
    let zh = this.hi;
    let zl = this.lo;
    // z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
    let sl = ((zh << 2) | (zl >>> 30)) >>> 0;
    let sh = zh >>> 30;
    zl = (zl ^ sl) >>> 0;
    zh = (zh ^ sh) >>> 0;
    let nh =
      (mulhi32(zl, 0x1ce4e5b9) + Math.imul(zl, 0xbf58476d) + Math.imul(zh, 0x1ce4e5b9)) >>> 0;
    zl = Math.imul(zl, 0x1ce4e5b9) >>> 0;
    zh = nh;
    // z = (z ^ (z >> 27)) * 0x94D049BB133111EB
    sl = ((zh << 5) | (zl >>> 27)) >>> 0;
    sh = zh >>> 27;
    zl = (zl ^ sl) >>> 0;
    zh = (zh ^ sh) >>> 0;
    nh = (mulhi32(zl, 0x133111eb) + Math.imul(zl, 0x94d049bb) + Math.imul(zh, 0x133111eb)) >>> 0;
    zl = Math.imul(zl, 0x133111eb) >>> 0;
    zh = nh;
    // z ^ (z >> 31)
    sl = ((zh << 1) | (zl >>> 31)) >>> 0;
    sh = zh >>> 31;
    this.zl = (zl ^ sl) >>> 0;
    this.zh = (zh ^ sh) >>> 0;
  }
}

/** `n` centres of `dim` integer coordinates each, row-major. */
export function clusteredCentres(seed: number, n: number, dim: number): Int32Array {
  const rng = new SplitMix64(0, seed);
  const out = new Int32Array(n * dim);
  for (let i = 0; i < out.length; i++) {
    rng.next();
    out[i] = (rng.zh >>> 11) - (1 << 20);
  }
  return out;
}

/** Points of one stream, one at a time: `nextInto` writes `dim` components. */
export class ClusteredStream {
  private readonly rng: SplitMix64;
  private readonly nCentres: number;
  constructor(
    private readonly centres: Int32Array,
    readonly dim: number,
    seed: number,
    stream: 'data' | 'query',
  ) {
    this.nCentres = centres.length / dim;
    this.rng = new SplitMix64(STREAM_HI[stream], (seed ^ STREAM_LO[stream]) >>> 0);
  }
  nextInto(out: Float32Array, offset = 0): void {
    const r = this.rng;
    r.next();
    const c = (r.zh % this.nCentres) * this.dim;
    for (let j = 0; j < this.dim; j++) {
      r.next();
      const s = (r.zl & 0xffff) + (r.zl >>> 16) + (r.zh & 0xffff) + (r.zh >>> 16);
      out[offset + j] = (this.centres[c + j]! + (s - 131070) * 8) / 65536;
    }
  }
}

/** `count` points of the stream, row-major. */
export function clusteredPoints(
  centres: Int32Array,
  dim: number,
  seed: number,
  stream: 'data' | 'query',
  count: number,
): Float32Array {
  const s = new ClusteredStream(centres, dim, seed, stream);
  const out = new Float32Array(count * dim);
  for (let i = 0; i < count; i++) s.nextInto(out, i * dim);
  return out;
}

/** The clustered rows and queries of one set: `{ rows, queries }`. */
export function clusteredSet(
  seed: number,
  nCentres: number,
  dim: number,
  rows: number,
  queries: number,
): { rows: Float32Array; queries: Float32Array } {
  const c = clusteredCentres(seed, nCentres, dim);
  return {
    rows: clusteredPoints(c, dim, seed, 'data', rows),
    queries: clusteredPoints(c, dim, seed, 'query', queries),
  };
}

/** The fixed 10,000 x 384 clustered set of the recall floor (100 centres, 200 queries, seed 10,000). */
export const RECALL_SET = { seed: 10_000, centres: 100, dim: 384, rows: 10_000, queries: 200 };
