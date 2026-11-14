#!/usr/bin/env node
// Regenerates the benchmark block of README.md from docs/benchmarks/vector-index.csv, the only source.
//   node scripts/bench-readme.mjs           print the block
//   node scripts/bench-readme.mjs --write   replace the block between the bench:begin/end markers
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, parseCsv, renderBench } from './bench-csv.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rows = parseCsv(readFileSync(join(repo, 'docs', 'benchmarks', 'vector-index.csv'), 'utf8'));
if (rows.length === 0) throw new Error('docs/benchmarks/vector-index.csv has no rows');
const block = renderBench(rows);
if (process.argv.includes('--write')) {
  const readme = join(repo, 'README.md');
  const text = readFileSync(readme, 'utf8');
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error('README.md has no bench:begin / bench:end markers');
  writeFileSync(readme, `${text.slice(0, a)}${BEGIN}\n\n${block}\n\n${text.slice(b)}`);
  console.log('README.md benchmark block rewritten from the CSV');
} else console.log(block);
