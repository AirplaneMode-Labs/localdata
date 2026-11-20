// Shared helpers of the handle-table tests (test/ann-evict.test.ts): a driver that holds a writer
// mid-commit, 20-row namespaces of dim 4 with distinct seeded scores, and a query helper. The same
// shapes test/ann-quota.test.ts uses.
import { mulberry32 } from '../bench/synth';
import type { VectorRow } from '../src/contracts/storage-api';
import { MemoryDriver } from '../src/drivers/memory';
import type { Event, LocalData } from '../src/index';
import { f32Bits } from '../src/vec/reference';

/** put() holds the first write to the named driver namespaces until release(): a writer caught mid-commit. */
export class Gated extends MemoryDriver {
  private gateNs = new Set<string>();
  readonly held = new Set<string>();
  private gate: Promise<void> = Promise.resolve();
  private open_: () => void = () => undefined;
  writes = 0;

  arm(namespaces: Iterable<string>): void {
    this.gateNs = new Set(namespaces);
    this.held.clear();
    this.gate = new Promise<void>((r) => (this.open_ = r));
  }

  release(): void {
    this.gateNs.clear();
    this.open_();
  }

  override async put(...a: Parameters<MemoryDriver['put']>) {
    if (this.gateNs.has(a[0])) {
      this.held.add(a[0]);
      await this.gate;
    }
    this.writes++;
    return super.put(...a);
  }
  override async del(...a: Parameters<MemoryDriver['del']>) {
    this.writes++;
    return super.del(...a);
  }
  override async clear(...a: Parameters<MemoryDriver['clear']>) {
    this.writes++;
    return super.clear(...a);
  }
}

export const TINY_PARAMS = { kind: 'hnsw', m: 4, efConstruction: 8, seed: 1 } as const;
export const tinyNs = (i: number) => `ns${i}`;

/** 20 rows of dim 4 for namespace i: seeded, integer-driven, distinct scores. */
export function tinyRows(i: number): VectorRow[] {
  const next = mulberry32(0x5eed0000 + i);
  return Array.from({ length: 20 }, (_, r) => ({
    key: `k${r}`,
    vector: Float32Array.from({ length: 4 }, () => ((next() >>> 8) / 16777216) * 2 - 1),
  }));
}
export function tinyQuery(i: number): Float32Array {
  const next = mulberry32(0x9e370000 + i);
  return Float32Array.from({ length: 4 }, () => ((next() >>> 8) / 16777216) * 2 - 1);
}
export type Answer = Array<[string, number]>;
export async function ask(store: LocalData, i: number, index?: 'hnsw'): Promise<Answer> {
  const hits = await store.query(tinyNs(i), tinyQuery(i), 5, {
    values: false,
    ...(index === undefined ? {} : { index }),
  });
  return hits.map((h) => [h.key, f32Bits(h.score)]);
}
export const lastQuery = (events: Event[]) =>
  events.filter((e) => e.name === 'storage.query').at(-1)!;
/** The namespaces whose stored graph was read (storage.index.open of kind hnsw), in order. */
export const annOpens = (events: Event[]) =>
  events
    .filter((e) => e.name === 'storage.index.open' && e.attrs['kind'] === 'hnsw')
    .map((e) => e.attrs['ns']);
