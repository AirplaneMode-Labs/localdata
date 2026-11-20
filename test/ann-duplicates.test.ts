// D4-01 (TD-109; BUG-T2-S6-14 / S1-124): the HNSW index over data with many exact duplicate vectors, through
// the Storage API and the WebAssembly kernel. The Rust tests (crates/ldvec/tests/hnsw_dup.rs) hold the kernel
// to the floors; these hold the SDK to them:
//   * on every duplicate set, at ef 64, at least 99 of 100 queries give HNSW top-10 scores equal to flat's
//     (as a multiset, bit for bit) and the mean recall@10 by score is at least 0.99, whether the graph or the
//     flat scan (fallback 'duplicates') answered; a graph that answered did so with a full k
//   * the build event carries duplicateRows, counted over LIVE rows only
//   * a put recounts the largest group of copies, so a graph that becomes degenerate says so on the next query
//   * a graph file of the first format (magic LDHNSW01) is refused with reason 'version' and rebuilt from the
//     stored vectors at most once per HEAD generation, guarded by a persisted marker, and the rebuild goes
//     through the same quota and maxIndexBytes refusals as a fresh build
//   * near-duplicates (BUG-T2-S7-02, TD-126): a group of live rows that share one quantised key (the low twelve
//     mantissa bits of every component cleared) larger than 2m also makes the graph degenerate, on T2's tight-cluster
//     sets as on exact copies; a group of 20 one-ulp variants stays on the graph; the count survives a reload
//   * a forged RAISED degenerate statistic can only force the exact flat path; a forged LOWERED one (kept consistent
//     with the exact count) suppresses the fallback and so can only cost recall: it cannot change a score
//     (BUG-T2-S7-03, S1-134, TD-127: the statistic is not recounted at load)
import { afterEach, describe, expect, it } from 'vitest';
import { clusteredSet, uniformPoints } from '../bench/synth';
import { ANN_NS_PREFIX } from '../src/contracts/storage-api';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, type Event, type LocalData } from '../src/index';
import { annStats } from '../src/vec/ann-test-hook';
import { decodeRebuilt, REBUILT_KEY } from '../src/vec/ann';
import { f32Bits } from '../src/vec/reference';
import { eventProblems } from './event-validate';
import { crc32c } from './forge';

const NS = 'dup';
const ANN = `${ANN_NS_PREFIX}${NS}`;
const QUERIES = 100;
const MIN_EQUAL = 99;
const MIN_RECALL = 0.99;
const PARAMS = { kind: 'hnsw', m: 16, efConstruction: 200, seed: 1 } as const;

const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

interface DataSet {
  name: string;
  dim: number;
  rows: Float32Array;
  queries: Float32Array;
  /** The size of the largest group of byte-identical rows, known from how the set is made. */
  maxGroup: number;
  /** The number of rows whose bytes equal an earlier row's. */
  dupRows: number;
}

const slice = (v: Float32Array, i: number, dim: number) => v.slice(i * dim, (i + 1) * dim);

function boilerplate(
  dim: number,
  groups: number,
  copies: number,
  unique: number,
  seed: number,
): DataSet {
  const c = clusteredSet(seed, 20, dim, groups + unique, QUERIES);
  const rows = new Float32Array((groups * copies + unique) * dim);
  let at = 0;
  for (let g = 0; g < groups; g++)
    for (let k = 0; k < copies; k++) rows.set(slice(c.rows, g, dim), dim * at++);
  for (let u = 0; u < unique; u++) rows.set(slice(c.rows, groups + u, dim), dim * at++);
  return {
    name: `${groups} groups x ${copies} copies + ${unique} distinct, dim ${dim}`,
    dim,
    rows,
    queries: c.queries,
    maxGroup: Math.max(1, copies),
    dupRows: groups * Math.max(0, copies - 1),
  };
}

function uniformProbe(
  dim: number,
  groups: number,
  copies: number,
  unique: number,
  seed: number,
): DataSet {
  const base = uniformPoints(seed, 'data', groups + unique, dim);
  const rows = new Float32Array((groups * copies + unique) * dim);
  let at = 0;
  for (let g = 0; g < groups; g++)
    for (let k = 0; k < copies; k++) rows.set(slice(base, g, dim), dim * at++);
  for (let u = 0; u < unique; u++) rows.set(slice(base, groups + u, dim), dim * at++);
  return {
    name: `uniform ${groups} groups x ${copies} copies + ${unique} distinct, dim ${dim}`,
    dim,
    rows,
    queries: uniformPoints(seed ^ 0x77, 'query', QUERIES, dim),
    maxGroup: Math.max(1, copies),
    dupRows: groups * Math.max(0, copies - 1),
  };
}

