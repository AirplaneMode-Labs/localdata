// D4-04 (TD-65): HNSW behind the Storage API 0.4.0, over the WebAssembly kernel, in Node. Written before
// src/vec/ann.ts. The shared suite (test/ann.behaviour.ts) runs on the memory driver and on the OPFS
// driver over the in-memory OPFS; test/browser/ann.spec.ts runs it again on real OPFS and IndexedDB in
// installed Chrome. Corruption cases are in test/ann-corrupt.test.ts, quota cases in test/ann-quota.test.ts.
//
//   * the fixed 10,000 x 384 clustered set: recall@10 against the flat answers of the same store is at
//     least 0.95 (the floor was stated before measuring; the figure is logged)
//   * the graph record built through the store for the determinism fixture has the fixture's sha256,
//     with both the SIMD and the scalar kernel: the same bytes as the native build
//   * flat stays the default; the events carry the documented attrs and never a key, a vector or the seed
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clusteredSet, RECALL_SET, synthVector } from '../bench/synth';
import type { StorageDriver } from '../src/contracts/storage-api';
import { MemoryDriver } from '../src/drivers/memory';
import { OpfsDriver } from '../src/drivers/opfs';
import { createStore, STORAGE_EVENT_NAMES, type Event, type LocalData } from '../src/index';
import {
  annCases,
  flatScores,
  keysOf,
  runAnnSuite,
  type AnnEnv,
  type AnnStoreOptions,
} from './ann.behaviour';
import { eventProblems } from './event-validate';
import { installFakeNavigator, type FakeNavigator } from './fake-env';

const stores: LocalData[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
});

function sdkOptions(o: AnnStoreOptions | undefined, driver: StorageDriver) {
  return {
    driver: o?.wrap ? o.wrap(driver) : driver,
    ...(o?.quotaBytes !== undefined ? { quotaBytes: o.quotaBytes } : {}),
    ...(o?.maxIndexBytes !== undefined ? { maxIndexBytes: o.maxIndexBytes } : {}),
    ...(o?.vectorKernel !== undefined ? { vectorKernel: o.vectorKernel } : {}),
    ...(o?.events !== undefined ? { events: o.events } : {}),
  };
}

export function memoryAnnEnv(): AnnEnv {
  let driver = new MemoryDriver();
  return {
    makeStore: async (o) => {
      driver = new MemoryDriver();
      const s = await createStore(sdkOptions(o, driver));
      stores.push(s);
      return s;
    },
    reopen: async (o) => {
      const s = await createStore(sdkOptions(o, driver));
      stores.push(s);
      return s;
    },
    // The live store shares this driver: hand out a view whose close() does nothing, so a case that
    // inspects records while the store is open cannot close the store's own driver.
    raw: async () => {
      await driver.open();
      return Object.create(driver, { close: { value: async () => undefined } }) as MemoryDriver;
    },
  };
}

let nav: FakeNavigator | undefined;
afterEach(() => {
  nav?.restore();
  nav = undefined;
});

/** The OPFS driver over the in-memory OPFS and Web Locks of test/fake-env.ts. */
function opfsAnnEnv(): AnnEnv {
  return {
    makeStore: async (o) => {
      nav?.restore();
      nav = installFakeNavigator({ locks: true });
      const s = await createStore(sdkOptions(o, new OpfsDriver()));
      stores.push(s);
      return s;
    },
    reopen: async (o) => {
      const s = await createStore(sdkOptions(o, new OpfsDriver()));
      stores.push(s);
      return s;
    },
    raw: async () => {
      const d = new OpfsDriver();
      await d.open();
      return d;
    },
  };
}

describe('HNSW suite (memory driver)', () => {
  it('has the cases, with unique names', () => {
    expect(annCases.length).toBeGreaterThanOrEqual(14);
    expect(new Set(annCases.map((c) => c.name)).size).toBe(annCases.length);
  });
  runAnnSuite(memoryAnnEnv(), (name, fn) => it(name, fn, 120_000));
});

