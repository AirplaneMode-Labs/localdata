// Driver-facing types. The authoritative shapes are in the vendored contract; this module adds the
// SDK-internal names drivers share.
export type {
  DriverPutMeta,
  DriverRecord,
  StorageDriver,
  StorageDriverName,
} from '../contracts/storage-api';

/** Reserved namespace that holds the SDK's per-namespace accounting records. */
export const META_NS = '__ld_meta';

/** Root directory name used by the OPFS driver and database name used by the IndexedDB driver. */
export const STORAGE_ROOT = 'airplanemode-localdata';

/**
 * Optional, non-contract driver hooks the vector index uses when a driver offers them. The
 * StorageDriver contract is unchanged: a custom driver without them still works, with the
 * documented limits (single writer; usage() without a namespace counts only indexes this store opened).
 */
export interface DriverHooks {
  /** Drops anything cached for a driver namespace so the next read sees other tabs' writes. */
  refreshIndex?(ns: string): void;
  /** Every driver namespace that currently holds records. */
  namespaces?(): Promise<string[]>;
}
