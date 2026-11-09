import { describe, expect, it } from 'vitest';
import { createStore } from '../src/index';
import { behaviourCases, runSuite, type MakeStore } from './storage.behaviour';

const makeStore: MakeStore = (opts) => createStore({ driver: 'memory', ...(opts ?? {}) });

describe('behavioural suite (memory driver)', () => {
  it('has at least 30 cases with unique names', () => {
    expect(behaviourCases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(behaviourCases.map((c) => c.name)).size).toBe(behaviourCases.length);
  });

  runSuite(makeStore, it);
});

describe('createStore', () => {
  it('reports driver "memory" for an explicit memory store', async () => {
    const store = await createStore({ driver: 'memory' });
    expect(store.driver).toBe('memory');
    await store.close();
  });

  it('accepts a custom StorageDriver instance', async () => {
    const { MemoryDriver } = await import('../src/drivers/memory');
    const driver = new MemoryDriver();
    const store = await createStore({ driver });
    await store.set('ns', 'k', 'v');
    expect((await driver.keys('ns')).length).toBe(1);
    await store.close();
  });

  it('"auto" rejects with driver_unavailable when neither OPFS nor IndexedDB exists', async () => {
    const g = globalThis as { navigator?: unknown; indexedDB?: unknown };
    const hadNav = 'navigator' in g;
    const hadIdb = 'indexedDB' in g;
    const nav = g.navigator;
    const idb = g.indexedDB;
    Object.defineProperty(g, 'navigator', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(g, 'indexedDB', { value: undefined, configurable: true, writable: true });
    try {
      await expect(createStore({ driver: 'auto' })).rejects.toMatchObject({
        name: 'StorageError',
        code: 'driver_unavailable',
      });
      await expect(createStore({ driver: 'opfs' })).rejects.toMatchObject({
        code: 'driver_unavailable',
      });
      await expect(createStore({ driver: 'indexeddb' })).rejects.toMatchObject({
        code: 'driver_unavailable',
      });
    } finally {
      if (hadNav) Object.defineProperty(g, 'navigator', { value: nav, configurable: true });
      else delete g.navigator;
      if (hadIdb) Object.defineProperty(g, 'indexedDB', { value: idb, configurable: true });
      else delete g.indexedDB;
    }
  });

  it('persists accounting across reopen on the same driver', async () => {
    const { MemoryDriver } = await import('../src/drivers/memory');
    const driver = new MemoryDriver();
    const a = await createStore({ driver });
    await a.set('ns', 'k1', new Uint8Array(100));
    await a.set('ns', 'k2', 'x');
    await a.close();
    const b = await createStore({ driver, quotaBytes: 100_000 });
    const u = await b.usage('ns');
    expect(u.items).toBe(2);
    expect(u.bytes).toBeGreaterThan(100);
    expect((await b.list('ns')).keys).toEqual(['k1', 'k2']);
    await b.close();
  });

  it('rebuilds accounting from the driver when the meta record is missing', async () => {
    const { MemoryDriver } = await import('../src/drivers/memory');
    const driver = new MemoryDriver();
    const a = await createStore({ driver });
    await a.set('ns', 'k1', 'one');
    await a.close();
    await driver.open();
    await driver.del('__ld_meta', 'ns');
    const b = await createStore({ driver });
    expect(await b.get('ns', 'k1')).toBe('one');
    expect((await b.usage('ns')).items).toBe(1);
    await b.close();
  });
});
