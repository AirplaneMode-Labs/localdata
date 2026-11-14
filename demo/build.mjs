#!/usr/bin/env node
// Builds the public demo into demo/dist: bundles demo/app.ts with tsup (the same bundler the
// browser test harness uses), copies index.html (with the build id substituted) and styles.css, and
// writes build.json. Run by `npm run demo:build`, by ci.yml and by .github/workflows/pages.yml.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { parseCsv } from '../scripts/bench-csv.mjs';

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
// The storage warning's figure comes from the benchmark CSV: the median index size of the OPFS
// 100,000 x 384 rows with 256-byte chunks, rounded to a whole number of MB. A missing figure fails the
// build rather than showing a made-up number.
const csv = parseCsv(
  readFileSync(join(here, '..', 'docs', 'benchmarks', 'vector-index.csv'), 'utf8'),
);
const sizes = csv
  .filter(
    (r) =>
      r.driver === 'opfs' && r.rows === '100000' && r.chunk_bytes === '256' && r.restart !== 'true',
  )
  .map((r) => Number(r.index_bytes))
  .sort((a, b) => a - b);
if (sizes.length === 0 || !sizes.every(Number.isFinite)) {
  throw new Error(
    'docs/benchmarks/vector-index.csv has no OPFS 100,000 x 256-byte index_bytes rows',
  );
}
const indexMb = String(Math.round(sizes[sizes.length >> 1] / 1e6));
if (!/^[0-9]{1,5}$/.test(indexMb)) throw new Error(`implausible index size ${indexMb}`);
if (!html.includes('__INDEX_MB__'))
  throw new Error('demo/index.html lost its __INDEX_MB__ placeholder');
// The id goes into a data attribute (hex or 'local' only); demo/app.ts renders it with textContent.
writeFileSync(
  join(outDir, 'index.html'),
  html.replace('__BUILD_SHA__', sha).replaceAll('__INDEX_MB__', indexMb),
);
copyFileSync(join(here, 'styles.css'), join(outDir, 'styles.css'));
writeFileSync(join(outDir, 'build.json'), `${JSON.stringify({ sha })}\n`);
console.log(`[demo] built ${outDir} (sha ${sha})`);
