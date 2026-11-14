// D4-03: a write that fails part-way (soft quota, maxIndexBytes, the browser's QuotaExceededError on
// the k-th put) rejects with quota_exceeded, deletes what it wrote, and leaves the previous index
// readable with identical hits.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, type LocalData } from '../src/index';
import { Kernel } from '../src/vec/kernel';
import { synthQuery, synthRows } from '../bench/synth';
import { HEAD_FIELD, editHead, readRecord, vnsOf } from './forge';

const NS = 'docs';
const D = 16;

/** Throws the browser's QuotaExceededError on the k-th put into a vector namespace. */
class QuotaDriver extends MemoryDriver {
  failOnPut = 0; // 1-based count of vector puts; 0 = never
  seen = 0;
  override async put(...a: Parameters<MemoryDriver['put']>): Promise<void> {
    if (a[0].startsWith('__ld_vec.') && this.failOnPut > 0 && ++this.seen === this.failOnPut) {
      throw Object.assign(new Error('The quota has been exceeded.'), {
        name: 'QuotaExceededError',
      });
    }
    return super.put(...a);
  }
}

const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

async function snapshot(d: MemoryDriver): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const k of await d.keys(vnsOf(NS))) {
    const rec = await d.getBytes(vnsOf(NS), k);
    out.set(k, Buffer.from(rec!.bytes).toString('base64'));
  }
  return out;
}

async function hitsOf(s: LocalData) {
  return (await s.query(NS, synthQuery(0, D), 10)).map((h) => [h.key, h.score]);
}