describe('HNSW suite (OPFS driver over the in-memory OPFS)', () => {
  runAnnSuite(opfsAnnEnv(), (name, fn) => it(name, fn, 120_000));
});

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('the fixed 10k x 384 clustered set', () => {
  it('recall@10 against the flat answers meets the 0.95 floor at m 16, efConstruction 200, ef 100', async () => {
    const FLOOR = 0.95; // stated before measuring (plan addendum 2026-11-19, section 1.3)
    const { seed, centres, dim, rows, queries } = RECALL_SET;
    const set = clusteredSet(seed, centres, dim, rows, queries);
    const store = await createStore({ driver: new MemoryDriver() });
    stores.push(store);
    await store.putVectors(
      'recall',
      (function* () {
        for (let i = 0; i < rows; i++)
          yield {
            key: `r${String(i).padStart(5, '0')}`,
            vector: set.rows.slice(i * dim, (i + 1) * dim),
          };
      })(),
    );
    const t0 = performance.now();
    const built = await store.buildIndex('recall', {
      kind: 'hnsw',
      m: 16,
      efConstruction: 200,
      seed: 1,
    });
    const buildMs = Math.round(performance.now() - t0);
    let sum = 0;
    for (let j = 0; j < queries; j++) {
      const q = set.queries.slice(j * dim, (j + 1) * dim);
      const flat = keysOf(await store.query('recall', q, 10, { values: false }));
      const ann = keysOf(
        await store.query('recall', q, 10, { values: false, index: 'hnsw', ef: 100 }),
      );
      sum += ann.filter((k) => flat.includes(k)).length / flat.length;
    }
    const recall = sum / queries;
    console.log(
      `HNSW-STORE10K recall@10 ${recall.toFixed(4)} (floor ${FLOOR}) build ${buildMs} ms graph ${built.bytes} bytes`,
    );
    expect(recall).toBeGreaterThanOrEqual(FLOOR);
  }, 300_000);
});

describe('determinism: the graph record equals the fixture (the native sha256)', () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'hnsw-determinism.json'), 'utf8'),
  ) as {
    seed: number;
    rows: number;
    dim: number;
    centres: number;
    m: number;
    efConstruction: number;
    graphSeed: number;
    ns: string;
    graphBytes: number;
    graphSha256: string;
  };
  for (const kernel of ['simd', 'scalar'] as const) {
    it(`${kernel} kernel: same rows in the same order, same graph bytes as native`, async () => {
      const set = clusteredSet(fixture.seed, fixture.centres, fixture.dim, fixture.rows, 1);
      const driver = new MemoryDriver();
      const store = await createStore({ driver, vectorKernel: kernel });
      stores.push(store);
      await store.putVectors(
        fixture.ns,
        (function* () {
          for (let i = 0; i < fixture.rows; i++)
            yield { key: `k${i}`, vector: set.rows.slice(i * fixture.dim, (i + 1) * fixture.dim) };
        })(),
      );
      const r = await store.buildIndex(fixture.ns, {
        kind: 'hnsw',
        m: fixture.m,
        efConstruction: fixture.efConstruction,
        seed: fixture.graphSeed,
      });
      expect(r.generation).toBe(1);
      const rec = await driver.getBytes(`__ld_ann.${fixture.ns}`, 'graph');
      const sha = sha256(rec!.bytes);
      console.log(`HNSW-STORE ${kernel} graph bytes ${rec!.bytes.length} sha256 ${sha}`);
      expect(rec!.bytes.length).toBe(fixture.graphBytes);
      expect(sha).toBe(fixture.graphSha256);
    }, 120_000);
  }
});

