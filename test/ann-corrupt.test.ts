// D4-04 (TD-65): the graph record is untrusted input at the Storage API level. Written before
// src/vec/ann.ts. Every way a stored graph can be wrong is refused (storage.index.open, kind 'hnsw',
// outcome corrupt, with the reason) and the graph is REBUILT from the stored vectors with the stored
// params before the query answers; the rebuilt graph is byte-identical to a fresh build. A rebuild that
// is refused again drops the index (no loop); refused params drop it at once; a kernel trap re-creates
// the module and answers with the flat scan. A forged graph that links to a deleted row never returns
// it, because liveness comes from the flat HEAD.
import { afterEach, describe, expect, it } from 'vitest';
import { ANN_NS_PREFIX } from '../src/contracts/storage-api';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, type Event, type LocalData } from '../src/index';
import { annStats, armAnnTrap } from '../src/vec/ann-test-hook';
import { f32Bits } from '../src/vec/reference';
import { D, N, NQ, flatScores, keysOf, query, rowVec, rows, key } from './ann.behaviour';
import { crc32c } from './forge';

const NS = 'vecs';
const ANN = `${ANN_NS_PREFIX}${NS}`;
const PARAMS = { kind: 'hnsw', m: 12, efConstruction: 100, seed: 9 } as const;

const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

interface Opened {
  store: LocalData;
  events: Event[];
}

async function openStore(
  driver: MemoryDriver,
  wrap?: (d: MemoryDriver) => MemoryDriver,
): Promise<Opened> {
  const events: Event[] = [];
  const store = await createStore({
    driver: wrap ? wrap(driver) : driver,
    events: { emit: (e) => void events.push(e) },
  });
  open.push(store);
  return { store, events };
}

/** A committed store: N rows and a graph at generation 1, closed, driver left open. */
async function committed(ns = NS, n = N, dim = D): Promise<MemoryDriver> {
  const driver = new MemoryDriver();
  const s = await createStore({ driver });
  const set = Array.from({ length: n }, (_, i) => ({
    key: key(i),
    vector: dim === D ? rowVec(i) : widen(rowVec(i), dim),
  }));
  await s.putVectors(ns, set);
  await s.buildIndex(ns, PARAMS);
  await s.close();
  await driver.open();
  return driver;
}

function widen(v: Float32Array, dim: number): Float32Array {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = v[i % v.length]! * (1 + (i >> 5) * 0.25);
  return out;
}

async function clone(src: MemoryDriver): Promise<MemoryDriver> {
  const dst = new MemoryDriver();
  await dst.open();
  for (const ns of await src.namespaces()) {
    for (const k of await src.keys(ns)) {
      const rec = await src.getBytes(ns, k);
      await dst.put(ns, k, rec!.bytes, rec!.meta);
    }
  }
  return dst;
}

const graphOf = async (d: MemoryDriver, ns = NS) =>
  (await d.getBytes(`${ANN_NS_PREFIX}${ns}`, 'graph'))!.bytes.slice();

async function putGraph(d: MemoryDriver, bytes: Uint8Array, ns = NS): Promise<void> {
  await d.put(`${ANN_NS_PREFIX}${ns}`, 'graph', bytes, { size: bytes.length });
}

function recrc(b: Uint8Array): void {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(
    b.length - 4,
    crc32c(b.subarray(0, b.length - 4)),
    true,
  );
}

const q0 = query(0);
const ask = (s: LocalData, j = 0, k = 10, ef = 64) =>
  s.query(NS, query(j), k, { index: 'hnsw', ef, values: false });

const opens = (ev: Event[]) =>
  ev.filter((e) => e.name === 'storage.index.open' && e.attrs['kind'] === 'hnsw');
const builds = (ev: Event[]) => ev.filter((e) => e.name === 'storage.index.build');
const lastQuery = (ev: Event[]) => ev.filter((e) => e.name === 'storage.query').pop()!;

/** The hits of a fresh, healthy build over the same rows: what every repaired store must return. */
async function freshHits(): Promise<Array<[string, number]>> {
  const d = await committed();
  const { store } = await openStore(d);
  return (await ask(store)).map((h) => [h.key, f32Bits(h.score)]);
}

