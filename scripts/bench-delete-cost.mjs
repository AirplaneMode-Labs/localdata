// The cost of one delete with and without a current HNSW graph (BUG-T2-S6-13): the CSV columns of
// docs/benchmarks/delete-cost.csv, RFC 4180 writing, and the phrases the README and docs/vector-index.md
// quote. Shared by bench/delete-cost.ts (which writes the CSV), by test/readme-delete-cost.test.ts and by
// this script. Nothing in the documents' figures is typed by hand: they are computed here from the CSV.
//
//   node scripts/bench-delete-cost.mjs    print the phrases the documents must contain
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsv } from './bench-csv.mjs';

export { parseCsv };

export const DELETE_COST_COLUMNS = [
  'commit',
  'date_utc',
  'machine',
  'os',
  'chrome',
  'command',
  'driver',
  'kernel',
  'rows',
  'dim',
  'with_graph',
  'm',
  'ef_construction',
  'seed',
  'deletes',
  'run',
  'ms_per_delete_p50',
  'ms_per_delete_p95',
  'graph_bytes',
  'eight_gb',
];

export const EIGHT_GB = 'not measured on 8 GB';

const quote = (v) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const deleteCostHeader = () => `${DELETE_COST_COLUMNS.join(',')}\n`;
export const deleteCostRow = (o) =>
  `${DELETE_COST_COLUMNS.map((c) => quote(o[c] ?? '')).join(',')}\n`;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Two decimals, as the documents print them. */
const ms = (x) => (Math.round(x * 100) / 100).toFixed(2);

/** The median over the runs of each run's p50, for one size and one kind of namespace. */
function cell(rows, size, withGraph) {
  const xs = rows
    .filter((r) => r.rows === String(size) && r.with_graph === String(withGraph))
    .map((r) => Number(r.ms_per_delete_p50));
  if (xs.length === 0)
    throw new Error(`delete-cost.csv has no row for ${size} rows, with_graph ${withGraph}`);
  return median(xs);
}

/**
 * The figures and the exact phrases the documents quote. `large` and `small` are "<graph> ms per delete against
 * <flat> ms" for 100,000 and 20,000 rows; `million` is the time a million single deletes at the large rate take.
 */
export function deleteCostPhrases(rows) {
  const graph100k = Math.round(cell(rows, 100000, true) * 100) / 100;
  const flat100k = Math.round(cell(rows, 100000, false) * 100) / 100;
  const graph20k = Math.round(cell(rows, 20000, true) * 100) / 100;
  const flat20k = Math.round(cell(rows, 20000, false) * 100) / 100;
  const hours = (1_000_000 * graph100k) / 3_600_000;
  const first = rows[0];
  return {
    graph100k,
    flat100k,
    graph20k,
    flat20k,
    large: `${ms(graph100k)} ms per delete against ${ms(flat100k)} ms`,
    small: `${ms(graph20k)} ms against ${ms(flat20k)} ms`,
    million: `about ${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} hours`,
    machine: first?.machine ?? '',
    os: first?.os ?? '',
    chrome: first?.chrome ?? '',
    commit: first?.commit ?? '',
    command: first?.command ?? '',
    deletes: first?.deletes ?? '',
    runs: Math.max(...rows.map((r) => Number(r.run))),
  };
}

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DELETE_COST_CSV = join(repoRoot, 'docs', 'benchmarks', 'delete-cost.csv');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = parseCsv(readFileSync(DELETE_COST_CSV, 'utf8'));
  if (rows.length === 0) throw new Error('docs/benchmarks/delete-cost.csv has no rows');
  const p = deleteCostPhrases(rows);
  console.log(
    [
      `machine: ${p.machine} (${p.os}), ${p.chrome}; commit ${p.commit}; command ${p.command}; ${p.deletes} deletes per cell, median of ${p.runs} runs`,
      `large:   ${p.large}`,
      `small:   ${p.small}`,
      `million: ${p.million}`,
    ].join('\n'),
  );
}
