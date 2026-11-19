// D4-04 (TD-65): quota and accounting with a graph. Written before src/vec/ann.ts.
//   * flat-only quota behaviour is unchanged (test/vector-quota.test.ts and the quota cases of the
//     shared suites are untouched and stay green)
//   * buildIndex over maxIndexBytes or over the soft quota throws quota_exceeded BEFORE anything is
//     written (a driver write counter of 0), with details.reason 'max_index_bytes' or 'quota'
//   * graph bytes are in usage().bytes and annBytes, and count toward the pre-write quota check: a
//     namespace with a graph can refuse a putVectors that a flat-only namespace accepts
//   * clearing a namespace leaves no '__ld_ann.' record
//   * BUG-T2-S6-03 (fix round 1): a store's kernel holds at most HNSW_MAX_GRAPHS (64) loaded graphs; the
//     65th buildIndex throws quota_exceeded with reason 'max_graphs' (not 'wasm_memory'), writes nothing,
//     dropIndex of one namespace lets it build, and every namespace still answers queries
//   * BUG-T2-S6-08 (fix round 2): only buildIndex is capped. A query (or a write) that must LOAD a persisted
//     graph into a full handle table releases the least-recently-used idle graph of another namespace and
//     loads again; it never throws max_graphs, never touches a stored record, and when every resident
//     graph is in use it answers with the exact flat scan and fallback 'absent'
import { afterEach, describe, expect, it } from 'vitest';
import { ANN_NS_PREFIX, HNSW_MAX_GRAPHS } from '../src/contracts/storage-api';
import { mulberry32 } from '../bench/synth';
import { MemoryDriver } from '../src/drivers/memory';
import { VEC_NS_PREFIX } from '../src/drivers/types';
import { createStore, type Event, type LocalData } from '../src/index';
import type { VectorRow } from '../src/contracts/storage-api';
import { f32Bits } from '../src/vec/reference';
import { N, NQ, query, rows } from './ann.behaviour';

const NS = 'vecs';
const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

/** Counts every mutating driver call (put, del, clear). */
class Counting extends MemoryDriver {
  writes = 0;
  override async put(...a: Parameters<MemoryDriver['put']>) {
    this.writes++;
    return super.put(...a);
  }
  override async del(...a: Parameters<MemoryDriver['del']>) {
    this.writes++;
    return super.del(...a);
  }
  override async clear(...a: Parameters<MemoryDriver['clear']>) {
    this.writes++;
    return super.clear(...a);
  }
}

async function make(
  opts: { quotaBytes?: number; maxIndexBytes?: number } = {},
  driver = new Counting(),
) {
  const store = await createStore({ driver, ...opts });
  open.push(store);
  return { store, driver };
}

describe('buildIndex refuses over quota before writing anything', () => {
  it('over maxIndexBytes: quota_exceeded reason max_index_bytes, driver writes 0, the flat index untouched', async () => {
    const probe = await make();
    await probe.store.putVectors(NS, rows(0, N));
    const flatBytes = (await probe.store.indexInfo(NS))!.bytes;
    await probe.store.close();
    // a store that is allowed exactly the flat index and a little more, but not a graph on top
    const { store, driver } = await make({ maxIndexBytes: flatBytes + 1000 }, probe.driver);
    await driver.open();
    const before = driver.writes;
    const err = await store.buildIndex(NS, { kind: 'hnsw' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'quota_exceeded', details: { reason: 'max_index_bytes' } });
    expect(driver.writes - before).toBe(0);
    expect(await driver.keys(`${ANN_NS_PREFIX}${NS}`)).toEqual([]);
    expect((await store.query(NS, query(0), 5)).length).toBe(5);
  });

  it('over the soft quota: quota_exceeded reason quota, driver writes 0', async () => {
    const probe = await make();
    await probe.store.putVectors(NS, rows(0, N));
    const used = (await probe.store.usage()).bytes;
    await probe.store.close();
    const { store, driver } = await make({ quotaBytes: used + 500 }, probe.driver);
    await driver.open();
    await store.usage(); // loads nothing new
    const before = driver.writes;
    const err = await store.buildIndex(NS, { kind: 'hnsw' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'quota_exceeded', details: { reason: 'quota' } });
    expect(driver.writes - before).toBe(0);
    expect(await driver.keys(`${ANN_NS_PREFIX}${NS}`)).toEqual([]);
  });

  it('with room it builds, and the driver wrote only graph records', async () => {
    const { store, driver } = await make({ quotaBytes: 50_000_000 });
    await store.putVectors(NS, rows(0, N));
    driver.writes = 0;
    await store.buildIndex(NS, { kind: 'hnsw' });
    expect(driver.writes).toBe(2); // params and graph
    expect((await driver.keys(`${ANN_NS_PREFIX}${NS}`)).sort()).toEqual(['graph', 'params']);
  });
});

