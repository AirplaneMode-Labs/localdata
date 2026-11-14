// storage.* events (Event contract 0.1.2): written before src/events.ts and the createStore
// `events` option. The memory driver stands in for OPFS and IndexedDB; test/browser/drivers.spec.ts
// repeats the shape and privacy checks over the real drivers.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STORAGE_EVENT_NAMES,
  createStore,
  encode,
  type Event,
  type EventSink,
  type StorageDriver,
} from '../src/index';
import { MemoryDriver } from '../src/drivers/memory';
import { eventProblems, schemaProblems } from './event-validate';

interface Rec {
  sink: EventSink;
  events: Event[];
  names: () => string[];
}
function recorder(): Rec {
  const events: Event[] = [];
  return {
    sink: { emit: (e) => void events.push(e) },
    events,
    names: () => events.map((e) => e.name),
  };
}

const SPEC_SCHEMA = resolve(
  import.meta.dirname,
  '..',
  '..',
  'runtime',
  'spec',
  'event.schema.json',
);
const specSchema = existsSync(SPEC_SCHEMA)
  ? (JSON.parse(readFileSync(SPEC_SCHEMA, 'utf8')) as Record<string, unknown>)
  : undefined;

function expectValid(events: Event[]): void {
  for (const e of events) {
    expect(eventProblems(e), JSON.stringify(e)).toEqual([]);
    if (specSchema) expect(schemaProblems(specSchema, e), JSON.stringify(e)).toEqual([]);
  }
}

/** A driver whose chosen operations throw, to reach the io and browser-quota paths. */
class FlakyDriver extends MemoryDriver {
  failPut: unknown;
  failGet: unknown;
  override async put(...a: Parameters<MemoryDriver['put']>): Promise<void> {
    if (this.failPut !== undefined) throw this.failPut;
    return super.put(...a);
  }
  override async getBytes(...a: Parameters<MemoryDriver['getBytes']>) {
    if (this.failGet !== undefined) throw this.failGet;
    return super.getBytes(...a);
  }
}

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});
async function make(
  rec: Rec | undefined,
  extra: Record<string, unknown> = {},
  driver: StorageDriver = new MemoryDriver(),
) {
  const store = await createStore({
    driver,
    ...(rec ? { events: rec.sink } : {}),
    ...extra,
  } as Parameters<typeof createStore>[0]);
  open.push(store);
  return store;
}

