// S1-101 at the codec: an own '__proto__' member is encoded, decoded and round-tripped as an own member,
// and bytes that carry a '__proto__' member never set the prototype of what decode() returns.
import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/codec';
import type { StorableValue } from '../src/contracts/storage-api';
import { valuesEqual } from './assert';
import { assertPlainPrototypes, craftEnvelope, HOSTILE_KEYS } from './proto.behaviour';

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The JSON section of an envelope, as text. */
function jsonOf(bytes: Uint8Array): string {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  return new TextDecoder().decode(bytes.subarray(8, 8 + len));
}

function withOwn(target: Record<string, StorableValue>, key: string, value: StorableValue) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

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

describe('codec: own __proto__ members (S1-101)', () => {
  it('encode writes an own __proto__ member into the JSON section', async () => {
    const v = JSON.parse('{"__proto__":{"a":1},"b":2}') as StorableValue;
    const json = jsonOf(await encode(v));
    expect(JSON.parse(json)).toBeTypeOf('object');
    expect(json).toContain('"__proto__":{"a":1}');
    expect(json).toContain('"b":2');
  });

  it('a primitive own __proto__ is not dropped', async () => {
    const v = JSON.parse('{"__proto__":7,"b":2}') as StorableValue;
    expect(jsonOf(await encode(v))).toContain('"__proto__":7');
    const got = decode(await encode(v)) as Record<string, unknown>;
    expect(own(got, '__proto__')).toBe(true);
    expect(got['__proto__']).toBe(7);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
  });

  it('an object under __proto__ comes back as an own member, not as a prototype', async () => {
    const v = JSON.parse('{"__proto__":{"a":1},"b":2}') as StorableValue;
    const got = decode(await encode(v)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect(own(got, '__proto__')).toBe(true);
    expect(got['__proto__']).toEqual({ a: 1 });
    expect(got['a']).toBeUndefined();
    expect(Object.keys(got).sort()).toEqual(['__proto__', 'b']);
  });

  it('works under the $ld escape, in arrays, and with a typed array as its value', async () => {
    const bin = withOwn({ k: 1 }, '__proto__', Uint8Array.from([9, 8, 7]));
    const cases: StorableValue[] = [
      JSON.parse('{"$ld":"x","__proto__":{"$ld":"y"}}') as StorableValue,
      JSON.parse('[{"__proto__":{"z":1}},{"__proto__":[]}]') as StorableValue,
      JSON.parse('{"a":{"b":{"__proto__":{"c":{"__proto__":1}}}}}') as StorableValue,
      bin,
    ];
    for (const v of cases) {
      const got = decode(await encode(v));
      expect(await valuesEqual(got, v)).toBe(true);
      assertPlainPrototypes(got);
    }
  });

  it('inherited member names are plain own members', async () => {
    const v = { constructor: 1, prototype: 2, toString: 3, valueOf: 4, hasOwnProperty: 5 };
    const got = decode(await encode(v)) as Record<string, unknown>;
    expect(await valuesEqual(got, v)).toBe(true);
    for (const k of Object.keys(v)) expect(own(got, k)).toBe(true);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
  });

  it('a null-prototype input is encoded; the decoded copy has Object.prototype', async () => {
    const o = Object.create(null) as Record<string, StorableValue>;
    o['__proto__'] = { a: 1 };
    o['x'] = 2;
    const got = decode(await encode(o)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect(own(got, '__proto__')).toBe(true);
  });

  it('300 seeded random objects over the hostile key names round trip as deep equals', async () => {
    const rand = rng(0x5ee1);
    const pickKey = () => HOSTILE_KEYS[Math.floor(rand() * HOSTILE_KEYS.length)]!;
    const build = (depth: number): StorableValue => {
      const r = rand();
      if (depth > 3 || r < 0.3) return Math.floor(rand() * 1000);
      if (r < 0.4) return `s${Math.floor(rand() * 100)}`;
      if (r < 0.5) return null;
      if (r < 0.65)
        return Array.from({ length: 1 + Math.floor(rand() * 3) }, () => build(depth + 1));
      const o: Record<string, StorableValue> = {};
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) withOwn(o, pickKey(), build(depth + 1));
      if (rand() < 0.2) withOwn(o, '$ld', 'x');
      return o;
    };
    for (let i = 0; i < 300; i++) {
      const v = build(0);
      const got = decode(await encode(v));
      expect(await valuesEqual(got, v), `case ${i}`).toBe(true);
      assertPlainPrototypes(got, `case ${i}`);
    }
  });
});

describe('codec: crafted bytes never set a prototype (S1-101)', () => {
  const crafted = [
    '{"__proto__":{"polluted":true},"ok":1}',
    '{"$ld":"obj","o":{"__proto__":{"polluted":true},"$ld":"x"}}',
    '{"a":{"__proto__":[1,2]},"b":[{"__proto__":{"polluted":true}}]}',
    '{"__proto__":{"toString":1,"valueOf":2},"hasOwnProperty":3}',
    '{"__proto__":{"$ld":"date","v":5}}',
    '{"__proto__":{"__proto__":{"__proto__":{"deep":1}}}}',
  ];

  it.each(crafted)('decode(%s)', (json) => {
    const got = decode(craftEnvelope(json)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    assertPlainPrototypes(got);
    expect(got['polluted']).toBeUndefined();
    expect(got['deep']).toBeUndefined();
    expect(Object.prototype.toString.call(got)).toBe('[object Object]');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Array.isArray((got['a'] as { __proto__?: unknown } | undefined)?.['__proto__'])).toBe(
      json.includes('"a":{"__proto__":[1,2]}'),
    );
  });

  it('a __proto__ member is an own member of the decoded object, content intact', () => {
    const got = decode(craftEnvelope('{"__proto__":{"polluted":true},"ok":1}')) as Record<
      string,
      unknown
    >;
    expect(own(got, '__proto__')).toBe(true);
    expect(got['__proto__']).toEqual({ polluted: true });
    expect(got['ok']).toBe(1);
    expect(Object.keys(got).sort()).toEqual(['__proto__', 'ok']);
  });

  it('decode never touches Object.prototype whatever the bytes say', () => {
    for (const json of crafted) decode(craftEnvelope(json));
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as Record<string, unknown>)['toString']).toBe(Object.prototype.toString);
  });
});
