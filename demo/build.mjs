#!/usr/bin/env node
// Builds the public demo into demo/dist: bundles demo/app.ts with tsup (the same bundler the
// browser test harness uses), copies index.html (with the build id substituted) and styles.css, and
// writes build.json. Run by `npm run demo:build`, by ci.yml and by .github/workflows/pages.yml.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { parseCsv } from '../scripts/bench-csv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');
const rawSha = process.env.GITHUB_SHA ?? '';
const repo = resolve(here, '..');

/**
 * The build id the page shows: 'Built from main at <sha12>' in CI, otherwise 'Local build <sha12>[-dirty]'
 * from this repository's own HEAD (only when git's top level IS this directory, so an unrelated parent
 * repository is never read), or 'Local build local' when there is no repository.
 */
function buildId() {
  if (/^[0-9a-f]{40}$/.test(rawSha))
    return { sha: rawSha.slice(0, 12), id: `Built from main at ${rawSha.slice(0, 12)}` };
  try {
    const git = (...a) =>
      execFileSync('git', ['-C', repo, ...a], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(repo))
      throw new Error('not its own repository');
    const sha = git('rev-parse', '--short=12', 'HEAD');
    if (!/^[0-9a-f]{12}$/.test(sha)) throw new Error('no sha');
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    return { sha, id: `Local build ${sha}${dirty ? '-dirty' : ''}` };
  } catch {
    return { sha: 'local', id: 'Local build local' };
  }
}
const { sha, id: buildLabel } = buildId();

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
if (!html.includes('__BUILD_ID__')) {
  throw new Error('demo/index.html lost its __BUILD_ID__ placeholder');
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
// The id goes into a data attribute (letters, hex, spaces and a hyphen only); demo/app.ts checks it against a
// fixed pattern and renders it with textContent.
writeFileSync(
  join(outDir, 'index.html'),
  html.replace('__BUILD_ID__', buildLabel).replaceAll('__INDEX_MB__', indexMb),
);
copyFileSync(join(here, 'styles.css'), join(outDir, 'styles.css'));
writeFileSync(join(outDir, 'build.json'), `${JSON.stringify({ sha, id: buildLabel })}\n`);
console.log(`[demo] built ${outDir} (${buildLabel})`);