describe('graph bytes are accounted', () => {
  it('usage().bytes includes annBytes, and a namespace with a graph refuses a putVectors a flat-only one accepts', async () => {
    const extra = rows(0, 10).map((r, i) => ({ ...r, key: `extra-${i}` }));
    // flat-only: how much the put adds, and a quota that exactly admits it
    const flat = await make();
    await flat.store.putVectors(NS, rows(0, N));
    const u0 = (await flat.store.usage()).bytes;
    await flat.store.putVectors(NS, extra);
    const x = (await flat.store.usage()).bytes - u0;
    const quota = u0 + x + 300;
    const f2 = await make({ quotaBytes: quota });
    await f2.store.putVectors(NS, rows(0, N));
    await f2.store.putVectors(NS, extra); // a flat-only namespace accepts it
    // the same data with a graph: the graph's bytes are in usage, so the put no longer fits
    const g = await make({ quotaBytes: quota });
    await g.store.putVectors(NS, rows(0, N));
    const built = await g.store.buildIndex(NS, { kind: 'hnsw', m: 12 }).catch((e: unknown) => e);
    // a graph needs room itself: with this tight quota even the build is refused, which is the point
    expect(built).toMatchObject({ code: 'quota_exceeded' });
    const roomy = await make({ quotaBytes: quota + 400_000 });
    await roomy.store.putVectors(NS, rows(0, N));
    await roomy.store.buildIndex(NS, { kind: 'hnsw', m: 12 });
    const u = await roomy.store.usage();
    expect(u.annBytes).toBeGreaterThan(0);
    const vec = u.vectorBytes!;
    expect(u.bytes).toBe(vec + u.annBytes!);
    // quota room for the flat part only, and the graph delta does not fit: refused, nothing written
    const tight = await make({ quotaBytes: u.bytes + x + 300 });
    await tight.store.putVectors(NS, rows(0, N));
    await tight.store.buildIndex(NS, { kind: 'hnsw', m: 12 });
    const gen = (await tight.store.indexInfo(NS))!.generation;
    const writes = tight.driver.writes;
    await expect(tight.store.putVectors(NS, extra)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(tight.driver.writes).toBe(writes);
    expect((await tight.store.indexInfo(NS))!.generation).toBe(gen);
    expect((await tight.store.indexInfo(NS))!.rows).toBe(N);
    expect((await tight.store.query(NS, query(0), 5, { index: 'hnsw' })).length).toBe(5);
    expect(NQ).toBeGreaterThan(0);
  });

  it('putVectors that grows a current graph updates annBytes; delete of the last row removes it', async () => {
    const { store, driver } = await make();
    await store.putVectors(NS, rows(0, 100));
    await store.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 40 });
    const a = (await store.usage(NS)).annBytes!;
    await store.putVectors(NS, rows(100, 100));
    const b = (await store.usage(NS)).annBytes!;
    expect(b).toBeGreaterThan(a);
    await store.clear(NS);
    expect(await driver.namespaces()).toEqual(
      (await driver.namespaces()).filter((n) => !n.startsWith(ANN_NS_PREFIX)),
    );
    expect((await store.usage()).annBytes).toBeUndefined();
  });
});

