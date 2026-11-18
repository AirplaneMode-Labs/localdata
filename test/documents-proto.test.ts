// D4-02, prototype safety of the documents API (the S1-100 and S1-101 classes): a docId, a meta key or a
// gate key that names an inherited member is an ordinary own member, and stored bytes that carry
// '__proto__' (forged straight into the document index) never set a prototype on DocumentInfo, ChunkHit
// or meta. A record that is structurally wrong is 'corrupt', never half-returned.
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, type LocalData, type VectorRow } from '../src/index';
import { MemoryDriver } from '../src/drivers/memory';
import { forgeDocRows } from './forge';
import { NS, fakeSha } from './documents.behaviour';
import { assertPlainPrototypes } from './proto.behaviour';

const stores: LocalData[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
});

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const v = (...xs: number[]) => Float32Array.from(xs);
const json = (text: string) => JSON.parse(text) as never;

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: 'Forged', h: fakeSha('x'), b: 10, p: 3, a: 1_700_000_000_000, m: {}, ...over };
}
function chunk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { s: 1, e: 1, t: 'forged text', ...over };
}

async function forged(rows: VectorRow[]): Promise<LocalData> {
  const driver = new MemoryDriver();
  await forgeDocRows(driver, NS, rows);
  await driver.close();
  const s = await createStore({ driver });
  stores.push(s);
  return s;
}

describe('forged stored bytes never set a prototype', () => {
  it('own __proto__ members in the record, its meta and the chunk value', async () => {
    const s = await forged([
      {
        key: 'doc',
        vector: v(0, 0),
        value: json(
          '{"__proto__":{"polluted":1},"t":"Forged","h":"' +
            fakeSha('x') +
            '","b":10,"p":3,"a":5,"m":{"ok":"x"}}',
        ),
      },
      {
        key: 'doc/00000000',
        vector: v(1, 0),
        value: json('{"__proto__":{"polluted":1},"s":1,"e":1,"t":"forged text"}'),
      },
    ]);
    const info = await s.getDocument(NS, 'doc');
    expect(info?.title).toBe('Forged');
    assertPlainPrototypes(info);
    expect(info?.meta).toEqual({ ok: 'x' });
    const hits = await s.queryChunks(NS, v(1, 0), 5);
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toBe('forged text');
    assertPlainPrototypes(hits[0]);
    expect(own(hits[0]!, '__proto__')).toBe(false);
    expect(own(info!, '__proto__')).toBe(false);
  });

  it('a __proto__ or constructor key inside the stored meta is corrupt, not an own member and not a prototype', async () => {
    for (const m of ['{"__proto__":{"polluted":1}}', '{"constructor":1}', '{"prototype":"x"}']) {
      const s = await forged([
        { key: 'doc', vector: v(0, 0), value: record({ m: json(m) }) as never },
        { key: 'doc/00000000', vector: v(1, 0), value: chunk() as never },
      ]);
      await expect(s.getDocument(NS, 'doc'), m).rejects.toMatchObject({
        code: 'corrupt',
        details: { reason: 'doc_record' },
      });
      await expect(s.listDocuments(NS), m).rejects.toMatchObject({ code: 'corrupt' });
    }
  });

  it('a record with the wrong shape is corrupt, with the record file named and no key or text in the error', async () => {
    const bad: Array<Record<string, unknown>> = [
      record({ t: 5 }),
      record({ h: 'short' }),
      record({ b: -1 }),
      record({ b: 1.5 }),
      record({ p: 100_001 }),
      record({ a: 'x' }),
      record({ m: [] }),
      record({ m: { k: { nested: 1 } } }),
      record({ m: { '1bad': 1 } }),
    ];
    for (const r of bad) {
      const s = await forged([{ key: 'doc', vector: v(0, 0), value: r as never }]);
      const err = await s.getDocument(NS, 'doc').then(
        () => undefined,
        (e: { code?: string; message: string; details?: Record<string, unknown> }) => e,
      );
      expect(err?.code, JSON.stringify(r)).toBe('corrupt');
      expect(err?.details?.['reason']).toBe('doc_record');
      expect(JSON.stringify(err)).not.toContain('Forged');
    }
  });

  it('a chunk with the wrong shape or pages outside the document is corrupt when it is a hit', async () => {
    const bad: Array<Record<string, unknown>> = [
      chunk({ s: 'x' }),
      chunk({ t: 5 }),
      chunk({ s: 0 }),
      chunk({ e: 4 }), // the record says 3 pages
      chunk({ s: 3, e: 2 }),
      chunk({ s: 1.5 }),
    ];
    for (const c of bad) {
      const s = await forged([
        { key: 'doc', vector: v(0, 0), value: record() as never },
        { key: 'doc/00000000', vector: v(1, 0), value: c as never },
      ]);
      await expect(s.queryChunks(NS, v(1, 0), 5), JSON.stringify(c)).rejects.toMatchObject({
        code: 'corrupt',
        details: { reason: 'chunk_record' },
      });
    }
  });

  it('chunk rows with no document record, and rows with junk keys, are not candidates', async () => {
    const s = await forged([
      { key: 'doc', vector: v(0, 0), value: record() as never },
      { key: 'doc/00000000', vector: v(1, 0), value: chunk() as never },
      { key: 'ghost/00000000', vector: v(1, 0), value: chunk() as never },
      { key: 'doc/notdigits', vector: v(1, 0), value: chunk() as never },
      { key: 'Doc/00000001', vector: v(1, 0), value: chunk() as never },
      { key: 'doc/1', vector: v(1, 0), value: chunk() as never },
    ]);
    const hits = await s.queryChunks(NS, v(1, 0), 10);
    expect(hits.map((h) => `${h.docId}#${h.ordinal}`)).toEqual(['doc#0']);
    expect((await s.getDocument(NS, 'doc'))?.chunks).toBe(1);
    expect((await s.listDocuments(NS)).map((d) => d.docId)).toEqual(['doc']);
    expect((await s.usage(NS)).documents).toBe(1);
  });
});

describe('docId constructor and prototype as ordinary ids', () => {
  it('put, get, list, query, delete and replace work for every name that Object.prototype has', async () => {
    const s = await createStore({ driver: 'memory' });
    stores.push(s);
    const ids = ['constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty', 'proto'];
    for (const [i, id] of ids.entries()) {
      await s.putDocument(
        NS,
        {
          docId: id,
          title: id,
          sha256: fakeSha(id),
          bytes: i,
          pages: 2,
          meta: { toString: id, valueOf: i },
        },
        [
          {
            ordinal: 0,
            pageStart: 1,
            pageEnd: 2,
            text: `text of ${id}`,
            vector: v(i + 1, 1),
          },
        ],
      );
    }
    expect((await s.listDocuments(NS)).map((d) => d.docId)).toEqual([...ids].sort());
    for (const id of ids) {
      const info = await s.getDocument(NS, id);
      expect(info?.title).toBe(id);
      expect(own(info!.meta!, 'toString')).toBe(true);
      const hits = await s.queryChunks(NS, v(1, 1), 10, { docId: id });
      expect(hits.map((h) => h.docId)).toEqual([id]);
    }
    expect(await s.deleteDocument(NS, 'constructor')).toBe(true);
    expect(await s.getDocument(NS, 'constructor')).toBeUndefined();
    expect(await s.deleteDocument(NS, 'hasownproperty')).toBe(true);
    expect((await s.listDocuments(NS)).length).toBe(4);
  });
});
