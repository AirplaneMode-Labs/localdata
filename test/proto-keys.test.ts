// S1-100 and S1-101 over the memory driver, each case across a close and reopen. The same cases run
// against OPFS and IndexedDB in Chrome (test/browser/proto.spec.ts).
import { describe, expect, it } from 'vitest';
import { HOSTILE_KEYS, protoCases } from './proto.behaviour';
import { memoryPersistEnv } from './memory-env';
import { runPersistCases } from './persist-env';

describe('prototype-safe keys and values (memory driver)', () => {
  it('covers the ten hostile key names and has unique case names', () => {
    expect(HOSTILE_KEYS).toEqual([
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
    ]);
    expect(new Set(protoCases.map((c) => c.name)).size).toBe(protoCases.length);
    expect(protoCases.length).toBeGreaterThanOrEqual(8);
  });

  runPersistCases(protoCases, memoryPersistEnv(), (name, fn) => it(name, fn, 60_000));

  it('leaves Object.prototype exactly as it was', () => {
    const own = Object.getOwnPropertyNames(Object.prototype).sort();
    expect(own).toEqual(
      [
        '__defineGetter__',
        '__defineSetter__',
        '__lookupGetter__',
        '__lookupSetter__',
        '__proto__',
        'constructor',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'toLocaleString',
        'toString',
        'valueOf',
      ].sort(),
    );
  });
});
