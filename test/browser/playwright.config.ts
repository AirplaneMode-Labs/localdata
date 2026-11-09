import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from 'playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
export const PORT = 4177;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: resolve(repoRoot, 'test-results'),
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: `node test/browser/serve.mjs --port ${PORT} --build`,
    url: `${BASE_URL}/`,
    cwd: repoRoot,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