function nearDuplicates(dim: number, groups: number, perGroup: number, seed: number): DataSet {
  const c = clusteredSet(seed, 20, dim, groups, QUERIES);
  const rows = new Float32Array(groups * perGroup * dim);
  const u32 = new Uint32Array(rows.buffer);
  let at = 0;
  for (let g = 0; g < groups; g++) {
    for (let k = 0; k < perGroup; k++) {
      rows.set(slice(c.rows, g, dim), dim * at);
      if (k > 0) for (const j of [(k * 7) % dim, (k * 13 + 3) % dim]) u32[dim * at + j]! += 1;
      at++;
    }
  }
  return {
    name: `${groups} groups x ${perGroup} one-ulp near-duplicates, dim ${dim}`,
    dim,
    rows,
    queries: c.queries,
    maxGroup: 1,
    dupRows: 0,
  };
}

// ---- T2's tight-cluster sets (BUG-T2-S7-02, TD-126) --------------------------------------------------------
// Ported from crates/ldvec/tests/hnsw_dup.rs (`t2sets`), which is T2's own generator: a SplitMix64 stream, 5 centres,
// groups of `perGroup` rows one to three ulps off a base. Every f32 operation is rounded with Math.fround so the
// rows are the same bytes as the Rust test's. Before the near-duplicate rule the graph answered these with 95 to 98
// of 100 queries equal to flat and no fallback.
const M64 = (1n << 64n) - 1n;
class T2Rng {
  constructor(private s: bigint) {}
  next(): bigint {
    this.s = (this.s + 0x9e3779b97f4a7c15n) & M64;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return z ^ (z >> 31n);
  }
  gauss(): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum = Math.fround(sum + Number(this.next() >> 40n) / 16777216);
    return Math.fround(sum - 6);
  }
  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}
const F = Math.fround;

function t2CentresPoints(
  r: T2Rng,
  dim: number,
  distinct: number,
  centres: number,
  sigma: number,
): Float32Array[] {
  const cs = Array.from({ length: centres }, () =>
    Float32Array.from({ length: dim }, () => r.gauss()),
  );
  const sg = F(sigma);
  return Array.from({ length: distinct }, () => {
    const c = cs[r.below(centres)]!;
    return Float32Array.from(c, (x) => F(x + F(sg * r.gauss())));
  });
}

function t2Queries(r: T2Rng, base: Float32Array[], dim: number): Float32Array {
  const out = new Float32Array(100 * dim);
  let at = 0;
  for (let i = 0; i < 40; i++) out.set(base[r.below(base.length)]!, dim * at++);
  for (let i = 0; i < 40; i++) {
    const b = base[r.below(base.length)]!;
    out.set(
      Float32Array.from(b, (x) => F(x + F(F(0.05) * r.gauss()))),
      dim * at++,
    );
  }
  for (let i = 0; i < 20; i++) {
    const a = base[r.below(base.length)]!;
    const b = base[r.below(base.length)]!;
    out.set(
      Float32Array.from(a, (x, j) => F(F(F(0.5) * F(x + b[j]!)) + F(F(0.02) * r.gauss()))),
      dim * at++,
    );
  }
  return out;
}

function t2Shuffle<T>(r: T2Rng, v: T[]): void {
  for (let i = v.length - 1; i >= 1; i--) {
    const j = r.below(i + 1);
    [v[i], v[j]] = [v[j]!, v[i]!];
  }
}

function countDupRows(rows: Float32Array, dim: number): number {
  const seen = new Set<string>();
  let dup = 0;
  for (let i = 0; i < rows.length / dim; i++) {
    const k = Buffer.from(rows.buffer, rows.byteOffset + i * dim * 4, dim * 4).toString('latin1');
    if (seen.has(k)) dup++;
    else seen.add(k);
  }
  return dup;
}

function t2Pack(name: string, dim: number, rows: Float32Array[], queries: Float32Array): DataSet {
  const flat = new Float32Array(rows.length * dim);
  rows.forEach((v, i) => flat.set(v, i * dim));
  return { name, dim, rows: flat, queries, maxGroup: 0, dupRows: countDupRows(flat, dim) };
}

/** T2's `--neardup-gap` set: seed 9,000,000 + seed * 101 + perGroup. Variants repeat, so exact copies exist too. */
function t2Gap(dim: number, perGroup: number, seed: number): DataSet {
  const r = new T2Rng(BigInt(9_000_000 + seed * 101 + perGroup));
  const base = t2CentresPoints(r, dim, 30, 5, 0.3);
  const rows: Float32Array[] = [];
  for (const b of base)
    for (let c = 0; c < perGroup; c++) {
      const v = b.slice();
      const j = r.below(dim);
      const ulps = 1 + r.below(3);
      new Uint32Array(v.buffer)[j]! += ulps;
      rows.push(v);
    }
  t2Shuffle(r, rows);
  return t2Pack(
    `T2 near-dup gap 30 x ${perGroup}, dim ${dim}, seed ${seed}`,
    dim,
    rows,
    t2Queries(r, base, dim),
  );
}