describe('events (Event 0.1.5)', () => {
  const SEED = 424242;
  async function setup() {
    const events: Event[] = [];
    const driver = new MemoryDriver();
    const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
    stores.push(store);
    return { store, events, driver };
  }
  const set = clusteredSet(5, 4, 16, 150, 3);
  const rows = Array.from({ length: 150 }, (_, i) => ({
    key: `secret-key-${i}`,
    vector: set.rows.slice(i * 16, (i + 1) * 16),
  }));

  it('STORAGE_EVENT_NAMES has the eleven names of Event 0.1.5, ending with storage.index.build', () => {
    expect(STORAGE_EVENT_NAMES.length).toBe(11);
    expect(STORAGE_EVENT_NAMES[10]).toBe('storage.index.build');
  });

  it('storage.index.build, storage.query attrs and storage.index.open (hnsw) have the documented shapes', async () => {
    const { store, events } = await setup();
    await store.putVectors('ev', rows);
    events.length = 0;
    const q = set.queries.slice(0, 16);
    await store.query('ev', q, 5); // default: flat
    await store.query('ev', q, 5, { index: 'hnsw' }); // no graph yet
    await store.buildIndex('ev', { kind: 'hnsw', m: 8, efConstruction: 40, seed: SEED });
    await store.query('ev', q, 5, { index: 'hnsw', ef: 100 });
    await store.query('ev', q, 5, { index: 'hnsw' });
    await store.query('ev', q, 5, { index: 'hnsw', filterPrefix: 'secret-key-1' });
    await store.query('ev', q, 5, { index: 'hnsw', metric: 'dot' });
    await store.buildIndex('ev', { kind: 'hnsw', m: 8, efConstruction: 40, seed: SEED });
    const queries = events.filter((e) => e.name === 'storage.query');
    const shape = (e: Event) => [
      e.attrs['requested'],
      e.attrs['index'],
      e.attrs['fallback'],
      e.attrs['ef'],
    ];
    expect(queries.map(shape)).toEqual([
      ['flat', 'flat', '', null],
      ['hnsw', 'flat', 'absent', null],
      ['hnsw', 'hnsw', '', 100],
      ['hnsw', 'hnsw', '', 64],
      ['hnsw', 'flat', 'filter', null],
      ['hnsw', 'flat', 'metric', null],
    ]);
    const builds = events.filter((e) => e.name === 'storage.index.build');
    expect(builds.map((e) => e.attrs['reason'])).toEqual(['build', 'replace']);
    const b = builds[0]!;
    expect(b.kind).toBe('timing');
    expect(b.level).toBe('debug');
    expect(b.source).toBe('localdata');
    expect(b.attrs).toEqual({
      ns: 'ev',
      driver: 'memory',
      kind: 'hnsw',
      reason: 'build',
      outcome: 'ok',
      rows: 150,
      liveRows: 150,
      dim: 16,
      m: 8,
      efConstruction: 40,
    });
    expect(b.bytes).toBeGreaterThan(0);
    expect(b.durationMs).toBeGreaterThanOrEqual(0);
    for (const e of events) expect(eventProblems(e), `${e.name}: ${JSON.stringify(e)}`).toEqual([]);
  });

  it('a failed build is a warn event with the error code; a graph open is an index.open event of kind hnsw', async () => {
    const { store, events, driver } = await setup();
    await store.putVectors('ev', rows);
    events.length = 0;
    await expect(store.buildIndex('ev', { kind: 'hnsw', m: 3 })).rejects.toMatchObject({
      code: 'invalid_value',
    });
    const failed = events.find((e) => e.name === 'storage.index.build')!;
    expect(failed.attrs['outcome']).toBe('invalid_value');
    expect(failed.level).toBe('warn');
    await store.buildIndex('ev', { kind: 'hnsw', m: 8, efConstruction: 40 });
    await store.close();
    await driver.open();
    const again: Event[] = [];
    const s2 = await createStore({ driver, events: { emit: (e) => void again.push(e) } });
    stores.push(s2);
    await s2.query('ev', set.queries.slice(0, 16), 5, { index: 'hnsw' });
    const opens = again.filter((e) => e.name === 'storage.index.open');
    expect(opens.map((e) => e.attrs['kind'])).toEqual(['flat', 'hnsw']);
    const g = opens[1]!;
    expect(g.attrs['outcome']).toBe('ok');
    expect(g.attrs['reason']).toBe('');
    expect(g.attrs['rows']).toBe(150);
    expect(g.bytes).toBeGreaterThan(0);
    for (const e of again) expect(eventProblems(e), e.name).toEqual([]);
  });

  it('no key, vector component, query or the seed appears in any event, over build, query and corruption', async () => {
    const { store, events, driver } = await setup();
    await store.putVectors('ev', rows);
    await store.buildIndex('ev', { kind: 'hnsw', m: 8, efConstruction: 40, seed: SEED });
    await store.query('ev', set.queries.slice(0, 16), 5, {
      index: 'hnsw',
      filterPrefix: 'secret-key-9',
    });
    await store.query('ev', set.queries.slice(0, 16), 5, { index: 'hnsw' });
    await store.delete('ev', 'secret-key-3');
    // a refused graph: truncate it, query again (index.open corrupt, then a rebuild)
    const rec = await driver.getBytes('__ld_ann.ev', 'graph');
    await driver.put('__ld_ann.ev', 'graph', rec!.bytes.slice(0, 100), { size: 100 });
    await store.close();
    await driver.open();
    const after: Event[] = [];
    const s2 = await createStore({ driver, events: { emit: (e) => void after.push(e) } });
    stores.push(s2);
    await s2.query('ev', set.queries.slice(0, 16), 5, { index: 'hnsw' });
    const wire = JSON.stringify([...events, ...after]);
    for (const needle of ['secret-key', String(SEED), 'Float32Array']) {
      expect(wire, `leaked ${needle}`).not.toContain(needle);
    }
    expect(
      after.some((e) => e.name === 'storage.index.build' && e.attrs['reason'] === 'rebuild'),
    ).toBe(true);
    for (const e of [...events, ...after]) expect(eventProblems(e), e.name).toEqual([]);
  });

  it('flat stays the default: a query with no index option never touches the graph', async () => {
    const { store, events } = await setup();
    await store.putVectors('ev', rows);
    await store.buildIndex('ev', { kind: 'hnsw', m: 8, efConstruction: 40 });
    const truth = await flatScores(store, set.queries.slice(0, 16), 150, 'ev');
    expect(truth.size).toBe(150);
    events.length = 0;
    const hits = await store.query('ev', set.queries.slice(0, 16), 5);
    expect(hits.length).toBe(5);
    const q = events.filter((e) => e.name === 'storage.query');
    expect(q).toHaveLength(1);
    expect(q[0]!.attrs['requested']).toBe('flat');
    expect(q[0]!.attrs['index']).toBe('flat');
    expect(
      events.filter((e) => e.name === 'storage.index.open' && e.attrs['kind'] === 'hnsw'),
    ).toHaveLength(0);
  });
});

