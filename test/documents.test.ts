// D4-02: the documents API (Storage API 0.3.0) over the memory driver, and the cases that need Node:
// failure injection at every put of a write, events, redaction, quota, locks and several stores over one
// driver. The shared cases (test/documents.behaviour.ts) also run in installed Chrome over OPFS and
// IndexedDB (test/browser/documents.spec.ts).
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK_GATE_KEYS_MAX,
  CHUNK_TEXT_UTF8_MAX,
  DOC_CHUNKS_MAX,
  DOC_ID_PATTERN,
  DOC_META_KEYS_MAX,
  DOC_QUERY_K_MAX,
  DOC_TITLE_MAX,
  STORAGE_EVENT_NAMES,
  createStore,
  type ChunkInput,
  type Event,
  type LocalData,
} from '../src/index';
import { MemoryDriver } from '../src/drivers/memory';
import { DOC_NS_PREFIX } from '../src/drivers/types';
import { synthVector } from '../bench/synth';
import {
  NS,
  docInput,
  documentCases,
  makeChunks,
  seededCorpus,
  sameAsReference,
} from './documents.behaviour';
import { installFakeNavigator, type FakeNavigator } from './fake-env';
import { memoryPersistEnv } from './memory-env';
import { runPersistCases } from './persist-env';

const stores: LocalData[] = [];
let nav: FakeNavigator | undefined;
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  nav?.restore();
  nav = undefined;
});

async function open(driver: MemoryDriver, extra: Record<string, unknown> = {}): Promise<LocalData> {
  const s = await createStore({ driver, ...extra } as Parameters<typeof createStore>[0]);
  stores.push(s);
  return s;
}

describe('documents API (memory driver): shared behavioural cases', () => {
  it('has unique case names and the contract constants', () => {
    expect(new Set(documentCases.map((c) => c.name)).size).toBe(documentCases.length);
    expect(documentCases.length).toBeGreaterThanOrEqual(14);
    expect(DOC_ID_PATTERN.test('constructor')).toBe(true);
    expect([DOC_TITLE_MAX, DOC_META_KEYS_MAX, CHUNK_TEXT_UTF8_MAX, DOC_CHUNKS_MAX]).toEqual([
      256, 16, 16384, 20000,
    ]);
    expect([CHUNK_GATE_KEYS_MAX, DOC_QUERY_K_MAX]).toEqual([8, 1000]);
    expect(STORAGE_EVENT_NAMES).toEqual(
      expect.arrayContaining(['storage.doc.put', 'storage.doc.delete', 'storage.doc.query']),
    );
  });

  runPersistCases(documentCases, memoryPersistEnv(), (name, fn) => it(name, fn, 120_000));
});