/** T2's `--neardup-unique` set: seed 12,000,000 + seed. Every row distinct (no byte-identical pair). */
function t2Unique(dim: number, perGroup: number, seed: number): DataSet {
  const r = new T2Rng(BigInt(12_000_000 + seed));
  const base = t2CentresPoints(r, dim, 30, 5, 0.3);
  const rows: Float32Array[] = [];
  for (const b of base)
    for (let c = 0; c < perGroup; c++) {
      const v = b.slice();
      const u = new Uint32Array(v.buffer);
      const j1 = c % dim;
      const j2 = (Math.floor(c / dim) + 7 * c + 1) % dim;
      u[j1]! += 1 + (c % 3);
      if (j2 !== j1) u[j2]! += (1 + (Math.floor(c / 3) % 3)) * (Math.floor(c / dim) + 1);
      rows.push(v);
    }
  t2Shuffle(r, rows);
  return t2Pack(
    `T2 all-distinct tight clusters 30 x ${perGroup}, dim ${dim}, seed ${seed}`,
    dim,
    rows,
    t2Queries(r, base, dim),
  );
}

/** A vector whose every component sits mid-bucket of the near key (low twelve bits 0x800): a few ulps never cross an edge. */
function midBucket(v: Float32Array): Float32Array {
  const out = v.slice();
  const u = new Uint32Array(out.buffer);
  for (let i = 0; i < u.length; i++) u[i] = ((u[i]! & 0xfffff000) | 0x800) >>> 0;
  return out;
}

const rowsOf = (d: DataSet) =>
  Array.from({ length: d.rows.length / d.dim }, (_, i) => ({
    key: `r${String(i).padStart(6, '0')}`,
    vector: slice(d.rows, i, d.dim),
  }));

async function store(events: Event[] = [], driver = new MemoryDriver(), opts = {}) {
  const s = await createStore({ driver, events: { emit: (e) => void events.push(e) }, ...opts });
  open.push(s);
  return s;
}

const scoreBits = (hits: Array<{ score: number }>) =>
  hits.map((h) => f32Bits(h.score)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

interface Measured {
  equal: number;
  recall: number;
  fallbacks: Record<string, number>;
}

async function measure(s: LocalData, ns: string, d: DataSet, events: Event[]): Promise<Measured> {
  let equal = 0;
  let total = 0;
  const fallbacks: Record<string, number> = {};
  for (let i = 0; i < QUERIES; i++) {
    const q = slice(d.queries, i, d.dim);
    const flat = await s.query(ns, q, 10, { values: false });
    events.length = 0;
    const ann = await s.query(ns, q, 10, { values: false, index: 'hnsw', ef: 64 });
    const e = events.filter((x) => x.name === 'storage.query').at(-1)!;
    const fb = String(e.attrs['fallback']);
    fallbacks[fb || 'graph'] = (fallbacks[fb || 'graph'] ?? 0) + 1;
    expect(['', 'duplicates', 'short'], 'a known fallback').toContain(fb);
    // descending, both: a multiset of the best ten scores
    const fa = scoreBits(flat);
    const aa = scoreBits(ann);
    if (aa.length === fa.length && aa.every((x, k) => x === fa[k])) equal++;
    const kth = flat.at(-1)!.score;
    total += ann.filter((h) => h.score >= kth).length / Math.max(1, flat.length);
  }
  return { equal, recall: total / QUERIES, fallbacks };
}

async function check(
  d: DataSet,
  params:
    typeof PARAMS | { kind: 'hnsw'; m: number; efConstruction: number; seed: number } = PARAMS,
) {
  const events: Event[] = [];
  const s = await store(events);
  await s.putVectors(NS, rowsOf(d));
  await s.buildIndex(NS, params);
  const build = events.filter((e) => e.name === 'storage.index.build').at(-1)!;
  expect(build.attrs['duplicateRows'], `${d.name}: duplicateRows`).toBe(d.dupRows);
  const m = await measure(s, NS, d, events);
  console.log(
    `ANNDUP [${d.name}] m ${params.m} efc ${params.efConstruction}: equal ${m.equal}/${QUERIES} mean-recall ${m.recall.toFixed(4)} answered by ${JSON.stringify(m.fallbacks)}`,
  );
  expect(m.equal, `${d.name}: queries with the flat top-10 scores`).toBeGreaterThanOrEqual(
    MIN_EQUAL,
  );
  expect(m.recall, `${d.name}: mean recall@10 by score`).toBeGreaterThanOrEqual(MIN_RECALL);
  return m;
}

describe('duplicate-heavy data through the Storage API: the floors hold (TD-109)', () => {
  it('T2 shape (uniform, dim 8 and 32) and clustered boilerplate sets at 10, 50 and 500 copies', async () => {
    for (const [i, copies] of [10, 50, 500].entries()) {
      await check(uniformProbe(8, 5, copies, 100, 100 + i), {
        kind: 'hnsw',
        m: 8,
        efConstruction: 60,
        seed: 1,
      });
      await check(boilerplate(32, 5, copies, 100, 200 + i));
      await check(boilerplate(384, 5, copies, 100, 300 + i));
    }
  }, 300_000);

  it('1000 base vectors x 10 copies, one vector x 1000 among 1000 distinct, and every row identical (dims 32 and 384)', async () => {
    for (const dim of [32, 384]) {
      await check(boilerplate(dim, 1000, 10, 0, 400 + dim));
      const one = boilerplate(dim, 1, 1000, 1000, 500 + dim);
      await check(one);
      await check(boilerplate(dim, 1, 1000, 0, 600 + dim));
    }
  }, 600_000);

  it('one-ulp near-duplicates (no byte-identical rows): duplicateRows is 0, and the graph answers', async () => {
    for (const dim of [32, 384]) {
      const m = await check(nearDuplicates(dim, 50, 20, 700 + dim));
      expect(m.fallbacks['graph'] ?? 0, 'near-duplicates are not degenerate').toBe(QUERIES);
    }
  }, 300_000);

  it('a group of copies larger than 2m makes the graph degenerate: fallback duplicates on every query, and the flat answer', async () => {
    const d = boilerplate(32, 5, 500, 100, 800);
    const events: Event[] = [];
    const s = await store(events);
    await s.putVectors(NS, rowsOf(d));
    await s.buildIndex(NS, PARAMS);
    const q = slice(d.queries, 3, d.dim);
    const flat = await s.query(NS, q, 10, { values: false });
    events.length = 0;
    const ann = await s.query(NS, q, 10, { values: false, index: 'hnsw' });
    expect(ann.map((h) => [h.key, f32Bits(h.score)])).toEqual(
      flat.map((h) => [h.key, f32Bits(h.score)]),
    );
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs).toMatchObject({
      requested: 'hnsw',
      index: 'flat',
      fallback: 'duplicates',
      ef: null,
    });
    // below the limit the same data answers from the graph
    const small = boilerplate(32, 5, 30, 100, 801);
    const s2 = await store(events);
    await s2.putVectors(NS, rowsOf(small));
    await s2.buildIndex(NS, PARAMS);
    events.length = 0;
    await s2.query(NS, slice(small.queries, 0, 32), 10, { index: 'hnsw' });
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs).toMatchObject({
      index: 'hnsw',
      fallback: '',
    });
  }, 300_000);
});

