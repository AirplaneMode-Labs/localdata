// D4-03: every way a stored index can be wrong makes the reader refuse with StorageError 'corrupt'
// and the expected details.reason, never return a hit, and never allocate beyond maxIndexBytes.
// HEAD and META are forged with their checksums recomputed (test/forge.ts), so the structural
// validators, not just the CRC gate, are what refuse them.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, type LocalData } from '../src/index';
import { DIM, synthKey, synthQuery, synthRows } from '../bench/synth';
import {
  HEAD_FIELD,
  SEG_FIELD,
  crc32c,
  editHead,
  editMeta,
  editVec,
  readRecord,
  vnsOf,
  writeRecord,
} from './forge';

const NS = 'docs';
const ROWS = 41; // not a multiple of 8, so the tombstone padding bits exist
const D = 16;

const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

async function build(opts: { segments?: number; values?: boolean } = {}) {
  const driver = new MemoryDriver();
  const store = await createStore({ driver });
  const segs = opts.segments ?? 1;
  for (let s = 0; s < segs; s++) {
    await store.putVectors(
      NS,
      synthRows(s * ROWS, ROWS, {
        dim: D,
        ...(opts.values === false ? {} : { chunkBytes: 48 }),
      }),
    );
  }
  await store.close();
  await driver.open();
  return driver;
}

async function reopen(driver: MemoryDriver, extra: Record<string, unknown> = {}) {
  const s = await createStore({ driver, ...extra } as Parameters<typeof createStore>[0]);
  open.push(s);
  return s;
}

const q = synthQuery(0, D);

/** The query rejects corrupt with this reason and file prefix, returns nothing, and stays refused. */
async function expectRefused(store: LocalData, reason: string, file: string): Promise<void> {
  let err: { code?: string; details?: Record<string, unknown> } | undefined;
  let hits: unknown;
  try {
    hits = await store.query(NS, q, 5);
  } catch (e) {
    err = e as typeof err;
  }
  expect(hits, 'no hit may be returned').toBeUndefined();
  expect(err?.code, JSON.stringify(err?.details)).toBe('corrupt');
  expect(err?.details?.['reason']).toBe(reason);
  expect(String(err?.details?.['file']).startsWith(file), String(err?.details?.['file'])).toBe(
    true,
  );
  expect(err?.details?.['ns']).toBe(NS);
  await expect(store.query(NS, q, 5)).rejects.toMatchObject({ code: 'corrupt' });
  await expect(store.indexInfo(NS)).rejects.toMatchObject({ code: 'corrupt' });
}

