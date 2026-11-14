// `npm run bench:vectors`: builds 10k and 100k indexes from deterministic synthetic vectors (bench/
// synth.ts: no real documents, no model download) in installed Chrome, closes the page, then times
// the cold path in fresh pages and records everything to docs/benchmarks/vector-index.csv.
//
//   OPFS      10,000 x 384 with 256-byte chunks; 100,000 x 384 with 256-byte chunks; 100,000 x 384 with
//             2,048-byte chunks
//   IndexedDB 10,000 x 384 with 256-byte chunks, and 100,000 if its build finishes within 10 minutes
//
// Per configuration: build with putVectors from a generator (write_ms); then 5 cold runs, each in a new
// page (cold_open_ms = createStore + indexInfo, first_query_ms = the first query(k = 10), which also
// loads and checksums the vectors, cold_total_ms = their sum); then one more cold run after relaunching
// the browser on the same profile (restart = true). Each run also issues 50 more queries for p50 and p95
// and samples the JS heap (Chrome launched with --enable-precise-memory-info), and checks the first
// query's top-10 against the naive reference (match). The OS file cache cannot be dropped from a page:
// the README says so.
//
// Nothing in the CSV is typed by hand: commit is `git describe --always --dirty`, machine comes from
// os.cpus() and os.totalmem(), Chrome's version and command line come from CDP.
//
// Environment (all optional):
//   LOCALDATA_BENCH_CSV      CSV path (default docs/benchmarks/vector-index.csv)
//   LOCALDATA_BENCH_LOGS     a directory that receives raw.jsonl, one line per measurement
//   LOCALDATA_PROFILE_DIR    Chrome profile root; unset, a mkdtemp directory named chrome-profile-bench-*
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import { csvHeader, csvRow } from '../scripts/bench-csv.mjs';
import { BASE_URL } from '../test/browser/playwright.config';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSV =
  process.env['LOCALDATA_BENCH_CSV'] ?? join(repo, 'docs', 'benchmarks', 'vector-index.csv');
const LOGS = process.env['LOCALDATA_BENCH_LOGS'];
const PROFILE_ROOT =
  process.env['LOCALDATA_PROFILE_DIR'] ?? mkdtempSync(join(os.tmpdir(), 'chrome-profile-bench-'));
const COLD_RUNS = 5;
const DIM = 384;
const IDB_100K_BUILD_LIMIT_MS = 600_000;

interface Cfg {
  driver: 'opfs' | 'indexeddb';
  rows: number;
  chunk: number;
  optional?: boolean;
}
const CONFIGS: Cfg[] = [
  { driver: 'opfs', rows: 10_000, chunk: 256 },
  { driver: 'opfs', rows: 100_000, chunk: 256 },
  { driver: 'opfs', rows: 100_000, chunk: 2048 },
  { driver: 'indexeddb', rows: 10_000, chunk: 256 },
  { driver: 'indexeddb', rows: 100_000, chunk: 256, optional: true },
];

const git = (...a: string[]) =>
  execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const cpus = os.cpus();
