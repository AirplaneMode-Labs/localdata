// D4-02 in installed Chrome (channel "chrome"): the documents API over real OPFS and IndexedDB.
//   * the shared cases (test/documents.behaviour.ts) pass on both drivers, each across a reopen;
//   * a document and its chunks survive page.reload() and a full browser relaunch, and a deleted one stays
//     gone;
//   * clear(ns) physically removes the document namespace: the browser's own listing (OPFS directories,
//     IndexedDB records) shows 0 entries for it;
//   * a page closed in the middle of a putDocument leaves no record and no chunk of that document;
//   * no console error and no request outside the harness origin.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, expect, test, type Page } from 'playwright/test';
import { BASE_URL } from './playwright.config';
import { documentCases } from '../documents.behaviour';

type DriverName = 'opfs' | 'indexeddb';
const DRIVERS: DriverName[] = ['opfs', 'indexeddb'];

const BASE_PROFILE =
  process.env['LOCALDATA_PROFILE_DIR'] ?? mkdtempSync(join(tmpdir(), 'chrome-profile-docs-'));
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

test.describe.configure({ mode: 'serial' });

for (const driver of DRIVERS) {
  test(`the documents cases pass against the ${driver} driver, each across a reopen`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await ready(page);
    const results = await page.evaluate((d) => window.__localdata.runDocumentCases(d), driver);
    expect(results.map((r) => r.name)).toEqual(documentCases.map((c) => c.name));
    const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);
    expect(failures, failures.join('\n')).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(foreign).toEqual([]);
  });

  test(`documents persist across page.reload() and a browser relaunch (${driver})`, async () => {
    test.setTimeout(300_000);
    const profile = freshProfile(`docs-${driver}`);
    let ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome' });
    try {
      const page = await ctx.newPage();
      await ready(page);
      await page.evaluate((d) => window.__localdata.docPersistWrite(d), driver);
      await page.reload();
      await page.waitForSelector('body[data-ready="1"]');
      const after = await page.evaluate((d) => window.__localdata.docPersistCheck(d), driver);
      expect(after.docs).toEqual(['survivor']);
      expect(after.chunks).toEqual([24]);
      expect(after.top[0]).toEqual({ docId: 'survivor', ordinal: 7, page: 2 });
      expect(after.createdAt).toEqual([1_700_000_000_000]);
    } finally {
      await ctx.close();
    }
    ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome' });
    try {
      const page = await ctx.newPage();
      await ready(page);
      const again = await page.evaluate((d) => window.__localdata.docPersistCheck(d), driver);
      expect(again.docs).toEqual(['survivor']);
      expect(again.top[0]).toEqual({ docId: 'survivor', ordinal: 7, page: 2 });
      expect(again.text).toBe('doc 1 chunk 7 xxxxxx');
    } finally {
      await ctx.close();
    }
  });

  test(`clear(ns) leaves 0 files and 0 records for the document namespace in the browser's own listing (${driver})`, async ({
    page,
  }) => {
    await ready(page);
    const driverNs = '__ld_doc.dockit.dphysical';
    const r = await page.evaluate(
      async ([d, ns]) => {
        await window.__localdata.reset(d);
        const s = await window.__localdata.openForTest(d);
        const { makeChunksForSpec } = window.__localdata;
        await s.putDocument(
          'dockit.dphysical',
          makeChunksForSpec.doc('physical'),
          makeChunksForSpec.chunks(1, 40),
        );
        await s.putDocument(
          'dockit.dkeep',
          makeChunksForSpec.doc('keep'),
          makeChunksForSpec.chunks(2, 10),
        );
        await s.deleteDocument('dockit.dphysical', 'physical');
        const before = await window.__localdata.rawNamespaceListing(d, ns);
        await s.clear('dockit.dphysical');
        const after = await window.__localdata.rawNamespaceListing(d, ns);
        const kept = await window.__localdata.rawNamespaceListing(d, '__ld_doc.dockit.dkeep');
        const reopened = await window.__localdata.openForTest(d);
        const chunks = await reopened.queryChunks(
          'dockit.dphysical',
          makeChunksForSpec.chunks(1, 1)[0]!.vector,
          5,
        );
        await reopened.close();
        await s.close();
        return { before, after, kept, chunks: chunks.length };
      },
      [driver, driverNs] as const,
    );
    expect(r.before.records, 'a deleted document still occupies its namespace').toBeGreaterThan(0);
    expect(r.after.records, 'zero files / records after clear').toBe(0);
    expect(r.after.files).toEqual([]);
    expect(r.after.namespaces.filter((n) => n === driverNs)).toEqual([]);
    expect(r.kept.records, 'another namespace is untouched').toBeGreaterThan(0);
    expect(r.chunks).toBe(0);
  });

  test(`a page closed in the middle of putDocument leaves no record and no chunk (${driver})`, async () => {
    test.setTimeout(300_000);
    const profile = freshProfile(`docs-close-${driver}`);
    let ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome' });
    try {
      const page = await ctx.newPage();
      await ready(page);
      await page.evaluate((d) => window.__localdata.reset(d), driver);
      await page.evaluate(([d, n]) => window.__localdata.docStartWrite(d, n), [
        driver,
        2000,
      ] as const);
      await page.waitForFunction(
        () => ((window as unknown as { __chunks?: number }).__chunks ?? 0) >= 600,
        undefined,
        { timeout: 120_000 },
      );
    } finally {
      await ctx.close();
    }
    ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome' });
    try {
      const page = await ctx.newPage();
      await ready(page);
      const seen = await page.evaluate((d) => window.__localdata.docVisible(d), driver);
      expect(seen).toEqual({ doc: false, hits: 0, docs: 0 });
    } finally {
      await ctx.close();
    }
  });
}
