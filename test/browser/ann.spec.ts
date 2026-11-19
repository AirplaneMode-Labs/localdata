// D4-04 in installed Chrome (channel "chrome"): the HNSW index kind over real OPFS and IndexedDB.
//   * the shared HNSW suite (test/ann.behaviour.ts) passes on both drivers
//   * smoke: build a graph, query it, close the page and reopen, query again; then relaunch the browser on
//     the same profile and query again: the same hits from the stored graph, no rebuild, answered by hnsw
//   * no console error and no request outside the harness origin
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import { BASE_URL } from './playwright.config';
import { annCases } from '../ann.behaviour';

type DriverName = 'opfs' | 'indexeddb';
const DRIVERS: DriverName[] = ['opfs', 'indexeddb'];

const BASE_PROFILE =
  process.env['LOCALDATA_PROFILE_DIR'] ?? mkdtempSync(join(tmpdir(), 'chrome-profile-ann-'));
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
  return chromium.launchPersistentContext(profile, { channel: 'chrome' });
}

test.describe.configure({ mode: 'serial' });

for (const driver of DRIVERS) {
  test(`the HNSW suite passes against the ${driver} driver`, async ({ page }) => {
    test.setTimeout(600_000);
    await ready(page);
    const results = await page.evaluate((d) => window.__localdata.runAnnSuite(d), driver);
    expect(results.map((r) => r.name)).toEqual(annCases.map((c) => c.name));
    const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test(`smoke (${driver}): build, query, close the page, reopen, query; then relaunch the browser`, async () => {
    test.setTimeout(300_000);
    const rows = 2000;
    const profile = freshProfile(`smoke-${driver}`);
    let first: { hnsw: string[]; flat: string[]; bits: number[] };
    let ctx = await launch(profile);
    try {
      const page = await ctx.newPage();
      await ready(page);
      const w = await page.evaluate(([d, n]) => window.__localdata.annPersistWrite(d, n), [
        driver,
        rows,
      ] as const);
      first = w;
      expect(w.built.liveRows).toBe(rows);
      expect(w.built.bytes).toBeGreaterThan(0);
      expect(w.hnsw.length).toBe(10);
      const overlap = w.hnsw.filter((k) => w.flat.includes(k)).length;
      expect(overlap, 'hnsw answers overlap the flat answers').toBeGreaterThanOrEqual(8);
      await page.close(); // the page is gone; the graph must be on the driver
      const again = await ctx.newPage();
      await ready(again);
      const r = await again.evaluate(([d, n]) => window.__localdata.annPersistCheck(d, n), [
        driver,
        rows,
      ] as const);
      expect(r.info?.ann?.current).toBe(true);
      expect(r.info?.ann?.nodes).toBe(rows);
      expect(r.answeredBy).toBe('hnsw');
      expect(r.fallback).toBe('');
      expect(r.rebuilds).toBe(0);
      expect(r.hnsw).toEqual(first.hnsw);
      expect(r.bits).toEqual(first.bits);
    } finally {
      await ctx.close();
    }
    ctx = await launch(profile);
    try {
      const page = await ctx.newPage();
      await ready(page);
      const r = await page.evaluate(([d, n]) => window.__localdata.annPersistCheck(d, n), [
        driver,
        rows,
      ] as const);
      expect(r.info?.ann?.current).toBe(true);
      expect(r.answeredBy).toBe('hnsw');
      expect(r.rebuilds).toBe(0);
      expect(r.hnsw).toEqual(first.hnsw);
      expect(r.coldMs).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });
}

test('no console error and no request outside the harness origin', () => {
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  expect(foreign, foreign.join('\n')).toEqual([]);
});