describe('tight clusters of near-identical vectors: the floors hold, or the flat scan answers (BUG-T2-S7-02, TD-126)', () => {
  it('T2 gap set (30 x 500, dim 384, seed 13) and T2 all-distinct set (30 x 500, dim 384, seed 4): flat answers on every query, equal to flat', async () => {
    for (const d of [t2Gap(384, 500, 13), t2Unique(384, 500, 4)]) {
      const m = await check(d);
      expect(
        m.fallbacks['duplicates'] ?? 0,
        `${d.name}: answered by the flat scan on every query`,
      ).toBe(QUERIES);
    }
  }, 900_000);

  it('the same shapes at dim 32 meet the floors whichever path answers', async () => {
    await check(t2Gap(32, 500, 13));
    await check(t2Unique(32, 500, 5));
  }, 300_000);

  it('a near-duplicate group that grows through puts degenerates the graph at 2m + 1 members, and removing it and rebuilding restores the graph', async () => {
    const dim = 32;
    const events: Event[] = [];
    const s = await store(events);
    const rest = boilerplate(dim, 1, 1, 400, 1100);
    const anchor = midBucket(slice(rest.rows, 0, dim));
    const variant = (k: number) => {
      const v = anchor.slice();
      new Uint32Array(v.buffer)[k]! += 1;
      return v;
    };
    // the anchor stands in for row 0, whose own bucket it shares: row 0 is left out so the group is only the anchor's
    await s.putVectors(NS, [{ key: 'anchor', vector: anchor }, ...rowsOf(rest).slice(1)]);
    await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 20, seed: 1 });
    const q = slice(rest.queries, 0, dim);
    const fallback = async () => {
      events.length = 0;
      await s.query(NS, q, 10, { index: 'hnsw' });
      return events.filter((e) => e.name === 'storage.query').at(-1)!.attrs['fallback'];
    };
    expect(await fallback(), 'before the group').toBe('');
    // 15 distinct one-ulp variants: with the anchor a group of 16 = 2m (m 8): still the graph
    await s.putVectors(
      NS,
      Array.from({ length: 15 }, (_, k) => ({ key: `v${k}`, vector: variant(k) })),
    );
    expect(await fallback(), 'a group of 16 = 2m').toBe('');
    await s.putVectors(
      NS,
      Array.from({ length: 5 }, (_, k) => ({ key: `v${15 + k}`, vector: variant(15 + k) })),
    );
    expect(await fallback(), 'a group of 21 > 2m, none of them byte-identical').toBe('duplicates');
    const ann = await s.query(NS, q, 10, { values: false, index: 'hnsw' });
    const flat = await s.query(NS, q, 10, { values: false });
    expect(ann.map((h) => [h.key, f32Bits(h.score)])).toEqual(
      flat.map((h) => [h.key, f32Bits(h.score)]),
    );
    for (let k = 0; k < 20; k++) await s.delete(NS, `v${k}`);
    await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 20, seed: 1 });
    expect(await fallback(), 'rebuilt without the group').toBe('');
  }, 120_000);

  it('the decision is stored in the graph record: a later session answers flat with fallback duplicates, and the open event is clean', async () => {
    const d = t2Gap(32, 200, 13);
    const driver = new MemoryDriver();
    const s1 = await createStore({ driver });
    await s1.putVectors(NS, rowsOf(d));
    await s1.buildIndex(NS, PARAMS);
    await s1.close();
    await driver.open();
    const events: Event[] = [];
    const s2 = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
    open.push(s2);
    const q = slice(d.queries, 0, 32);
    const flat = await s2.query(NS, q, 10, { values: false });
    events.length = 0;
    const ann = await s2.query(NS, q, 10, { values: false, index: 'hnsw' });
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs).toMatchObject({
      index: 'flat',
      fallback: 'duplicates',
    });
    expect(
      events
        .filter((e) => e.name === 'storage.index.open' && e.attrs['kind'] === 'hnsw')
        .map((e) => e.attrs['outcome']),
      'the graph loaded fine (it was not refused)',
    ).toEqual(['ok']);
    expect(ann.map((h) => [h.key, f32Bits(h.score)])).toEqual(
      flat.map((h) => [h.key, f32Bits(h.score)]),
    );
  }, 120_000);
});

