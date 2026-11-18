// Driver-facing types. The authoritative shapes are in the vendored contract; this module adds the
// SDK-internal names drivers share.
import type { DriverRecord } from '../contracts/storage-api';

export type {
  DriverPutMeta,
  DriverRecord,
  StorageDriver,
  StorageDriverName,
} from '../contracts/storage-api';

/** Reserved namespace that holds the SDK's per-namespace accounting records. */
export const META_NS = '__ld_meta';

/** Driver namespaces owned by the SDK: the vector index of `ns` is '__ld_vec.' + ns. */
export const VEC_NS_PREFIX = '__ld_vec.';
/** The documents of `ns` (Storage API 0.3.0) live in '__ld_doc.' + ns. */
export const DOC_NS_PREFIX = '__ld_doc.';

/** True for a driver namespace that holds an SDK index (vector or document), where a damaged keys.json is corruption. */
export function isIndexNamespace(ns: string): boolean {
  return ns.startsWith(VEC_NS_PREFIX) || ns.startsWith(DOC_NS_PREFIX);
}

/** The caller's namespace behind an index driver namespace (the namespace itself when it is neither). */
export function userNamespace(ns: string): string {
  if (ns.startsWith(VEC_NS_PREFIX)) return ns.slice(VEC_NS_PREFIX.length);
  if (ns.startsWith(DOC_NS_PREFIX)) return ns.slice(DOC_NS_PREFIX.length);
  return ns;
}

/** Root directory name used by the OPFS driver and database name used by the IndexedDB driver. */
export const STORAGE_ROOT = 'airplanemode-localdata';

/**
 * Optional, non-contract driver hooks the vector index uses when a driver offers them. The
 * StorageDriver contract is unchanged: a custom driver without them still works, with the
 * documented limits (single writer; usage() without a namespace counts only indexes this store opened).
 */
export interface ReadLimit {
  /** The record must be exactly this many bytes. */
  exact?: number;
  /** The record must be at most this many bytes. */
  max?: number;
}

/** Result of a bounded read: the record, nothing, or a size that broke the limit (nothing was read). */
export type BoundedRead =
  { kind: 'ok'; record: DriverRecord } | { kind: 'absent' } | { kind: 'size'; actual: number };

export interface DriverHooks {
  /**
   * S1-092: reads one record only when its stored size satisfies `limit`, deciding from the file's
   * size BEFORE any of its bytes are read into memory. A driver without it is read whole and checked
   * afterwards (the memory driver already holds the bytes; IndexedDB hands back a whole value).
   */
  getBytesBounded?(ns: string, key: string, limit: ReadLimit): Promise<BoundedRead>;
  /** Drops anything cached for a driver namespace so the next read sees other tabs' writes. */
  refreshIndex?(ns: string): void;
  /** Every driver namespace that currently holds records. */
  namespaces?(): Promise<string[]>;
}
