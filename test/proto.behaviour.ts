// S1-100 and S1-101 (Sprint 5, D4-01): prototype-safe keys and values.
//
//   S1-100  the per-namespace accounting record was an object keyed by the user's key, so the key
//           '__proto__' set a prototype instead of an own member and was dropped from the persisted
//           record: after a reopen list() and usage().items missed it.
//   S1-101  the value codec had the same flaw on encode (an own '__proto__' member was dropped) and on
//           decode (stored bytes with a '__proto__' member set the prototype of the decoded object).
//
// The same cases run in Vitest against the memory driver (test/proto-keys.test.ts) and inside Chrome
// against OPFS and IndexedDB (test/browser/proto.spec.ts), each across a close and reopen.
import type { StorableValue } from '../src/contracts/storage-api';
import { deepEq, eq, ok } from './assert';
import { using, type PersistCase, type PersistEnv } from './persist-env';

export const HOSTILE_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  '0',
  '01',
  '00',
  '1e3',
  '-1',
];

const NS = 'protons';
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** An LD1 envelope around a hand-written JSON section (no binary leaves): what crafted bytes look like. */
export function craftEnvelope(json: string): Uint8Array {
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(8 + body.byteLength);
  out.set([0x4c, 0x44, 0x31, 0], 0);
  new DataView(out.buffer).setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}

/** Every plain object reachable from v has Object.prototype; none has an extra inherited member. */
export function assertPlainPrototypes(v: unknown, path = '$'): void {
  if (v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    ok(Object.getPrototypeOf(v) === Array.prototype, `${path}: array prototype changed`);
    v.forEach((x, i) => assertPlainPrototypes(x, `${path}[${i}]`));
    return;
  }
  if (
    v instanceof Date ||
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v) ||
    (typeof Blob !== 'undefined' && v instanceof Blob)
  )
    return;
  ok(Object.getPrototypeOf(v) === Object.prototype, `${path}: prototype is not Object.prototype`);
  for (const k of Object.keys(v))
    assertPlainPrototypes((v as Record<string, unknown>)[k], `${path}.${k}`);
}

function ttlCase(label: string, expiring: (i: number) => boolean): PersistCase {
  return {
    name: `S1-100: hostile key names with TTLs are listed, counted and readable across a reopen (${label})`,
    run: async (env) => {
      let now = 1_000_000;
      const clock = () => now;
      const expect = (i: number) => ({ n: i, k: HOSTILE_KEYS[i]! });
      await using(await env.makeStore({ clock }), async (s) => {
        for (let i = 0; i < HOSTILE_KEYS.length; i++)
          await s.set(NS, HOSTILE_KEYS[i]!, expect(i), expiring(i) ? { ttlMs: 5000 } : undefined);
        eq((await s.list(NS)).keys.length, HOSTILE_KEYS.length, 'list before reopen');
        eq((await s.usage(NS)).items, HOSTILE_KEYS.length, 'usage.items before reopen');
      });
      await using(await env.reopen({ clock }), async (s) => {
        const listed = (await s.list(NS)).keys;
        await deepEq(listed, [...HOSTILE_KEYS].sort(), 'list after reopen');
        eq((await s.usage(NS)).items, HOSTILE_KEYS.length, 'usage(ns).items after reopen');
        eq((await s.usage()).items, HOSTILE_KEYS.length, 'usage().items after reopen');
        for (let i = 0; i < HOSTILE_KEYS.length; i++)
          await deepEq(await s.get(NS, HOSTILE_KEYS[i]!), expect(i), `get ${HOSTILE_KEYS[i]}`);
        // The TTL is honoured, and the accounting that survived the reopen knows each expiry.
        now += 6000;
        const live = HOSTILE_KEYS.filter((_, i) => !expiring(i));
        await deepEq((await s.list(NS)).keys, [...live].sort(), 'list after the TTL passed');
        for (let i = 0; i < HOSTILE_KEYS.length; i++) {
          const got = await s.get(NS, HOSTILE_KEYS[i]!);
          if (expiring(i)) eq(got, undefined, `${HOSTILE_KEYS[i]} expired`);
          else await deepEq(got, expect(i), `${HOSTILE_KEYS[i]} still live`);
        }
        eq((await s.usage(NS)).items, live.length, 'usage.items after expiry');
      });
    },
  };
}

