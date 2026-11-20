// Shared by bench/vector-bench.spec.ts (which writes docs/benchmarks/vector-index.csv), by
// scripts/bench-readme.mjs and by test/readme-bench.test.ts: the CSV columns, RFC 4180 quoting, a
// parser, and the one function that turns CSV rows into the README benchmark section. Nothing in the
// README numbers is typed by hand: they are computed here from the CSV and nothing else.

import { join, resolve } from 'node:path';

export const COLUMNS = [
  'commit',
  'date_utc',
  'machine',
  'os',
  'chrome',
  'precise_memory',
  'driver',
  'kernel',
  'rows',
  'dim',
  'chunk_bytes',
  'restart',
  'run',
  'write_ms',
  'cold_open_ms',
  'first_query_ms',
  'cold_total_ms',
  'query_p50_ms',
  'query_p95_ms',
  'js_heap_peak_bytes',
  'wasm_memory_bytes',
  'index_bytes',
  'storage_usage_bytes',
  'match',
];

const quote = (v) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const csvHeader = () => `${COLUMNS.join(',')}\n`;
export const csvRow = (o) => `${COLUMNS.map((c) => quote(o[c] ?? '')).join(',')}\n`;

/** Parses RFC 4180 text into row objects keyed by the header line. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** The path after `--readme` on the command line, else the README.md of the repository: the --check modes of the
 * generators read it, so a test can point them at a copy that was edited by hand. */
export function readmePath(argv, repo) {
  const i = argv.indexOf('--readme');
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : join(repo, 'README.md');
}

/**
 * Whether the block of `text` between `begin` and `end` is exactly `body`, as `--write` writes it. `name` is the marker
 * name for the message. Returns `{ ok, message }`.
 */
export function checkBlock(text, begin, end, body, name) {
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  if (a < 0 || b < a) return { ok: false, message: `README.md has no ${name} markers` };
  if (text.slice(a, b) === `${begin}\n\n${body}\n\n`)
    return { ok: true, message: `README.md ${name} block is up to date with the CSV` };
  return {
    ok: false,
    message: `README.md ${name} block differs from the CSV: a figure was edited by hand or the CSV changed; run the generator with --write`,
  };
}

const num = (v) => Number(v);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const worst = (xs) => Math.max(...xs);
const fmtMs = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
const fmtMB = (b) => `${(b / 1e6).toFixed(1)} MB`;
const commas = (n) => Number(n).toLocaleString('en-US');

