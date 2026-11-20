// `npm run bench:ann`: flat against HNSW (Storage API 0.4.0) at 100,000 x 384 in installed Chrome on OPFS,
// recorded to docs/benchmarks/ann.csv (TD-76; the vector-index.csv columns are pinned by tests, so these
// rows have their own file).
//
//   clustered 100,000 x 384 (1,000 centres, the integer-only generator of bench/synth.ts), 200 queries:
//     per run: write the flat index (timed), build HNSW m 16 / efConstruction 200 / seed 1 (timed), then in a
//     fresh page the flat queries, and in another fresh page the HNSW queries at ef 32, 64 and 128 with the
//     recall@10 against the flat scan of the same store. 3 runs.
//   uniform 100,000 x 384 (the worst case for any graph index), the same, 1 run, no floor.
//   duplicates 100,000 x 384 clustered with every vector stored 30 times and 60 times (docs/benchmarks/ann-duplicates.csv,
//     Sprint 7, TD-109): HNSW at ef 32, 64 and 128, 1 run each; recall is counted by score because copies tie;
//   1,000,000 x 384 clustered (10,000 centres): attempted only if the 100,000 HNSW build took under 120 s,
//     time-boxed to 20 minutes, one run; whether it ran, and why not if it did not, is written to
//     docs/benchmarks/ann-notes.json and stated in the README.
//
// Nothing in the CSV is typed by hand: commit is `git describe --always --dirty`, machine comes from
// os.cpus() and os.totalmem(), Chrome's version comes from CDP, and the command is this script's own.
// The recall target (at least 0.90 at ef 128 on the 100,000 set) was stated before measuring and is
// reported as measured: this spec asserts only that every HNSW row was answered by the graph (no fallback)
// and that the graph was current, never a recall number.
//
// Environment (all optional):
//   LOCALDATA_ANN_BENCH_CSV     CSV path (default docs/benchmarks/ann.csv)
//   LOCALDATA_ANN_BENCH_NOTE    note path (default docs/benchmarks/ann-notes.json)
//   LOCALDATA_ANN_DUP_BENCH_CSV duplicates CSV path (default docs/benchmarks/ann-duplicates.csv)
//   LOCALDATA_ANN_BENCH_ROWS    rows of the "100k" sets (a dry run: 10000); the CSV then says so in `command`
//   LOCALDATA_ANN_BENCH_SKIP_1M set to skip the 1M attempt
//   LOCALDATA_BENCH_LOGS        a directory that receives raw.jsonl
//   LOCALDATA_PROFILE_DIR       Chrome profile root; unset, a mkdtemp directory named chrome-profile-ann-bench-*
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import {
  ANN_CSV as ANN_CSV_DEFAULT,
  ANN_DUP_CSV as ANN_DUP_CSV_DEFAULT,
  EIGHT_GB,
  annCsvHeader,
  annCsvRow,
  annDupCsvHeader,
  annDupCsvRow,
  hostLoadCell,
} from '../scripts/bench-ann-readme.mjs';
import { BASE_URL } from '../test/browser/playwright.config';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = process.env['LOCALDATA_ANN_BENCH_CSV'] ?? ANN_CSV_DEFAULT;
const DUP_CSV = process.env['LOCALDATA_ANN_DUP_BENCH_CSV'] ?? ANN_DUP_CSV_DEFAULT;
const NOTE =
  process.env['LOCALDATA_ANN_BENCH_NOTE'] ?? join(repo, 'docs', 'benchmarks', 'ann-notes.json');
const LOGS = process.env['LOCALDATA_BENCH_LOGS'];
const PROFILE_ROOT =
  process.env['LOCALDATA_PROFILE_DIR'] ??
  mkdtempSync(join(os.tmpdir(), 'chrome-profile-ann-bench-'));
const ROWS_100K = Number(process.env['LOCALDATA_ANN_BENCH_ROWS'] ?? 100_000);
const SKIP_1M = process.env['LOCALDATA_ANN_BENCH_SKIP_1M'] !== undefined;
const COMMAND = `${ROWS_100K !== 100_000 ? `LOCALDATA_ANN_BENCH_ROWS=${ROWS_100K} ` : ''}npm run bench:ann`;