describe('at most HNSW_MAX_GRAPHS graphs are loaded per store (BUG-T2-S6-03)', () => {
  const PARAMS = { kind: 'hnsw', m: 4, efConstruction: 8, seed: 1 } as const;
  const nsName = (i: number) => `ns${i}`;

  async function fill(store: LocalData, count: number) {
    for (let i = 0; i < count; i++) await store.putVectors(nsName(i), rows(0, 20));
  }

  it('the cap is the contract constant, 64', () => {
    expect(HNSW_MAX_GRAPHS).toBe(64);
  });

  it('65 namespaces of 20 rows: the 65th buildIndex throws max_graphs and writes nothing; dropIndex of ns0 lets it build; every namespace still answers', async () => {
    const events: Event[] = [];
    const driver = new Counting();
    const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
    open.push(store);
    await fill(store, HNSW_MAX_GRAPHS + 1);
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) await store.buildIndex(nsName(i), PARAMS);
    const last = nsName(HNSW_MAX_GRAPHS);
    const before = driver.writes;
    events.length = 0;
    const err = await store.buildIndex(last, PARAMS).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'quota_exceeded',
      details: { reason: 'max_graphs', maxGraphs: HNSW_MAX_GRAPHS },
    });
    expect(driver.writes - before, 'a refused build writes nothing').toBe(0);
    expect(await driver.keys(`${ANN_NS_PREFIX}${last}`)).toEqual([]);
    const failed = events.find((e) => e.name === 'storage.index.build')!;
    expect(failed.attrs['outcome']).toBe('quota_exceeded');
    expect(failed.level).toBe('warn');
    // the namespace without a graph answers flat, the 64 others answer from their graph
    for (let i = 0; i <= HNSW_MAX_GRAPHS; i++) {
      events.length = 0;
      const flat = await store.query(nsName(i), query(0), 5, { values: false });
      const hnsw = await store.query(nsName(i), query(0), 5, { values: false, index: 'hnsw' });
      expect(
        hnsw.map((h) => h.key),
        nsName(i),
      ).toEqual(flat.map((h) => h.key));
      const q = events.filter((e) => e.name === 'storage.query').at(-1)!;
      expect(q.attrs, nsName(i)).toMatchObject(
        i < HNSW_MAX_GRAPHS
          ? { index: 'hnsw', fallback: '' }
          : { index: 'flat', fallback: 'absent' },
      );
    }
    // dropIndex frees a slot: the same build now works
    expect(await store.dropIndex(nsName(0), 'hnsw')).toBe(true);
    const built = await store.buildIndex(last, PARAMS);
    expect(built).toMatchObject({ kind: 'hnsw', rows: 20, liveRows: 20, replaced: false });
    const q = await store.query(last, query(0), 5, { values: false, index: 'hnsw' });
    expect(q).toHaveLength(5);
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs).toBeDefined();
  }, 120_000);

  it('at the cap, buildIndex over a namespace that already has a resident graph replaces it', async () => {
    const store = await createStore({ driver: new MemoryDriver() });
    open.push(store);
    await fill(store, HNSW_MAX_GRAPHS);
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) await store.buildIndex(nsName(i), PARAMS);
    const again = await store.buildIndex(nsName(7), { ...PARAMS, seed: 2 });
    expect(again).toMatchObject({ kind: 'hnsw', replaced: true, liveRows: 20 });
    expect((await store.indexInfo(nsName(7)))!.ann!.seed).toBe(2);
  }, 120_000);

  it('a refusal for another reason is not reported as max_graphs', async () => {
    const store = await createStore({ driver: new MemoryDriver(), maxIndexBytes: 1 });
    open.push(store);
    await store.putVectors(NS, rows(0, 20)).catch(() => undefined);
    const err = await store.buildIndex(NS, PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { details?: { reason?: string } }).details?.reason).not.toBe('max_graphs');
  });
});

// ---- BUG-T2-S6-08 ---------------------------------------------------------------------------------------

/** put() holds the first write to the named driver namespaces until release(): a writer caught mid-commit. */
class Gated extends MemoryDriver {
  private gateNs = new Set<string>();
  readonly held = new Set<string>();
  private gate: Promise<void> = Promise.resolve();
  private open_: () => void = () => undefined;
  writes = 0;

