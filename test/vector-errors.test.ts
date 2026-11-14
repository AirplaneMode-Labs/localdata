// D4-03: error hygiene, events, the forced-trap path, and the no-network rule.
//  * no StorageError for a vector operation carries a key, filterPrefix, vector component, score or
//    value (message, details and JSON), whatever failed;
//  * storage.query, storage.index.open and storage.index.write have the documented shapes and carry
//    none of those either;
//  * a trap discards the kernel instance and the next call works.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryDriver } from '../src/drivers/memory';
import { createStore, STORAGE_EVENT_NAMES, type Event, type LocalData } from '../src/index';
import { DIM, synthQuery, synthRows } from '../bench/synth';
import { eventProblems } from './event-validate';
import { HEAD_FIELD, editHead } from './forge';

const KEY = 'SENTINEL-KEY-7c1e/α';
const PREFIX = 'SENTINEL-PREFIX-93ab';
const VALUE = 'SENTINEL-VALUE-ff02-नमस्ते';
const COMPONENT = 0.123456789; // a distinctive component: its digits must not appear anywhere
const NS = 'docs';

const open: LocalData[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

function recorder() {
  const events: Event[] = [];
  return { events, sink: { emit: (e: Event) => void events.push(e) } };
}

async function make(extra: Record<string, unknown> = {}, driver = new MemoryDriver()) {
  const s = await createStore({ driver, ...extra } as Parameters<typeof createStore>[0]);
  open.push(s);
  return { store: s, driver };
}

function shown(e: unknown): string {
  const err = e as { message?: string; details?: unknown; stack?: string };
  return `${err.message}\n${JSON.stringify(err.details)}\n${JSON.stringify(e)}\n${String(err.stack)}`;
}

const SENTINELS = [KEY, PREFIX, VALUE, 'SENTINEL', String(COMPONENT), '0.1234567'];

describe('vector error hygiene', () => {
  it('no sentinel key, prefix, component or value appears in any vector error, whatever failed', async () => {
    const rec = recorder();
    const { store, driver } = await make({ events: rec.sink });
    await store.putVectors(NS, [
      { key: 'ok', vector: new Float32Array([COMPONENT, 0, 0]), value: VALUE },
    ]);
    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        'duplicate key',
        () =>
          store.putVectors(NS, [
            { key: KEY, vector: new Float32Array([1, 0, 0]) },
            { key: KEY, vector: new Float32Array([1, 0, 0]) },
          ]),
      ],
      [
        'dim mismatch',
        () => store.putVectors(NS, [{ key: KEY, vector: new Float32Array([COMPONENT, 0]) }]),
      ],
      [
        'NaN row',
        () =>
          store.putVectors(NS, [
            { key: KEY, vector: new Float32Array([COMPONENT, Number.NaN, 0]) },
          ]),
      ],
      [
        'huge row',
        () =>
          store.putVectors(NS, [{ key: KEY, vector: new Float32Array([COMPONENT, 3e38, 3e38]) }]),
      ],
      [
        'bad key',
        () => store.putVectors(NS, [{ key: `${KEY}\u0000`, vector: new Float32Array([1, 0, 0]) }]),
      ],
      [
        'ill-formed key',
        () => store.putVectors(NS, [{ key: `${KEY}\uD800`, vector: new Float32Array([1, 0, 0]) }]),
      ],
      [
        'unstorable value',
        () =>
          store.putVectors(NS, [
            { key: KEY, vector: new Float32Array([1, 0, 0]), value: { [VALUE]: () => 1 } as never },
          ]),
      ],
      [
        'value too large',
        () =>
          store.putVectors(NS, [
            { key: KEY, vector: new Float32Array([1, 0, 0]), value: new Uint8Array(1048577) },
          ]),
      ],
      ['query dim', () => store.query(NS, new Float32Array([COMPONENT, 0]), 3)],
      ['query nan', () => store.query(NS, new Float32Array([COMPONENT, Number.NaN, 0]), 3)],
      [
        'query prefix',
        () =>
          store.query(NS, new Float32Array([COMPONENT, 0, 0]), 3, {
            filterPrefix: `${PREFIX}\uD800`,
          }),
      ],
      [
        'query metric',
        () => store.query(NS, new Float32Array([COMPONENT, 0, 0]), 3, { metric: PREFIX as 'dot' }),
      ],
      ['query k', () => store.query(NS, new Float32Array([COMPONENT, 0, 0]), 1.5)],
      ['bad rows argument', () => store.putVectors(NS, KEY as never)],
    ];
    for (const [what, fn] of calls) {
      const err = await fn().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, what).toBeDefined();
      const text = shown(err);
      for (const s of SENTINELS) expect(text.includes(s), `${what}: ${s}`).toBe(false);
    }
    // corruption errors too
    await editHead(driver, NS, (_h, dv) => dv.setUint32(HEAD_FIELD.totalRows, 4194305, true)).catch(
      () => undefined,
    );
    // events over the whole run carry none of it
    const wire = JSON.stringify(rec.events);
    for (const s of SENTINELS) expect(wire.includes(s), `events: ${s}`).toBe(false);
  });

  it('a corrupt index error carries only ns, file and reason', async () => {
    const driver = new MemoryDriver();
    const a = await createStore({ driver });
    await a.putVectors(NS, [
      { key: KEY, vector: new Float32Array([COMPONENT, 0, 0]), value: VALUE },
    ]);
    await a.close();
    await driver.open();
    const vec = (await driver.getBytes('__ld_vec.docs', 'vec-0/00000'))!.bytes.slice();
    vec[0] = vec[0]! ^ 0xff;
    await driver.put('__ld_vec.docs', 'vec-0/00000', vec, { size: vec.length });
    const { store } = await make({}, driver);
    const err = await store
      .query(NS, new Float32Array([COMPONENT, 0, 0]), 1)
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('corrupt');
    expect(Object.keys((err as { details: object }).details).sort()).toEqual([
      'file',
      'ns',
      'reason',
    ]);
    for (const s of SENTINELS) expect(shown(err).includes(s)).toBe(false);
  });
});

