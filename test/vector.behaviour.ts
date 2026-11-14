// Behavioural suite for the vector index (Storage API 0.2.0): putVectors, query, indexInfo, usage,
// delete and clear. The same cases run in Vitest against the memory driver (test/memory.test.ts) and
// inside Chrome against OPFS and IndexedDB (test/browser/harness.ts). They depend only on the public
// SDK surface, the reference in src/vec/reference.ts and the raw driver for forging corruption.
import type { QueryHit, StorageApi, StorageDriver, VectorRow } from '../src/contracts/storage-api';
import { simdSupported } from '../src/vec/kernel';
import { compareUtf8Ref, f32Bits, topKRef, type RefRow } from '../src/vec/reference';
import { DIM, synthKey, synthQuery, synthRow, synthRows, synthVector } from '../bench/synth';
import { deepEq, eq, ok, rejectsWith } from './assert';

export interface VectorStoreOptions {
  quotaBytes?: number;
  vectorKernel?: 'auto' | 'simd' | 'scalar';
  maxIndexBytes?: number;
}

export interface VectorEnv {
  /** A fresh, EMPTY store (persistent drivers wipe their storage first). */
  makeStore(opts?: VectorStoreOptions): Promise<StorageApi>;
  /** A new store over the SAME storage with no wipe: what a page reload or a restart sees. */
  reopen(opts?: VectorStoreOptions): Promise<StorageApi>;
  /** A raw, opened driver over the same storage, for forging corruption. The caller closes it. */
  raw(): Promise<StorageDriver>;
}

export interface VectorCase {
  name: string;
  run: (env: VectorEnv) => Promise<void>;
}

const NS = 'vecs';
const VNS = `__ld_vec.${NS}`;

