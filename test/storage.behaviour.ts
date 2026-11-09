// Behavioural suite for the Storage API. The same cases run in Vitest against the memory driver
// (test/memory.test.ts) and inside Chrome against the OPFS and IndexedDB drivers
// (test/browser/harness.ts). It depends only on the public SDK surface and test/assert.ts.
import type { StorableValue, StorageApi } from '../src/contracts/storage-api';
import { bytesEq, deepEq, eq, ok, rejectsWith } from './assert';

export interface MakeStoreOptions {
  quotaBytes?: number;
  clock?: () => number;
}

/** Returns a fresh, EMPTY store. Persistent drivers must wipe their storage first. */
export type MakeStore = (opts?: MakeStoreOptions) => Promise<StorageApi>;

export interface SuiteCase {
  name: string;
  run: (makeStore: MakeStore) => Promise<void>;
}

const NS = 'suite';

function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function withStore(
  makeStore: MakeStore,
  opts: MakeStoreOptions | undefined,
  fn: (store: StorageApi) => Promise<void>,
): Promise<void> {
  const store = await makeStore(opts);
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

function roundTrip(name: string, value: StorableValue | (() => StorableValue)): SuiteCase {
  return {
    name: `set/get round trip: ${name}`,
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        const v = typeof value === 'function' ? value() : value;
        await store.set(NS, 'k', v);
        const got = await store.get(NS, 'k');
        await deepEq(got, v, name);
      }),
  };
}