describe('all-or-nothing: a failure injected at any put of a write leaves nothing of the document', () => {
  /** A driver that counts puts into document namespaces and fails the n-th one. */
  class Failing extends MemoryDriver {
    puts = 0;
    failOn = 0;
    override async put(ns: string, key: string, bytes: Uint8Array, meta: { size: number }) {
      if (ns.startsWith(DOC_NS_PREFIX) && ++this.puts === this.failOn)
        throw this.failOn % 2 === 0
          ? new DOMException('The quota has been exceeded.', 'QuotaExceededError')
          : new Error('disk exploded');
      return super.put(ns, key, bytes, meta);
    }
  }

  async function totalPuts(chunks: ChunkInput[], dim: number, withOld: boolean): Promise<number> {
    const d = new Failing();
    const s = await open(d);
    if (withOld) await s.putDocument(NS, docInput('d'), makeChunks(5, 6, dim));
    d.puts = 0;
    await s.putDocument(NS, docInput('d', 1000, { title: 'new' }), chunks);
    await s.close();
    return d.puts;
  }

  for (const [label, n, dim, withOld] of [
    ['a new document, one segment', 40, 16, false],
    ['a replace, one segment', 40, 16, true],
    ['a new document, two vector parts', 1100, 2048, false],
    ['a replace, two vector parts', 1100, 2048, true],
  ] as const) {
    it(`${label}: every put number 1..N fails cleanly, before and after a reopen`, async () => {
      const chunks = makeChunks(9, n, dim);
      const total = await totalPuts(chunks, dim, withOld);
      expect(total).toBeGreaterThanOrEqual(4);
      for (let at = 1; at <= total; at++) {
        const d = new Failing();
        const s = await open(d);
        if (withOld) await s.putDocument(NS, docInput('d'), makeChunks(5, 6, dim));
        d.puts = 0;
        d.failOn = at;
        await expect(
          s.putDocument(NS, docInput('d', 1000, { title: 'new' }), chunks),
          `put ${at}/${total}`,
        ).rejects.toMatchObject({
          name: 'StorageError',
        });
        d.failOn = 0;
        const verify = async (view: LocalData) => {
          if (withOld) {
            const info = await view.getDocument(NS, 'd');
            expect(info?.title, `put ${at}: the old record survives`).toBe('Title of d');
            expect(info?.chunks).toBe(6);
            const hits = await view.queryChunks(NS, synthVector(5000, dim), 100);
            expect(hits.length, `put ${at}: the old chunks survive`).toBe(6);
            expect(hits.every((h) => h.text.startsWith('doc 5 chunk '))).toBe(true);
          } else {
            expect(await view.getDocument(NS, 'd'), `put ${at}: no record`).toBeUndefined();
            expect(
              await view.queryChunks(NS, synthVector(9000, dim), 100),
              `put ${at}: no chunk`,
            ).toEqual([]);
            expect(await view.listDocuments(NS)).toEqual([]);
          }
        };
        await verify(s);
        await s.close();
        await verify(await open(d));
        // the store still works, and the next write is clean
        const again = await open(d);
        const r = await again.putDocument(NS, docInput('d', 1000, { title: 'new' }), chunks);
        expect(r.chunks).toBe(n);
        expect((await again.getDocument(NS, 'd'))?.title).toBe('new');
        await again.close();
      }
    }, 300_000);
  }

  it('a chunk source that throws at chunk N leaves nothing, at every N (also after the last chunk), and the old version stays', async () => {
    for (const at of [0, 1, 7, 19, 20]) {
      const d = new MemoryDriver();
      const s = await open(d);
      await s.putDocument(NS, docInput('d'), makeChunks(5, 6));
      function* boom(): Generator<ChunkInput> {
        const cs = makeChunks(9, 20);
        for (let i = 0; i <= 20; i++) {
          if (i === at) throw new Error('source failed');
          if (i < 20) yield cs[i]!;
        }
      }
      await expect(
        s.putDocument(NS, docInput('d', 1000, { title: 'new' }), boom()),
        `throw at ${at}`,
      ).rejects.toMatchObject({ name: 'StorageError' });
      await s.close();
      const view = await open(d);
      expect((await view.getDocument(NS, 'd'))?.title).toBe('Title of d');
      expect((await view.queryChunks(NS, synthVector(5000, 16), 100)).length).toBe(6);
    }
  });

  it('a quota refusal (soft quota) writes nothing and the key-value side still works', async () => {
    const d = new MemoryDriver();
    const s = await open(d, { quotaBytes: 6000 });
    await expect(
      s.putDocument(NS, docInput('big', 100), makeChunks(1, 60, 16, 400)),
    ).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(await s.getDocument(NS, 'big')).toBeUndefined();
    await s.set(NS, 'k', 'v');
    expect(await s.get(NS, 'k')).toBe('v');
    expect((await s.putDocument(NS, docInput('small'), makeChunks(2, 2))).chunks).toBe(2);
  });
});

