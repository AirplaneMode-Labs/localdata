// Structured-clone-safe codec for StorableValue.
//
// Envelope: 'LD1' (3 bytes) | u8 flags | u32 LE jsonLen | JSON (jsonLen bytes) | binary section.
// Binary leaves are replaced in the JSON by {"$ld": kind, "i": index, "o": offset, "n": length,
// "t"?: blobType} and their bytes are appended to the binary section in index order.
// Date -> {"$ld":"date","v": ms | null}; non-finite or negative-zero numbers -> {"$ld":"num","v": tag};
// a plain object that owns a "$ld" key is escaped as {"$ld":"obj","o": { ...entries }}.
import { StorageError, type StorableValue } from './contracts/storage-api';

export const MAGIC: Uint8Array = Uint8Array.from([0x4c, 0x44, 0x31]); // 'LD1'
const HEADER = 8;
const FLAGS_V1 = 0;

type BinaryKind =
  'ab' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64' | 'bi64' | 'bu64' | 'blob';

type TypedArrayCtor = {
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): ArrayBufferView;
  readonly BYTES_PER_ELEMENT: number;
};

const TYPED: Array<[BinaryKind, TypedArrayCtor]> = [
  ['u8', Uint8Array],
  ['i8', Int8Array],
  ['u16', Uint16Array],
  ['i16', Int16Array],
  ['u32', Uint32Array],
  ['i32', Int32Array],
  ['f32', Float32Array],
  ['f64', Float64Array],
  ['bi64', BigInt64Array],
  ['bu64', BigUint64Array],
];
const CTOR_BY_KIND = new Map<BinaryKind, TypedArrayCtor>(TYPED);

interface Leaf {
  bytes: Uint8Array;
  /** The JSON node for this leaf; `o` and `n` are filled once every leaf is materialised. */
  node: Record<string, unknown>;
}

function invalid(what: string, path: string): StorageError {
  return new StorageError('invalid_value', `value at ${path || '$'} is not storable: ${what}`, {
    path: path || '$',
    reason: what,
  });
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function kindOfBinary(v: unknown): BinaryKind | undefined {
  if (v instanceof ArrayBuffer) return 'ab';
  if (typeof Blob !== 'undefined' && v instanceof Blob) return 'blob';
  for (const [kind, ctor] of TYPED)
    if (v instanceof (ctor as unknown as new () => unknown)) return kind;
  return undefined;
}

/** Encodes a StorableValue; rejects anything outside the contract with invalid_value. */
export async function encode(value: StorableValue): Promise<Uint8Array> {
  const leaves: Leaf[] = [];
  const pending: Array<{ leaf: Leaf; blob: Blob }> = [];
  const seen = new Set<object>();

  const walk = (v: unknown, path: string): unknown => {
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        if (Number.isNaN(v)) return { $ld: 'num', v: 'nan' };
        if (v === Infinity) return { $ld: 'num', v: 'inf' };
        if (v === -Infinity) return { $ld: 'num', v: '-inf' };
        if (Object.is(v, -0)) return { $ld: 'num', v: '-0' };
        return v;
      case 'undefined':
        throw invalid('undefined', path);
      case 'bigint':
        throw invalid('bigint', path);
      case 'function':
        throw invalid('function', path);
      case 'symbol':
        throw invalid('symbol', path);
      case 'object':
        break;
      default:
        throw invalid(typeof v, path);
    }
    if (v === null) return null;
    const obj = v as object;
    if (obj instanceof Date) {
      const t = obj.getTime();
      return { $ld: 'date', v: Number.isNaN(t) ? null : t };
    }
    const kind = kindOfBinary(obj);
    if (kind !== undefined) {
      const index = leaves.length;
      const node: Record<string, unknown> = { $ld: kind, i: index };
      const leaf: Leaf = { bytes: new Uint8Array(0), node };
      leaves.push(leaf);
      if (kind === 'blob') {
        const blob = obj as Blob;
        pending.push({ leaf, blob });
        node['t'] = blob.type;
        return node;
      }
      if (kind === 'ab') {
        leaf.bytes = new Uint8Array((obj as ArrayBuffer).slice(0));
      } else {
        const view = obj as ArrayBufferView;
        leaf.bytes = new Uint8Array(
          view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
        );
      }
      return node;
    }
    if (ArrayBuffer.isView(obj)) throw invalid('DataView', path);
    if (seen.has(obj)) throw invalid('circular reference', path);
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const out: unknown[] = new Array(obj.length);
        for (let i = 0; i < obj.length; i++) {
          if (!(i in obj)) throw invalid('sparse array hole', `${path}[${i}]`);
          out[i] = walk(obj[i], `${path}[${i}]`);
        }
        return out;
      }
      if (obj instanceof Map) throw invalid('Map', path);
      if (obj instanceof Set) throw invalid('Set', path);
      if (!isPlainObject(obj))
        throw invalid(`class instance (${obj.constructor?.name ?? 'unknown'})`, path);
      const rec = obj as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec)) out[k] = walk(rec[k], `${path}.${k}`);
      return Object.prototype.hasOwnProperty.call(rec, '$ld') ? { $ld: 'obj', o: out } : out;
    } finally {
      seen.delete(obj);
    }
  };

  const tree = walk(value, '');
  for (const p of pending) p.leaf.bytes = new Uint8Array(await p.blob.arrayBuffer());

  // Fill offsets and lengths now that every leaf (including Blobs) is materialised.
  let offset = 0;
  for (const l of leaves) {
    l.node['o'] = offset;
    l.node['n'] = l.bytes.byteLength;
    offset += l.bytes.byteLength;
  }

  const json = new TextEncoder().encode(JSON.stringify(tree));
  const out = new Uint8Array(HEADER + json.byteLength + offset);
  out.set(MAGIC, 0);
  out[3] = FLAGS_V1;
  new DataView(out.buffer).setUint32(4, json.byteLength, true);
  out.set(json, HEADER);
  let cursor = HEADER + json.byteLength;
  for (const l of leaves) {
    out.set(l.bytes, cursor);
    cursor += l.bytes.byteLength;
  }
  return out;
}

