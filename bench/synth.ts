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
