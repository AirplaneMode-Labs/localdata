#!/usr/bin/env node
// Owner decision, 20 Nov 2026: every benchmark figure quoted anywhere is backed by a raw file committed under
// docs/benchmarks/, and the folder has an index (docs/benchmarks/README.md). This module is that rule as code, shared by
// test/benchmarks-index.test.ts and by this script:
//
//   node scripts/bench-figures.mjs            check everything, print the problems, exit 1 if there are any
//   node scripts/bench-figures.mjs --map      print which committed row each quoted figure comes from
//
// What is checked:
//   1. the index: every file of docs/benchmarks/ is listed with a status, a date, a commit and a machine that match the
//      file's own columns, and has what / method / reproduce / quoted-in lines; every reproduce command is real (an npm
//      script, a script of this repository or a cargo test that exists) and names a writer that mentions the file; the
//      standing line "nothing is measured on an 8 GB laptop" is present; the files named in the documents exist.
//   2. the figures: every measured figure the prose of README.md (outside its generated blocks), CHANGELOG.md, docs/*.md,
//      the demo page and the generators' own text quotes (a time, a size, a "N of M" count, a recall, a ratio or a
//      percentage) is the output of one of the REGISTER entries below, which compute it from the committed rows, or is a
//      stated floor, a stated constant, arithmetic on stated inputs, or marked "raw data not kept" beside it and listed
//      in the index. A figure that is none of these fails: that is how a figure with no committed row is caught.
//   The README blocks between the bench markers are generated from the CSVs and compared with them by
//   test/readme-*.test.ts and by the --check modes of the generator scripts; they are not scanned here.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsv } from './bench-csv.mjs';
import { deleteCostPhrases } from './bench-delete-cost.mjs';

export { parseCsv };

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NOT_KEPT = 'raw data not kept';
export const STANDING_LINE = 'Nothing in this folder was measured on an 8 GB laptop';
export const INDEX_STATUSES = ['current', 'historical baseline'];

const README = 'README.md';
const INDEX = 'docs/benchmarks/README.md';
const CHANGELOG = 'CHANGELOG.md';
const DEMO = 'demo/index.html';
const WRITEUP = 'docs/writeup-0.4.0-alpha.1-draft.md';
const VECTOR_DESIGN = 'docs/vector-index.md';
const HNSW_FORMAT = 'docs/hnsw-format.md';
const GENERATORS = [
  'scripts/bench-csv.mjs',
  'scripts/bench-docs-csv.mjs',
  'scripts/bench-ann-readme.mjs',
  'scripts/bench-delete-cost.mjs',
];
const FIXED_SCOPE = [
  README,
  CHANGELOG,
  DEMO,
  'demo/app.ts',
  'docs/benchmarks/README.md',
  ...GENERATORS,
];

// ---- loading ---------------------------------------------------------------------------------------------------