const machine = `${cpus[0]?.model ?? 'unknown cpu'}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
const osName = `${os.platform()} ${os.arch()} ${os.release()}`;

function profileFor(cfg: Cfg): string {
  const dir = join(PROFILE_ROOT, `${cfg.driver}-${cfg.rows}-${cfg.chunk}`);
  if (basename(PROFILE_ROOT).startsWith('chrome-profile'))
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    args: LAUNCH_ARGS,
  });
}

async function openPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('body[data-ready="1"]');
  return page;
}

const LAUNCH_ARGS = ['--enable-precise-memory-info'];

/**
 * Chrome's version from CDP, and whether precise memory info is really on: the flag was passed AND
 * performance.memory returns unquantised values (without the flag Chrome rounds them to coarse buckets,
 * so every sample would be a round number). Browser.getBrowserCommandLine needs --enable-automation,
 * which Playwright does not set, so the command line cannot be read back.
 */
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
  return {
    chrome: version.product,
    precise: LAUNCH_ARGS.includes('--enable-precise-memory-info') && unquantised,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

test.beforeAll(() => {
  mkdirSync(dirname(CSV), { recursive: true });
  writeFileSync(CSV, csvHeader());
  if (LOGS) mkdirSync(LOGS, { recursive: true });
});

test.describe.configure({ mode: 'serial' });

for (const cfg of CONFIGS) {
  test(`${cfg.driver} ${cfg.rows} x ${DIM}, ${cfg.chunk}-byte chunks: build, ${COLD_RUNS} cold runs, 1 restart run`, async () => {
    test.setTimeout(3_000_000);
    const profile = profileFor(cfg);
    let ctx = await launch(profile);
    const commit = git('describe', '--always', '--dirty');
    let facts = { chrome: '', precise: false };
    let writeMs = 0;
    try {
      const page = await openPage(ctx);
      facts = await browserFacts(ctx, page);
      expect(facts.precise, 'Chrome must run with --enable-precise-memory-info').toBe(true);
      const build = page.evaluate(([d, n, c]) => window.__localdata.benchBuild(d, n, c), [
        cfg.driver,
        cfg.rows,
        cfg.chunk,
      ] as const);
      let built: Awaited<typeof build> | 'timeout';
      if (cfg.optional) {
        built = await Promise.race([
          build,
          new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), IDB_100K_BUILD_LIMIT_MS)),
        ]);
      } else built = await build;
      if (built === 'timeout') {
        if (LOGS)
          appendFileSync(
            join(LOGS, 'raw.jsonl'),
            `${JSON.stringify({ cfg, skipped: 'build did not finish within 10 minutes' })}\n`,
          );
        console.log(`[bench] ${cfg.driver} ${cfg.rows}: build exceeded 10 minutes; not recorded`);
        return;
      }
      expect(built.rows).toBe(cfg.rows);
      writeMs = built.writeMs;
      await page.close();

      const record = async (c: BrowserContext, restart: boolean, run: number) => {
        const p = await openPage(c);
        const r = await p.evaluate(([d, n, ch]) => window.__localdata.benchCold(d, n, ch), [
          cfg.driver,
          cfg.rows,
          cfg.chunk,
        ] as const);
        await p.close();
        const total = r.coldOpenMs + r.firstQueryMs;
        const row = {
          commit,
          date_utc: new Date().toISOString(),
          machine,
          os: osName,
          chrome: facts.chrome,
          precise_memory: facts.precise,
          driver: cfg.driver,
          kernel: r.kernel,
          rows: cfg.rows,
          dim: DIM,
          chunk_bytes: cfg.chunk,
          restart,
          run,
          write_ms: round(writeMs),
          cold_open_ms: round(r.coldOpenMs),
          first_query_ms: round(r.firstQueryMs),
          cold_total_ms: round(total),
          query_p50_ms: round(r.p50),
          query_p95_ms: round(r.p95),
          js_heap_peak_bytes: Math.round(r.jsHeapPeak),
          wasm_memory_bytes: r.wasmBytes,
          index_bytes: r.indexBytes,
          storage_usage_bytes: r.storageUsage,
          match: r.match,
        };
        appendFileSync(CSV, csvRow(row));
        if (LOGS) appendFileSync(join(LOGS, 'raw.jsonl'), `${JSON.stringify({ row, raw: r })}\n`);
        expect(r.match, 'top-10 equals the naive reference').toBe(true);
        return total;
      };

      const totals: number[] = [];
      for (let run = 1; run <= COLD_RUNS; run++) {
        totals.push(await record(ctx, false, run));
        await new Promise((r) => setTimeout(r, 500));
      }
      await ctx.close();
      ctx = await launch(profile);
      const restart = await record(ctx, true, COLD_RUNS + 1);
      console.log(
        `[bench] ${cfg.driver} ${cfg.rows} x ${cfg.chunk}B: write ${round(writeMs)} ms, cold totals ${totals.map(round).join(', ')} ms, after restart ${round(restart)} ms`,
      );
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}
