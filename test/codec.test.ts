import { describe, expect, it } from 'vitest';
import { decode, encode, MAGIC } from '../src/codec';
import { StorageError, type StorableValue } from '../src/contracts/storage-api';
import { valuesEqual } from './assert';

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function randomValue(rand: () => number, depth = 0): StorableValue {
  const pick = Math.floor(rand() * (depth > 3 ? 9 : 13));
  const len = () => Math.floor(rand() * 6);
  switch (pick) {
    case 0:
      return rand() < 0.1 ? '' : `s${Math.floor(rand() * 1e6)}éन`;
    case 1: {
      const specials = [NaN, -0, 0, Infinity, -Infinity, 1.5, -2.25e-7, Number.MAX_SAFE_INTEGER];
      return rand() < 0.5 ? specials[Math.floor(rand() * specials.length)]! : rand() * 1e9 - 5e8;
    }
    case 2:
      return rand() < 0.5;
    case 3:
      return null;
    case 4:
      return rand() < 0.1 ? new Date(NaN) : new Date(Math.floor(rand() * 4e12) - 2e12);
    case 5:
      return Uint8Array.from({ length: len() * 7 }, () => Math.floor(rand() * 256));
    case 6:
      return Float64Array.from({ length: len() }, () => rand() * 2 - 1);
    case 7:
      return Int16Array.from({ length: len() }, () => Math.floor(rand() * 65536) - 32768).buffer;
    case 8:
      return BigUint64Array.from({ length: len() }, () => BigInt(Math.floor(rand() * 1e15)));
    case 9:
      return Array.from({ length: len() }, () => randomValue(rand, depth + 1));
    case 10: {
      const o: Record<string, StorableValue> = {};
      const n = len();
      for (let i = 0; i < n; i++) {
        const k = rand() < 0.15 ? '$ld' : `k${i}_${Math.floor(rand() * 100)}`;
        o[k] = randomValue(rand, depth + 1);
      }
      return o;
    }
    case 11:
      return new Blob([Uint8Array.from({ length: len() * 3 }, () => Math.floor(rand() * 256))], {
        type: rand() < 0.5 ? 'application/octet-stream' : '',
      });
    default:
      return Float32Array.from({ length: len() }, () => (rand() < 0.1 ? NaN : rand() * 100));
  }
}

async function roundTrip(v: StorableValue): Promise<StorableValue> {
  const bytes = await encode(v);
  return decode(bytes);
}

describe('codec envelope', () => {
  it('starts with the LD1 magic, a flags byte and a little-endian u32 JSON length', async () => {
    const bytes = await encode({ a: 1 });
    expect(Array.from(bytes.subarray(0, 3))).toEqual(Array.from(MAGIC));
    expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe('LD1');
    const jsonLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
    const json = new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen));
    expect(JSON.parse(json)).toEqual({ a: 1 });
    expect(bytes.length).toBe(8 + jsonLen);
  });

  it('places binary leaves after the JSON section and references them by index', async () => {
    const u8 = Uint8Array.from([1, 2, 3]);
    const f32 = Float32Array.from([1.5]);
    const bytes = await encode({ u8, f32, nested: [u8] });
    const jsonLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen)));
    expect(json.u8).toMatchObject({ $ld: 'u8', i: 0 });
    expect(json.f32).toMatchObject({ $ld: 'f32', i: 1 });
    expect(json.nested[0]).toMatchObject({ $ld: 'u8', i: 2 });
    expect(bytes.length).toBe(8 + jsonLen + 3 + 4 + 3);
  });

  it('decode rejects a buffer with the wrong magic', () => {
    const bad = Uint8Array.from([0x4c, 0x44, 0x30, 0, 0, 0, 0, 0]);
    expect(() => decode(bad)).toThrow(StorageError);
    try {
      decode(bad);
    } catch (e) {
      expect((e as StorageError).code).toBe('io');
    }
  });

  it('decode rejects a truncated buffer', async () => {
    const bytes = await encode(Uint8Array.from([1, 2, 3, 4]));
    expect(() => decode(bytes.subarray(0, bytes.length - 2))).toThrow(StorageError);
  });
});