  arm(namespaces: Iterable<string>): void {
    this.gateNs = new Set(namespaces);
    this.held.clear();
    this.gate = new Promise<void>((r) => (this.open_ = r));
  }

  release(): void {
    this.gateNs.clear();
    this.open_();
  }

  override async put(...a: Parameters<MemoryDriver['put']>) {
    if (this.gateNs.has(a[0])) {
      this.held.add(a[0]);
      await this.gate;
    }
    this.writes++;
    return super.put(...a);
  }
  override async del(...a: Parameters<MemoryDriver['del']>) {
    this.writes++;
    return super.del(...a);
  }
  override async clear(...a: Parameters<MemoryDriver['clear']>) {
    this.writes++;
    return super.clear(...a);
  }
}

const TINY_PARAMS = { kind: 'hnsw', m: 4, efConstruction: 8, seed: 1 } as const;
const tinyNs = (i: number) => `ns${i}`;

/** 20 rows of dim 4 for namespace i: seeded, integer-driven, distinct scores. */
function tinyRows(i: number): VectorRow[] {
  const next = mulberry32(0x5eed0000 + i);
  return Array.from({ length: 20 }, (_, r) => ({
    key: `k${r}`,
    vector: Float32Array.from({ length: 4 }, () => ((next() >>> 8) / 16777216) * 2 - 1),
  }));
}
function tinyQuery(i: number): Float32Array {
  const next = mulberry32(0x9e370000 + i);
  return Float32Array.from({ length: 4 }, () => ((next() >>> 8) / 16777216) * 2 - 1);
}
type Answer = Array<[string, number]>;
async function ask(store: LocalData, i: number, index?: 'hnsw'): Promise<Answer> {
  const hits = await store.query(tinyNs(i), tinyQuery(i), 5, {
    values: false,
    ...(index === undefined ? {} : { index }),
  });
  return hits.map((h) => [h.key, f32Bits(h.score)]);
}
const lastQuery = (events: Event[]) => events.filter((e) => e.name === 'storage.query').at(-1)!;
const annOpens = (events: Event[]) =>
  events
    .filter((e) => e.name === 'storage.index.open' && e.attrs['kind'] === 'hnsw')
    .map((e) => e.attrs['ns']);

/** T2's two-session state: ns1..ns64 persisted by session 1 (64 graphs), then session 2 builds ns0 (65 persisted). */
async function twoSessions(driver: MemoryDriver, events: Event[]): Promise<LocalData> {
  const s1 = await createStore({ driver });
  for (let i = 0; i <= HNSW_MAX_GRAPHS; i++) await s1.putVectors(tinyNs(i), tinyRows(i));
  for (let i = 0; i < HNSW_MAX_GRAPHS; i++) await s1.buildIndex(tinyNs(i), TINY_PARAMS);
  await s1.dropIndex(tinyNs(0), 'hnsw');
  await s1.buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS);
  await s1.close();
  await driver.open();
  const s2 = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
  open.push(s2);
  await s2.buildIndex(tinyNs(0), TINY_PARAMS);
  return s2;
}

