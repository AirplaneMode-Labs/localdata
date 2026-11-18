// Own-property helpers. A plain `obj[key] = value` with key === '__proto__' does not create a member:
// it runs the Object.prototype.__proto__ setter and either sets a prototype or is silently ignored.
// Everything in the SDK that builds an object from user-controlled or stored names goes through
// setOwn(), so '__proto__' is an ordinary own member like any other key (S1-100, S1-101).

/** Defines `key` as an own, enumerable, writable, configurable data property of `target`. */
export function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A record with no prototype at all: no inherited member can collide with any key. */
export function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