async function withStore(
  env: VectorEnv,
  opts: VectorStoreOptions | undefined,
  fn: (store: StorageApi) => Promise<void>,
): Promise<void> {
  const store = await env.makeStore(opts);
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

const keysOf = (hits: QueryHit[]): string[] => hits.map((h) => h.key);
const bitsOf = (hits: QueryHit[]): number[] => hits.map((h) => f32Bits(h.score));

function v(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

function refRows(from: number, count: number, dim = DIM): RefRow[] {
  const out: RefRow[] = [];
  for (let i = from; i < from + count; i++)
    out.push({ key: synthKey(i), vector: synthVector(i, dim) });
  return out;
}

async function flip(env: VectorEnv, name: string, at?: number): Promise<void> {
  const d = await env.raw();
  try {
    const rec = await d.getBytes(VNS, name);
    ok(rec !== undefined, `record ${name} exists`);
    const b = rec.bytes.slice();
    const i = at ?? b.length >> 1;
    b[i] = b[i]! ^ 0x40;
    await d.put(VNS, name, b, { size: b.length });
  } finally {
    await d.close();
  }
}

async function expectCorrupt(
  store: StorageApi,
  reason: string,
  fileStartsWith: string,
  what: () => Promise<unknown>,
): Promise<void> {
  const err = await rejectsWith(what(), 'corrupt');
  eq(err.details?.['reason'], reason, 'details.reason');
  ok(
    String(err.details?.['file']).startsWith(fileStartsWith),
    `details.file ${err.details?.['file']}`,
  );
  eq(err.details?.['ns'], NS, 'details.ns');
  // No wrong answers, and the failure is sticky for this index.
  await rejectsWith(store.query(NS, synthQuery(0, 16), 40), 'corrupt');
}

export const vectorCases: VectorCase[] = [
  {
    name: 'top-k equals the Math.fround reference bit for bit: 5,000 rows, dim 384, k in {1, 10, 100}, both metrics',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        const res = await store.putVectors(NS, synthRows(0, 5000));
        await deepEq(res, { written: 5000, replaced: 0, rows: 5000 });
        const rows = refRows(0, 5000);
        for (const j of [0, 1, 2]) {
          const q = synthQuery(j);
          for (const metric of ['cosine', 'dot'] as const) {
            const ref = topKRef(rows, q, 100, metric);
            for (const k of [1, 10, 100]) {
              const hits = await store.query(NS, q, k, { metric });
              const want = ref.slice(0, k);
              await deepEq(
                keysOf(hits),
                want.map((h) => h.key),
                `keys q${j} ${metric} k${k}`,
              );
              await deepEq(
                bitsOf(hits),
                want.map((h) => f32Bits(h.score)),
                `scores q${j} ${metric} k${k}`,
              );
            }
          }
        }
      }),
  },
  {
    name: 'SIMD and scalar kernels return bitwise-equal hits (skipped without WebAssembly SIMD)',
    run: async (env) => {
      const rows = [...synthRows(0, 1200)];
      const results: Array<{ kernel: string; keys: string[]; bits: number[] }> = [];
      for (const vectorKernel of ['scalar', 'simd'] as const) {
        if (vectorKernel === 'simd' && !simdSupported()) continue;
        await withStore(env, { vectorKernel }, async (store) => {
          await store.putVectors(NS, rows);
          const info = await store.indexInfo(NS);
          eq(info?.kernel, vectorKernel, 'kernel in use');
          const hits = await store.query(NS, synthQuery(7), 600);
          results.push({ kernel: vectorKernel, keys: keysOf(hits), bits: bitsOf(hits) });
        });
      }
      if (results.length === 2) {
        await deepEq(results[1]!.keys, results[0]!.keys, 'simd keys equal scalar keys');
        await deepEq(results[1]!.bits, results[0]!.bits, 'simd scores equal scalar scores');
      }
    },
  },
  {
    name: 'ties break by key in UTF-8 byte order, including an astral key against a U+FFFD-adjacent key',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        // UTF-16 code-unit order would put the astral keys BEFORE U+E000..U+FFFF; UTF-8 byte order after.
        const keys = ['\u{10000}', '�', '', 'z', '\u{1F600}', 'a', '～', '\u{10FFFF}'];
        await store.putVectors(
          NS,
          keys.map((key) => ({ key, vector: v(1, 0) })),
        );
        const hits = await store.query(NS, v(1, 0), 20);
        const expected = [...keys].sort(compareUtf8Ref);
        await deepEq(keysOf(hits), expected, 'UTF-8 byte order');
        await deepEq(
          keysOf(hits),
          ['a', 'z', '', '～', '�', '\u{10000}', '\u{1F600}', '\u{10FFFF}'],
          'pinned order',
        );
        const top = await store.query(NS, v(1, 0), 3);
        await deepEq(keysOf(top), ['a', 'z', ''], 'k = 3 keeps the first three');
      }),
  },
  {
    name: 'reopen gives identical hits, scores and values (persistence across a new store instance)',
    run: async (env) => {
      const first = await env.makeStore();
      const rows = [...synthRows(0, 1500, { chunkBytes: 256 })];
      await first.putVectors(NS, rows);
      const q = synthQuery(3);
      const before = await first.query(NS, q, 25);
      const infoBefore = await first.indexInfo(NS);
      await first.close();
      const second = await env.reopen();
      try {
        const after = await second.query(NS, q, 25);
        await deepEq(keysOf(after), keysOf(before), 'keys');
        await deepEq(bitsOf(after), bitsOf(before), 'scores');
        await deepEq(
          after.map((h) => h.value),
          before.map((h) => h.value),
          'values',
        );
        await deepEq(await second.indexInfo(NS), infoBefore, 'indexInfo');
        eq(typeof after[0]?.value, 'string', 'values come back');
      } finally {
        await second.close();
      }
    },
  },
  {
    name: 'a repeated key in one call is invalid_value duplicate_key and nothing becomes visible',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        await store.putVectors(NS, [{ key: 'keep', vector: v(1, 0, 0) }]);
        const err = await rejectsWith(
          store.putVectors(NS, [
            { key: 'a', vector: v(1, 0, 0) },
            { key: 'b', vector: v(0, 1, 0) },
            { key: 'a', vector: v(0, 0, 1) },
          ]),
          'invalid_value',
        );
        eq(err.details?.['reason'], 'duplicate_key');
        eq(err.details?.['row'], 2, 'the position of the second occurrence');
        ok(!JSON.stringify(err).includes('"a"'), 'no key in the error');
        await deepEq(
          keysOf(await store.query(NS, v(1, 0, 0), 10)),
          ['keep'],
          'previous index only',
        );
        eq((await store.indexInfo(NS))?.rows, 1);
      }),
  },
  {
    name: 'a first call fixes dim and a different length is invalid_value dim, within a call and across calls',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        const within = await rejectsWith(
          store.putVectors(NS, [
            { key: 'a', vector: v(1, 0, 0) },
            { key: 'b', vector: v(1, 0) },
          ]),
          'invalid_value',
        );
        eq(within.details?.['reason'], 'dim');
        eq(within.details?.['row'], 1);
        eq(await store.indexInfo(NS), undefined, 'a failed first call creates no index');
        await store.putVectors(NS, [{ key: 'a', vector: v(1, 0, 0) }]);
        const across = await rejectsWith(
          store.putVectors(NS, [{ key: 'b', vector: v(1, 0) }]),
          'invalid_value',
        );
        eq(across.details?.['reason'], 'dim');
        eq((await store.indexInfo(NS))?.dim, 3);
      }),
  },
  {
    name: 'non-finite, oversize and mis-shaped vectors are refused with details.row and no previous data lost',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        await store.putVectors(NS, [{ key: 'keep', vector: v(1, 0, 0) }]);
        const bad: Array<[string, unknown]> = [
          ['NaN', v(1, Number.NaN, 0)],
          ['Infinity', v(Number.POSITIVE_INFINITY, 0, 0)],
          ['-Infinity', v(0, 0, Number.NEGATIVE_INFINITY)],
          ['selfDot above 1e30', v(3e15, 0, 0)],
          ['f32 overflow', v(3e38, 3e38, 0)],
          ['not a Float32Array', [1, 0, 0]],
          ['a Float64Array', new Float64Array([1, 0, 0])],
          ['empty', new Float32Array(0)],
        ];
        for (const [what, vector] of bad) {
          const err = await rejectsWith(
            store.putVectors(NS, [
              { key: 'ok1', vector: v(0, 1, 0) },
              { key: 'ok2', vector: v(0, 0, 1) },
              { key: 'bad', vector: vector as Float32Array },
            ]),
            'invalid_value',
          );
          eq(err.details?.['row'], 2, `${what}: row`);
          ok(!err.message.includes('bad'), `${what}: no key in the message`);
        }
        await deepEq(keysOf(await store.query(NS, v(1, 0, 0), 10)), ['keep'], 'index unchanged');
      }),
  },
  {
    name: 'invalid keys are invalid_key with the row position; a value over 1 MiB is invalid_value',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        for (const key of ['', 'a\u0000b', 'x'.repeat(1025), '\uD800', 'ok\uDC00']) {
          const err = await rejectsWith(
            store.putVectors(NS, [
              { key: 'fine', vector: v(1, 0) },
              { key, vector: v(0, 1) },
            ]),
            'invalid_key',
          );
          eq(err.details?.['row'], 1);
        }
        const err = await rejectsWith(
          store.putVectors(NS, [{ key: 'big', vector: v(1, 0), value: new Uint8Array(1048577) }]),
          'invalid_value',
        );
        eq(err.details?.['reason'], 'value_size');
        await store.putVectors(NS, [
          { key: 'edge', vector: v(1, 0), value: new Uint8Array(1048576 - 1000) },
        ]);
        eq((await store.indexInfo(NS))?.rows, 1);
      }),
  },
  {
    name: 'query validation order: ns, k, vector, filterPrefix, metric, then no index, dim and k = 0',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        const reason = async (p: Promise<unknown>, code: 'invalid_value' | 'invalid_namespace') =>
          (await rejectsWith(p, code)).details?.['reason'];
        const nan = v(Number.NaN);
        // 2 before 3: a bad namespace wins over a bad k
        await rejectsWith(store.query('NOT VALID', v(1), -1), 'invalid_namespace');
        // 3 before 4
        eq(await reason(store.query(NS, nan, -1), 'invalid_value'), 'k');
        // 4 before 5
        eq(
          await reason(store.query(NS, nan, 1, { filterPrefix: '\uD800' }), 'invalid_value'),
          'vector',
        );
        // 5 before 6
        eq(
          await reason(
            store.query(NS, v(1), 1, { filterPrefix: '\uD800', metric: 'euclid' as 'dot' }),
            'invalid_value',
          ),
          'filter_prefix',
        );
        eq(
          await reason(store.query(NS, v(1), 1, { filterPrefix: 'a\u0000' }), 'invalid_value'),
          'filter_prefix',
        );
        eq(
          await reason(store.query(NS, v(1), 1, { metric: 'euclid' as 'dot' }), 'invalid_value'),
          'metric',
        );
        // 7: no index returns []
        await deepEq(await store.query(NS, v(1, 2, 3), 5), [], 'no index');
        await deepEq(await store.query(NS, v(1, 2, 3), 0), [], 'no index, k = 0');
        await store.putVectors(NS, [{ key: 'a', vector: v(1, 0, 0) }]);
        // 8 before 9: a wrong dim is refused even when k = 0
        eq(await reason(store.query(NS, v(1, 0), 0), 'invalid_value'), 'dim');
        eq(await reason(store.query(NS, v(1, 0), 3), 'invalid_value'), 'dim');
        // 9
        await deepEq(await store.query(NS, v(1, 0, 0), 0), [], 'k = 0');
        // k bounds
        eq(await reason(store.query(NS, v(1, 0, 0), 2147483648), 'invalid_value'), 'k');
        eq((await store.query(NS, v(1, 0, 0), 2147483647)).length, 1);
        // an empty or oversize query vector
        eq(await reason(store.query(NS, new Float32Array(0), 1), 'invalid_value'), 'vector');
        eq(await reason(store.query(NS, new Float32Array(4097), 1), 'invalid_value'), 'vector');
      }),
  },
  {
    name: 'filterPrefix compares UTF-8 prefixes, and metric defaults to cosine',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        await store.putVectors(NS, [
          { key: 'doc/ä/1', vector: v(1, 0) },
          { key: 'doc/ä/2', vector: v(0, 1) },
          { key: 'doc/z', vector: v(1, 1) },
          { key: 'img/1', vector: v(1, 0) },
        ]);
        await deepEq(
          keysOf(await store.query(NS, v(1, 0), 10, { filterPrefix: 'doc/ä' })),
          ['doc/ä/1', 'doc/ä/2'],
          'prefix with a multi-byte character',
        );
        await deepEq(
          keysOf(await store.query(NS, v(1, 0), 10, { filterPrefix: 'nope' })),
          [],
          'no match',
        );
        const dflt = await store.query(NS, v(2, 0), 4);
        const cos = await store.query(NS, v(2, 0), 4, { metric: 'cosine' });
        await deepEq(bitsOf(dflt), bitsOf(cos), 'default metric is cosine');
        await deepEq(keysOf(dflt), ['doc/ä/1', 'img/1', 'doc/z', 'doc/ä/2'], 'order');
      }),
  },
  {
    name: 'values round-trip for every storable shape and values: false leaves them off',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        const date = new Date(Date.UTC(2026, 10, 14));
        const rows: VectorRow[] = [
          { key: 'str', vector: v(1, 0, 0), value: 'नमस्ते chunk text' },
          { key: 'bytes', vector: v(0, 1, 0), value: new Uint8Array([1, 2, 3, 250]) },
          {
            key: 'obj',
            vector: v(0, 0, 1),
            value: { page: 3, when: date, tags: ['a', null], nan: NaN },
          },
          { key: 'null', vector: v(1, 1, 0), value: null },
          { key: 'none', vector: v(1, 0, 1) },
          { key: 'zero', vector: v(0, 0, 0), value: 0 },
        ];
        await store.putVectors(NS, rows);
        const hits = await store.query(NS, v(1, 1, 1), 10);
        const byKey = new Map(hits.map((h) => [h.key, h]));
        eq(hits.length, 6);
        await deepEq(byKey.get('str')?.value, 'नमस्ते chunk text', 'string');
        await deepEq(byKey.get('bytes')?.value, new Uint8Array([1, 2, 3, 250]), 'bytes');
        await deepEq(
          byKey.get('obj')?.value,
          { page: 3, when: date, tags: ['a', null], nan: NaN },
          'object',
        );
        ok('value' in byKey.get('null')!, 'a null value is a value');
        eq(byKey.get('null')?.value, null);
        ok(!('value' in byKey.get('none')!), 'a row without a value has no value key');
        eq(byKey.get('zero')?.value, 0);
        const bare = await store.query(NS, v(1, 1, 1), 10, { values: false });
        ok(
          bare.every((h) => !('value' in h)),
          'values: false omits every value',
        );
        await deepEq(keysOf(bare), keysOf(hits), 'same hits');
      }),
  },
  {
    name: 'overwrite and delete across segments: ranking, indexInfo, usage and list follow the live rows',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        await store.putVectors(NS, [
          { key: 'a', vector: v(1, 0) },
          { key: 'b', vector: v(0, 1) },
        ]);
        await store.putVectors(NS, [{ key: 'c', vector: v(1, 1) }]);
        await store.putVectors(NS, [{ key: 'd', vector: v(-1, 0) }]);
        eq((await store.indexInfo(NS))?.segments, 3);
        const re = await store.putVectors(NS, [
          { key: 'a', vector: v(0, -1) },
          { key: 'e', vector: v(1, 0.1) },
        ]);
        await deepEq(re, { written: 2, replaced: 1, rows: 5 });
        await deepEq(
          keysOf(await store.query(NS, v(1, 0), 10)),
          // a = (0,-1) and b = (0,1) both score 0 against (1,0): tied, so key order puts a before b
          ['e', 'c', 'a', 'b', 'd'],
          'after overwrite',
        );
        eq(await store.delete(NS, 'c'), true, 'vector delete reports true');
        eq(await store.delete(NS, 'c'), false, 'a second delete reports false');
        await deepEq(
          keysOf(await store.query(NS, v(1, 0), 10)),
          ['e', 'a', 'b', 'd'],
          'after delete',
        );
        const info = await store.indexInfo(NS);
        eq(info?.rows, 4, 'live rows');
        eq(info?.totalRows, 6, 'rows on disk');
        eq(info?.segments, 4);
        eq(info?.generation, 5);
        const u = await store.usage(NS);
        eq(u.vectorRows, 4);
        ok(
          (u.vectorBytes ?? 0) > 0 && u.bytes >= (u.vectorBytes ?? 0),
          'usage includes vector bytes',
        );
        eq(u.items, 0, 'items count KV only');
        await deepEq((await store.list(NS)).keys, [], 'list counts KV only');
        // replacing a deleted key brings it back
        await store.putVectors(NS, [{ key: 'c', vector: v(1, 0) }]);
        eq((await store.query(NS, v(1, 0), 1))[0]?.key, 'c');
      }),
  },
  {
    name: 'KV values and vectors share a namespace: delete removes both, clear removes both and resets dim',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        await store.set(NS, 'both', 'kv value');
        await store.set(NS, 'kv-only', 1);
        await store.putVectors(NS, [
          { key: 'both', vector: v(1, 0) },
          { key: 'vec-only', vector: v(0, 1) },
        ]);
        eq(await store.get(NS, 'both'), 'kv value');
        await deepEq((await store.list(NS)).keys, ['both', 'kv-only'], 'list is KV only');
        eq((await store.usage(NS)).items, 2);
        eq(await store.delete(NS, 'both'), true);
        eq(await store.get(NS, 'both'), undefined);
        await deepEq(
          keysOf(await store.query(NS, v(1, 0), 10)),
          ['vec-only'],
          'vector row removed too',
        );
        eq(await store.delete(NS, 'vec-only'), true, 'a vector-only key reports true');
        eq(await store.delete(NS, 'kv-only'), true, 'a KV-only key reports true');
        eq(await store.delete(NS, 'nothing'), false);
        await store.putVectors(NS, [{ key: 'x', vector: v(1, 0) }]);
        await store.set(NS, 'k', 2);
        await store.clear(NS);
        eq(await store.indexInfo(NS), undefined, 'the index is gone');
        eq(await store.get(NS, 'k'), undefined, 'KV is gone');
        await deepEq(await store.query(NS, v(1, 0), 5), [], 'query after clear');
        await store.putVectors(NS, [{ key: 'again', vector: v(1, 0, 0) }]);
        eq((await store.indexInfo(NS))?.dim, 3, 'dim is fixed again by the next write');
      }),
  },
  {
    name: 'putVectors: an empty iterable is a no-op, an async iterable streams, the result counts rows',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        await deepEq(await store.putVectors(NS, []), { written: 0, replaced: 0, rows: 0 });
        eq(await store.indexInfo(NS), undefined, 'an empty first call creates no index');
        async function* gen(): AsyncGenerator<VectorRow> {
          for (let i = 0; i < 10; i++) {
            await Promise.resolve();
            yield synthRow(i, { dim: 8 });
          }
        }
        await deepEq(await store.putVectors(NS, gen()), { written: 10, replaced: 0, rows: 10 });
        await deepEq(await store.putVectors(NS, []), { written: 0, replaced: 0, rows: 10 });
        await rejectsWith(store.putVectors(NS, 42 as unknown as VectorRow[]), 'invalid_value');
        await rejectsWith(store.putVectors('NOT VALID', []), 'invalid_namespace');
        eq((await store.indexInfo(NS))?.rows, 10);
      }),
  },
  {
    name: 'a reserved namespace is refused for every vector call',
    run: (env) =>
      withStore(env, undefined, async (store) => {
        for (const ns of ['__ld_vec.vecs', '__ld_meta']) {
          await rejectsWith(store.putVectors(ns, []), 'invalid_namespace');
          await rejectsWith(store.query(ns, v(1), 1), 'invalid_namespace');
          await rejectsWith(store.indexInfo(ns), 'invalid_namespace');
        }
      }),
  },
  {
    name: 'every call after close rejects with closed, vector calls included',
    run: async (env) => {
      const store = await env.makeStore();
      await store.putVectors(NS, [{ key: 'a', vector: v(1, 0) }]);
      await store.close();
      await rejectsWith(store.putVectors(NS, []), 'closed');
      await rejectsWith(store.query(NS, v(1, 0), 1), 'closed');
      await rejectsWith(store.indexInfo(NS), 'closed');
    },
  },
  {
    name: 'corruption: a flipped byte in a vec part, a meta part, HEAD or a value is corrupt with details.reason',
    run: async (env) => {
      const cases: Array<[string, string, string, string]> = [
        ['vec-0/00000', 'crc', 'vec-0', 'vector part'],
        ['meta-0/00000', 'crc', 'meta-0', 'meta part'],
        ['head', 'crc', 'head', 'HEAD'],
        ['val-0/00000', 'value_crc', 'val-0/00000', 'value'],
      ];
      for (const [name, reason, file] of cases) {
        const first = await env.makeStore();
        await first.putVectors(NS, [...synthRows(0, 40, { dim: 16, chunkBytes: 64 })]);
        await first.close();
        await flip(env, name);
        const store = await env.reopen();
        try {
          await expectCorrupt(store, reason, file, () => store.query(NS, synthQuery(0, 16), 40));
          if (name !== 'val-0/00000') {
            await rejectsWith(store.indexInfo(NS), 'corrupt');
            await rejectsWith(store.putVectors(NS, [synthRow(100, { dim: 16 })]), 'corrupt');
            await rejectsWith(store.delete(NS, synthKey(1)), 'corrupt');
          }
          // KV operations on the namespace are unaffected
          await store.set(NS, 'kv', 'still works');
          eq(await store.get(NS, 'kv'), 'still works');
          // clear recovers
          await store.clear(NS);
          await deepEq(await store.query(NS, synthQuery(0, 16), 5), [], 'after clear');
          await store.putVectors(NS, [synthRow(0, { dim: 16 })]);
          eq((await store.query(NS, synthQuery(0, 16), 5)).length, 1);
        } finally {
          await store.close();
        }
      }
    },
  },
  {
    name: 'corruption: a truncated part and a missing part are corrupt (length, missing_part)',
    run: async (env) => {
      for (const [mode, reason] of [
        ['truncate', 'length'],
        ['remove', 'missing_part'],
      ] as const) {
        const first = await env.makeStore();
        await first.putVectors(NS, [...synthRows(0, 40, { dim: 16 })]);
        await first.close();
        const d = await env.raw();
        try {
          const rec = await d.getBytes(VNS, 'vec-0/00000');
          ok(rec !== undefined, 'vec part exists');
          if (mode === 'truncate') {
            const b = rec.bytes.slice(0, rec.bytes.length - 1);
            await d.put(VNS, 'vec-0/00000', b, { size: b.length });
          } else await d.del(VNS, 'vec-0/00000');
        } finally {
          await d.close();
        }
        const store = await env.reopen();
        try {
          await expectCorrupt(store, reason, 'vec-0', () => store.query(NS, synthQuery(0, 16), 40));
        } finally {
          await store.close();
        }
      }
    },
  },
];

/** Registers every case with a test framework or any (name, fn) collector. */
export function runVectorSuite(
  env: VectorEnv,
  define: (name: string, fn: () => Promise<void>) => unknown,
): void {
  for (const c of vectorCases) define(c.name, () => c.run(env));
}

export interface VectorSuiteResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/** Runs every case sequentially and returns results (used by the browser harness). */
export async function collectVectorSuite(env: VectorEnv): Promise<VectorSuiteResult[]> {
  const results: VectorSuiteResult[] = [];
  for (const c of vectorCases) {
    const t0 = performance.now();
    try {
      await c.run(env);
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
