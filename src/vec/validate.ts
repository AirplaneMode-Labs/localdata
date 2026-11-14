// Input validation for the vector API (Storage API 0.2.0). None of these messages or details ever
// contains a key, a filterPrefix, a vector component, a score or a value: a bad row is identified by
// its 0-based position in the call (details.row).
import {
  STORAGE_KEY_MAX,
  StorageError,
  VECTOR_DIM_MAX,
  VECTOR_KEY_UTF8_MAX,
  type VectorMetric,
} from '../contracts/storage-api';

const encoder = new TextEncoder();

/** UTF-8 length of a string without allocating when it is short ASCII. */
export function utf8Length(s: string): number {
  return encoder.encode(s).byteLength;
}

export function isWellFormed(s: string): boolean {
  const f = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof f === 'function') return f.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** Row key rules: the storage key rules, well formed, UTF-8 length <= 4096. Throws invalid_key. */
export function checkRowKey(key: unknown, row: number): asserts key is string {
  if (
    typeof key !== 'string' ||
    key.length < 1 ||
    key.length > STORAGE_KEY_MAX ||
    key.includes('\u0000') ||
    !isWellFormed(key) ||
    utf8Length(key) > VECTOR_KEY_UTF8_MAX
  ) {
    throw new StorageError(
      'invalid_key',
      `row ${row}: invalid key (1..${STORAGE_KEY_MAX} UTF-16 code units, no U+0000, well formed, at most ${VECTOR_KEY_UTF8_MAX} UTF-8 bytes)`,
      { row },
    );
  }
}

/** Shape check of a vector (not its values): a Float32Array of length 1..4096. */
export function checkVectorShape(v: unknown): asserts v is Float32Array {
  if (!(v instanceof Float32Array) || v.length < 1 || v.length > VECTOR_DIM_MAX) {
    throw new StorageError(
      'invalid_value',
      `vector must be a Float32Array of length 1..${VECTOR_DIM_MAX}`,
      { reason: 'vector' },
    );
  }
}

/**
 * dot4 of v with itself, with every operation rounded to binary32: bit-identical to the kernel's
 * selfDot (see src/vec/reference.ts for why Math.fround reproduces binary32). Used only for the
 * query vector; rows are checked in bulk by the kernel.
 */
export function selfDot(v: Float32Array): number {
  const acc = [0, 0, 0, 0];
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    acc[i & 3] = Math.fround(acc[i & 3]! + Math.fround(x * x));
  }
  return Math.fround(Math.fround(acc[0]! + acc[1]!) + Math.fround(acc[2]! + acc[3]!));
}

/** True when every component is finite and selfDot <= 1e30. */
export function vectorValuesOk(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i]!)) return false;
  const sd = selfDot(v);
  return Number.isFinite(sd) && sd <= 1e30;
}

/** Query step 3: k is an integer 0..2147483647. */
export function checkK(k: unknown): asserts k is number {
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k > 2147483647) {
    throw new StorageError('invalid_value', 'k must be an integer 0..2147483647', { reason: 'k' });
  }
}

/** Query step 4. */
export function checkQueryVector(v: unknown): asserts v is Float32Array {
  checkVectorShape(v);
  if (!vectorValuesOk(v)) {
    throw new StorageError(
      'invalid_value',
      'the query vector must have only finite components and a self dot product of at most 1e30',
      { reason: 'vector' },
    );
  }
}

/** Query step 5. */
export function checkFilterPrefix(p: unknown): asserts p is string {
  if (
    typeof p !== 'string' ||
    !isWellFormed(p) ||
    p.includes('\u0000') ||
    utf8Length(p) > VECTOR_KEY_UTF8_MAX
  ) {
    throw new StorageError(
      'invalid_value',
      `filterPrefix must be a well-formed string without U+0000 and at most ${VECTOR_KEY_UTF8_MAX} UTF-8 bytes`,
      { reason: 'filter_prefix' },
    );
  }
}

/** Query step 6. */
export function checkMetric(m: unknown): asserts m is VectorMetric {
  if (m !== 'cosine' && m !== 'dot') {
    throw new StorageError('invalid_value', "metric must be 'cosine' or 'dot'", {
      reason: 'metric',
    });
  }
}
