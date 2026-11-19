// Test hooks for the vector layer. TEST CODE ONLY.
//
// BUG-T2-S6-07 and BUG-T2-S6-12: this module is deliberately NOT imported by src/index.ts (or by anything
// src/index.ts imports), so it is in neither the emitted typings (dist/index.d.ts) nor the bundle
// (dist/index.js) nor the packed tarball; test/dist-surface.test.ts and `npm run pack:check` fail if it ever
// is, or if any identifier ending in "ForTest" or any name below reaches a shipped file. Tests import it from
// the source path:
//
//   import { annStats, armAnnTrap, armVectorTrap } from '../src/vec/ann-test-hook';
//
// The hooks reach into the store's private vector layer on purpose; they have no public API to keep stable.
import type { LocalData } from '../store';
import type { AnnManager } from './ann';
import type { Kernel } from './kernel';

interface Inner {
  vec: { ann: AnnManager; kernel: Kernel | undefined };
}

/** Kernel fields the hooks set (they are `private` to the class only for TypeScript). */
interface Traps {
  trapAfter: number | undefined;
  trapOnHnsw: boolean;
}

const inner = (store: LocalData): Inner['vec'] => (store as unknown as Inner).vec;

/**
 * The next call into the HNSW code of this store's vector kernel traps for real (an out-of-range read inside
 * WebAssembly). The store must then discard the instance and answer through the flat scan. Applied at the first
 * graph operation after this call, on whichever kernel instance that operation uses.
 */
export function armAnnTrap(store: LocalData): void {
  inner(store).ann.beforeGraphCall = (kernel) => {
    (kernel as unknown as Traps).trapOnHnsw = true;
  };
}

/** The n-th next kernel boundary call of this store (0 = the very next) traps for real. */
export function armVectorTrap(store: LocalData, afterCalls = 0): void {
  const kernel = inner(store).kernel;
  if (kernel !== undefined) (kernel as unknown as Traps).trapAfter = afterCalls;
}

/** How many rebuilds of a refused graph ran for `ns` in this store. */
export function annStats(store: LocalData, ns: string): { rebuilds: number } {
  return { rebuilds: inner(store).ann.state(ns).rebuilds };
}
