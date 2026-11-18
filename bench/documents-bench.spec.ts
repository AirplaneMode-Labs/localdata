// `npm run bench:documents`: the documents API (Storage API 0.3.0) on a synthetic corpus of 100 documents x
// 200 chunks x 384 dims (400-byte chunk texts), in installed Chrome, written to
// docs/benchmarks/documents.csv. Measured rows only; every row says "not measured on 8 GB".
//
// Per driver (OPFS, then IndexedDB), 3 runs, each:
//   put          100 sequential putDocument calls (per-document p50 and p95), then
//   query_warm   50 queryChunks (k = 5) against the resident index, in the same page;
//   query_cold   a NEW page: createStore + the first queryChunks (loads and checks the vectors);
//   delete       the first 50 documents, one deleteDocument each, then a query against a reference;
//   clear        clear(ns), then the browser's own listing and a query: nothing may be left.
// plus one restart run: the browser is relaunched on the same profile and the cold query repeated.
// The top 5 of every query is compared with a naive reference outside the timing (the match column).
//
// Nothing in the CSV is typed by hand: commit is `git describe --always --dirty`, machine comes from
// os.cpus() and os.totalmem(), Chrome's version comes from CDP.
//
// Environment (all optional):
//   LOCALDATA_DOCS_BENCH_CSV   CSV path (default docs/benchmarks/documents.csv)
//   LOCALDATA_BENCH_LOGS       a directory that receives raw-documents.jsonl
//   LOCALDATA_PROFILE_DIR      Chrome profile root; unset, a mkdtemp directory named chrome-profile-docbench-*
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import { EIGHT_GB, csvHeader, csvRow } from '../scripts/bench-docs-csv.mjs';
import { BASE_URL } from '../test/browser/playwright.config';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSV =
  process.env['LOCALDATA_DOCS_BENCH_CSV'] ?? join(repo, 'docs', 'benchmarks', 'documents.csv');
const LOGS = process.env['LOCALDATA_BENCH_LOGS'];
const PROFILE_ROOT =
  process.env['LOCALDATA_PROFILE_DIR'] ??
  mkdtempSync(join(os.tmpdir(), 'chrome-profile-docbench-'));
const RUNS = 3;
const DELETE_COUNT = 50;
const COMMAND = 'npm run bench:documents';
const LAUNCH_ARGS = ['--enable-precise-memory-info'];

const git = (...a: string[]) =>
  execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const cpus = os.cpus();
