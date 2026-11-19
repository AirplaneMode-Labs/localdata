// BUG-T2-S6-11 (fix round 2): a graph keeps the nodes of replaced rows, so after most rows are replaced
// (or after building over duplicate-heavy data such as boilerplate chunks) its recall can sit well below a
// fresh build's, and nothing in a query says so. The condition is visible to the caller through
// indexInfo(ns).ann (nodes, liveNodes); the remedy is buildIndex again; compaction stays "not yet".
//
// This test reproduces the condition with a small seeded set and pins what a caller can rely on:
//   * the ratio liveNodes / nodes falls to 0.5 after one full replace and below 0.5 after the second
//   * after buildIndex the ratio is back to 1 and recall@10 against the flat scan is 1.0
// It deliberately asserts NO number for the recall before the rebuild: that depends on the data and is not a
// promise. The README and docs/vector-index.md cite no such figure either.
import { afterEach, describe, expect, it } from 'vitest';
import { clusteredSet } from '../bench/synth';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, type Event, type LocalData } from '../src/index';
import { keysOf } from './ann.behaviour';

const NS = 'boiler';
const DIM = 8;
const ROWS = 500;
const QUERIES = 40;
const PARAMS = { kind: 'hnsw', m: 8, efConstruction: 60, seed: 1 } as const;
const key = (i: number) => `chunk-${String(i).padStart(4, '0')}`;

const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

/** Mean recall@10 of the default-ef hnsw answer against the flat answer, and whether the graph answered every query. */
async function recall(store: LocalData, queries: Float32Array, events: Event[]) {
  let sum = 0;
  events.length = 0;
  for (let j = 0; j < QUERIES; j++) {
    const q = queries.slice(j * DIM, (j + 1) * DIM);
    const flat = keysOf(await store.query(NS, q, 10, { values: false }));
    const ann = keysOf(await store.query(NS, q, 10, { values: false, index: 'hnsw' }));
    sum += ann.filter((k) => flat.includes(k)).length / Math.max(1, flat.length);
  }
  const fromGraph = events
    .filter((e) => e.name === 'storage.query' && e.attrs['requested'] === 'hnsw')
    .every((e) => e.attrs['index'] === 'hnsw');
  return { recall: sum / QUERIES, fromGraph };
}

describe('after most rows are replaced the caller can see it and rebuild (BUG-T2-S6-11)', () => {
  it('identical vectors, then two full replaces: liveNodes / nodes < 0.5, and buildIndex gives recall@10 1.0', async () => {
    const events: Event[] = [];
    const store = await createStore({
      driver: new MemoryDriver(),
      events: { emit: (e) => void events.push(e) },
    });
    open.push(store);
    const identical = new Float32Array(DIM).fill(0.5);
    await store.putVectors(
      NS,
      Array.from({ length: ROWS }, (_, i) => ({ key: key(i), vector: identical })),
    );
    await store.buildIndex(NS, PARAMS);
    const ratio = async () => {
      const a = (await store.indexInfo(NS))!.ann!;
      return { nodes: a.nodes, liveNodes: a.liveNodes, ratio: a.liveNodes / a.nodes };
    };
    expect(await ratio()).toMatchObject({ nodes: ROWS, liveNodes: ROWS, ratio: 1 });

    // two full replaces of the same keys with distinct, clustered vectors
    const first = clusteredSet(11, 6, DIM, ROWS, QUERIES);
    const second = clusteredSet(12, 6, DIM, ROWS, QUERIES);
    for (const set of [first, second]) {
      await store.putVectors(
        NS,
        Array.from({ length: ROWS }, (_, i) => ({
          key: key(i),
          vector: set.rows.slice(i * DIM, (i + 1) * DIM),
        })),
      );
    }
    const stale = await ratio();
    expect(stale.liveNodes).toBe(ROWS);
    expect(stale.nodes).toBe(3 * ROWS);
    expect(stale.ratio, 'the caller sees liveNodes / nodes below 0.5').toBeLessThan(0.5);
    expect((await store.indexInfo(NS))!.rows).toBe(ROWS);

    // the remedy: build again. The ratio is back to 1 and recall is the fresh build's.
    await store.buildIndex(NS, PARAMS);
    expect(await ratio()).toMatchObject({ nodes: ROWS, liveNodes: ROWS, ratio: 1 });
    const fresh = await recall(store, second.queries, events);
    expect(fresh.fromGraph, 'every query was answered by the graph').toBe(true);
    expect(fresh.recall).toBe(1);
  }, 120_000);

  it('one full replace of a graph gives exactly 0.5, which is the point to rebuild (not below it)', async () => {
    const store = await createStore({ driver: new MemoryDriver() });
    open.push(store);
    const set = clusteredSet(13, 6, DIM, ROWS, 1);
    const rows = (s: Float32Array) =>
      Array.from({ length: ROWS }, (_, i) => ({
        key: key(i),
        vector: s.slice(i * DIM, (i + 1) * DIM),
      }));
    await store.putVectors(NS, rows(set.rows));
    await store.buildIndex(NS, PARAMS);
    await store.putVectors(NS, rows(clusteredSet(14, 6, DIM, ROWS, 1).rows));
    const a = (await store.indexInfo(NS))!.ann!;
    expect(a.nodes).toBe(2 * ROWS);
    expect(a.liveNodes / a.nodes).toBe(0.5);
  }, 120_000);
});
