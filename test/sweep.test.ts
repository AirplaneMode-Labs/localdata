// T1-S4-08, code part (Sprint 5, D4-03): when an index is opened, the records of its namespace that
// no HEAD references (parts of a write that never committed) are deleted, and the number deleted is
// reported as the `swept` attr of storage.index.open. A record the committed HEAD references is never
// deleted; a writer in another tab is never raced (the sweep takes the writer's Web Lock only if it is
// free); a failure to delete never fails the read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, type Event, type LocalData } from '../src/index';
import { synthQuery, synthRows } from '../bench/synth';
import { installFakeNavigator, type FakeNavigator } from './fake-env';

const NS = 'docs';
const VNS = `__ld_vec.${NS}`;
const D = 16;
const q = synthQuery(0, D);

let nav: FakeNavigator | undefined;
const stores: LocalData[] = [];

beforeEach(() => {
  nav = undefined;
});
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  nav?.restore();
});

interface Opened {
  store: LocalData;
  events: Event[];
}

async function open(driver: MemoryDriver): Promise<Opened> {
  const events: Event[] = [];
  const store = await createStore({ driver, events: { emit: (e) => void events.push(e) } });
  stores.push(store);
  return { store, events };
}

const opens = (events: Event[]): Event[] => events.filter((e) => e.name === 'storage.index.open');

/** A committed index: two putVectors calls (two segments), one delete and one replace. */
async function committed(driver: MemoryDriver, rows = 30): Promise<void> {
  const s = await createStore({ driver });
  await s.putVectors(NS, synthRows(0, rows, { dim: D, chunkBytes: 64 }));
  await s.putVectors(NS, synthRows(rows, rows, { dim: D, chunkBytes: 64 }));
  await s.delete(NS, 'chunk-000003');
  await s.putVectors(NS, synthRows(5, 2, { dim: D, chunkBytes: 80 }));
  await s.close();
  await driver.open();
}

const ORPHANS = [
  'vec-9/00000', // a segment no HEAD lists
  'meta-9/00000',
  'val-9/00001',
  'vec-0/00007', // a listed segment, but a part its length does not need
  'val-1/00005',
  'vec-4000/00000', // a far-away id
];

async function plantOrphans(d: MemoryDriver, names = ORPHANS): Promise<void> {
  for (const n of names) await d.put(VNS, n, new Uint8Array([1, 2, 3, 4]), { size: 4 });
}

describe('T1-S4-08: sweep unreferenced index records on open', () => {
  it('deletes planted orphans, counts them in storage.index.open swept, and keeps every referenced record', async () => {
    const driver = new MemoryDriver();
    await committed(driver);
    const before = await driver.keys(VNS);
    await plantOrphans(driver);
    await driver.put(VNS, 'notes', new Uint8Array(2), { size: 2 }); // not an index record: left alone
    const { store, events } = await open(driver);
    const hits = await store.query(NS, q, 8);
    expect(hits.length).toBe(8);
    expect(await driver.keys(VNS)).toEqual([...before, 'notes'].sort());
    const first = opens(events)[0]!;
    expect(first.attrs['outcome']).toBe('ok');
    expect(first.attrs['swept']).toBe(ORPHANS.length);
  });

  it('results are identical with and without orphans (the sweep never touches a referenced record)', async () => {
    const a = new MemoryDriver();
    const b = new MemoryDriver();
    await committed(a);
    await committed(b);
    await plantOrphans(b);
    const sa = await open(a);
    const sb = await open(b);
    for (let j = 0; j < 4; j++) {
      const x = await sa.store.query(NS, synthQuery(j, D), 12);
      const y = await sb.store.query(NS, synthQuery(j, D), 12);
      expect(y).toEqual(x);
    }
    expect(await b.keys(VNS)).toEqual(await a.keys(VNS));
    expect(opens(sa.events)[0]!.attrs['swept']).toBe(0);
  });

  it('a second open finds nothing left to sweep', async () => {
    const driver = new MemoryDriver();
    await committed(driver);
    await plantOrphans(driver);
    const one = await open(driver);
    await one.store.query(NS, q, 3);
    await one.store.close();
    await driver.open();
    const two = await open(driver);
    await two.store.query(NS, q, 3);
    expect(opens(two.events)[0]!.attrs['swept']).toBe(0);
  });

  it('every storage.index.open event carries an integer swept (0 when nothing was removed)', async () => {
    const driver = new MemoryDriver();
    await committed(driver);
    const { store, events } = await open(driver);
    await store.query(NS, q, 3);
    await store.putVectors(NS, synthRows(100, 2, { dim: D }));
    const all = opens(events);
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const e of all) expect(Number.isInteger(e.attrs['swept'])).toBe(true);
  });

  it('a namespace with orphans and no HEAD (the first write never committed) is swept too', async () => {
    const driver = new MemoryDriver();
    await driver.open();
    await plantOrphans(driver, ['vec-0/00000', 'vec-0/00001', 'meta-0/00000', 'val-0/00000']);
    const { store, events } = await open(driver);
    expect(await store.query(NS, q, 5)).toEqual([]);
    expect(await store.indexInfo(NS)).toBeUndefined();
    expect(await driver.keys(VNS)).toEqual([]);
    const ev = opens(events)[0]!;
    expect(ev.attrs['outcome']).toBe('absent');
    expect(ev.attrs['swept']).toBe(4);
  });

  it('multi-part vector and value parts and several segments are all referenced: nothing is swept', async () => {
    const driver = new MemoryDriver();
    const s = await createStore({ driver });
    // dim 2048: 1024 rows per 8 MiB vector part, so 1100 rows are two vector parts
    await s.putVectors('big', synthRows(0, 1100, { dim: 2048 }));
    // 60 values of 20 KiB: 1.2 MB of values, two 1 MiB value parts
    await s.putVectors('vals', synthRows(0, 60, { dim: D, chunkBytes: 20_000 }));
    await s.putVectors('vals', synthRows(60, 60, { dim: D, chunkBytes: 20_000 }));
    await s.delete('vals', 'chunk-000001');
    await s.close();
    await driver.open();
    const names = {
      big: await driver.keys('__ld_vec.big'),
      vals: await driver.keys('__ld_vec.vals'),
    };
    expect(names.big.filter((n) => n.startsWith('vec-')).length).toBe(2);
    expect(names.vals.filter((n) => n.startsWith('val-')).length).toBeGreaterThanOrEqual(3);
    const o = await open(driver);
    expect((await o.store.query('big', synthQuery(0, 2048), 3)).length).toBe(3);
    expect((await o.store.query('vals', synthQuery(0, D), 3)).length).toBe(3);
    expect(await driver.keys('__ld_vec.big')).toEqual(names.big);
    expect(await driver.keys('__ld_vec.vals')).toEqual(names.vals);
    for (const e of opens(o.events)) expect(e.attrs['swept']).toBe(0);
  });

  it('usage() opens the index too and sweeps, without adding an event of its own', async () => {
    const driver = new MemoryDriver();
    await committed(driver);
    await plantOrphans(driver);
    const { store, events } = await open(driver);
    const u = await store.usage(NS);
    expect(u.vectorRows).toBeGreaterThan(0);
    expect(await driver.keys(VNS)).not.toContain('vec-9/00000');
    expect(opens(events).length).toBe(0);
  });
});