describe('queryChunks and writes keep working through several stores over one driver', () => {
  it("a second store opened earlier does not lose the first store's documents when it writes (refresh under the lock)", async () => {
    nav = installFakeNavigator({ locks: true });
    const d = new MemoryDriver();
    const a = await open(d);
    const b = await open(d);
    await a.putDocument(NS, docInput('from-a'), makeChunks(1, 3));
    await b.putDocument(NS, docInput('from-b'), makeChunks(2, 3));
    const c = await open(d);
    expect((await c.listDocuments(NS)).map((x) => x.docId)).toEqual(['from-a', 'from-b']);
    expect((await c.queryChunks(NS, synthVector(1000, 16), 100)).length).toBe(6);
  });

  it('writes take the document lock and a held lock delays a writer but never a reader', async () => {
    nav = installFakeNavigator({ locks: true });
    const d = new MemoryDriver();
    const s = await open(d);
    await s.putDocument(NS, docInput('first'), makeChunks(1, 3));
    expect(nav.locks.requests.some((r) => r.name === `airplanemode-localdata:doc:${NS}`)).toBe(
      true,
    );
    const release = nav.locks.hold(`airplanemode-localdata:doc:${NS}`);
    let done = false;
    const pending = s
      .putDocument(NS, docInput('second'), makeChunks(2, 3))
      .then(() => (done = true));
    const hits = await s.queryChunks(NS, synthVector(1000, 16), 10); // a reader is not blocked
    expect(hits.length).toBe(3);
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    release();
    await pending;
    expect((await s.listDocuments(NS)).length).toBe(2);
  });

  it('concurrent writes in one namespace are serialised and none is lost', async () => {
    const d = new MemoryDriver();
    const s = await open(d);
    await Promise.all([
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
        s.putDocument(NS, docInput(id), makeChunks(i, 4)),
      ),
    ]);
    await Promise.all([
      s.deleteDocument(NS, 'b'),
      s.putDocument(NS, docInput('a', 3), makeChunks(9, 2)),
      s.putDocument(NS, docInput('g'), makeChunks(7, 5)),
    ]);
    const list = await s.listDocuments(NS);
    expect(list.map((x) => x.docId)).toEqual(['a', 'c', 'd', 'e', 'f', 'g']);
    expect(list.find((x) => x.docId === 'a')?.chunks).toBe(2);
    expect((await s.queryChunks(NS, synthVector(1, 16), 1000)).length).toBe(2 + 4 * 4 + 5);
  });

  it('a closed store rejects every document call with closed', async () => {
    const s = await createStore({ driver: 'memory' });
    await s.close();
    for (const call of [
      () => s.putDocument(NS, docInput('x'), []),
      () => s.getDocument(NS, 'x'),
      () => s.listDocuments(NS),
      () => s.deleteDocument(NS, 'x'),
      () => s.queryChunks(NS, synthVector(1, 16), 1),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'closed' });
  });
});

