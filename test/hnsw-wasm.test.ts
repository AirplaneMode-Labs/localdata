// D4-03 (TD-65): the HNSW kernel through the production WASM boundary (src/vec/kernel.ts), SIMD and
// scalar builds. The Rust tests (crates/ldvec/tests/hnsw.rs) cover the logic natively; these prove the
// WebAssembly builds themselves:
//   * the TypeScript integer-only generator gives the fixture's input sha256, and the graph built in
//     WASM has the fixture's graph sha256: the SAME bytes as the native build
//   * hits carry the flat scan's scores bit for bit
//   * every validation failure is a negative code and never a trap; an over-large declared count with a
//     short file is refused without trapping; bad handles and bad block tables are E_ARGS
//   * a seeded fuzz through the WASM validator causes no trap
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clusteredCentres, clusteredPoints, clusteredSet } from '../bench/synth';
import { E_ARGS, Kernel, type KernelKind } from '../src/vec/kernel';

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
  generation: number;
  ns: string;
  inputSha256: string;
  graphBytes: number;
  graphSha256: string;
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ENC = new TextEncoder();

/** A block table and its memory inside one kernel instance; free() releases everything. */
class Rows {
  private readonly blocks: Array<[number, number]> = [];
  readonly total: number;
  readonly tablePtr: number;
  readonly nBlocks: number;
  constructor(
    readonly k: Kernel,
    readonly dim: number,
    vec: Float32Array,
    cuts: number[] = [],
  ) {
    this.total = vec.length / dim;
    const bounds = [0, ...cuts, this.total];
    const table: number[] = [];
    for (let b = 0; b + 1 < bounds.length; b++) {
      const first = bounds[b]!;
      const rows = bounds[b + 1]! - first;
      const vp = k.alloc(rows * dim * 4);
      const np = k.alloc(rows * 4);
      k.f32(vp, rows * dim).set(vec.subarray(first * dim, (first + rows) * dim));
      expect(k.invNorms(vp, rows, dim, np)).toBe(0);
      this.blocks.push([vp, rows * dim * 4], [np, rows * 4]);
      table.push(first, rows, vp, np);
    }
    this.nBlocks = bounds.length - 1;
    this.tablePtr = k.alloc(table.length * 4);
    k.u32(this.tablePtr, table.length).set(table);
    this.blocks.push([this.tablePtr, table.length * 4]);
  }
  free(): void {
    for (const [p, n] of this.blocks) this.k.free(p, n);
  }
}

function put(k: Kernel, bytes: Uint8Array): number {
  const p = k.alloc(Math.max(1, bytes.byteLength));
  k.u8(p, bytes.byteLength).set(bytes);
  return p;
}

interface BuildArgs {
  metric?: number;
  m?: number;
  efc?: number;
  seed?: number;
  generation?: number;
  ns?: string;
  tomb?: Uint8Array;
}

function build(k: Kernel, rows: Rows, a: BuildArgs = {}): number {
  const ns = put(k, ENC.encode(a.ns ?? 'ns'));
  const tomb = a.tomb && a.tomb.length > 0 ? put(k, a.tomb) : 0;
  try {
    return k.hnswBuild(
      rows.tablePtr,
      rows.nBlocks,
      rows.total,
      rows.dim,
      tomb,
      a.tomb?.length ?? 0,
      ns,
      ENC.encode(a.ns ?? 'ns').length,
      a.metric ?? 0,
      a.m ?? 16,
      a.efc ?? 200,
      a.seed ?? 1,
      a.generation ?? 1,
    );
  } finally {
    k.free(ns, Math.max(1, ENC.encode(a.ns ?? 'ns').length));
    if (tomb) k.free(tomb, a.tomb!.length);
  }
}

function serialize(k: Kernel, h: number): Uint8Array {
  const len = k.hnswSerializeLen(h);
  expect(len).toBeGreaterThan(0);
  const p = k.alloc(len);
  try {
    expect(k.hnswSerialize(h, p, len)).toBe(0);
    return k.u8(p, len).slice();
  } finally {
    k.free(p, len);
  }
}

function load(
  k: Kernel,
  bytes: Uint8Array,
  e: { dim: number; rows: number; generation: number; ns: string },
): number {
  const p = put(k, bytes);
  const nsb = ENC.encode(e.ns);
  const np = put(k, nsb);
  try {
    return k.hnswLoad(p, bytes.byteLength, e.dim, e.rows, e.generation, np, nsb.length);
  } finally {
    k.free(p, Math.max(1, bytes.byteLength));
    k.free(np, Math.max(1, nsb.length));
  }
}