// BUG-T2-S6-02 (fix round 1): many identical vectors (boilerplate chunks embed identically) make the graph
// return fewer than k hits (T2 measured 34 for k = 50 with 60, 200 or 1,000 copies, at ef 64 and 500). The
// kernel is not changed this sprint (its graph bytes and determinism fixture stay as they are); the SDK
// detects the short answer and answers with the exact flat scan, reporting fallback 'short'.
describe('identical vectors: a short graph answer falls back to the flat scan', () => {
  const DIM = 32;
  const base = clusteredSet(11, 40, DIM, 5000, 1);
  const one = synthVector(424_242, DIM);
  const flatRows = Array.from({ length: 5000 }, (_, i) => ({
    key: `k${String(i).padStart(5, '0')}`,
    vector: base.rows.slice(i * DIM, (i + 1) * DIM),
  }));

  async function setup(copies: number) {
    const events: Event[] = [];
    const store = await createStore({
      driver: new MemoryDriver(),
      events: { emit: (e) => void events.push(e) },
    });
    stores.push(store);
    await store.putVectors('dup', flatRows);
    if (copies > 0) {
      await store.putVectors(
        'dup',
        Array.from({ length: copies }, (_, i) => ({ key: `dup${i}`, vector: one.slice() })),
      );
    }
    await store.buildIndex('dup', { kind: 'hnsw', m: 16, efConstruction: 200, seed: 1 });
    return { store, events };
  }

  const lastQuery = (events: Event[]) => events.filter((e) => e.name === 'storage.query').at(-1)!;
  const bits = (hits: Array<{ key: string; score: number }>) =>
    hits.map((h) => [h.key, new Uint32Array(new Float32Array([h.score]).buffer)[0]]);

  for (const copies of [60, 1000]) {
    it(`${copies} copies of one vector: k = 50 on hnsw returns the 50 flat hits and reports fallback 'short'`, async () => {
      const { store, events } = await setup(copies);
      const flat = await store.query('dup', one, 50);
      expect(flat).toHaveLength(50);
      events.length = 0;
      const hnsw = await store.query('dup', one, 50, { index: 'hnsw' });
      expect(hnsw).toHaveLength(50);
      expect(bits(hnsw)).toEqual(bits(flat));
      expect(lastQuery(events).attrs).toMatchObject({
        requested: 'hnsw',
        index: 'flat',
        fallback: 'short',
        ef: null,
      });
      // a wider ef does not change the story, and the answer is still the flat answer
      const wide = await store.query('dup', one, 50, { index: 'hnsw', ef: 500 });
      expect(bits(wide)).toEqual(bits(flat));
      expect(lastQuery(events).attrs).toMatchObject({ index: 'flat', fallback: 'short' });
    }, 120_000);
  }

  it('20 copies: the graph still answers (a full k hits), fallback is empty, index is hnsw', async () => {
    const { store, events } = await setup(20);
    events.length = 0;
    const hnsw = await store.query('dup', one, 50, { index: 'hnsw' });
    expect(hnsw).toHaveLength(50);
    expect(lastQuery(events).attrs).toMatchObject({
      requested: 'hnsw',
      index: 'hnsw',
      fallback: '',
    });
    expect(lastQuery(events).attrs['ef']).toBe(64);
  }, 120_000);

  it('k above the namespace size and k above ef (HNSW_EF_MAX): the exact flat answer, never a short list', async () => {
    const { store, events } = await setup(0);
    const flat = await store.query('dup', one, 1500, { values: false });
    expect(flat).toHaveLength(1500);
    events.length = 0;
    const hnsw = await store.query('dup', one, 1500, { values: false, index: 'hnsw' });
    expect(bits(hnsw)).toEqual(bits(flat));
    expect(lastQuery(events).attrs).toMatchObject({ index: 'flat', fallback: 'short' });
    // k larger than the live rows: min(k, live) is what flat returns, and hnsw with k <= ef finds them
    const small = await createStore({ driver: new MemoryDriver() });
    stores.push(small);
    await small.putVectors('s', flatRows.slice(0, 30));
    await small.buildIndex('s', { kind: 'hnsw', m: 8, efConstruction: 50, seed: 1 });
    const all = await small.query('s', one, 100, { values: false, index: 'hnsw' });
    expect(all).toHaveLength(30);
  }, 120_000);
});