describe('storage.* events: shapes', () => {
  it('exports STORAGE_EVENT_NAMES with the seven names of Event 0.1.3', () => {
    expect([...STORAGE_EVENT_NAMES]).toEqual([
      'storage.set',
      'storage.get',
      'storage.delete',
      'storage.quota',
      'storage.query',
      'storage.index.open',
      'storage.index.write',
    ]);
  });

  it('set emits one storage.set: timing, source localdata, attrs exactly {ns, driver, outcome}', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.set('docs', 'k', { a: 1 });
    expect(rec.events).toHaveLength(1);
    const e = rec.events[0]!;
    expect(e.name).toBe('storage.set');
    expect(e.kind).toBe('timing');
    expect(e.source).toBe('localdata');
    expect(e.level).toBe('debug');
    expect(e.attrs).toEqual({ ns: 'docs', driver: 'memory', outcome: 'ok' });
    expect(typeof e.durationMs).toBe('number');
    expect(e.durationMs!).toBeGreaterThanOrEqual(0);
    expect(e.bytes).toBe((await store.usage('docs')).bytes);
    expectValid(rec.events);
  });

  it('get emits hit (with bytes), miss and expired', async () => {
    const rec = recorder();
    let now = 1_000;
    const store = await make(rec, { clock: () => now });
    await store.set('docs', 'k', 'value');
    await store.set('docs', 'ttl', 'value', { ttlMs: 10 });
    rec.events.length = 0;
    await store.get('docs', 'k');
    await store.get('docs', 'absent');
    now += 20;
    await store.get('docs', 'ttl');
    expect(rec.names()).toEqual(['storage.get', 'storage.get', 'storage.get']);
    const [hit, miss, expired] = rec.events as [Event, Event, Event];
    expect(hit.attrs).toEqual({ ns: 'docs', driver: 'memory', outcome: 'hit' });
    expect(hit.bytes).toBeGreaterThan(0);
    expect(hit.kind).toBe('timing');
    expect(miss.attrs).toEqual({ ns: 'docs', driver: 'memory', outcome: 'miss' });
    expect(miss.bytes).toBeUndefined();
    expect(expired.attrs).toEqual({ ns: 'docs', driver: 'memory', outcome: 'expired' });
    expect(expired.bytes).toBeUndefined();
    expectValid(rec.events);
  });

  it('a get hit reports the stored (encoded) size', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.set('docs', 'k', new Uint8Array(100));
    const stored = rec.events[0]!.bytes!;
    rec.events.length = 0;
    await store.get('docs', 'k');
    expect(rec.events[0]!.bytes).toBe(stored);
    expect(stored).toBeGreaterThan(100);
  });

  it('delete emits removed and absent; an expired row counts as absent', async () => {
    const rec = recorder();
    let now = 1_000;
    const store = await make(rec, { clock: () => now });
    await store.set('docs', 'k', 1);
    await store.set('docs', 'ttl', 1, { ttlMs: 10 });
    rec.events.length = 0;
    expect(await store.delete('docs', 'k')).toBe(true);
    expect(await store.delete('docs', 'k')).toBe(false);
    now += 20;
    expect(await store.delete('docs', 'ttl')).toBe(false);
    expect(rec.events.map((e) => [e.name, e.attrs['outcome']])).toEqual([
      ['storage.delete', 'removed'],
      ['storage.delete', 'absent'],
      ['storage.delete', 'absent'],
    ]);
    expect(rec.events[0]!.attrs).toEqual({ ns: 'docs', driver: 'memory', outcome: 'removed' });
    expect(rec.events[0]!.kind).toBe('timing');
    expect(rec.events[0]!.bytes).toBeUndefined();
    expectValid(rec.events);
  });

  it('list, clear and close emit nothing', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.set('docs', 'k', 1);
    rec.events.length = 0;
    await store.list('docs');
    await store.clear('docs');
    await store.close();
    expect(rec.events).toEqual([]);
  });

  it('usage() emits storage.quota at debug: ns "" for all namespaces, quota null without a soft quota, needed 0', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.set('docs', 'k', 'abc');
    const used = (await store.usage('docs')).bytes;
    rec.events.length = 0;
    await store.usage();
    await store.usage('docs');
    expect(rec.events.map((e) => e.name)).toEqual(['storage.quota', 'storage.quota']);
    expect(rec.events[0]!.kind).toBe('log');
    expect(rec.events[0]!.level).toBe('debug');
    expect(rec.events[0]!.attrs).toEqual({
      driver: 'memory',
      ns: '',
      usage: used,
      quota: null,
      needed: 0,
    });
    expect(rec.events[1]!.attrs).toEqual({
      driver: 'memory',
      ns: 'docs',
      usage: used,
      quota: null,
      needed: 0,
    });
    expectValid(rec.events);
  });

  it('usage() reports the configured soft quota', async () => {
    const rec = recorder();
    const store = await make(rec, { quotaBytes: 4096 });
    rec.events.length = 0;
    await store.usage();
    expect(rec.events[0]!.attrs['quota']).toBe(4096);
  });
});