const DIM = 384;
const K = 10;
const QUERIES = 200;
const EFS = [32, 64, 128];
const HNSW = { m: 16, efConstruction: 200, seed: 1 };
const GATE_1M_MS = 120_000;
// Sprint 7 (TD-124): the 1M row is re-run only if it finishes within 20 minutes.
const TIMEBOX_1M_MS = 20 * 60_000;
// Sprint 7 (TD-109): every vector stored 30 times (a group within 2m = 32: the graph answers) and 60 times (more than
// 2m: the graph is degenerate and the exact flat scan answers, fallback 'duplicates').
const DUP_COPIES_LIST = [30, 60];
const LAUNCH_ARGS = ['--enable-precise-memory-info'];

interface Cfg {
  label: string;
  data: 'clustered' | 'uniform';
  rows: number;
  centres: number;
  seed: number;
  runs: number;
  maxIndexBytes: number;
}

const git = (...a: string[]) =>
  execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const cpus = os.cpus();
const machine = `${cpus[0]?.model ?? 'unknown cpu'}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
const osName = `${os.platform()} ${os.arch()} ${os.release()}`;
const round = (x: number) => Math.round(x * 100) / 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { channel: 'chrome', args: LAUNCH_ARGS });
}

async function openPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('body[data-ready="1"]');
  return page;
}

/** Chrome's version from CDP, and whether precise memory info is really on (as bench/vector-bench.spec.ts). */
async function browserFacts(ctx: BrowserContext, page: Page) {
  const cdp = await ctx.newCDPSession(page);
  const version = (await cdp.send('Browser.getVersion')) as { product: string };
  await cdp.detach();
  const unquantised = await page.evaluate(() => {
    const keep: unknown[] = [];
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      keep.push(new Array(1000 + i * 37).fill(i));
      seen.push(
        (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize,
      );
    }
    return seen.some((v) => v % 1000 !== 0) && keep.length === 40;
  });
  return { chrome: version.product, precise: unquantised };
}

function profileFor(label: string): string {
  const dir = join(PROFILE_ROOT, label);
  if (basename(PROFILE_ROOT).startsWith('chrome-profile'))
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cfgOf = (c: Cfg) => ({
  data: c.data,
  rows: c.rows,
  dim: DIM,
  centres: c.centres,
  seed: c.seed,
});

/** One run: build in one page, then flat and HNSW in fresh pages. Appends the CSV rows; returns the build ms. */
async function oneRun(
  cfg: Cfg,
  run: number,
  ctx: BrowserContext,
  commit: string,
  facts: { chrome: string; precise: boolean },
): Promise<{ buildMs: number; flatWriteMs: number }> {
  // The 1-minute load average before the run and after it (quiet slot Q2, TD-124); every row of the run carries
  // both. '' on Windows, where the figure does not exist.
  const loadStart = os.loadavg()[0] ?? Number.NaN;
  const pending: Array<Record<string, unknown>> = [];
  const page = await openPage(ctx);
  const built = await page.evaluate(
    ([data, hnsw, max]) => window.__localdata.annBenchBuild('opfs', data, hnsw, max),
    [cfgOf(cfg), HNSW, cfg.maxIndexBytes] as const,
  );
  await page.close();
  expect(built.nodes).toBe(cfg.rows);

  const common = {
    commit,
    date_utc: '',
    machine,
    os: osName,
    chrome: facts.chrome,
    precise_memory: facts.precise,
    command: COMMAND,
    driver: 'opfs',
    data: cfg.data,
    rows: cfg.rows,
    dim: DIM,
    k: K,
    queries: QUERIES,
    run,
    eight_gb: EIGHT_GB,
  };

  const flatPage = await openPage(ctx);
  const flat = await flatPage.evaluate(
    ([data, q, max]) => window.__localdata.annBenchCold('opfs', data, 'flat', [], q, max),
    [cfgOf(cfg), QUERIES, cfg.maxIndexBytes] as const,
  );
  await flatPage.close();
  expect(flat.liveRows).toBe(cfg.rows);
  expect(flat.answered.hnsw).toBe(0);
  const flatRow = {
    ...common,
    date_utc: new Date().toISOString(),
    kernel: flat.kernel,
    index_kind: 'flat',
    m: '',
    ef_construction: '',
    ef_search: '',
    seed: '',
    build_ms: round(built.flatWriteMs),
    cold_open_ms: round(flat.coldOpenMs),
    query_p50_ms: round(flat.variants[0]!.p50),
    query_p95_ms: round(flat.variants[0]!.p95),
    recall_at_10: 1,
    js_heap_peak_bytes: Math.round(flat.jsHeapPeak),
    wasm_memory_bytes: flat.wasmBytes,
    index_bytes: flat.indexBytes,
    ann_bytes: 0,
    storage_usage_bytes: flat.storageUsage,
  };
  pending.push(flatRow);
  if (LOGS) appendFileSync(join(LOGS, 'raw.jsonl'), `${JSON.stringify({ flatRow, raw: flat })}\n`);

  const annPage = await openPage(ctx);
  const ann = await annPage.evaluate(
    ([data, efs, q, max]) => window.__localdata.annBenchCold('opfs', data, 'hnsw', efs, q, max),
    [cfgOf(cfg), EFS, QUERIES, cfg.maxIndexBytes] as const,
  );
  await annPage.close();
  // A graph row must have been answered by the graph, from a current graph: never a fallback.
  expect(ann.annCurrent, 'the graph is current').toBe(true);
  expect(ann.annNodes).toBe(cfg.rows);
  expect(ann.answered.fallbacks, 'no query fell back to the flat scan').toBe(0);
  for (const v of ann.variants) {
    const row = {
      ...common,
      date_utc: new Date().toISOString(),
      kernel: ann.kernel,
      index_kind: 'hnsw',
      m: HNSW.m,
      ef_construction: HNSW.efConstruction,
      ef_search: v.ef ?? '',
      seed: HNSW.seed,
      build_ms: round(built.buildMs),
      cold_open_ms: round(ann.coldOpenMs),
      query_p50_ms: round(v.p50),
      query_p95_ms: round(v.p95),
      recall_at_10: Math.round(v.recall * 10000) / 10000,
      js_heap_peak_bytes: Math.round(ann.jsHeapPeak),
      wasm_memory_bytes: ann.wasmBytes,
      index_bytes: ann.indexBytes,
      ann_bytes: ann.annBytes,
      storage_usage_bytes: ann.storageUsage,
    };
    pending.push(row);
    if (LOGS) appendFileSync(join(LOGS, 'raw.jsonl'), `${JSON.stringify({ row, raw: ann })}\n`);
  }
  const loadEnd = os.loadavg()[0] ?? Number.NaN;
  for (const r of pending)
    appendFileSync(
      CSV,
      annCsvRow({
        ...r,
        host_load_1m_start: hostLoadCell(os.platform(), loadStart),
        host_load_1m_end: hostLoadCell(os.platform(), loadEnd),
      }),
    );
  console.log(
    `[bench:ann] ${cfg.label} run ${run}: flat write ${round(built.flatWriteMs)} ms, graph build ${round(built.buildMs)} ms (${built.graphBytes} bytes), ` +
      `flat p50 ${round(flat.variants[0]!.p50)} ms, hnsw ${ann.variants
        .map((v) => `ef${v.ef} p50 ${round(v.p50)} ms recall ${round(v.recall)}`)
        .join(', ')}`,
  );
  return { buildMs: built.buildMs, flatWriteMs: built.flatWriteMs };
}

async function runConfig(cfg: Cfg): Promise<number[]> {
  const profile = profileFor(cfg.label);
  const commit = git('describe', '--always', '--dirty');
  const builds: number[] = [];
  const ctx = await launch(profile);
  try {
    const probe = await openPage(ctx);
    const facts = await browserFacts(ctx, probe);
    await probe.close();
    expect(facts.precise, 'Chrome must run with --enable-precise-memory-info').toBe(true);
    for (let run = 1; run <= cfg.runs; run++) {
      builds.push((await oneRun(cfg, run, ctx, commit, facts)).buildMs);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
  return builds;
}

test.beforeAll(() => {
  mkdirSync(dirname(CSV), { recursive: true });
  writeFileSync(CSV, annCsvHeader());
  writeFileSync(DUP_CSV, annDupCsvHeader());
  if (LOGS) mkdirSync(LOGS, { recursive: true });
});

test.describe.configure({ mode: 'serial' });

let clusteredBuilds: number[] = [];
const note: { oneMillion?: { attempted: boolean; finished: boolean; statement: string } } = {};

test(`clustered ${ROWS_100K} x ${DIM}: flat and HNSW (ef ${EFS.join(', ')}), 3 runs`, async () => {
  test.setTimeout(3_600_000);
  clusteredBuilds = await runConfig({
    label: `clustered-${ROWS_100K}`,
    data: 'clustered',
    rows: ROWS_100K,
    centres: ROWS_100K >= 100_000 ? 1000 : Math.max(10, Math.round(ROWS_100K / 100)),
    seed: ROWS_100K,
    runs: 3,
    maxIndexBytes: 2 ** 30,
  });
});

test(`uniform ${ROWS_100K} x ${DIM}: flat and HNSW, 1 run, no floor`, async () => {
  test.setTimeout(3_600_000);
  await runConfig({
    label: `uniform-${ROWS_100K}`,
    data: 'uniform',
    rows: ROWS_100K,
    centres: 0,
    seed: 0,
    runs: 1,
    maxIndexBytes: 2 ** 30,
  });
});

/** One duplicates run: every vector of the set stored `copies` times; HNSW at the efs, recall counted by score. */
async function dupRun(
  cfg: Cfg,
  copies: number,
  ctx: BrowserContext,
  commit: string,
  facts: { chrome: string; precise: boolean },
) {
  const loadStart = os.loadavg()[0] ?? Number.NaN;
  const data = { ...cfgOf(cfg), copies };
  const page = await openPage(ctx);
  const built = await page.evaluate(
    ([d, hnsw, max]) => window.__localdata.annBenchBuild('opfs', d, hnsw, max),
    [data, HNSW, cfg.maxIndexBytes] as const,
  );
  await page.close();
  expect(built.nodes).toBe(cfg.rows);
  expect(built.duplicateRows, 'every copy after the first is a duplicate row').toBe(
    cfg.rows - Math.ceil(cfg.rows / copies),
  );
  const annPage = await openPage(ctx);
  const ann = await annPage.evaluate(
    ([d, efs, q, max]) => window.__localdata.annBenchCold('opfs', d, 'hnsw', efs, q, max),
    [data, EFS, QUERIES, cfg.maxIndexBytes] as const,
  );
  await annPage.close();
  const loadEnd = os.loadavg()[0] ?? Number.NaN;
  expect(ann.annCurrent, 'the graph is current').toBe(true);
  for (const v of ann.variants) {
    appendFileSync(
      DUP_CSV,
      annDupCsvRow({
        commit,
        date_utc: new Date().toISOString(),
        machine,
        os: osName,
        chrome: facts.chrome,
        precise_memory: facts.precise,
        command: COMMAND,
        driver: 'opfs',
        kernel: ann.kernel,
        data: cfg.data,
        rows: cfg.rows,
        dim: DIM,
        copies_per_vector: copies,
        m: HNSW.m,
        ef_construction: HNSW.efConstruction,
        ef_search: v.ef ?? '',
        k: K,
        seed: HNSW.seed,
        queries: QUERIES,
        run: 1,
        build_ms: round(built.buildMs),
        duplicate_rows: built.duplicateRows,
        answered_by_graph: v.answeredByGraph,
        answered_by_flat_duplicates: v.answeredByFlatDuplicates,
        queries_equal_to_flat: v.equalToFlat,
        recall_at_10_by_score: Math.round(v.recallByScore * 10000) / 10000,
        query_p50_ms: round(v.p50),
        query_p95_ms: round(v.p95),
        index_bytes: ann.indexBytes,
        ann_bytes: ann.annBytes,
        eight_gb: EIGHT_GB,
        host_load_1m_start: hostLoadCell(os.platform(), loadStart),
        host_load_1m_end: hostLoadCell(os.platform(), loadEnd),
      }),
    );
  }
  console.log(
    `[bench:ann] duplicates ${cfg.rows} x ${DIM} x${copies}: graph build ${round(built.buildMs)} ms (${built.graphBytes} bytes, ${built.duplicateRows} duplicate rows), ` +
      ann.variants
        .map(
          (v) =>
            `ef${v.ef} p50 ${round(v.p50)} ms equal ${v.equalToFlat}/${QUERIES} recall-by-score ${round(v.recallByScore)}`,
        )
        .join(', '),
  );
}

for (const copies of DUP_COPIES_LIST) {
  test(`duplicates ${ROWS_100K} x ${DIM}, every vector stored ${copies} times: HNSW (ef ${EFS.join(', ')}), 1 run, recall by score`, async () => {
    test.setTimeout(3_600_000);
    const cfg: Cfg = {
      label: `duplicates-${ROWS_100K}-x${copies}`,
      data: 'clustered',
      rows: ROWS_100K,
      // one centre per hundred base vectors, as the distinct clustered set has one per hundred rows
      centres: Math.max(10, Math.round(ROWS_100K / copies / 100)),
      seed: ROWS_100K + copies,
      runs: 1,
      maxIndexBytes: 2 ** 30,
    };
    const commit = git('describe', '--always', '--dirty');
    const ctx = await launch(profileFor(cfg.label));
    try {
      const probe = await openPage(ctx);
      const facts = await browserFacts(ctx, probe);
      await probe.close();
      expect(facts.precise, 'Chrome must run with --enable-precise-memory-info').toBe(true);
      await dupRun(cfg, copies, ctx, commit, facts);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}

test('1,000,000 x 384: only if the 100k graph build took under 120 s, time-boxed to 20 minutes', async () => {
  test.setTimeout(TIMEBOX_1M_MS + 600_000);
  const buildS = median(clusteredBuilds) / 1000;
  if (SKIP_1M) {
    note.oneMillion = {
      attempted: false,
      finished: false,
      statement: 'not attempted: the run was told to skip it.',
    };
  } else if (!(median(clusteredBuilds) < GATE_1M_MS)) {
    note.oneMillion = {
      attempted: false,
      finished: false,
      statement: `not attempted: the ${ROWS_100K.toLocaleString('en-US')} x 384 graph build took ${buildS.toFixed(1)} s (median of ${clusteredBuilds.length} runs), not under the 120 s gate that was set before measuring.`,
    };
  } else {
    const cfg: Cfg = {
      label: 'clustered-1m',
      data: 'clustered',
      rows: 1_000_000,
      centres: 10_000,
      seed: 1_000_000,
      runs: 1,
      maxIndexBytes: 2 ** 31,
    };
    const outcome = await Promise.race([
      runConfig(cfg).then(
        () => 'finished' as const,
        (e: unknown) => ({ failed: e instanceof Error ? e.name : 'error' }),
      ),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), TIMEBOX_1M_MS)),
    ]);
    if (outcome === 'finished') {
      note.oneMillion = {
        attempted: true,
        finished: true,
        statement: `ran once to completion (the 100,000 x 384 graph build took ${buildS.toFixed(1)} s, under the 120 s gate); its rows are in the table above, 10,000 centres, the same parameters.`,
      };
    } else if (outcome === 'timeout') {
      note.oneMillion = {
        attempted: true,
        finished: false,
        statement:
          'attempted (the 100,000 build was under the 120 s gate) and stopped at the 30-minute time box before it finished; nothing is recorded for it.',
      };
    } else {
      note.oneMillion = {
        attempted: true,
        finished: false,
        statement: `attempted (the 100,000 build was under the 120 s gate) and failed with ${outcome.failed}; nothing is recorded for it.`,
      };
    }
  }
  writeFileSync(NOTE, `${JSON.stringify(note, null, 2)}\n`);
  console.log(`[bench:ann] 1M: ${note.oneMillion?.statement}`);
});