function search(
  k: Kernel,
  h: number,
  rows: Rows,
  q: Float32Array,
  ef: number,
  tomb: Uint8Array = new Uint8Array(0),
): Array<{ ordinal: number; scoreBits: number }> | number {
  const qp = put(k, new Uint8Array(q.buffer, q.byteOffset, q.byteLength));
  const tp = tomb.length > 0 ? put(k, tomb) : 0;
  const outCap = ef;
  const op = k.alloc(Math.max(8, outCap * 8));
  try {
    const n = k.hnswSearch(
      h,
      rows.tablePtr,
      rows.nBlocks,
      rows.total,
      tp,
      tomb.length,
      qp,
      ef,
      op,
      outCap,
    );
    if (n < 0) return n;
    const w = k.u32(op, n * 2);
    const out: Array<{ ordinal: number; scoreBits: number }> = [];
    for (let i = 0; i < n; i++) out.push({ ordinal: w[2 * i]!, scoreBits: w[2 * i + 1]! });
    return out;
  } finally {
    k.free(qp, q.byteLength);
    if (tp) k.free(tp, tomb.length);
    k.free(op, Math.max(8, outCap * 8));
  }
}

const f32Bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]!;

describe('the integer-only generator', () => {
  it('reproduces the input sha256 of the determinism fixture (the same bytes as Rust)', () => {
    const { rows } = clusteredSet(fixture.seed, fixture.centres, fixture.dim, fixture.rows, 1);
    expect(sha256(new Uint8Array(rows.buffer))).toBe(fixture.inputSha256);
  });

  it('is a prefix-stable stream and every component is exact in binary32', () => {
    const c = clusteredCentres(3, 5, 16);
    const a = clusteredPoints(c, 16, 3, 'data', 10);
    const b = clusteredPoints(c, 16, 3, 'data', 4);
    expect(Array.from(b)).toEqual(Array.from(a.subarray(0, 4 * 16)));
    const q = clusteredPoints(c, 16, 3, 'query', 4);
    expect(Array.from(q)).not.toEqual(Array.from(b));
    for (const x of a) expect(Math.fround(x * 65536)).toBe(x * 65536);
  });
});

