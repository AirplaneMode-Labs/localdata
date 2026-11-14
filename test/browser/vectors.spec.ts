// D4-03 in installed Chrome (channel "chrome"): the vector index over real OPFS and IndexedDB.
//   * the shared vector suite and the 13 query() cases pass on both drivers;
//   * an index survives page.reload() and a full browser relaunch of a persistent profile, and a
//     brand-new profile starts empty without an error;
//   * two pages of one persistent context writing the same namespace and different namespaces at the
//     same time, then a third page reopening: every row present, 0 corrupt, hits bit-identical to an
//     independent reference;
//   * a quota failure mid-write (the browser's own quota, overridden through CDP) and a page closed
//     during a write both leave the previous index readable with identical top-k;
//   * with OPFS removed from the page, 'auto' falls back to IndexedDB and the index still works;
//   * no console error and no request outside the harness origin.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import { BASE_URL } from './playwright.config';
import { vectorCases } from '../vector.behaviour';
import { queryCases } from '../query.behaviour';

type DriverName = 'opfs' | 'indexeddb';
const DRIVERS: DriverName[] = ['opfs', 'indexeddb'];

// The persistent profile. LOCALDATA_PROFILE_DIR names it (the sprint evidence runs use a directory
// called chrome-profile-harness); unset, a fresh mkdtemp under the OS temp directory is used. Only a
// directory whose name starts with "chrome-profile" is ever removed.
const BASE_PROFILE =
  process.env['LOCALDATA_PROFILE_DIR'] ?? mkdtempSync(join(tmpdir(), 'chrome-profile-harness-'));
function freshProfile(label: string): string {
  const dir = join(BASE_PROFILE, label);
  if (basename(BASE_PROFILE).startsWith('chrome-profile'))
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const consoleErrors: string[] = [];
const foreign: string[] = [];

function watch(page: Page): void {
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('request', (r) => {
    if (!r.url().startsWith(`${BASE_URL}/`) && !r.url().startsWith('data:')) foreign.push(r.url());
  });
}

async function ready(page: Page): Promise<void> {
  watch(page);
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('body[data-ready="1"]');
}

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    args: ['--enable-precise-memory-info'],
  });
}

test.describe.configure({ mode: 'serial' });