export const behaviourCases: SuiteCase[] = [
  roundTrip('string', 'hello, world'),
  roundTrip('empty string', ''),
  roundTrip('non-ASCII string', 'नमस्ते दुनिया \u{1F30D} café'),
  roundTrip('integer', 42),
  roundTrip('float', 3.14159),
  roundTrip('NaN', NaN),
  roundTrip('-0', -0),
  roundTrip('Infinity', Infinity),
  roundTrip('-Infinity', -Infinity),
  roundTrip('MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER),
  roundTrip('true', true),
  roundTrip('false', false),
  roundTrip('null', null),
  roundTrip('Date', () => new Date(Date.UTC(2026, 10, 9, 12, 30, 45, 123))),
  roundTrip('invalid Date', () => new Date(NaN)),
  roundTrip('nested object and array', {
    a: [1, 'two', { three: 3, four: [null, true] }],
    b: { c: { d: 'deep' } },
    e: [],
    f: {},
  }),
  roundTrip('object with reserved key "$ld"', { $ld: 'date', v: 5, nested: { $ld: 'obj' } }),
  roundTrip('array mixing special numbers and dates', () => [NaN, -0, new Date(0), 'x', null]),
  roundTrip('ArrayBuffer', () => bytes(1000, 7).buffer),
  roundTrip('Uint8Array', () => bytes(777, 3)),
  roundTrip('Uint8Array subarray view', () => bytes(64, 9).subarray(10, 50)),
  roundTrip('Int8Array', () => Int8Array.from([-128, -1, 0, 1, 127])),
  roundTrip('Uint16Array', () => Uint16Array.from([0, 1, 65535, 256])),
  roundTrip('Int16Array', () => Int16Array.from([-32768, 0, 32767])),
  roundTrip('Uint32Array', () => Uint32Array.from([0, 1, 4294967295])),
  roundTrip('Int32Array', () => Int32Array.from([-2147483648, 0, 2147483647])),
  roundTrip('Float32Array', () => Float32Array.from([0.5, -1.25, 3.5e10, NaN, -0])),
  roundTrip('Float64Array', () => Float64Array.from([Math.PI, -0, Infinity, NaN, 1e-300])),
  roundTrip('BigInt64Array', () => BigInt64Array.from([-(2n ** 63n), 0n, 2n ** 63n - 1n])),
  roundTrip('BigUint64Array', () => BigUint64Array.from([0n, 1n, 2n ** 64n - 1n])),
  roundTrip(
    'Blob with type',
    () => new Blob([bytes(300, 5)], { type: 'application/octet-stream' }),
  ),
  roundTrip('Blob with empty type', () => new Blob(['plain text'])),
  roundTrip('binary nested in object and array', () => ({
    name: 'bundle',
    parts: [bytes(16, 1), { inner: Float32Array.from([1, 2, 3]) }, new Date(1)],
    blob: new Blob(['b'], { type: 'text/plain' }),
    raw: bytes(8, 2).buffer,
  })),
  roundTrip('1 MiB Uint8Array', () => bytes(1024 * 1024, 11)),

  {
    name: 'set overwrites the previous value and usage reflects the new size',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await store.set(NS, 'k', bytes(1000));
        const u1 = await store.usage(NS);
        await store.set(NS, 'k', 'short');
        const u2 = await store.usage(NS);
        eq(await store.get(NS, 'k'), 'short', 'overwritten value');
        eq(u2.items, 1, 'items after overwrite');
        ok(u2.bytes < u1.bytes, `bytes should shrink after overwrite (${u1.bytes} -> ${u2.bytes})`);
      }),
  },
  {
    name: 'delete returns true when a value existed and false otherwise',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await store.set(NS, 'k', 1);
        eq(await store.delete(NS, 'k'), true, 'first delete');
        eq(await store.delete(NS, 'k'), false, 'second delete');
        eq(await store.get(NS, 'k'), undefined, 'value after delete');
        eq((await store.usage(NS)).items, 0, 'items after delete');
      }),
  },
  {
    name: 'get of a missing key resolves undefined',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        eq(await store.get(NS, 'missing'), undefined);
        eq(await store.get('other-ns', 'missing'), undefined);
      }),
  },
  {
    name: 'ttl: value is readable before expiry and undefined after (injectable clock)',
    run: async (makeStore) => {
      let now = 1_000_000;
      await withStore(makeStore, { clock: () => now }, async (store) => {
        await store.set(NS, 'k', 'ephemeral', { ttlMs: 500 });
        now += 499;
        eq(await store.get(NS, 'k'), 'ephemeral', 'before expiry');
        now += 1;
        eq(await store.get(NS, 'k'), undefined, 'at expiry');
      });
    },
  },
  {
    name: 'ttl: expired values are lazily deleted and leave list and usage',
    run: async (makeStore) => {
      let now = 5_000;
      await withStore(makeStore, { clock: () => now }, async (store) => {
        await store.set(NS, 'a', 'x', { ttlMs: 10 });
        await store.set(NS, 'b', 'y');
        now += 11;
        await deepEq((await store.list(NS)).keys, ['b'], 'list hides expired');
        eq(await store.get(NS, 'a'), undefined, 'expired get');
        eq((await store.usage(NS)).items, 1, 'usage after lazy delete');
        eq(await store.delete(NS, 'a'), false, 'delete after lazy delete');
      });
    },
  },
  {
    name: 'ttl: a value set without ttl never expires',
    run: async (makeStore) => {
      let now = 0;
      await withStore(makeStore, { clock: () => now }, async (store) => {
        await store.set(NS, 'k', 'forever');
        now = Number.MAX_SAFE_INTEGER;
        eq(await store.get(NS, 'k'), 'forever');
      });
    },
  },
  {
    name: 'ttl: non-positive or non-finite ttlMs is rejected with invalid_value',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await rejectsWith(store.set(NS, 'k', 1, { ttlMs: 0 }), 'invalid_value');
        await rejectsWith(store.set(NS, 'k', 1, { ttlMs: -1 }), 'invalid_value');
        await rejectsWith(store.set(NS, 'k', 1, { ttlMs: NaN }), 'invalid_value');
        eq(await store.get(NS, 'k'), undefined, 'nothing written');
      }),
  },
  {
    name: 'namespaces isolate the same key',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await store.set('ns-a', 'k', 'A');
        await store.set('ns-b', 'k', 'B');
        eq(await store.get('ns-a', 'k'), 'A');
        eq(await store.get('ns-b', 'k'), 'B');
        await store.delete('ns-a', 'k');
        eq(await store.get('ns-b', 'k'), 'B', 'delete in one ns leaves the other');
      }),
  },
  {
    name: 'list returns keys sorted by code unit order',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        for (const k of ['b', 'a', 'c', 'B', '10', '2']) await store.set(NS, k, k);
        await deepEq((await store.list(NS)).keys, ['10', '2', 'B', 'a', 'b', 'c']);
      }),
  },
  {
    name: 'list filters by prefix',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        for (const k of ['doc/1', 'doc/2', 'img/1', 'doc', 'document']) await store.set(NS, k, 1);
        await deepEq((await store.list(NS, { prefix: 'doc/' })).keys, ['doc/1', 'doc/2']);
        await deepEq((await store.list(NS, { prefix: 'doc' })).keys, [
          'doc',
          'doc/1',
          'doc/2',
          'document',
        ]);
        await deepEq((await store.list(NS, { prefix: 'zzz' })).keys, []);
      }),
  },
  {
    name: 'list paginates with limit and cursor until the cursor is absent',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        const all: string[] = [];
        for (let i = 0; i < 25; i++) {
          const k = `k${String(i).padStart(3, '0')}`;
          all.push(k);
          await store.set(NS, k, i);
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const opts: { limit: number; cursor?: string } = { limit: 7 };
          if (cursor !== undefined) opts.cursor = cursor;
          const page = await store.list(NS, opts);
          ok(page.keys.length <= 7, 'page size respects limit');
          seen.push(...page.keys);
          cursor = page.cursor;
          pages++;
          ok(pages < 10, 'pagination terminates');
        } while (cursor !== undefined);
        await deepEq(seen, all, 'pages cover every key exactly once');
        eq(pages, 4, 'ceil(25/7) pages');
      }),
  },
  {
    name: 'list on an empty or unknown namespace returns no keys and no cursor',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        const r = await store.list('never-written');
        await deepEq(r.keys, []);
        eq(r.cursor, undefined);
        eq('cursor' in r, false, 'cursor property absent when there is no next page');
      }),
  },
  {
    name: 'usage reports bytes and items per namespace',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        eq((await store.usage(NS)).items, 0);
        eq((await store.usage(NS)).bytes, 0);
        await store.set(NS, 'a', bytes(1000));
        await store.set(NS, 'b', bytes(2000));
        const u = await store.usage(NS);
        eq(u.items, 2);
        ok(u.bytes >= 3000 && u.bytes < 3000 + 512, `bytes ~3000 plus envelope, got ${u.bytes}`);
        eq(u.quotaBytes, undefined, 'quotaBytes absent when not configured');
      }),
  },
  {
    name: 'usage without a namespace totals every namespace and reports quotaBytes',
    run: (makeStore) =>
      withStore(makeStore, { quotaBytes: 1024 * 1024 }, async (store) => {
        await store.set('ns-a', 'a', bytes(100));
        await store.set('ns-b', 'b', bytes(200));
        await store.set('ns-b', 'c', bytes(300));
        const total = await store.usage();
        const a = await store.usage('ns-a');
        const b = await store.usage('ns-b');
        eq(total.items, 3);
        eq(total.bytes, a.bytes + b.bytes, 'total is the sum of namespaces');
        eq(total.quotaBytes, 1024 * 1024);
      }),
  },
  {
    name: 'clear empties one namespace and leaves others untouched',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await store.set('ns-a', 'k1', 1);
        await store.set('ns-a', 'k2', 2);
        await store.set('ns-b', 'k1', 3);
        await store.clear('ns-a');
        eq(await store.get('ns-a', 'k1'), undefined);
        await deepEq((await store.list('ns-a')).keys, []);
        eq((await store.usage('ns-a')).items, 0);
        eq((await store.usage('ns-a')).bytes, 0);
        eq(await store.get('ns-b', 'k1'), 3);
        await store.clear('never-written');
      }),
  },
  {
    name: 'invalid namespaces are rejected with invalid_namespace',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        for (const ns of ['', 'Upper', '_lead', '.lead', 'has space', 'a'.repeat(65), 'ns/slash']) {
          await rejectsWith(store.set(ns, 'k', 1), 'invalid_namespace');
          await rejectsWith(store.get(ns, 'k'), 'invalid_namespace');
          await rejectsWith(store.delete(ns, 'k'), 'invalid_namespace');
          await rejectsWith(store.list(ns), 'invalid_namespace');
          await rejectsWith(store.clear(ns), 'invalid_namespace');
          await rejectsWith(store.usage(ns), 'invalid_namespace');
        }
        await store.set('a'.repeat(64), 'k', 1);
        await store.set('0.ok_ns-1', 'k', 1);
      }),
  },
  {
    name: 'the reserved namespace __ld_meta is rejected',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await rejectsWith(store.set('__ld_meta', 'k', 1), 'invalid_namespace');
        await rejectsWith(store.get('__ld_meta', 'k'), 'invalid_namespace');
        await rejectsWith(store.clear('__ld_meta'), 'invalid_namespace');
      }),
  },
  {
    name: 'invalid keys are rejected with invalid_key',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await rejectsWith(store.set(NS, '', 1), 'invalid_key');
        await rejectsWith(store.set(NS, 'a'.repeat(1025), 1), 'invalid_key');
        await rejectsWith(store.set(NS, 'nul\u0000byte', 1), 'invalid_key');
        await rejectsWith(store.get(NS, ''), 'invalid_key');
        await rejectsWith(store.delete(NS, 'x\u0000'), 'invalid_key');
        eq((await store.usage(NS)).items, 0, 'nothing written');
      }),
  },
  {
    name: 'keys at the 1024 code unit limit and with non-ASCII characters are accepted',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        const long = 'k'.repeat(1024);
        const uni = 'कुंजी/\u{1F511}/ключ';
        await store.set(NS, long, 'long');
        await store.set(NS, uni, 'uni');
        eq(await store.get(NS, long), 'long');
        eq(await store.get(NS, uni), 'uni');
        await deepEq((await store.list(NS)).keys, [long, uni].sort());
      }),
  },
  {
    name: 'unsupported values are rejected with invalid_value and nothing is written',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        class Thing {
          x = 1;
        }
        const bad: unknown[] = [
          () => 1,
          Symbol('s'),
          new Map([['a', 1]]),
          new Set([1]),
          new Thing(),
          undefined,
          10n,
          { nested: new Map() },
          [1, () => 2],
          { f: undefined },
          new DataView(new ArrayBuffer(4)),
        ];
        for (const v of bad) {
          await rejectsWith(store.set(NS, 'k', v as StorableValue), 'invalid_value');
        }
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        await rejectsWith(store.set(NS, 'k', circular as StorableValue), 'invalid_value');
        eq(await store.get(NS, 'k'), undefined, 'nothing written');
        eq((await store.usage(NS)).items, 0);
      }),
  },
  {
    name: 'quota_exceeded is thrown before writing when quotaBytes would be exceeded',
    run: (makeStore) =>
      withStore(makeStore, { quotaBytes: 4096 }, async (store) => {
        await store.set(NS, 'small', bytes(1000));
        const before = await store.usage();
        const err = await rejectsWith(store.set(NS, 'big', bytes(4000)), 'quota_exceeded');
        eq(await store.get(NS, 'big'), undefined, 'big was not written');
        const after = await store.usage();
        eq(after.bytes, before.bytes, 'usage unchanged');
        eq(after.items, 1, 'items unchanged');
        ok(err.details !== undefined, 'details present');
        eq(err.details?.['quotaBytes'], 4096, 'details.quotaBytes');
        ok(typeof err.details?.['needed'] === 'number', 'details.needed');
      }),
  },
  {
    name: 'quota accounting credits the old size when overwriting',
    run: (makeStore) =>
      withStore(makeStore, { quotaBytes: 4096 }, async (store) => {
        await store.set(NS, 'k', bytes(3000));
        await store.set(NS, 'k', bytes(3500));
        await deepEq(await store.get(NS, 'k'), bytes(3500), 'overwrite within quota succeeds');
        await rejectsWith(store.set(NS, 'other', bytes(1000)), 'quota_exceeded');
        await store.delete(NS, 'k');
        await store.set(NS, 'other', bytes(1000));
      }),
  },
  {
    name: 'query rejects with not_implemented and a message naming Sprint 4',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        await rejectsWith(
          store.query(NS, new Float32Array([0.1, 0.2, 0.3]), 5),
          'not_implemented',
          'Sprint 4',
        );
        await rejectsWith(
          store.query(NS, new Float32Array(8), 1, { filterPrefix: 'doc/' }),
          'not_implemented',
          'Sprint 4',
        );
      }),
  },
  {
    name: 'close is idempotent and every call after close rejects with closed',
    run: async (makeStore) => {
      const store = await makeStore();
      await store.set(NS, 'k', 1);
      await store.close();
      await store.close();
      await rejectsWith(store.set(NS, 'k', 2), 'closed');
      await rejectsWith(store.get(NS, 'k'), 'closed');
      await rejectsWith(store.delete(NS, 'k'), 'closed');
      await rejectsWith(store.list(NS), 'closed');
      await rejectsWith(store.usage(), 'closed');
      await rejectsWith(store.clear(NS), 'closed');
      await rejectsWith(store.query(NS, new Float32Array(1), 1), 'closed');
    },
  },
  {
    name: 'driver name is one of opfs, indexeddb or memory',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        ok(['opfs', 'indexeddb', 'memory'].includes(store.driver), `driver ${store.driver}`);
      }),
  },
  {
    name: 'values are copied on set: mutating the input afterwards does not change the stored value',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        const input = bytes(32, 4);
        const copy = bytes(32, 4);
        await store.set(NS, 'k', input);
        input.fill(0);
        const got = (await store.get(NS, 'k')) as Uint8Array;
        bytesEq(got, copy, 'stored bytes unaffected by later mutation');
        const obj = { list: [1, 2, 3] };
        await store.set(NS, 'o', obj);
        obj.list.push(4);
        await deepEq(await store.get(NS, 'o'), { list: [1, 2, 3] });
      }),
  },
  {
    name: 'many keys: 200 sets then list, usage and get agree',
    run: (makeStore) =>
      withStore(makeStore, undefined, async (store) => {
        for (let i = 0; i < 200; i++) await store.set(NS, `key-${i}`, { i });
        const listed = await store.list(NS);
        eq(listed.keys.length, 200);
        eq((await store.usage(NS)).items, 200);
        await deepEq(await store.get(NS, 'key-199'), { i: 199 });
      }),
  },
];

/** Registers every case with a test framework (`it`, `test`) or any (name, fn) collector. */
export function runSuite(
  makeStore: MakeStore,
  define: (name: string, fn: () => Promise<void>) => unknown,
): void {
  for (const c of behaviourCases) define(c.name, () => c.run(makeStore));
}

export interface SuiteResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/** Runs every case sequentially and returns results (used by the browser harness). */
export async function collectSuite(makeStore: MakeStore): Promise<SuiteResult[]> {
  const results: SuiteResult[] = [];
  for (const c of behaviourCases) {
    const t0 = performance.now();
    try {
      await c.run(makeStore);
      results.push({ name: c.name, ok: true, ms: performance.now() - t0 });
    } catch (e) {
      results.push({
        name: c.name,
        ok: false,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        ms: performance.now() - t0,
      });
    }
  }
  return results;
}