describe('quota failures mid-putVectors leave the previous index intact', () => {
  it('QuotaExceededError on the k-th put, for every k: quota_exceeded, same records, same hits', async () => {
    const driver = new QuotaDriver();
    const store = await createStore({ driver });
    open.push(store);
    await store.putVectors(NS, synthRows(0, 60, { dim: D, chunkBytes: 40 }));
    const before = await hitsOf(store);
    const files = await snapshot(driver);
    // a call with values writes: vec part(s), val part, meta part and the HEAD: 4 puts
    for (let k = 1; k <= 4; k++) {
      driver.seen = 0;
      driver.failOnPut = k;
      await expect(
        store.putVectors(NS, synthRows(1000, 80, { dim: D, chunkBytes: 40 })),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
      driver.failOnPut = 0;
      expect(await snapshot(driver), `records after a failure on put ${k}`).toEqual(files);
      expect(await hitsOf(store), `hits after a failure on put ${k}`).toEqual(before);
    }
    // and the same index is still writable afterwards
    await store.putVectors(NS, synthRows(1000, 5, { dim: D }));
    expect((await store.indexInfo(NS))?.rows).toBe(65);
  });

  it('after a reload the previous index answers identically', async () => {
    const driver = new QuotaDriver();
    const a = await createStore({ driver });
    await a.putVectors(NS, synthRows(0, 60, { dim: D }));
    const before = await hitsOf(a);
    driver.failOnPut = 2;
    await expect(a.putVectors(NS, synthRows(1000, 80, { dim: D }))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await a.close();
    await driver.open();
    const b = await createStore({ driver });
    open.push(b);
    expect(await hitsOf(b)).toEqual(before);
  });

  it('a failure on the very first write leaves no index and no records', async () => {
    const driver = new QuotaDriver();
    const store = await createStore({ driver });
    open.push(store);
    driver.failOnPut = 2;
    await expect(store.putVectors(NS, synthRows(0, 10, { dim: D }))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(await store.indexInfo(NS)).toBeUndefined();
    expect((await snapshot(driver)).size).toBe(0);
  });

  it('the soft quota refuses before writing too much, with details, and keeps the index', async () => {
    const driver = new MemoryDriver();
    const store = await createStore({ driver, quotaBytes: 20_000 });
    open.push(store);
    await store.putVectors(NS, synthRows(0, 20, { dim: D }));
    const before = await hitsOf(store);
    const files = await snapshot(driver);
    const err = await store
      .putVectors(NS, synthRows(1000, 2000, { dim: D }))
      .catch((e: unknown) => e as { code: string; details: Record<string, unknown> });
    expect((err as { code: string }).code).toBe('quota_exceeded');
    expect((err as { details: Record<string, unknown> }).details['quotaBytes']).toBe(20_000);
    expect(await snapshot(driver)).toEqual(files);
    expect(await hitsOf(store)).toEqual(before);
    // KV writes still obey the same quota accounting, vectors included
    const u = await store.usage(NS);
    expect(u.bytes).toBe((u.vectorBytes ?? 0) + 0);
    await expect(store.set(NS, 'big', new Uint8Array(20_000))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
  });

  it('maxIndexBytes refuses with reason max_index_bytes, and the writer never makes an index the reader refuses', async () => {
    const driver = new MemoryDriver();
    const store = await createStore({ driver, maxIndexBytes: 30_000 });
    open.push(store);
    await store.putVectors(NS, synthRows(0, 20, { dim: D }));
    const before = await hitsOf(store);
    const files = await snapshot(driver);
    const err = await store
      .putVectors(NS, synthRows(1000, 2000, { dim: D }))
      .catch((e: unknown) => e as { code: string; details: Record<string, unknown> });
    expect((err as { code: string }).code).toBe('quota_exceeded');
    expect((err as { details: Record<string, unknown> }).details['reason']).toBe('max_index_bytes');
    expect(await snapshot(driver)).toEqual(files);
    expect(await hitsOf(store)).toEqual(before);
    // what the writer does accept, the reader accepts under the same cap
    await store.putVectors(NS, synthRows(100, 30, { dim: D }));
    await store.close();
    await driver.open();
    const again = await createStore({ driver, maxIndexBytes: 30_000 });
    open.push(again);
    expect((await again.query(NS, synthQuery(0, D), 5)).length).toBe(5);
  });
});

describe('limits', () => {
  it('a generation counter at the maximum is refused with reason generation, nothing is written', async () => {
    const driver = new MemoryDriver();
    const s = await createStore({ driver });
    await s.putVectors(NS, synthRows(0, 5, { dim: D }));
    await s.close();
    await driver.open();
    await editHead(driver, NS, (_h, dv) => dv.setUint32(HEAD_FIELD.generation, 0xfffffffe, true));
    const files = await snapshot(driver);
    const store = await createStore({ driver });
    open.push(store);
    const err = await store
      .putVectors(NS, synthRows(100, 2, { dim: D }))
      .catch((e: unknown) => e as { code: string; details: Record<string, unknown> });
    expect((err as { code: string }).code).toBe('invalid_value');
    expect((err as { details: Record<string, unknown> }).details['reason']).toBe('generation');
    await expect(store.delete(NS, 'chunk-000001')).rejects.toMatchObject({
      code: 'invalid_value',
      details: { reason: 'generation' },
    });
    expect(await snapshot(driver)).toEqual(files);
    expect((await store.query(NS, synthQuery(0, D), 3)).length).toBe(3);
  });

  it('a failed first call that wrote parts leaves nothing behind, and a crash leftover is cleaned by the next write', async () => {
    const driver = new MemoryDriver();
    const store = await createStore({ driver });
    open.push(store);
    await store.putVectors(NS, synthRows(0, 10, { dim: D }));
    // simulate a crash: parts of a segment that was never committed
    const stray = new Uint8Array(16);
    for (const name of ['vec-5/00000', 'meta-5/00000', 'val-6/00003']) {
      await driver.put(vnsOf(NS), name, stray, { size: 16 });
    }
    await store.putVectors(NS, synthRows(100, 3, { dim: D }));
    const names = await driver.keys(vnsOf(NS));
    expect(names.filter((n) => /-5\/|-6\//.test(n))).toEqual([]);
    // the committed head is intact and the records it references still exist
    expect((await store.indexInfo(NS))?.rows).toBe(13);
    const head = await readRecord(driver, NS, 'head');
    expect(head.length).toBeGreaterThan(64);
  });

  it('a WebAssembly allocation that fails is quota_exceeded with reason wasm_memory', async () => {
    const k = await Kernel.create('scalar');
    try {
      k.alloc(0xfffffff0);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'quota_exceeded', details: { reason: 'wasm_memory' } });
    }
    expect(k.alive).toBe(true);
  });
});