function corrupt(reason: string): StorageError {
  return new StorageError('io', `stored value is corrupt: ${reason}`, { reason });
}

/** Decodes an envelope produced by encode(). Throws io on a malformed envelope. */
export function decode(bytes: Uint8Array): StorableValue {
  if (bytes.byteLength < HEADER) throw corrupt('shorter than header');
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2])
    throw corrupt('bad magic');
  if (bytes[3] !== FLAGS_V1) throw corrupt(`unknown flags ${bytes[3]}`);
  const jsonLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (HEADER + jsonLen > bytes.byteLength) throw corrupt('json length exceeds buffer');
  const binaryBase = HEADER + jsonLen;
  const binaryLen = bytes.byteLength - binaryBase;
  let tree: unknown;
  try {
    tree = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER, binaryBase)));
  } catch {
    throw corrupt('json section does not parse');
  }

  const slice = (o: unknown, n: unknown): ArrayBuffer => {
    if (typeof o !== 'number' || typeof n !== 'number' || o < 0 || n < 0 || o + n > binaryLen) {
      throw corrupt('binary leaf out of range');
    }
    return bytes.buffer.slice(
      bytes.byteOffset + binaryBase + o,
      bytes.byteOffset + binaryBase + o + n,
    ) as ArrayBuffer;
  };

  const revive = (node: unknown): StorableValue => {
    if (node === null || typeof node !== 'object') return node as StorableValue;
    if (Array.isArray(node)) return node.map(revive);
    const rec = node as Record<string, unknown>;
    const tag = rec['$ld'];
    if (typeof tag !== 'string') {
      const out: Record<string, StorableValue> = {};
      for (const k of Object.keys(rec)) out[k] = revive(rec[k]);
      return out;
    }
    switch (tag) {
      case 'obj': {
        const inner = rec['o'];
        if (inner === null || typeof inner !== 'object' || Array.isArray(inner))
          throw corrupt('bad obj escape');
        const out: Record<string, StorableValue> = {};
        for (const k of Object.keys(inner as object))
          out[k] = revive((inner as Record<string, unknown>)[k]);
        return out;
      }
      case 'date':
        return new Date(rec['v'] === null ? NaN : (rec['v'] as number));
      case 'num':
        switch (rec['v']) {
          case 'nan':
            return NaN;
          case 'inf':
            return Infinity;
          case '-inf':
            return -Infinity;
          case '-0':
            return -0;
          default:
            throw corrupt('bad num tag');
        }
      case 'ab':
        return slice(rec['o'], rec['n']);
      case 'blob':
        return new Blob([slice(rec['o'], rec['n'])], {
          type: typeof rec['t'] === 'string' ? rec['t'] : '',
        });
      default: {
        const ctor = CTOR_BY_KIND.get(tag as BinaryKind);
        if (!ctor) throw corrupt(`unknown leaf kind ${tag}`);
        const buf = slice(rec['o'], rec['n']);
        if (buf.byteLength % ctor.BYTES_PER_ELEMENT !== 0)
          throw corrupt('leaf length not a multiple of element size');
        return new ctor(buf) as unknown as StorableValue;
      }
    }
  };
  return revive(tree);
}
