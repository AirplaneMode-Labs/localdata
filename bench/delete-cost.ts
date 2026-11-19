// `npm run bench:delete-cost`: what one delete() costs with and without a current HNSW graph, in installed
// Chrome on OPFS, recorded to docs/benchmarks/delete-cost.csv (BUG-T2-S6-13). With a current graph every delete
// marks one node and writes the whole graph record again, so the cost grows with the graph; the README and
// docs/vector-index.md quote this CSV, never an internal log (test/readme-delete-cost.test.ts).
//
//   20,000 x 32 and 100,000 x 32, seeded integer-only vectors (bench/synth.ts), HNSW m 16 / efConstruction 200 /
//   seed 1. Per size and per kind (graph, flat-only): 3 runs; each run builds a fresh namespace in a fresh
//   page, then times 200 single delete() calls one after another (each awaited). A row is one run: p50 and p95
//   over its 200 deletes. The documents quote the median over the runs of each run's p50.
//
// Nothing in the CSV is typed by hand: commit is `git describe --always --dirty`, machine comes from os.cpus()
// and os.totalmem(), Chrome's version comes from CDP, and the command is this script's own. This script
// asserts only that the rows were deleted and that the graph (when there is one) stayed current: never a
// timing.
//
// Environment (all optional):
//   LOCALDATA_DELETE_COST_CSV   CSV path (default docs/benchmarks/delete-cost.csv)
//   LOCALDATA_DELETE_COST_ROWS  comma-separated row counts (a dry run: 2000); the CSV's `command` then says so
//   LOCALDATA_PROFILE_DIR       Chrome profile root; unset, a mkdtemp directory named chrome-profile-delete-cost-*
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import { EIGHT_GB, deleteCostHeader, deleteCostRow } from '../scripts/bench-delete-cost.mjs';
import { BASE_URL } from '../test/browser/playwright.config';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSV =
  process.env['LOCALDATA_DELETE_COST_CSV'] ?? join(repo, 'docs', 'benchmarks', 'delete-cost.csv');
const PROFILE_ROOT =
  process.env['LOCALDATA_PROFILE_DIR'] ??
  mkdtempSync(join(os.tmpdir(), 'chrome-profile-delete-cost-'));
const SIZES = (process.env['LOCALDATA_DELETE_COST_ROWS'] ?? '20000,100000')
  .split(',')
  .map((s) => Number(s.trim()));
const COMMAND = `${process.env['LOCALDATA_DELETE_COST_ROWS'] !== undefined ? `LOCALDATA_DELETE_COST_ROWS=${process.env['LOCALDATA_DELETE_COST_ROWS']} ` : ''}npm run bench:delete-cost`;

const DIM = 32;
const DELETES = 200;
const RUNS = 3;
const HNSW = { m: 16, efConstruction: 200, seed: 1 };

const git = (...a: string[]) =>
  execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const cpus = os.cpus();
const machine = `${cpus[0]?.model ?? 'unknown cpu'}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
const osName = `${os.platform()} ${os.arch()} ${os.release()}`;
const round = (x: number) => Math.round(x * 100) / 100;
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

async function openPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('body[data-ready="1"]');
  return page;
}

function profileFor(label: string): string {
  const dir = join(PROFILE_ROOT, label);
  if (basename(PROFILE_ROOT).startsWith('chrome-profile'))
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.beforeAll(() => {
  mkdirSync(dirname(CSV), { recursive: true });
  writeFileSync(CSV, deleteCostHeader());
});

test.describe.configure({ mode: 'serial' });

for (const rows of SIZES) {
  test(`${rows} x ${DIM}: ${DELETES} single deletes with a current graph and flat only, ${RUNS} runs each`, async () => {
    test.setTimeout(3_600_000);
    const commit = git('describe', '--always', '--dirty');
    const ctx = await chromium.launchPersistentContext(profileFor(`rows-${rows}`), {
      channel: 'chrome',
    });
    try {
      const probe = await openPage(ctx);
      const cdp = await ctx.newCDPSession(probe);
      const chrome = ((await cdp.send('Browser.getVersion')) as { product: string }).product;
      await cdp.detach();
      await probe.close();
      for (let run = 1; run <= RUNS; run++) {
        for (const withGraph of [false, true]) {
          const page = await openPage(ctx);
          const r = await page.evaluate(
            ([n, d, g, del, h]) => window.__localdata.deleteCostBench('opfs', n, d, g, del, h),
            [rows, DIM, withGraph, DELETES, HNSW] as const,
          );
          await page.close();
          expect(r.samples).toHaveLength(DELETES);
          expect(r.liveRows, 'the deleted rows are gone').toBe(rows - DELETES);
          if (withGraph) expect(r.annCurrent, 'the graph stayed current').toBe(true);
          const row = {
            commit,
            date_utc: new Date().toISOString(),
            machine,
            os: osName,
            chrome,
            command: COMMAND,
            driver: 'opfs',
            kernel: r.kernel,
            rows,
            dim: DIM,
            with_graph: withGraph,
            m: withGraph ? HNSW.m : '',
            ef_construction: withGraph ? HNSW.efConstruction : '',
            seed: withGraph ? HNSW.seed : '',
            deletes: DELETES,
            run,
            ms_per_delete_p50: round(percentile(r.samples, 50)),
            ms_per_delete_p95: round(percentile(r.samples, 95)),
            graph_bytes: r.graphBytes,
            eight_gb: EIGHT_GB,
          };
          appendFileSync(CSV, deleteCostRow(row));
          console.log(
            `[bench:delete-cost] ${rows} x ${DIM} run ${run} ${withGraph ? 'graph' : 'flat'}: p50 ${row.ms_per_delete_p50} ms, p95 ${row.ms_per_delete_p95} ms` +
              (withGraph ? ` (graph ${r.graphBytes} bytes)` : ''),
          );
          await new Promise((res) => setTimeout(res, 300));
        }
      }
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}
