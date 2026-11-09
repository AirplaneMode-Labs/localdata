#!/usr/bin/env node
// Builds the public demo into demo/dist: bundles demo/app.ts with tsup (the same bundler the
// browser test harness uses), copies index.html (with the build id substituted) and styles.css, and
// writes build.json. Run by `npm run demo:build`, by ci.yml and by .github/workflows/pages.yml.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');
const rawSha = process.env.GITHUB_SHA ?? '';
const sha = /^[0-9a-f]{40}$/.test(rawSha) ? rawSha.slice(0, 12) : 'local';

await build({
  entry: { app: join(here, 'app.ts') },
  outDir,
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  clean: true,
  silent: true,
  config: false,
});

mkdirSync(outDir, { recursive: true });
const html = readFileSync(join(here, 'index.html'), 'utf8');
if (!html.includes('__BUILD_SHA__')) {
  throw new Error('demo/index.html lost its __BUILD_SHA__ placeholder');
}
// The id goes into a data attribute (hex or 'local' only); demo/app.ts renders it with textContent.
writeFileSync(join(outDir, 'index.html'), html.replace('__BUILD_SHA__', sha));
copyFileSync(join(here, 'styles.css'), join(outDir, 'styles.css'));
writeFileSync(join(outDir, 'build.json'), `${JSON.stringify({ sha })}\n`);
console.log(`[demo] built ${outDir} (sha ${sha})`);