const machine = `${cpus[0]?.model ?? 'unknown cpu'}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
const osName = `${os.platform()} ${os.arch()} ${os.release()}`;
const round = (x: number) => Math.round(x * 100) / 100;

function profileFor(driver: string): string {
  const dir = join(PROFILE_ROOT, `docs-${driver}`);
  if (basename(PROFILE_ROOT).startsWith('chrome-profile'))
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { channel: 'chrome', args: LAUNCH_ARGS });
}

async function openPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('body[data-ready="1"]');
  return page;
}

async function chromeFacts(ctx: BrowserContext, page: Page) {
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
  return { chrome: version.product, precise: LAUNCH_ARGS.length > 0 && unquantised };
}

test.beforeAll(() => {
  mkdirSync(dirname(CSV), { recursive: true });
  writeFileSync(CSV, csvHeader());
  if (LOGS) mkdirSync(LOGS, { recursive: true });
});

test.describe.configure({ mode: 'serial' });

for (const driver of ['opfs', 'indexeddb'] as const) {
  test(`${driver}: ${RUNS} runs of put, warm and cold query, delete and clear, plus a restart run`, async () => {
    test.setTimeout(3_000_000);
    const profile = profileFor(driver);
    const commit = git('describe', '--always', '--dirty');
    let facts = { chrome: '', precise: false };
    let shape = { docs: 0, chunks: 0, dim: 0, text: 0 };
    let kernel = '';

    const base = (operation: string, run: number, restart: boolean) => ({
      commit,
      date_utc: new Date().toISOString(),
      machine,
      os: osName,
      chrome: facts.chrome,
      precise_memory: facts.precise,
      command: COMMAND,
      driver,
      kernel,
      operation,
      docs: shape.docs,
      chunks_per_doc: shape.chunks,
      dim: shape.dim,
      chunk_text_bytes: shape.text,
      restart,
      run,
      eight_gb: EIGHT_GB,
    });
    const write = (row: Record<string, string | number | boolean>, raw: unknown) => {
      appendFileSync(CSV, csvRow(row));
      if (LOGS)
        appendFileSync(join(LOGS, 'raw-documents.jsonl'), `${JSON.stringify({ row, raw })}\n`);
    };

    let ctx = await launch(profile);
    try {
      for (let run = 1; run <= RUNS; run++) {
        const a = await openPage(ctx);
        if (run === 1) {
          facts = await chromeFacts(ctx, a);
          expect(facts.precise, 'Chrome must run with --enable-precise-memory-info').toBe(true);
          shape = await a.evaluate(() => window.__localdata.docBenchShape);
        }
        const built = await a.evaluate((d) => window.__localdata.docBenchBuild(d), driver);
        await a.close();
        kernel = built.kernel;
        expect(built.match, 'warm query top 5 equals the naive reference').toBe(true);
        expect(built.put.documents).toBe(shape.docs);
        write(
          {
            ...base('put', run, false),
            kernel,
            ops: shape.docs,
            total_ms: round(built.put.totalMs),
            per_op_ms: round(built.put.totalMs / shape.docs),
            p50_ms: round(built.put.p50),
            p95_ms: round(built.put.p95),
            js_heap_peak_bytes: Math.round(built.put.heapPeak),
            index_bytes: built.put.indexBytes,
            storage_usage_bytes: built.storageUsage,
            match: true,
          },
          built,
        );
        write(
          {
            ...base('query_warm', run, false),
            kernel,
            ops: 50,
            total_ms: round(built.warm.totalMs),
            per_op_ms: round(built.warm.totalMs / 50),
            p50_ms: round(built.warm.p50),
            p95_ms: round(built.warm.p95),
            js_heap_peak_bytes: Math.round(built.warm.heapPeak),
            wasm_memory_bytes: built.warm.wasm,
            index_bytes: built.put.indexBytes,
            storage_usage_bytes: built.storageUsage,
            match: built.match,
          },
          built,
        );

        // a new page: the cold query, then delete and clear on the store it leaves open
        const b = await openPage(ctx);
        const cold = await b.evaluate((d) => window.__localdata.docBenchCold(d), driver);
        expect(cold.documents).toBe(shape.docs);
        expect(cold.match, 'cold query top 5 equals the naive reference').toBe(true);
        write(
          {
            ...base('query_cold', run, false),
            ops: 1,
            total_ms: round(cold.coldMs),
            per_op_ms: round(cold.coldMs),
            p50_ms: round(cold.coldMs),
            p95_ms: round(cold.coldMs),
            js_heap_peak_bytes: Math.round(cold.heapPeak),
            wasm_memory_bytes: cold.wasm,
            index_bytes: cold.indexBytes,
            storage_usage_bytes: cold.storageUsage,
            match: cold.match,
          },
          cold,
        );
        const del = await b.evaluate((n) => window.__localdata.docBenchDelete(n), DELETE_COUNT);
        expect(del.match, 'top 5 after the deletes equals the naive reference').toBe(true);
        expect(del.documents).toBe(shape.docs - DELETE_COUNT);
        write(
          {
            ...base('delete', run, false),
            ops: DELETE_COUNT,
            total_ms: round(del.totalMs),
            per_op_ms: round(del.totalMs / DELETE_COUNT),
            p50_ms: round(del.p50),
            p95_ms: round(del.p95),
            js_heap_peak_bytes: Math.round(del.heapPeak),
            index_bytes: del.indexBytes,
            match: del.match,
          },
          del,
        );
        const clear = await b.evaluate((d) => window.__localdata.docBenchClear(d), driver);
        const cleared = clear.records === 0 && clear.namespaces === 0 && clear.hits === 0;
        expect(cleared, 'clear(ns) left nothing behind').toBe(true);
        write(
          {
            ...base('clear', run, false),
            ops: 1,
            total_ms: round(clear.ms),
            per_op_ms: round(clear.ms),
            p50_ms: round(clear.ms),
            p95_ms: round(clear.ms),
            js_heap_peak_bytes: Math.round(clear.heapPeak),
            match: cleared,
          },
          clear,
        );
        await b.close();
      }

      // restart run: build, close the browser, relaunch on the same profile, cold query
      const a = await openPage(ctx);
      await a.evaluate((d) => window.__localdata.docBenchBuild(d), driver);
      await a.close();
      await ctx.close();
      ctx = await launch(profile);
      const b = await openPage(ctx);
      const cold = await b.evaluate((d) => window.__localdata.docBenchCold(d), driver);
      expect(cold.match, 'restart cold query top 5 equals the naive reference').toBe(true);
      write(
        {
          ...base('query_cold', RUNS + 1, true),
          ops: 1,
          total_ms: round(cold.coldMs),
          per_op_ms: round(cold.coldMs),
          p50_ms: round(cold.coldMs),
          p95_ms: round(cold.coldMs),
          js_heap_peak_bytes: Math.round(cold.heapPeak),
          wasm_memory_bytes: cold.wasm,
          index_bytes: cold.indexBytes,
          storage_usage_bytes: cold.storageUsage,
          match: cold.match,
        },
        cold,
      );
      await b.evaluate((d) => window.__localdata.docBenchClear(d), driver);
      await b.close();
    } finally {
      await ctx.close();
    }
  });
}
