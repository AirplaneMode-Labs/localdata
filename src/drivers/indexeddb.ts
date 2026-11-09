// IndexedDB fallback driver. Database 'airplanemode-localdata' version 1, object store 'kv' with
// keyPath [ns, key] and an index 'ns'. Values are stored whole as ArrayBuffer (no chunking).
import { StorageError } from '../contracts/storage-api';
import { toStorageError } from '../errors';
import { STORAGE_ROOT, type DriverPutMeta, type DriverRecord, type StorageDriver } from './types';

const DB_VERSION = 1;
const STORE = 'kv';
const NS_INDEX = 'ns';

interface Row {
  ns: string;
  key: string;
  bytes: ArrayBuffer;
  size: number;
  expiresAt?: number;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Key range covering every key of one namespace: arrays sort after strings in IndexedDB. */
function nsRange(ns: string): IDBKeyRange {
  return IDBKeyRange.bound([ns], [ns, []]);
}

export class IndexedDbDriver implements StorageDriver {
  readonly name = 'indexeddb' as const;
  private db: IDBDatabase | undefined;

  async open(): Promise<void> {
    if (this.db) return;
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory)
      throw new StorageError('driver_unavailable', 'IndexedDB is unavailable in this environment');
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = factory.open(STORAGE_ROOT, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: ['ns', 'key'] });
            store.createIndex(NS_INDEX, 'ns', { unique: false });
          }
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
        r.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
      });
      this.db.onversionchange = () => {
        this.db?.close();
        this.db = undefined;
      };
    } catch (e) {
      throw toStorageError(e, 'indexeddb open');
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  private tx(mode: IDBTransactionMode): [IDBTransaction, IDBObjectStore] {
    if (!this.db) throw new StorageError('closed', 'indexeddb driver is closed');
    const tx = this.db.transaction(STORE, mode);
    return [tx, tx.objectStore(STORE)];
  }

  async put(ns: string, key: string, bytes: Uint8Array, meta: DriverPutMeta): Promise<void> {
    try {
      const [tx, store] = this.tx('readwrite');
      const copy = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const row: Row = { ns, key, bytes: copy, size: meta.size };
      if (meta.expiresAt !== undefined) row.expiresAt = meta.expiresAt;
      store.put(row);
      await txDone(tx);
    } catch (e) {
      throw toStorageError(e, 'indexeddb put');
    }
  }

  async getBytes(ns: string, key: string): Promise<DriverRecord | undefined> {
    try {
      const [, store] = this.tx('readonly');
      const row = (await req(store.get([ns, key]))) as Row | undefined;
      if (!row) return undefined;
      const rec: DriverRecord = { bytes: new Uint8Array(row.bytes), meta: { size: row.size } };
      if (row.expiresAt !== undefined) rec.meta.expiresAt = row.expiresAt;
      return rec;
    } catch (e) {
      throw toStorageError(e, 'indexeddb getBytes');
    }
  }

  async del(ns: string, key: string): Promise<boolean> {
    try {
      const [tx, store] = this.tx('readwrite');
      const count = await req(store.count([ns, key]));
      if (count === 0) return false;
      store.delete([ns, key]);
      await txDone(tx);
      return true;
    } catch (e) {
      throw toStorageError(e, 'indexeddb del');
    }
  }

  async keys(ns: string, prefix?: string): Promise<string[]> {
    try {
      const [, store] = this.tx('readonly');
      const primaryKeys = (await req(store.getAllKeys(nsRange(ns)))) as Array<[string, string]>;
      const out: string[] = [];
      for (const pk of primaryKeys) {
        const k = pk[1];
        if (prefix === undefined || k.startsWith(prefix)) out.push(k);
      }
      return out.sort();
    } catch (e) {
      throw toStorageError(e, 'indexeddb keys');
    }
  }

  async clear(ns: string): Promise<void> {
    try {
      const [tx, store] = this.tx('readwrite');
      store.delete(nsRange(ns));
      await txDone(tx);
    } catch (e) {
      throw toStorageError(e, 'indexeddb clear');
    }
  }

  async usage(ns?: string): Promise<{ bytes: number; items: number }> {
    try {
      const [, store] = this.tx('readonly');
      const source = ns === undefined ? store : store.index(NS_INDEX);
      const range = ns === undefined ? null : IDBKeyRange.only(ns);
      return await new Promise((resolve, reject) => {
        let bytes = 0;
        let items = 0;
        const r = source.openCursor(range);
        r.onsuccess = () => {
          const cursor = r.result;
          if (!cursor) {
            resolve({ bytes, items });
            return;
          }
          const row = cursor.value as Row;
          bytes += row.size;
          items++;
          cursor.continue();
        };
        r.onerror = () => reject(r.error ?? new Error('IndexedDB cursor failed'));
      });
    } catch (e) {
      throw toStorageError(e, 'indexeddb usage');
    }
  }
}