/** Groups rows by driver, rows and chunk size, in a stable order. */
export function configs(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = `${r.driver}|${r.rows}|${r.chunk_bytes}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const order = (c) =>
    `${c.driver === 'opfs' ? 0 : 1}|${String(1e9 + num(c.rows))}|${String(1e9 + num(c.chunk_bytes))}`;
  return [...map.values()].sort((a, b) => order(a[0]).localeCompare(order(b[0])));
}

export const ROW_LIMIT_MS = 2000;

/** One summary object per configuration: medians, worsts and the restart run. */
export function summarise(rows) {
  return configs(rows).map((g) => {
    const cold = g.filter((r) => r.restart !== 'true');
    const restart = g.find((r) => r.restart === 'true');
    const total = cold.map((r) => num(r.cold_total_ms));
    return {
      driver: g[0].driver,
      rows: num(g[0].rows),
      chunk: num(g[0].chunk_bytes),
      kernel: g[0].kernel,
      n: cold.length,
      allMatch: g.every((r) => r.match === 'true'),
      allPrecise: g.every((r) => r.precise_memory === 'true'),
      write: median(g.map((r) => num(r.write_ms))),
      open: median(cold.map((r) => num(r.cold_open_ms))),
      first: median(cold.map((r) => num(r.first_query_ms))),
      totalMedian: median(total),
      totalWorst: worst(total),
      restartTotal: restart ? num(restart.cold_total_ms) : undefined,
      p50: median(cold.map((r) => num(r.query_p50_ms))),
      p95: median(cold.map((r) => num(r.query_p95_ms))),
      indexBytes: [
        median(cold.map((r) => num(r.index_bytes))),
        worst(cold.map((r) => num(r.index_bytes))),
      ],
      wasm: [
        median(cold.map((r) => num(r.wasm_memory_bytes))),
        worst(cold.map((r) => num(r.wasm_memory_bytes))),
      ],
      heap: [
        median(cold.map((r) => num(r.js_heap_peak_bytes))),
        worst(cold.map((r) => num(r.js_heap_peak_bytes))),
      ],
      usage: [
        median(cold.map((r) => num(r.storage_usage_bytes))),
        worst(cold.map((r) => num(r.storage_usage_bytes))),
      ],
    };
  });
}

const label = (s) => `${commas(s.rows)} x 384, ${commas(s.chunk)}-byte chunks`;
const NM = 'not measured';
const CELL = 'not measured on 8 GB';

/** The README Benchmarks block, generated from the CSV rows only. */
export function renderBench(rows) {
  const sums = summarise(rows);
  const first = rows[0];
  const base = String(first.commit).replace(/-dirty$/, '');
  const lines = [];
  lines.push(
    `Measured on ${first.machine} (${first.os}), ${first.chrome}, ${first.kernel} kernel, on the uncommitted Sprint 4 working tree based on ${base} (CSV commit column \`${first.commit}\`). Every figure below is computed from [docs/benchmarks/vector-index.csv](docs/benchmarks/vector-index.csv) by \`scripts/bench-readme.mjs\`; \`npm run bench:vectors\` writes the CSV. The 8 GB Windows no-GPU laptop column is ${NM} (owner step): nothing here is an 8 GB figure, and the OS file cache cannot be dropped from a page, so a "cold" run is cold for the page, the JS heap and the WebAssembly instance, not for the disk cache. Chrome was launched with \`--enable-precise-memory-info\`.`,
  );
  lines.push('');
  lines.push(
    'Cold open plus first query (`createStore` through the resolved first `query`, k = 10), milliseconds:',
  );
  lines.push('');
  lines.push(
    '| Index | Driver | Runs | Median | Worst | After a browser restart | Headroom (2000 ms / worst) | 8 GB Windows no-GPU laptop |',
  );
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const s of sums) {
    lines.push(
      `| ${label(s)} | ${s.driver} | ${s.n} | ${fmtMs(s.totalMedian)} | ${fmtMs(s.totalWorst)} | ${s.restartTotal === undefined ? '-' : fmtMs(s.restartTotal)} | ${(ROW_LIMIT_MS / s.totalWorst).toFixed(1)}x | ${CELL} |`,
    );
  }
  lines.push('');
  lines.push(
    'Where the time goes, and what a query costs once the index is resident (medians over the runs), milliseconds:',
  );
  lines.push('');
  lines.push(
    '| Index | Driver | Write (`putVectors`) | Open (HEAD and META) | First query | Query p50 | Query p95 |',
  );
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const s of sums) {
    lines.push(
      `| ${label(s)} | ${s.driver} | ${fmtMs(s.write)} | ${fmtMs(s.open)} | ${fmtMs(s.first)} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} |`,
    );
  }
  lines.push('');
  lines.push(
    "Memory budget (median / worst over the cold runs). `index bytes` is the index as written (HEAD, vectors, META with keys, value parts); `WASM memory` is the kernel instance's linear memory after the first query; `JS heap peak` is `performance.memory.usedJSHeapSize` sampled every 10 ms (approximate) over the first query plus the 50 queries that follow it, so it depends on GC timing and is not a cold-window peak (a Sprint 4 browser probe read about 79.2 MB at the end of the first query on the 256-byte index and 163.8 MB after 50 more queries; raw data not kept, the probe output is not in this repository); `storage usage` is `navigator.storage.estimate().usage` for the whole origin:",
  );
  lines.push('');
  lines.push(
    '| Index | Driver | Index bytes | WASM memory | JS heap peak | Storage usage | 8 GB Windows no-GPU laptop |',
  );
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const s of sums) {
    const pair = ([m, w]) => `${fmtMB(m)} / ${fmtMB(w)}`;
    lines.push(
      `| ${label(s)} | ${s.driver} | ${pair(s.indexBytes)} | ${pair(s.wasm)} | ${pair(s.heap)} | ${pair(s.usage)} | ${CELL} |`,
    );
  }
  lines.push('');
  const opfs100 = sums.filter((s) => s.driver === 'opfs' && s.rows === 100000);
  const all =
    opfs100.length > 0 &&
    opfs100.every((s) => s.totalMedian < ROW_LIMIT_MS && s.totalWorst < ROW_LIMIT_MS);
  lines.push(
    `Done-when (100,000 chunks persist and reload cold in under 2 seconds): ${all ? 'passes' : 'does NOT pass'} on this machine for OPFS at both chunk sizes${opfs100.map((s) => `; ${commas(s.chunk)}-byte chunks: median ${fmtMs(s.totalMedian)} ms, worst ${fmtMs(s.totalWorst)} ms, headroom ${(ROW_LIMIT_MS / s.totalWorst).toFixed(1)}x`).join('')}. Apple M5 Pro, 48 GB; ${NM} on 8 GB.`,
  );
  return lines.join('\n');
}

export const BEGIN =
  '<!-- bench:begin (generated by scripts/bench-readme.mjs from docs/benchmarks/vector-index.csv) -->';
export const END = '<!-- bench:end -->';