/** Everything the checks read, from a checkout at `root`: texts of the scope, the CSVs and notes, and a few sources. */
export function loadInputs(root = repoRoot) {
  const read = (...p) => readFileSync(join(root, ...p), 'utf8');
  const bench = join(root, 'docs', 'benchmarks');
  const files = existsSync(bench) ? readdirSync(bench).sort() : [];
  const texts = {};
  const scope = [
    ...FIXED_SCOPE,
    ...readdirSync(join(root, 'docs'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => `docs/${n}`),
  ];
  for (const rel of new Set(scope))
    if (existsSync(join(root, rel))) texts[rel] = read(...rel.split('/'));
  const csv = {};
  const sizes = {};
  for (const f of files) {
    sizes[f] = readFileSync(join(bench, f)).length;
    if (f.endsWith('.csv')) csv[f] = parseCsv(read('docs', 'benchmarks', f));
  }
  const rustTests = {};
  const rustDir = join(root, 'crates', 'ldvec', 'tests');
  for (const f of readdirSync(rustDir).filter((n) => n.endsWith('.rs')))
    rustTests[f] = readFileSync(join(rustDir, f), 'utf8');
  const sources = {};
  for (const dir of ['bench', 'scripts'])
    for (const f of readdirSync(join(root, dir)).filter((n) => /\.(ts|mjs)$/.test(n)))
      sources[`${dir}/${f}`] = read(dir, f);
  return {
    root,
    files,
    sizes,
    texts,
    csv,
    notes: existsSync(join(bench, 'ann-notes.json'))
      ? JSON.parse(read('docs', 'benchmarks', 'ann-notes.json'))
      : {},
    rustTests,
    sources,
    pkg: JSON.parse(read('package.json')),
  };
}

// ---- prose and figure tokens -----------------------------------------------------------------------------------

const GENERATED = /<!-- (?:bench|docs-bench|ann-bench|ann-dup-bench):begin[\s\S]*?:end -->/g;

const flat = (t) => t.replace(/`/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

/** The text a figure scan reads for `rel`: no generated README blocks, no code fences, no markup, one line. */
export function prose(rel, text) {
  let t = text;
  if (rel.endsWith('.html')) {
    t = t
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  } else if (rel.endsWith('.md')) {
    t = t.replace(GENERATED, ' ').replace(/```[\s\S]*?```/g, ' ');
  }
  return flat(t);
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
/** One alternation, longest shape first, so "92, 88 and 78 of 100" is one token and not "78 of 100". */
const FIGURE = new RegExp(
  [
    String.raw`(?<![\w.])\d+(?:, \d+)+,? and \d+ of \d+(?!\w|\.\d)`, // 92, 88 and 78 of 100
    String.raw`(?<![\w.])\d+(?:, \d+)+,? and \d+ at ef \d+(?!\w|\.\d)`, // 99, 92 and 93 at ef 512
    String.raw`(?<![\w.])\d+ to \d+ of \d+(?!\w|\.\d)`, // 91 to 98 of 100
    String.raw`(?<![\w.])\d+ of \d+(?!\w|\.\d)`, // 200 of 200
    String.raw`(?<![\w.])${NUM} to ${NUM} (?:ms|s|seconds|hours|minutes)\b`, // 70 to 90 ms
    String.raw`(?<![\w.])${NUM} ?(?:ms|seconds?|hours|minutes|MB|GB|KB)\b`, // 22.80 ms, 11.7 MB
    String.raw`(?<![\w.-])${NUM} s\b`, // 50 s
    String.raw`(?<![\w.])\d+\.\d+x\b`, // 10.2x
    String.raw`(?<![\w.])\d+(?:\.\d+)?%`, // 89%
    String.raw`(?<![\w.])0\.\d{2,4}(?!\w|\.\d)`, // 0.9965
  ].join('|'),
  'g',
);
/** The machines are named by their memory ("Apple M5 Pro, 48 GB", "an 8 GB laptop"): labels, not figures. */
const LABEL = /^(?:8|48) GB$/;

/** The figure tokens of a prose string with their positions, in order. */
export function figureTokens(text, { decimals = true } = {}) {
  return [...text.matchAll(FIGURE)]
    .filter((m) => !LABEL.test(m[0]) && (decimals || !/^0\.\d+$/.test(m[0])))
    .map((m) => ({ token: m[0], start: m.index, end: m.index + m[0].length }));
}

// ---- computing figures from committed rows ---------------------------------------------------------------------

const where = (rows, w) => {
  const r = rows.filter((x) => Object.entries(w).every(([k, v]) => x[k] === String(v)));
  if (r.length === 0) throw new Error(`no row with ${JSON.stringify(w)}`);
  return r;
};
const one = (rows, w) => where(rows, w)[0];
const nums = (rows, c) => rows.map((r) => Number(r[c]));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sec = (ms, d) => `${(ms / 1000).toFixed(d)} s`;
const mb = (bytes, d) => `${(bytes / 1e6).toFixed(d)} MB`;
const msec = (v, d) => `${v.toFixed(d)} ms`;
const eq = (r) => Number(r.graph_alone_equal_to_flat.split('/')[0]);
const recall = (v) => String(Number(v));
const list = (xs) => `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
const unique = (xs) => [...new Set(xs)];

/**
 * The quoted figures. Each entry: where it is quoted (`docs`), the text that quotes it (`tokens`, computed from the
 * committed rows and never typed here), exact phrases that must also appear (`phrases`), and statements of the
 * documents that the rows must bear out (`checks`: [description, boolean]).
 */
export function register(d) {
  const ann = d.csv['ann.csv'];
  const s6 = d.csv['ann-s6-format-v1.csv'];
  const dup = d.csv['ann-duplicates.csv'];
  const near = d.csv['ann-near-duplicates.csv'];
  const scale = d.csv['ann-scale-duplicates-native.csv'];
  const del = d.csv['delete-cost.csv'];
  const vec = d.csv['vector-index.csv'];
  const wasm = d.csv['wasm-size.csv'];
  const clAll = (rows, kind, n) => where(rows, { data: 'clustered', index_kind: kind, rows: n });
  /** The median over the runs of one column of a clustered configuration (what the README tables print). */
  const cm = (rows, kind, n, ef, col) =>
    median(
      nums(
        where(rows, {
          data: 'clustered',
          index_kind: kind,
          rows: n,
          ...(ef === undefined ? {} : { ef_search: ef }),
        }),
        col,
      ),
    );
  const dupRow = (copies, ef) => one(dup, { copies_per_vector: copies, ef_search: ef });
  const of = (r) => `${r.queries_equal_to_flat} of ${r.queries}`;
  const jitter = (sigma, ef) => one(near, { family: 'jitter', seed_or_sigma: sigma, ef });
  const noise = (dim, tag) => one(near, { family: 'noise', dim, seed_or_sigma: tag });
  const t2 = near.filter((r) => r.family === 't2-gap' || r.family === 't2-unique');
  const t2dim384 = t2.filter((r) => r.dim === '384');
  const noise384 = ['ulp256', 'ulp1024', 'rel1e-5', 'rel1e-4'].map((t) => noise(384, t));
  const noise32 = ['ulp256', 'ulp1024', 'rel1e-5'].map((t) => noise(32, t));
  const sigmas = ['1e-4', '1e-3', '1e-2'];
  const delPhrases = deleteCostPhrases(del);
  const scaleAt = (copies, ef) => one(scale, { copies_per_vector: copies, ef });
  const loads = [...nums(ann, 'host_load_1m_start'), ...nums(ann, 'host_load_1m_end')];
  const flat100k = nums(
    where(ann, { data: 'clustered', index_kind: 'flat', rows: 100000 }),
    'build_ms',
  );
  const slow = Math.max(...flat100k);
  const fast = flat100k.filter((x) => x !== slow);
  const bigGraph = (rows) => nums(clAll(rows, 'hnsw', 1000000), 'ann_bytes')[0];
  const opfs100k = where(vec, { driver: 'opfs', rows: 100000, chunk_bytes: 256, restart: 'false' });
  const wasmMb = median(nums(opfs100k, 'wasm_memory_bytes')) / 1e6;
  const textBytes = (() => {
    const r = one(vec, { driver: 'opfs', rows: 100000, chunk_bytes: 2048, restart: 'false' });
    return (Number(r.rows) * Number(r.chunk_bytes)) / 1e6;
  })();
  const sig2 = (x) => Number(x.toPrecision(2));

  return [
    {
      id: 'duplicates-30-copies',
      source: 'ann-duplicates.csv, 30 copies per vector (ef 32, 64, 128)',
      docs: [README, DEMO, WRITEUP],
      tokens: [
        of(dupRow(30, 64)),
        sec(Number(dupRow(30, 64).build_ms), 0),
        sec(Number(dupRow(30, 64).build_ms), 1),
        mb(Number(dupRow(30, 64).ann_bytes), 1),
        of(dupRow(30, 32)),
        of(dupRow(30, 128)),
      ],
    },
    {
      id: 'duplicates-60-copies',
      source: 'ann-duplicates.csv, 60 copies per vector (answered by the flat scan)',
      docs: [WRITEUP],
      tokens: [of(dupRow(60, 64)), msec(Number(dupRow(60, 64).query_p50_ms), 1)],
      checks: [
        [
          'at 60 copies every query is answered by the flat scan',
          Number(dupRow(60, 64).answered_by_flat_duplicates) === Number(dupRow(60, 64).queries),
        ],
      ],
    },
    {
      id: 'format-v2-against-v1-100k',
      source:
        'ann.csv against ann-s6-format-v1.csv, clustered 100,000 x 384, HNSW (medians of three runs)',
      docs: [WRITEUP],
      tokens: [
        mb(median(nums(clAll(s6, 'hnsw', 100000), 'ann_bytes')), 1),
        mb(median(nums(clAll(ann, 'hnsw', 100000), 'ann_bytes')), 1),
        sec(median(nums(clAll(s6, 'hnsw', 100000), 'build_ms')), 1),
        sec(median(nums(clAll(ann, 'hnsw', 100000), 'build_ms')), 1),
        recall(cm(s6, 'hnsw', 100000, 32, 'recall_at_10')),
        recall(cm(ann, 'hnsw', 100000, 32, 'recall_at_10')),
        msec(cm(ann, 'hnsw', 100000, 64, 'query_p50_ms'), 1),
        msec(cm(ann, 'flat', 100000, undefined, 'query_p50_ms'), 1),
      ],
    },
    {
      id: 'format-v2-against-v1-1m',
      source:
        'ann.csv against ann-s6-format-v1.csv, clustered 1,000,000 x 384, HNSW (one run each)',
      docs: [WRITEUP],
      tokens: [
        mb(bigGraph(s6), 1),
        mb(bigGraph(ann), 1),
        sec(cm(s6, 'hnsw', 1000000, 32, 'build_ms'), 0),
        sec(cm(ann, 'hnsw', 1000000, 32, 'build_ms'), 0),
        recall(cm(s6, 'hnsw', 1000000, 32, 'recall_at_10')),
        recall(cm(s6, 'hnsw', 1000000, 64, 'recall_at_10')),
        recall(cm(ann, 'hnsw', 1000000, 32, 'recall_at_10')),
        recall(cm(ann, 'hnsw', 1000000, 64, 'recall_at_10')),
        `${(cm(ann, 'hnsw', 1000000, 32, 'wasm_memory_bytes') / 1e9).toFixed(1)} GB`,
      ],
    },
    {
      id: 'host-load-and-flat-write',
      source:
        'ann.csv host_load_1m_start and host_load_1m_end; the flat 100,000 write_ms of the three runs',
      docs: [WRITEUP],
      tokens: [sec(slow, 1), sec(Math.min(...fast), 0)],
      phrases: [
        `read from ${Math.min(...loads).toFixed(2)} to ${Math.round(Math.max(...loads))} during the run`,
      ],
      checks: [
        [
          'the other two flat writes both round to one second',
          fast.every((x) => sec(x, 0) === '1 s'),
        ],
      ],
    },
    {
      id: 'delete-cost',
      source:
        "delete-cost.csv, median over the runs of each run's p50 (scripts/bench-delete-cost.mjs)",
      docs: [README, CHANGELOG, VECTOR_DESIGN],
      tokens: [
        msec(delPhrases.graph100k, 2),
        msec(delPhrases.flat100k, 2),
        msec(delPhrases.graph20k, 2),
        msec(delPhrases.flat20k, 2),
        delPhrases.million.replace(/^about /, ''),
      ],
    },
    {
      id: 'near-duplicate-sets-before-the-rule',
      source: 'ann-near-duplicates.csv, rows t2-gap and t2-unique (graph alone, ef 64)',
      docs: [README, CHANGELOG, VECTOR_DESIGN, HNSW_FORMAT],
      tokens: [
        `${Math.min(...t2dim384.map(eq))} to ${Math.max(...t2dim384.map(eq))} of 100`,
        `${Math.min(...t2.map(eq))} to ${Math.max(...t2.map(eq))} of 100`,
      ],
    },
    {
      id: 'jitter-rows',
      source: 'ann-near-duplicates.csv, rows jitter (30 groups of 500 at dim 384)',
      docs: [README, CHANGELOG, VECTOR_DESIGN, WRITEUP],
      tokens: [
        `${list(sigmas.map((s) => eq(jitter(s, 64))))} of 100`,
        `${list(sigmas.map((s) => eq(jitter(s, 512))))} at ef 512`,
        `${eq(jitter('1e-5', 64))} of 100`,
      ],
      checks: [
        [
          'a spread of 1e-5 and 1e-6 gave the same count on that one set',
          eq(jitter('1e-5', 64)) === eq(jitter('1e-6', 64)),
        ],
        ['a spread of 1e-7 made the rule fire', jitter('1e-7', 64).degenerate === 'true'],
        [
          'the rule did not fire at 1e-4, 1e-3 and 1e-2',
          sigmas.every((s) => jitter(s, 64).degenerate === 'false'),
        ],
      ],
    },
    {
      id: 'noise-rows',
      source: 'ann-near-duplicates.csv, rows noise (30 groups of 500, ef 64)',
      docs: [README, CHANGELOG, DEMO, VECTOR_DESIGN, HNSW_FORMAT, WRITEUP],
      tokens: [
        `${list(noise384.map(eq))} of 100`,
        `${Math.min(...noise384.map(eq))} to ${Math.max(...noise384.map(eq))} of 100`,
        `${list(noise32.map(eq))} of 100`,
        `${eq(noise(32, 'rel1e-4'))} of 100`,
      ],
      phrases: [
        `near_max ${Math.min(...noise384.map((r) => Number(r.near_max)))} to ${Math.max(...noise384.map((r) => Number(r.near_max)))}`,
      ],
      checks: [
        ['no dim-384 noise row was detected', noise384.every((r) => r.degenerate === 'false')],
        [
          'the first three dim-32 noise rows were detected and relative 1e-4 was not',
          noise32.every((r) => r.degenerate === 'true') &&
            noise(32, 'rel1e-4').degenerate === 'false',
        ],
      ],
    },
    {
      id: 'scale-native',
      source: 'ann-scale-duplicates-native.csv, the bench set at 30 and 60 copies (graph alone)',
      docs: [README, WRITEUP],
      tokens: [
        `${Number(scaleAt(60, 64).queries) - eq(scaleAt(60, 64))} of ${scaleAt(60, 64).queries}`,
      ],
      checks: [
        [
          'with 60 copies the graph missed the same number of queries at every ef',
          unique([32, 64, 128].map((ef) => eq(scaleAt(60, ef)))).length === 1,
        ],
        [
          'with 30 copies it missed none at ef 64 and 128',
          [64, 128].every((ef) => eq(scaleAt(30, ef)) === Number(scaleAt(30, ef).queries)),
        ],
        [
          '30 copies are not degenerate and 60 are (the rule applied natively)',
          scaleAt(30, 64).degenerate === 'false' && scaleAt(60, 64).degenerate === 'true',
        ],
      ],
    },
    {
      id: 'wasm-budget',
      source: 'wasm-size.csv, budget_bytes (both modules recorded within it)',
      docs: [CHANGELOG, VECTOR_DESIGN, INDEX],
      tokens: [`${Number(wasm[0].budget_bytes) / 1024} KB`],
      checks: [
        ['both modules are within the budget', wasm.every((r) => r.within_budget === 'true')],
      ],
    },
    {
      id: 'wasm-memory-approximate',
      source:
        'vector-index.csv, wasm_memory_bytes of the OPFS 100,000 x 384 rows, to the nearest 10 MB',
      docs: [README],
      tokens: [`${Math.round(wasmMb / 10) * 10} MB`],
    },
    {
      id: 'graph-record-approximate',
      source: 'ann.csv, ann_bytes of the clustered 100,000 x 384 HNSW rows, to the nearest MB',
      docs: [README, VECTOR_DESIGN],
      tokens: [mb(median(nums(clAll(ann, 'hnsw', 100000), 'ann_bytes')), 0)],
    },
    {
      id: 'arithmetic-chunk-text',
      source:
        'arithmetic on vector-index.csv columns: rows x chunk_bytes of the 100,000 x 2,048-byte index, two significant figures',
      docs: [VECTOR_DESIGN],
      tokens: [`${sig2(textBytes)} MB`],
    },
    {
      id: 'arithmetic-forged-header',
      source:
        'arithmetic on the forged header of crates/ldvec/tests/hnsw_header.rs: 1,000,000 nodes x (2 x 64 + 1) words x 4 bytes',
      docs: [CHANGELOG, WRITEUP, HNSW_FORMAT],
      tokens: [`${(1_000_000 * (2 * 64 + 1) * 4) / 1e6} MB`],
    },
  ];
}

/** Statements about the code that the prose leans on: [description, file, pattern]. */
export const SOURCE_NEEDLES = [
  ['the floor of 99 of 100 queries', 'hnsw_dup.rs', /const MIN_EQUAL_QUERIES: usize = 99;/],
  ['the floor of 0.99 mean recall', 'hnsw_dup.rs', /const MIN_MEAN_RECALL: f64 = 0\.99;/],
  ['the floor of 0.95 at 10,000 x 384', 'hnsw.rs', /const RECALL_FLOOR_10K: f64 = 0\.95;/],
  ['the forged header reserved 516 MB for layer 0', 'hnsw_header.rs', /516 MB for layer 0/],
  [
    'the forged header says m = 64 over a stored m = 16 with a million declared rows',
    'hnsw_header.rs',
    /m = 64 with a declared 1,000,000 rows/,
  ],
];

/** Wordings that are stated floors (asserted by the sources above), not measurements. */
export const FLOORS = [
  { pattern: /at least 99 of 100/g, reason: 'the floor of hnsw_dup.rs, stated before measuring' },
  { pattern: /at least 0\.99/g, reason: 'the floor of hnsw_dup.rs, stated before measuring' },
  {
    pattern: /at least 0\.90/g,
    reason: 'the recall target of bench/ann-bench.spec.ts, stated before measuring',
  },
  {
    pattern: /floors? \(?0\.95/g,
    reason: 'the floor of crates/ldvec/tests/hnsw.rs and test/ann.test.ts',
  },
  {
    pattern: /\(0\.95 at m 16/g,
    reason: 'the floor of crates/ldvec/tests/hnsw.rs and test/ann.test.ts',
  },
];

/** Numbers that are settings of a tool or a rule of this repository, not measurements. */
export const CONSTANTS = [
  {
    pattern: /(?:under|over) 5 MB/g,
    reason: 'the packaging and input size rule (scripts/pack-check.mjs, CONTRIBUTING.md)',
  },
  { pattern: /every 2 s/g, reason: "the demo's refresh interval for navigator.storage" },
  { pattern: /every 10 ms/g, reason: 'the JS heap sampling interval of the bench specs' },
  {
    pattern: /Headroom \(2000 ms \/ worst\)/g,
    reason: 'the done-when of the plan: 100,000 chunks persist and reload cold in under 2 seconds',
  },
  {
    pattern: /under 2 seconds/g,
    reason: 'the done-when of the plan: 100,000 chunks persist and reload cold in under 2 seconds',
  },
  {
    pattern: /under 120 seconds/g,
    reason: 'the gate of bench/ann-bench.spec.ts before it attempts 1,000,000 rows',
  },
  {
    pattern: /under the 120 s gate/g,
    reason: 'the gate of bench/ann-bench.spec.ts before it attempts 1,000,000 rows',
  },
];

/**
 * Figures whose raw data is not kept: each is marked "raw data not kept" beside it in every document, and listed in the
 * index. `docs` are the files that quote it, The index is an implicit document of every entry.
 */
export const NOT_KEPT_FIGURES = [
  {
    id: 'second-counting-pass-cost',
    tokens: ['70 to 90 ms'],
    docs: [README],
    why: 'a native timing of the second counting pass taken once while fixing BUG-T2-S7-02; no committed script prints it',
  },
  {
    id: 'sprint-6-duplicate-reproduction',
    tokens: ['13 of 100', '33 of 350'],
    docs: [VECTOR_DESIGN, WRITEUP],
    why: 'measured against the Sprint 6 kernel, which is no longer in the tree (the current kernel does not show it)',
  },
  {
    id: 'top-sample',
    tokens: ['89%'],
    docs: [WRITEUP],
    why: 'one top sample taken by hand during the Sprint 7 latency run; not recorded',
  },
  {
    id: 'heap-probe',
    tokens: ['79.2 MB', '163.8 MB'],
    docs: [README, 'scripts/bench-csv.mjs'],
    why: 'a Sprint 4 browser probe of the JS heap during one cold query; its output was not committed and the probe is not in this repository',
  },
];

/** The documents that quote a not-kept figure: its own, and the index that lists it. */
const docsOf = (n) => [...n.docs, INDEX];
const around = (text, start, end, n = 400) =>
  text.slice(Math.max(0, start - n), Math.min(text.length, end + n));

// ---- the figure check ------------------------------------------------------------------------------------------

/** The problems with the quoted figures: an array of strings, empty when every figure is backed. */
export function checkFigures(d) {
  const problems = [];
  let reg;
  try {
    reg = register(d);
  } catch (e) {
    return [`the figure register could not be computed from the committed rows: ${e.message}`];
  }
  const prosed = Object.fromEntries(
    Object.entries(d.texts).map(([rel, t]) => [rel, prose(rel, t)]),
  );
  const raw = Object.fromEntries(Object.entries(d.texts).map(([rel, t]) => [rel, flat(t)]));

  // 0. the statements the register and the floors lean on
  for (const [what, file, pattern] of SOURCE_NEEDLES)
    if (!pattern.test(d.rustTests[file] ?? ''))
      problems.push(`source: ${what} is not in crates/ldvec/tests/${file}`);

  // 1. every entry: its checks hold, every token and phrase is quoted somewhere it lists, each of its docs exists
  const accepted = {};
  for (const e of reg) {
    for (const [what, ok] of e.checks ?? [])
      if (!ok) problems.push(`${e.id}: the committed rows do not bear out "${what}"`);
    for (const rel of e.docs) {
      if (prosed[rel] === undefined) {
        problems.push(`${e.id}: ${rel} is not in the scanned scope`);
        continue;
      }
      accepted[rel] ??= new Set();
      for (const t of e.tokens) accepted[rel].add(t);
    }
    for (const t of e.tokens)
      if (!e.docs.some((rel) => prosed[rel] !== undefined && prosed[rel].includes(t)))
        problems.push(
          `${e.id}: the figure "${t}" (from ${e.source}) is quoted in none of ${e.docs.join(', ')}`,
        );
    for (const ph of e.phrases ?? [])
      if (!e.docs.some((rel) => prosed[rel] !== undefined && prosed[rel].includes(ph)))
        problems.push(
          `${e.id}: the phrase "${ph}" (from ${e.source}) is quoted in none of ${e.docs.join(', ')}`,
        );
  }

  // 2. every figure token of every scanned file is a register output, a floor, a constant or marked not kept
  for (const [rel, text] of Object.entries(prosed)) {
    const covered = [];
    for (const { pattern } of [...FLOORS, ...CONSTANTS])
      for (const m of text.matchAll(new RegExp(pattern.source, 'g')))
        covered.push([m.index, m.index + m[0].length]);
    for (const { token, start, end } of figureTokens(text, { decimals: !rel.endsWith('.ts') })) {
      if (accepted[rel]?.has(token)) continue;
      if (covered.some(([a, b]) => a <= start && end <= b)) continue;
      const kept = NOT_KEPT_FIGURES.find(
        (n) => docsOf(n).includes(rel) && n.tokens.includes(token),
      );
      if (kept !== undefined) {
        if (!around(text, start, end).includes(NOT_KEPT))
          problems.push(
            `${rel}: "${token}" has no committed row and is not marked "${NOT_KEPT}" beside it`,
          );
        continue;
      }
      problems.push(
        `${rel}: the figure "${token}" is not computed from any committed row (add the raw file and a register entry, or mark it "${NOT_KEPT}")`,
      );
    }
  }

  // 3. every not-kept figure is quoted where it says, and is marked beside every quote (generated blocks included)
  for (const n of NOT_KEPT_FIGURES)
    for (const rel of docsOf(n))
      for (const t of n.tokens) {
        const text = raw[rel];
        if (text === undefined) continue;
        const i = text.indexOf(t);
        if (i < 0)
          problems.push(
            `not kept: "${t}" is no longer quoted in ${rel} (remove ${n.id} from NOT_KEPT_FIGURES and from the index)`,
          );
        else if (!around(text, i, i + t.length).includes(NOT_KEPT))
          problems.push(`not kept: "${t}" in ${rel} is not marked "${NOT_KEPT}" beside it`);
      }

  // 4. no figure leans on a path outside this repository
  for (const [rel, text] of Object.entries(raw))
    for (const m of text.matchAll(/evidence\/sprint-\d+\/[A-Za-z0-9_./-]+/g)) {
      const hit = figureTokens(around(text, m.index, m.index + m[0].length, 250)).filter(
        ({ token }) => !/^0\.\d+$/.test(token),
      );
      if (hit.length > 0)
        problems.push(
          `${rel}: "${hit[0].token}" is quoted beside ${m[0]}, a path that is not in this repository`,
        );
    }
  return problems;
}

// ---- the index -------------------------------------------------------------------------------------------------

const rowsOf = (md) => md.split('\n').filter((l) => /^\|/.test(l) && !/^\|[ :|-]+\|?$/.test(l));
const cells = (line) =>
  line
    .replace(/^\||\|\s*$/g, '')
    .split('|')
    .map((c) => c.trim());
const stripTicks = (s) => s.replace(/`/g, '').replace(/^\[|\]\([^)]*\)$/g, '');

/** The index README parsed: `table` rows and the `sections` of the per-file lines. */
export function parseIndex(md) {
  const lines = rowsOf(md);
  const head = lines.findIndex((l) =>
    /^\|\s*File\s*\|\s*Status\s*\|\s*Date \(UTC\)\s*\|\s*Commit\s*\|\s*Machine\s*\|/.test(l),
  );
  const table =
    head < 0
      ? []
      : lines
          .slice(head + 1)
          .filter((l) => /^\|\s*\[?`/.test(l))
          .map((l) => {
            const [file, status, date, commit, machine] = cells(l).map(stripTicks);
            return { file, status, date, commit, machine };
          });
  const sections = {};
  for (const block of md.split(/^### /m).slice(1)) {
    const name = /^`([^`]+)`/.exec(block)?.[1];
    if (name === undefined) continue;
    const get = (k) =>
      new RegExp(`^- ${k}: (.+(?:\\n  .+)*)`, 'm').exec(block)?.[1]?.replace(/\s+/g, ' ');
    sections[name] = {
      what: get('What'),
      method: get('Method'),
      reproduce: get('Reproduce'),
      quotedIn: get('Quoted in'),
    };
  }
  const notKept = (() => {
    const i = md.indexOf('## Figures with no raw data');
    if (i < 0) return undefined;
    const rest = md.slice(i + 1);
    const j = rest.indexOf('\n## ');
    return flat(j < 0 ? rest : rest.slice(0, j));
  })();
  return {
    table,
    sections,
    notKept,
    standing: md.includes(STANDING_LINE),
    eightGb: md.includes('not measured on 8 GB'),
  };
}

const dayOf = (iso) => /^\d{4}-\d\d-\d\d/.exec(iso ?? '')?.[0];

/** The problems with the index of docs/benchmarks/README.md against the folder and the repository. */
export function checkIndex(d) {
  const problems = [];
  const md = d.texts['docs/benchmarks/README.md'];
  if (md === undefined) return ['docs/benchmarks/README.md does not exist'];
  const idx = parseIndex(md);
  if (!idx.standing) problems.push(`the index lacks the standing line "${STANDING_LINE}"`);
  if (!idx.eightGb) problems.push('the index never says "not measured on 8 GB"');
  const data = d.files.filter((f) => f !== 'README.md');
  const listed = idx.table.map((r) => r.file);
  for (const f of data)
    if (!listed.includes(f))
      problems.push(`${f} is in docs/benchmarks/ but not in the index table`);
  for (const f of listed)
    if (!data.includes(f)) problems.push(`the index lists ${f}, which is not in docs/benchmarks/`);
  for (const f of d.files) {
    if ((d.sizes?.[f] ?? 0) > 5 * 1024 * 1024) problems.push(`${f} is over 5 MB`);
  }
  for (const r of idx.table) {
    const rows = d.csv[r.file];
    if (!INDEX_STATUSES.includes(r.status))
      problems.push(`${r.file}: status "${r.status}" is not one of ${INDEX_STATUSES.join(', ')}`);
    const sec = idx.sections[r.file];
    for (const k of ['what', 'method', 'reproduce', 'quotedIn'])
      if (!sec?.[k]) problems.push(`${r.file}: the index has no "${k}" line`);
    if (/^same run as /.test(r.date)) {
      const other = /^same run as (\S+)/.exec(r.date)?.[1];
      const o = idx.table.find((x) => x.file === other);
      if (o === undefined)
        problems.push(`${r.file}: "same run as ${other}" names a file that is not in the table`);
      else if (o.status !== r.status)
        problems.push(`${r.file}: its status differs from ${other}'s`);
    } else if (rows !== undefined) {
      const dates = rows
        .map((x) => dayOf(x.date_utc))
        .filter(Boolean)
        .sort();
      const commits = unique(rows.map((x) => x.commit));
      const machines = unique(rows.map((x) => x.machine));
      const want = dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} to ${dates.at(-1)}`;
      if (r.date !== want)
        problems.push(`${r.file}: the index says ${r.date}, the rows say ${want}`);
      if (r.commit !== commits.join(', '))
        problems.push(
          `${r.file}: the index says commit ${r.commit}, the rows say ${commits.join(', ')}`,
        );
      if (r.machine !== machines.join(', '))
        problems.push(
          `${r.file}: the index says machine ${r.machine}, the rows say ${machines.join(' / ')}`,
        );
      if (machines.some((m) => !/^.+, \d+ GB$/.test(m)))
        problems.push(`${r.file}: a machine cell is not "<model>, <RAM> GB"`);
      if (rows.length === 0) problems.push(`${r.file} has no rows`);
      const cmds = unique(rows.map((x) => x.command).filter(Boolean));
      for (const c of cmds)
        if (!sec?.reproduce?.includes(c))
          problems.push(`${r.file}: the rows' command "${c}" is not in the index's Reproduce line`);
    }
    // the reproduce commands are real, and a writer in this repository names the file
    const cmds = [...(sec?.reproduce ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const real = [];
    for (const c of cmds) {
      const npm = /(?:^|\s)npm run ([\w:-]+)/.exec(c)?.[1];
      const script = /node (scripts\/[\w./-]+\.mjs)/.exec(c)?.[1];
      const cargo = /cargo test .*--test (\w+) (\w+)/.exec(c);
      if (npm !== undefined) {
        if (d.pkg.scripts?.[npm] === undefined)
          problems.push(`${r.file}: "npm run ${npm}" is not a script of package.json`);
        else real.push(npm);
      } else if (script !== undefined) {
        if (d.sources[script] === undefined) problems.push(`${r.file}: ${script} does not exist`);
        else real.push(script);
      } else if (cargo !== null) {
        const src = d.rustTests[`${cargo[1]}.rs`];
        if (src === undefined || !new RegExp(`fn ${cargo[2]}\\b`).test(src))
          problems.push(`${r.file}: the cargo test ${cargo[1]} ${cargo[2]} does not exist`);
        else real.push(cargo[2]);
      }
    }
    if (!/cannot be reproduced/.test(sec?.reproduce ?? '')) {
      if (real.length === 0)
        problems.push(
          `${r.file}: the Reproduce line has no command that exists in this repository`,
        );
      const mentions = [
        ...Object.entries(d.sources).map(([k, t]) => [k, t]),
        ...Object.entries(d.rustTests).map(([k, t]) => [k, t]),
      ];
      if (!mentions.some(([, t]) => t.includes(r.file)))
        problems.push(
          `${r.file}: no script or test of this repository names this file, so no command can have written it`,
        );
    }
  }
  // not-kept figures: every one is in the index section, and the section names nothing else
  for (const n of NOT_KEPT_FIGURES)
    for (const t of n.tokens)
      if (!(idx.notKept ?? '').includes(t))
        problems.push(`the index has no "Figures with no raw data" entry for "${t}" (${n.id})`);
  if (idx.notKept === undefined)
    problems.push('the index has no "Figures with no raw data" section');
  // the documents name only files that exist
  for (const [rel, t] of Object.entries(d.texts))
    for (const m of t.matchAll(/docs\/benchmarks\/([A-Za-z0-9_.-]+\.(?:csv|json))/g))
      if (!d.files.includes(m[1]))
        problems.push(`${rel} names docs/benchmarks/${m[1]}, which does not exist`);
  return problems;
}

// ---- command line ----------------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const d = loadInputs();
  if (process.argv.includes('--map')) {
    for (const e of register(d))
      console.log(
        `${e.id}\n  from ${e.source}\n  quoted as ${e.tokens.join(' | ')}\n  in ${e.docs.join(', ')}`,
      );
    for (const n of NOT_KEPT_FIGURES)
      console.log(
        `${n.id}\n  ${NOT_KEPT}: ${n.tokens.join(' | ')}\n  in ${n.docs.join(', ')}\n  ${n.why}`,
      );
  } else {
    const problems = [...checkIndex(d), ...checkFigures(d)];
    for (const p of problems) console.error(`bench-figures: ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(
      `bench-figures: ok (${d.files.length} files in docs/benchmarks, ${register(d).length} figure groups)`,
    );
  }
}
