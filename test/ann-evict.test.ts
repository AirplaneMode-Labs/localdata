// D4-02 (TD-110; BUG-T2-S6-15 / S1-125): buildIndex at the 64-handle cap. Written before the change.
//
// Storage API 0.4.1 wording, which these tests pin:
//   * at HNSW_MAX_GRAPHS resident graphs, buildIndex first releases the in-memory instance (never the stored
//     bytes) of the least-recently-used IDLE graph (no operation running or queued, and not being built);
//   * it throws quota_exceeded 'max_graphs' only when every resident graph is busy;
//   * dropIndex frees a slot only if the graph was resident: a non-resident namespace's stored record is
//     deleted and no handle is released.
// The busy guard is proved necessary by a mutation: with the guard removed, the same scenario evicts a graph
// whose writer is mid-commit, and the scenario's own invariant check reports it.
import { afterEach, describe, expect, it } from 'vitest';
import { ANN_NS_PREFIX, HNSW_MAX_GRAPHS } from '../src/contracts/storage-api';
import { MemoryDriver } from '../src/drivers/memory';
import { VEC_NS_PREFIX } from '../src/drivers/types';
import { createStore, type Event, type LocalData } from '../src/index';
import { annResident, annResidentCount, removeBusyGuardForTest } from '../src/vec/ann-test-hook';
import { ask, annOpens, Gated, lastQuery, TINY_PARAMS, tinyNs, tinyRows } from './ann-handles';

const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

const stored = async (d: MemoryDriver, i: number) => {
  const rec = await d.getBytes(`${ANN_NS_PREFIX}${tinyNs(i)}`, 'graph');
  return rec === undefined ? undefined : Array.from(rec.bytes);
};

/** A store holding 65 namespaces of 20 rows and 64 built graphs (ns0 .. ns63), ns0 the least recently used. */
async function full(driver: MemoryDriver, events: Event[] = []): Promise<LocalData> {
  const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
  open.push(store);
  for (let i = 0; i <= HNSW_MAX_GRAPHS; i++) await store.putVectors(tinyNs(i), tinyRows(i));
  for (let i = 0; i < HNSW_MAX_GRAPHS; i++) await store.buildIndex(tinyNs(i), TINY_PARAMS);
  return store;
}

