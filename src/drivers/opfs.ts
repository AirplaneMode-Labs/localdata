// OPFS driver. Layout: <root>/airplanemode-localdata/v1/<ns>/<hex sha-256(key)> holds the bytes
// of one key; <ns>/keys.json is the namespace index (key -> hash, size, expiresAt) rewritten whole
// on every mutation with createWritable({ keepExistingData: false }).
import { StorageError } from '../contracts/storage-api';
import { toStorageError } from '../errors';
import { STORAGE_ROOT, type DriverPutMeta, type DriverRecord, type StorageDriver } from './types';

const VERSION_DIR = 'v1';
const INDEX_FILE = 'keys.json';

interface IndexEntry {
  h: string;
  s: number;
  e?: number;
}

interface IndexFile {
  v: 1;
  k: Record<string, IndexEntry>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function isNotFound(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === 'NotFoundError';
}

export class OpfsDriver implements StorageDriver {
  readonly name = 'opfs' as const;
  private root: FileSystemDirectoryHandle | undefined;
  private readonly indexes = new Map<string, Map<string, IndexEntry>>();

  async open(): Promise<void> {
    if (this.root) return;
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    if (typeof nav?.storage?.getDirectory !== 'function') {
      throw new StorageError(
        'driver_unavailable',
        'OPFS is unavailable: navigator.storage.getDirectory is missing',
      );
    }
    try {
      const top = await nav.storage.getDirectory();
      const app = await top.getDirectoryHandle(STORAGE_ROOT, { create: true });
      this.root = await app.getDirectoryHandle(VERSION_DIR, { create: true });
    } catch (e) {
      throw toStorageError(e, 'opfs open');
    }
  }

  async close(): Promise<void> {
    this.root = undefined;
    this.indexes.clear();
  }

  private rootDir(): FileSystemDirectoryHandle {
    if (!this.root) throw new StorageError('closed', 'opfs driver is closed');
    return this.root;
  }

  private async nsDir(ns: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    try {
      return await this.rootDir().getDirectoryHandle(ns, { create });
    } catch (e) {
      if (!create && isNotFound(e)) return undefined;
      throw e;
    }
  }

  private async loadIndex(ns: string): Promise<Map<string, IndexEntry>> {
    const cached = this.indexes.get(ns);
    if (cached) return cached;
    const m = new Map<string, IndexEntry>();
    const dir = await this.nsDir(ns, false);
    if (dir) {
      try {
        const fh = await dir.getFileHandle(INDEX_FILE);
        const text = await (await fh.getFile()).text();
        const parsed = JSON.parse(text) as IndexFile;
        if (parsed && parsed.v === 1 && parsed.k && typeof parsed.k === 'object') {
          for (const [k, v] of Object.entries(parsed.k)) {
            if (v && typeof v.h === 'string' && typeof v.s === 'number') m.set(k, v);
          }
        }
      } catch (e) {
        if (!isNotFound(e) && !(e instanceof SyntaxError)) throw e;
      }
    }
    this.indexes.set(ns, m);
    return m;
  }

  private async saveIndex(
    ns: string,
    dir: FileSystemDirectoryHandle,
    m: Map<string, IndexEntry>,
  ): Promise<void> {
    const file: IndexFile = { v: 1, k: Object.fromEntries(m) };
    const fh = await dir.getFileHandle(INDEX_FILE, { create: true });
    const w = await fh.createWritable({ keepExistingData: false });
    try {
      await w.write(JSON.stringify(file));
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
    await w.close();
  }

  async put(ns: string, key: string, bytes: Uint8Array, meta: DriverPutMeta): Promise<void> {
    try {
      const dir = (await this.nsDir(ns, true))!;
      const m = await this.loadIndex(ns);
      const h = m.get(key)?.h ?? (await sha256Hex(key));
      const fh = await dir.getFileHandle(h, { create: true });
      const w = await fh.createWritable({ keepExistingData: false });
      try {
        await w.write(bytes as unknown as BufferSource);
      } catch (e) {
        await w.abort().catch(() => undefined);
        throw e;
      }
      await w.close();
      const entry: IndexEntry = { h, s: meta.size };
      if (meta.expiresAt !== undefined) entry.e = meta.expiresAt;
      m.set(key, entry);
      await this.saveIndex(ns, dir, m);
    } catch (e) {
      throw toStorageError(e, 'opfs put');
    }
  }

  async getBytes(ns: string, key: string): Promise<DriverRecord | undefined> {
    try {
      const m = await this.loadIndex(ns);
      const entry = m.get(key);
      if (!entry) return undefined;
      const dir = await this.nsDir(ns, false);
      if (!dir) return undefined;
      let file: File;
      try {
        file = await (await dir.getFileHandle(entry.h)).getFile();
      } catch (e) {
        if (isNotFound(e)) {
          m.delete(key);
          await this.saveIndex(ns, dir, m);
          return undefined;
        }
        throw e;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const rec: DriverRecord = { bytes, meta: { size: entry.s } };
      if (entry.e !== undefined) rec.meta.expiresAt = entry.e;
      return rec;
    } catch (e) {
      throw toStorageError(e, 'opfs getBytes');
    }
  }

  async del(ns: string, key: string): Promise<boolean> {
    try {
      const m = await this.loadIndex(ns);
      const entry = m.get(key);
      if (!entry) return false;
      const dir = await this.nsDir(ns, false);
      if (dir) {
        try {
          await dir.removeEntry(entry.h);
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        m.delete(key);
        await this.saveIndex(ns, dir, m);
      } else {
        m.delete(key);
      }
      return true;
    } catch (e) {
      throw toStorageError(e, 'opfs del');
    }
  }

  async keys(ns: string, prefix?: string): Promise<string[]> {
    try {
      const m = await this.loadIndex(ns);
      const out: string[] = [];
      for (const k of m.keys()) if (prefix === undefined || k.startsWith(prefix)) out.push(k);
      return out.sort();
    } catch (e) {
      throw toStorageError(e, 'opfs keys');
    }
  }

  async clear(ns: string): Promise<void> {
    try {
      this.indexes.delete(ns);
      try {
        await this.rootDir().removeEntry(ns, { recursive: true });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    } catch (e) {
      throw toStorageError(e, 'opfs clear');
    }
  }

  async usage(ns?: string): Promise<{ bytes: number; items: number }> {
    try {
      const namespaces: string[] = [];
      if (ns !== undefined) namespaces.push(ns);
      else for await (const name of this.rootDir().keys()) namespaces.push(name);
      let bytes = 0;
      let items = 0;
      for (const n of namespaces) {
        for (const e of (await this.loadIndex(n)).values()) {
          bytes += e.s;
          items++;
        }
      }
      return { bytes, items };
    } catch (e) {
      throw toStorageError(e, 'opfs usage');
    }
  }
}
