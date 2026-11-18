// Playwright config for `npm run bench:vectors` (bench/vector-bench.spec.ts) and `npm run bench:documents`
// (bench/documents-bench.spec.ts): installed Chrome, one
// worker, a long timeout. The bench spec launches its own persistent contexts (with
// --enable-precise-memory-info) on a profile directory it is given; this config only supplies the
// harness server and the test location.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'playwright/test';
import { BASE_URL, PORT } from './playwright.config';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default defineConfig({
  testDir: resolve(repoRoot, 'bench'),
  testMatch: /(vector|documents)-bench\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 3_600_000,
  reporter: [['list']],
  outputDir: resolve(repoRoot, 'test-results'),
  use: { baseURL: BASE_URL, channel: 'chrome' },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
  webServer: {
    command: `node test/browser/serve.mjs --port ${PORT} --build`,
    url: `${BASE_URL}/`,
    cwd: repoRoot,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