async function expectRepaired(
  driver: MemoryDriver,
  reason: string,
  fresh: Array<[string, number]>,
): Promise<Opened> {
  const o = await openStore(driver);
  const hits = await ask(o.store);
  expect(hits.map((h) => [h.key, f32Bits(h.score)])).toEqual(fresh);
  const refused = opens(o.events);
  expect(refused.map((e) => [e.attrs['outcome'], e.attrs['reason']])).toEqual([
    ['corrupt', reason],
  ]);
  expect(refused[0]!.level).toBe('warn');
  const rebuilt = builds(o.events);
  expect(rebuilt.map((e) => [e.attrs['reason'], e.attrs['outcome']])).toEqual([['rebuild', 'ok']]);
  const lq = lastQuery(o.events);
  expect(lq.attrs['index']).toBe('hnsw');
  expect(lq.attrs['fallback']).toBe('');
  expect(annStats(o.store, NS).rebuilds).toBe(1);
  // the repaired graph equals a fresh build byte for byte
  const clean = await committed();
  expect(Buffer.from(await graphOf(driver)).equals(Buffer.from(await graphOf(clean)))).toBe(true);
  return o;
}

describe('a refused graph is rebuilt from the stored vectors', () => {
  it('truncation at several offsets (reason length): refused, rebuilt, the same hits as a fresh build', async () => {
    const fresh = await freshHits();
    const base = await committed();
    const len = (await graphOf(base)).length;
    for (const cut of [0, 8, 55, 56, 59, 60, 61, 65, 100, len >> 1, len - 5, len - 1]) {
      const d = await clone(base);
      await putGraph(d, (await graphOf(d)).slice(0, cut));
      await expectRepaired(d, 'length', fresh);
    }
  });

  it('a flipped byte (reason crc), a wrong magic (magic), a bad version (version)', async () => {
    const fresh = await freshHits();
    const base = await committed();
    const whole = await graphOf(base);
    const len = whole.length;
    // 56 is the near-duplicate count (header word 56), 60 + nsLen the first node-table byte
    for (const at of [56, 60 + whole[11]!, 300, len >> 1, len - 1]) {
      const d = await clone(base);
      const g = await graphOf(d);
      g[at] = g[at]! ^ 0x10;
      await putGraph(d, g);
      await expectRepaired(d, 'crc', fresh);
    }
    const m = await clone(base);
    const gm = await graphOf(m);
    gm[0] = 0x58;
    await putGraph(m, gm);
    await expectRepaired(m, 'magic', fresh);
    const v = await clone(base);
    const gv = await graphOf(v);
    gv[8] = 9;
    await putGraph(v, gv);
    await expectRepaired(v, 'version', fresh);
  });

  it("another namespace's graph (reason ns), another dimension's graph (dim), a graph from the future (generation)", async () => {
    const fresh = await freshHits();
    const base = await committed();
    // another namespace: a graph of the same shape and dimension, copied under this namespace's name
    const other = await committed('other');
    const d1 = await clone(base);
    await putGraph(d1, await graphOf(other, 'other'));
    await expectRepaired(d1, 'ns', fresh);
    // another dimension: the 32-dim graph placed into a namespace of 48-dim rows
    const wide = await committed(NS, N, 48);
    const wideFresh = await (async () => {
      const { store } = await openStore(await clone(wide));
      return (await store.query(NS, widen(query(0), 48), 10, { index: 'hnsw', values: false })).map(
        (h) => h.key,
      );
    })();
    const d2 = await clone(wide);
    await putGraph(d2, await graphOf(base));
    const o2 = await openStore(d2);
    const hits2 = await o2.store.query(NS, widen(query(0), 48), 10, {
      index: 'hnsw',
      values: false,
    });
    expect(keysOf(hits2)).toEqual(wideFresh);
    expect(opens(o2.events).map((e) => e.attrs['reason'])).toEqual(['dim']);
    expect(builds(o2.events).map((e) => e.attrs['reason'])).toEqual(['rebuild']);
    // generation ahead of HEAD: refused, never trusted, rebuilt
    const d3 = await clone(base);
    const g3 = await graphOf(d3);
    new DataView(g3.buffer).setUint32(28, 6, true);
    recrc(g3);
    await putGraph(d3, g3);
    await expectRepaired(d3, 'generation', fresh);
  });

  it('structural lies with a valid CRC: an out-of-range link (links) and level 17 (bounds)', async () => {
    const fresh = await freshHits();
    const base = await committed();
    const g = await graphOf(base);
    const dv = new DataView(g.buffer);
    const nsLen = g[11]!;
    const nodes = dv.getUint32(32, true);
    const links = 60 + nsLen + 8 * nodes;
    const d1 = await clone(base);
    const g1 = g.slice();
    new DataView(g1.buffer).setUint32(links + 4, nodes, true);
    recrc(g1);
    await putGraph(d1, g1);
    await expectRepaired(d1, 'links', fresh);
    const d2 = await clone(base);
    const g2 = g.slice();
    g2[60 + nsLen + 4] = 17;
    recrc(g2);
    await putGraph(d2, g2);
    await expectRepaired(d2, 'bounds', fresh);
  });

  it('a header whose params differ from the stored params record (S1-123, S1-128): refused with reason params before anything is reserved, then rebuilt', async () => {
    const fresh = await freshHits();
    const base = await committed(); // stored params: m 12, efConstruction 100, seed 9
    for (const [name, off, value] of [
      ['m 64', 16, 64],
      ['m 4', 16, 4],
      ['efConstruction 1000', 20, 1000],
      ['seed', 24, 77],
    ] as Array<[string, number, number]>) {
      const d = await clone(base);
      const g = await graphOf(d);
      new DataView(g.buffer).setUint32(off, value, true);
      recrc(g);
      await putGraph(d, g);
      const o = await expectRepaired(d, 'params', fresh);
      expect(
        opens(o.events).map((e) => e.attrs['reason']),
        name,
      ).toEqual(['params']);
    }
    // the metric byte: 1 (dot) in a header whose namespace was built for cosine
    const m = await clone(base);
    const gm = await graphOf(m);
    gm[10] = 1;
    recrc(gm);
    await putGraph(m, gm);
    await expectRepaired(m, 'params', fresh);
  });

  it('refused again after the rebuild: the index is dropped, queries answer flat with fallback refused, and there is no loop', async () => {
    const base = await committed();
    const d = await clone(base);
    let reads = 0;
    // every read of the graph record comes back damaged: the rebuilt graph is refused too
    class Damaging extends MemoryDriver {
      constructor(private readonly inner: MemoryDriver) {
        super();
      }
      override async open() {
        await this.inner.open();
      }
      override async close() {
        await this.inner.close();
      }
      override async put(...a: Parameters<MemoryDriver['put']>) {
        return this.inner.put(...a);
      }
      override async del(...a: Parameters<MemoryDriver['del']>) {
        return this.inner.del(...a);
      }
      override async keys(...a: Parameters<MemoryDriver['keys']>) {
        return this.inner.keys(...a);
      }
      override async clear(...a: Parameters<MemoryDriver['clear']>) {
        return this.inner.clear(...a);
      }
      override async namespaces() {
        return this.inner.namespaces();
      }
      override async getBytes(ns: string, k: string) {
        const rec = await this.inner.getBytes(ns, k);
        if (rec && ns === ANN && k === 'graph') {
          reads++;
          const b = rec.bytes.slice();
          b[b.length >> 1] = b[b.length >> 1]! ^ 0x01;
          return { bytes: b, meta: rec.meta };
        }
        return rec;
      }
    }
    const { store, events } = await openStore(d, (x) => new Damaging(x));
    const flat = (await store.query(NS, q0, 10, { values: false })).map((h) => [
      h.key,
      f32Bits(h.score),
    ]);
    events.length = 0;
    const first = await ask(store);
    expect(first.map((h) => [h.key, f32Bits(h.score)])).toEqual(flat);
    expect(lastQuery(events).attrs).toMatchObject({
      requested: 'hnsw',
      index: 'flat',
      fallback: 'refused',
    });
    expect(annStats(store, NS).rebuilds).toBe(1);
    expect(builds(events).map((e) => [e.attrs['reason'], e.attrs['outcome']])).toEqual([
      ['rebuild', 'corrupt'],
    ]);
    // later queries keep answering flat and never rebuild again, with the HEAD generation unchanged
    const readsAfterFirst = reads;
    for (let i = 0; i < 3; i++) {
      const again = await ask(store, i);
      expect(again.length).toBeGreaterThan(0);
      expect(lastQuery(events).attrs['fallback']).toBe('refused');
    }
    expect(annStats(store, NS).rebuilds).toBe(1);
    expect(reads).toBe(readsAfterFirst);
    expect(builds(events)).toHaveLength(1);
    // the index was dropped: the graph namespace holds nothing
    expect(await d.keys(ANN)).toEqual([]);
  });

  it('refused params drop the index at once: no rebuild, the flat answer, the graph namespace emptied', async () => {
    const base = await committed();
    const flat = (
      await (await openStore(await clone(base))).store.query(NS, q0, 10, { values: false })
    ).map((h) => h.key);
    for (const damage of ['crc', 'range', 'size', 'missing'] as const) {
      const d = await clone(base);
      const p = (await d.getBytes(ANN, 'params'))!.bytes.slice();
      if (damage === 'crc') p[12] = p[12]! ^ 1;
      if (damage === 'range') {
        new DataView(p.buffer).setUint32(12, 3, true); // m = 3
        new DataView(p.buffer).setUint32(24, crc32c(p.subarray(0, 24)), true);
      }
      if (damage === 'size') await d.put(ANN, 'params', p.slice(0, 20), { size: 20 });
      else if (damage === 'missing') await d.del(ANN, 'params');
      else await d.put(ANN, 'params', p, { size: p.length });
      const { store, events } = await openStore(d);
      const hits = await ask(store);
      expect(keysOf(hits), damage).toEqual(flat);
      expect(lastQuery(events).attrs, damage).toMatchObject({ index: 'flat', fallback: 'refused' });
      expect(annStats(store, NS).rebuilds, damage).toBe(0);
      expect(builds(events), damage).toHaveLength(0);
      expect(await d.keys(ANN), damage).toEqual([]);
      // building again repairs it: the sticky refusal ends with buildIndex
      await store.buildIndex(NS, PARAMS);
      await ask(store);
      expect(lastQuery(events).attrs, damage).toMatchObject({ index: 'hnsw', fallback: '' });
    }
  });

  it('a kernel trap during an hnsw query: the module is re-created, the flat answer is returned, the next query uses the graph again', async () => {
    const base = await committed();
    const { store, events } = await openStore(await clone(base));
    const flat = (await store.query(NS, q0, 10, { values: false })).map((h) => [
      h.key,
      f32Bits(h.score),
    ]);
    await ask(store); // loads the graph
    armAnnTrap(store);
    const hits = await ask(store);
    expect(hits.map((h) => [h.key, f32Bits(h.score)])).toEqual(flat);
    expect(lastQuery(events).attrs).toMatchObject({
      requested: 'hnsw',
      index: 'flat',
      fallback: 'trap',
      ef: null,
    });
    // a fresh instance: the graph is read from the driver again and answers
    const again = await ask(store);
    expect(again.length).toBeGreaterThan(0);
    expect(lastQuery(events).attrs).toMatchObject({ index: 'hnsw', fallback: '' });
    expect(annStats(store, NS).rebuilds).toBe(0);
  });

  it('a trap while loading the graph, and while building it, is the same story', async () => {
    const base = await committed();
    const { store, events } = await openStore(await clone(base));
    armAnnTrap(store);
    const hits = await ask(store); // first hnsw query loads the graph: that call traps
    expect(keysOf(hits).length).toBeGreaterThan(0);
    expect(lastQuery(events).attrs).toMatchObject({ index: 'flat', fallback: 'trap' });
    const ok1 = await ask(store);
    expect(ok1.length).toBeGreaterThan(0);
    expect(lastQuery(events).attrs).toMatchObject({ index: 'hnsw', fallback: '' });
    // buildIndex that traps rejects with io (nothing was written), and a retry works
    const d = new MemoryDriver();
    const s = await createStore({ driver: d });
    open.push(s);
    await s.putVectors(NS, rows(0, 80));
    armAnnTrap(s);
    await expect(s.buildIndex(NS, PARAMS)).rejects.toMatchObject({ code: 'io' });
    expect(await d.keys(ANN)).toEqual([]);
    const r = await s.buildIndex(NS, PARAMS);
    expect(r.liveRows).toBe(80);
  });
});

