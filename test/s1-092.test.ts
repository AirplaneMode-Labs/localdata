// S1-092 (Sprint 5, D4-03): the OPFS driver checks File.size against the length a record must have
// BEFORE it calls arrayBuffer(), so a planted oversize or truncated part is refused without being read
// into memory; and an unparseable keys.json in a vector or document namespace is 'corrupt' with reason
// 'keys_json', never an empty index. The OPFS driver runs over the in-memory OPFS in test/fake-env.ts, so
// a spy on Blob.prototype.arrayBuffer sees every read; real OPFS is covered in Chrome (test/browser).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpfsDriver } from '../src/drivers/opfs';
import { STORAGE_ROOT } from '../src/drivers/types';
import { createStore, type LocalData } from '../src/index';
import { HEAD_MAX_BYTES } from '../src/vec/reader';
import { DIM, synthQuery, synthRows } from '../bench/synth';
import { installFakeNavigator, type FakeNavigator } from './fake-env';

const NS = 'docs';
const VNS = `__ld_vec.${NS}`;
const D = 8;
const ROWS = 20;
const q = synthQuery(0, D);

let nav: FakeNavigator;
const stores: LocalData[] = [];

beforeEach(() => {
  nav = installFakeNavigator();
});
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  vi.restoreAllMocks();
  nav.restore();
});

async function open(): Promise<LocalData> {
  const s = await createStore({ driver: new OpfsDriver() });
  stores.push(s);
  return s;
}

async function build(): Promise<void> {
  const s = await open();
  await s.putVectors(NS, synthRows(0, ROWS, { dim: D, chunkBytes: 40 }));
  await s.close();
}

/** A raw OPFS driver over the same fake storage (what a planted file or another script would use). */
async function raw(): Promise<OpfsDriver> {
  const d = new OpfsDriver();
  await d.open();
  return d;
}

async function plant(name: string, bytes: Uint8Array): Promise<void> {
  const d = await raw();
  await d.put(VNS, name, bytes, { size: bytes.byteLength });
  await d.close();
}

async function length(name: string): Promise<number> {
  const d = await raw();
  const rec = await d.getBytes(VNS, name);
  await d.close();
  return rec!.bytes.byteLength;
}

/** Records the byte size of every Blob whose arrayBuffer() is called. */
function spyOnReads(): number[] {
  const sizes: number[] = [];
  const orig = Blob.prototype.arrayBuffer;
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function (this: Blob) {
    sizes.push(this.size);
    return orig.call(this);
  });
  return sizes;
}

async function refused(s: LocalData): Promise<{
  code?: string | undefined;
  reason?: unknown;
  file?: unknown;
  ns?: unknown;
}> {
  try {
    await s.query(NS, q, 5);
  } catch (e) {
    const err = e as { code?: string; details?: Record<string, unknown> };
    return {
      code: err.code,
      reason: err.details?.['reason'],
      file: err.details?.['file'],
      ns: err.details?.['ns'],
    };
  }
  return {};
}

describe('S1-092: File.size is checked before arrayBuffer()', () => {
  it('control: an intact index is read, so the spy sees real reads and the query works', async () => {
    await build();
    const sizes = spyOnReads();
    const s = await open();
    const hits = await s.query(NS, q, 5);
    expect(hits.length).toBe(5);
    expect(sizes.length).toBeGreaterThan(3);
    expect(sizes).toContain(await length('vec-0/00000'));
  });

  it.each(['vec-0/00000', 'meta-0/00000'])(
    'an oversize %s is refused as corrupt/length without being read',
    async (name) => {
      await build();
      const good = await length(name);
      const planted = good + 1_048_576;
      await plant(name, new Uint8Array(planted));
      const sizes = spyOnReads();
      const s = await open();
      expect(await refused(s)).toMatchObject({ code: 'corrupt', reason: 'length', file: name });
      expect(sizes, 'the oversize record was never read into memory').not.toContain(planted);
    },
  );

  it('an oversize value part is refused as corrupt/length without being read', async () => {
    await build();
    const planted = (await length('val-0/00000')) + 1_048_576;
    await plant('val-0/00000', new Uint8Array(planted));
    const sizes = spyOnReads();
    const s = await open();
    expect(await refused(s)).toMatchObject({
      code: 'corrupt',
      reason: 'length',
      file: 'val-0/00000',
    });
    expect(sizes).not.toContain(planted);
  });

  it('a truncated vector part is refused as corrupt/length without being read', async () => {
    await build();
    const good = await length('vec-0/00000');
    await plant('vec-0/00000', new Uint8Array(good - 1));
    const sizes = spyOnReads();
    const s = await open();
    expect(await refused(s)).toMatchObject({
      code: 'corrupt',
      reason: 'length',
      file: 'vec-0/00000',
    });
    expect(sizes).not.toContain(good - 1);
  });

  it('an oversize HEAD is refused as corrupt/too_large without being read', async () => {
    await build();
    const planted = HEAD_MAX_BYTES + 1;
    await plant('head', new Uint8Array(planted));
    const sizes = spyOnReads();
    const s = await open();
    expect(await refused(s)).toMatchObject({ code: 'corrupt', reason: 'too_large', file: 'head' });
    expect(sizes).not.toContain(planted);
  });

  it('a 64 MiB plant is refused in constant memory: no read of it, size-checked first', async () => {
    await build();
    const planted = 64 * 1024 * 1024;
    await plant('vec-0/00000', new Uint8Array(planted));
    const sizes = spyOnReads();
    const s = await open();
    expect(await refused(s)).toMatchObject({ code: 'corrupt', reason: 'length' });
    expect(Math.max(0, ...sizes)).toBeLessThan(planted);
  });

  it('the error carries the user-facing namespace and a record name, never a key', async () => {
    await build();
    await plant('vec-0/00000', new Uint8Array(3));
    const s = await open();
    const r = await refused(s);
    expect(r.ns).toBe(NS);
    expect(JSON.stringify(r)).not.toContain('chunk-');
  });
});

