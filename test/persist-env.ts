// Shared plumbing for behavioural suites that need a store that can be closed and opened again over
// the SAME storage (a page reload). The memory driver runs them in Vitest; the OPFS and IndexedDB
// drivers run the very same cases inside Chrome (test/browser/harness.ts). Framework agnostic.
import type { StorageApi, StorageDriver } from '../src/contracts/storage-api';

export interface PersistOptions {
  clock?: () => number;
  quotaBytes?: number;
  vectorKernel?: 'auto' | 'simd' | 'scalar';
}

export interface PersistEnv {
  /** A fresh, EMPTY store (persistent drivers wipe their storage first). */
  makeStore(opts?: PersistOptions): Promise<StorageApi>;
  /** A new store over the SAME storage with no wipe: what a page reload sees. */
  reopen(opts?: PersistOptions): Promise<StorageApi>;
  /** A raw, opened driver over the same storage, for forging or inspecting records. The caller closes it. */
  raw(): Promise<StorageDriver>;
}

export interface PersistCase {
  name: string;
  run: (env: PersistEnv) => Promise<void>;
}

export interface PersistResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export function runPersistCases(
  cases: readonly PersistCase[],
  env: PersistEnv,
  define: (name: string, fn: () => Promise<void>) => unknown,
): void {
  for (const c of cases) define(c.name, () => c.run(env));
}

/** Runs every case sequentially and returns results (used by the browser harness). */
export async function collectPersistCases(
  cases: readonly PersistCase[],
  env: PersistEnv,
): Promise<PersistResult[]> {
  const results: PersistResult[] = [];
  for (const c of cases) {
    const t0 = performance.now();
    try {
      await c.run(env);
      results.push({ name: c.name, ok: true, ms: performance.now() - t0 });
    } catch (e) {
      results.push({
        name: c.name,
        ok: false,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        ms: performance.now() - t0,
      });
    }
  }
  return results;
}

/** A store, closed whatever happens. */
export async function using(
  store: StorageApi,
  fn: (s: StorageApi) => Promise<void>,
): Promise<void> {
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}
