// D4-01 in installed Chrome (channel "chrome"): S1-100 and S1-101 over real OPFS and IndexedDB.
// The shared cases in test/proto.behaviour.ts close and reopen the store over the same storage;
// the spec also relaunches the browser on a persistent profile and reads the hostile keys back.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, expect, test } from 'playwright/test';
import { BASE_URL } from './playwright.config';
import { HOSTILE_KEYS, protoCases } from '../proto.behaviour';

type DriverName = 'opfs' | 'indexeddb';
const DRIVERS: DriverName[] = ['opfs', 'indexeddb'];

const BASE_PROFILE =
  process.env['LOCALDATA_PROFILE_DIR'] ?? mkdtempSync(join(tmpdir(), 'chrome-profile-proto-'));
function freshProfile(label: string): string {
  const dir = join(BASE_PROFILE, label);
  if (basename(BASE_PROFILE).startsWith('chrome-profile'))
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

for (const driver of DRIVERS) {
  test(`S1-100 and S1-101: every prototype-safety case passes on ${driver}, each across a reopen`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE_URL}/`);
    await page.waitForSelector('body[data-ready="1"]');
    const results = await page.evaluate((d) => window.__localdata.runProtoCases(d), driver);
    expect(results.map((r) => r.name)).toEqual(protoCases.map((c) => c.name));
    const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);
    expect(failures, failures.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`the hostile keys survive a full browser relaunch on ${driver}`, async () => {
    const profile = freshProfile(`proto-${driver}`);
    let ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome' });
    try {
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/`);
      await page.waitForSelector('body[data-ready="1"]');
      await page.evaluate(
        async ([d, keys]) => {
          await window.__localdata.reset(d);
          const store = await window.__localdata.openForTest(d);
          for (const k of keys) await store.set('protons', k, { k }, { ttlMs: 3_600_000 });
          await store.close();
        },
        [driver, HOSTILE_KEYS] as const,
      );
    } finally {
      await ctx.close();
    }
    ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome' });
    try {
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/`);
      await page.waitForSelector('body[data-ready="1"]');
      const seen = await page.evaluate(async (d) => {
        const store = await window.__localdata.openForTest(d);
        try {
          return {
            keys: (await store.list('protons')).keys,
            items: (await store.usage('protons')).items,
            first: await store.get('protons', '__proto__'),
          };
        } finally {
          await store.close();
        }
      }, driver);
      expect(seen.keys).toEqual([...HOSTILE_KEYS].sort());
      expect(seen.items).toBe(HOSTILE_KEYS.length);
      expect(seen.first).toEqual({ k: '__proto__' });
    } finally {
      await ctx.close();
    }
  });
}