for (const driver of DRIVERS) {
  test(`the vector suite passes against the ${driver} driver`, async ({ page }) => {
    test.setTimeout(600_000);
    await ready(page);
    const results = await page.evaluate((d) => window.__localdata.runVectorSuite(d), driver);
    expect(results.map((r) => r.name)).toEqual(vectorCases.map((c) => c.name));
    const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test(`the 13 query() cases pass against the ${driver} driver (none skipped)`, async ({
    page,
  }) => {
    await ready(page);
    const results = await page.evaluate((d) => window.__localdata.runQueryCases(d), driver);
    expect(results.length).toBe(13);
    expect(results.map((r) => r.name)).toEqual(queryCases.map((c) => c.name));
    const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

for (const driver of DRIVERS) {
  test(`an index persists across page.reload() and a browser relaunch (${driver})`, async () => {
    test.setTimeout(300_000);
    const profile = freshProfile(`persist-${driver}`);
    const rows = 3000;
    let before: { keys: string[]; bits: number[] };
    let ctx = await launch(profile);
    try {
      const page = await ctx.newPage();
      await ready(page);
      const w = await page.evaluate(([d, n]) => window.__localdata.vecPersistWrite(d, n), [
        driver,
        rows,
      ] as const);
      before = w.hits;
      expect(w.info?.rows).toBe(rows);
      await page.reload();
      await page.waitForSelector('body[data-ready="1"]');
      const afterReload = await page.evaluate(
        ([d, n]) => window.__localdata.vecPersistCheck(d, n),
        [driver, rows] as const,
      );
      expect(afterReload.match, 'hits equal the reference after reload').toBe(true);
      expect(afterReload.values).toBe(true);
      expect(afterReload.info?.rows).toBe(rows);
    } finally {
      await ctx.close();
    }
    // a full relaunch of the browser on the same profile
    ctx = await launch(profile);
    try {
      const page = await ctx.newPage();
      await ready(page);
      const again = await page.evaluate(([d, n]) => window.__localdata.vecPersistCheck(d, n), [
        driver,
        rows,
      ] as const);
      expect(again.match, 'hits equal the reference after a relaunch').toBe(true);
      expect(again.info?.rows).toBe(rows);
      expect(again.info?.totalRows).toBe(rows);
      expect(again.coldMs).toBeGreaterThan(0);
      void before;
    } finally {
      await ctx.close();
    }
  });

  test(`a brand-new profile starts with no index and no error (${driver})`, async () => {
    const ctx = await launch(freshProfile(`empty-${driver}`));
    try {
      const page = await ctx.newPage();
      await ready(page);
      const r = await page.evaluate((d) => window.__localdata.vecFreshProfileCheck(d), driver);
      expect(r).toEqual({ hits: 0, info: null });
    } finally {
      await ctx.close();
    }
  });
}

for (const driver of DRIVERS) {
  test(`two pages writing one namespace and different namespaces at once: all rows, 0 corrupt (${driver})`, async () => {
    test.setTimeout(300_000);
    const ctx = await launch(freshProfile(`multi-${driver}`));
    try {
      const a = await ctx.newPage();
      const b = await ctx.newPage();
      await ready(a);
      await ready(b);
      await a.evaluate((d) => window.__localdata.reset(d), driver);
      const planA = [
        { ns: 'same', from: 0, count: 600, batch: 60 },
        { ns: 'only-a', from: 0, count: 300, batch: 50 },
      ];
      const planB = [
        { ns: 'same', from: 600, count: 600, batch: 60 },
        { ns: 'only-b', from: 100, count: 300, batch: 50 },
      ];
      const [ra, rb] = await Promise.all([
        a.evaluate(([d, p]) => window.__localdata.vecWriterRun(d, p), [driver, planA] as const),
        b.evaluate(([d, p]) => window.__localdata.vecWriterRun(d, p), [driver, planB] as const),
      ]);
      expect(ra.errors, 'page A errors').toEqual([]);
      expect(rb.errors, 'page B errors').toEqual([]);
      expect(ra.written).toBe(900);
      expect(rb.written).toBe(900);
      const c = await ctx.newPage();
      await ready(c);
      const v = await c.evaluate(([d, e]) => window.__localdata.vecVerify(d, e), [
        driver,
        {
          same: [
            [0, 600],
            [600, 600],
          ],
          'only-a': [[0, 300]],
          'only-b': [[100, 300]],
        },
      ] as const);
      expect(v.corrupt, 'corrupt results').toBe(0);
      expect(v.problems, v.problems.join('\n')).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
}

for (const driver of DRIVERS) {
  test(`a quota failure mid-write leaves the previous index readable with identical top-k (${driver})`, async () => {
    test.setTimeout(300_000);
    const ctx = await launch(freshProfile(`quota-${driver}`));
    try {
      const page = await ctx.newPage();
      await ready(page);
      const base = await page.evaluate((d) => window.__localdata.vecQuotaBase(d, 2000), driver);
      type Attempt = {
        outcome: string;
        code?: string | undefined;
        reason?: string | null | undefined;
      };
      const attempts: Array<[string, Attempt]> = [];
      if (driver === 'opfs') {
        // The browser's own quota, overridden through CDP to leave 1.5 MB of headroom.
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Storage.overrideQuotaForOrigin', {
          origin: BASE_URL,
          quotaSize: base.usage + 1_500_000,
        });
        attempts.push([
          'cdp',
          await page.evaluate((d) => window.__localdata.vecTryWrite(d, 5000, 8000), driver),
        ]);
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: BASE_URL });
      } else {
        // Chrome does not enforce the CDP quota override on IndexedDB writes (measured here: a 14 MB
        // write resolved under a 200 KB override), so IndexedDB is driven by a real
        // QuotaExceededError DOMException on the 3rd part instead.
        attempts.push([
          'kth',
          await page.evaluate((d) => window.__localdata.vecTryWrite(d, 5000, 8000, 'kth'), driver),
        ]);
      }
      attempts.push([
        'soft',
        await page.evaluate((d) => window.__localdata.vecTryWrite(d, 5000, 8000, 'soft'), driver),
      ]);
      for (const [what, a] of attempts) {
        expect(a.outcome, what).toBe('rejected');
        expect(a.code, `${what}: ${JSON.stringify(a)}`).toBe('quota_exceeded');
      }
      await page.reload();
      await page.waitForSelector('body[data-ready="1"]');
      const after = await page.evaluate((d) => window.__localdata.vecPersistCheck(d, 2000), driver);
      expect(after.match, 'the same top-k after a reload').toBe(true);
      expect(after.info?.rows).toBe(2000);
      expect(after.info?.totalRows).toBe(2000);
      expect(base.hits.keys.length).toBe(10);
      // and the namespace is writable again once the quota is back
      const ok = await page.evaluate((d) => window.__localdata.vecTryWrite(d, 5000, 100), driver);
      expect(ok.outcome).toBe('resolved');
    } finally {
      await ctx.close();
    }
  });

  test(`closing the page during a write leaves the previous index intact on reopen (${driver})`, async () => {
    test.setTimeout(300_000);
    const profile = freshProfile(`close-${driver}`);
    const ctx = await launch(profile);
    try {
      const page = await ctx.newPage();
      await ready(page);
      await page.evaluate((d) => window.__localdata.vecQuotaBase(d, 1500), driver);
      await page.evaluate(([d, n]) => window.__localdata.vecStartWrite(d, 5000, n), [
        driver,
        100000,
      ] as const);
      // close while the write is genuinely mid-flight: parts written, HEAD not yet
      await page.waitForFunction(
        () => ((window as unknown as { __rows?: number }).__rows ?? 0) >= 12000,
        undefined,
        { timeout: 60_000 },
      );
      await page.close({ runBeforeUnload: false });
      const next = await ctx.newPage();
      await ready(next);
      const after = await next.evaluate((d) => window.__localdata.vecPersistCheck(d, 1500), driver);
      expect(after.match, 'the previous index answers identically').toBe(true);
      expect(after.info?.rows).toBe(1500);
      const ok = await next.evaluate((d) => window.__localdata.vecTryWrite(d, 5000, 100), driver);
      expect(ok.outcome).toBe('resolved');
    } finally {
      await ctx.close();
    }
  });
}

test('with OPFS unavailable, auto falls back to IndexedDB and the vector index works', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await ready(page);
  const r = await page.evaluate(() => window.__localdata.vecFallbackCheck(3000));
  expect(r.opfsAvailable).toBe(false);
  expect(r.driver).toBe('indexeddb');
  expect(r.match).toBe(true);
  expect(r.rows).toBe(3000);
});

test('no console error and no request outside the harness origin in any scenario above', async () => {
  expect(consoleErrors).toEqual([]);
  expect(foreign).toEqual([]);
});
