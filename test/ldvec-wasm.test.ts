// D4-02: the two embedded ldvec modules, driven through the production boundary (src/vec/kernel.ts)
// in Node. The Rust unit tests cover the logic natively; these prove the WASM builds themselves:
// size, the simd flag, opcode content, and bit-equal SIMD and scalar results.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E_ARGS, Kernel, simdSupported, type KernelKind } from '../src/vec/kernel';
import { dot4Ref, f32Bits, invNormRef, scoreRef } from '../src/vec/reference';
import { relaxedSimdOpcodes, scanCode, SIMD_PREFIX } from './wasm-opcodes';

const root = join(import.meta.dirname, '..');
const wasmPath = (kind: KernelKind) =>
  join(root, 'target', `wasm-${kind}`, 'wasm32-unknown-unknown', 'release', 'ldvec.wasm');

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRows(seed: number, rows: number, dim: number): Float32Array {
  const r = rng(seed);
  const v = new Float32Array(rows * dim);
  for (let i = 0; i < v.length; i++) v[i] = r() * 2 - 1;
  return v;
}

/** Runs inv_norms and scan for both metrics in one kernel; returns the f32 bit patterns. */
async function run(
  kind: KernelKind,
  data: Float32Array,
  rows: number,
  dim: number,
  q: Float32Array,
) {
  const k = await Kernel.create(kind);
  const vecPtr = k.alloc(data.byteLength);
  k.f32(vecPtr, data.length).set(data);
  const normsPtr = k.alloc(rows * 4);
  const qPtr = k.alloc(dim * 4);
  k.f32(qPtr, dim).set(q);
  const qn = k.alloc(4);
  const outPtr = k.alloc(rows * 4);
  expect(k.checkRows(vecPtr, rows, dim)).toBe(-1);
  expect(k.invNorms(vecPtr, rows, dim, normsPtr)).toBe(0);
  expect(k.invNorms(qPtr, 1, dim, qn)).toBe(0);
  const qInv = k.f32(qn, 1)[0]!;
  const norms = Array.from(k.f32(normsPtr, rows), f32Bits);
  const scores: Record<string, number[]> = {};
  for (const [name, metric] of [
    ['cosine', 0],
    ['dot', 1],
  ] as const) {
    expect(k.scan(vecPtr, rows, dim, normsPtr, qPtr, qInv, metric, outPtr)).toBe(0);
    scores[name] = Array.from(k.f32(outPtr, rows), f32Bits);
  }
  return { norms, qInv: f32Bits(qInv), scores, simd: k.simd() };
}

describe('the embedded modules', () => {
  for (const kind of ['simd', 'scalar'] as const) {
    it(`${kind}: under 100 KB, and ldv_simd() says ${kind === 'simd' ? 1 : 0}`, async () => {
      const bytes = readFileSync(wasmPath(kind));
      expect(bytes.length).toBeLessThan(100 * 1024);
      if (kind === 'simd' && !simdSupported()) return;
      const k = await Kernel.create(kind);
      expect(k.simd()).toBe(kind === 'simd' ? 1 : 0);
      expect(k.kind).toBe(kind);
    });
  }

  it('both modules export the ten HNSW functions and the size budget holds with them (TD-65: the graph adds 40 to 45 KB)', () => {
    const NAMES = [
      'ldv_hnsw_build',
      'ldv_hnsw_load',
      'ldv_hnsw_info',
      'ldv_hnsw_insert',
      'ldv_hnsw_mark_deleted',
      'ldv_hnsw_set_generation',
      'ldv_hnsw_search',
      'ldv_hnsw_serialize_len',
      'ldv_hnsw_serialize',
      'ldv_hnsw_free',
    ];
    for (const kind of ['simd', 'scalar'] as const) {
      const mod = new WebAssembly.Module(readFileSync(wasmPath(kind)));
      const exported = WebAssembly.Module.exports(mod).map((e) => e.name);
      for (const n of NAMES) expect(exported, `${kind} exports ${n}`).toContain(n);
      // The Sprint 5 modules were 34 and 37 KB; the budget (100 KB) is unchanged, not loosened.
      expect(readFileSync(wasmPath(kind)).length).toBeLessThan(100 * 1024);
    }
  });

  it('the scalar build contains no 0xFD-prefixed (SIMD) instruction', () => {
    const scan = scanCode(readFileSync(wasmPath('scalar')));
    expect(scan.functions).toBeGreaterThan(5);
    expect(scan.single.get(SIMD_PREFIX) ?? 0).toBe(0);
    expect(scan.simd.size).toBe(0);
  });

  it('the SIMD build uses SIMD, and neither build has a relaxed-simd instruction', () => {
    const simd = scanCode(readFileSync(wasmPath('simd')));
    expect(simd.single.get(SIMD_PREFIX) ?? 0).toBeGreaterThan(0);
    // f32x4.mul (0xe6) and f32x4.add (0xe4) are the instructions the scan is built from.
    expect(simd.simd.has(0xe6)).toBe(true);
    expect(simd.simd.has(0xe4)).toBe(true);
    expect(relaxedSimdOpcodes(simd)).toEqual([]);
    expect(relaxedSimdOpcodes(scanCode(readFileSync(wasmPath('scalar'))))).toEqual([]);
  });

  it('the opcode walker itself finds a SIMD instruction in a known module', () => {
    // (module (func (result v128) i32.const 0 v128.load8_splat...)) is overkill: use the probe module.
    const probe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
      15, 253, 98, 11,
    ]);
    const scan = scanCode(probe);
    expect(scan.simd.get(0x0f)).toBe(1); // i8x16.splat
    expect(scan.simd.get(0x62)).toBe(1); // i8x16.popcnt
  });
});

