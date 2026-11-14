// storage.* events (Event contract 0.1.2, source "localdata"). Optional: nothing here runs, and no
// timing is taken, unless the app passes an EventSink to createStore({ events }).
//
// Rules (also in README "Security and privacy" and runtime/spec/storage-api.md):
//   - The sink is called synchronously, inside try/catch, and its return value is never awaited. A
//     sink that throws, or returns a rejecting promise, cannot break a storage operation.
//   - An event is built from fixed fields only: the namespace (when it is a valid one, otherwise ''),
//     the driver name, an outcome from a closed set, byte counts and a duration. It never carries a
//     key, a prefix, a value, a driver error message or a stack.
//   - The namespace DOES appear. Applications must not encode personal data or document identifiers
//     in namespace names.
//   - Events emitted from inside a sink call on the same store (the sink calling back into the
//     store synchronously) are dropped, so a sink can never recurse into itself.
import {
  EVENT_SPEC,
  type Event,
  type EventAttrs,
  type EventKind,
  type EventLevel,
  type EventSink,
} from './contracts/event';
import { STORAGE_NS_PATTERN, type StorageErrorCode } from './contracts/storage-api';

export const STORAGE_EVENT_SOURCE = 'localdata';

export type SetOutcome = 'ok' | StorageErrorCode;
export type GetOutcome = 'hit' | 'miss' | 'expired' | StorageErrorCode;
export type DeleteOutcome = 'removed' | 'absent' | StorageErrorCode;

const ERROR_CODES: ReadonlySet<string> = new Set<StorageErrorCode>([
  'not_implemented',
  'quota_exceeded',
  'invalid_key',
  'invalid_namespace',
  'invalid_value',
  'driver_unavailable',
  'io',
  'closed',
]);
const DRIVER_NAMES: ReadonlySet<string> = new Set(['opfs', 'indexeddb', 'memory']);

/** The StorageErrorCode of a thrown value; anything that is not a StorageError is 'io'. */
export function outcomeOf(e: unknown): StorageErrorCode {
  const code = (e as { code?: unknown } | null)?.code;
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'StorageError' && typeof code === 'string' && ERROR_CODES.has(code)
    ? (code as StorageErrorCode)
    : 'io';
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let moduleSession: string | undefined;
/** Random id for this page load (module instance). Never persisted, never derived from the user. */
function defaultSession(): string {
  return (moduleSession ??= randomId());
}

function monotonicNow(): number {
  const p = (globalThis as { performance?: Performance }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

/** Throws a plain message (no value echoed) when the options are not usable. Returns normalised values. */
export function eventOptionProblem(opts: {
  events?: unknown;
  eventSession?: unknown;
}): string | undefined {
  if (opts.events !== undefined) {
    const s = opts.events as { emit?: unknown } | null;
    if (typeof s !== 'object' || s === null || typeof s.emit !== 'function')
      return 'events must be an EventSink: an object with an emit(event) method';
  }
  if (opts.eventSession !== undefined) {
    const v = opts.eventSession;
    if (typeof v !== 'string' || v.length < 1 || v.length > 64)
      return 'eventSession must be a string of 1..64 characters (a random id, never user-derived)';
  }
  return undefined;
}

/** Emits the storage.* events of one store. Construct with no sink for a zero-cost no-op. */
export class StorageEvents {
  private readonly driver: string;
  private emitting = false;

  constructor(
    private readonly sink: EventSink | undefined,
    driverName: string,
    private readonly session: string | undefined,
  ) {
    this.driver = DRIVER_NAMES.has(driverName) ? driverName : 'custom';
  }

  get enabled(): boolean {
    return this.sink !== undefined;
  }

  /** Start time for a duration; 0 (and no clock read) when there is no sink. */
  start(): number {
    return this.sink === undefined ? 0 : monotonicNow();
  }

  set(startedAt: number, ns: string, outcome: SetOutcome, bytes?: number): void {
    this.timing('storage.set', startedAt, ns, outcome, outcome === 'ok' ? 'debug' : 'warn', bytes);
  }

  get(startedAt: number, ns: string, outcome: GetOutcome, bytes?: number): void {
    const quiet = outcome === 'hit' || outcome === 'miss' || outcome === 'expired';
    this.timing('storage.get', startedAt, ns, outcome, quiet ? 'debug' : 'warn', bytes);
  }

  delete(startedAt: number, ns: string, outcome: DeleteOutcome): void {
    const quiet = outcome === 'removed' || outcome === 'absent';
    this.timing('storage.delete', startedAt, ns, outcome, quiet ? 'debug' : 'warn');
  }

  /**
   * storage.quota. `ns` is '' for all namespaces. `quota` is the SDK soft quota, or null when there
   * is none or when the browser (which does not say what its limit is) refused the write. `needed` is
   * 0 from usage(); on a refused set it is the bytes that did not fit: the exact shortfall for the
   * soft quota, and the write's own size (an upper bound) for a browser refusal.
   */
  quota(
    ns: string,
    usage: number,
    quota: number | null,
    needed: number,
    level: 'debug' | 'warn',
  ): void {
    if (this.sink === undefined) return;
    this.deliver('log', 'storage.quota', level, {
      driver: this.driver,
      ns: validNs(ns),
      usage,
      quota,
      needed,
    });
  }

  private timing(
    name: string,
    startedAt: number,
    ns: string,
    outcome: string,
    level: EventLevel,
    bytes?: number,
  ): void {
    if (this.sink === undefined) return;
    this.deliver(
      'timing',
      name,
      level,
      { ns: validNs(ns), driver: this.driver, outcome },
      Math.max(0, monotonicNow() - startedAt),
      bytes,
    );
  }

  private deliver(
    kind: EventKind,
    name: string,
    level: EventLevel,
    attrs: EventAttrs,
    durationMs?: number,
    bytes?: number,
  ): void {
    const sink = this.sink;
    if (sink === undefined || this.emitting) return;
    this.emitting = true;
    try {
      const e: Event = {
        spec: EVENT_SPEC,
        id: randomId(),
        ts: Date.now(),
        session: this.session ?? defaultSession(),
        source: STORAGE_EVENT_SOURCE,
        kind,
        name,
        level,
        attrs,
      };
      const p = (globalThis as { performance?: Performance }).performance;
      if (p && typeof p.now === 'function') e.mono = p.now();
      if (durationMs !== undefined && Number.isFinite(durationMs)) e.durationMs = durationMs;
      if (bytes !== undefined && Number.isSafeInteger(bytes) && bytes >= 0) e.bytes = bytes;
      const returned: unknown = sink.emit(e);
      // Never awaited; a rejection must not surface as an unhandled rejection either.
      if (isThenable(returned)) returned.then(undefined, () => undefined);
    } catch {
      // A sink must never break a storage operation.
    } finally {
      this.emitting = false;
    }
  }
}

/** The namespace as it may appear in an event: itself when valid, otherwise '' (never the raw string). */
function validNs(ns: string): string {
  return typeof ns === 'string' && STORAGE_NS_PATTERN.test(ns) ? ns : '';
}