describe('S1-092: an unparseable keys.json is corrupt/keys_json in vector and document namespaces', () => {
  const keysJson = (ns: string) => nav.root.entry(STORAGE_ROOT, 'v1', ns, 'keys.json')!;
  const set = (ns: string, text: string) => {
    keysJson(ns).bytes = new TextEncoder().encode(text);
  };

  it.each([
    ['truncated JSON', '{"v":1,"k":{"head":{"h":"ab'],
    ['empty file', ''],
    ['not JSON', 'garbage \u0000 bytes'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['null', 'null'],
    ['wrong version', '{"v":2,"k":{}}'],
    ['k is not an object', '{"v":1,"k":[]}'],
  ])('a vector namespace with keys.json = %s', async (_label, text) => {
    await build();
    set(VNS, text);
    const s = await open();
    expect(await refused(s)).toMatchObject({
      code: 'corrupt',
      reason: 'keys_json',
      file: 'keys.json',
      ns: NS,
    });
  });

  it('the refusal is sticky until clear(ns), and clear(ns) recovers the namespace', async () => {
    await build();
    set(VNS, '{"v":1,"k":{"head"');
    const s = await open();
    expect((await refused(s)).reason).toBe('keys_json');
    expect((await refused(s)).reason).toBe('keys_json');
    await expect(s.indexInfo(NS)).rejects.toMatchObject({ code: 'corrupt' });
    // usage and KV calls never reject because an index is corrupt
    await expect(s.usage(NS)).resolves.toBeDefined();
    await s.set(NS, 'kv', 'still works');
    expect(await s.get(NS, 'kv')).toBe('still works');
    await s.clear(NS);
    expect(await s.query(NS, q, 5)).toEqual([]);
    expect(await s.indexInfo(NS)).toBeUndefined();
    await s.putVectors(NS, synthRows(0, 5, { dim: D }));
    expect((await s.query(NS, q, 5)).length).toBe(5);
    expect(nav.root.dir(STORAGE_ROOT, 'v1', VNS)).toBeDefined();
  });

  it('putVectors on a corrupt keys.json refuses instead of starting an empty index over it', async () => {
    await build();
    set(VNS, 'not json');
    const s = await open();
    await expect(s.putVectors(NS, synthRows(0, 3, { dim: D }))).rejects.toMatchObject({
      code: 'corrupt',
      details: { reason: 'keys_json' },
    });
  });

  it('the driver itself refuses a __ld_doc. namespace the same way (documents, D4-02)', async () => {
    const d = await raw();
    await d.put('__ld_doc.books', 'k', new Uint8Array(4), { size: 4 });
    await d.close();
    set('__ld_doc.books', '{oops');
    const d2 = await raw();
    for (const call of [
      () => d2.getBytes('__ld_doc.books', 'k'),
      () => d2.keys('__ld_doc.books'),
      () => d2.put('__ld_doc.books', 'x', new Uint8Array(1), { size: 1 }),
      () => d2.del('__ld_doc.books', 'k'),
    ]) {
      await expect(call()).rejects.toMatchObject({
        name: 'StorageError',
        code: 'corrupt',
        details: { reason: 'keys_json', file: 'keys.json', ns: 'books' },
      });
    }
    // clearing the namespace removes it whatever it holds
    await d2.clear('__ld_doc.books');
    expect(await d2.keys('__ld_doc.books')).toEqual([]);
    await d2.close();
  });

  it('a key-value namespace keeps the documented tolerant behaviour (unchanged, see Limitations)', async () => {
    const s = await open();
    await s.set('plain', 'k', 'v');
    await s.close();
    set('plain', '{broken');
    const s2 = await open();
    // The accounting record (not keys.json) still lists the key, but the value is unreachable: a miss.
    await expect(s2.get('plain', 'k')).resolves.toBeUndefined();
    await s2.set('plain', 'k2', 'fresh');
    expect(await s2.get('plain', 'k2')).toBe('fresh');
  });

  it('DIM is the harness default (sanity for the synth helpers)', () => {
    expect(DIM).toBe(384);
  });
});
