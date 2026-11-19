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
import { STORAGE_NS_PATTERN, StorageError, type StorageErrorCode } from './contracts/storage-api';

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
  'corrupt',
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

/** Namespace prefixes the SDK itself redacts in events: dockit keeps one namespace per document. */
export const BUILTIN_REDACTED_PREFIXES: readonly string[] = Object.freeze(['dockit.d']);
/** At most this many prefixes can be registered through redactNamespacePrefix(). */
export const REDACTED_PREFIXES_MAX = 16;

/** The 0.1.5 attrs of storage.query: which index was asked for, which answered, why not the asked one. */
export interface QueryAnnAttrs {
  requested: 'flat' | 'hnsw';
  index: 'flat' | 'hnsw';
  fallback: '' | 'absent' | 'stale' | 'filter' | 'metric' | 'short' | 'refused' | 'trap';
  ef: number | null;
}
const FLAT_QUERY: QueryAnnAttrs = { requested: 'flat', index: 'flat', fallback: '', ef: null };

export type DocPutOutcome = 'ok' | StorageErrorCode;
export type DocDeleteOutcome = 'removed' | 'absent' | StorageErrorCode;

/** Emits the storage.* events of one store. Construct with no sink for a zero-cost no-op. */
export class StorageEvents {
  private readonly driver: string;
  private emitting = false;
  private readonly redacted: string[] = [...BUILTIN_REDACTED_PREFIXES];

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

