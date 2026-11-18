#!/usr/bin/env node
// Regenerates the documents benchmark block of README.md from docs/benchmarks/documents.csv, the only source.
//   node scripts/bench-docs-readme.mjs           print the block
//   node scripts/bench-docs-readme.mjs --write   replace the block between the docs-bench:begin/end markers
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, parseCsv, renderDocsBench } from './bench-docs-csv.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rows = parseCsv(readFileSync(join(repo, 'docs', 'benchmarks', 'documents.csv'), 'utf8'));
if (rows.length === 0) throw new Error('docs/benchmarks/documents.csv has no rows');
const block = renderDocsBench(rows);
if (process.argv.includes('--write')) {
  const readme = join(repo, 'README.md');
  const text = readFileSync(readme, 'utf8');
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error('README.md has no docs-bench:begin / docs-bench:end markers');
  writeFileSync(readme, `${text.slice(0, a)}${BEGIN}\n\n${block}\n\n${text.slice(b)}`);
  console.log('README.md documents benchmark block rewritten from the CSV');
} else console.log(block);
