// @airplanemode/localdata: set/get/delete/query over OPFS with an IndexedDB fallback, plus a flat
// vector index (putVectors/query) persisted beside the values.
// Implements the Storage API contract 0.2.0 vendored from AirplaneMode-Labs/runtime spec/.
import { StorageError, type StorageDriver } from './contracts/storage-api';
import { IndexedDbDriver } from './drivers/indexeddb';
import { MemoryDriver } from './drivers/memory';
import { OpfsDriver } from './drivers/opfs';
import type { EventSink } from './contracts/event';
import { LocalData, type LocalDataOptions } from './store';
import type { KernelChoice } from './vec/kernel';

export * from './contracts/storage-api';
export {
  EVENT_SPEC,
  STORAGE_EVENT_NAMES,
  type Event,
  type EventAttrs,
  type EventSink,
  type StorageEventName,
} from './contracts/event';
export { LocalData, validateKey, validateNamespace, type LocalDataOptions } from './store';
export { DEFAULT_MAX_INDEX_BYTES } from './vec/files';
export { simdSupported, type KernelChoice, type KernelKind } from './vec/kernel';
export { MemoryDriver } from './drivers/memory';
export { OpfsDriver } from './drivers/opfs';
export { IndexedDbDriver } from './drivers/indexeddb';
export { META_NS, STORAGE_ROOT, type DriverHooks } from './drivers/types';
export { decode, encode } from './codec';
export { isQuotaError, toStorageError } from './errors';

export type DriverChoice = StorageDriver | 'opfs' | 'indexeddb' | 'memory' | 'auto';

export interface CreateStoreOptions {
  /** A driver instance or name. 'auto' picks OPFS, then IndexedDB, else rejects driver_unavailable. */
  driver?: DriverChoice;
  /** Soft quota enforced by the SDK before any write. */
  quotaBytes?: number;
  /** Injectable clock in epoch milliseconds (TTL); defaults to Date.now. */
  clock?: () => number;
  /**
   * Optional EventSink receiving storage.set, storage.get, storage.delete and storage.quota events
   * (Event 0.1.2, source "localdata"). Never receives a key, prefix or value; the namespace does
   * appear. Called synchronously inside try/catch and never awaited.
   */
  events?: EventSink;
  /** Session id for events (1..64 chars); pass the runtime's sessionId() to share one id. */
  eventSession?: string;
  /** Largest vector index (vectors plus META and keys) to write or open, in bytes; default 1 GiB (2^30). */
  maxIndexBytes?: number;
  /** Scan kernel: 'auto' (SIMD when WebAssembly SIMD is available, else scalar), 'simd' or 'scalar'. */
  vectorKernel?: KernelChoice;
}

export function opfsAvailable(): boolean {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  return typeof nav?.storage?.getDirectory === 'function';
}

export function indexedDbAvailable(): boolean {
  return (
    typeof (globalThis as { indexedDB?: IDBFactory }).indexedDB === 'object' &&
    (globalThis as { indexedDB?: IDBFactory }).indexedDB !== null
  );
}

function resolveDriver(choice: DriverChoice): StorageDriver {
  if (typeof choice === 'object') return choice;
  switch (choice) {
    case 'memory':
      return new MemoryDriver();
    case 'opfs':
      if (!opfsAvailable()) {
        throw new StorageError(
          'driver_unavailable',
          'OPFS is unavailable: navigator.storage.getDirectory is missing (Chrome in a secure context is required)',
        );
      }
      return new OpfsDriver();
    case 'indexeddb':
      if (!indexedDbAvailable()) {
        throw new StorageError(
          'driver_unavailable',
          'IndexedDB is unavailable in this environment',
        );
      }
      return new IndexedDbDriver();
    case 'auto':
      if (opfsAvailable()) return new OpfsDriver();
      if (indexedDbAvailable()) return new IndexedDbDriver();
      throw new StorageError(
        'driver_unavailable',
        'neither OPFS nor IndexedDB is available; pass driver: "memory" or a StorageDriver',
      );
    default:
      throw new StorageError('driver_unavailable', `unknown driver ${JSON.stringify(choice)}`);
  }
}

/** Opens a store. The returned object implements StorageApi. */
export async function createStore(opts: CreateStoreOptions = {}): Promise<LocalData> {
  const driver = resolveDriver(opts.driver ?? 'auto');
  const ldOpts: LocalDataOptions = { driver };
  if (opts.quotaBytes !== undefined) ldOpts.quotaBytes = opts.quotaBytes;
  if (opts.clock !== undefined) ldOpts.clock = opts.clock;
  if (opts.events !== undefined) ldOpts.events = opts.events;
  if (opts.eventSession !== undefined) ldOpts.eventSession = opts.eventSession;
  if (opts.maxIndexBytes !== undefined) ldOpts.maxIndexBytes = opts.maxIndexBytes;
  if (opts.vectorKernel !== undefined) ldOpts.vectorKernel = opts.vectorKernel;
  return LocalData.open(ldOpts);
}
