// A small WebAssembly code-section walker for the tests: it decodes every instruction with its
// immediates (MVP, sign-extension, saturating truncation, bulk memory, reference types, SIMD) and
// reports which instructions occur. It exists to prove, from the module bytes, that
//   * the scalar build has no 0xFD (SIMD prefix) instruction, and
//   * neither build has a relaxed-simd instruction (0xFD sub-opcode >= 0x100: relaxed madd and
//     friends, which could fuse a multiply-add) and no instruction that could fuse one.
// A byte-grep for 0xFD would be wrong: 0xFD also appears inside LEB128 immediates and data.

export interface OpcodeScan {
  /** Count of instructions per single-byte opcode (0x00..0xFF), prefixes counted under their byte. */
  single: Map<number, number>;
  /** Count of 0xFD sub-opcodes. */
  simd: Map<number, number>;
  /** Count of 0xFC sub-opcodes. */
  misc: Map<number, number>;
  functions: number;
}

class Reader {
  constructor(
    readonly b: Uint8Array,
    public p = 0,
  ) {}
  byte(): number {
    if (this.p >= this.b.length) throw new Error('unexpected end of module');
    return this.b[this.p++]!;
  }
  u32(): number {
    let r = 0;
    let shift = 0;
    for (;;) {
      const x = this.byte();
      r += (x & 0x7f) * 2 ** shift;
      if ((x & 0x80) === 0) return r;
      shift += 7;
      if (shift > 35) throw new Error('bad LEB128');
    }
  }
  skipLeb(): void {
    while ((this.byte() & 0x80) !== 0);
  }
  skip(n: number): void {
    this.p += n;
  }
}

function skipMemarg(r: Reader): void {
  const align = r.u32();
  if ((align & 0x40) !== 0) r.u32(); // multi-memory index
  r.u32(); // offset
}

/** Skips the immediates of one 0xFD sub-opcode. */
function skipSimdImmediates(r: Reader, sub: number): void {
  if (sub <= 0x0b || sub === 0x5c || sub === 0x5d) return skipMemarg(r);
  if (sub === 0x0c || sub === 0x0d) return r.skip(16); // v128.const, i8x16.shuffle
  if (sub >= 0x15 && sub <= 0x22) return r.skip(1); // extract / replace lane
  if (sub >= 0x54 && sub <= 0x5b) {
    skipMemarg(r);
    return r.skip(1); // load / store lane
  }
}

export function scanCode(wasm: Uint8Array): OpcodeScan {
  const out: OpcodeScan = { single: new Map(), simd: new Map(), misc: new Map(), functions: 0 };
  const r = new Reader(wasm);
  if (r.byte() !== 0 || r.byte() !== 0x61 || r.byte() !== 0x73 || r.byte() !== 0x6d)
    throw new Error('not a wasm module');
  r.skip(4);
  while (r.p < wasm.length) {
    const id = r.byte();
    const size = r.u32();
    const end = r.p + size;
    if (id !== 10) {
      r.p = end;
      continue;
    }
    const count = r.u32();
    for (let f = 0; f < count; f++) {
      const bodySize = r.u32();
      const bodyEnd = r.p + bodySize;
      out.functions++;
      // locals
      const groups = r.u32();
      for (let g = 0; g < groups; g++) {
        r.u32();
        r.byte();
      }
      while (r.p < bodyEnd) {
        const op = r.byte();
        out.single.set(op, (out.single.get(op) ?? 0) + 1);
        switch (true) {
          case op === 0x02 || op === 0x03 || op === 0x04:
            r.skipLeb(); // blocktype (s33)
            break;
          case op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12:
            r.u32();
            break;
          case op === 0x0e: {
            const n = r.u32();
            for (let i = 0; i <= n; i++) r.u32();
            break;
          }
          case op === 0x11 || op === 0x13:
            r.u32();
            r.u32();
            break;
          case op === 0x1c: {
            const n = r.u32();
            r.skip(n);
            break;
          }
          case (op >= 0x20 && op <= 0x26) || op === 0xd2:
            r.u32();
            break;
          case op >= 0x28 && op <= 0x3e:
            skipMemarg(r);
            break;
          case op === 0x3f || op === 0x40:
            r.u32();
            break;
          case op === 0x41 || op === 0x42:
            r.skipLeb();
            break;
          case op === 0x43:
            r.skip(4);
            break;
          case op === 0x44:
            r.skip(8);
            break;
          case op === 0xd0:
            r.byte();
            break;
          case op === 0xfc: {
            const sub = r.u32();
            out.misc.set(sub, (out.misc.get(sub) ?? 0) + 1);
            if (sub === 8) {
              r.u32();
              r.u32();
            } else if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) r.u32();
            else if (sub === 10) {
              r.u32();
              r.u32();
            } else if (sub === 11) r.u32();
            else if (sub === 12 || sub === 14) {
              r.u32();
              r.u32();
            }
            break;
          }
          case op === 0xfd: {
            const sub = r.u32();
            out.simd.set(sub, (out.simd.get(sub) ?? 0) + 1);
            skipSimdImmediates(r, sub);
            break;
          }
          default:
            // Everything else (control, parametric, numeric, 0x45..0xc4, ref.is_null, end, else...)
            // carries no immediates.
            break;
        }
      }
      if (r.p !== bodyEnd) throw new Error(`function ${f}: decoded past its body`);
    }
    r.p = end;
  }
  return out;
}

/** f32x4.relaxed_madd / nmadd (0x105, 0x106) and every other relaxed-simd opcode are >= 0x100. */
export function relaxedSimdOpcodes(scan: OpcodeScan): number[] {
  return [...scan.simd.keys()].filter((s) => s >= 0x100);
}

export const SIMD_PREFIX = 0xfd;
