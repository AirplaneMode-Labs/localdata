// OPFS driver. Layout: <root>/airplanemode-localdata/v1/<ns>/<hex sha-256(key)> holds the bytes
// of one key; <ns>/keys.json is the namespace index (key -> hash, size, expiresAt) rewritten whole
// on every mutation with createWritable({ keepExistingData: false }).
import { StorageError } from '../contracts/storage-api';
import { toStorageError } from '../errors';
import {
  STORAGE_ROOT,
  isIndexNamespace,
  userNamespace,
  type BoundedRead,
  type DriverHooks,
  type DriverPutMeta,
  type DriverRecord,
  type ReadLimit,
  type StorageDriver,
} from './types';

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

const HASH_FILE = /^[0-9a-f]{64}$/;

/**
 * Parses keys.json. `strict` (a vector or document namespace) demands the exact shape this driver writes
 * and returns undefined for anything else; the lenient form (key-value namespaces) skips entries it cannot
 * use, as it always has. Undefined means "not a usable index file".
 */
function parseIndexFile(text: string, strict: boolean): Map<string, IndexEntry> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const file = parsed as { v?: unknown; k?: unknown };
  if (file.v !== 1 || typeof file.k !== 'object' || file.k === null || Array.isArray(file.k))
    return undefined;
  const m = new Map<string, IndexEntry>();
  for (const [k, v] of Object.entries(file.k as Record<string, IndexEntry>)) {
    const usable =
      v !== null &&
      typeof v === 'object' &&
      typeof v.h === 'string' &&
      typeof v.s === 'number' &&
      (!strict ||
        (HASH_FILE.test(v.h) &&
          Number.isSafeInteger(v.s) &&
          v.s >= 0 &&
          (v.e === undefined || Number.isFinite(v.e))));
    if (usable) m.set(k, v);
    else if (strict) return undefined;
  }
  return m;
}

/** S1-092: a damaged keys.json of an index namespace is corruption, never an empty index. */
function keysJsonCorrupt(ns: string): StorageError {
  const user = userNamespace(ns);
  return new StorageError(
    'corrupt',
    `the stored index of namespace ${JSON.stringify(user)} failed validation (keys_json in keys.json)`,
    { ns: user, file: INDEX_FILE, reason: 'keys_json' },
  );
}

export class OpfsDriver implements StorageDriver, DriverHooks {
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

  /**
   * Drops the cached keys.json of one namespace. The vector index calls this under its cross-tab
   * lock so a writer in another tab is seen before this tab reads or rewrites the namespace index.
   */
  refreshIndex(ns: string): void {
    this.indexes.delete(ns);
  }

  /** Every namespace directory under the root. */
  async namespaces(): Promise<string[]> {
    try {
      const out: string[] = [];
      for await (const name of this.rootDir().keys()) out.push(name);
      return out.sort();
    } catch (e) {
      throw toStorageError(e, 'opfs namespaces');
    }
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
    let m = new Map<string, IndexEntry>();
    const dir = await this.nsDir(ns, false);
    if (dir) {
      let text: string | undefined;
      try {
        text = await (await (await dir.getFileHandle(INDEX_FILE)).getFile()).text();
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      if (text !== undefined) {
        const strict = isIndexNamespace(ns);
        const parsed = parseIndexFile(text, strict);
        if (parsed === undefined) {
          // Key-value namespaces keep the tolerant behaviour (documented in Limitations); a vector or
          // document namespace refuses, so an unreadable index never looks like an empty one.
          if (strict) throw keysJsonCorrupt(ns);
        } else m = parsed;
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
      const r = await this.read(ns, key);
      return r.kind === 'ok' ? r.record : undefined;
    } catch (e) {
      throw toStorageError(e, 'opfs getBytes');
    }
  }

  /** S1-092: the record is read only if its File.size satisfies `limit`; otherwise nothing is read. */
  async getBytesBounded(ns: string, key: string, limit: ReadLimit): Promise<BoundedRead> {
    try {
      return await this.read(ns, key, limit);
    } catch (e) {
      throw toStorageError(e, 'opfs getBytes');
    }
  }

  private async read(ns: string, key: string, limit?: ReadLimit): Promise<BoundedRead> {
    const m = await this.loadIndex(ns);
    const entry = m.get(key);
    if (!entry) return { kind: 'absent' };
    const dir = await this.nsDir(ns, false);
    if (!dir) return { kind: 'absent' };
    let file: File;
    try {
      file = await (await dir.getFileHandle(entry.h)).getFile();
    } catch (e) {
      if (isNotFound(e)) {
        m.delete(key);
        await this.saveIndex(ns, dir, m);
        return { kind: 'absent' };
      }
      throw e;
    }
    // The size is known from the file's metadata; decide before reading a single byte (S1-092).
    if (limit?.exact !== undefined && file.size !== limit.exact)
      return { kind: 'size', actual: file.size };
    if (limit?.max !== undefined && file.size > limit.max)
      return { kind: 'size', actual: file.size };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const record: DriverRecord = { bytes, meta: { size: entry.s } };
    if (entry.e !== undefined) record.meta.expiresAt = entry.e;
    return { kind: 'ok', record };
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
