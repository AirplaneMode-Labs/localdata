// Input validation for the documents API (Storage API 0.3.0). Messages and details never contain a docId,
// a title, a meta or gate value, chunk text, a vector component or a score: a bad chunk is identified by
// its 0-based position in the call (details.row), a bad document field by details.reason.
//
// Validation order (normative, storage-api.md): invalid_namespace; invalid_key (docId); invalid_value for
// the document fields with reason 'title' | 'sha256' | 'bytes' | 'pages' | 'meta' | 'reserved_key'; then,
// as the chunks stream, invalid_value for each chunk with { reason, row }; then quota; then the commit.
import {
  CHUNK_GATE_KEYS_MAX,
  CHUNK_TEXT_UTF8_MAX,
  DOC_CHUNKS_MAX,
  DOC_ID_PATTERN,
  DOC_META_KEYS_MAX,
  DOC_TITLE_MAX,
  StorageError,
  VECTOR_DIM_MAX,
  type DocumentInput,
  type Primitive,
} from '../contracts/storage-api';
import { setOwn } from '../own';
import { isWellFormed, utf8Length } from '../vec/validate';

/** Keys that name the prototype machinery: refused, whatever the application meant by them. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export const RECORD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const META_STRING_MAX = 1024;
export const PAGES_MAX = 100_000;

export function invalidDoc(reason: string): StorageError {
  return new StorageError('invalid_value', `invalid document: ${reason}`, { reason });
}

export function invalidChunk(reason: string, row: number): StorageError {
  return new StorageError('invalid_value', `chunk ${row}: invalid ${reason}`, { reason, row });
}

export function invalidDocId(): StorageError {
  return new StorageError('invalid_key', 'invalid docId: it must match ^[a-z0-9][a-z0-9_-]{0,63}$');
}

export function checkDocId(docId: unknown): asserts docId is string {
  if (typeof docId !== 'string' || !DOC_ID_PATTERN.test(docId)) throw invalidDocId();
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function primitiveOk(v: unknown): v is Primitive {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.length <= META_STRING_MAX && isWellFormed(v);
}

/**
 * Validates a meta or gate record and returns a sanitised copy built with setOwn (so an own key such as
 * 'toString' stays an ordinary member). Returns the failing reason instead of throwing, so the same rules
 * serve input validation (which throws with the right details) and the decoding of stored bytes (where any
 * failure is corruption).
 */
export function readRecord(
  v: unknown,
  max: number,
  failReason: string,
): { ok: true; value: Record<string, Primitive> } | { ok: false; reason: string } {
  if (!isPlainRecord(v)) return { ok: false, reason: failReason };
  const keys = Object.keys(v);
  if (keys.length > max) return { ok: false, reason: failReason };
  const out: Record<string, Primitive> = {};
  for (const k of keys) {
    if (RESERVED_KEYS.has(k)) return { ok: false, reason: 'reserved_key' };
    if (!RECORD_KEY_PATTERN.test(k)) return { ok: false, reason: failReason };
    const x = v[k];
    if (!primitiveOk(x)) return { ok: false, reason: failReason };
    setOwn(out, k, x);
  }
  return { ok: true, value: out };
}

export interface ValidDocument {
  docId: string;
  title: string;
  sha256: string;
  bytes: number;
  pages: number;
  meta: Record<string, Primitive> | undefined;
}

/** Steps 2 to 4 of the validation order: docId, then the document fields. */
export function checkDocument(doc: unknown): ValidDocument {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw invalidDoc('doc');
  const d = doc as Partial<Record<keyof DocumentInput, unknown>>;
  checkDocId(d.docId);
  const { title, sha256, bytes, pages } = d;
  if (typeof title !== 'string' || title.length > DOC_TITLE_MAX || !isWellFormed(title))
    throw invalidDoc('title');
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) throw invalidDoc('sha256');
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)
    throw invalidDoc('bytes');
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 0 || pages > PAGES_MAX)
    throw invalidDoc('pages');
  let meta: Record<string, Primitive> | undefined;
  if (d.meta !== undefined) {
    const r = readRecord(d.meta, DOC_META_KEYS_MAX, 'meta');
    if (!r.ok) throw invalidDoc(r.reason);
    meta = r.value;
  }
  return { docId: d.docId, title, sha256, bytes, pages, meta };
}

/** The 'chunks' argument must be an iterable or an async iterable. */
export function chunkIterator(chunks: unknown): AsyncIterator<unknown> {
  if (typeof chunks === 'object' && chunks !== null) {
    const c = chunks as { [Symbol.asyncIterator]?: unknown; [Symbol.iterator]?: unknown };
    if (typeof c[Symbol.asyncIterator] === 'function')
      return (chunks as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    if (typeof c[Symbol.iterator] === 'function') {
      const it = (chunks as Iterable<unknown>)[Symbol.iterator]();
      return {
        next: async () => it.next() as IteratorResult<unknown>,
        return: async (value?: unknown) =>
          (it.return ? it.return(value) : { done: true, value }) as IteratorResult<unknown>,
      };
    }
  }
  throw invalidDoc('chunks');
}

export interface ValidChunk {
  ordinal: number;
  pageStart: number;
  pageEnd: number;
  text: string;
  vector: Float32Array;
  gate: Record<string, Primitive> | undefined;
}

/**
 * Validates one chunk as it streams. `seen` holds the ordinals already used in this call. The vector's
 * components and the namespace dim are checked by the writer (reasons 'vector' and 'dim', same row).
 */
export function checkChunk(c: unknown, row: number, pages: number, seen: Set<number>): ValidChunk {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw invalidChunk('ordinal', row);
  const x = c as Record<string, unknown>;
  const ordinal = x['ordinal'];
  if (
    typeof ordinal !== 'number' ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= DOC_CHUNKS_MAX
  )
    throw invalidChunk('ordinal', row);
  if (seen.has(ordinal)) throw invalidChunk('duplicate_ordinal', row);
  const pageStart = x['pageStart'];
  const pageEnd = x['pageEnd'];
  if (
    typeof pageStart !== 'number' ||
    typeof pageEnd !== 'number' ||
    !Number.isInteger(pageStart) ||
    !Number.isInteger(pageEnd) ||
    pageStart < 1 ||
    pageEnd < pageStart ||
    pageEnd > pages
  )
    throw invalidChunk('page', row);
  const text = x['text'];
  // UTF-16 units never exceed UTF-8 bytes, so a string longer than the byte limit is refused unencoded.
  if (
    typeof text !== 'string' ||
    text.length < 1 ||
    text.length > CHUNK_TEXT_UTF8_MAX ||
    !isWellFormed(text) ||
    utf8Length(text) > CHUNK_TEXT_UTF8_MAX
  )
    throw invalidChunk('text', row);
  const vector = x['vector'];
  if (!(vector instanceof Float32Array) || vector.length < 1 || vector.length > VECTOR_DIM_MAX)
    throw invalidChunk('vector', row);
  let gate: Record<string, Primitive> | undefined;
  if (x['gate'] !== undefined) {
    const r = readRecord(x['gate'], CHUNK_GATE_KEYS_MAX, 'gate');
    if (!r.ok) throw invalidChunk(r.reason, row);
    gate = r.value;
  }
  seen.add(ordinal);
  return { ordinal, pageStart, pageEnd, text, vector, gate };
}