describe('buildIndex at the cap releases the least recently used idle graph (TD-110)', () => {
  it('the 65th build succeeds, writes only its own two records, keeps the evicted bytes, and the evicted namespace loads again', async () => {
    const events: Event[] = [];
    const driver = new Gated();
    const store = await full(driver, events);
    expect(annResidentCount(store)).toBe(HNSW_MAX_GRAPHS);
    const ns0 = await stored(driver, 0);
    expect(ns0).toBeDefined();
    const writes = driver.writes;
    const built = await store.buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS);
    expect(built).toMatchObject({ kind: 'hnsw', rows: 20, liveRows: 20, replaced: false });
    expect(driver.writes - writes, 'params and graph, nothing deleted or rewritten').toBe(2);
    expect(annResidentCount(store), 'the table is still full, not over').toBe(HNSW_MAX_GRAPHS);
    expect(annResident(store, tinyNs(0)), 'ns0 was the least recently used').toBe(false);
    expect(annResident(store, tinyNs(HNSW_MAX_GRAPHS))).toBe(true);
    expect(await stored(driver, 0), 'the evicted graph is still stored, byte for byte').toEqual(
      ns0,
    );
    // the evicted namespace answers from its stored graph (one storage.index.open), the others from memory
    events.length = 0;
    const flat = await ask(store, 0);
    expect(await ask(store, 0, 'hnsw')).toEqual(flat);
    expect(annOpens(events)).toEqual([tinyNs(0)]);
    expect(lastQuery(events).attrs).toMatchObject({ index: 'hnsw', fallback: '' });
  }, 120_000);

  it('the victim is the least recently used one: a query on ns0 makes ns1 the victim', async () => {
    const driver = new Gated();
    const store = await full(driver);
    await ask(store, 0, 'hnsw'); // ns0 is now the most recently used
    await store.buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS);
    expect(annResident(store, tinyNs(0))).toBe(true);
    expect(annResident(store, tinyNs(1))).toBe(false);
  }, 120_000);

  it('a namespace whose writer is mid-commit is never the victim: the next least recently used goes, and the write still updates its graph', async () => {
    const driver = new Gated();
    const store = await full(driver);
    driver.arm([`${VEC_NS_PREFIX}${tinyNs(0)}`]);
    const extra = tinyRows(901).map((r, i) => ({ ...r, key: `extra-${i}` }));
    const write = store.putVectors(tinyNs(0), extra);
    for (let t = 0; t < 2000 && driver.held.size === 0; t++)
      await new Promise((r) => setTimeout(r, 1));
    expect(driver.held.size, 'the writer reached the flat commit').toBe(1);
    // every other graph is used again, so ns0 is the least recently used of all of them
    for (let i = 1; i < HNSW_MAX_GRAPHS; i++) await ask(store, i, 'hnsw');
    await store.buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS);
    expect(annResident(store, tinyNs(0)), 'ns0 is busy: kept').toBe(true);
    expect(
      annResident(store, tinyNs(1)),
      'ns1 is the least recently used idle graph: released',
    ).toBe(false);
    driver.release();
    await write;
    const info = await store.indexInfo(tinyNs(0));
    expect(info!.rows).toBe(40);
    expect(info!.ann, 'the graph took the write').toMatchObject({ nodes: 40, current: true });
  }, 120_000);

  /** The scenario of the mutation test: returns what a violated guard looks like. */
  async function busyScenario(mutate: boolean): Promise<string[]> {
    const driver = new Gated();
    const store = await full(driver);
    if (mutate) removeBusyGuardForTest(store);
    driver.arm([`${VEC_NS_PREFIX}${tinyNs(0)}`]);
    const extra = tinyRows(902).map((r, i) => ({ ...r, key: `extra-${i}` }));
    const write = store.putVectors(tinyNs(0), extra).catch((e: unknown) => e);
    for (let t = 0; t < 2000 && driver.held.size === 0; t++)
      await new Promise((r) => setTimeout(r, 1));
    const problems: string[] = [];
    for (let i = 1; i < HNSW_MAX_GRAPHS; i++) await ask(store, i, 'hnsw'); // ns0 is now the oldest
    await store.buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS);
    if (!annResident(store, tinyNs(0)))
      problems.push('the graph of a namespace mid-commit was released');
    driver.release();
    await write;
    const info = await store.indexInfo(tinyNs(0));
    if (info?.ann?.current !== true) problems.push('the write left its graph stale');
    return problems;
  }

  it('the guard is what keeps that test green: with the busy guard removed, the same scenario reports a released graph', async () => {
    expect(await busyScenario(false), 'unmutated').toEqual([]);
    const mutated = await busyScenario(true);
    expect(mutated, 'a mutation that removes the queued-operation guard').not.toEqual([]);
    expect(mutated).toContain('the graph of a namespace mid-commit was released');
  }, 240_000);

  it('max_graphs is thrown only when every one of the 64 resident graphs is busy, and then nothing is written', async () => {
    const driver = new Gated();
    const store = await full(driver);
    driver.arm(Array.from({ length: HNSW_MAX_GRAPHS }, (_, i) => `${VEC_NS_PREFIX}${tinyNs(i)}`));
    const writes: Array<Promise<unknown>> = [];
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) {
      const extra = tinyRows(1000 + i).map((r, j) => ({ ...r, key: `extra-${j}` }));
      writes.push(store.putVectors(tinyNs(i), extra));
    }
    for (let t = 0; t < 5000 && driver.held.size < HNSW_MAX_GRAPHS; t++)
      await new Promise((r) => setTimeout(r, 1));
    expect(driver.held.size, 'all 64 writers are mid-commit').toBe(HNSW_MAX_GRAPHS);
    const before = driver.writes;
    const err = await store
      .buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'quota_exceeded',
      details: { reason: 'max_graphs', maxGraphs: HNSW_MAX_GRAPHS },
    });
    expect(driver.writes - before, 'a refused build writes nothing').toBe(0);
    expect(await driver.keys(`${ANN_NS_PREFIX}${tinyNs(HNSW_MAX_GRAPHS)}`)).toEqual([]);
    driver.release();
    await Promise.all(writes);
    // with the writers done, every graph is idle again and the same build succeeds
    const built = await store.buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS);
    expect(built).toMatchObject({ kind: 'hnsw', replaced: false });
  }, 120_000);

  it('rebuilding a namespace that already has a resident graph replaces it and releases nothing else', async () => {
    const store = await full(new MemoryDriver());
    const resident = Array.from({ length: HNSW_MAX_GRAPHS }, (_, i) =>
      annResident(store, tinyNs(i)),
    );
    expect(resident.every(Boolean)).toBe(true);
    const again = await store.buildIndex(tinyNs(7), { ...TINY_PARAMS, seed: 2 });
    expect(again).toMatchObject({ kind: 'hnsw', replaced: true, liveRows: 20 });
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++)
      expect(annResident(store, tinyNs(i)), tinyNs(i)).toBe(true);
  }, 120_000);
});

describe('dropIndex frees a slot only if the graph was resident (TD-110)', () => {
  it('a non-resident namespace: the stored record goes, true is returned, and no resident graph is released', async () => {
    // session 1 persists 64 graphs; session 2 loads none of them
    const driver = new Gated();
    const s1 = await full(driver);
    await s1.close();
    open.pop();
    await driver.open();
    const events: Event[] = [];
    const s2 = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
    open.push(s2);
    for (let i = 1; i < HNSW_MAX_GRAPHS; i++) await ask(s2, i, 'hnsw');
    const residentBefore = annResidentCount(s2);
    expect(residentBefore).toBeGreaterThan(0);
    // ns0 was never queried in this session: not resident
    expect(annResident(s2, tinyNs(0))).toBe(false);
    expect(await stored(driver, 0)).toBeDefined();
    expect(await s2.dropIndex(tinyNs(0), 'hnsw')).toBe(true);
    expect(await stored(driver, 0), 'the stored record is deleted').toBeUndefined();
    expect(annResidentCount(s2), 'no resident graph was released').toBe(residentBefore);
    // a namespace that never had a graph: false, and still nothing released
    expect(await s2.dropIndex(tinyNs(HNSW_MAX_GRAPHS), 'hnsw')).toBe(false);
    expect(annResidentCount(s2)).toBe(residentBefore);
  }, 120_000);

  it('a resident namespace: its handle is released, so the table has room for a new build without evicting anyone', async () => {
    const driver = new Gated();
    const store = await full(driver);
    expect(await store.dropIndex(tinyNs(5), 'hnsw')).toBe(true);
    expect(annResidentCount(store)).toBe(HNSW_MAX_GRAPHS - 1);
    await store.buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS);
    expect(annResidentCount(store)).toBe(HNSW_MAX_GRAPHS);
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) {
      if (i !== 5) expect(annResident(store, tinyNs(i)), tinyNs(i)).toBe(true);
    }
  }, 120_000);
});