describe('liveness comes from the flat HEAD, never from the graph', () => {
  it('a forged graph that links to a deleted row, with its deleted flag cleared, never returns the key', async () => {
    const d = await committed();
    {
      const s = await createStore({ driver: d });
      open.push(s);
      for (const i of [10, 11, 12]) await s.delete(NS, key(i));
      await s.close();
      await d.open();
    }
    const g = await graphOf(d);
    const dv = new DataView(g.buffer);
    const nsLen = g[11]!;
    const nodes = dv.getUint32(32, true);
    expect(dv.getUint32(36, true)).toBe(nodes - 3); // the graph noted the deletes
    const table = 60 + nsLen;
    let cleared = 0;
    for (let i = 0; i < nodes; i++) {
      if (g[table + 8 * i + 5] === 1) {
        g[table + 8 * i + 5] = 0;
        cleared++;
      }
    }
    expect(cleared).toBe(3);
    dv.setUint32(36, nodes, true);
    recrc(g);
    await putGraph(d, g);
    const { store, events } = await openStore(d);
    for (const i of [10, 11, 12]) {
      const hits = await store.query(NS, rowVec(i), 30, { index: 'hnsw', ef: 300, values: false });
      expect(keysOf(hits)).not.toContain(key(i));
      expect(hits.length).toBeGreaterThan(5);
    }
    // the forged graph passed validation (it is structurally fine): nothing was rebuilt
    expect(opens(events).map((e) => e.attrs['outcome'])).toEqual(['ok']);
    expect(builds(events)).toHaveLength(0);
    expect(lastQuery(events).attrs).toMatchObject({ index: 'hnsw', fallback: '' });
  });
});

