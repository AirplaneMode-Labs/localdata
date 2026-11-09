// Playwright smoke test on installed Chrome (channel "chrome"): the shared behavioural suite runs
// against the OPFS and IndexedDB drivers, values survive page.reload(), no request leaves the
// harness's own 127.0.0.1 origin, and write/read throughput is recorded for the README.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { BASE_URL } from './playwright.config';
import type { BenchResult } from './harness';
import { behaviourCases, type SuiteResult } from '../storage.behaviour';

type DriverName = 'opfs' | 'indexeddb';
const DRIVERS: DriverName[] = ['opfs', 'indexeddb'];

// Benchmark figures are written only when LOCALDATA_BENCH_OUT names a directory; unset, the
// benchmark cases still run and assert but write nothing to disk.
const BENCH_OUT = process.env['LOCALDATA_BENCH_OUT'];

const requestLog: string[] = [];
const suiteResults = new Map<DriverName, SuiteResult[]>();

test.describe.configure({ mode: 'serial' });

async function openHarness(page: Page): Promise<void> {
  page.on('request', (r) => requestLog.push(r.url()));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="1"]');
  const features = await page.evaluate(() => window.__localdata.features());
  expect(features.secureContext, '127.0.0.1 must be a secure context').toBe(true);
  expect(features.opfs, 'OPFS available').toBe(true);
  expect(features.indexedDb, 'IndexedDB available').toBe(true);
}

for (const driver of DRIVERS) {
  test(`behavioural suite passes against the ${driver} driver`, async ({ page }) => {
    await openHarness(page);
    const results = await page.evaluate((d) => window.__localdata.runSuite(d), driver);
    suiteResults.set(driver, results);
    expect(results.length).toBeGreaterThanOrEqual(30);
    expect(results.map((r) => r.name)).toEqual(behaviourCases.map((c) => c.name));
    const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

test('both drivers produce identical results for every case', async () => {
  const a = suiteResults.get('opfs');
  const b = suiteResults.get('indexeddb');
  expect(a, 'opfs results recorded').toBeTruthy();
  expect(b, 'indexeddb results recorded').toBeTruthy();
  const strip = (rs: SuiteResult[]) => rs.map((r) => ({ name: r.name, ok: r.ok }));
  expect(strip(a!)).toEqual(strip(b!));
});

for (const driver of DRIVERS) {
  test(`values persist across page.reload() with the ${driver} driver`, async ({ page }) => {
    await openHarness(page);
    await page.evaluate((d) => window.__localdata.persistWrite(d), driver);
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]');
    const check = await page.evaluate((d) => window.__localdata.persistCheck(d), driver);
    expect(check.problems, check.problems.join(', ')).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.items).toBe(5);
    await page.evaluate((d) => window.__localdata.reset(d), driver);
  });
}

for (const driver of DRIVERS) {
  test(`benchmark: 1000 x 1 KiB and 10 x 5 MiB sets with the ${driver} driver`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(600_000);
    await openHarness(page);
    const result: BenchResult = await page.evaluate((d) => window.__localdata.bench(d), driver);
    expect(result.set1k.n).toBe(1000);
    expect(result.set5m.n).toBe(10);
    if (!BENCH_OUT) return;
    mkdirSync(BENCH_OUT, { recursive: true });
    const record = {
      recordedAt: new Date().toISOString(),
      machine:
        'Apple-silicon development machine, placeholder; 8 GB Windows no-GPU laptop not yet measured',
      chromeVersion: browser.version(),
      command: 'LOCALDATA_BENCH_OUT=<dir> npm run test:browser',
      ...result,
    };
    writeFileSync(join(BENCH_OUT, `${driver}.json`), JSON.stringify(record, null, 2) + '\n');
    appendFileSync(
      join(BENCH_OUT, 'raw.log'),
      `${record.recordedAt} ${driver} chrome=${record.chromeVersion} ` +
        `set1k=${result.set1k.ms}ms get1k=${result.get1k.ms}ms set5m=${result.set5m.ms}ms get5m=${result.get5m.ms}ms\n`,
    );
  });
}

test('no request left the harness origin in any scenario', async () => {
  expect(requestLog.length).toBeGreaterThan(0);
  const foreign = requestLog.filter((u) => !u.startsWith(`${BASE_URL}/`));
  expect(foreign, `foreign requests: ${foreign.join(', ')}`).toEqual([]);
  const paths = new Set(requestLog.map((u) => new URL(u).pathname));
  for (const p of paths) {
    expect(p === '/' || p === '/index.html' || p.startsWith('/dist/'), `unexpected path ${p}`).toBe(
      true,
    );
  }
});
