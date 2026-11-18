// The documents API (Storage API 0.3.0) over the vector index machinery: DocStore is a VectorStore whose
// indexes live under '__ld_doc.' + ns. A document is one record row plus one row per chunk (see
// ./records.ts), so putDocument, deleteDocument and a replace are each ONE HEAD commit: all-or-nothing,
// with the old chunks retired in the same commit. queryChunks is the brute-force scan restricted to
// the chunk rows, with its own tie order (docId bytes, then ordinal).
import {
  DOC_QUERY_K_MAX,
  StorageError,
  type ChunkHit,
  type ChunkInput,
  type DocumentInfo,
  type DocumentInput,
  type PutDocumentResult,
  type QueryChunksOptions,
  type StorageErrorCode,
} from '../contracts/storage-api';
import { DOC_NS_PREFIX } from '../drivers/types';
import { corrupt } from '../vec/files';
import { VectorStore, withWebLock, type Entry, type VectorStoreOptions } from '../vec';
import { OpenIndex, readValue } from '../vec/reader';
import { compareUtf8 } from '../vec/topk';
import { checkMetric, checkQueryVector } from '../vec/validate';
import { tombstoneKeys } from '../vec/writer';
import {
  chunkKey,
  chunkValue,
  parseKey,
  readChunkValue,
  readRecordValue,
  recordValue,
  tieKey,
  toInfo,
} from './records';
import { checkChunk, checkDocId, checkDocument, chunkIterator, invalidDoc } from './validate';
import type { VectorRow } from '../contracts/storage-api';

/** Dim of the index while no chunk has fixed one: record rows still need a vector. */
const PLACEHOLDER_DIM = 1;

interface DocView {
  idx: OpenIndex;
  generation: number;
  /** docId -> row of its record. */
  records: Map<string, number>;
  /** docId -> live chunk rows (only for documents that have a record). */
  chunkRows: Map<string, number[]>;
  /** 1 for a live chunk row of a document that has a record: the query candidates. */
  mask: Uint8Array;
  chunkCount: number;
  info: Map<string, DocumentInfo>;
}

export interface PutProbe {
  chunks: number;
  replaced: boolean;
  rows: number;
  bytes: number | undefined;
}

export interface QueryProbe {
  candidates: number;
  metric: string;
}

export interface DocUsage {
  documents: number;
  bytes: number;
}

function copyInfo(i: DocumentInfo): DocumentInfo {
  const out: DocumentInfo = { ...i };
  if (i.meta !== undefined) out.meta = { ...i.meta };
  return out;
}

const dimError = (): StorageError =>
  new StorageError('invalid_value', 'the query vector length differs from the namespace dim', {
    reason: 'dim',
  });

export class DocStore extends VectorStore {
  constructor(o: Omit<VectorStoreOptions, 'prefix'>) {
    super({ ...o, prefix: DOC_NS_PREFIX });
  }

  // ---- derived view -------------------------------------------------------------------------------

  private viewOf(e: Entry, idx: OpenIndex): DocView {
    const cached = e.ext as DocView | undefined;
    if (cached && cached.idx === idx && cached.generation === idx.generation) return cached;
    const records = new Map<string, number>();
    const tmp = new Map<string, number[]>();
    for (const [key, row] of idx.live) {
      const p = parseKey(key);
      if (p === undefined) continue;
      if (p.ordinal === undefined) records.set(p.docId, row);
      else {
        let a = tmp.get(p.docId);
        if (a === undefined) tmp.set(p.docId, (a = []));
        a.push(row);
      }
    }
    const chunkRows = new Map<string, number[]>();
    const mask = new Uint8Array(idx.totalRows);
    let chunkCount = 0;
    for (const [docId, rows] of tmp) {
      if (!records.has(docId)) continue; // chunk rows without a record are never visible
      chunkRows.set(docId, rows);
      for (const r of rows) mask[r] = 1;
      chunkCount += rows.length;
    }
    const view: DocView = {
      idx,
      generation: idx.generation,
      records,
      chunkRows,
      mask,
      chunkCount,
      info: new Map(),
    };
    e.ext = view;
    return view;
  }

  private async rowValue(e: Entry, idx: OpenIndex, row: number): Promise<unknown> {
    const seg = idx.segmentOf(row);
    return readValue(this.ctx(e, idx.kernel), idx, seg, row - seg.firstRow);
  }

  private async infoOf(
    e: Entry,
    idx: OpenIndex,
    view: DocView,
    docId: string,
  ): Promise<DocumentInfo> {
    const known = view.info.get(docId);
    if (known !== undefined) return known;
    const fields = readRecordValue(await this.rowValue(e, idx, view.records.get(docId)!));
    if (fields === undefined) throw corrupt(e.ns, 'doc-records', 'doc_record');
    const info = toInfo(docId, fields, view.chunkRows.get(docId)?.length ?? 0, idx.dim);
    view.info.set(docId, info);
    return info;
  }

