// How the documents API lays a document out in the document index (Storage API 0.3.0):
//
//   record row   key  <docId>                     vector  zeros(dim)   value  { t, h, b, p, a, m? }
//   chunk row    key  <docId>/<8-digit ordinal>   vector  the chunk's  value  { s, e, t, g? }
//
// A record row has no embedding of its own: its vector is zeros, and it is never a query candidate (only
// chunk rows are). Putting both kinds of row in one index is what makes a document ALL-OR-NOTHING: one HEAD
// commit publishes the record and every chunk, and replaces or retires the old ones in the same commit.
//
// Everything that comes back out of the index is untrusted (a CRC cannot vouch for what a writer put
// there): it is re-validated with the input rules and rebuilt member by member, never returned as stored.
import {
  DOC_CHUNKS_MAX,
  DOC_ID_PATTERN,
  DOC_META_KEYS_MAX,
  DOC_TITLE_MAX,
  type DocumentInfo,
  type Primitive,
  type StorableValue,
} from '../contracts/storage-api';
import { isWellFormed } from '../vec/validate';
import {
  PAGES_MAX,
  SHA256_PATTERN,
  readRecord,
  type ValidChunk,
  type ValidDocument,
} from './validate';

export const ORDINAL_DIGITS = 8;

export function chunkKey(docId: string, ordinal: number): string {
  return `${docId}/${String(ordinal).padStart(ORDINAL_DIGITS, '0')}`;
}

export interface ParsedKey {
  docId: string;
  /** undefined for a record row. */
  ordinal: number | undefined;
}

/** The docId and ordinal behind a stored key, or undefined for a key this layer never writes. */
export function parseKey(key: string): ParsedKey | undefined {
  const i = key.indexOf('/');
  if (i < 0) return DOC_ID_PATTERN.test(key) ? { docId: key, ordinal: undefined } : undefined;
  const docId = key.slice(0, i);
  const digits = key.slice(i + 1);
  if (!DOC_ID_PATTERN.test(docId) || digits.length !== ORDINAL_DIGITS || !/^\d+$/.test(digits))
    return undefined;
  const ordinal = Number(digits);
  return ordinal < DOC_CHUNKS_MAX ? { docId, ordinal } : undefined;
}

/**
 * The string whose UTF-8 order breaks exact score ties between chunk rows: docId ascending by bytes, then
 * ordinal. The raw key would be wrong when one docId is a prefix of another ('a' before 'a-b' but
 * 'a/00000001' after 'a-b/00000000', since '/' sorts after '-'), so the separator becomes U+0001, which
 * sorts before every character a docId can hold.
 */
export function tieKey(key: string): string {
  const i = key.indexOf('/');
  return i < 0 ? key : `${key.slice(0, i)}\u0001${key.slice(i + 1)}`;
}

export function recordValue(doc: ValidDocument, createdAt: number): StorableValue {
  const v: Record<string, StorableValue> = {
    t: doc.title,
    h: doc.sha256,
    b: doc.bytes,
    p: doc.pages,
    a: createdAt,
  };
  if (doc.meta !== undefined) v['m'] = doc.meta;
  return v;
}

export function chunkValue(c: ValidChunk): StorableValue {
  const v: Record<string, StorableValue> = { s: c.pageStart, e: c.pageEnd, t: c.text };
  if (c.gate !== undefined) v['g'] = c.gate;
  return v;
}

export interface RecordFields {
  title: string;
  sha256: string;
  bytes: number;
  pages: number;
  createdAt: number;
  meta: Record<string, Primitive> | undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The record row's value as validated fields, or undefined when it is not what this layer wrote. */
export function readRecordValue(v: unknown): RecordFields | undefined {
  if (!isObject(v)) return undefined;
  const { t, h, b, p, a, m } = v as Record<string, unknown>;
  if (typeof t !== 'string' || t.length > DOC_TITLE_MAX || !isWellFormed(t)) return undefined;
  if (typeof h !== 'string' || !SHA256_PATTERN.test(h)) return undefined;
  if (typeof b !== 'number' || !Number.isSafeInteger(b) || b < 0) return undefined;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > PAGES_MAX) return undefined;
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0) return undefined;
  let meta: Record<string, Primitive> | undefined;
  if (m !== undefined) {
    const r = readRecord(m, DOC_META_KEYS_MAX, 'meta');
    if (!r.ok) return undefined;
    meta = r.value;
  }
  return { title: t, sha256: h, bytes: b, pages: p, createdAt: a, meta };
}

export interface ChunkFields {
  pageStart: number;
  pageEnd: number;
  text: string;
}

/** A chunk row's value as validated fields (pages checked against the document's), or undefined. */
export function readChunkValue(v: unknown, pages: number): ChunkFields | undefined {
  if (!isObject(v)) return undefined;
  const { s, e, t } = v as Record<string, unknown>;
  if (typeof s !== 'number' || typeof e !== 'number' || typeof t !== 'string') return undefined;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s || e > pages) return undefined;
  if (t.length < 1 || !isWellFormed(t)) return undefined;
  return { pageStart: s, pageEnd: e, text: t };
}

/** The DocumentInfo of a validated record, built member by member. */
export function toInfo(docId: string, f: RecordFields, chunks: number, dim: number): DocumentInfo {
  const info: DocumentInfo = {
    docId,
    title: f.title,
    sha256: f.sha256,
    bytes: f.bytes,
    pages: f.pages,
    chunks,
    dim: chunks > 0 ? dim : 0,
    createdAt: f.createdAt,
  };
  if (f.meta !== undefined) info.meta = f.meta;
  return info;
}