  /**
   * True while the sink is being called. An operation that STARTS inside a sink call is "nested":
   * its events are dropped for its whole lifetime, even if they would be emitted after an await,
   * so a sink that calls back into the store can never feed itself.
   */
  get nested(): boolean {
    return this.emitting;
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
   * storage.query. Never the query vector, filterPrefix, keys, scores or values. `kernel` is the
   * scan kernel in use, or 'none' when no kernel had been created. Since Event 0.1.5 also `requested`
   * (QueryOptions.index as given, default 'flat'), `index` (the index that answered), `fallback` ('' or
   * why the flat scan answered a request for 'hnsw') and `ef` (the effective HNSW ef, or null).
   */
  query(
    startedAt: number,
    ns: string,
    outcome: string,
    k: number,
    candidates: number,
    metric: string,
    kernel: string,
    ann: QueryAnnAttrs = FLAT_QUERY,
  ): void {
    this.timing(
      'storage.query',
      startedAt,
      ns,
      outcome,
      outcome === 'ok' ? 'debug' : 'warn',
      undefined,
      {
        k: Number.isInteger(k) ? k : -1,
        candidates,
        metric,
        kernel,
        requested: ann.requested,
        index: ann.index,
        fallback: ann.fallback,
        ef: ann.ef,
      },
    );
  }

  /**
   * storage.index.open: one event per load of an index (HEAD and META, and vectors when loaded).
   * `swept` is the number of unreferenced index records deleted by this open (T1-S4-08), 0 when none.
   */
  indexOpen(
    startedAt: number,
    ns: string,
    outcome: string,
    rows: number,
    segments: number,
    reason: string,
    kernel: string,
    bytes: number,
    swept = 0,
    kind: 'flat' | 'hnsw' = 'flat',
  ): void {
    this.timing(
      'storage.index.open',
      startedAt,
      ns,
      outcome,
      outcome === 'ok' || outcome === 'absent' ? 'debug' : 'warn',
      bytes,
      { rows, segments, reason, kernel, swept, kind },
    );
  }

  /**
   * storage.index.build (Event 0.1.5): a buildIndex() call ('build' on a namespace without a graph,
   * 'replace' over one) or the SDK's rebuild of a refused graph ('rebuild'). `bytes` is the graph bytes
   * written. Never a key, a vector, a score or the seed.
   */
  indexBuild(
    startedAt: number,
    ns: string,
    outcome: string,
    reason: 'build' | 'rebuild' | 'replace',
    rows: number,
    liveRows: number,
    dim: number,
    m: number,
    efConstruction: number,
    bytes?: number,
  ): void {
    this.timing(
      'storage.index.build',
      startedAt,
      ns,
      outcome,
      outcome === 'ok' ? 'debug' : 'warn',
      bytes,
      { kind: 'hnsw', reason, rows, liveRows, dim, m, efConstruction },
    );
  }

  /** storage.index.write: putVectors, and a vector delete (replaced 0). */
  indexWrite(
    startedAt: number,
    ns: string,
    outcome: string,
    rows: number,
    replaced: number,
    segments: number,
    bytes: number,
  ): void {
    this.timing(
      'storage.index.write',
      startedAt,
      ns,
      outcome,
      outcome === 'ok' ? 'debug' : 'warn',
      bytes,
      { rows, replaced, segments },
    );
  }

  /**
   * redactNamespacePrefix (Storage API 0.3.0): a namespace that starts with `prefix` is emitted in event
   * attrs as prefix + '*', so an application that keeps one namespace per document never shows a document
   * id in an event. Takes effect for every storage.* event of this store.
   */
  redact(prefix: unknown): void {
    if (typeof prefix !== 'string' || !STORAGE_NS_PATTERN.test(prefix)) {
      throw new StorageError(
        'invalid_namespace',
        'invalid prefix: it must match ^[a-z0-9][a-z0-9._-]{0,63}$ (the namespace grammar)',
      );
    }
    if (this.redacted.includes(prefix)) return;
    if (this.redacted.length - BUILTIN_REDACTED_PREFIXES.length >= REDACTED_PREFIXES_MAX) {
      throw new StorageError(
        'invalid_value',
        `at most ${REDACTED_PREFIXES_MAX} prefixes can be registered for redaction`,
      );
    }
    this.redacted.push(prefix);
  }

  /** storage.doc.put: attrs ns, driver, outcome, chunks, replaced, rows; bytes written. Never a docId or text. */
  docPut(
    startedAt: number,
    ns: string,
    outcome: DocPutOutcome,
    chunks: number,
    replaced: boolean,
    rows: number,
    bytes?: number,
  ): void {
    this.timing(
      'storage.doc.put',
      startedAt,
      ns,
      outcome,
      outcome === 'ok' ? 'debug' : 'warn',
      bytes,
      { chunks, replaced, rows },
    );
  }

  /** storage.doc.delete: attrs ns, driver, outcome 'removed' | 'absent' | StorageErrorCode. */
  docDelete(startedAt: number, ns: string, outcome: DocDeleteOutcome): void {
    const quiet = outcome === 'removed' || outcome === 'absent';
    this.timing('storage.doc.delete', startedAt, ns, outcome, quiet ? 'debug' : 'warn');
  }

  /** storage.doc.query: attrs ns, driver, outcome, k, candidates, metric, kernel. Never the vector, docId or scores. */
  docQuery(
    startedAt: number,
    ns: string,
    outcome: string,
    k: number,
    candidates: number,
    metric: string,
    kernel: string,
  ): void {
    this.timing(
      'storage.doc.query',
      startedAt,
      ns,
      outcome,
      outcome === 'ok' ? 'debug' : 'warn',
      undefined,
      { k: Number.isInteger(k) ? k : -1, candidates, metric, kernel },
    );
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
      ns: this.validNs(ns),
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
    extra?: EventAttrs,
  ): void {
    if (this.sink === undefined) return;
    this.deliver(
      'timing',
      name,
      level,
      { ns: this.validNs(ns), driver: this.driver, outcome, ...(extra ?? {}) },
      Math.max(0, monotonicNow() - startedAt),
      bytes,
    );
  }

  /**
   * The namespace as it may appear in an event: itself when valid, 'prefix*' when it starts with a
   * redacted prefix, otherwise '' (never the raw string).
   */
  private validNs(ns: string): string {
    if (typeof ns !== 'string' || !STORAGE_NS_PATTERN.test(ns)) return '';
    for (const p of this.redacted) if (ns.startsWith(p)) return `${p}*`;
    return ns;
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