  /** A read failed: stick a corrupt result for this HEAD (as the vector index does) and map the error. */
  private readFailure(e: Entry, err: unknown, context: string): StorageError {
    const se = this.convert(err, e.ns, false, context);
    if (se.code === 'corrupt' && se.details?.['reason'] !== 'wasm_trap' && e.state !== 'corrupt')
      this.stick(e, se);
    return se;
  }

  // ---- put ------------------------------------------------------------------------------------------

  async put(
    ns: string,
    rawDoc: DocumentInput,
    chunks: Iterable<ChunkInput> | AsyncIterable<ChunkInput>,
    now: () => number,
    probe: PutProbe,
  ): Promise<PutDocumentResult> {
    const doc = checkDocument(rawDoc);
    const it = chunkIterator(chunks);
    let started = false;
    try {
      // The first chunk is read before the lock so its vector length can decide whether this write may
      // change the namespace dim; it is validated like every other chunk, in the stream below.
      const first = await it.next();
      const fv = first.done ? undefined : (first.value as { vector?: unknown } | null)?.vector;
      const firstDim = fv instanceof Float32Array ? fv.length : 0;
      const e = this.entry(ns);
      return await this.exclusive(e, () =>
        withWebLock(this.lockName(ns), async () => {
          const idx = await this.refreshForWrite(e);
          const view = idx === undefined ? undefined : this.viewOf(e, idx);
          const replaced = view?.records.has(doc.docId) ?? false;
          const oldRows = view?.chunkRows.get(doc.docId) ?? [];
          const otherChunks = (view?.chunkCount ?? 0) - oldRows.length;
          // No chunk of another document fixes the dim: this write may set a new one, and starts a new
          // index (the zero-chunk documents' records are carried over).
          const restart =
            idx !== undefined && firstDim > 0 && firstDim !== idx.dim && otherChunks === 0;
          const recordDim =
            firstDim > 0 && (restart || idx === undefined)
              ? firstDim
              : (idx?.dim ?? PLACEHOLDER_DIM);
          const carried: VectorRow[] = [];
          if (restart && idx !== undefined && view !== undefined) {
            for (const [id, row] of view.records) {
              if (id === doc.docId) continue;
              const v = await this.rowValue(e, idx, row);
              if (readRecordValue(v) === undefined) throw corrupt(ns, 'doc-records', 'doc_record');
              carried.push({ key: id, vector: new Float32Array(recordDim), value: v as never });
            }
          }
          let written = 0;
          const rows = async function* (): AsyncGenerator<VectorRow> {
            const seen = new Set<number>();
            let pending: IteratorResult<unknown> | undefined = first;
            let drained = false;
            try {
              for (;;) {
                const r: IteratorResult<unknown> = pending ?? (await it.next());
                pending = undefined;
                if (r.done) break;
                const c = checkChunk(r.value, written, doc.pages, seen);
                yield {
                  key: chunkKey(doc.docId, c.ordinal),
                  vector: c.vector,
                  value: chunkValue(c) as never,
                };
                written++;
              }
              drained = true;
            } finally {
              // A failure (here or in the writer) closes the application's chunk source.
              if (!drained) await Promise.resolve(it.return?.()).catch(() => undefined);
            }
            for (const o of carried) yield o;
            yield {
              key: doc.docId,
              vector: new Float32Array(recordDim),
              value: recordValue(doc, now()) as never,
            };
          };
          started = true;
          const retire = oldRows.map((r) => idx!.keys[r]!);
          const out = await this.commitRows(e, idx, rows(), { retire, restart });
          probe.chunks = written;
          probe.replaced = replaced;
          probe.rows = otherChunks + written;
          probe.bytes = out.bytes;
          return { docId: doc.docId, chunks: written, replaced, rows: otherChunks + written };
        }),
      );
    } catch (err) {
      if (!started) await Promise.resolve(it.return?.()).catch(() => undefined);
      throw this.convert(err, ns, true, 'putDocument');
    }
  }

  // ---- reads ----------------------------------------------------------------------------------------

  async get(ns: string, docId: string): Promise<DocumentInfo | undefined> {
    checkDocId(docId);
    const e = this.entry(ns);
    try {
      return await this.exclusive(e, async () => {
        const idx = await this.ensure(e, 'meta', true);
        if (idx === undefined) return undefined;
        const view = this.viewOf(e, idx);
        if (!view.records.has(docId)) return undefined;
        return copyInfo(await this.infoOf(e, idx, view, docId));
      });
    } catch (err) {
      throw this.readFailure(e, err, 'getDocument');
    }
  }

  async list(ns: string): Promise<DocumentInfo[]> {
    const e = this.entry(ns);
    try {
      return await this.exclusive(e, async () => {
        const idx = await this.ensure(e, 'meta', true);
        if (idx === undefined) return [];
        const view = this.viewOf(e, idx);
        const out: DocumentInfo[] = [];
        for (const id of [...view.records.keys()].sort(compareUtf8))
          out.push(copyInfo(await this.infoOf(e, idx, view, id)));
        return out;
      });
    } catch (err) {
      throw this.readFailure(e, err, 'listDocuments');
    }
  }