describe('duplicateRows on storage.index.build counts live rows only', () => {
  it('395 for 5 groups of 80 over 100 distinct rows; 385 after ten live copies are deleted; every build event is a valid event', async () => {
    const d = boilerplate(32, 5, 80, 100, 900);
    const events: Event[] = [];
    const s = await store(events);
    await s.putVectors(NS, rowsOf(d));
    await s.buildIndex(NS, PARAMS);
    expect(
      events.filter((e) => e.name === 'storage.index.build').at(-1)!.attrs['duplicateRows'],
    ).toBe(395);
    // ten copies of the first group go (they are rows r000000 .. r000009)
    for (let i = 0; i < 10; i++)
      expect(await s.delete(NS, `r${String(i).padStart(6, '0')}`)).toBe(true);
    await s.buildIndex(NS, PARAMS);
    const last = events.filter((e) => e.name === 'storage.index.build').at(-1)!;
    expect(last.attrs['duplicateRows'], 'live rows only').toBe(385);
    expect(last.attrs['liveRows']).toBe(d.rows.length / d.dim - 10);
    for (const e of events) expect(eventProblems(e), JSON.stringify(e)).toEqual([]);
  }, 120_000);

  it('rows that differ only in the sign of zero are not duplicates', async () => {
    const dim = 8;
    const events: Event[] = [];
    const s = await store(events);
    const a = new Float32Array(dim).fill(0.5);
    a[3] = 0;
    const b = a.slice();
    b[3] = -0;
    await s.putVectors(NS, [
      { key: 'a', vector: a },
      { key: 'b', vector: b },
      { key: 'c', vector: a.slice() },
    ]);
    await s.buildIndex(NS, { kind: 'hnsw', m: 4, efConstruction: 8, seed: 1 });
    expect(
      events.filter((e) => e.name === 'storage.index.build').at(-1)!.attrs['duplicateRows'],
    ).toBe(1);
  });

  it('an empty namespace builds with duplicateRows 0', async () => {
    const events: Event[] = [];
    const s = await store(events);
    await s.buildIndex('nothing', PARAMS);
    expect(
      events.filter((e) => e.name === 'storage.index.build').at(-1)!.attrs['duplicateRows'],
    ).toBe(0);
  });
});

describe('a put recounts the largest group of copies', () => {
  it('a graph that becomes degenerate through puts answers flat with fallback duplicates, and buildIndex after removing them restores the graph', async () => {
    const dim = 32;
    const events: Event[] = [];
    const s = await store(events);
    const base = boilerplate(dim, 1, 1, 400, 1000);
    await s.putVectors(NS, rowsOf(base));
    await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 20, seed: 1 });
    const q = slice(base.queries, 0, dim);
    events.length = 0;
    await s.query(NS, q, 10, { index: 'hnsw' });
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs['fallback']).toBe('');
    // 25 copies of one vector arrive in two puts (a group of 26 with the original, more than 2m = 16)
    const one = slice(base.rows, 0, dim);
    const copies = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `copy${from + i}`, vector: one.slice() }));
    await s.putVectors(NS, copies(0, 15));
    events.length = 0;
    await s.query(NS, q, 10, { index: 'hnsw' });
    expect(
      events.filter((e) => e.name === 'storage.query').at(-1)!.attrs['fallback'],
      '16 copies: still fine',
    ).toBe('');
    await s.putVectors(NS, copies(15, 10));
    events.length = 0;
    const ann = await s.query(NS, q, 10, { values: false, index: 'hnsw' });
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs).toMatchObject({
      index: 'flat',
      fallback: 'duplicates',
    });
    const flat = await s.query(NS, q, 10, { values: false });
    expect(ann.map((h) => [h.key, f32Bits(h.score)])).toEqual(
      flat.map((h) => [h.key, f32Bits(h.score)]),
    );
    // the copies go, a fresh build is not degenerate any more
    for (let i = 0; i < 25; i++) await s.delete(NS, `copy${i}`);
    await s.buildIndex(NS, { kind: 'hnsw', m: 8, efConstruction: 20, seed: 1 });
    events.length = 0;
    await s.query(NS, q, 10, { index: 'hnsw' });
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs['fallback']).toBe('');
  }, 120_000);
});

