// Framework-agnostic assertions so the behavioural suite runs under Vitest (Node) and inside the
// Playwright browser harness without pulling a test framework into the bundle.
import { StorageError, type StorageErrorCode } from '../src/contracts/storage-api';

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function ok(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

export function eq<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(`${message}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

export function bytesEq(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  message = 'bytes',
): void {
  ok(
    actual.length === expected.length,
    `${message}: length ${actual.length} !== ${expected.length}`,
  );
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new AssertionError(`${message}: byte ${i} is ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

function show(v: unknown): string {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const TYPED = [
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;

/** Deep equality that preserves NaN, -0, Date identity by time, typed-array class and Blob type. */
export async function valuesEqual(a: unknown, b: unknown): Promise<boolean> {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof ArrayBuffer || b instanceof ArrayBuffer) {
    if (!(a instanceof ArrayBuffer && b instanceof ArrayBuffer)) return false;
    return sameBytes(new Uint8Array(a), new Uint8Array(b));
  }
  for (const T of TYPED) {
    if (a instanceof T || b instanceof T) {
      if (!(a instanceof T && b instanceof T)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const x = (a as ArrayLike<number | bigint>)[i];
        const y = (b as ArrayLike<number | bigint>)[i];
        if (typeof x === 'number' && typeof y === 'number') {
          if (!Object.is(x, y) && !(Number.isNaN(x) && Number.isNaN(y))) return false;
        } else if (x !== y) return false;
      }
      return true;
    }
  }
  if (typeof Blob !== 'undefined' && (a instanceof Blob || b instanceof Blob)) {
    if (!(a instanceof Blob && b instanceof Blob)) return false;
    if (a.type !== b.type || a.size !== b.size) return false;
    return sameBytes(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer()));
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!(await valuesEqual(a[i], b[i]))) return false;
    return true;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  for (const k of ka) {
    if (
      !(await valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    ) {
      return false;
    }
  }
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function deepEq(
  actual: unknown,
  expected: unknown,
  message = 'deep equality',
): Promise<void> {
  if (!(await valuesEqual(actual, expected))) {
    throw new AssertionError(`${message}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

/** Awaits a rejection and asserts it is a StorageError with the given code. Returns the error. */
export async function rejectsWith(
  p: Promise<unknown> | (() => Promise<unknown>),
  code: StorageErrorCode,
  messageIncludes?: string,
): Promise<StorageError> {
  let err: unknown;
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    err = e;
  }
  ok(err !== undefined, `expected rejection with StorageError code ${code}, but it resolved`);
  ok(
    err instanceof StorageError || (err as { name?: string })?.name === 'StorageError',
    `expected StorageError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`,
  );
  const se = err as StorageError;
  eq(se.code, code, 'StorageError code');
  if (messageIncludes !== undefined) {
    ok(se.message.includes(messageIncludes), `message "${se.message}" lacks "${messageIncludes}"`);
  }
  return se;
}