describe('storage.query, storage.index.open and storage.index.write events', () => {
  it('STORAGE_EVENT_NAMES lists seven names including the three new ones', () => {
    expect(STORAGE_EVENT_NAMES).toContain('storage.query');
    expect(STORAGE_EVENT_NAMES).toContain('storage.index.open');
    expect(STORAGE_EVENT_NAMES).toContain('storage.index.write');
    expect(STORAGE_EVENT_NAMES.length).toBe(7);
  });

  it('a write, a cold query and a hot query emit the documented events with valid shapes', async () => {
    const driver = new MemoryDriver();
    const w = recorder();
    const a = await createStore({ driver, events: w.sink });
    await a.putVectors(NS, [...synthRows(0, 30, { dim: 8, chunkBytes: 20 })]);
    await a.close();
    const names = w.events.map((e) => e.name);
    expect(names).toEqual(['storage.index.write']);
    const write = w.events[0]!;
    expect(write.kind).toBe('timing');
    expect(write.level).toBe('debug');
    expect(write.source).toBe('localdata');
    expect(write.attrs).toMatchObject({
      ns: NS,
      driver: 'memory',
      outcome: 'ok',
      rows: 30,
      replaced: 0,
      segments: 1,
    });
    expect(write.bytes).toBeGreaterThan(0);
    expect(write.durationMs).toBeGreaterThanOrEqual(0);

    await driver.open();
    const r = recorder();
    const b = await createStore({ driver, events: r.sink });
    open.push(b);
    await b.query(NS, synthQuery(0, 8), 5, { metric: 'dot', filterPrefix: 'chunk-00001' });
    await b.query(NS, synthQuery(1, 8), 3);
    expect(r.events.map((e) => e.name)).toEqual([
      'storage.index.open',
      'storage.query',
      'storage.query',
    ]);
    const open1 = r.events[0]!;
    expect(open1.attrs).toMatchObject({
      ns: NS,
      driver: 'memory',
      outcome: 'ok',
      rows: 30,
      segments: 1,
      reason: '',
    });
    expect(['simd', 'scalar']).toContain(open1.attrs['kernel']);
    expect(open1.bytes).toBeGreaterThan(0);
    const q1 = r.events[1]!;
    expect(q1.attrs).toMatchObject({
      ns: NS,
      driver: 'memory',
      outcome: 'ok',
      k: 5,
      metric: 'dot',
    });
    expect(q1.attrs['candidates']).toBe(10);
    expect(q1.attrs['kernel']).toBe(open1.attrs['kernel']);
    expect(r.events[2]!.attrs).toMatchObject({ k: 3, metric: 'cosine', candidates: 30 });
    for (const e of [...w.events, ...r.events]) expect(eventProblems(e), e.name).toEqual([]);
  });

  it('absent, replaced and failed outcomes: levels and attrs', async () => {
    const rec = recorder();
    const { store, driver } = await make({ events: rec.sink });
    await store.query(NS, new Float32Array(4), 3); // no index
    expect(rec.events.map((e) => [e.name, e.attrs['outcome'], e.level])).toEqual([
      ['storage.index.open', 'absent', 'debug'],
      ['storage.query', 'ok', 'debug'],
    ]);
    expect(rec.events[1]!.attrs['kernel']).toBeDefined();
    rec.events.length = 0;
    await store.putVectors(NS, synthRows(0, 5, { dim: 4 }));
    await store.putVectors(NS, synthRows(3, 4, { dim: 4 }));
    const writes = rec.events.filter((e) => e.name === 'storage.index.write');
    expect(writes.map((e) => [e.attrs['rows'], e.attrs['replaced'], e.attrs['segments']])).toEqual([
      [5, 0, 1],
      [7, 2, 2],
    ]);
    rec.events.length = 0;
    await expect(
      store.putVectors(NS, [{ key: 'x', vector: new Float32Array(3) }]),
    ).rejects.toMatchObject({ code: 'invalid_value' });
    const failed = rec.events.find((e) => e.name === 'storage.index.write')!;
    expect(failed.attrs['outcome']).toBe('invalid_value');
    expect(failed.level).toBe('warn');
    await expect(store.query(NS, new Float32Array(4), 1.5)).rejects.toMatchObject({
      code: 'invalid_value',
    });
    const badQuery = rec.events.filter((e) => e.name === 'storage.query').pop()!;
    expect(badQuery.attrs['outcome']).toBe('invalid_value');
    expect(badQuery.attrs['k']).toBe(-1);
    expect(badQuery.level).toBe('warn');
    // a corrupt open is a warn event with the reason
    await store.close();
    await driver.open();
    await editHead(driver, NS, (_h, dv) => dv.setUint32(HEAD_FIELD.totalRows, 4194305, true));
    const rec2 = recorder();
    const { store: s2 } = await make({ events: rec2.sink }, driver);
    await expect(s2.query(NS, new Float32Array(4), 1)).rejects.toMatchObject({ code: 'corrupt' });
    const openEv = rec2.events.find((e) => e.name === 'storage.index.open')!;
    expect(openEv.level).toBe('warn');
    expect(openEv.attrs).toMatchObject({ outcome: 'corrupt', reason: 'count' });
    for (const e of [...rec.events, ...rec2.events]) expect(eventProblems(e), e.name).toEqual([]);
  });

  it('a throwing sink cannot break a vector call', async () => {
    const { store } = await make({
      events: {
        emit: () => {
          throw new Error('sink exploded');
        },
      },
    });
    await store.putVectors(NS, synthRows(0, 3, { dim: 4 }));
    expect((await store.query(NS, synthQuery(0, 4), 2)).length).toBe(2);
  });
});

