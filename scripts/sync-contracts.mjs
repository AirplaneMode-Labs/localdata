#!/usr/bin/env node
// Copies the Storage API contract from the sibling runtime repository (../runtime/spec) into
// src/contracts/, prepending the vendoring header. The source of truth is runtime/spec; never edit
// the vendored copy by hand. Exits 0 and prints a notice when the sibling is absent.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

export const CONTRACTS = [
  {
    source: resolve(repo, '..', 'runtime', 'spec', 'storage-api.ts'),
    target: resolve(repo, 'src', 'contracts', 'storage-api.ts'),
    header:
      '// Vendored from AirplaneMode-Labs/runtime spec/storage-api.ts @ 0.1.0; source of truth is runtime/spec; do not edit here\n',
  },
];

export function vendoredBody(text) {
  // Strip the single-line vendoring header so the remainder can be diffed against the source.
  const nl = text.indexOf('\n');
  return text.startsWith('// Vendored from ') && nl !== -1 ? text.slice(nl + 1) : text;
}

export function sync({ write = true } = {}) {
  const results = [];
  for (const c of CONTRACTS) {
    if (!existsSync(c.source)) {
      results.push({ target: c.target, status: 'source-missing' });
      continue;
    }
    const src = readFileSync(c.source, 'utf8');
    const current = existsSync(c.target) ? readFileSync(c.target, 'utf8') : '';
    const inSync = vendoredBody(current) === src;
    if (!inSync && write) writeFileSync(c.target, c.header + src);
    results.push({ target: c.target, status: inSync ? 'in-sync' : write ? 'updated' : 'drift' });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  for (const r of sync({ write: !check })) console.log(`${r.status}\t${r.target}`);
}
