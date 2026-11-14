// D4-03: structure that only shows at size: segments cut at 131,072 rows, indexes spread over several
// 8 MiB vector parts, values that cross 1 MiB part boundaries, in-place extension of a resident index,
// the 4,096-segment limit, and concurrent writers inside one store.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, type LocalData } from '../src/index';
import { f32Bits, topKRef } from '../src/vec/reference';
import { DIM, synthKey, synthQuery, synthRow, synthRows, synthVector } from '../bench/synth';

const NS = 'big';
const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

async function make(driver = new MemoryDriver(), extra: Record<string, unknown> = {}) {
  const s = await createStore({ driver, ...extra } as Parameters<typeof createStore>[0]);
  open.push(s);
  return { store: s, driver };
}

class CountingDriver extends MemoryDriver {
  reads = new Map<string, number>();
  override async getBytes(...a: Parameters<MemoryDriver['getBytes']>) {
    const k = `${a[0]}/${a[1]}`;
    this.reads.set(k, (this.reads.get(k) ?? 0) + 1);
    return super.getBytes(...a);
  }
  vecReads(): number {
    let n = 0;
    for (const [k, c] of this.reads) if (k.includes('/vec-')) n += c;
    return n;
  }
}

describe('size', () => {
  it('131,073 rows are cut into two segments and answer exactly', async () => {
    const { store, driver } = await make();
    const dim = 4;
    const res = await store.putVectors(NS, synthRows(0, 131_073, { dim }));
    expect(res).toEqual({ written: 131_073, replaced: 0, rows: 131_073 });
    const info = await store.indexInfo(NS);
    expect(info?.segments).toBe(2);
    expect(info?.totalRows).toBe(131_073);
    const names = await driver.keys('__ld_vec.big');
    expect(names.filter((n) => n.startsWith('vec-0/')).length).toBe(1);
    expect(names.filter((n) => n.startsWith('vec-1/')).length).toBe(1);
    // exact answer around the segment boundary, against the reference over the rows involved
    const q = synthQuery(1, dim);
    const hits = await store.query(NS, q, 10);
    const rows = [];
    for (let i = 0; i < 131_073; i++) rows.push({ key: synthKey(i), vector: synthVector(i, dim) });
    const want = topKRef(rows, q, 10, 'cosine');
    expect(hits.map((h) => h.key)).toEqual(want.map((h) => h.key));
    expect(hits.map((h) => f32Bits(h.score))).toEqual(want.map((h) => f32Bits(h.score)));
    // a key in the second segment (the last row) can be found and deleted
    const last = await store.query(NS, synthVector(131_072, dim), 1);
    expect(last[0]?.key).toBe(synthKey(131_072));
    expect(await store.delete(NS, synthKey(131_072))).toBe(true);
    expect((await store.query(NS, synthVector(131_072, dim), 1))[0]?.key).not.toBe(
      synthKey(131_072),
    );
  }, 120_000);

  it('12,000 rows at dim 384 span three 8 MiB vector parts and match the reference', async () => {
    const { store, driver } = await make();
    await store.putVectors(NS, synthRows(0, 12_000));
    const names = await driver.keys('__ld_vec.big');
    expect(names.filter((n) => n.startsWith('vec-0/')).sort()).toEqual([
      'vec-0/00000',
      'vec-0/00001',
      'vec-0/00002',
    ]);
    const rows = [];
    for (let i = 0; i < 12_000; i++) rows.push({ key: synthKey(i), vector: synthVector(i) });
    for (const metric of ['cosine', 'dot'] as const) {
      const q = synthQuery(5);
      const want = topKRef(rows, q, 50, metric);
      const hits = await store.query(NS, q, 50, { metric });
      expect(hits.map((h) => h.key)).toEqual(want.map((h) => h.key));
      expect(hits.map((h) => f32Bits(h.score))).toEqual(want.map((h) => f32Bits(h.score)));
    }
    // rows from the first, middle and last part are all reachable by their own vector
    for (const i of [0, 5460, 5461, 10_921, 11_999]) {
      expect((await store.query(NS, synthVector(i), 1))[0]?.key).toBe(synthKey(i));
    }
  }, 120_000);

  it('values that cross 1 MiB part boundaries round-trip, and the part cache handles more than 16 parts', async () => {
    const { store, driver } = await make();
    const big = (n: number, seed: number) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
      return b;
    };
    const rows = [];
    for (let i = 0; i < 40; i++) {
      rows.push({
        key: synthKey(i),
        vector: synthVector(i, 8),
        value: big(600_000 + i * 1000, i),
      });
    }
    await store.putVectors(NS, rows);
    const parts = (await driver.keys('__ld_vec.big')).filter((n) => n.startsWith('val-0/'));
    expect(parts.length).toBeGreaterThan(20);
    const hits = await store.query(NS, synthVector(7, 8), 40);
    expect(hits.length).toBe(40);
    for (const h of hits) {
      const i = Number(h.key.slice(6));
      expect(h.value).toEqual(big(600_000 + i * 1000, i));
    }
  }, 120_000);
});