describe('CRC-32C through the module', () => {
  for (const kind of ['simd', 'scalar'] as const) {
    it(`${kind}: the check value and incremental use`, async () => {
      if (kind === 'simd' && !simdSupported()) return;
      const k = await Kernel.create(kind);
      const text = new TextEncoder().encode('123456789');
      const p = k.alloc(16);
      k.u8(p, 9).set(text);
      expect(k.crc32c(0, p, 9)).toBe(0xe3069283);
      expect(k.crc32c(k.crc32c(0, p, 4), p + 4, 5)).toBe(0xe3069283);
      expect(k.crc32c(0xdeadbeef, p, 0)).toBe(0xdeadbeef);
    });
  }
});

describe('scan results', () => {
  const dims = [1, 3, 4, 5, 383, 384, 4096];

  it('scalar equals the Math.fround reference bit for bit at every dim', async () => {
    for (const dim of dims) {
      const rows = dim === 4096 ? 24 : 150;
      const data = randomRows(dim, rows, dim);
      const q = randomRows(dim + 1000, 1, dim);
      const res = await run('scalar', data, rows, dim, q);
      const qInv = invNormRef(q);
      expect(res.qInv, `qInv dim ${dim}`).toBe(f32Bits(qInv));
      for (let i = 0; i < rows; i++) {
        const row = data.subarray(i * dim, (i + 1) * dim);
        expect(res.norms[i], `norm dim ${dim} row ${i}`).toBe(f32Bits(invNormRef(row)));
        for (const metric of ['cosine', 'dot'] as const) {
          const want = scoreRef(row, invNormRef(row), q, qInv, metric);
          expect(res.scores[metric]![i], `${metric} dim ${dim} row ${i}`).toBe(f32Bits(want));
        }
      }
    }
  });

  it('SIMD and scalar give bitwise-equal norms and score buffers at dims {1, 3, 4, 5, 383, 384, 4096}', async () => {
    if (!simdSupported()) return;
    for (const dim of dims) {
      const rows = dim === 4096 ? 24 : 150;
      const data = randomRows(dim * 7, rows, dim);
      const q = randomRows(dim * 7 + 1, 1, dim);
      const a = await run('simd', data, rows, dim, q);
      const b = await run('scalar', data, rows, dim, q);
      expect(a.simd).toBe(1);
      expect(b.simd).toBe(0);
      expect(a.norms, `norms dim ${dim}`).toEqual(b.norms);
      expect(a.qInv).toBe(b.qInv);
      expect(a.scores['cosine'], `cosine dim ${dim}`).toEqual(b.scores['cosine']);
      expect(a.scores['dot'], `dot dim ${dim}`).toEqual(b.scores['dot']);
    }
  });

  it('dot4 order: a case where four lanes and a running sum disagree is scored in lane order', async () => {
    // Ill-conditioned data makes the accumulation order observable.
    const dim = 64;
    const r = rng(5);
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      a[i] = (r() * 2 - 1) * 1e6;
      b[i] = r() * 2 - 1;
    }
    let running = 0;
    for (let i = 0; i < dim; i++) running = Math.fround(running + Math.fround(a[i]! * b[i]!));
    expect(f32Bits(dot4Ref(a, b))).not.toBe(f32Bits(running));
    for (const kind of ['simd', 'scalar'] as const) {
      if (kind === 'simd' && !simdSupported()) continue;
      const res = await run(kind, a, 1, dim, b);
      expect(res.scores['dot']![0]).toBe(f32Bits(dot4Ref(a, b)));
    }
  });

  it('-0 scores become +0 and a zero row scores 0 under cosine, in both builds', async () => {
    for (const kind of ['simd', 'scalar'] as const) {
      if (kind === 'simd' && !simdSupported()) continue;
      const data = new Float32Array([0, 1, -0, 1, 0, 0]);
      const q = new Float32Array([-1, 0]);
      const res = await run(kind, data, 3, 2, q);
      for (const metric of ['cosine', 'dot']) expect(res.scores[metric]).toEqual([0, 0, 0]);
    }
  });

  it('check_rows reports the first row that is non-finite or whose selfDot exceeds 1e30', async () => {
    for (const kind of ['simd', 'scalar'] as const) {
      if (kind === 'simd' && !simdSupported()) continue;
      const k = await Kernel.create(kind);
      const ptr = k.alloc(4 * 3 * 4);
      const v = k.f32(ptr, 12);
      v.fill(0.5);
      expect(k.checkRows(ptr, 4, 3)).toBe(-1);
      v[3 * 3 + 2] = Number.NaN;
      expect(k.checkRows(ptr, 4, 3)).toBe(3);
      v[2 * 3] = 3e15; // selfDot 9e30
      expect(k.checkRows(ptr, 4, 3)).toBe(2);
      v[1 * 3] = Number.POSITIVE_INFINITY;
      expect(k.checkRows(ptr, 4, 3)).toBe(1);
    }
  });

  it('bad pointers return E_ARGS (-100) instead of trapping, for every function that has an error channel', async () => {
    const k = await Kernel.create('scalar');
    const far = 0x7fff_fff0;
    expect(k.checkRows(far, 4, 4)).toBe(E_ARGS);
    expect(k.invNorms(far, 4, 4, far)).toBe(E_ARGS);
    expect(k.scan(far, 4, 4, far, far, 1, 0, far)).toBe(E_ARGS);
    expect(k.parseHead(far, 100, far)).toBe(E_ARGS);
    expect(k.checkMeta(far, 100, 1, 1, 1)).toBe(E_ARGS);
    expect(k.alive).toBe(true);
    // misaligned f32 pointer
    const p = k.alloc(64);
    expect(k.checkRows(p + 2, 1, 4)).toBe(E_ARGS);
  });
});
