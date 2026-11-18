// Behavioural suite for the documents API (Storage API 0.3.0, D4-02): putDocument, getDocument,
// listDocuments, deleteDocument, queryChunks. The same cases run in Vitest against the memory driver
// (test/documents.test.ts) and inside Chrome against OPFS and IndexedDB (test/browser/documents.spec.ts),
// each across a close and reopen of the store over the same storage.
import {
  CHUNK_TEXT_UTF8_MAX,
  DOC_CHUNKS_MAX,
  DOC_QUERY_K_MAX,
  StorageError,
  type ChunkHit,
  type ChunkInput,
  type DocumentInput,
  type StorageApi,
  type StorageErrorCode,
  type VectorMetric,
} from '../src/contracts/storage-api';
import type { DriverHooks } from '../src/drivers/types';
import { f32Bits, invNormRef, scoreRef } from '../src/vec/reference';
import { synthVector } from '../bench/synth';
import { assertPlainPrototypes } from './proto.behaviour';
import { deepEq, eq, ok } from './assert';
import { using, type PersistCase, type PersistEnv } from './persist-env';

export const NS = 'books';
export const DIM = 16;

/** A deterministic 64-hex sha256 stand-in (the SDK stores what the app computed; it does not verify). */
export function fakeSha(seed: string): string {
  let h = '';
  for (let i = 0; h.length < 64; i++)
    h += ((seed.charCodeAt(i % seed.length) + i * 7) & 0xff).toString(16).padStart(2, '0');
  return h.slice(0, 64);
}

export function docInput(
  docId: string,
  pages = 12,
  extra: Partial<DocumentInput> = {},
): DocumentInput {
  return {
    docId,
    title: `Title of ${docId}`,
    sha256: fakeSha(docId),
    bytes: 1000 + docId.length,
    pages,
    ...extra,
  };
}

/** `n` chunks with ordinals 0..n-1, four chunks per page, vectors from the seeded generator. */
export function makeChunks(seed: number, n: number, dim = DIM, textBytes = 60): ChunkInput[] {
  const out: ChunkInput[] = [];
  for (let i = 0; i < n; i++) {
    const page = 1 + Math.floor(i / 4);
    out.push({
      ordinal: i,
      pageStart: page,
      pageEnd: page,
      text: `doc ${seed} chunk ${i} `.padEnd(textBytes, 'x'),
      vector: synthVector(seed * 1000 + i, dim),
    });
  }
  return out;
}

export const sha = fakeSha;

/** Resolves with the StorageError that `p` rejects with. */
export async function failure(
  p: Promise<unknown> | (() => Promise<unknown>),
): Promise<StorageError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    ok(
      (e as { name?: string }).name === 'StorageError',
      `expected a StorageError, got ${String(e)}`,
    );
    return e as StorageError;
  }
  throw new Error('expected a rejection, but it resolved');
}

export async function invalid(
  p: Promise<unknown> | (() => Promise<unknown>),
  reason: string,
  row?: number,
  code: StorageErrorCode = 'invalid_value',
): Promise<void> {
  const e = await failure(p);
  eq(e.code, code, `code (${e.message})`);
  eq(e.details?.['reason'], reason, `details.reason (${e.message})`);
  if (row !== undefined) eq(e.details?.['row'], row, 'details.row');
}

// ---- the naive reference -------------------------------------------------------------------------------

export interface RefChunk {
  docId: string;
  ordinal: number;
  vector: Float32Array;
}

const encoder = new TextEncoder();
function cmpBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** Score descending, then docId ascending by UTF-8 bytes, then ordinal ascending; min(k, candidates). */
export function refQueryChunks(
  corpus: readonly RefChunk[],
  q: Float32Array,
  k: number,
  metric: VectorMetric = 'cosine',
  docId?: string,
): Array<{ docId: string; ordinal: number; score: number }> {
  const qInv = invNormRef(q);
  const scored = corpus
    .filter((c) => docId === undefined || c.docId === docId)
    .map((c) => ({
      docId: c.docId,
      ordinal: c.ordinal,
      score: scoreRef(c.vector, invNormRef(c.vector), q, qInv, metric),
    }));
  scored.sort((a, b) =>
    a.score !== b.score
      ? a.score > b.score
        ? -1
        : 1
      : cmpBytes(a.docId, b.docId) || a.ordinal - b.ordinal,
  );
  return scored.slice(0, Math.min(k, scored.length));
}

const idOf = (hits: Array<{ docId: string; ordinal: number }>): string[] =>
  hits.map((h) => `${h.docId}#${h.ordinal}`);
const bitsOf = (hits: Array<{ score: number }>): number[] => hits.map((h) => f32Bits(h.score));

