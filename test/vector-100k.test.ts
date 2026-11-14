// D4-03 acceptance: at 100,000 rows, 20 seeded queries, both metrics, k in {1, 10, 100}: hits and scores
// equal an independent Math.fround reference bit for bit, on the SIMD module and on the scalar module.
// The reference scores every row once per (query, metric) with src/vec/reference.ts and sorts with a
// UTF-8 byte-order comparator that shares no code with the index.
import { describe, expect, it } from 'vitest';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore } from '../src/index';
import { simdSupported } from '../src/vec/kernel';
import { compareUtf8Ref, f32Bits, invNormRef, scoreRef } from '../src/vec/reference';
import { DIM, synthKey, synthQuery, synthRows } from '../bench/synth';

const ROWS = 100_000;
const QUERIES = 20;

describe('100,000 rows against the reference', () => {
  for (const kernel of ['simd', 'scalar'] as const) {
    it(`${kernel}: ${QUERIES} seeded queries x cosine and dot x k in {1, 10, 100} are bit-identical`, async (ctx) => {
      if (kernel === 'simd' && !simdSupported()) return ctx.skip();
      const store = await createStore({ driver: new MemoryDriver(), vectorKernel: kernel });
      try {
        // one pass over the generator feeds the store and fills the reference's copy
        const all = new Float32Array(ROWS * DIM);
        const rows = (function* () {
          let i = 0;
          for (const r of synthRows(0, ROWS)) {
            all.set(r.vector, i * DIM);
            i++;
            yield r;
          }
        })();
        await store.putVectors('big', rows);
        expect((await store.indexInfo('big'))?.kernel).toBe(kernel);
        const inv = new Float32Array(ROWS);
        for (let i = 0; i < ROWS; i++) inv[i] = invNormRef(all.subarray(i * DIM, (i + 1) * DIM));
        const keys = Array.from({ length: ROWS }, (_, i) => synthKey(i));
        for (let j = 0; j < QUERIES; j++) {
          const q = synthQuery(j);
          const qInv = invNormRef(q);
          for (const metric of ['cosine', 'dot'] as const) {
            const score = new Float32Array(ROWS);
            for (let i = 0; i < ROWS; i++)
              score[i] = scoreRef(all.subarray(i * DIM, (i + 1) * DIM), inv[i]!, q, qInv, metric);
            const order = Array.from({ length: ROWS }, (_, i) => i).sort((a, b) =>
              score[a]! !== score[b]!
                ? score[a]! > score[b]!
                  ? -1
                  : 1
                : compareUtf8Ref(keys[a]!, keys[b]!),
            );
            for (const k of [1, 10, 100]) {
              const hits = await store.query('big', q, k, { metric, values: false });
              const want = order.slice(0, k);
              expect(
                hits.map((h) => h.key),
                `q${j} ${metric} k${k} keys`,
              ).toEqual(want.map((i) => keys[i]));
              expect(
                hits.map((h) => f32Bits(h.score)),
                `q${j} ${metric} k${k} scores`,
              ).toEqual(want.map((i) => f32Bits(score[i]!)));
            }
          }
        }
      } finally {
        await store.close();
      }
    }, 900_000);
  }
});