describe('extending a resident index in place', () => {
  it('an append after a query is visible without re-reading any vector part, and stays exact', async () => {
    const driver = new CountingDriver();
    const { store } = await make(driver);
    await store.putVectors(NS, synthRows(0, 3000, { dim: 32, chunkBytes: 30 }));
    const q = synthQuery(2, 32);
    await store.query(NS, q, 5); // loads the vectors
    const reads = driver.vecReads();
    expect(reads).toBeGreaterThan(0);
    await store.putVectors(NS, synthRows(3000, 500, { dim: 32, chunkBytes: 30 }));
    // overwrite some old rows too, and delete one
    await store.putVectors(NS, [{ ...synthRow(10, { dim: 32 }), vector: synthVector(9999, 32) }]);
    expect(await store.delete(NS, synthKey(11))).toBe(true);
    const hits = await store.query(NS, q, 25);
    expect(driver.vecReads(), 'no vector part was read again').toBe(reads);
    const live = [];
    for (let i = 0; i < 3500; i++) {
      if (i === 11) continue;
      live.push({ key: synthKey(i), vector: synthVector(i === 10 ? 9999 : i, 32) });
    }
    const want = topKRef(live, q, 25, 'cosine');
    expect(hits.map((h) => h.key)).toEqual(want.map((h) => h.key));
    expect(hits.map((h) => f32Bits(h.score))).toEqual(want.map((h) => f32Bits(h.score)));
    expect(hits.every((h) => typeof h.value === 'string' || h.key === synthKey(10))).toBe(true);
    // and a fresh store over the same driver sees exactly the same
    await store.close();
    await driver.open();
    const { store: again } = await make(driver);
    const hits2 = await again.query(NS, q, 25);
    expect(hits2.map((h) => h.key)).toEqual(hits.map((h) => h.key));
    expect(hits2.map((h) => f32Bits(h.score))).toEqual(hits.map((h) => f32Bits(h.score)));
    expect((await again.indexInfo(NS))?.rows).toBe(3499);
  });

  it('five concurrent putVectors calls on one namespace all commit, none corrupts', async () => {
    const { store } = await make();
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((n) => store.putVectors(NS, synthRows(n * 100, 100, { dim: 8 }))),
    );
    expect(results.map((r) => r.written)).toEqual([100, 100, 100, 100, 100]);
    expect((await store.indexInfo(NS))?.rows).toBe(500);
    expect((await store.indexInfo(NS))?.generation).toBe(5);
    expect((await store.query(NS, synthVector(321, 8), 1))[0]?.key).toBe(synthKey(321));
  });

  it('concurrent queries during a write see a consistent index', async () => {
    const { store } = await make();
    await store.putVectors(NS, synthRows(0, 500, { dim: 8 }));
    const q = synthVector(1, 8);
    const [a, , b] = await Promise.all([
      store.query(NS, q, 5),
      store.putVectors(NS, synthRows(500, 500, { dim: 8 })),
      store.query(NS, q, 5),
    ]);
    expect(a.length).toBe(5);
    expect(b.length).toBe(5);
    expect((await store.indexInfo(NS))?.rows).toBe(1000);
  });
});

describe('limits', () => {
  it('the 4,097th segment is refused with quota_exceeded max_segments and the index is untouched', async () => {
    const { store } = await make();
    await store.putVectors(NS, [synthRow(0, { dim: 2 })]);
    await store.query(NS, synthVector(0, 2), 1); // resident, so each append extends it in place
    for (let i = 1; i < 4096; i++) await store.putVectors(NS, [synthRow(i, { dim: 2 })]);
    expect((await store.indexInfo(NS))?.segments).toBe(4096);
    await expect(store.putVectors(NS, [synthRow(5000, { dim: 2 })])).rejects.toMatchObject({
      code: 'quota_exceeded',
      details: { reason: 'max_segments' },
    });
    expect((await store.indexInfo(NS))?.rows).toBe(4096);
    expect((await store.query(NS, synthVector(4095, 2), 1))[0]?.key).toBe(synthKey(4095));
    // an update that fits in no new segment is still impossible, but a delete is fine
    expect(await store.delete(NS, synthKey(1))).toBe(true);
  }, 300_000);

  it('DIM is 384 and the synthetic data is deterministic', () => {
    expect(DIM).toBe(384);
    expect([...synthVector(0).slice(0, 3)]).toEqual([...synthVector(0).slice(0, 3)]);
    expect(synthKey(7)).toBe('chunk-000007');
  });
});