for (const kind of ['simd', 'scalar'] as KernelKind[]) {
  describe(`ldvec HNSW through WASM (${kind})`, () => {
    it('builds the fixture graph: the same sha256 as the native build', async () => {
      const k = await Kernel.create(kind);
      const { rows: vec } = clusteredSet(
        fixture.seed,
        fixture.centres,
        fixture.dim,
        fixture.rows,
        1,
      );
      const rows = new Rows(k, fixture.dim, vec);
      const h = build(k, rows, {
        m: fixture.m,
        efc: fixture.efConstruction,
        seed: fixture.graphSeed,
        generation: fixture.generation,
        ns: fixture.ns,
      });
      expect(h).toBeGreaterThan(0);
      const bytes = serialize(k, h);
      const sha = sha256(bytes);
      console.log(`HNSW-WASM ${kind} graph bytes ${bytes.length} sha256 ${sha}`);
      expect(bytes.length).toBe(fixture.graphBytes);
      expect(sha).toBe(fixture.graphSha256);
      k.hnswFree(h);
      rows.free();
    }, 120_000);

    it('splits the rows over several blocks without changing a byte', async () => {
      const k = await Kernel.create(kind);
      const { rows: vec } = clusteredSet(11, 6, 24, 600, 1);
      const one = new Rows(k, 24, vec);
      const many = new Rows(k, 24, vec, [100, 101, 399]);
      const a = serialize(k, build(k, one, { m: 8, efc: 50, seed: 2, ns: 'blk' }));
      const b = serialize(k, build(k, many, { m: 8, efc: 50, seed: 2, ns: 'blk' }));
      expect(sha256(a)).toBe(sha256(b));
    });

    it('hit scores are the flat scan scores, bit for bit, best first', async () => {
      const k = await Kernel.create(kind);
      const dim = 40;
      const { rows: vec, queries } = clusteredSet(5, 10, dim, 1_200, 10);
      const rows = new Rows(k, dim, vec, [500]);
      const h = build(k, rows, { m: 12, efc: 100, seed: 3, ns: 'bits' });
      // flat scores through the production scan kernel
      const norms = k.alloc(1_200 * 4);
      const vp = put(k, new Uint8Array(vec.buffer));
      const out = k.alloc(1_200 * 4);
      expect(k.invNorms(vp, 1_200, dim, norms)).toBe(0);
      for (let i = 0; i < 10; i++) {
        const q = queries.subarray(i * dim, (i + 1) * dim);
        const qp = put(k, new Uint8Array(q.buffer, q.byteOffset, q.byteLength));
        const qn = k.alloc(4);
        k.invNorms(qp, 1, dim, qn);
        const qInv = k.f32(qn, 1)[0]!;
        expect(k.scan(vp, 1_200, dim, norms, qp, qInv, 0, out)).toBe(0);
        const flat = k.f32(out, 1_200).slice();
        const hits = search(k, h, rows, q, 64);
        expect(Array.isArray(hits)).toBe(true);
        const list = hits as Array<{ ordinal: number; scoreBits: number }>;
        expect(list.length).toBeGreaterThan(0);
        for (const hit of list) expect(hit.scoreBits).toBe(f32Bits(flat[hit.ordinal]!));
        for (let j = 1; j < list.length; j++) {
          const a = new Float32Array(new Uint32Array([list[j - 1]!.scoreBits]).buffer)[0]!;
          const b = new Float32Array(new Uint32Array([list[j]!.scoreBits]).buffer)[0]!;
          expect(a >= b).toBe(true);
        }
        k.free(qp, q.byteLength);
        k.free(qn, 4);
      }
      k.free(norms, 1_200 * 4);
      k.free(vp, vec.byteLength);
      k.free(out, 1_200 * 4);
    });

    it('insert, mark_deleted and set_generation round-trip through serialise and load', async () => {
      const k = await Kernel.create(kind);
      const dim = 16;
      const { rows: vec } = clusteredSet(8, 4, dim, 300, 1);
      const first = new Rows(k, dim, vec.subarray(0, 200 * dim));
      const h = build(k, first, { m: 8, efc: 40, seed: 4, generation: 2, ns: 'inc' });
      const all = new Rows(k, dim, vec);
      expect(k.hnswInsert(h, all.tablePtr, all.nBlocks, all.total, 200, 100)).toBe(0);
      expect(k.hnswMarkDeleted(h, 7)).toBe(1);
      expect(k.hnswMarkDeleted(h, 7)).toBe(0);
      expect(k.hnswMarkDeleted(h, 100_000)).toBe(0);
      expect(k.hnswSetGeneration(h, 3)).toBe(0);
      const bytes = serialize(k, h);
      const info = k.alloc(12 * 4);
      expect(k.hnswInfo(h, info)).toBe(0);
      const w = k.u32(info, 12);
      expect(Array.from(w.subarray(5, 9))).toEqual([300, 299, 3, w[8]!]); // nodes, live, generation
      const again = load(k, bytes, { dim, rows: 300, generation: 3, ns: 'inc' });
      expect(again).toBeGreaterThan(0);
      expect(sha256(serialize(k, again))).toBe(sha256(bytes));
      // inserting an ordinal that is not above the last, or past the block table, is an error code
      expect(k.hnswInsert(again, all.tablePtr, all.nBlocks, all.total, 10, 1)).toBeLessThan(0);
    });

    it('validation failures are negative codes, never traps', async () => {
      const k = await Kernel.create(kind);
      const dim = 8;
      const { rows: vec } = clusteredSet(21, 4, dim, 60, 1);
      const rows = new Rows(k, dim, vec);
      const good = serialize(
        k,
        build(k, rows, { m: 4, efc: 20, seed: 9, generation: 5, ns: 'ns.a' }),
      );
      const e = { dim, rows: 60, generation: 5, ns: 'ns.a' };
      expect(load(k, good, e)).toBeGreaterThan(0);
      for (let cut = 0; cut < good.length; cut += 7)
        expect(load(k, good.slice(0, cut), e)).toBe(-22);
      const flipped = good.slice();
      flipped[good.length >> 1]! ^= 1;
      expect(load(k, flipped, e)).toBeLessThan(0);
      expect(load(k, good, { ...e, ns: 'ns.b' })).toBe(-24);
      expect(load(k, good, { ...e, dim: 9 })).toBe(-23);
      expect(load(k, good, { ...e, generation: 4 })).toBe(-25);
      const magic = good.slice();
      magic[0] = 0x58;
      expect(load(k, magic, e)).toBe(-20);
      // an over-large declared node count (with the CRC fixed up): a negative code, no trap
      const huge = good.slice();
      new DataView(huge.buffer).setUint32(32, 0xffff_ffff, true);
      recrc(k, huge);
      expect(load(k, huge, e)).toBe(-26);
      const hugeWords = good.slice();
      new DataView(hugeWords.buffer).setUint32(48, 0xffff_ffff, true);
      recrc(k, hugeWords);
      expect(load(k, hugeWords, e)).toBe(-22);
      expect(k.alive).toBe(true);
    });

    it('bad handles, bad block tables and bad arguments are E_ARGS', async () => {
      const k = await Kernel.create(kind);
      const dim = 8;
      const { rows: vec } = clusteredSet(2, 2, dim, 20, 1);
      const rows = new Rows(k, dim, vec);
      const h = build(k, rows, { m: 4, efc: 20, ns: 'ns' });
      const q = vec.subarray(0, dim);
      expect(search(k, 0, rows, q, 10)).toBe(E_ARGS);
      expect(search(k, h + 5, rows, q, 10)).toBe(E_ARGS);
      expect(k.hnswSerializeLen(h + 5)).toBe(E_ARGS);
      expect(k.hnswMarkDeleted(h + 5, 1)).toBe(E_ARGS);
      // a table whose rows do not add up to the HEAD total, and a table pointing outside memory
      const bad = new Rows(k, dim, vec.subarray(0, 10 * dim));
      expect(k.hnswSearch(h, bad.tablePtr, bad.nBlocks, 20, 0, 0, 0, 10, 0, 10)).toBe(E_ARGS);
      const wild = k.alloc(16);
      k.u32(wild, 4).set([0, 20, 0x7fff_fff0, 0x7fff_fff0]);
      expect(k.hnswBuild(wild, 1, 20, dim, 0, 0, 0, 0, 0, 4, 20, 1, 1)).toBe(E_ARGS);
      // ef 0 and ef above the maximum, a query with a NaN component
      expect(search(k, h, rows, q, 0)).toBeLessThan(0);
      const nan = new Float32Array(q);
      nan[0] = NaN;
      expect(search(k, h, rows, nan, 10)).toBeLessThan(0);
      expect(k.alive).toBe(true);
    });

    it('a seeded fuzz of 2,000 mutations through the WASM validator causes no trap', async () => {
      const k = await Kernel.create(kind);
      const dim = 8;
      const { rows: vec } = clusteredSet(21, 4, dim, 60, 1);
      const rows = new Rows(k, dim, vec);
      const good = serialize(
        k,
        build(k, rows, { m: 4, efc: 20, seed: 9, generation: 5, ns: 'ns.a' }),
      );
      const e = { dim, rows: 60, generation: 5, ns: 'ns.a' };
      let a = 0x1d4_0003;
      const rnd = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      let accepted = 0;
      for (let i = 0; i < 2_000; i++) {
        let m = good.slice();
        for (let r = 1 + Math.floor(rnd() * 3); r > 0; r--) {
          const at = Math.floor(rnd() * m.length);
          const kind = Math.floor(rnd() * 4);
          if (kind === 0) m[at]! ^= 1 << Math.floor(rnd() * 8);
          else if (kind === 1) m[at] = Math.floor(rnd() * 256);
          else if (kind === 2) m = m.slice(0, at);
          else if (m.length >= 4 && at + 4 <= m.length)
            new DataView(m.buffer).setUint32(
              at,
              [0, 1, 17, 59, 60, 0xffff_ffff][Math.floor(rnd() * 6)]!,
              true,
            );
        }
        if (m.length >= 4 && rnd() < 0.5) recrc(k, m);
        const h = load(k, m, e);
        if (h > 0) {
          accepted++;
          const hits = search(k, h, rows, vec.subarray(0, dim), 30);
          expect(Array.isArray(hits)).toBe(true);
          for (const hit of hits as Array<{ ordinal: number }>)
            expect(hit.ordinal).toBeLessThan(60);
          k.hnswFree(h);
        } else expect(h).toBeLessThan(0);
        expect(k.alive).toBe(true);
      }
      console.log(`HNSW-WASM-FUZZ ${kind} mutations 2000 traps 0 accepted ${accepted}`);
    }, 120_000);
  });
}

function recrc(k: Kernel, b: Uint8Array): void {
  const n = b.length;
  const p = put(k, b.subarray(0, n - 4));
  try {
    new DataView(b.buffer, b.byteOffset).setUint32(n - 4, k.crc32c(0, p, n - 4), true);
  } finally {
    k.free(p, n - 4);
  }
}