describe('storage.* events: failures', () => {
  it('a set the soft quota refuses emits storage.quota (warn) then storage.set quota_exceeded (warn)', async () => {
    const rec = recorder();
    const store = await make(rec, { quotaBytes: 200 });
    await store.set('docs', 'small', 'x');
    const used = (await store.usage()).bytes;
    rec.events.length = 0;
    await expect(store.set('docs', 'big', new Uint8Array(500))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(rec.names()).toEqual(['storage.quota', 'storage.set']);
    const [quota, set] = rec.events as [Event, Event];
    expect(quota.kind).toBe('log');
    expect(quota.level).toBe('warn');
    expect(quota.attrs['driver']).toBe('memory');
    expect(quota.attrs['ns']).toBe('docs');
    expect(quota.attrs['usage']).toBe(used);
    expect(quota.attrs['quota']).toBe(200);
    // needed = how far over the quota the refused write would have gone (the shortfall).
    expect(quota.attrs['needed']).toBeGreaterThan(0);
    expect(Object.keys(quota.attrs).sort()).toEqual(['driver', 'needed', 'ns', 'quota', 'usage']);
    expect(set.level).toBe('warn');
    expect(set.attrs).toEqual({ ns: 'docs', driver: 'memory', outcome: 'quota_exceeded' });
    expectValid(rec.events);
  });

  it('the shortfall is projected total minus quota', async () => {
    const rec = recorder();
    const store = await make(rec, { quotaBytes: 300 });
    await store.set('docs', 'a', new Uint8Array(100));
    const used = (await store.usage()).bytes;
    rec.events.length = 0;
    await expect(store.set('docs', 'b', new Uint8Array(400))).rejects.toThrow();
    const attemptedBytes = (await encode(new Uint8Array(400))).byteLength;
    expect(rec.events[0]!.attrs['needed']).toBe(used + attemptedBytes - 300);
  });

  it('a browser QuotaExceededError from the driver emits storage.quota with quota null and storage.set quota_exceeded', async () => {
    const rec = recorder();
    const driver = new FlakyDriver();
    const store = await make(rec, {}, driver);
    driver.failPut = Object.assign(new Error('The quota has been exceeded.'), {
      name: 'QuotaExceededError',
    });
    await expect(store.set('docs', 'k', new Uint8Array(50))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(rec.names()).toEqual(['storage.quota', 'storage.set']);
    expect(rec.events[0]!.level).toBe('warn');
    expect(rec.events[0]!.attrs['quota']).toBeNull();
    expect(rec.events[0]!.attrs['needed']).toBeGreaterThan(0);
    expect(rec.events[1]!.attrs['outcome']).toBe('quota_exceeded');
    expectValid(rec.events);
  });

  it('a driver failure is outcome io on set, get and delete', async () => {
    const rec = recorder();
    const driver = new FlakyDriver();
    const store = await make(rec, {}, driver);
    await store.set('docs', 'k', 1);
    rec.events.length = 0;
    driver.failPut = new Error('disk on fire');
    driver.failGet = new Error('disk on fire');
    await expect(store.set('docs', 'k2', 1)).rejects.toMatchObject({ code: 'io' });
    await expect(store.get('docs', 'k')).rejects.toMatchObject({ code: 'io' });
    expect(rec.events.map((e) => [e.name, e.attrs['outcome'], e.level])).toEqual([
      ['storage.set', 'io', 'warn'],
      ['storage.get', 'io', 'warn'],
    ]);
    expectValid(rec.events);
  });

  it('validation failures carry their StorageErrorCode as the outcome', async () => {
    const rec = recorder();
    const store = await make(rec);
    await expect(store.set('docs', '', 1)).rejects.toMatchObject({ code: 'invalid_key' });
    await expect(store.get('docs', 'a\u0000b')).rejects.toMatchObject({ code: 'invalid_key' });
    await expect(store.delete('docs', '')).rejects.toMatchObject({ code: 'invalid_key' });
    await expect(store.set('docs', 'k', (() => 1) as never)).rejects.toMatchObject({
      code: 'invalid_value',
    });
    await expect(store.set('docs', 'k', 1, { ttlMs: -1 })).rejects.toMatchObject({
      code: 'invalid_value',
    });
    expect(rec.events.map((e) => [e.name, e.attrs['outcome']])).toEqual([
      ['storage.set', 'invalid_key'],
      ['storage.get', 'invalid_key'],
      ['storage.delete', 'invalid_key'],
      ['storage.set', 'invalid_value'],
      ['storage.set', 'invalid_value'],
    ]);
    expect(rec.events.every((e) => e.level === 'warn')).toBe(true);
    expectValid(rec.events);
  });

  it('operations on a closed store emit outcome closed', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.close();
    await expect(store.set('docs', 'k', 1)).rejects.toMatchObject({ code: 'closed' });
    await expect(store.get('docs', 'k')).rejects.toMatchObject({ code: 'closed' });
    await expect(store.delete('docs', 'k')).rejects.toMatchObject({ code: 'closed' });
    expect(rec.events.map((e) => e.attrs['outcome'])).toEqual(['closed', 'closed', 'closed']);
    expectValid(rec.events);
  });

  it('an invalid namespace is reported as ns "" and outcome invalid_namespace, never the offending string', async () => {
    const rec = recorder();
    const store = await make(rec);
    const bad = 'Bad Namespace With Spaces SENTINEL-NS-91c2';
    await expect(store.set(bad, 'k', 1)).rejects.toMatchObject({ code: 'invalid_namespace' });
    await expect(store.get(bad, 'k')).rejects.toMatchObject({ code: 'invalid_namespace' });
    await expect(store.delete('__ld_meta', 'k')).rejects.toMatchObject({
      code: 'invalid_namespace',
    });
    expect(rec.events.map((e) => [e.attrs['ns'], e.attrs['outcome']])).toEqual([
      ['', 'invalid_namespace'],
      ['', 'invalid_namespace'],
      ['', 'invalid_namespace'],
    ]);
    expect(JSON.stringify(rec.events)).not.toContain('SENTINEL-NS-91c2');
    expectValid(rec.events);
  });

  it('closed store plus an invalid namespace still never leaks the namespace string', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.close();
    await expect(store.get('NOT A NAMESPACE SENTINEL-NS-5d1e', 'k')).rejects.toMatchObject({
      code: 'closed',
    });
    expect(rec.events[0]!.attrs['ns']).toBe('');
    expect(JSON.stringify(rec.events)).not.toContain('SENTINEL-NS-5d1e');
  });

  it('query() on a namespace with no index resolves [] and emits storage.index.open (absent) then storage.query (0.2.0)', async () => {
    const rec = recorder();
    const store = await make(rec);
    await expect(store.query('docs', new Float32Array(4), 1)).resolves.toEqual([]);
    expect(rec.events.map((e) => e.name)).toEqual(['storage.index.open', 'storage.query']);
    expect(rec.events[0]!.attrs['outcome']).toBe('absent');
    expect(rec.events[1]!.attrs['outcome']).toBe('ok');
    expect(rec.events[1]!.attrs['candidates']).toBe(0);
    expectValid(rec.events);
  });

  it('usage(), delete() and the other KV calls emit no storage.index.* event and create no kernel', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.set('docs', 'k', 1);
    await store.usage('docs');
    await store.usage();
    await store.delete('docs', 'k');
    await store.clear('docs');
    expect(rec.names().every((n) => !n.startsWith('storage.index.') && n !== 'storage.query')).toBe(
      true,
    );
    expect(store.vectorWasmBytes()).toBe(0);
  });
});

