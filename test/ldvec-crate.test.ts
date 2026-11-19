// BUG-T3-S6-08 (fix round 1): the ldvec crate manifest says what the crate is now (the flat scan plus the
// in-house HNSW graph) and why it has no dependencies (TD-17 build-or-adopt, TD-65), and it still has none.
//
// Read as text on purpose: no TOML parser is a dependency here. The sections of Cargo.toml are split on
// lines that start with '[', which is enough for this manifest.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const manifest = readFileSync(join(root, 'crates', 'ldvec', 'Cargo.toml'), 'utf8');
const lines = manifest.split(/\r?\n/u);

/** The lines of one `[section]` (up to the next section header), comments and blanks included. */
function section(name: string): string[] {
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  expect(start, `[${name}] is present`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('[')) break;
    out.push(l);
  }
  return out;
}

describe('the ldvec crate manifest', () => {
  it('describes the flat scan and the HNSW graph, not a flat-only kernel', () => {
    const d = /^description\s*=\s*"(.*)"\s*$/mu.exec(manifest);
    expect(d, 'a one-line description').not.toBeNull();
    const text = d![1]!;
    expect(text).toMatch(/HNSW/u);
    expect(text).toMatch(/flat/iu);
    expect(text).not.toMatch(/^Flat vector index kernel/u);
  });

  it('keeps [dependencies] empty and says why: TD-17 and TD-65, with the audit size a buyer reads', () => {
    const deps = section('dependencies');
    const entries = deps.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    expect(entries, 'no dependency of any kind').toEqual([]);
    const idx = lines.findIndex((l) => l.trim() === '[dependencies]');
    const comment = lines
      .slice(Math.max(0, idx - 4), idx)
      .filter((l) => l.trim().startsWith('#'))
      .join('\n');
    expect(comment).toMatch(/TD-17/u);
    expect(comment).toMatch(/TD-65/u);
    expect(comment).toMatch(/HNSW/u);
    expect(comment, 'the old flat-only line count is gone').not.toMatch(/about 300 lines/u);
    expect(comment).toMatch(/1,050 lines/u);
  });

  it('has no dev-, build- or target-specific dependency tables either', () => {
    for (const l of lines) {
      expect(l.trim(), l).not.toMatch(/^\[(dev-|build-)?dependencies\./u);
      expect(l.trim(), l).not.toMatch(/^\[target\./u);
      expect(l.trim(), l).not.toMatch(/^\[(dev|build)-dependencies\]/u);
    }
  });

  it('the lockfile names the crate itself and nothing else', () => {
    const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
    const names = [...lock.matchAll(/^name = "([^"]+)"/gmu)].map((m) => m[1]);
    expect(names).toEqual(['ldvec']);
  });

  it('the line count the comment states is the size of src/hnsw.rs (to the nearest fifty)', () => {
    const hnsw = readFileSync(join(root, 'crates', 'ldvec', 'src', 'hnsw.rs'), 'utf8');
    const n = hnsw.split('\n').length - (hnsw.endsWith('\n') ? 1 : 0);
    expect(Math.abs(n - 1050)).toBeLessThanOrEqual(75);
  });
});
