import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CONTRACTS, vendoredBody } from '../scripts/sync-contracts.mjs';

const siblingPresent = CONTRACTS.every((c: { source: string }) => existsSync(c.source));

describe('vendored contracts', () => {
  it('carry the vendoring header pointing at runtime/spec', () => {
    for (const c of CONTRACTS as Array<{ target: string }>) {
      const text = readFileSync(c.target, 'utf8');
      expect(text.startsWith('// Vendored from AirplaneMode-Labs/runtime spec/')).toBe(true);
      expect(text.split('\n')[0]).toContain('source of truth is runtime/spec');
    }
  });

  it.skipIf(!siblingPresent)(
    'match ../runtime/spec byte for byte (run `npm run sync-contracts` on drift)',
    () => {
      for (const c of CONTRACTS as Array<{ source: string; target: string }>) {
        const src = readFileSync(c.source, 'utf8');
        const vendored = vendoredBody(readFileSync(c.target, 'utf8'));
        expect(vendored, `drift in ${resolve(c.target)}`).toBe(src);
      }
    },
  );
});