describe('storage.* events: privacy', () => {
  const KEY = 'SENTINEL-KEY-7f3a/with/slashes';
  const PREFIX = 'SENTINEL-PREFIX-22b9';
  const VALUE = 'SENTINEL-VALUE-c0de-नमस्ते';

  it('no key, prefix, value, driver message or stack appears in any event, over every operation and failure', async () => {
    const rec = recorder();
    const driver = new FlakyDriver();
    const store = await make(rec, { quotaBytes: 600 }, driver);
    await store.set('docs', KEY, { secret: VALUE });
    await store.set('docs', `${PREFIX}-1`, VALUE, { ttlMs: 60_000 });
    await store.get('docs', KEY);
    await store.get('docs', `${KEY}-missing`);
    await store.list('docs', { prefix: PREFIX });
    await store.usage('docs');
    await store.delete('docs', KEY);
    await store.delete('docs', `${KEY}-missing`);
    await expect(store.set('docs', KEY, VALUE.repeat(200))).rejects.toThrow();
    driver.failPut = new Error(`SENTINEL-DRIVER-MESSAGE key=${KEY} value=${VALUE}`);
    driver.failGet = new Error(`SENTINEL-DRIVER-MESSAGE key=${KEY}`);
    await expect(store.set('docs', 'k3', 1)).rejects.toThrow();
    await expect(store.get('docs', `${PREFIX}-1`)).rejects.toThrow();
    await expect(store.set('docs', 'x'.repeat(2000), VALUE)).rejects.toThrow();
    await expect(store.set(KEY.toUpperCase(), 'k', VALUE)).rejects.toThrow();
    await store.close();
    await expect(store.get('docs', KEY)).rejects.toThrow();

    expect(rec.events.length).toBeGreaterThan(10);
    const wire = JSON.stringify(rec.events);
    for (const needle of [
      'SENTINEL-KEY',
      'SENTINEL-PREFIX',
      'SENTINEL-VALUE',
      'SENTINEL-DRIVER',
      'c0de',
      'slashes',
      'secret',
      'disk',
      'Error:',
      'at ',
    ]) {
      expect(wire, `leaked ${needle}`).not.toContain(needle);
    }
    for (const e of rec.events) {
      expect(
        Object.keys(e.attrs).every((k) => /^(ns|driver|outcome|usage|quota|needed)$/.test(k)),
      ).toBe(true);
    }
    expectValid(rec.events);
  });

  it('only fixed attrs appear: ns, driver, outcome (set/get/delete); driver, ns, usage, quota, needed (quota)', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.set('docs', 'k', 1);
    await store.get('docs', 'k');
    await store.delete('docs', 'k');
    await store.usage();
    const shapes = new Set(
      rec.events.map((e) => `${e.name}:${Object.keys(e.attrs).sort().join(',')}`),
    );
    expect([...shapes].sort()).toEqual([
      'storage.delete:driver,ns,outcome',
      'storage.get:driver,ns,outcome',
      'storage.quota:driver,needed,ns,quota,usage',
      'storage.set:driver,ns,outcome',
    ]);
  });
});