export const protoCases: PersistCase[] = [
  ttlCase('even positions expire, so __proto__ expires', (i) => i % 2 === 0),
  ttlCase('odd positions expire, so __proto__ does not', (i) => i % 2 === 1),

  {
    name: 'S1-100: the persisted accounting record holds __proto__ as an own member',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        for (const k of HOSTILE_KEYS) await s.set(NS, k, k, { ttlMs: 60_000 });
      });
      const d = await env.raw();
      try {
        const rec = await d.getBytes('__ld_meta', NS);
        ok(rec !== undefined, 'accounting record exists');
        const parsed = JSON.parse(new TextDecoder().decode(rec.bytes)) as {
          v: number;
          k: Record<string, [number, number]>;
        };
        eq(parsed.v, 1, 'record version unchanged');
        await deepEq(Object.keys(parsed.k).sort(), [...HOSTILE_KEYS].sort(), 'record keys');
        ok(own(parsed.k, '__proto__'), '__proto__ is an own member of the record');
        const [size, exp] = parsed.k['__proto__']!;
        ok(size > 0 && exp > 0, 'size and expiry stored for __proto__');
      } finally {
        await d.close();
      }
    },
  },

  {
    name: 'S1-100: accounting rebuilt from the driver keeps __proto__ across a second reopen',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        for (const k of HOSTILE_KEYS) await s.set(NS, k, k);
      });
      const d = await env.raw();
      try {
        await d.del('__ld_meta', NS);
      } finally {
        await d.close();
      }
      // First reopen rebuilds the accounting from the driver and persists it again.
      await using(await env.reopen(), async (s) => {
        await deepEq((await s.list(NS)).keys, [...HOSTILE_KEYS].sort(), 'list after rebuild');
        eq((await s.usage(NS)).items, HOSTILE_KEYS.length, 'items after rebuild');
      });
      // Second reopen reads what the rebuild persisted.
      await using(await env.reopen(), async (s) => {
        await deepEq((await s.list(NS)).keys, [...HOSTILE_KEYS].sort(), 'list after second reopen');
        eq((await s.usage(NS)).items, HOSTILE_KEYS.length, 'items after second reopen');
      });
    },
  },

  {
    name: 'S1-100: delete and clear of the hostile keys hold across a reopen',
    run: async (env) => {
      await using(await env.makeStore(), async (s) => {
        for (const k of HOSTILE_KEYS) await s.set(NS, k, k);
        eq(await s.delete(NS, '__proto__'), true, 'delete __proto__');
        eq(await s.delete(NS, '__proto__'), false, 'second delete is absent');
        eq(await s.delete(NS, 'constructor'), true, 'delete constructor');
      });
      await using(await env.reopen(), async (s) => {
        const rest = HOSTILE_KEYS.filter((k) => k !== '__proto__' && k !== 'constructor');
        await deepEq((await s.list(NS)).keys, [...rest].sort(), 'list after deletes and reopen');
        eq(await s.get(NS, '__proto__'), undefined, '__proto__ stays deleted');
        eq((await s.usage(NS)).items, rest.length, 'items after deletes');
        await s.clear(NS);
      });
      await using(await env.reopen(), async (s) => {
        eq((await s.list(NS)).keys.length, 0, 'list after clear and reopen');
        eq((await s.usage(NS)).items, 0, 'items after clear and reopen');
      });
    },
  },

  {
    name: 'S1-100: a vector row keyed __proto__ with a value that owns __proto__ survives a reopen',
    run: async (env) => {
      const value = JSON.parse('{"__proto__":{"vecValue":true},"x":1}') as StorableValue;
      await using(await env.makeStore(), async (s) => {
        await s.putVectors(NS, [
          { key: '__proto__', vector: Float32Array.from([1, 0, 0, 0]), value },
          { key: 'constructor', vector: Float32Array.from([0, 1, 0, 0]), value: 'c' },
        ]);
      });
      await using(await env.reopen(), async (s) => {
        const hits = await s.query(NS, Float32Array.from([1, 0, 0, 0]), 2);
        await deepEq(
          hits.map((h) => h.key),
          ['__proto__', 'constructor'],
          'hit keys',
        );
        const got = hits[0]!.value as Record<string, unknown>;
        ok(own(got, '__proto__'), 'the value owns __proto__');
        await deepEq(got['__proto__'], { vecValue: true }, 'own __proto__ content');
        ok(Object.getPrototypeOf(got) === Object.prototype, 'value prototype is Object.prototype');
        eq(got['vecValue'], undefined, 'nothing leaked onto the value itself');
        eq(await s.delete(NS, '__proto__'), true, 'delete removes the vector row');
      });
      await using(await env.reopen(), async (s) => {
        const hits = await s.query(NS, Float32Array.from([1, 0, 0, 0]), 2);
        await deepEq(
          hits.map((h) => h.key),
          ['constructor'],
          'only constructor remains',
        );
      });
    },
  },

  {
    name: 'S1-101: an own __proto__ member round trips as an own member across a reopen',
    run: async (env) => {
      const withBinary = JSON.parse('{"k":1}') as Record<string, StorableValue>;
      Object.defineProperty(withBinary, '__proto__', {
        value: Uint8Array.from([1, 2, 3]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const values: Array<[string, StorableValue]> = [
        ['object', JSON.parse('{"__proto__":{"a":1},"b":2}') as StorableValue],
        ['number', JSON.parse('{"__proto__":7,"b":2}') as StorableValue],
        ['array', JSON.parse('{"__proto__":[1,2,3]}') as StorableValue],
        ['null', JSON.parse('{"__proto__":null}') as StorableValue],
        ['string', JSON.parse('{"__proto__":"s"}') as StorableValue],
        [
          'escape and nesting',
          JSON.parse(
            '{"$ld":"x","__proto__":{"$ld":"y"},"inner":[{"__proto__":{"z":1}}]}',
          ) as StorableValue,
        ],
        ['binary under __proto__', withBinary],
        [
          'inherited names as own members',
          { constructor: 1, prototype: 2, toString: 3, valueOf: 4, hasOwnProperty: 5 },
        ],
      ];
      await using(await env.makeStore(), async (s) => {
        for (const [name, v] of values) {
          await s.set(NS, name, v);
          const same = await s.get(NS, name);
          await deepEq(same, v, `${name}: same session`);
        }
      });
      await using(await env.reopen(), async (s) => {
        for (const [name, v] of values) {
          const got = (await s.get(NS, name)) as Record<string, unknown>;
          await deepEq(got, v, `${name}: after reopen`);
          assertPlainPrototypes(got, name);
          if (own(v as object, '__proto__'))
            ok(own(got, '__proto__'), `${name}: __proto__ comes back as an own member`);
        }
        const inherited = (await s.get(NS, 'object')) as Record<string, unknown>;
        eq(inherited['a'], undefined, 'the own __proto__ content did not become inherited');
        eq(({} as Record<string, unknown>)['a'], undefined, 'Object.prototype was not touched');
      });
    },
  },

  {
    name: 'S1-101: crafted stored bytes never set a prototype on decode',
    run: async (env) => {
      await (await env.makeStore()).close();
      const crafted: Array<[string, string]> = [
        ['top', '{"__proto__":{"polluted":true},"ok":1}'],
        ['escaped', '{"$ld":"obj","o":{"__proto__":{"polluted":true},"$ld":"x"}}'],
        ['nested', '{"a":{"__proto__":[1,2]},"b":[{"__proto__":{"polluted":true}}]}'],
        ['methods', '{"__proto__":{"toString":1,"valueOf":2},"hasOwnProperty":3}'],
      ];
      const d = await env.raw();
      try {
        for (const [k, json] of crafted) {
          const bytes = craftEnvelope(json);
          await d.put('crafted', k, bytes, { size: bytes.byteLength });
        }
      } finally {
        await d.close();
      }
      await using(await env.reopen(), async (s) => {
        for (const [k] of crafted) {
          const got = (await s.get('crafted', k)) as Record<string, unknown>;
          ok(got !== undefined && got !== null, `${k}: decoded`);
          ok(
            Object.getPrototypeOf(got) === Object.prototype,
            `${k}: prototype is Object.prototype`,
          );
          eq(got['polluted'], undefined, `${k}: no inherited polluted member`);
          eq(typeof got['toString'] === 'function' || own(got, 'toString'), true, `${k}: toString`);
          eq(
            String(Object.prototype.toString.call(got)),
            '[object Object]',
            `${k}: Object.prototype.toString still works`,
          );
          assertPlainPrototypes(got, k);
        }
        const top = (await s.get('crafted', 'top')) as Record<string, unknown>;
        ok(own(top, '__proto__'), 'top: __proto__ is an own member');
        await deepEq(top['__proto__'], { polluted: true }, 'top: own __proto__ content');
        eq(top['ok'], 1, 'top: sibling member intact');
        const nested = (await s.get('crafted', 'nested')) as { a: object };
        ok(!Array.isArray(nested.a), 'nested: a is not turned into an array by __proto__ [1,2]');
        eq(({} as Record<string, unknown>)['polluted'], undefined, 'Object.prototype untouched');
      });
    },
  },
];