  /** Top-k chunks (storage-api.md, Documents): score descending, docId bytes ascending, ordinal ascending. */
  async queryChunks(
    ns: string,
    vector: Float32Array,
    k: number,
    opts: QueryChunksOptions | undefined,
    probe: QueryProbe,
  ): Promise<ChunkHit[]> {
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > DOC_QUERY_K_MAX)
      throw new StorageError('invalid_value', `k must be an integer 1..${DOC_QUERY_K_MAX}`, {
        reason: 'k',
      });
    checkQueryVector(vector);
    if (opts?.docId !== undefined) checkDocId(opts.docId);
    if (opts?.metric !== undefined) checkMetric(opts.metric);
    const metric = opts?.metric ?? 'cosine';
    probe.metric = metric;
    const e = this.entry(ns);
    try {
      return await this.exclusive(e, async () => {
        const idx = await this.ensure(e, 'full', true);
        if (idx === undefined) return [];
        const view = this.viewOf(e, idx);
        if (view.chunkCount === 0) return [];
        if (vector.length !== idx.dim) throw dimError();
        let only: Set<number> | undefined;
        if (opts?.docId !== undefined) {
          const rows = view.chunkRows.get(opts.docId);
          if (rows === undefined) return [];
          only = new Set(rows);
        }
        const found = this.scan(idx, vector, k, metric === 'dot' ? 1 : 0, undefined, {
          row: (r) => view.mask[r] === 1 && (only === undefined || only.has(r)),
          capacity: only?.size ?? view.chunkCount,
          tieKey,
        });
        probe.candidates = found.candidates;
        const hits: ChunkHit[] = [];
        for (const { row, score } of found.top) {
          const p = parseKey(idx.keys[row]!)!;
          const record = await this.infoOf(e, idx, view, p.docId);
          const cf = readChunkValue(await this.rowValue(e, idx, row), record.pages);
          if (cf === undefined) throw corrupt(ns, 'doc-chunks', 'chunk_record');
          hits.push({
            docId: p.docId,
            title: record.title,
            ordinal: p.ordinal!,
            pageStart: cf.pageStart,
            pageEnd: cf.pageEnd,
            text: cf.text,
            score,
          });
        }
        return hits;
      });
    } catch (err) {
      throw this.readFailure(e, err, 'queryChunks');
    }
  }

  // ---- delete ---------------------------------------------------------------------------------------

  /** Tombstones the record and every chunk of `docId` in ONE new generation. Resolves false when absent. */
  async remove(ns: string, docId: string): Promise<boolean> {
    checkDocId(docId);
    const e = this.entry(ns);
    try {
      return await this.exclusive(e, () =>
        withWebLock(this.lockName(ns), async () => {
          const idx = await this.refreshForWrite(e);
          if (idx === undefined) return false;
          const view = this.viewOf(e, idx);
          if (!view.records.has(docId)) return false;
          const keys = [docId, ...(view.chunkRows.get(docId) ?? []).map((r) => idx.keys[r]!)];
          const kernel = await this.getKernel();
          await tombstoneKeys(this.wctx(e, kernel), idx, keys);
          return true;
        }),
      );
    } catch (err) {
      throw this.convert(err, ns, true, 'deleteDocument');
    }
  }

  // ---- usage ----------------------------------------------------------------------------------------

  /** Live documents and index bytes of one namespace, or of every document namespace; undefined when none. */
  async docUsage(ns?: string): Promise<DocUsage | undefined> {
    if (ns !== undefined) return this.docUsageOne(ns);
    const names = new Set<string>();
    for (const n of (await this.d.namespaces?.()) ?? [])
      if (n.startsWith(DOC_NS_PREFIX)) names.add(n.slice(DOC_NS_PREFIX.length));
    for (const n of this.openNamespaces()) names.add(n);
    let documents = 0;
    let bytes = 0;
    let any = false;
    for (const n of names) {
      const u = await this.docUsageOne(n);
      if (u) {
        documents += u.documents;
        bytes += u.bytes;
        any = true;
      }
    }
    return any ? { documents, bytes } : undefined;
  }

  private async docUsageOne(ns: string): Promise<DocUsage | undefined> {
    const e = this.entry(ns);
    try {
      return await this.exclusive(e, async () => {
        const idx = await this.ensure(e, 'meta', true);
        if (idx === undefined) return undefined;
        return { documents: this.viewOf(e, idx).records.size, bytes: idx.bytes };
      });
    } catch (err) {
      if (err instanceof StorageError && err.code === 'corrupt') return undefined;
      throw this.convert(err, ns, false, 'usage');
    }
  }
}

export type { StorageErrorCode };
export { invalidDoc };