// ---- the first graph format --------------------------------------------------------------------------------

const D = 24;
const N = 300;
const ROWS = (() => {
  const c = clusteredSet(31, 8, D, N, 10);
  return { rows: c.rows, queries: c.queries };
})();
const key = (i: number) => `k${String(i).padStart(4, '0')}`;
const V1_PARAMS = { kind: 'hnsw', m: 12, efConstruction: 80, seed: 5 } as const;

async function committed(): Promise<MemoryDriver> {
  const driver = new MemoryDriver();
  const s = await createStore({ driver });
  await s.putVectors(
    NS,
    Array.from({ length: N }, (_, i) => ({ key: key(i), vector: slice(ROWS.rows, i, D) })),
  );
  await s.buildIndex(NS, V1_PARAMS);
  await s.close();
  await driver.open();
  return driver;
}

const graphOf = async (d: MemoryDriver) => (await d.getBytes(ANN, 'graph'))!.bytes.slice();
const putGraph = (d: MemoryDriver, b: Uint8Array) => d.put(ANN, 'graph', b, { size: b.length });

/** A graph of the first format: magic LDHNSW01 and version 1, CRC refreshed (the Sprint 6 kernel's header). */
function asV1(g: Uint8Array): Uint8Array {
  const out = g.slice();
  out.set(new TextEncoder().encode('LDHNSW01'), 0);
  new DataView(out.buffer).setUint16(8, 1, true);
  new DataView(out.buffer).setUint32(out.length - 4, crc32c(out.subarray(0, out.length - 4)), true);
  return out;
}

async function clone(src: MemoryDriver): Promise<MemoryDriver> {
  const dst = new MemoryDriver();
  await dst.open();
  for (const ns of await src.namespaces())
    for (const k of await src.keys(ns)) {
      const rec = await src.getBytes(ns, k);
      await dst.put(ns, k, rec!.bytes, rec!.meta);
    }
  return dst;
}

const builds = (ev: Event[]) => ev.filter((e) => e.name === 'storage.index.build');
const opens = (ev: Event[]) =>
  ev.filter((e) => e.name === 'storage.index.open' && e.attrs['kind'] === 'hnsw');
const ask = (s: LocalData, j = 0) =>
  s.query(NS, slice(ROWS.queries, j, D), 10, { index: 'hnsw', ef: 64, values: false });

