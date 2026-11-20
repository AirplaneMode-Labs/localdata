// Behavioural suite for the HNSW index kind (Storage API 0.4.0): buildIndex, dropIndex, query({ index,
// ef }), indexInfo().ann, usage().annBytes and clear. The same cases run in Vitest against the memory
// driver and the OPFS driver over the in-memory OPFS (test/ann.test.ts) and inside Chrome against real
// OPFS and IndexedDB (test/browser/ann.spec.ts). They depend only on the public SDK surface, the raw
// driver for inspecting records, and the integer-only generator of bench/synth.ts.
import {
  ANN_NS_PREFIX,
  type QueryHit,
  type StorageApi,
  type StorageDriver,
  type VectorRow,
} from '../src/contracts/storage-api';
import type { Event, EventSink } from '../src/contracts/event';
import { f32Bits } from '../src/vec/reference';
import { clusteredSet, synthKey, synthVector } from '../bench/synth';
import { bytesEq, deepEq, eq, ok, rejectsWith } from './assert';

export interface AnnStoreOptions {
  quotaBytes?: number;
  maxIndexBytes?: number;
  vectorKernel?: 'auto' | 'simd' | 'scalar';
  events?: EventSink;
  /** Wraps the driver the store is built on (to count writes, fail a put, or corrupt a read). */
  wrap?: (d: StorageDriver) => StorageDriver;
}

export interface AnnEnv {
  /** A fresh, EMPTY store (persistent drivers wipe their storage first). */
  makeStore(opts?: AnnStoreOptions): Promise<StorageApi>;
  /** A new store over the SAME storage with no wipe: what a page reload sees. */
  reopen(opts?: AnnStoreOptions): Promise<StorageApi>;
  /** A raw, opened driver over the same storage. The caller closes it. */
  raw(): Promise<StorageDriver>;
}

export interface AnnCase {
  name: string;
  run: (env: AnnEnv) => Promise<void>;
}

export const NS = 'vecs';
export const ANN_NS = `${ANN_NS_PREFIX}${NS}`;
export const D = 32;
export const N = 400;
export const NQ = 30;
const data = clusteredSet(77, 6, D, N, NQ);

export const key = synthKey;
export function rowVec(i: number): Float32Array {
  return data.rows.slice(i * D, (i + 1) * D);
}
export function row(i: number): VectorRow {
  return { key: synthKey(i), vector: rowVec(i) };
}
export function rows(from: number, count: number): VectorRow[] {
  return Array.from({ length: count }, (_, i) => row(from + i));
}
export function query(j: number): Float32Array {
  return data.queries.slice(j * D, (j + 1) * D);
}

export const keysOf = (hits: QueryHit[]): string[] => hits.map((h) => h.key);
export const bitsOf = (hits: QueryHit[]): number[] => hits.map((h) => f32Bits(h.score));

