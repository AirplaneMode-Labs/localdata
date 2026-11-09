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