describe('a graph file of the first format is refused with reason version and rebuilt once per generation', () => {
  it('refused (reason version), rebuilt from the stored vectors to the same bytes as a fresh build, marker persisted', async () => {
    const fresh = await committed();
    const freshBytes = await graphOf(fresh);
    const d = await clone(fresh);
    await putGraph(d, asV1(freshBytes));
    const events: Event[] = [];
    const s = await createStore({ driver: d, events: { emit: (e) => void events.push(e) } });
    open.push(s);
    const hits = await ask(s);
    expect(opens(events).map((e) => [e.attrs['outcome'], e.attrs['reason']])).toEqual([
      ['corrupt', 'version'],
    ]);
    expect(builds(events).map((e) => [e.attrs['reason'], e.attrs['outcome']])).toEqual([
      ['rebuild', 'ok'],
    ]);
    expect(annStats(s, NS).rebuilds).toBe(1);
    // the rebuilt graph is the fresh build, byte for byte, and answers exactly as a fresh store does
    expect(Buffer.from(await graphOf(d)).equals(Buffer.from(freshBytes))).toBe(true);
    const ref = await createStore({ driver: fresh });
    open.push(ref);
    expect((await ask(ref)).map((h) => [h.key, f32Bits(h.score)])).toEqual(
      hits.map((h) => [h.key, f32Bits(h.score)]),
    );
    // the persisted marker names the HEAD generation
    const marker = await d.getBytes(ANN, REBUILT_KEY);
    expect(marker).toBeDefined();
    expect(decodeRebuilt(marker!.bytes)).toBe((await s.indexInfo(NS))!.generation);
    // and it is part of the namespace's accounted bytes
    const usage = await s.usage();
    expect(usage.bytes).toBe(usage.vectorBytes! + usage.annBytes!);
  });

  it('refused again at the same generation in a LATER session: not rebuilt a second time, the index is dropped and flat answers', async () => {
    const fresh = await committed();
    const d = await clone(fresh);
    await putGraph(d, asV1(await graphOf(fresh)));
    const e1: Event[] = [];
    const s1 = await createStore({ driver: d, events: { emit: (e) => void e1.push(e) } });
    await ask(s1);
    expect(builds(e1)).toHaveLength(1);
    await s1.close();
    await d.open();
    // the graph is damaged again, at the same generation (an older build of the SDK wrote it)
    await putGraph(d, asV1(await graphOf(d)));
    const e2: Event[] = [];
    const s2 = await createStore({ driver: d, events: { emit: (e) => void e2.push(e) } });
    open.push(s2);
    const flat = await s2.query(NS, slice(ROWS.queries, 0, D), 10, { values: false });
    e2.length = 0;
    const hits = await ask(s2);
    expect(
      builds(e2).filter((e) => e.attrs['reason'] === 'rebuild'),
      'no second rebuild',
    ).toEqual([]);
    expect(annStats(s2, NS).rebuilds).toBe(0);
    expect(hits.map((h) => [h.key, f32Bits(h.score)])).toEqual(
      flat.map((h) => [h.key, f32Bits(h.score)]),
    );
    expect(e2.filter((e) => e.name === 'storage.query').at(-1)!.attrs).toMatchObject({
      index: 'flat',
      fallback: 'refused',
    });
    expect(await d.keys(ANN)).toEqual([]);
  });

  it('a new generation allows a new rebuild: put, damage, query', async () => {
    const fresh = await committed();
    const d = await clone(fresh);
    await putGraph(d, asV1(await graphOf(fresh)));
    const s1 = await createStore({ driver: d });
    await ask(s1);
    await s1.putVectors(NS, [{ key: 'extra', vector: slice(ROWS.rows, 0, D) }]); // generation + 1
    await s1.close();
    await d.open();
    await putGraph(d, asV1(await graphOf(d)));
    const events: Event[] = [];
    const s2 = await createStore({ driver: d, events: { emit: (e) => void events.push(e) } });
    open.push(s2);
    await ask(s2);
    expect(builds(events).map((e) => [e.attrs['reason'], e.attrs['outcome']])).toEqual([
      ['rebuild', 'ok'],
    ]);
  });

  it('the rebuild goes through the soft quota: refused, the index dropped, the build event says quota_exceeded', async () => {
    const fresh = await committed();
    const probe = await createStore({ driver: fresh });
    const used = (await probe.usage()).bytes;
    await probe.close();
    await fresh.open();
    const d = await clone(fresh);
    await putGraph(d, asV1(await graphOf(fresh)));
    const events: Event[] = [];
    const s = await createStore({
      driver: d,
      quotaBytes: used - 1,
      events: { emit: (e) => void events.push(e) },
    });
    open.push(s);
    const flat = await s.query(NS, slice(ROWS.queries, 0, D), 10, { values: false });
    events.length = 0;
    const hits = await ask(s);
    expect(hits.map((h) => h.key)).toEqual(flat.map((h) => h.key));
    const b = builds(events);
    expect(b).toHaveLength(1);
    expect(b[0]!.attrs).toMatchObject({ reason: 'rebuild', outcome: 'quota_exceeded' });
    expect(events.filter((e) => e.name === 'storage.query').at(-1)!.attrs).toMatchObject({
      index: 'flat',
      fallback: 'refused',
    });
    expect(await d.keys(ANN)).toEqual([]);
  });

  it('the rebuild goes through maxIndexBytes: refused, the index dropped, the build event says quota_exceeded', async () => {
    const fresh = await committed();
    const flatBytes = await (async () => {
      const p = await createStore({ driver: fresh });
      const u = await p.usage();
      await p.close();
      await fresh.open();
      return u.vectorBytes!;
    })();
    const g = await graphOf(fresh);
    const d = await clone(fresh);
    await putGraph(d, asV1(g));
    const events: Event[] = [];
    // room to read the flat index and the stored graph, but not for flat + graph + params + marker
    const s = await createStore({
      driver: d,
      maxIndexBytes: flatBytes + g.length - 1000,
      events: { emit: (e) => void events.push(e) },
    });
    open.push(s);
    events.length = 0;
    const hits = await ask(s);
    expect(hits).toHaveLength(10);
    expect(builds(events).map((e) => [e.attrs['reason'], e.attrs['outcome']])).toEqual([
      ['rebuild', 'quota_exceeded'],
    ]);
    expect(await d.keys(ANN)).toEqual([]);
  });
});

const setWords = (g: Uint8Array, words: Record<number, number>): Uint8Array => {
  const out = g.slice();
  const dv = new DataView(out.buffer);
  for (const [off, v] of Object.entries(words)) dv.setUint32(Number(off), v, true);
  dv.setUint32(out.length - 4, crc32c(out.subarray(0, out.length - 4)), true);
  return out;
};
const fallbackOf = (ev: Event[]) => ev.filter((e) => e.name === 'storage.query').at(-1)!.attrs;

