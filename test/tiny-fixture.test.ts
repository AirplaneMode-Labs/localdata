// D4-03: the TypeScript writer reproduces the golden "tiny" index byte for byte. The Rust crate parses
// the same files (crates/ldvec/tests/fixtures/tiny/, tests/format.rs and tests/mutation.rs), so the
// format has two independent implementations agreeing on real bytes.
//
//   npm run fixture:tiny     rewrites the fixture from the writer (LDVEC_WRITE_FIXTURE=1)
//
// Rows: 3, dim 4, one segment, generation 1. Row 1 has no value; rows 0 and 2 do.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore } from '../src/index';

const dir = join(import.meta.dirname, '..', 'crates', 'ldvec', 'tests', 'fixtures', 'tiny');
const WRITE = process.env['LDVEC_WRITE_FIXTURE'] === '1';
const VNS = '__ld_vec.tiny';

async function written(): Promise<Map<string, Uint8Array>> {
  const driver = new MemoryDriver();
  const store = await createStore({ driver, vectorKernel: 'scalar' });
  await store.putVectors('tiny', [
    { key: 'alpha', vector: new Float32Array([1, 0, 0, 0]), value: 'first chunk' },
    { key: 'bravo-é', vector: new Float32Array([0, 1, 0, 0]) },
    { key: 'charlie-\u{1F30D}', vector: new Float32Array([0.5, 0.5, 0.5, 0.5]), value: { n: 3 } },
  ]);
  await store.close();
  await driver.open();
  const out = new Map<string, Uint8Array>();
  for (const k of await driver.keys(VNS)) out.set(k, (await driver.getBytes(VNS, k))!.bytes);
  return out;
}

function files(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(root, rel)).sort()) {
    const r = rel === '' ? n : `${rel}/${n}`;
    if (statSync(join(root, r)).isDirectory()) out.push(...files(root, r));
    else out.push(r);
  }
  return out;
}

describe('the golden tiny fixture', () => {
  it('the writer reproduces every record byte for byte', async () => {
    const got = await written();
    expect([...got.keys()].sort()).toEqual(['head', 'meta-0/00000', 'val-0/00000', 'vec-0/00000']);
    if (WRITE) {
      for (const [name, bytes] of got) {
        const p = join(dir, name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, bytes);
      }
    }
    expect(files(dir)).toEqual(['head', 'meta-0/00000', 'val-0/00000', 'vec-0/00000']);
    for (const [name, bytes] of got) {
      const want = readFileSync(join(dir, name));
      expect(Buffer.from(bytes).equals(want), `${name} differs from the fixture`).toBe(true);
    }
  });

  it('is deterministic: two independent writes are identical', async () => {
    const a = await written();
    const b = await written();
    for (const [name, bytes] of a)
      expect(Buffer.from(bytes).equals(Buffer.from(b.get(name)!))).toBe(true);
  });

  it('the fixture reads back through the reader with the expected rows', async () => {
    const driver = new MemoryDriver();
    await driver.open();
    for (const name of files(dir)) {
      const bytes = readFileSync(join(dir, name));
      await driver.put(VNS, name, new Uint8Array(bytes), { size: bytes.length });
    }
    const store = await createStore({ driver });
    const hits = await store.query('tiny', new Float32Array([1, 0, 0, 0]), 3);
    expect(hits.map((h) => h.key)).toEqual(['alpha', 'charlie-\u{1F30D}', 'bravo-é']);
    expect(hits[0]!.value).toBe('first chunk');
    expect('value' in hits[2]!).toBe(false);
    expect(hits[1]!.value).toEqual({ n: 3 });
    await store.close();
  });
});
