// @airplanemode/localdata: set/get/delete/query over OPFS with an IndexedDB fallback.
// Implements the Storage API contract 0.1.0 vendored from AirplaneMode-Labs/runtime spec/.
import { StorageError, type StorageDriver } from './contracts/storage-api';
import { IndexedDbDriver } from './drivers/indexeddb';
import { MemoryDriver } from './drivers/memory';
import { OpfsDriver } from './drivers/opfs';
import { LocalData } from './store';

export * from './contracts/storage-api';
export { LocalData, validateKey, validateNamespace, type LocalDataOptions } from './store';
export { MemoryDriver } from './drivers/memory';
export { OpfsDriver } from './drivers/opfs';
export { IndexedDbDriver } from './drivers/indexeddb';
export { META_NS, STORAGE_ROOT } from './drivers/types';
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
  const ldOpts: { driver: StorageDriver; quotaBytes?: number; clock?: () => number } = { driver };
  if (opts.quotaBytes !== undefined) ldOpts.quotaBytes = opts.quotaBytes;
  if (opts.clock !== undefined) ldOpts.clock = opts.clock;
  return LocalData.open(ldOpts);
}