describe('storage.* events: sink contract', () => {
  it('the sink is called synchronously: the event is delivered before the awaiting caller resumes', async () => {
    const order: string[] = [];
    const store = await make(undefined, { events: { emit: () => void order.push('emit') } });
    await store.set('docs', 'k', 1).then(() => order.push('resolved'));
    expect(order).toEqual(['emit', 'resolved']);
  });

  it('a throwing sink never breaks the operation', async () => {
    const store = await make(undefined, {
      events: {
        emit: () => {
          throw new Error('sink exploded');
        },
      },
    });
    await store.set('docs', 'k', 'v');
    expect(await store.get('docs', 'k')).toBe('v');
    expect(await store.delete('docs', 'k')).toBe(true);
  });

  it('a sink that returns a promise is not awaited: a never-settling or rejecting promise changes nothing', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => void unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      let calls = 0;
      const store = await make(undefined, {
        events: {
          emit: () => {
            calls++;
            return (calls % 2 === 0
              ? new Promise(() => {})
              : Promise.reject(new Error('async sink failed'))) as unknown as void;
          },
        },
      });
      await store.set('docs', 'a', 1);
      await store.set('docs', 'b', 2);
      await store.get('docs', 'a');
      await new Promise((r) => setTimeout(r, 25));
      expect(calls).toBe(3);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a sink that calls back into the same store synchronously cannot recurse: nested events are dropped', async () => {
    const events: Event[] = [];
    let store!: Awaited<ReturnType<typeof make>>;
    store = await make(undefined, {
      events: {
        emit: (e: Event) => {
          events.push(e);
          void store.usage(); // would emit storage.quota synchronously from inside the sink
        },
      },
    });
    await store.set('docs', 'k', 1);
    expect(events.map((e) => e.name)).toEqual(['storage.set']);
  });

  it('without a sink nothing is emitted and the store behaves as before', async () => {
    const store = await make(undefined);
    await store.set('docs', 'k', 'v');
    expect(await store.get('docs', 'k')).toBe('v');
  });

  it('rejects an events option that is not an EventSink', async () => {
    await expect(
      createStore({ driver: 'memory', events: 42 as unknown as EventSink }),
    ).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(
      createStore({ driver: 'memory', events: {} as unknown as EventSink }),
    ).rejects.toMatchObject({ code: 'invalid_value' });
  });
});

describe('storage.* events: session', () => {
  it('every event of a module carries one random session id of 1..64 characters', async () => {
    const rec = recorder();
    const store = await make(rec);
    await store.set('docs', 'k', 1);
    await store.get('docs', 'k');
    const ids = new Set(rec.events.map((e) => e.session));
    expect(ids.size).toBe(1);
    const [id] = [...ids] as [string];
    expect(id.length).toBeGreaterThanOrEqual(1);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it('eventSession lets an app share the runtime session id', async () => {
    const rec = recorder();
    const store = await make(rec, { eventSession: 'runtime-session-abc123' });
    await store.set('docs', 'k', 1);
    expect(rec.events[0]!.session).toBe('runtime-session-abc123');
  });

  it('rejects an eventSession that is empty, over 64 characters or not a string', async () => {
    for (const bad of ['', 'x'.repeat(65), 7]) {
      await expect(
        createStore({ driver: 'memory', eventSession: bad as unknown as string }),
      ).rejects.toMatchObject({ code: 'invalid_value' });
    }
  });
});

describe('event validators (so the checks above are not vacuous)', () => {
  const good: Event = {
    spec: 'airplanemode.event/0.1',
    id: '123e4567-e89b-42d3-a456-426614174000',
    ts: 1,
    session: 's',
    source: 'localdata',
    kind: 'timing',
    name: 'storage.set',
    level: 'debug',
    attrs: { ns: 'docs', driver: 'memory', outcome: 'ok' },
  };
  it('accepts a good event and rejects a bad one under both validators', () => {
    expect(eventProblems(good)).toEqual([]);
    expect(eventProblems({ ...good, attrs: { ...good.attrs, text: 'x' } })).not.toEqual([]);
    expect(eventProblems({ ...good, id: 'nope' })).not.toEqual([]);
    expect(eventProblems({ ...good, name: 'storage.unknown' })).not.toEqual([]);
    expect(eventProblems({ ...good, source: 'runtime' })).not.toEqual([]);
    if (specSchema) {
      expect(schemaProblems(specSchema, good)).toEqual([]);
      expect(schemaProblems(specSchema, { ...good, extra: 1 })).not.toEqual([]);
      expect(schemaProblems(specSchema, { ...good, attrs: { a: { nested: 1 } } })).not.toEqual([]);
    }
  });
});
