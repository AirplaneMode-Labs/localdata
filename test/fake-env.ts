// A fake `navigator` for Node tests: an in-memory Origin Private File System (enough of the File System
// API for src/drivers/opfs.ts) and a Web Locks manager (exclusive, with ifAvailable and a way for a test
// to hold a lock as "another tab"). Records are real Node `File` objects, so a spy on
// Blob.prototype.arrayBuffer sees exactly what the driver reads.
//
// This is test scaffolding only. Real OPFS behaviour is covered in installed Chrome by test/browser/*.

interface Entry {
  name: string;
  bytes: Uint8Array;
}

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

export class FakeDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDir | Entry>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return c;
    if (c !== undefined) throw domError('TypeMismatchError', `${name} is a file`);
    if (!opts?.create) throw domError('NotFoundError', `${name} not found`);
    const d = new FakeDir(name);
    this.children.set(name, d);
    return d;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) throw domError('TypeMismatchError', `${name} is a directory`);
    if (c !== undefined) return new FakeFileHandle(c);
    if (!opts?.create) throw domError('NotFoundError', `${name} not found`);
    const e: Entry = { name, bytes: new Uint8Array(0) };
    this.children.set(name, e);
    return new FakeFileHandle(e);
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const c = this.children.get(name);
    if (c === undefined) throw domError('NotFoundError', `${name} not found`);
    if (c instanceof FakeDir && c.children.size > 0 && !opts?.recursive)
      throw domError('InvalidModificationError', `${name} is not empty`);
    this.children.delete(name);
  }

  async *keys(): AsyncGenerator<string> {
    for (const k of [...this.children.keys()]) yield k;
  }

  /** The entry at a path below this directory, or undefined. For tests that plant or inspect files. */
  entry(...path: string[]): Entry | undefined {
    let cur: FakeDir | Entry | undefined = this;
    for (const p of path) {
      if (!(cur instanceof FakeDir)) return undefined;
      cur = cur.children.get(p);
    }
    return cur instanceof FakeDir ? undefined : cur;
  }

  dir(...path: string[]): FakeDir | undefined {
    let cur: FakeDir | Entry | undefined = this;
    for (const p of path) {
      if (!(cur instanceof FakeDir)) return undefined;
      cur = cur.children.get(p);
    }
    return cur instanceof FakeDir ? cur : undefined;
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  constructor(private readonly e: Entry) {}

  get name(): string {
    return this.e.name;
  }

  async getFile(): Promise<File> {
    // A snapshot, like the real API: later writes do not change it.
    return new File([this.e.bytes.slice()], this.e.name);
  }

  async createWritable(): Promise<{
    write(data: unknown): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    const chunks: Uint8Array[] = [];
    const e = this.e;
    return {
      async write(data: unknown) {
        if (typeof data === 'string') chunks.push(new TextEncoder().encode(data));
        else if (data instanceof Uint8Array) chunks.push(data.slice());
        else if (data instanceof ArrayBuffer) chunks.push(new Uint8Array(data.slice(0)));
        else throw new TypeError('fake OPFS: unsupported write payload');
      },
      async close() {
        let n = 0;
        for (const c of chunks) n += c.byteLength;
        const out = new Uint8Array(n);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.byteLength;
        }
        e.bytes = out;
      },
      async abort() {
        chunks.length = 0;
      },
    };
  }
}

type LockCallback<T> = (lock: { name: string; mode: string } | null) => Promise<T> | T;

/** Exclusive Web Locks. `hold(name)` takes a lock the way another tab's writer would. */
export class FakeLocks {
  readonly requests: Array<{ name: string; ifAvailable: boolean }> = [];
  private readonly held = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  /** Takes the lock now (it must be free) and returns the release function. */
  hold(name: string): () => void {
    if (this.held.has(name)) throw new Error(`fake lock ${name} is already held`);
    this.held.add(name);
    return () => this.release(name);
  }

  private release(name: string): void {
    this.held.delete(name);
    const next = this.waiters.get(name)?.shift();
    if (next) next();
  }

  request<T>(
    name: string,
    a: { mode?: string; ifAvailable?: boolean } | LockCallback<T>,
    b?: LockCallback<T>,
  ): Promise<T> {
    const opts = typeof a === 'function' ? {} : a;
    const cb = (typeof a === 'function' ? a : b) as LockCallback<T>;
    const ifAvailable = opts.ifAvailable === true;
    this.requests.push({ name, ifAvailable });
    if (this.held.has(name) && ifAvailable) return Promise.resolve(cb(null));
    const run = async (): Promise<T> => {
      this.held.add(name);
      try {
        return await cb({ name, mode: 'exclusive' });
      } finally {
        this.release(name);
      }
    };
    if (!this.held.has(name)) return run();
    return new Promise<T>((resolve, reject) => {
      const q = this.waiters.get(name) ?? [];
      q.push(() => void run().then(resolve, reject));
      this.waiters.set(name, q);
    });
  }
}

export interface FakeNavigator {
  /** The OPFS root (what navigator.storage.getDirectory() resolves to). */
  root: FakeDir;
  locks: FakeLocks;
  restore(): void;
}

/** Installs a fake navigator with an OPFS root and a lock manager; call restore() in afterEach. */
export function installFakeNavigator(opts: { locks?: boolean } = {}): FakeNavigator {
  const g = globalThis as { navigator?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const root = new FakeDir('');
  const locks = new FakeLocks();
  const nav: Record<string, unknown> = { storage: { getDirectory: async () => root } };
  if (opts.locks) nav['locks'] = locks;
  Object.defineProperty(g, 'navigator', { value: nav, configurable: true, writable: true });
  return {
    root,
    locks,
    restore() {
      if (had) Object.defineProperty(globalThis, 'navigator', had);
      else delete g.navigator;
    },
  };
}
