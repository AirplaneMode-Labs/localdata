// D4-02 / S1-088: no builder path in a shipped WASM module or in the generated module that embeds
// them. scripts/pack-check.mjs repeats the check on the packed tarball. The needles are built from
// pieces so this file does not match its own scan (test/portability.test.ts).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LDVEC_SCALAR_B64,
  LDVEC_SCALAR_SHA256,
  LDVEC_SIMD_B64,
  LDVEC_SIMD_SHA256,
} from '../src/wasm/ldvec.gen';
import { createHash } from 'node:crypto';

const root = join(import.meta.dirname, '..');
const NEEDLES = [
  ['/Us', 'ers/'].join(''),
  ['/ho', 'me/'].join(''),
  ['C:', '\\'].join(''),
  ['.cargo', '/registry'].join(''),
  ['.rus', 'tup'].join(''),
  homedir(),
  root,
];
const wasm = (kind: string) =>
  join(root, 'target', `wasm-${kind}`, 'wasm32-unknown-unknown', 'release', 'ldvec.wasm');

describe('builder paths', () => {
  for (const kind of ['simd', 'scalar']) {
    it(`the ${kind} .wasm contains none of the builder-path needles`, () => {
      expect(existsSync(wasm(kind)), `${wasm(kind)} (run npm run build:wasm)`).toBe(true);
      const bytes = readFileSync(wasm(kind));
      const text = bytes.toString('latin1');
      for (const n of NEEDLES) expect(text.includes(n), `needle ${JSON.stringify(n)}`).toBe(false);
    });
  }

  it('src/wasm/ldvec.gen.ts contains none of the needles, and its sha256 values match its bytes', () => {
    const gen = readFileSync(join(root, 'src', 'wasm', 'ldvec.gen.ts'), 'utf8');
    for (const n of NEEDLES) expect(gen.includes(n), `needle ${JSON.stringify(n)}`).toBe(false);
    for (const [b64, sha] of [
      [LDVEC_SIMD_B64, LDVEC_SIMD_SHA256],
      [LDVEC_SCALAR_B64, LDVEC_SCALAR_SHA256],
    ] as const) {
      const raw = Buffer.from(b64, 'base64');
      expect(createHash('sha256').update(raw).digest('hex')).toBe(sha);
    }
  });

  it('the embedded modules are the ones in target/ (the gen file is not stale)', () => {
    expect(Buffer.from(LDVEC_SIMD_B64, 'base64').equals(readFileSync(wasm('simd')))).toBe(true);
    expect(Buffer.from(LDVEC_SCALAR_B64, 'base64').equals(readFileSync(wasm('scalar')))).toBe(true);
  });

  it('the build script remaps the repository root, the cargo home and the rustup home', () => {
    const script = readFileSync(join(root, 'scripts', 'build-wasm.mjs'), 'utf8');
    expect(script).toContain('--remap-path-prefix=${repo}=/ldvec');
    expect(script).toContain('--remap-path-prefix=${cargoHome}=/cargo');
    expect(script).toContain('--remap-path-prefix=${rustupHome}=/rustup');
    expect(script).toContain('--locked');
  });
});