describe('codec round trips', () => {
  it('Date -> Date, NaN and -0 preserved, invalid Date preserved', async () => {
    const d = new Date(1_700_000_000_000);
    const got = (await roundTrip({ d, n: NaN, z: -0, inf: -Infinity, bad: new Date(NaN) })) as {
      d: Date;
      n: number;
      z: number;
      inf: number;
      bad: Date;
    };
    expect(got.d).toBeInstanceOf(Date);
    expect(got.d.getTime()).toBe(d.getTime());
    expect(Number.isNaN(got.n)).toBe(true);
    expect(Object.is(got.z, -0)).toBe(true);
    expect(got.inf).toBe(-Infinity);
    expect(got.bad).toBeInstanceOf(Date);
    expect(Number.isNaN(got.bad.getTime())).toBe(true);
  });

  it('escapes plain objects that own a "$ld" key', async () => {
    const v = { $ld: 'u8', i: 0, v: 'not a leaf' };
    expect(await valuesEqual(await roundTrip(v), v)).toBe(true);
    const v2 = { $ld: { $ld: 'date', v: 1 } };
    expect(await valuesEqual(await roundTrip(v2), v2)).toBe(true);
  });

  it('every typed array class and ArrayBuffer round-trip byte-exact with the same class', async () => {
    const values: StorableValue[] = [
      new ArrayBuffer(5),
      Uint8Array.from([255, 0, 1]),
      Int8Array.from([-1, 1]),
      Uint16Array.from([65535]),
      Int16Array.from([-32768]),
      Uint32Array.from([4294967295]),
      Int32Array.from([-2147483648]),
      Float32Array.from([1.5, NaN]),
      Float64Array.from([Math.E, -0]),
      BigInt64Array.from([-1n]),
      BigUint64Array.from([2n ** 64n - 1n]),
    ];
    for (const v of values) {
      const got = await roundTrip(v);
      expect((got as object).constructor).toBe((v as object).constructor);
      expect(await valuesEqual(got, v)).toBe(true);
    }
  });

  it('Blob round-trips with its MIME type', async () => {
    const b = new Blob([Uint8Array.from([9, 8, 7])], { type: 'image/png' });
    const got = (await roundTrip(b)) as Blob;
    expect(got).toBeInstanceOf(Blob);
    expect(got.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await got.arrayBuffer()))).toEqual([9, 8, 7]);
  });

  it('typed array views over a shared buffer keep only their own window', async () => {
    const base = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = base.subarray(2, 5);
    const got = (await roundTrip(view)) as Uint8Array;
    expect(Array.from(got)).toEqual([2, 3, 4]);
    expect(got.byteOffset).toBe(0);
    expect(got.buffer.byteLength).toBe(3);
  });

  it('200 random nested values round-trip by deep equality (seeded property test)', async () => {
    const rand = rng(0x5eed);
    for (let i = 0; i < 200; i++) {
      const v = randomValue(rand);
      const got = await roundTrip(v);
      expect(await valuesEqual(got, v), `case ${i}`).toBe(true);
    }
  });
});

describe('codec rejections (invalid_value)', () => {
  const cases: Array<[string, unknown]> = [
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Map', new Map()],
    ['Set', new Set()],
    ['class instance', new (class Foo {})()],
    ['undefined', undefined],
    ['bigint', 1n],
    ['nested undefined', { a: undefined }],
    ['nested function in array', [1, () => 2]],
    ['DataView', new DataView(new ArrayBuffer(1))],
    ['sparse array hole', [1, , 3]],
  ];
  for (const [name, v] of cases) {
    it(`rejects ${name}`, async () => {
      await expect(encode(v as StorableValue)).rejects.toMatchObject({
        name: 'StorageError',
        code: 'invalid_value',
      });
    });
  }

  it('rejects circular references', async () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    await expect(encode(a as StorableValue)).rejects.toMatchObject({ code: 'invalid_value' });
  });

  it('accepts null-prototype objects as plain objects', async () => {
    const o = Object.create(null) as Record<string, StorableValue>;
    o['a'] = 1;
    expect(await valuesEqual(await roundTrip(o), { a: 1 })).toBe(true);
  });
});