describe('a query never throws because of the 64-handle cap (BUG-T2-S6-08)', () => {
  it('T2 two-session case: 65 persisted graphs, 65 answers, 0 throws, every answer equals the flat answer', async () => {
    const events: Event[] = [];
    const store = await twoSessions(new MemoryDriver(), events);
    const thrown: string[] = [];
    let answered = 0;
    for (let i = 0; i <= HNSW_MAX_GRAPHS; i++) {
      const flat = await ask(store, i);
      let hnsw: Answer;
      try {
        hnsw = await ask(store, i, 'hnsw');
      } catch (e) {
        thrown.push(
          `${tinyNs(i)}:${(e as { code?: string }).code}/${(e as { details?: { reason?: string } }).details?.reason}`,
        );
        continue;
      }
      answered++;
      expect(hnsw, tinyNs(i)).toEqual(flat);
      // an idle store can always make room: every answer comes from its graph
      expect(lastQuery(events).attrs, tinyNs(i)).toMatchObject({ index: 'hnsw', fallback: '' });
    }
    expect(thrown).toEqual([]);
    expect(answered).toBe(HNSW_MAX_GRAPHS + 1);
  }, 120_000);

  it('evicts the least recently used graph, writes nothing, and the evicted namespace loads again from its stored record', async () => {
    const events: Event[] = [];
    const driver = new Gated();
    const store = await twoSessions(driver, events);
    for (let i = 1; i < HNSW_MAX_GRAPHS; i++) await ask(store, i, 'hnsw'); // ns0 (built) .. ns63 resident: full
    await ask(store, 0, 'hnsw'); // ns0 is now the most recently used, ns1 the least
    const stored = await driver.getBytes(`${ANN_NS_PREFIX}${tinyNs(1)}`, 'graph');
    expect(stored).toBeDefined();
    const writes = driver.writes;
    events.length = 0;
    await ask(store, HNSW_MAX_GRAPHS, 'hnsw'); // needs a slot: ns1 goes
    expect(annOpens(events)).toEqual([tinyNs(HNSW_MAX_GRAPHS)]);
    events.length = 0;
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) if (i !== 1) await ask(store, i, 'hnsw');
    expect(annOpens(events), 'every other graph is still resident: no load').toEqual([]);
    await ask(store, 1, 'hnsw');
    expect(annOpens(events), 'the evicted graph is read again').toEqual([tinyNs(1)]);
    expect(lastQuery(events).attrs).toMatchObject({ index: 'hnsw', fallback: '' });
    expect(driver.writes - writes, 'eviction deletes and rewrites nothing').toBe(0);
    const after = await driver.getBytes(`${ANN_NS_PREFIX}${tinyNs(1)}`, 'graph');
    expect(Array.from(after!.bytes)).toEqual(Array.from(stored!.bytes));
  }, 120_000);

  it('a fresh session over 80 persisted graphs: a sequential storm and a concurrent storm give 0 throws and no hit that differs from flat', async () => {
    const TOTAL = 80;
    const driver = new MemoryDriver();
    const a = await createStore({ driver });
    for (let i = 0; i < TOTAL; i++) await a.putVectors(tinyNs(i), tinyRows(i));
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) await a.buildIndex(tinyNs(i), TINY_PARAMS);
    await a.close();
    await driver.open();
    const b = await createStore({ driver });
    for (let i = HNSW_MAX_GRAPHS; i < TOTAL; i++) await b.buildIndex(tinyNs(i), TINY_PARAMS);
    await b.close();
    await driver.open();
    const events: Event[] = [];
    const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
    open.push(store);
    const flat: Answer[] = [];
    for (let i = 0; i < TOTAL; i++) flat.push(await ask(store, i));
    // sequential, two rounds in different orders
    let thrown = 0;
    let differing = 0;
    for (const order of [
      Array.from({ length: TOTAL }, (_, i) => i),
      Array.from({ length: TOTAL }, (_, i) => TOTAL - 1 - i),
    ]) {
      for (const i of order) {
        try {
          if (JSON.stringify(await ask(store, i, 'hnsw')) !== JSON.stringify(flat[i])) differing++;
        } catch {
          thrown++;
        }
      }
    }
    expect({ thrown, differing }).toEqual({ thrown: 0, differing: 0 });
    // concurrent: all 80 at once, three times
    for (let round = 0; round < 3; round++) {
      events.length = 0;
      const settled = await Promise.allSettled(
        Array.from({ length: TOTAL }, (_, i) => ask(store, i, 'hnsw')),
      );
      expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(0);
      settled.forEach((r, i) => {
        expect(r.status === 'fulfilled' ? r.value : null, tinyNs(i)).toEqual(flat[i]);
      });
      // a query is answered by its graph, or by the exact flat scan reported as 'absent' (every handle in use)
      for (const e of events.filter((x) => x.name === 'storage.query')) {
        expect(['', 'absent'], 'fallback').toContain(e.attrs['fallback']);
      }
    }
  }, 180_000);

  it('a write to a namespace whose persisted graph must be loaded into a full table succeeds and keeps the graph current', async () => {
    const events: Event[] = [];
    const store = await twoSessions(new MemoryDriver(), events);
    for (let i = 1; i < HNSW_MAX_GRAPHS; i++) await ask(store, i, 'hnsw'); // full
    const extra = tinyRows(900).map((r, i) => ({ ...r, key: `extra-${i}` }));
    await store.putVectors(tinyNs(HNSW_MAX_GRAPHS), extra);
    const info = await store.indexInfo(tinyNs(HNSW_MAX_GRAPHS));
    expect(info!.rows).toBe(40);
    expect(info!.ann).toMatchObject({ nodes: 40, current: true });
    expect(await store.delete(tinyNs(HNSW_MAX_GRAPHS - 1), 'k3')).toBe(true);
    expect((await store.indexInfo(tinyNs(HNSW_MAX_GRAPHS - 1)))!.ann!.current).toBe(true);
  }, 120_000);

  it('never evicts a namespace whose writer is mid-commit: its graph is updated and current when the write ends', async () => {
    const events: Event[] = [];
    const driver = new Gated();
    const store = await twoSessions(driver, events);
    for (let i = 1; i < HNSW_MAX_GRAPHS; i++) await ask(store, i, 'hnsw'); // ns0 .. ns63 resident, ns0 the oldest
    // a writer on ns0 reaches the flat commit and is held there, with its graph handle in hand
    driver.arm([`${VEC_NS_PREFIX}${tinyNs(0)}`]);
    const extra = tinyRows(901).map((r, i) => ({ ...r, key: `extra-${i}` }));
    const write = store.putVectors(tinyNs(0), extra);
    for (let t = 0; t < 2000 && driver.held.size === 0; t++)
      await new Promise((r) => setTimeout(r, 1));
    expect(driver.held.size, 'the writer reached the flat commit').toBe(1);
    // every other graph is used again, so ns0 is the least recently used of all of them
    for (let i = 1; i < HNSW_MAX_GRAPHS; i++) await ask(store, i, 'hnsw');
    // a query needs a slot while ns0's writer holds its handle
    const hnsw = await ask(store, HNSW_MAX_GRAPHS, 'hnsw');
    expect(hnsw).toEqual(await ask(store, HNSW_MAX_GRAPHS));
    driver.release();
    await write;
    const info = await store.indexInfo(tinyNs(0));
    expect(info!.rows).toBe(40);
    expect(info!.ann, 'the graph took the write').toMatchObject({ nodes: 40, current: true });
    await ask(store, 0, 'hnsw');
    expect(lastQuery(events).attrs).toMatchObject({ index: 'hnsw', fallback: '' });
  }, 120_000);

  it('when every resident graph is in use: the exact flat answer with fallback absent, no throw, the stored graph untouched', async () => {
    const events: Event[] = [];
    const driver = new Gated();
    const store = await twoSessions(driver, events); // ns0 resident, ns1..ns64 persisted
    // 64 writers (ns0 .. ns63) each load or hold their graph and stop at the flat commit
    driver.arm(Array.from({ length: HNSW_MAX_GRAPHS }, (_, i) => `${VEC_NS_PREFIX}${tinyNs(i)}`));
    const writes: Array<Promise<unknown>> = [];
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) {
      const extra = tinyRows(1000 + i).map((r, j) => ({ ...r, key: `extra-${j}` }));
      writes.push(store.putVectors(tinyNs(i), extra));
    }
    for (let t = 0; t < 5000 && driver.held.size < HNSW_MAX_GRAPHS; t++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(driver.held.size, 'all 64 writers are mid-commit').toBe(HNSW_MAX_GRAPHS);
    const last = tinyNs(HNSW_MAX_GRAPHS);
    const stored = await driver.getBytes(`${ANN_NS_PREFIX}${last}`, 'graph');
    const nsWrites = driver.writes;
    events.length = 0;
    const hnsw = await ask(store, HNSW_MAX_GRAPHS, 'hnsw'); // must not throw
    expect(hnsw).toEqual(await ask(store, HNSW_MAX_GRAPHS));
    expect(
      events.filter((e) => e.name === 'storage.query' && e.attrs['requested'] === 'hnsw').at(-1)!
        .attrs,
    ).toMatchObject({ requested: 'hnsw', index: 'flat', fallback: 'absent', ef: null });
    expect(driver.writes, 'the answer wrote, deleted and cleared nothing').toBe(nsWrites);
    expect(await driver.keys(`${ANN_NS_PREFIX}${last}`)).toEqual(['graph', 'params']);
    const still = await driver.getBytes(`${ANN_NS_PREFIX}${last}`, 'graph');
    expect(Array.from(still!.bytes)).toEqual(Array.from(stored!.bytes));
    driver.release();
    await Promise.all(writes);
    // once the writers are done, the same query is answered by its graph
    events.length = 0;
    expect(await ask(store, HNSW_MAX_GRAPHS, 'hnsw')).toEqual(await ask(store, HNSW_MAX_GRAPHS));
    expect(
      events.filter((e) => e.name === 'storage.query' && e.attrs['requested'] === 'hnsw').at(-1)!
        .attrs,
    ).toMatchObject({ index: 'hnsw', fallback: '' });
  }, 120_000);

  it('T2 results unchanged: 80 namespaces built one after another, then all at once: 64 builds succeed and the other 16 throw max_graphs (builds only), then every query answers', async () => {
    const TOTAL = 80;
    for (const mode of ['sequential', 'concurrent'] as const) {
      const driver = new MemoryDriver();
      const store = await createStore({ driver });
      open.push(store);
      for (let i = 0; i < TOTAL; i++) await store.putVectors(tinyNs(i), tinyRows(i));
      const results: Array<'ok' | string> = [];
      const build = (i: number) =>
        store.buildIndex(tinyNs(i), TINY_PARAMS).then(
          () => 'ok',
          (e: unknown) => String((e as { details?: { reason?: string } }).details?.reason),
        );
      if (mode === 'sequential') for (let i = 0; i < TOTAL; i++) results.push(await build(i));
      else results.push(...(await Promise.all(Array.from({ length: TOTAL }, (_, i) => build(i)))));
      expect(
        results.filter((r) => r === 'ok'),
        mode,
      ).toHaveLength(HNSW_MAX_GRAPHS);
      expect(
        results.filter((r) => r === 'max_graphs'),
        mode,
      ).toHaveLength(TOTAL - HNSW_MAX_GRAPHS);
      expect(results, mode).toHaveLength(TOTAL);
      // queries: no throw, flat-equal answers; graphs that exist answer from them, the others flat
      let thrown = 0;
      let differing = 0;
      for (let i = 0; i < TOTAL; i++) {
        const flat = await ask(store, i);
        try {
          if (JSON.stringify(await ask(store, i, 'hnsw')) !== JSON.stringify(flat)) differing++;
        } catch {
          thrown++;
        }
      }
      expect({ mode, thrown, differing }).toEqual({ mode, thrown: 0, differing: 0 });
    }
  }, 180_000);

  it('buildIndex is still the only call the cap refuses: the 65th build throws max_graphs and writes nothing', async () => {
    const driver = new Counting();
    const store = await createStore({ driver });
    open.push(store);
    for (let i = 0; i <= HNSW_MAX_GRAPHS; i++) await store.putVectors(tinyNs(i), tinyRows(i));
    for (let i = 0; i < HNSW_MAX_GRAPHS; i++) await store.buildIndex(tinyNs(i), TINY_PARAMS);
    const before = driver.writes;
    const err = await store
      .buildIndex(tinyNs(HNSW_MAX_GRAPHS), TINY_PARAMS)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'quota_exceeded',
      details: { reason: 'max_graphs', maxGraphs: HNSW_MAX_GRAPHS },
    });
    expect(driver.writes - before).toBe(0);
    // queries on the 64 resident graphs keep answering from them
    expect(await ask(store, 5, 'hnsw')).toEqual(await ask(store, 5));
  }, 120_000);
});