describe('a stale graph is never used', () => {
  it('a graph write that fails after the flat commit leaves it stale: the flat answer, fallback stale; buildIndex repairs it', async () => {
    const d = await committed();
    class FailAnn extends MemoryDriver {
      failing = false;
      constructor(private readonly inner: MemoryDriver) {
        super();
      }
      override async open() {
        await this.inner.open();
      }
      override async close() {
        await this.inner.close();
      }
      override async put(ns: string, k: string, b: Uint8Array, m: { size: number }) {
        if (this.failing && ns.startsWith(ANN_NS_PREFIX)) throw new Error('disk exploded');
        return this.inner.put(ns, k, b, m);
      }
      override async del(...a: Parameters<MemoryDriver['del']>) {
        return this.inner.del(...a);
      }
      override async keys(...a: Parameters<MemoryDriver['keys']>) {
        return this.inner.keys(...a);
      }
      override async clear(...a: Parameters<MemoryDriver['clear']>) {
        return this.inner.clear(...a);
      }
      override async namespaces() {
        return this.inner.namespaces();
      }
      override async getBytes(...a: Parameters<MemoryDriver['getBytes']>) {
        return this.inner.getBytes(...a);
      }
    }
    let wrapper: FailAnn | undefined;
    const { store, events } = await openStore(d, (x) => (wrapper = new FailAnn(x)));
    await ask(store); // graph loaded, current
    wrapper!.failing = true;
    await store.putVectors(NS, [{ key: 'extra-1', vector: rowVec(3) }]); // flat commits, graph write fails
    wrapper!.failing = false;
    const flat = await store.query(NS, q0, 10, { values: false });
    const stale = await ask(store);
    expect(keysOf(stale)).toEqual(keysOf(flat));
    expect(lastQuery(events).attrs).toMatchObject({
      requested: 'hnsw',
      index: 'flat',
      fallback: 'stale',
    });
    const info = await store.indexInfo(NS);
    expect(info?.ann?.current).toBe(false);
    expect(info?.ann?.generation).toBe(1);
    expect(info?.generation).toBe(2);
    await store.buildIndex(NS, PARAMS);
    await ask(store);
    expect(lastQuery(events).attrs).toMatchObject({ index: 'hnsw', fallback: '' });
    expect((await store.indexInfo(NS))?.ann?.current).toBe(true);
  });

  it('a graph that is behind HEAD when the store opens (another store wrote the flat index without it) falls back to the flat answer', async () => {
    const d = await committed();
    const other = await createStore({ driver: d });
    open.push(other);
    // drop the graph so the other store's write does not maintain it, then restore the old graph file
    const old = await graphOf(d);
    const oldParams = (await d.getBytes(ANN, 'params'))!;
    await other.dropIndex(NS, 'hnsw');
    await other.putVectors(NS, [{ key: 'extra-2', vector: rowVec(4) }]);
    await d.put(ANN, 'graph', old, { size: old.length });
    await d.put(ANN, 'params', oldParams.bytes, oldParams.meta);
    await other.close();
    await d.open();
    const { store, events } = await openStore(d);
    const flat = await store.query(NS, q0, 10, { values: false });
    const hits = await ask(store);
    expect(keysOf(hits)).toEqual(keysOf(flat));
    expect(lastQuery(events).attrs).toMatchObject({ index: 'flat', fallback: 'stale' });
    expect(opens(events).map((e) => e.attrs['outcome'])).toEqual(['ok']);
  });
});

