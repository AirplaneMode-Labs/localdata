import { StorageError } from '../contracts/storage-api';
import type { DriverPutMeta, DriverRecord, StorageDriver } from './types';

interface Row {
  bytes: Uint8Array;
  meta: DriverPutMeta;
}

/** In-memory driver for tests and non-browser environments. Bytes are copied on put and get. */
export class MemoryDriver implements StorageDriver {
  readonly name = 'memory' as const;
  private readonly spaces = new Map<string, Map<string, Row>>();
  private opened = false;

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  private ensureOpen(): void {
    if (!this.opened) throw new StorageError('closed', 'memory driver is closed');
  }

  async put(ns: string, key: string, bytes: Uint8Array, meta: DriverPutMeta): Promise<void> {
    this.ensureOpen();
    let space = this.spaces.get(ns);
    if (!space) {
      space = new Map();
      this.spaces.set(ns, space);
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const row: Row = { bytes: copy, meta: { size: meta.size } };
    if (meta.expiresAt !== undefined) row.meta.expiresAt = meta.expiresAt;
    space.set(key, row);
  }

  async getBytes(ns: string, key: string): Promise<DriverRecord | undefined> {
    this.ensureOpen();
    const row = this.spaces.get(ns)?.get(key);
    if (!row) return undefined;
    const copy = new Uint8Array(row.bytes.byteLength);
    copy.set(row.bytes);
    const meta: DriverPutMeta = { size: row.meta.size };
    if (row.meta.expiresAt !== undefined) meta.expiresAt = row.meta.expiresAt;
    return { bytes: copy, meta };
  }

  async del(ns: string, key: string): Promise<boolean> {
    this.ensureOpen();
    const space = this.spaces.get(ns);
    if (!space) return false;
    const existed = space.delete(key);
    if (space.size === 0) this.spaces.delete(ns);
    return existed;
  }

  async keys(ns: string, prefix?: string): Promise<string[]> {
    this.ensureOpen();
    const space = this.spaces.get(ns);
    if (!space) return [];
    const out: string[] = [];
    for (const k of space.keys()) if (prefix === undefined || k.startsWith(prefix)) out.push(k);
    return out.sort();
  }

  async clear(ns: string): Promise<void> {
    this.ensureOpen();
    this.spaces.delete(ns);
  }

  async usage(ns?: string): Promise<{ bytes: number; items: number }> {
    this.ensureOpen();
    let bytes = 0;
    let items = 0;
    const spaces = ns === undefined ? [...this.spaces.values()] : [this.spaces.get(ns)];
    for (const space of spaces) {
      if (!space) continue;
      for (const row of space.values()) {
        bytes += row.meta.size;
        items++;
      }
    }
    return { bytes, items };
  }
}