describe('T1-S4-08: the sweep never races a writer in another tab', () => {
  it('takes the writer lock (ifAvailable) before deleting anything', async () => {
    nav = installFakeNavigator({ locks: true });
    const driver = new MemoryDriver();
    await committed(driver);
    await plantOrphans(driver);
    nav.locks.requests.length = 0;
    const { store } = await open(driver);
    await store.query(NS, q, 3);
    const mine = nav.locks.requests.filter((r) => r.name === `airplanemode-localdata:vec:${NS}`);
    expect(mine.some((r) => r.ifAvailable)).toBe(true);
    expect(await driver.keys(VNS)).not.toContain('vec-9/00000');
  });

  it('with the lock held by another writer the read still resolves, nothing is deleted, swept is 0', async () => {
    nav = installFakeNavigator({ locks: true });
    const driver = new MemoryDriver();
    await committed(driver);
    await plantOrphans(driver);
    const release = nav.locks.hold(`airplanemode-localdata:vec:${NS}`);
    const { store, events } = await open(driver);
    const hits = await store.query(NS, q, 5); // must not wait for the writer
    expect(hits.length).toBe(5);
    expect(await driver.keys(VNS)).toEqual(expect.arrayContaining(ORPHANS));
    expect(opens(events)[0]!.attrs['swept']).toBe(0);
    release();
    await store.close();
    await driver.open();
    const again = await open(driver);
    await again.store.query(NS, q, 5);
    expect(opens(again.events)[0]!.attrs['swept']).toBe(ORPHANS.length);
    expect(await driver.keys(VNS)).not.toContain('vec-9/00000');
  });

  it('a HEAD that changed between the read and the lock is not swept against (another writer committed)', async () => {
    class Racy extends MemoryDriver {
      headReads = 0;
      override async getBytes(ns: string, key: string) {
        const rec = await super.getBytes(ns, key);
        if (ns === VNS && key === 'head' && rec && ++this.headReads === 2)
          rec.bytes[8] = rec.bytes[8]! ^ 1;
        return rec;
      }
    }
    const driver = new Racy();
    await committed(driver);
    await plantOrphans(driver);
    driver.headReads = 0;
    const { store, events } = await open(driver);
    expect((await store.query(NS, q, 5)).length).toBe(5);
    expect(driver.headReads).toBeGreaterThanOrEqual(2);
    expect(await driver.keys(VNS)).toEqual(expect.arrayContaining(ORPHANS));
    expect(opens(events)[0]!.attrs['swept']).toBe(0);
  });

  it('a delete that fails does not fail the read; swept counts only what was removed', async () => {
    class Stubborn extends MemoryDriver {
      override async del(ns: string, key: string) {
        if (ns === VNS && key === 'meta-9/00000') throw new Error('disk says no');
        return super.del(ns, key);
      }
    }
    const driver = new Stubborn();
    await committed(driver);
    await plantOrphans(driver);
    const { store, events } = await open(driver);
    expect((await store.query(NS, q, 5)).length).toBe(5);
    expect(await driver.keys(VNS)).toContain('meta-9/00000');
    expect(opens(events)[0]!.attrs['swept']).toBe(ORPHANS.length - 1);
  });
});
