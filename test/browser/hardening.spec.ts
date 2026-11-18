// D4-03 in installed Chrome (channel "chrome"), on real OPFS and IndexedDB:
//   S1-092   an oversize or truncated part is refused before it is read (Blob.prototype.arrayBuffer is
//            instrumented in the page), and an unparseable keys.json is corrupt/keys_json (OPFS);
//   T1-S4-08 orphan records planted next to a committed index are swept on open and counted in
//            storage.index.open swept; with the writer lock held by another page nothing is swept and the
//            read does not wait.
import { expect, test, type Page } from 'playwright/test';
import { BASE_URL } from './playwright.config';

type DriverName = 'opfs' | 'indexeddb';

async function ready(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('body[data-ready="1"]');
}

test('S1-092: an oversize or truncated record is refused on real OPFS before it is read', async ({
  page,
}) => {
  await ready(page);
  for (const [record, extra, reason] of [
    ['vec-0/00000', 1_048_576, 'length'],
    ['meta-0/00000', 1_048_576, 'length'],
    ['val-0/00000', 1_048_576, 'length'],
    ['vec-0/00000', -1, 'length'],
    ['vec-0/00000', 96 * 1024 * 1024, 'length'],
  ] as const) {
    const r = await page.evaluate(
      ([rec, ex]) => window.__localdata.hardenOversize('opfs', rec, ex),
      [record, extra] as const,
    );
    expect(r.code, `${record} ${extra}`).toBe('corrupt');
    expect(r.reason, `${record} ${extra}`).toBe('length');
    expect(r.file).toBe(record);
    expect(reason).toBe('length');
    expect(r.readPlanted, `${record} +${extra}: the planted file was read into memory`).toBe(false);
    expect(r.reads, 'the other records were read').toBeGreaterThan(0);
  }
});

test('S1-092: an oversize record on IndexedDB is refused as corrupt/length too (read whole, checked after)', async ({
  page,
}) => {
  await ready(page);
  const r = await page.evaluate(() =>
    window.__localdata.hardenOversize('indexeddb', 'vec-0/00000', 1_048_576),
  );
  expect(r.code).toBe('corrupt');
  expect(r.reason).toBe('length');
});

for (const [label, text] of [
  ['truncated JSON', '{"v":1,"k":{"head":{"h":"ab'],
  ['an empty file', ''],
  ['an array', '[]'],
  ['wrong version', '{"v":2,"k":{}}'],
] as const) {
  test(`S1-092: keys.json = ${label} is corrupt/keys_json on real OPFS, and clear(ns) recovers`, async ({
    page,
  }) => {
    await ready(page);
    const r = await page.evaluate((t) => window.__localdata.hardenKeysJson(t), text);
    expect(r.refused.code).toBe('corrupt');
    expect(r.refused.reason).toBe('keys_json');
    expect(r.afterClear).toBe(0);
    expect(r.rebuilt).toBe(5);
  });
}

for (const driver of ['opfs', 'indexeddb'] as DriverName[]) {
  test(`T1-S4-08: orphan records are swept on open and counted (${driver})`, async ({ page }) => {
    await ready(page);
    const r = await page.evaluate((d) => window.__localdata.sweepProbe(d), driver);
    expect(r.planted.length).toBe(r.before.length + 4);
    expect(r.after).toEqual(r.before);
    expect(r.swept[0]).toBe(4);
    expect(r.match, 'hits equal the reference after the sweep').toBe(true);
  });
}

test('T1-S4-08: with the writer lock held by another page nothing is swept and the read does not wait', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  try {
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    await ready(a);
    await ready(b);
    await a.evaluate(() => window.__localdata.hardenBuild('opfs'));
    expect(await a.evaluate(() => window.__localdata.holdWriterLock())).toBe(true);
    const locked = await b.evaluate(() => window.__localdata.sweepWhileLocked('opfs'));
    expect(locked.hits).toBe(5);
    expect(locked.swept[0]).toBe(0);
    expect(locked.remaining.length).toBe(4);
    expect(locked.ms, 'the read did not wait for the writer').toBeLessThan(5000);
    await a.evaluate(() => window.__localdata.releaseWriterLock());
    const free = await b.evaluate(() => window.__localdata.sweepWhileLocked('opfs'));
    expect(free.swept[0]).toBe(4);
    expect(free.remaining).toEqual([]);
  } finally {
    await ctx.close();
  }
});