export async function sameAsReference(
  store: StorageApi,
  corpus: readonly RefChunk[],
  q: Float32Array,
  k: number,
  metric: VectorMetric,
  docId?: string,
): Promise<ChunkHit[]> {
  const got = await store.queryChunks(NS, q, k, {
    metric,
    ...(docId === undefined ? {} : { docId }),
  });
  const want = refQueryChunks(corpus, q, k, metric, docId);
  await deepEq(idOf(got), idOf(want), `order (k ${k}, ${metric}, ${docId ?? 'all'})`);
  await deepEq(bitsOf(got), bitsOf(want), `score bits (k ${k}, ${metric}, ${docId ?? 'all'})`);
  return got;
}

/** The seeded corpus: ids that are prefixes of each other, 'constructor', gaps in ordinals, and exact ties. */
export const CORPUS_IDS = ['a', 'a-b', 'a_b', 'b', 'constructor', 'doc1', 'prototype', 'z9'];

export interface Corpus {
  docs: Array<{ input: DocumentInput; chunks: ChunkInput[] }>;
  ref: RefChunk[];
}

export function seededCorpus(dim = DIM): Corpus {
  const docs: Corpus['docs'] = [];
  const ref: RefChunk[] = [];
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  CORPUS_IDS.forEach((docId, di) => {
    const n = 3 + (next() % 20);
    const chunks: ChunkInput[] = [];
    let ordinal = next() % 3;
    for (let i = 0; i < n; i++) {
      // Documents 'a', 'a-b' and 'a_b' share vectors for the same chunk index: exact score ties across
      // docIds that are prefixes of each other. 'doc1' repeats a vector inside one document: ties by ordinal.
      const seed = di < 3 ? 77_000 + i : docId === 'doc1' && i % 2 === 1 ? 5_000 : di * 1000 + i;
      const vector = synthVector(seed, dim);
      const page = 1 + Math.floor(i / 3);
      chunks.push({
        ordinal,
        pageStart: page,
        pageEnd: page,
        text: `${docId} ordinal ${ordinal}`,
        vector,
      });
      ref.push({ docId, ordinal, vector });
      ordinal += 1 + (next() % 3);
    }
    docs.push({ input: docInput(docId, 12), chunks });
  });
  return { docs, ref };
}

const ownKeys = (o: object): string[] => Object.keys(o).sort();
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

async function ownedDriverNamespaces(env: PersistEnv): Promise<string[]> {
  const d = await env.raw();
  try {
    return (await (d as unknown as DriverHooks).namespaces?.()) ?? [];
  } finally {
    await d.close();
  }
}

