// query() behaviour suite for the flat vector index (Storage API 0.2.0). The 13 cases were written in
// Sprint 2 against the proposal in docs/vector-index.md and skipped; Sprint 4 un-skipped them with one
// edit: a put() helper that writes through putVectors() where they used to call set(). Every assertion
// is unchanged. The cases depend only on the public SDK surface and test/assert.ts, so the same list
// runs against memory (test/memory.test.ts) and against OPFS and IndexedDB in Chrome
// (test/browser/harness.ts).
import type { QueryHit, StorageApi } from '../src/contracts/storage-api';
import { deepEq, eq, ok, rejectsWith } from './assert';
import type { MakeStore } from './storage.behaviour';

function q(store: StorageApi) {
  return (
    ns: string,
    vector: Float32Array,
    k: number,
    opts?: { filterPrefix?: string; metric?: 'cosine' | 'dot' },
  ): Promise<QueryHit[]> => store.query(ns, vector, k, opts);
}

/** Writes one vector row (one putVectors call, so each call is its own segment). */
function put(store: StorageApi, ns: string, key: string, vector: Float32Array): Promise<unknown> {
  return store.putVectors(ns, [{ key, vector }]);
}

const NS = 'vec';

function v(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

function keysOf(hits: QueryHit[]): string[] {
  return hits.map((h) => h.key);
}

async function withStore(makeStore: MakeStore, fn: (store: StorageApi) => Promise<void>) {
  const store = await makeStore();
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

export interface QueryCase {
  name: string;
  run: (makeStore: MakeStore) => Promise<void>;
}

export const queryCases: QueryCase[] = [
  {
    name: 'cosine orders integer vectors by angle, not length',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'a', v(1, 0));
        await put(store, NS, 'b', v(10, 10));
        await put(store, NS, 'c', v(0, 5));
        await put(store, NS, 'd', v(-3, 0));
        const hits = await q(store)(NS, v(1, 0), 4);
        await deepEq(keysOf(hits), ['a', 'b', 'c', 'd'], 'cosine order');
        eq(hits[0]?.score, 1, 'identical direction scores exactly 1');
        eq(hits[3]?.score, -1, 'opposite direction scores exactly -1');
      }),
  },
  {
    name: 'dot metric orders by inner product, so length matters',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'short', v(1, 0));
        await put(store, NS, 'long', v(10, 10));
        await put(store, NS, 'neg', v(-3, 0));
        const hits = await q(store)(NS, v(1, 0), 3, { metric: 'dot' });
        await deepEq(keysOf(hits), ['long', 'short', 'neg'], 'dot order');
        eq(hits[0]?.score, 10, 'dot score');
      }),
  },
  {
    name: 'k = 0 returns an empty array',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'a', v(1, 0));
        await deepEq(await q(store)(NS, v(1, 0), 0), [], 'k=0');
      }),
  },
  {
    name: 'k larger than the count returns every vector',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'a', v(1, 0));
        await put(store, NS, 'b', v(0, 1));
        const hits = await q(store)(NS, v(1, 1), 1000);
        eq(hits.length, 2, 'hit count');
      }),
  },
  {
    name: 'invalid k (negative, fractional, NaN, Infinity) throws invalid_value',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        for (const k of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          await rejectsWith(q(store)(NS, v(1, 0), k), 'invalid_value');
        }
      }),
  },
  {
    name: 'namespaces are isolated',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, 'one', 'a', v(1, 0));
        await put(store, 'two', 'b', v(1, 0));
        await deepEq(keysOf(await q(store)('one', v(1, 0), 10)), ['a'], 'ns one');
        await deepEq(keysOf(await q(store)('two', v(1, 0), 10)), ['b'], 'ns two');
        await deepEq(await q(store)('three', v(1, 0), 10), [], 'ns three is empty');
      }),
  },
  {
    name: 'an empty store returns an empty array',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await deepEq(await q(store)(NS, v(1, 0), 5), [], 'empty store');
      }),
  },
  {
    name: 'deleted keys are never returned',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'a', v(1, 0));
        await put(store, NS, 'b', v(0.9, 0.1));
        ok(await store.delete(NS, 'a'), 'delete reports true');
        await deepEq(keysOf(await q(store)(NS, v(1, 0), 5)), ['b'], 'after delete');
      }),
  },
  {
    name: 'an overwritten key is ranked by its new vector',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'a', v(1, 0));
        await put(store, NS, 'b', v(0, 1));
        await put(store, NS, 'a', v(0, -1));
        await deepEq(keysOf(await q(store)(NS, v(0, 1), 2)), ['b', 'a'], 'after overwrite');
      }),
  },
  {
    name: 'filterPrefix restricts candidates to keys with that prefix',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'doc/1', v(1, 0));
        await put(store, NS, 'doc/2', v(0, 1));
        await put(store, NS, 'img/1', v(1, 0));
        const hits = await q(store)(NS, v(1, 0), 10, { filterPrefix: 'doc/' });
        await deepEq(keysOf(hits), ['doc/1', 'doc/2'], 'prefix doc/');
      }),
  },
  {
    name: 'a query vector with the wrong dimension throws invalid_value',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'a', v(1, 0, 0));
        await rejectsWith(q(store)(NS, v(1, 0), 1), 'invalid_value');
      }),
  },
  {
    name: 'a zero vector under cosine scores 0 and never yields NaN',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'zero', v(0, 0));
        await put(store, NS, 'a', v(1, 0));
        const hits = await q(store)(NS, v(1, 0), 2);
        await deepEq(keysOf(hits), ['a', 'zero'], 'zero vector ranks last');
        eq(hits[1]?.score, 0, 'zero vector score');
        const zeroQuery = await q(store)(NS, v(0, 0), 2);
        for (const h of zeroQuery) ok(!Number.isNaN(h.score), 'no NaN score');
      }),
  },
  {
    name: 'ties are broken by key in byte order',
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await put(store, NS, 'b', v(1, 0));
        await put(store, NS, 'a', v(1, 0));
        await put(store, NS, 'B', v(1, 0));
        await deepEq(keysOf(await q(store)(NS, v(1, 0), 3)), ['B', 'a', 'b'], 'byte order ties');
      }),
  },
];

/** Registers every case with `define`. */
export function runQuerySuite(
  makeStore: MakeStore,
  define: (name: string, fn: () => Promise<void>) => unknown,
): void {
  for (const c of queryCases) define(c.name, () => c.run(makeStore));
}