describe('a forged RAISED degenerate statistic can only force the exact flat path', () => {
  it('raising the exact and near counts (header words 52 and 56) of a healthy graph above 2m: flat answers, equal to flat, fallback duplicates', async () => {
    const fresh = await committed();
    const forged = setWords(await graphOf(fresh), { 52: N, 56: N }); // the whole graph "is one group of copies"
    const d = await clone(fresh);
    await putGraph(d, forged);
    const events: Event[] = [];
    const s = await createStore({ driver: d, events: { emit: (e) => void events.push(e) } });
    open.push(s);
    for (let j = 0; j < 10; j++) {
      const flat = await s.query(NS, slice(ROWS.queries, j, D), 10, { values: false });
      events.length = 0;
      const ann = await ask(s, j);
      expect(ann.map((h) => [h.key, f32Bits(h.score)])).toEqual(
        flat.map((h) => [h.key, f32Bits(h.score)]),
      );
      expect(fallbackOf(events)).toMatchObject({ index: 'flat', fallback: 'duplicates' });
    }
  });

  it('raising only the near count (word 56) is consistent and forces the flat path too; a near count above the node count, or below the exact count, is a refused graph (reason bounds)', async () => {
    const fresh = await committed();
    const g = await graphOf(fresh);
    const only = await clone(fresh);
    await putGraph(only, setWords(g, { 56: N }));
    const ev1: Event[] = [];
    const s1 = await createStore({ driver: only, events: { emit: (e) => void ev1.push(e) } });
    open.push(s1);
    await ask(s1);
    expect(fallbackOf(ev1)).toMatchObject({ index: 'flat', fallback: 'duplicates' });
    for (const [name, words] of [
      ['exact count above the node count', { 52: N + 1 }],
      ['near count above the node count', { 56: N + 1 }],
      ['near count below the exact count', { 52: 5, 56: 4 }],
    ] as const) {
      const bad = await clone(fresh);
      await putGraph(bad, setWords(g, words));
      const ev: Event[] = [];
      const s = await createStore({ driver: bad, events: { emit: (e) => void ev.push(e) } });
      open.push(s);
      await ask(s);
      expect(
        opens(ev).map((e) => e.attrs['reason']),
        name,
      ).toEqual(['bounds']);
    }
  });
});

describe('a forged LOWERED degenerate statistic suppresses the fallback and can only cost recall (BUG-T2-S7-03, S1-134, TD-127)', () => {
  it("lowering both counts of a degenerate graph to 1: the graph answers (fallback empty), and every hit it returns carries the flat scan's score for that key", async () => {
    const dim = 32;
    const d = t2Gap(dim, 200, 13); // degenerate: groups of 200 near-identical rows
    const driver = new MemoryDriver();
    const s0 = await createStore({ driver });
    await s0.putVectors(NS, rowsOf(d));
    await s0.buildIndex(NS, PARAMS);
    await s0.close();
    await driver.open();
    const g = await graphOf(driver);
    expect(new DataView(g.buffer).getUint32(56, true), 'the stored near count').toBeGreaterThan(32);
    const events: Event[] = [];
    // honest: flat answers
    const honest = await createStore({
      driver: await clone(driver),
      events: { emit: (e) => void events.push(e) },
    });
    open.push(honest);
    await honest.query(NS, slice(d.queries, 0, dim), 10, { index: 'hnsw' });
    expect(fallbackOf(events)).toMatchObject({ index: 'flat', fallback: 'duplicates' });
    // forged: the statistic is not recounted at load, so the graph answers
    const forgedDriver = await clone(driver);
    await putGraph(forgedDriver, setWords(g, { 52: 1, 56: 1 }));
    const ev2: Event[] = [];
    const forged = await createStore({
      driver: forgedDriver,
      events: { emit: (e) => void ev2.push(e) },
    });
    open.push(forged);
    const total = d.rows.length / dim;
    for (let j = 0; j < 20; j++) {
      const q = slice(d.queries, j, dim);
      const all = await forged.query(NS, q, total, { values: false }); // flat, every row
      const score = new Map(all.map((h) => [h.key, f32Bits(h.score)]));
      ev2.length = 0;
      const ann = await forged.query(NS, q, 10, { values: false, index: 'hnsw', ef: 64 });
      expect(fallbackOf(ev2)).toMatchObject({ index: 'hnsw', fallback: '' });
      expect(ann.length).toBe(10);
      for (const h of ann) expect(f32Bits(h.score), `score of ${h.key}`).toBe(score.get(h.key));
    }
  }, 300_000);
});

describe('a degenerate count that is not an integer count of this graph is a refused graph', () => {
  it('a header whose exact count is above the node count is refused (reason bounds) and rebuilt', async () => {
    const fresh = await committed();
    const d2 = await clone(fresh);
    await putGraph(d2, setWords(await graphOf(fresh), { 52: N + 1 }));
    const ev2: Event[] = [];
    const s2 = await createStore({ driver: d2, events: { emit: (e) => void ev2.push(e) } });
    open.push(s2);
    await ask(s2);
    expect(opens(ev2).map((e) => e.attrs['reason'])).toEqual(['bounds']);
  });
});