export const documentCases: PersistCase[] = [
  {
    name: 'put, get, list and query across a reopen: chunk text and source page come back',
    run: async (env) => {
      const meta = { source: 'upload', pagesRead: 12, scanned: false, note: null };
      await using(await env.makeStore({ clock: () => 1_700_000_000_000 }), async (s) => {
        const a = await s.putDocument(NS, docInput('policy-1', 12, { meta }), makeChunks(1, 9));
        await deepEq(a, { docId: 'policy-1', chunks: 9, replaced: false, rows: 9 }, 'put result');
        const b = await s.putDocument(NS, docInput('policy-2', 3), makeChunks(2, 5));
        await deepEq(b, { docId: 'policy-2', chunks: 5, replaced: false, rows: 14 }, 'second put');
      });
      await using(await env.reopen(), async (s) => {
        const info = await s.getDocument(NS, 'policy-1');
        ok(info !== undefined, 'document is there after a reopen');
        await deepEq(
          info,
          {
            ...docInput('policy-1', 12, { meta }),
            chunks: 9,
            dim: DIM,
            createdAt: 1_700_000_000_000,
          },
          'DocumentInfo',
        );
        assertPlainPrototypes(info);
        const listed = await s.listDocuments(NS);
        await deepEq(
          listed.map((d) => d.docId),
          ['policy-1', 'policy-2'],
          'listDocuments',
        );
        eq(await s.getDocument(NS, 'missing'), undefined, 'absent document');
        // the nearest chunk of a stored vector is that chunk, with its text and page
        const q = synthVector(1000 + 5, DIM);
        const hits = await s.queryChunks(NS, q, 3);
        eq(hits.length, 3, 'three hits');
        const top = hits[0]!;
        await deepEq(
          {
            docId: top.docId,
            title: top.title,
            ordinal: top.ordinal,
            p: [top.pageStart, top.pageEnd],
          },
          { docId: 'policy-1', title: 'Title of policy-1', ordinal: 5, p: [2, 2] },
          'top hit',
        );
        ok(top.text.startsWith('doc 1 chunk 5 '), 'chunk text returned');
        ok(Math.abs(top.score - 1) < 1e-6, 'a chunk is its own nearest neighbour');
        assertPlainPrototypes(top);
        await deepEq(
          ownKeys(top),
          ['docId', 'ordinal', 'pageEnd', 'pageStart', 'score', 'text', 'title'],
          'ChunkHit fields',
        );
      });
    },
  },

  {
    name: 'queryChunks equals a naive reference on a seeded corpus: ties by docId bytes then ordinal, both metrics, docId filter, across a reopen',
    run: async (env) => {
      const corpus = seededCorpus();
      await using(await env.makeStore(), async (s) => {
        for (const d of corpus.docs) await s.putDocument(NS, d.input, d.chunks);
      });
      await using(await env.reopen(), async (s) => {
        const queries = [
          synthVector(77_001, DIM), // ties across 'a', 'a-b', 'a_b'
          synthVector(5_000, DIM), // ties inside 'doc1'
          synthVector(31_415, DIM),
          synthVector(2_718, DIM),
        ];
        let compared = 0;
        for (const q of queries)
          for (const metric of ['cosine', 'dot'] as const)
            for (const k of [1, 2, 5, 12, 40, 1000]) {
              await sameAsReference(s, corpus.ref, q, k, metric);
              compared++;
            }
        for (const docId of ['a', 'a-b', 'doc1', 'constructor'])
          await sameAsReference(s, corpus.ref, queries[0]!, 7, 'cosine', docId);
        ok(compared >= 48, 'many comparisons ran');
        // k beyond the candidates: min(k, candidates)
        const all = await s.queryChunks(NS, queries[2]!, 1000);
        eq(all.length, corpus.ref.length, 'min(k, candidates)');
        // a docId that does not exist is an empty candidate set
        await deepEq(
          await s.queryChunks(NS, queries[0]!, 5, { docId: 'nope' }),
          [],
          'unknown docId',
        );
      });
    },
  },

  {
    name: 'putDocument replaces a document in one commit: fewer chunks leave no stale chunk, across a reopen',
    run: async (env) => {
      await using(await env.makeStore({ clock: () => 5 }), async (s) => {
        await s.putDocument(NS, docInput('keep'), makeChunks(7, 6));
        await s.putDocument(NS, docInput('swap', 8, { title: 'old title' }), makeChunks(1, 10));
        const r = await s.putDocument(
          NS,
          docInput('swap', 3, { title: 'new title' }),
          makeChunks(9, 4),
        );
        await deepEq(r, { docId: 'swap', chunks: 4, replaced: true, rows: 10 }, 'replace result');
      });
      await using(await env.reopen(), async (s) => {
        const swap = await s.getDocument(NS, 'swap');
        eq(swap?.title, 'new title', 'new record');
        eq(swap?.chunks, 4, 'new chunk count');
        eq(swap?.pages, 3, 'new pages');
        eq((await s.listDocuments(NS)).length, 2, 'still two documents');
        const hits = await s.queryChunks(NS, synthVector(1000 + 8, DIM), 1000, { docId: 'swap' });
        eq(hits.length, 4, 'only the four new chunks of swap are visible');
        for (const h of hits) ok(h.text.startsWith('doc 9 chunk '), 'no chunk of the old version');
        eq(
          (await s.queryChunks(NS, synthVector(1, DIM), 1000)).length,
          10,
          'ten live chunks in all',
        );
        // replacing with more chunks, again in one commit
        await s.putDocument(NS, docInput('swap', 12), makeChunks(3, 15));
      });
      await using(await env.reopen(), async (s) => {
        eq(
          (await s.queryChunks(NS, synthVector(3000, DIM), 1000, { docId: 'swap' })).length,
          15,
          'fifteen chunks',
        );
        eq(
          (await s.queryChunks(NS, synthVector(3000, DIM), 1000)).length,
          21,
          'plus the six of keep',
        );
      });
    },
  },

  {
    name: 'deleteDocument hides the chunks of one document, in one commit, across a reopen; the rest is untouched',
    run: async (env) => {
      const corpus = seededCorpus();
      await using(await env.makeStore(), async (s) => {
        for (const d of corpus.docs) await s.putDocument(NS, d.input, d.chunks);
        eq(await s.deleteDocument(NS, 'a-b'), true, 'deleted');
        eq(await s.deleteDocument(NS, 'a-b'), false, 'second delete is absent');
        eq(await s.deleteDocument(NS, 'never-stored'), false, 'unknown id');
      });
      const left = corpus.ref.filter((c) => c.docId !== 'a-b');
      await using(await env.reopen(), async (s) => {
        eq(await s.getDocument(NS, 'a-b'), undefined, 'gone after reopen');
        eq((await s.listDocuments(NS)).length, corpus.docs.length - 1, 'one fewer');
        for (const metric of ['cosine', 'dot'] as const) {
          const hits = await sameAsReference(s, left, synthVector(77_001, DIM), 1000, metric);
          ok(!hits.some((h) => h.docId === 'a-b'), 'no chunk of the deleted document');
        }
        await deepEq(
          await s.queryChunks(NS, synthVector(77_001, DIM), 5, { docId: 'a-b' }),
          [],
          'filtered to the deleted id',
        );
        // the id can be used again
        const r = await s.putDocument(NS, docInput('a-b'), makeChunks(4, 2));
        eq(r.replaced, false, 'a deleted document is not "replaced"');
      });
    },
  },

  {
    name: 'a document with zero chunks is stored (dim 0); the first chunked document then fixes the namespace dim',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        const empty = await s.putDocument(NS, docInput('empty', 4), []);
        await deepEq(
          empty,
          { docId: 'empty', chunks: 0, replaced: false, rows: 0 },
          'zero-chunk put',
        );
        const info = await s.getDocument(NS, 'empty');
        eq(info?.chunks, 0, 'no chunks');
        eq(info?.dim, 0, 'dim 0 when chunks is 0');
        await deepEq(
          await s.queryChunks(NS, synthVector(1, 8), 5),
          [],
          'no candidates, any query dim',
        );
        // a first chunked document of any dim is accepted, although a zero-chunk document came first
        await s.putDocument(NS, docInput('dense'), makeChunks(1, 3, 32));
      });
      await using(await env.reopen(), async (s) => {
        eq((await s.listDocuments(NS)).length, 2, 'both documents');
        eq((await s.getDocument(NS, 'empty'))?.dim, 0, 'still dim 0');
        eq((await s.getDocument(NS, 'dense'))?.dim, 32, 'the namespace dim is 32');
        eq((await s.queryChunks(NS, synthVector(1000, 32), 5)).length, 3, 'three chunks of dim 32');
        await invalid(() => s.queryChunks(NS, synthVector(1, 8), 5), 'dim');
        // a zero-chunk document replacing a chunked one removes its chunks in the same commit
        await s.putDocument(NS, docInput('dense'), []);
        await deepEq(await s.queryChunks(NS, synthVector(1000, 32), 5), [], 'no chunks left');
        eq((await s.getDocument(NS, 'dense'))?.chunks, 0, 'zero chunks now');
      });
      await using(await env.reopen(), async (s) => {
        // all chunks gone: the namespace is free to take another dim
        await s.putDocument(NS, docInput('again'), makeChunks(2, 2, 24));
        eq((await s.getDocument(NS, 'again'))?.dim, 24, 'dim 24 now');
        eq((await s.queryChunks(NS, synthVector(2000, 24), 5)).length, 2, 'two chunks of dim 24');
      });
    },
  },

  {
    name: 'a chunk whose dim differs from a namespace that holds chunks is refused as dim with its row, and nothing changes',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        await s.putDocument(NS, docInput('one'), makeChunks(1, 4, 16));
        const bad = [...makeChunks(2, 3, 16), { ...makeChunks(2, 1, 8)[0]!, ordinal: 3 }];
        await invalid(() => s.putDocument(NS, docInput('two'), bad), 'dim', 3);
        eq(await s.getDocument(NS, 'two'), undefined, 'the refused document left no record');
        eq((await s.queryChunks(NS, synthVector(1000, 16), 100)).length, 4, 'and no chunk');
        // replacing the only chunked document with another dim is allowed: nothing else holds chunks
        await s.putDocument(NS, docInput('one'), makeChunks(1, 2, 8));
        eq((await s.getDocument(NS, 'one'))?.dim, 8, 'dim changed with the only document');
        await s.putDocument(NS, docInput('three'), makeChunks(3, 2, 8));
        await invalid(() => s.putDocument(NS, docInput('one'), makeChunks(1, 2, 16)), 'dim', 0);
      });
      await using(await env.reopen(), async (s) => {
        eq((await s.getDocument(NS, 'one'))?.dim, 8, 'the refused replace changed nothing');
        eq((await s.listDocuments(NS)).length, 2, 'two documents');
      });
    },
  },

  {
    name: 'queryChunks validates k (1..1000) and the query vector dim',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        await s.putDocument(NS, docInput('d'), makeChunks(1, 5));
        const q = synthVector(1000, DIM);
        for (const k of [0, -1, 1.5, NaN, DOC_QUERY_K_MAX + 1, Infinity])
          await invalid(() => s.queryChunks(NS, q, k), 'k');
        eq((await s.queryChunks(NS, q, DOC_QUERY_K_MAX)).length, 5, 'k = 1000 is fine');
        eq((await s.queryChunks(NS, q, 1)).length, 1, 'k = 1 is fine');
        await invalid(() => s.queryChunks(NS, synthVector(1, DIM + 1), 3), 'dim');
        await invalid(() => s.queryChunks(NS, new Float32Array(0), 3), 'vector');
        await invalid(
          () =>
            s.queryChunks(
              NS,
              Float32Array.from({ length: DIM }, () => NaN),
              3,
            ),
          'vector',
        );
        await failure(() => s.queryChunks('Bad NS', q, 3)).then((e) =>
          eq(e.code, 'invalid_namespace', 'ns'),
        );
        await failure(() => s.queryChunks(NS, q, 3, { docId: 'Bad Id' })).then((e) =>
          eq(e.code, 'invalid_key', 'docId'),
        );
        await failure(() => s.queryChunks('__ld_doc.x', q, 3)).then((e) =>
          eq(e.code, 'invalid_namespace', 'reserved'),
        );
        await deepEq(
          await s.queryChunks('no-such-namespace', q, 3),
          [],
          'a namespace without documents is []',
        );
      });
    },
  },

  {
    name: 'validation order and details.reason for the document fields',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        const ok1 = docInput('fine');
        const put = (d: unknown, c: ChunkInput[] = []) => s.putDocument(NS, d as DocumentInput, c);
        await failure(() => s.putDocument('Bad NS', ok1, [])).then((e) =>
          eq(e.code, 'invalid_namespace', 'ns first'),
        );
        await failure(() => put({ ...ok1, docId: 'Bad Id' })).then((e) =>
          eq(e.code, 'invalid_key', 'docId'),
        );
        for (const id of ['', 'A', '-x', 'a'.repeat(65), 'a/b', 'a b', 'é'])
          await failure(() => put({ ...ok1, docId: id })).then((e) =>
            eq(e.code, 'invalid_key', `docId ${JSON.stringify(id)}`),
          );
        await failure(() => put({ ...ok1, docId: 5 })).then((e) =>
          eq(e.code, 'invalid_key', 'docId not a string'),
        );
        await invalid(() => put({ ...ok1, title: 'x'.repeat(257) }), 'title');
        await invalid(() => put({ ...ok1, title: 'lone \ud800 surrogate' }), 'title');
        await invalid(() => put({ ...ok1, title: 5 }), 'title');
        await invalid(() => put({ ...ok1, sha256: 'A'.repeat(64) }), 'sha256');
        await invalid(() => put({ ...ok1, sha256: 'a'.repeat(63) }), 'sha256');
        await invalid(() => put({ ...ok1, sha256: 5 }), 'sha256');
        for (const b of [-1, 1.5, NaN, 2 ** 53, Infinity, '1'])
          await invalid(() => put({ ...ok1, bytes: b }), 'bytes');
        for (const p of [-1, 1.5, 100_001, NaN, '3'])
          await invalid(() => put({ ...ok1, pages: p }), 'pages');
        await invalid(() => put({ ...ok1, meta: [] }), 'meta');
        await invalid(() => put({ ...ok1, meta: 'x' }), 'meta');
        await invalid(() => put({ ...ok1, meta: { '1bad': 1 } }), 'meta');
        await invalid(() => put({ ...ok1, meta: { 'has space': 1 } }), 'meta');
        await invalid(() => put({ ...ok1, meta: { k: { nested: 1 } } }), 'meta');
        await invalid(() => put({ ...ok1, meta: { k: 'y'.repeat(1025) } }), 'meta');
        await invalid(() => put({ ...ok1, meta: { k: NaN } }), 'meta');
        await invalid(() => put({ ...ok1, meta: { k: undefined } }), 'meta');
        const many: Record<string, number> = {};
        for (let i = 0; i < 17; i++) many[`k${i}`] = i;
        await invalid(() => put({ ...ok1, meta: many }), 'meta');
        for (const k of ['constructor', 'prototype'])
          await invalid(() => put({ ...ok1, meta: { [k]: 1 } }), 'reserved_key');
        await invalid(() => put({ ...ok1, meta: JSON.parse('{"__proto__":1}') }), 'reserved_key');
        // the document fields are checked before any chunk, and before a bad chunks argument
        await invalid(
          () => put({ ...ok1, title: 'x'.repeat(257) }, [{ ordinal: -1 } as ChunkInput]),
          'title',
        );
        await invalid(() => s.putDocument(NS, ok1, 5 as unknown as ChunkInput[]), 'chunks');
        await invalid(() => s.putDocument(NS, null as unknown as DocumentInput, []), 'doc');
        // the boundaries that are fine
        await s.putDocument(
          NS,
          docInput('limits', 100_000, {
            title: 'é'.repeat(256),
            bytes: 2 ** 53 - 1,
            meta: { k: 'y'.repeat(1024) },
          }),
          [],
        );
        const sixteen: Record<string, number> = {};
        for (let i = 0; i < 16; i++) sixteen[`k${i}`] = i;
        await s.putDocument(NS, docInput('sixteen', 2, { meta: sixteen }), []);
        await s.putDocument(NS, docInput('a'.repeat(64)), []);
        await s.putDocument(NS, docInput('t', 0, { title: '' }), []);
        eq((await s.getDocument(NS, 'limits'))?.bytes, 2 ** 53 - 1, 'bytes 2^53-1 stored exactly');
        eq((await s.getDocument(NS, 'limits'))?.pages, 100_000, 'pages 100000');
        eq((await s.listDocuments(NS)).length, 4, 'four documents; the refused ones left nothing');
      });
    },
  },

  {
    name: 'validation reasons for chunk fields carry the 0-based row of the chunk in the call',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        const d = docInput('d', 6);
        const good = (n: number): ChunkInput[] => makeChunks(1, n, DIM);
        const at = (
          n: number,
          patch: Partial<ChunkInput> | ((c: ChunkInput) => ChunkInput),
        ): ChunkInput[] => {
          const cs = good(n + 2);
          const c = cs[n]!;
          cs[n] = typeof patch === 'function' ? patch(c) : { ...c, ...patch };
          return cs;
        };
        const put = (c: ChunkInput[]) => () => s.putDocument(NS, d, c);
        for (const o of [-1, 1.5, NaN, DOC_CHUNKS_MAX, '1' as unknown as number])
          await invalid(put(at(2, { ordinal: o })), 'ordinal', 2);
        await invalid(put(at(3, { ordinal: 0 })), 'duplicate_ordinal', 3);
        for (const [a, b] of [
          [0, 1],
          [3, 2],
          [1, 7],
          [1.5, 2],
          [7, 7],
        ] as const)
          await invalid(put(at(1, { pageStart: a, pageEnd: b })), 'page', 1);
        for (const t of ['', 'x'.repeat(CHUNK_TEXT_UTF8_MAX + 1), '\ud800', 5 as unknown as string])
          await invalid(put(at(0, { text: t })), 'text', 0);
        await invalid(put(at(2, { vector: new Float32Array(0) })), 'vector', 2);
        await invalid(
          put(
            at(2, {
              vector: Float32Array.from({ length: DIM }, (_, i) => (i === 3 ? Infinity : 1)),
            }),
          ),
          'vector',
          2,
        );
        await invalid(put(at(2, { vector: [1, 2, 3] as unknown as Float32Array })), 'vector', 2);
        await invalid(put(at(1, { gate: [] as unknown as Record<string, never> })), 'gate', 1);
        await invalid(put(at(1, { gate: { k: { x: 1 } } as never })), 'gate', 1);
        await invalid(put(at(1, { gate: { '1k': 1 } })), 'gate', 1);
        const nine: Record<string, number> = {};
        for (let i = 0; i < 9; i++) nine[`g${i}`] = i;
        await invalid(put(at(1, { gate: nine })), 'gate', 1);
        await invalid(put(at(1, { gate: { constructor: 1 } })), 'reserved_key', 1);
        await invalid(put(at(1, { gate: JSON.parse('{"__proto__":1}') })), 'reserved_key', 1);
        await invalid(put(at(0, () => null as unknown as ChunkInput)), 'ordinal', 0);
        // nothing of any refused call is visible
        eq(await s.getDocument(NS, 'd'), undefined, 'no record');
        await deepEq(await s.queryChunks(NS, synthVector(1000, DIM), 10), [], 'no chunk');
        // chunks may be any iterable or async iterable
        async function* gen(): AsyncGenerator<ChunkInput> {
          for (const c of good(3)) yield c;
        }
        eq((await s.putDocument(NS, d, gen())).chunks, 3, 'async generator');
        eq((await s.putDocument(NS, d, new Set(good(4)))).chunks, 4, 'a Set');
        // text at the limit, in bytes: ASCII, and 4-byte characters
        const ascii = 'x'.repeat(CHUNK_TEXT_UTF8_MAX);
        const emoji = '\u{1F600}'.repeat(CHUNK_TEXT_UTF8_MAX / 4);
        await s.putDocument(NS, d, [
          { ...good(1)[0]!, ordinal: 0, text: ascii },
          { ...good(2)[1]!, ordinal: 1, text: emoji },
          { ...good(3)[2]!, ordinal: DOC_CHUNKS_MAX - 1 },
        ]);
        const hits = await s.queryChunks(NS, synthVector(1000, DIM), 10, { docId: 'd' });
        eq(hits.length, 3, 'three boundary chunks');
        eq(
          hits.find((h) => h.ordinal === 0)!.text.length,
          CHUNK_TEXT_UTF8_MAX,
          'ASCII text at the limit is intact',
        );
        eq(hits.find((h) => h.ordinal === 1)!.text, emoji, '4-byte text at the limit is intact');
        ok(
          hits.some((h) => h.ordinal === DOC_CHUNKS_MAX - 1),
          'ordinal 19999',
        );
        await invalid(put([{ ...good(1)[0]!, text: `${emoji}x` }]), 'text', 0);
      });
    },
  },

  {
    name: 'documents are isolated from the key-value data and from the generic vector index of the namespace',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        await s.set(NS, 'kv', 'value');
        await s.putVectors(NS, [{ key: 'row', vector: synthVector(1, DIM), value: 'v' }]);
        await s.putDocument(NS, docInput('doc'), makeChunks(1, 5));
        await deepEq((await s.list(NS)).keys, ['kv'], 'list(ns) never lists documents');
        const generic = await s.query(NS, synthVector(1, DIM), 50);
        await deepEq(
          generic.map((h) => h.key),
          ['row'],
          'query(ns) never returns chunks',
        );
        eq((await s.indexInfo(NS))?.rows, 1, 'the generic index has one row');
        eq((await s.queryChunks(NS, synthVector(1000, DIM), 50)).length, 5, 'documents have five');
        eq(await s.get(NS, 'doc'), undefined, 'a docId is not a KV key');
        eq((await s.usage(NS)).items, 1, 'KV items are KV only');
        // a doc-only namespace has no generic index
        await s.putDocument('only-docs', docInput('d'), makeChunks(1, 2));
        eq(await s.indexInfo('only-docs'), undefined, 'no generic index');
        await deepEq(await s.query('only-docs', synthVector(1, DIM), 5), [], 'query is []');
      });
      await using(await env.reopen(), async (s) => {
        eq((await s.listDocuments(NS)).length, 1, 'one document after a reopen');
        await s.clear(NS);
        eq((await s.listDocuments(NS)).length, 0, 'clear(ns) removes the documents too');
        eq(await s.get(NS, 'kv'), undefined, 'and the KV data');
        eq((await s.listDocuments('only-docs')).length, 1, 'another namespace is untouched');
      });
    },
  },

  {
    name: 'usage reports documents and counts their bytes',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        eq((await s.usage(NS)).documents, undefined, 'no document namespace in scope: omitted');
        await s.putDocument(NS, docInput('one'), makeChunks(1, 6));
        await s.putDocument(NS, docInput('two'), makeChunks(2, 6));
        await s.putDocument(NS, docInput('three'), []);
        const u = await s.usage(NS);
        eq(u.documents, 3, 'three documents');
        ok(u.bytes > 6 * 2 * DIM * 4, 'bytes count the vectors and text of the documents');
        eq(u.items, 0, 'KV items unchanged');
        eq((await s.usage()).documents, 3, 'usage() totals every namespace');
        await s.putDocument('other', docInput('x'), makeChunks(3, 1));
        eq((await s.usage()).documents, 4, 'across namespaces');
        eq((await s.usage(NS)).documents, 3, 'one namespace');
        eq(await s.deleteDocument(NS, 'one'), true, 'delete');
        eq((await s.usage(NS)).documents, 2, 'two live documents');
      });
      await using(await env.reopen(), async (s) => {
        eq((await s.usage(NS)).documents, 2, 'two after a reopen');
        eq((await s.usage()).documents, 3, 'three in total after a reopen');
      });
    },
  },

  {
    name: 'clear(ns) physically removes every record of the document namespace',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        await s.putDocument('dockit.dabc123', docInput('abc123'), makeChunks(1, 30, DIM, 400));
        await s.putDocument('dockit.ddef456', docInput('def456'), makeChunks(2, 30, DIM, 400));
        await s.deleteDocument('dockit.dabc123', 'abc123'); // hidden, bytes still on the driver
      });
      let spaces = await ownedDriverNamespaces(env);
      ok(
        spaces.includes('__ld_doc.dockit.dabc123'),
        'the deleted document still occupies its namespace',
      );
      ok(spaces.includes('__ld_doc.dockit.ddef456'), 'the other namespace');
      await using(await env.reopen(), async (s) => {
        eq((await s.listDocuments('dockit.dabc123')).length, 0, 'deleted: hidden from every query');
        await s.clear('dockit.dabc123');
      });
      spaces = await ownedDriverNamespaces(env);
      await deepEq(
        spaces.filter((n) => n.includes('abc123')),
        [],
        'clear(ns) left no driver namespace for it',
      );
      const d = await env.raw();
      try {
        await deepEq(await d.keys('__ld_doc.dockit.dabc123'), [], 'zero records');
        ok(
          (await d.keys('__ld_doc.dockit.ddef456')).length > 0,
          'the other document namespace still holds its records',
        );
      } finally {
        await d.close();
      }
      await using(await env.reopen(), async (s) => {
        await deepEq(
          await s.queryChunks('dockit.dabc123', synthVector(1000, DIM), 5),
          [],
          'reopen: no chunks',
        );
        eq((await s.listDocuments('dockit.dabc123')).length, 0, 'reopen: no documents');
        eq((await s.listDocuments('dockit.ddef456')).length, 1, 'the other namespace is intact');
        await s.clear('dockit.ddef456');
      });
      await deepEq(
        (await ownedDriverNamespaces(env)).filter((n) => n.startsWith('__ld_doc.')),
        [],
        'nothing left',
      );
    },
  },

  {
    name: 'a 20,000-chunk document is stored, listed and queried',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        const dim = 4;
        const rows: ChunkInput[] = [];
        for (let i = 0; i < DOC_CHUNKS_MAX; i++)
          rows.push({
            ordinal: i,
            pageStart: 1 + (i % 50),
            pageEnd: 1 + (i % 50),
            text: `c${i}`,
            vector: synthVector(i, dim),
          });
        const r = await s.putDocument(NS, docInput('big', 50), rows);
        eq(r.chunks, DOC_CHUNKS_MAX, 'chunks');
        eq(r.rows, DOC_CHUNKS_MAX, 'rows');
        const hits = await s.queryChunks(NS, synthVector(12_345, dim), 5);
        eq(hits[0]!.ordinal, 12_345, 'the exact chunk is the nearest');
        eq(hits[0]!.text, 'c12345', 'text');
        eq(hits[0]!.pageStart, 1 + (12_345 % 50), 'page');
        await invalid(
          () =>
            s.putDocument(NS, docInput('toomany', 50), [
              ...rows,
              { ...rows[0]!, ordinal: DOC_CHUNKS_MAX },
            ]),
          'ordinal',
          DOC_CHUNKS_MAX,
        );
      });
      await using(await env.reopen(), async (s) => {
        eq((await s.getDocument(NS, 'big'))?.chunks, DOC_CHUNKS_MAX, 'after a reopen');
        eq(
          (await s.queryChunks(NS, synthVector(19_999, 4), 1))[0]!.ordinal,
          19_999,
          'last ordinal',
        );
      });
    },
  },

  {
    name: 'docId constructor and prototype, and meta and gate keys toString, valueOf and hasOwnProperty, round trip as own members across a reopen',
    run: async (env) => {
      const meta = {
        toString: 'a',
        valueOf: 2,
        hasOwnProperty: true,
        isPrototypeOf: null,
        Constructor: 'ok',
      };
      const gate = { toString: 1, valueOf: 'pass', hasOwnProperty: false };
      await using(await env.makeStore(), async (s) => {
        for (const id of ['constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty']) {
          const cs = makeChunks(1, 2).map((c) => ({ ...c, gate }));
          await s.putDocument(NS, docInput(id, 12, { meta }), cs);
        }
      });
      await using(await env.reopen(), async (s) => {
        await deepEq(
          (await s.listDocuments(NS)).map((d) => d.docId),
          ['constructor', 'hasownproperty', 'prototype', 'tostring', 'valueof'],
          'all five ids listed',
        );
        for (const id of ['constructor', 'prototype']) {
          const info = (await s.getDocument(NS, id))!;
          eq(info.docId, id, 'docId');
          await deepEq(info.meta, meta, 'meta');
          for (const k of Object.keys(meta)) ok(own(info.meta!, k), `meta.${k} is an own member`);
          assertPlainPrototypes(info);
          const hits = await s.queryChunks(NS, synthVector(1000, DIM), 10, { docId: id });
          eq(hits.length, 2, 'two chunks');
          eq(hits[0]!.docId, id, 'hit docId');
          assertPlainPrototypes(hits[0]);
        }
        eq(
          typeof (await s.getDocument(NS, 'constructor'))!.meta!['toString'],
          'string',
          'toString is data, not a function',
        );
      });
    },
  },
];