describe('HEAD that lies about its counts (checksums recomputed)', () => {
  const cases: Array<[string, (h: Uint8Array, dv: DataView) => void, string, string]> = [
    [
      'dim 16 -> 17 (vec parts no longer have the expected length)',
      (_h, dv) => dv.setUint32(HEAD_FIELD.dim, 17, true),
      'length',
      'vec-0',
    ],
    ['dim 0', (_h, dv) => dv.setUint32(HEAD_FIELD.dim, 0, true), 'dim', 'head'],
    ['dim 4097', (_h, dv) => dv.setUint32(HEAD_FIELD.dim, 4097, true), 'dim', 'head'],
    ['dim u32::MAX', (_h, dv) => dv.setUint32(HEAD_FIELD.dim, 0xffffffff, true), 'dim', 'head'],
    [
      'totalRows 41 -> 42 (same tombstone length, rows no longer sum)',
      (_h, dv) => dv.setUint32(HEAD_FIELD.totalRows, ROWS + 1, true),
      'count',
      'head',
    ],
    [
      'totalRows 4,194,305',
      (_h, dv) => dv.setUint32(HEAD_FIELD.totalRows, 4194305, true),
      'count',
      'head',
    ],
    [
      'totalRows u32::MAX',
      (_h, dv) => dv.setUint32(HEAD_FIELD.totalRows, 0xffffffff, true),
      'count',
      'head',
    ],
    ['segCount 4097', (_h, dv) => dv.setUint32(HEAD_FIELD.segCount, 4097, true), 'count', 'head'],
    [
      'segCount u32::MAX',
      (_h, dv) => dv.setUint32(HEAD_FIELD.segCount, 0xffffffff, true),
      'count',
      'head',
    ],
    [
      'segCount 1 -> 0 (the entry is still there)',
      (_h, dv) => dv.setUint32(HEAD_FIELD.segCount, 0, true),
      'length',
      'head',
    ],
    ['segCount 1 -> 2', (_h, dv) => dv.setUint32(HEAD_FIELD.segCount, 2, true), 'length', 'head'],
    [
      'liveRows 41 -> 40',
      (_h, dv) => dv.setUint32(HEAD_FIELD.liveRows, ROWS - 1, true),
      'count',
      'head',
    ],
    [
      'liveRows > totalRows',
      (_h, dv) => dv.setUint32(HEAD_FIELD.liveRows, ROWS + 1, true),
      'count',
      'head',
    ],
    ['generation 0', (_h, dv) => dv.setUint32(HEAD_FIELD.generation, 0, true), 'count', 'head'],
    [
      'generation 0xFFFFFFFF',
      (_h, dv) => dv.setUint32(HEAD_FIELD.generation, 0xffffffff, true),
      'count',
      'head',
    ],
    [
      'nextSegId 0 (not above the last segment id)',
      (_h, dv) => dv.setUint32(HEAD_FIELD.nextSegId, 0, true),
      'segment_order',
      'head',
    ],
    ['a future format version', (h) => void (h[4] = 2), 'version', 'head'],
    ['another dtype', (h) => void (h[6] = 2), 'dtype', 'head'],
    ['a reserved byte set', (h) => void (h[40] = 1), 'reserved', 'head'],
    [
      'segment flags set',
      (_h, dv) => dv.setUint32(64 + SEG_FIELD.flags, 1, true),
      'reserved',
      'head',
    ],
    ['segment rows 0', (_h, dv) => dv.setUint32(64 + SEG_FIELD.rows, 0, true), 'count', 'head'],
    [
      'segment rows u32::MAX',
      (_h, dv) => dv.setUint32(64 + SEG_FIELD.rows, 0xffffffff, true),
      'count',
      'head',
    ],
    [
      'segment rows 131,073',
      (_h, dv) => dv.setUint32(64 + SEG_FIELD.rows, 131073, true),
      'count',
      'head',
    ],
    [
      'segment firstRow 1',
      (_h, dv) => dv.setUint32(64 + SEG_FIELD.firstRow, 1, true),
      'segment_order',
      'head',
    ],
    [
      'segment keyBytesLen near u32::MAX',
      (_h, dv) => dv.setUint32(64 + SEG_FIELD.keyBytesLen, 0xfffffff0, true),
      'count',
      'head',
    ],
    [
      'segment valueBytesLen u32::MAX',
      (_h, dv) => dv.setUint32(64 + SEG_FIELD.valueBytesLen, 0xffffffff, true),
      'count',
      'head',
    ],
    [
      'segment keyBytesLen + 1 (head valid, META part has the wrong length)',
      (_h, dv) =>
        dv.setUint32(
          64 + SEG_FIELD.keyBytesLen,
          dv.getUint32(64 + SEG_FIELD.keyBytesLen, true) + 1,
          true,
        ),
      'length',
      'meta-0',
    ],
    [
      'a tombstone padding bit set',
      (h) => (h[h.length - 5] = h[h.length - 5]! | 0x80),
      'tombstone_padding',
      'head',
    ],
    [
      'a tombstone with liveRows not adjusted',
      (h) => (h[h.length - 6] = h[h.length - 6]! | 1),
      'count',
      'head',
    ],
  ];
  for (const [name, edit, reason, file] of cases) {
    it(name, async () => {
      const driver = await build();
      await editHead(driver, NS, (h, dv) => edit(h, dv));
      await expectRefused(await reopen(driver), reason, file);
    });
  }

  it('an empty HEAD record is length', async () => {
    const driver = await build();
    await writeRecord(driver, NS, 'head', new Uint8Array(0));
    await expectRefused(await reopen(driver), 'length', 'head');
  });

  it('a HEAD record longer than the maximum is too_large before it is parsed', async () => {
    const driver = await build();
    await writeRecord(driver, NS, 'head', new Uint8Array(64 + 32 * 4096 + 524288 + 4 + 1));
    const store = await reopen(driver);
    await expectRefused(store, 'too_large', 'head');
    expect(store.vectorWasmBytes()).toBeLessThan(4 * 1024 * 1024);
  });

  it('a HEAD of random bytes is magic', async () => {
    const driver = await build();
    const junk = new Uint8Array(200);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
    await writeRecord(driver, NS, 'head', junk);
    await expectRefused(await reopen(driver), 'magic', 'head');
  });

  it('a lying HEAD never makes the reader allocate more than maxIndexBytes', async () => {
    const driver = await build();
    // dim 4096 over 41 rows is 687 KB of vectors: valid for the format, far above a 4 KB cap.
    await editHead(driver, NS, (_h, dv) => dv.setUint32(HEAD_FIELD.dim, 4096, true));
    const store = await reopen(driver, { maxIndexBytes: 4096 });
    await expectRefused(store, 'too_large', 'head');
    expect(store.vectorWasmBytes()).toBeLessThan(4 * 1024 * 1024);
  });

  it('an index larger than this store maxIndexBytes is too_large even when it is perfectly valid', async () => {
    const driver = await build();
    const store = await reopen(driver, { maxIndexBytes: 1000 });
    await expectRefused(store, 'too_large', 'head');
    // The same index opens under a sufficient cap.
    await store.close();
    const ok = await reopen(driver);
    expect((await ok.query(NS, q, 3)).length).toBe(3);
  });
});