async function withStore(
  env: AnnEnv,
  opts: AnnStoreOptions | undefined,
  fn: (s: StorageApi) => Promise<void>,
): Promise<void> {
  const s = await env.makeStore(opts);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

/** Every row's flat score for one query: key -> score bits (the ground truth for "exact scores"). */
export async function flatScores(
  s: StorageApi,
  q: Float32Array,
  total: number,
  ns = NS,
): Promise<Map<string, number>> {
  const all = await s.query(ns, q, total, { values: false });
  return new Map(all.map((h) => [h.key, f32Bits(h.score)]));
}

/** Mean recall@10 of the hnsw answers against the flat answers over the first `queries` queries. */
export async function meanRecall(
  s: StorageApi,
  queries: number,
  ef: number,
  ns = NS,
  q: (j: number) => Float32Array = query,
): Promise<number> {
  let sum = 0;
  for (let j = 0; j < queries; j++) {
    const flat = keysOf(await s.query(ns, q(j), 10, { values: false }));
    const ann = keysOf(await s.query(ns, q(j), 10, { values: false, index: 'hnsw', ef }));
    sum += ann.filter((k) => flat.includes(k)).length / Math.max(1, flat.length);
  }
  return sum / queries;
}

/** The raw bytes of the namespace's graph record, or undefined. */
export async function graphBytes(env: AnnEnv, ns = NS): Promise<Uint8Array | undefined> {
  const d = await env.raw();
  try {
    return (await d.getBytes(`${ANN_NS_PREFIX}${ns}`, 'graph'))?.bytes;
  } finally {
    await d.close();
  }
}

export const annCases: AnnCase[] = [
  {
    name: 'buildIndex, then query({index:"hnsw"}) gives flat-identical scores for every hit and high recall',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, N));
        const r = await s.buildIndex(NS, { kind: 'hnsw', m: 12, efConstruction: 100 });
        eq(r.kind, 'hnsw');
        eq(r.rows, N);
        eq(r.liveRows, N);
        eq(r.replaced, false);
        eq(r.generation, 1);
        ok(r.bytes > 0, 'graph bytes');
        for (let j = 0; j < 10; j++) {
          const truth = await flatScores(s, query(j), N);
          const hits = await s.query(NS, query(j), 10, { index: 'hnsw', ef: 64 });
          ok(hits.length > 0 && hits.length <= 10, 'hit count');
          for (const h of hits) eq(f32Bits(h.score), truth.get(h.key)!, `score of ${h.key}`);
          for (let i = 1; i < hits.length; i++) {
            const a = hits[i - 1]!;
            const b = hits[i]!;
            ok(
              a.score > b.score || (a.score === b.score && a.key < b.key),
              'ordered as flat orders them',
            );
          }
        }
        const recall = await meanRecall(s, NQ, 64);
        ok(recall >= 0.9, `recall@10 ${recall}`);
      }),
  },
  {
    name: 'a graph persists: close, reopen, the same hits, indexInfo().ann is current',
    run: async (env) => {
      const a = await env.makeStore();
      await a.putVectors(NS, rows(0, N));
      await a.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 64, seed: 5 });
      const before = await a.query(NS, query(3), 10, { index: 'hnsw', ef: 80 });
      await a.close();
      const b = await env.reopen();
      try {
        const info = await b.indexInfo(NS);
        ok(info?.ann !== undefined, 'ann info after reopen');
        eq(info.ann.kind, 'hnsw');
        eq(info.ann.current, true);
        eq(info.ann.nodes, N);
        eq(info.ann.liveNodes, N);
        eq(info.ann.m, 8);
        eq(info.ann.efConstruction, 64);
        eq(info.ann.seed, 5);
        eq(info.ann.metric, 'cosine');
        eq(info.ann.generation, info.generation);
        ok(info.ann.bytes > 0, 'ann bytes');
        const after = await b.query(NS, query(3), 10, { index: 'hnsw', ef: 80 });
        await deepEq(keysOf(after), keysOf(before));
        await deepEq(bitsOf(after), bitsOf(before));
      } finally {
        await b.close();
      }
    },
  },
  {
    name: 'putVectors keeps a current graph current: new rows are found, a replaced row answers with its new vector',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, N - 100));
        await s.buildIndex(NS, { kind: 'hnsw', m: 12, efConstruction: 100 });
        await s.putVectors(NS, rows(N - 100, 100));
        let info = await s.indexInfo(NS);
        eq(info?.ann?.current, true);
        eq(info?.ann?.nodes, N);
        eq(info?.ann?.generation, info?.generation);
        // a new row is found by its own vector
        const own = await s.query(NS, rowVec(N - 1), 3, { index: 'hnsw', ef: 128 });
        eq(own[0]!.key, key(N - 1));
        // a replaced row: chunk 5 now holds row 399's vector
        await s.putVectors(NS, [{ key: key(5), vector: rowVec(N - 1) }]);
        info = await s.indexInfo(NS);
        eq(info?.ann?.current, true);
        eq(info?.ann?.nodes, N + 1);
        eq(info?.ann?.liveNodes, N);
        const top = keysOf(await s.query(NS, rowVec(N - 1), 4, { index: 'hnsw', ef: 160 }));
        ok(top.includes(key(5)) && top.includes(key(N - 1)), `both copies found: ${top}`);
        const old = await s.query(NS, rowVec(5), 1, { index: 'hnsw', ef: 160 });
        ok(old[0]!.key !== key(5), 'the old vector of chunk 5 is gone');
        const recall = await meanRecall(s, NQ, 96);
        ok(recall >= 0.9, `recall after writes ${recall}`);
      }),
  },
  {
    name: 'delete never returns a deleted key from the graph, and a re-inserted key is found again',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, N));
        await s.buildIndex(NS, { kind: 'hnsw', m: 12, efConstruction: 100 });
        eq(await s.delete(NS, key(10)), true);
        const info = await s.indexInfo(NS);
        eq(info?.ann?.current, true);
        eq(info?.ann?.liveNodes, N - 1);
        const hits = await s.query(NS, rowVec(10), 20, { index: 'hnsw', ef: 160 });
        ok(!keysOf(hits).includes(key(10)), 'a deleted key was returned');
        for (let j = 0; j < 10; j++) {
          const h = await s.query(NS, rowVec(10 + j), 20, { index: 'hnsw', ef: 160 });
          ok(!keysOf(h).includes(key(10)), 'a deleted key was returned');
        }
        await s.putVectors(NS, [row(10)]);
        const again = await s.query(NS, rowVec(10), 3, { index: 'hnsw', ef: 160 });
        eq(again[0]!.key, key(10));
        eq((await s.indexInfo(NS))?.ann?.current, true);
      }),
  },
  {
    name: 'dropIndex removes the graph: true once, false after, queries fall back to the flat answer',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, 120));
        eq(await s.dropIndex(NS, 'hnsw'), false, 'nothing to drop');
        await s.buildIndex(NS, { kind: 'hnsw' });
        ok((await graphBytes(env)) !== undefined, 'graph record exists');
        eq(await s.dropIndex(NS, 'hnsw'), true);
        eq(await graphBytes(env), undefined);
        eq((await s.indexInfo(NS))?.ann, undefined);
        const flat = await s.query(NS, query(0), 10);
        const asked = await s.query(NS, query(0), 10, { index: 'hnsw' });
        await deepEq(keysOf(asked), keysOf(flat));
        await deepEq(bitsOf(asked), bitsOf(flat));
        await rejectsWith(s.dropIndex(NS, 'flat' as 'hnsw'), 'invalid_value');
        await rejectsWith(s.dropIndex('Bad NS', 'hnsw'), 'invalid_namespace');
      }),
  },
  {
    name: 'usage counts the graph: annBytes is in bytes, and absent without a graph',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, 200));
        const flat = await s.usage(NS);
        eq(flat.annBytes, undefined);
        const r = await s.buildIndex(NS, { kind: 'hnsw' });
        const u = await s.usage(NS);
        ok(u.annBytes !== undefined && u.annBytes >= r.bytes, `annBytes ${u.annBytes}`);
        eq(u.bytes, flat.bytes + u.annBytes!);
        eq(u.vectorBytes, flat.vectorBytes);
        const all = await s.usage();
        ok(all.annBytes !== undefined && all.annBytes >= r.bytes, 'annBytes over every namespace');
        await s.dropIndex(NS, 'hnsw');
        eq((await s.usage(NS)).annBytes, undefined);
      }),
  },
  {
    name: 'clear(ns) removes the graph namespace with the vectors',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, 100));
        await s.buildIndex(NS, { kind: 'hnsw' });
        await s.clear(NS);
        const d = await env.raw();
        try {
          eq((await d.keys(ANN_NS)).length, 0, 'no record left in the graph namespace');
          const names =
            (await (d as { namespaces?: () => Promise<string[]> }).namespaces?.()) ?? [];
          ok(
            names.every((n) => !n.startsWith(ANN_NS_PREFIX)),
            `a graph namespace survived: ${names}`,
          );
        } finally {
          await d.close();
        }
        eq((await s.usage(NS)).annBytes, undefined);
      }),
  },
  {
    name: 'deleting the last live row removes the graph namespace; the namespace can be built again',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, 3));
        await s.buildIndex(NS, { kind: 'hnsw', m: 4, efConstruction: 8 });
        for (let i = 0; i < 3; i++) await s.delete(NS, key(i));
        eq(await graphBytes(env), undefined, 'no graph record after the last row went');
        eq((await s.usage(NS)).annBytes, undefined);
        await s.putVectors(NS, rows(10, 5));
        const r = await s.buildIndex(NS, { kind: 'hnsw', m: 4, efConstruction: 8 });
        eq(r.liveRows, 5);
        eq(r.replaced, false);
      }),
  },
  {
    name: 'buildIndex on an empty namespace is allowed, and rows put afterwards are served by the graph',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        const r = await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 50 });
        eq(r.rows, 0);
        eq(r.liveRows, 0);
        eq(r.generation, 0);
        eq(r.replaced, false);
        ok(r.bytes > 0, 'an empty graph has a header');
        eq((await s.query(NS, query(0), 5, { index: 'hnsw' })).length, 0);
        await s.putVectors(NS, rows(0, 200));
        const info = await s.indexInfo(NS);
        eq(info?.ann?.current, true);
        eq(info?.ann?.nodes, 200);
        const own = await s.query(NS, rowVec(7), 3, { index: 'hnsw', ef: 96 });
        eq(own[0]!.key, key(7));
      }),
  },
  {
    name: 'buildIndex again replaces the graph (replaced true), is deterministic, and the seed changes the bytes',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, 250));
        const a = await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 60, seed: 3 });
        eq(a.replaced, false);
        const first = (await graphBytes(env))!;
        const b = await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 60, seed: 3 });
        eq(b.replaced, true);
        bytesEq((await graphBytes(env))!, first, 'same parameters, same graph bytes');
        const c = await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 60, seed: 4 });
        eq(c.replaced, true);
        const other = (await graphBytes(env))!;
        ok(
          other.length !== first.length || other.some((x, i) => x !== first[i]),
          'another seed gives another graph',
        );
        // a build over rows with deleted ones skips them (liveRows) and still never returns them
        await s.delete(NS, key(1));
        const d = await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 60, seed: 3 });
        eq(d.liveRows, 249);
        eq(d.rows, 249);
        const h = await s.query(NS, rowVec(1), 30, { index: 'hnsw', ef: 200 });
        ok(!keysOf(h).includes(key(1)), 'deleted row returned');
      }),
  },
  {
    name: 'a query that asks for another metric, a filterPrefix, or an absent graph gets the flat answer',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, 200));
        const absent = await s.query(NS, query(1), 10, { index: 'hnsw' });
        await deepEq(keysOf(absent), keysOf(await s.query(NS, query(1), 10)));
        await s.buildIndex(NS, { kind: 'hnsw' });
        const dot = await s.query(NS, query(1), 10, { index: 'hnsw', metric: 'dot' });
        const dotFlat = await s.query(NS, query(1), 10, { metric: 'dot' });
        await deepEq(keysOf(dot), keysOf(dotFlat));
        await deepEq(bitsOf(dot), bitsOf(dotFlat));
        const pre = await s.query(NS, query(1), 10, { index: 'hnsw', filterPrefix: 'chunk-0001' });
        const preFlat = await s.query(NS, query(1), 10, { filterPrefix: 'chunk-0001' });
        await deepEq(keysOf(pre), keysOf(preFlat));
        await deepEq(bitsOf(pre), bitsOf(preFlat));
        ok(pre.length > 0 && pre.every((h) => h.key.startsWith('chunk-0001')), 'filter honoured');
      }),
  },
  {
    name: 'values are returned from a graph query as from a flat query, and values:false leaves them off',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(
          NS,
          Array.from({ length: 150 }, (_, i) => ({ ...row(i), value: { n: i, t: `v${i}` } })),
        );
        await s.buildIndex(NS, { kind: 'hnsw' });
        const hits = await s.query(NS, rowVec(9), 5, { index: 'hnsw', ef: 100 });
        eq(hits[0]!.key, key(9));
        await deepEq(hits[0]!.value, { n: 9, t: 'v9' });
        const bare = await s.query(NS, rowVec(9), 5, { index: 'hnsw', ef: 100, values: false });
        eq(bare[0]!.value, undefined);
      }),
  },
  {
    name: 'option validation: ns first, then the shape, with details.reason',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await s.putVectors(NS, rows(0, 20));
        await rejectsWith(s.buildIndex('Bad NS', { kind: 'nope' } as never), 'invalid_namespace');
        const bad: Array<[unknown, string]> = [
          [{ kind: 'flat' }, 'kind'],
          [undefined, 'kind'],
          [{ kind: 'hnsw', m: 3 }, 'm'],
          [{ kind: 'hnsw', m: 65 }, 'm'],
          [{ kind: 'hnsw', m: 8.5 }, 'm'],
          [{ kind: 'hnsw', m: 16, efConstruction: 15 }, 'efConstruction'],
          [{ kind: 'hnsw', efConstruction: 1001 }, 'efConstruction'],
          [{ kind: 'hnsw', seed: -1 }, 'seed'],
          [{ kind: 'hnsw', seed: 2 ** 32 }, 'seed'],
          [{ kind: 'hnsw', seed: 1.5 }, 'seed'],
          [{ kind: 'hnsw', metric: 'l2' }, 'metric'],
        ];
        for (const [opts, reason] of bad) {
          const e = await rejectsWith(s.buildIndex(NS, opts as never), 'invalid_value');
          eq(e.details?.['reason'], reason, JSON.stringify(opts));
        }
        for (const [opts, reason] of [
          [{ index: 'ivf' }, 'kind'],
          [{ index: 'hnsw', ef: 0 }, 'ef'],
          [{ index: 'hnsw', ef: 1001 }, 'ef'],
          [{ index: 'hnsw', ef: 2.5 }, 'ef'],
        ] as Array<[Record<string, unknown>, string]>) {
          const e = await rejectsWith(s.query(NS, query(0), 5, opts as never), 'invalid_value');
          eq(e.details?.['reason'], reason, JSON.stringify(opts));
        }
        // the smallest and largest legal values build
        await s.buildIndex(NS, { kind: 'hnsw', m: 4, efConstruction: 4, seed: 0 });
        await s.buildIndex(NS, { kind: 'hnsw', m: 64, efConstruction: 1000, seed: 0xffff_ffff });
        eq((await s.indexInfo(NS))?.ann?.m, 64);
      }),
  },
  {
    // BUG-T2-S6-14 / S1-124 (TD-109): 30 copies of one vector, k = 50. Sprint 6: with 60 copies the graph returned
    // 34 hits and the SDK answered flat with 'short'. Sprint 7: exact copies no longer fill every neighbour list,
    // the group is reachable, and the graph itself returns the 50 flat scores (up to 2m = 32 copies; more makes the
    // graph degenerate, next case).
    name: 'many identical vectors: 30 copies of one vector, k = 50: the graph answers with the flat scores, bit for bit',
    run: (env) => {
      const events: Event[] = [];
      return withStore(env, { events: { emit: (e) => void events.push(e) } }, async (s) => {
        const dim = 32;
        const base = clusteredSet(11, 40, dim, 5000, 1);
        const one = synthVector(424_242, dim);
        await s.putVectors(
          NS,
          (function* () {
            for (let i = 0; i < 5000; i++)
              yield {
                key: `k${String(i).padStart(5, '0')}`,
                vector: base.rows.slice(i * dim, (i + 1) * dim),
              };
            for (let i = 0; i < 30; i++) yield { key: `dup${i}`, vector: one.slice() };
          })(),
        );
        await s.buildIndex(NS, { kind: 'hnsw', m: 16, efConstruction: 200, seed: 1 });
        const flat = await s.query(NS, one, 50, { values: false });
        eq(flat.length, 50, 'flat hits');
        events.length = 0;
        const hnsw = await s.query(NS, one, 50, { values: false, index: 'hnsw' });
        deepEq(bitsOf(hnsw), bitsOf(flat), 'the flat scores, bit for bit');
        const q = events.filter((e) => e.name === 'storage.query').at(-1)!;
        eq(q.attrs['requested'], 'hnsw', 'requested');
        eq(q.attrs['index'], 'hnsw', 'the graph answered');
        eq(q.attrs['fallback'], '', 'fallback');
        eq(q.attrs['ef'], 64, 'ef');
      });
    },
  },
  {
    // TD-109 plan B: a group of exact copies larger than 2m (here 1000 > 32) makes the graph
    // degenerate. The exact flat scan answers, with fallback 'duplicates', until the copies are gone and
    // buildIndex is called again.
    name: 'many identical vectors: 1000 copies (more than 2m) make the graph degenerate: the exact flat answer, fallback "duplicates"',
    run: (env) => {
      const events: Event[] = [];
      return withStore(env, { events: { emit: (e) => void events.push(e) } }, async (s) => {
        const dim = 32;
        const base = clusteredSet(11, 40, dim, 5000, 1);
        const one = synthVector(424_242, dim);
        await s.putVectors(
          NS,
          (function* () {
            for (let i = 0; i < 5000; i++)
              yield {
                key: `k${String(i).padStart(5, '0')}`,
                vector: base.rows.slice(i * dim, (i + 1) * dim),
              };
            for (let i = 0; i < 1000; i++) yield { key: `dup${i}`, vector: one.slice() };
          })(),
        );
        await s.buildIndex(NS, { kind: 'hnsw', m: 16, efConstruction: 200, seed: 1 });
        const flat = await s.query(NS, one, 50, { values: false });
        eq(flat.length, 50, 'flat hits');
        events.length = 0;
        const hnsw = await s.query(NS, one, 50, { values: false, index: 'hnsw' });
        deepEq(keysOf(hnsw), keysOf(flat), 'the flat answer, key for key');
        deepEq(bitsOf(hnsw), bitsOf(flat), 'the flat scores, bit for bit');
        const q = events.filter((e) => e.name === 'storage.query').at(-1)!;
        eq(q.attrs['requested'], 'hnsw', 'requested');
        eq(q.attrs['index'], 'flat', 'index');
        eq(q.attrs['fallback'], 'duplicates', 'fallback');
        eq(q.attrs['ef'], null, 'ef');
      });
    },
  },
  {
    // BUG-T2-S6-08 (fix round 2): T2's two-session case on every driver. Session 1 persists graphs for
    // ns1..ns64; session 2 builds ns0 (65 persisted in all) and queries all 65 with index 'hnsw'. The
    // 64-handle table cannot hold them at once: the answers must not throw, and must equal the flat ones.
    name: 'more persisted graphs than the 64-handle table: every query answers from its graph, equal to flat, none throws max_graphs',
    run: async (env) => {
      const MAX = 64;
      const PARAMS = { kind: 'hnsw', m: 4, efConstruction: 8, seed: 1 } as const;
      const ns = (i: number) => `ns${i}`;
      const a = await env.makeStore();
      for (let i = 0; i <= MAX; i++) await a.putVectors(ns(i), rows(i, 20));
      for (let i = 0; i < MAX; i++) await a.buildIndex(ns(i), PARAMS);
      eq(await a.dropIndex(ns(0), 'hnsw'), true, 'drop ns0');
      await a.buildIndex(ns(MAX), PARAMS);
      await a.close();
      const events: Event[] = [];
      const b = await env.reopen({ events: { emit: (e) => void events.push(e) } });
      try {
        await b.buildIndex(ns(0), PARAMS);
        const thrown: string[] = [];
        for (let i = 0; i <= MAX; i++) {
          const flat = await b.query(ns(i), query(i % NQ), 5, { values: false });
          try {
            const hnsw = await b.query(ns(i), query(i % NQ), 5, { values: false, index: 'hnsw' });
            await deepEq(keysOf(hnsw), keysOf(flat), `${ns(i)} keys`);
            await deepEq(bitsOf(hnsw), bitsOf(flat), `${ns(i)} scores`);
            const q = events.filter((e) => e.name === 'storage.query').at(-1)!;
            eq(q.attrs['index'], 'hnsw', `${ns(i)} answered by its graph`);
            eq(q.attrs['fallback'], '', `${ns(i)} fallback`);
          } catch (e) {
            thrown.push(`${ns(i)}:${(e as { details?: { reason?: string } }).details?.reason}`);
          }
        }
        await deepEq(thrown, [], 'no query threw');
      } finally {
        await b.close();
      }
    },
  },
  {
    name: 'the public API refuses the reserved graph namespace',
    run: (env) =>
      withStore(env, undefined, async (s) => {
        await rejectsWith(s.set(`${ANN_NS_PREFIX}x`, 'k', 1), 'invalid_namespace');
        await rejectsWith(s.get(`${ANN_NS_PREFIX}x`, 'k'), 'invalid_namespace');
        await rejectsWith(s.delete(`${ANN_NS_PREFIX}x`, 'k'), 'invalid_namespace');
        await rejectsWith(s.buildIndex(`${ANN_NS_PREFIX}x`, { kind: 'hnsw' }), 'invalid_namespace');
      }),
  },
];

export function runAnnSuite(
  env: AnnEnv,
  define: (name: string, fn: () => Promise<void>) => unknown,
): void {
  for (const c of annCases) define(c.name, () => c.run(env));
}