describe('a WebAssembly trap', () => {
  it('discards the instance: the failing query is corrupt wasm_trap, the next call works with a fresh one', async () => {
    const { store } = await make();
    await store.putVectors(NS, synthRows(0, 200, { dim: 16 }));
    const q = synthQuery(0, 16);
    const before = await store.query(NS, q, 5);
    store.armVectorTrapForTest(0);
    const err = await store.query(NS, q, 5).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'corrupt', details: { reason: 'wasm_trap' } });
    // not sticky: a trap is not a corrupt index
    const after = await store.query(NS, q, 5);
    expect(after).toEqual(before);
    expect((await store.indexInfo(NS))?.rows).toBe(200);
  });

  it('a trap during a write is io, and the index is unchanged', async () => {
    const { store } = await make();
    await store.putVectors(NS, synthRows(0, 20, { dim: 16 }));
    await store.query(NS, synthQuery(0, 16), 1);
    store.armVectorTrapForTest(3);
    const err = await store
      .putVectors(NS, synthRows(100, 20, { dim: 16 }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'io', details: { reason: 'wasm_trap' } });
    expect((await store.indexInfo(NS))?.rows).toBe(20);
    await store.putVectors(NS, synthRows(100, 20, { dim: 16 }));
    expect((await store.indexInfo(NS))?.rows).toBe(40);
  });

  it('a trap during open is corrupt wasm_trap and the next open succeeds', async () => {
    const driver = new MemoryDriver();
    const a = await createStore({ driver });
    await a.putVectors(NS, synthRows(0, 20, { dim: 16 }));
    await a.close();
    await driver.open();
    const { store } = await make({}, driver);
    await store.indexInfo(NS);
    store.armVectorTrapForTest(0);
    await expect(store.query(NS, synthQuery(0, 16), 3)).rejects.toMatchObject({
      code: 'corrupt',
      details: { reason: 'wasm_trap' },
    });
    expect((await store.query(NS, synthQuery(0, 16), 3)).length).toBe(3);
  });
});
