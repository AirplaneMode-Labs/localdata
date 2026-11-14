// Reference implementation of the Storage API 0.2.0 scoring and ordering rules, written with
// Math.fround after every operation and a UTF-8 byte-order key comparison that does not share code
// with the production path. It is the oracle for the tests and the benchmark; it is NOT exported from
// the package root and is not part of the shipped bundle (nothing in src/ imports it).
//
// Why Math.fround is bit-identical to the WASM kernels: a product of two binary32 values is exact in a
// double, and a sum or quotient of binary32 values computed in a double and then rounded to binary32
// equals the directly rounded result (a double carries more than 2 * 24 + 2 bits), and so does a
// square root. So rounding with Math.fround after each operation reproduces IEEE binary32.
import type { VectorMetric } from '../contracts/storage-api';

export const SELF_DOT_MAX = 1e30;

/** dot4: four accumulators from +0, element i into accumulator i mod 4, then (a0 + a1) + (a2 + a3). */
export function dot4Ref(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const acc = [0, 0, 0, 0];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const p = Math.fround(Math.fround(a[i]!) * Math.fround(b[i]!));
    acc[i & 3] = Math.fround(acc[i & 3]! + p);
  }
  return Math.fround(Math.fround(acc[0]! + acc[1]!) + Math.fround(acc[2]! + acc[3]!));
}

/** 0 for a zero self dot product, otherwise 1 / sqrt(selfDot) in binary32. */
export function invNormRef(v: ArrayLike<number>): number {
  const sd = dot4Ref(v, v);
  return sd === 0 ? 0 : Math.fround(1 / Math.fround(Math.sqrt(sd)));
}

/** True when every component is finite and selfDot <= 1e30 (the contract's row and query rule). */
export function vectorOkRef(v: ArrayLike<number>): boolean {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i]!)) return false;
  const sd = dot4Ref(v, v);
  return Number.isFinite(sd) && sd <= SELF_DOT_MAX;
}

/** The score of one row against a query. -0 becomes +0. */
export function scoreRef(
  row: ArrayLike<number>,
  rowInvNorm: number,
  q: ArrayLike<number>,
  qInvNorm: number,
  metric: VectorMetric,
): number {
  const d = dot4Ref(row, q);
  const s =
    metric === 'dot'
      ? d
      : Math.fround(Math.fround(d * Math.fround(rowInvNorm)) * Math.fround(qInvNorm));
  return s === 0 ? 0 : s;
}

const encoder = new TextEncoder();

/** Compares two strings by their UTF-8 bytes (what the contract calls "key ascending by UTF-8 bytes"). */
export function compareUtf8Ref(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export interface RefRow {
  key: string;
  vector: Float32Array;
}

export interface RefHit {
  key: string;
  score: number;
}

/** Starts-with on UTF-8 bytes, for well-formed strings. */
function hasPrefixUtf8(key: string, prefix: string): boolean {
  const k = encoder.encode(key);
  const p = encoder.encode(prefix);
  if (p.length > k.length) return false;
  for (let i = 0; i < p.length; i++) if (k[i] !== p[i]) return false;
  return true;
}

/**
 * The full, naive answer: score every live row, sort by score descending then key ascending by UTF-8
 * bytes, keep min(k, candidates). `rows` must be the LIVE rows only; it may be a lazy iterable, and only
 * a key and a score are kept per row.
 */
export function topKRef(
  rows: Iterable<RefRow>,
  q: Float32Array,
  k: number,
  metric: VectorMetric,
  filterPrefix?: string,
): RefHit[] {
  const qInv = invNormRef(q);
  const scored: RefHit[] = [];
  for (const r of rows) {
    if (filterPrefix !== undefined && !hasPrefixUtf8(r.key, filterPrefix)) continue;
    scored.push({ key: r.key, score: scoreRef(r.vector, invNormRef(r.vector), q, qInv, metric) });
  }
  scored.sort((a, b) =>
    a.score > b.score ? -1 : a.score < b.score ? 1 : compareUtf8Ref(a.key, b.key),
  );
  return scored.slice(0, Math.max(0, Math.min(k, scored.length)));
}

/** The f32 bit pattern of a number, for bit-for-bit comparisons. */
export function f32Bits(x: number): number {
  const f = new Float32Array(1);
  f[0] = x;
  return new Uint32Array(f.buffer)[0]!;
}
