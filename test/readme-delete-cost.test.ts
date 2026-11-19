// BUG-T2-S6-13 (fix round 2): the per-delete cost the README and docs/vector-index.md quote comes from a
// committed CSV, never from an internal evidence log. docs/benchmarks/delete-cost.csv is written by
// bench/delete-cost.ts (`npm run bench:delete-cost`); this test recomputes the figures from it and demands
// that the README Limitations and docs/vector-index.md section 6 contain exactly those figures, and pins
// what the CSV must carry on every row (machine, command, "not measured on 8 GB").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELETE_COST_COLUMNS,
  EIGHT_GB,
  deleteCostPhrases,
  parseCsv,
} from '../scripts/bench-delete-cost.mjs';

const root = join(import.meta.dirname, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const design = readFileSync(join(root, 'docs', 'vector-index.md'), 'utf8');
const csvText = readFileSync(join(root, 'docs', 'benchmarks', 'delete-cost.csv'), 'utf8');
const rows = parseCsv(csvText);

const flat = (t: string) => t.replace(/\s+/gu, ' ');

describe('docs/benchmarks/delete-cost.csv', () => {
  it('has the documented header and, per size, with-graph and flat-only rows for every run', () => {
    expect(csvText.split('\n')[0]).toBe(DELETE_COST_COLUMNS.join(','));
    for (const size of ['20000', '100000']) {
      for (const g of ['true', 'false']) {
        const cell = rows.filter((r) => r['rows'] === size && r['with_graph'] === g);
        expect(cell.length, `${size} rows, with_graph ${g}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('names the machine, the command and "not measured on 8 GB" on every row, at 32 dimensions', () => {
    for (const r of rows) {
      expect(r['machine'], 'machine').not.toBe('');
      expect(r['command'], 'command').toBe('npm run bench:delete-cost');
      expect(r['eight_gb']).toBe(EIGHT_GB);
      expect(r['dim']).toBe('32');
      expect(Number(r['ms_per_delete_p50'])).toBeGreaterThan(0);
      expect(Number(r['ms_per_delete_p95'])).toBeGreaterThanOrEqual(Number(r['ms_per_delete_p50']));
      expect(
        r['with_graph'] === 'true' ? Number(r['graph_bytes']) > 0 : r['graph_bytes'] === '0',
      ).toBe(true);
    }
  });

  it('shows what the README says: a delete with a current graph costs more than a flat-only delete', () => {
    const p = deleteCostPhrases(rows);
    expect(p.graph100k).toBeGreaterThan(p.flat100k);
    expect(p.graph20k).toBeGreaterThan(p.flat20k);
  });
});

describe.each([
  ['README Limitations', () => flat(readme)],
  ['docs/vector-index.md', () => flat(design)],
])('%s quotes the CSV', (_name, text) => {
  it('contains the figures computed from the CSV, the CSV path and the 8 GB wording', () => {
    const t = text();
    const p = deleteCostPhrases(rows);
    expect(t, 'the 100,000 x 32 figures').toContain(p.large);
    expect(t, 'the 20,000 x 32 figures').toContain(p.small);
    expect(t, 'the million-delete estimate').toContain(p.million);
    expect(t).toContain('docs/benchmarks/delete-cost.csv');
    expect(t).toContain('not measured on 8 GB');
  });
});