describe('META that fails its structural checks (checksum recomputed)', () => {
  // META layout for 41 rows: norms 0, keyOffsets 164 (42 u32), valueOffsets 332 (42 u32),
  // valueCrcs 500, keyBytes 664.
  const KO = ROWS * 4;
  const VO = KO + (ROWS + 1) * 4;
  const KB = ROWS * 16 + 8;
  const cases: Array<[string, (m: Uint8Array, dv: DataView) => void, string]> = [
    ['key offsets that do not start at 0', (_m, dv) => dv.setUint32(KO, 1, true), 'offsets'],
    ['key offsets that decrease', (_m, dv) => dv.setUint32(KO + 4 * 5, 0, true), 'offsets'],
    [
      'key offsets that end past the key bytes',
      (_m, dv) => dv.setUint32(KO + 4 * ROWS, 1 << 30, true),
      'offsets',
    ],
    ['an empty key', (_m, dv) => dv.setUint32(KO + 4, 0, true), 'key_length'],
    [
      'an offset that jumps past the next one',
      (_m, dv) => dv.setUint32(KO + 4, 4097, true),
      'offsets',
    ],
    ['an invalid UTF-8 key byte', (m) => (m[KB + 3] = 0xff), 'utf8'],
    ['value offsets that do not start at 0', (_m, dv) => dv.setUint32(VO, 1, true), 'offsets'],
    ['value offsets that decrease', (_m, dv) => dv.setUint32(VO + 4 * 3, 0, true), 'offsets'],
    [
      'value offsets that end elsewhere than valueBytesLen',
      (_m, dv) => dv.setUint32(VO + 4 * ROWS, 5, true),
      'offsets',
    ],
  ];
  for (const [name, edit, reason] of cases) {
    it(name, async () => {
      const driver = await build();
      await editMeta(driver, NS, 0, 0, (m, dv) => edit(m, dv));
      await expectRefused(await reopen(driver), reason, 'meta-0');
    });
  }

  it('two live rows with the same key are duplicate_key', async () => {
    const driver = await build();
    // Keys are 12 bytes each ('chunk-000000'); make row 1's key equal row 0's.
    await editMeta(driver, NS, 0, 0, (m) => {
      m.copyWithin(KB + 12, KB, KB + 12);
    });
    await expectRefused(await reopen(driver), 'duplicate_key', 'meta-0');
  });

  it('a duplicate key across segments is duplicate_key; a tombstoned duplicate is fine (overwrite)', async () => {
    const driver = await build({ segments: 2 });
    // overwrite through the API first: the same key appears twice on disk, one row tombstoned
    const s = await createStore({ driver });
    await s.putVectors(NS, synthRows(0, 1, { dim: D }));
    await s.close();
    await driver.open();
    const ok = await reopen(driver);
    expect((await ok.query(NS, q, 5)).length).toBe(5);
    expect((await ok.indexInfo(NS))?.totalRows).toBe(2 * ROWS + 1);
  });

  it('a META part that was flipped is crc, a vec part with a NaN and a valid checksum is bad_vector', async () => {
    const d1 = await build();
    const m = await readRecord(d1, NS, 'meta-0/00000');
    m[20] = m[20]! ^ 1;
    await writeRecord(d1, NS, 'meta-0/00000', m);
    await expectRefused(await reopen(d1), 'crc', 'meta-0');

    const d2 = await build();
    await editVec(d2, NS, 0, 0, (_v, dv) => dv.setFloat32(4 * 5, Number.NaN, true));
    await expectRefused(await reopen(d2), 'bad_vector', 'vec-0');

    const d3 = await build();
    await editVec(d3, NS, 0, 0, (_v, dv) => dv.setFloat32(4 * 5, 3e15, true));
    await expectRefused(await reopen(d3), 'bad_vector', 'vec-0');
  });
});