describe('storage.doc.* events', () => {
  const SENTINELS = {
    docId: 'sentinel-doc-id-77',
    title: 'SENTINEL-TITLE-5d2e',
    text: 'SENTINEL-CHUNK-TEXT-a41c',
    meta: 'SENTINEL-META-9b0f',
    gate: 'SENTINEL-GATE-0e7a',
  };

  async function run(ns = 'events') {
    const events: Event[] = [];
    const s = await createStore({ driver: 'memory', events: { emit: (e) => void events.push(e) } });
    stores.push(s);
    const vectors = [0, 1, 2].map((i) => synthVector(40 + i, 16));
    const chunks: ChunkInput[] = vectors.map((vector, i) => ({
      ordinal: i,
      pageStart: 1,
      pageEnd: 2,
      text: `${SENTINELS.text} ${i}`,
      vector,
      gate: { verdict: SENTINELS.gate },
    }));
    const doc = docInput(SENTINELS.docId, 3, {
      title: SENTINELS.title,
      meta: { note: SENTINELS.meta },
    });
    await s.putDocument(ns, doc, chunks);
    await s.putDocument(ns, doc, chunks);
    const hits = await s.queryChunks(ns, vectors[0]!, 2, { metric: 'dot' });
    await s.queryChunks(ns, vectors[0]!, 2, { docId: SENTINELS.docId });
    await s.deleteDocument(ns, SENTINELS.docId);
    await s.deleteDocument(ns, SENTINELS.docId);
    await s.putDocument(ns, { ...doc, sha256: 'bad' }, chunks).catch(() => undefined);
    await s.queryChunks(ns, vectors[0]!, 0).catch(() => undefined);
    return { events, hits, vectors, s };
  }

  it('has exactly the documented attrs, outcomes and event kinds', async () => {
    const { events } = await run();
    const docEvents = events.filter((e) => e.name.startsWith('storage.doc.'));
    const put = docEvents.filter((e) => e.name === 'storage.doc.put');
    const del = docEvents.filter((e) => e.name === 'storage.doc.delete');
    const query = docEvents.filter((e) => e.name === 'storage.doc.query');
    expect(put.length).toBe(3);
    expect(del.length).toBe(2);
    expect(query.length).toBe(3);
    for (const e of docEvents) {
      expect(e.source).toBe('localdata');
      expect(e.kind).toBe('timing');
      expect(typeof e.durationMs).toBe('number');
    }
    expect(Object.keys(put[0]!.attrs).sort()).toEqual(
      ['chunks', 'driver', 'ns', 'outcome', 'replaced', 'rows'].sort(),
    );
    expect(put[0]!.attrs).toMatchObject({
      ns: 'events',
      driver: 'memory',
      outcome: 'ok',
      chunks: 3,
      replaced: false,
      rows: 3,
    });
    expect(put[0]!.bytes).toBeGreaterThan(0);
    expect(put[1]!.attrs).toMatchObject({ outcome: 'ok', chunks: 3, replaced: true, rows: 3 });
    expect(put[2]!.attrs).toMatchObject({
      outcome: 'invalid_value',
      chunks: 0,
      replaced: false,
      rows: 0,
    });
    expect(Object.keys(del[0]!.attrs).sort()).toEqual(['driver', 'ns', 'outcome']);
    expect(del.map((e) => e.attrs['outcome'])).toEqual(['removed', 'absent']);
    expect(Object.keys(query[0]!.attrs).sort()).toEqual(
      ['candidates', 'driver', 'k', 'kernel', 'metric', 'ns', 'outcome'].sort(),
    );
    expect(query[0]!.attrs).toMatchObject({ outcome: 'ok', k: 2, candidates: 3, metric: 'dot' });
    expect(['simd', 'scalar']).toContain(query[0]!.attrs['kernel']);
    expect(query[1]!.attrs).toMatchObject({ metric: 'cosine', candidates: 3 });
    expect(query[2]!.attrs).toMatchObject({ outcome: 'invalid_value' });
  });

  it('never carries a docId, title, sha256, meta, chunk text, gate, vector component or score', async () => {
    const { events, hits, vectors } = await run();
    const wire = JSON.stringify(events);
    for (const [name, value] of Object.entries(SENTINELS))
      expect(wire.includes(value), `${name} leaked into an event`).toBe(false);
    expect(wire.includes('Title of')).toBe(false);
    for (const h of hits) expect(wire.includes(String(h.score))).toBe(false);
    for (const v of vectors) expect(wire.includes(String(v[0]))).toBe(false);
    for (const e of events.filter((x) => x.name.startsWith('storage.doc.'))) {
      for (const [k, v] of Object.entries(e.attrs)) {
        expect(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)).toBe(true);
        expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true);
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it('a namespace that starts with "dockit.d" (registered by the SDK) is emitted as "dockit.d*", in every event', async () => {
    const { events } = await run('dockit.dabc123def');
    const wire = JSON.stringify(events);
    expect(wire.includes('abc123def')).toBe(false);
    const nses = new Set(events.map((e) => e.attrs['ns']));
    expect([...nses]).toEqual(['dockit.d*']);
  });

  it('redactNamespacePrefix registers a prefix emitted as prefix + "*", for KV and index events too', async () => {
    const events: Event[] = [];
    const s = await createStore({ driver: 'memory', events: { emit: (e) => void events.push(e) } });
    stores.push(s);
    s.redactNamespacePrefix('tenant-');
    await s.set('tenant-42', 'k', 'v');
    await s.get('tenant-42', 'k');
    await s.putDocument('tenant-42', docInput('d'), makeChunks(1, 2));
    await s.queryChunks('tenant-42', synthVector(1000, 16), 2);
    await s.set('plain', 'k', 'v');
    const byName = (n: string) => events.filter((e) => e.name === n).map((e) => e.attrs['ns']);
    expect(byName('storage.set')).toEqual(['tenant-*', 'plain']);
    expect(byName('storage.get')).toEqual(['tenant-*']);
    expect(byName('storage.doc.put')).toEqual(['tenant-*']);
    expect(byName('storage.doc.query')).toEqual(['tenant-*']);
    expect(JSON.stringify(events).includes('tenant-42')).toBe(false);
  });

  it('redactNamespacePrefix validates its argument and is bounded', async () => {
    const s = await createStore({ driver: 'memory' });
    stores.push(s);
    for (const bad of ['', 'Upper', 'has space', '_x', 'a'.repeat(65), 5 as unknown as string])
      expect(() => s.redactNamespacePrefix(bad), JSON.stringify(bad)).toThrowError(
        /prefix|namespace/i,
      );
    for (let i = 0; i < 40; i++) {
      try {
        s.redactNamespacePrefix(`p${i}`);
      } catch (e) {
        expect((e as { code?: string }).code).toBe('invalid_value');
        expect(i).toBeGreaterThan(8);
        return;
      }
    }
    throw new Error('the number of registered prefixes is not bounded');
  });

  it('a sink that throws cannot break a document call', async () => {
    const s = await createStore({
      driver: 'memory',
      events: {
        emit: () => {
          throw new Error('sink exploded');
        },
      },
    });
    stores.push(s);
    await s.putDocument(NS, docInput('d'), makeChunks(1, 3));
    expect((await s.queryChunks(NS, synthVector(1000, 16), 1)).length).toBe(1);
    expect(await s.deleteDocument(NS, 'd')).toBe(true);
  });
});

describe('queryChunks over a larger seeded corpus', () => {
  it('matches the naive reference for 60 random queries (both metrics, with and without a docId)', async () => {
    const corpus = seededCorpus();
    const s = await createStore({ driver: 'memory' });
    stores.push(s);
    for (const d of corpus.docs) await s.putDocument(NS, d.input, d.chunks);
    let state = 1234567;
    const rnd = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let i = 0; i < 60; i++) {
      const q = synthVector(Math.floor(rnd() * 200_000), 16);
      const metric = rnd() < 0.5 ? 'cosine' : 'dot';
      const k = 1 + Math.floor(rnd() * 60);
      const docId =
        rnd() < 0.3 ? corpus.docs[Math.floor(rnd() * corpus.docs.length)]!.input.docId : undefined;
      await sameAsReference(s, corpus.ref, q, k, metric, docId);
    }
    expect(corpus.ref.length).toBeGreaterThan(60);
  });
});

describe('restart on a new dim, and the application chunk source', () => {
  it('a new dim over zero-chunk documents starts a new index; the sweep on open removes the old segments, nothing is lost', async () => {
    const d = new MemoryDriver();
    const s = await open(d, { clock: () => 42 });
    await s.putDocument(NS, docInput('empty-1', 3, { meta: { kept: 'yes' } }), []);
    await s.putDocument(NS, docInput('empty-2'), []);
    await s.putDocument(NS, docInput('dense', 4), makeChunks(1, 6, 32));
    // the first index (record rows only, dim 1) is unreferenced now, but still on the driver
    const before = await d.keys(`${DOC_NS_PREFIX}${NS}`);
    expect(before.some((n) => n.startsWith('vec-0/'))).toBe(true);
    expect(before.some((n) => n.startsWith('vec-2/'))).toBe(true);
    await s.close();
    // reopen: the new HEAD is read, the sweep (writer lock free) deletes the old segments' parts
    const again = await open(d);
    const list = await again.listDocuments(NS);
    expect(list.map((x) => x.docId)).toEqual(['dense', 'empty-1', 'empty-2']);
    expect(list.find((x) => x.docId === 'empty-1')).toMatchObject({
      chunks: 0,
      dim: 0,
      createdAt: 42,
      meta: { kept: 'yes' },
    });
    expect((await again.queryChunks(NS, synthVector(1000, 32), 10)).length).toBe(6);
    const after = await d.keys(`${DOC_NS_PREFIX}${NS}`);
    expect(after.some((n) => n.startsWith('vec-0/') || n.startsWith('vec-1/'))).toBe(false);
    expect(after.some((n) => n.startsWith('vec-2/'))).toBe(true);
  });

  it('the application chunk iterator is closed when validation fails, when the writer fails, and when the document is refused', async () => {
    const d = new MemoryDriver();
    const s = await open(d);
    const closed: string[] = [];
    function source(label: string, chunks: ChunkInput[]): Iterable<ChunkInput> {
      return {
        [Symbol.iterator](): Iterator<ChunkInput> {
          let i = 0;
          return {
            next: () =>
              i < chunks.length
                ? { done: false, value: chunks[i++]! }
                : { done: true, value: undefined },
            return: () => {
              closed.push(label);
              return { done: true, value: undefined };
            },
          };
        },
      };
    }
    const bad = makeChunks(1, 5);
    bad[3] = { ...bad[3]!, pageEnd: 99 };
    await expect(s.putDocument(NS, docInput('x'), source('validation', bad))).rejects.toMatchObject(
      {
        details: { reason: 'page', row: 3 },
      },
    );
    await expect(
      s.putDocument(
        NS,
        { ...docInput('x'), title: 'x'.repeat(300) },
        source('refused', makeChunks(1, 2)),
      ),
    ).rejects.toMatchObject({ details: { reason: 'title' } });
    expect(closed).toEqual(['validation']);
    // a source fully consumed is not "closed" by the SDK
    await s.putDocument(NS, docInput('x'), source('complete', makeChunks(1, 2)));
    expect(closed).toEqual(['validation']);
  });
});