describe('a seeded fuzz of the stored graph record', () => {
  it('300 mutations: no query throws, every hit carries the flat score, and the result is never a deleted key', async () => {
    const base = await committed();
    {
      const s = await createStore({ driver: base });
      open.push(s);
      await s.delete(NS, key(20));
      await s.close();
      await base.open();
    }
    const good = await graphOf(base);
    const truth = await (async () => {
      const { store } = await openStore(await clone(base));
      return flatScores(store, q0, N);
    })();
    let a = 0x1d4_0004;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let rebuilt = 0;
    for (let i = 0; i < 300; i++) {
      let m: Uint8Array = good.slice();
      for (let r = 1 + Math.floor(rnd() * 3); r > 0; r--) {
        const at = Math.floor(rnd() * m.length);
        const how = Math.floor(rnd() * 4);
        if (how === 0) m[at] = m[at]! ^ (1 << Math.floor(rnd() * 8));
        else if (how === 1) m[at] = Math.floor(rnd() * 256);
        else if (how === 2) m = m.slice(0, at);
        else if (at + 4 <= m.length)
          new DataView(m.buffer, m.byteOffset).setUint32(
            at,
            [0, 1, N - 1, N, N + 1, 0xffff_ffff][Math.floor(rnd() * 6)]!,
            true,
          );
      }
      if (m.length >= 4 && rnd() < 0.5) recrc(m);
      const d = await clone(base);
      await putGraph(d, m);
      const { store, events } = await openStore(d);
      const hits = await store.query(NS, q0, 10, { index: 'hnsw', ef: 80, values: false });
      expect(hits.length, `mutation ${i}`).toBeGreaterThan(0);
      for (const h of hits) {
        expect(f32Bits(h.score), `mutation ${i}`).toBe(truth.get(h.key));
        expect(h.key).not.toBe(key(20));
      }
      if (builds(events).length > 0) rebuilt++;
      await store.close();
    }
    console.log(`HNSW-STORE-FUZZ mutations 300 rebuilt ${rebuilt}`);
    expect(rebuilt).toBeGreaterThan(100);
    expect(NQ).toBeGreaterThan(0);
  }, 300_000);
});
