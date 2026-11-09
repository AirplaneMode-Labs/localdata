// query() test suite for the Sprint 4 flat index (design: docs/vector-index.md). Written now,
// skipped until the index lands. One live case asserts the 0.1.0 behaviour (not_implemented naming
// Sprint 4). The cases depend only on the public SDK surface and test/assert.ts so the same list can
// run against memory (test/memory.test.ts) and, once enabled, against OPFS and IndexedDB through
// test/browser/harness.ts.
//
// Anything not in Storage API 0.1.0 is declared here as a local type and is a PROPOSAL listed in
// docs/vector-index.md: the `metric` option ('cosine' default, or 'dot'). src/contracts is untouched.
import type { QueryHit, StorageApi } from '../src/contracts/storage-api';
import { deepEq, eq, ok, rejectsWith } from './assert';
import type { MakeStore } from './storage.behaviour';

export const SKIP_NOTE = 'Sprint 4: flat index (docs/vector-index.md)';

/** Proposal, not in 0.1.0: query options plus a metric. */
interface ProposedQueryOptions {
  filterPrefix?: string;
  metric?: 'cosine' | 'dot';
}

type ProposedQuery = (
  ns: string,
  vector: Float32Array,
  k: number,
  opts?: ProposedQueryOptions,
) => Promise<QueryHit[]>;

function q(store: StorageApi): ProposedQuery {
  return (ns, vector, k, opts) =>
    (store.query as unknown as ProposedQuery).call(store, ns, vector, k, opts);
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
  /** True while the case waits for Sprint 4; false for the live 0.1.0 assertion. */
  skipped: boolean;
  run: (makeStore: MakeStore) => Promise<void>;
}

export const queryCases: QueryCase[] = [
  {
    name: 'query throws not_implemented naming Sprint 4 (0.1.0, live)',
    skipped: false,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await rejectsWith(store.query(NS, v(1, 0), 1), 'not_implemented', 'Sprint 4');
      }),
  },
  {
    name: 'cosine orders integer vectors by angle, not length',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'a', v(1, 0));
        await store.set(NS, 'b', v(10, 10));
        await store.set(NS, 'c', v(0, 5));
        await store.set(NS, 'd', v(-3, 0));
        const hits = await q(store)(NS, v(1, 0), 4);
        await deepEq(keysOf(hits), ['a', 'b', 'c', 'd'], 'cosine order');
        eq(hits[0]?.score, 1, 'identical direction scores exactly 1');
        eq(hits[3]?.score, -1, 'opposite direction scores exactly -1');
      }),
  },
  {
    name: 'dot metric orders by inner product, so length matters',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'short', v(1, 0));
        await store.set(NS, 'long', v(10, 10));
        await store.set(NS, 'neg', v(-3, 0));
        const hits = await q(store)(NS, v(1, 0), 3, { metric: 'dot' });
        await deepEq(keysOf(hits), ['long', 'short', 'neg'], 'dot order');
        eq(hits[0]?.score, 10, 'dot score');
      }),
  },
  {
    name: 'k = 0 returns an empty array',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'a', v(1, 0));
        await deepEq(await q(store)(NS, v(1, 0), 0), [], 'k=0');
      }),
  },
  {
    name: 'k larger than the count returns every vector',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'a', v(1, 0));
        await store.set(NS, 'b', v(0, 1));
        const hits = await q(store)(NS, v(1, 1), 1000);
        eq(hits.length, 2, 'hit count');
      }),
  },
  {
    name: 'invalid k (negative, fractional, NaN, Infinity) throws invalid_value',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        for (const k of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          await rejectsWith(q(store)(NS, v(1, 0), k), 'invalid_value');
        }
      }),
  },
  {
    name: 'namespaces are isolated',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set('one', 'a', v(1, 0));
        await store.set('two', 'b', v(1, 0));
        await deepEq(keysOf(await q(store)('one', v(1, 0), 10)), ['a'], 'ns one');
        await deepEq(keysOf(await q(store)('two', v(1, 0), 10)), ['b'], 'ns two');
        await deepEq(await q(store)('three', v(1, 0), 10), [], 'ns three is empty');
      }),
  },
  {
    name: 'an empty store returns an empty array',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await deepEq(await q(store)(NS, v(1, 0), 5), [], 'empty store');
      }),
  },
  {
    name: 'deleted keys are never returned',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'a', v(1, 0));
        await store.set(NS, 'b', v(0.9, 0.1));
        ok(await store.delete(NS, 'a'), 'delete reports true');
        await deepEq(keysOf(await q(store)(NS, v(1, 0), 5)), ['b'], 'after delete');
      }),
  },
  {
    name: 'an overwritten key is ranked by its new vector',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'a', v(1, 0));
        await store.set(NS, 'b', v(0, 1));
        await store.set(NS, 'a', v(0, -1));
        await deepEq(keysOf(await q(store)(NS, v(0, 1), 2)), ['b', 'a'], 'after overwrite');
      }),
  },
  {
    name: 'filterPrefix restricts candidates to keys with that prefix',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'doc/1', v(1, 0));
        await store.set(NS, 'doc/2', v(0, 1));
        await store.set(NS, 'img/1', v(1, 0));
        const hits = await q(store)(NS, v(1, 0), 10, { filterPrefix: 'doc/' });
        await deepEq(keysOf(hits), ['doc/1', 'doc/2'], 'prefix doc/');
      }),
  },
  {
    name: 'a query vector with the wrong dimension throws invalid_value',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'a', v(1, 0, 0));
        await rejectsWith(q(store)(NS, v(1, 0), 1), 'invalid_value');
      }),
  },
  {
    name: 'a zero vector under cosine scores 0 and never yields NaN',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'zero', v(0, 0));
        await store.set(NS, 'a', v(1, 0));
        const hits = await q(store)(NS, v(1, 0), 2);
        await deepEq(keysOf(hits), ['a', 'zero'], 'zero vector ranks last');
        eq(hits[1]?.score, 0, 'zero vector score');
        const zeroQuery = await q(store)(NS, v(0, 0), 2);
        for (const h of zeroQuery) ok(!Number.isNaN(h.score), 'no NaN score');
      }),
  },
  {
    name: 'ties are broken by key in byte order',
    skipped: true,
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        await store.set(NS, 'b', v(1, 0));
        await store.set(NS, 'a', v(1, 0));
        await store.set(NS, 'B', v(1, 0));
        await deepEq(keysOf(await q(store)(NS, v(1, 0), 3)), ['B', 'a', 'b'], 'byte order ties');
      }),
  },
];

/** Registers the cases: live ones with `define`, Sprint 4 ones with `defineSkipped`. */
export function runQuerySuite(
  makeStore: MakeStore,
  define: (name: string, fn: () => Promise<void>) => unknown,
  defineSkipped: (name: string, fn: () => Promise<void>) => unknown,
): void {
  for (const c of queryCases) {
    (c.skipped ? defineSkipped : define)(c.skipped ? `${c.name} [${SKIP_NOTE}]` : c.name, () =>
      c.run(makeStore),
    );
  }
}