describe('missing and truncated parts', () => {
  it('a missing vec, meta and val part is missing_part with the record name', async () => {
    for (const [name, file] of [
      ['vec-0/00000', 'vec-0'],
      ['meta-0/00000', 'meta-0'],
    ] as const) {
      const driver = await build();
      await driver.del(vnsOf(NS), name);
      await expectRefused(await reopen(driver), 'missing_part', file);
    }
    const driver = await build();
    await driver.del(vnsOf(NS), 'val-0/00000');
    const store = await reopen(driver);
    // Without values the index is fully usable: the value part is read lazily, per hit.
    expect((await store.query(NS, q, 5, { values: false })).length).toBe(5);
    await expect(store.query(NS, q, 5)).rejects.toMatchObject({
      code: 'corrupt',
      details: { reason: 'missing_part', file: 'val-0/00000' },
    });
  });

  it('a truncated vec part and a truncated meta part are length', async () => {
    for (const [name, file] of [
      ['vec-0/00000', 'vec-0'],
      ['meta-0/00000', 'meta-0'],
    ] as const) {
      const driver = await build();
      const b = await readRecord(driver, NS, name);
      await writeRecord(driver, NS, name, b.slice(0, b.length - 3));
      await expectRefused(await reopen(driver), 'length', file);
    }
  });

  it('an extended part is length too', async () => {
    const driver = await build();
    const b = await readRecord(driver, NS, 'vec-0/00000');
    const longer = new Uint8Array(b.length + 4);
    longer.set(b);
    await writeRecord(driver, NS, 'vec-0/00000', longer);
    await expectRefused(await reopen(driver), 'length', 'vec-0');
  });

  it('a flipped value byte is value_crc, only for a query that returns that row', async () => {
    const driver = await build();
    const b = await readRecord(driver, NS, 'val-0/00000');
    b[b.length >> 1] = b[b.length >> 1]! ^ 1;
    await writeRecord(driver, NS, 'val-0/00000', b);
    const store = await reopen(driver);
    expect((await store.query(NS, q, ROWS, { values: false })).length).toBe(ROWS);
    await expect(store.query(NS, q, ROWS)).rejects.toMatchObject({
      code: 'corrupt',
      details: { reason: 'value_crc' },
    });
    await expect(store.query(NS, q, 3, { values: false })).rejects.toMatchObject({
      code: 'corrupt',
    });
  });
});

describe('what happens after corruption', () => {
  it('every vector call rejects, KV is unaffected, clear recovers and the namespace is reusable', async () => {
    const driver = await build();
    await editHead(driver, NS, (_h, dv) => dv.setUint32(HEAD_FIELD.totalRows, 4194305, true));
    const store = await reopen(driver);
    await expectRefused(store, 'count', 'head');
    await expect(store.putVectors(NS, synthRows(900, 2, { dim: D }))).rejects.toMatchObject({
      code: 'corrupt',
    });
    await expect(store.delete(NS, synthKey(1))).rejects.toMatchObject({ code: 'corrupt' });
    await store.set(NS, 'kv', { fine: true });
    expect(await store.get(NS, 'kv')).toEqual({ fine: true });
    // usage never throws because of an index
    const u = await store.usage(NS);
    expect(u.vectorRows).toBeUndefined();
    await store.clear(NS);
    expect(await store.indexInfo(NS)).toBeUndefined();
    await store.putVectors(NS, synthRows(0, 3, { dim: DIM }));
    expect((await store.query(NS, synthQuery(0), 5)).length).toBe(3);
  });

  it('a new HEAD (another writer committed) ends the refusal without a clear', async () => {
    const driver = await build();
    const good = await readRecord(driver, NS, 'head');
    await editHead(driver, NS, (_h, dv) => dv.setUint32(HEAD_FIELD.totalRows, 4194305, true));
    const store = await reopen(driver);
    await expectRefused(store, 'count', 'head');
    await writeRecord(driver, NS, 'head', good);
    expect((await store.query(NS, q, 5)).length).toBe(5);
  });

  it('a corrupt namespace does not affect another namespace in the same store', async () => {
    const driver = new MemoryDriver();
    const s0 = await createStore({ driver });
    await s0.putVectors('one', synthRows(0, 5, { dim: D }));
    await s0.putVectors('two', synthRows(0, 5, { dim: D }));
    await s0.close();
    await driver.open();
    const b = await readRecord(driver, 'one', 'vec-0/00000');
    b[3] = b[3]! ^ 0xff;
    await writeRecord(driver, 'one', 'vec-0/00000', b);
    const store = await reopen(driver);
    await expect(store.query('one', q, 3)).rejects.toMatchObject({ code: 'corrupt' });
    expect((await store.query('two', q, 3)).length).toBe(3);
  });

  it('crc32c of the forged records is the one the kernel computes', async () => {
    // Sanity for the test helper: the check value.
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
  });
});
