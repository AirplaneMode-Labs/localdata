#!/usr/bin/env node
// The size of the two embedded ldvec WebAssembly modules: the one figure the documents quote about them ("under 100 KB",
// docs/vector-index.md section 3 and the CHANGELOG), recorded as raw rows in docs/benchmarks/wasm-size.csv so the claim
// has a committed file behind it. The rows are read from src/wasm/ldvec.gen.ts, which scripts/build-wasm.mjs writes
// (run `npm run build:wasm` first); nothing in the CSV is typed by hand: the commit is `git describe --always --dirty`,
// the machine comes from os.cpus() and os.totalmem(), the toolchain from `rustc --version` in this repository, and
// the sizes and sha256 values from the decoded modules themselves.
//
//   node scripts/bench-wasm-size.mjs            print the rows
//   node scripts/bench-wasm-size.mjs --write    write docs/benchmarks/wasm-size.csv
//   node scripts/bench-wasm-size.mjs --check    exit 1 unless the built modules are within the budget and the committed
//                                               CSV records the same budget and sizes within it (the bytes themselves are
//                                               not compared: only macOS has been shown to rebuild them byte for byte)
//
// The budget is the one test/ldvec-wasm.test.ts asserts: 100 KiB = 102,400 bytes per module.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsv } from './bench-csv.mjs';

export { parseCsv };

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WASM_SIZE_CSV = join(repoRoot, 'docs', 'benchmarks', 'wasm-size.csv');
export const GEN = join(repoRoot, 'src', 'wasm', 'ldvec.gen.ts');
export const BUDGET_BYTES = 100 * 1024;
export const COMMAND = 'npm run bench:wasm-size';

export const WASM_SIZE_COLUMNS = [
  'commit',
  'date_utc',
  'machine',
  'os',
  'toolchain',
  'command',
  'module',
  'bytes',
  'sha256',
  'budget_bytes',
  'within_budget',
];

const quote = (v) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const wasmSizeHeader = () => `${WASM_SIZE_COLUMNS.join(',')}\n`;
export const wasmSizeRow = (o) => `${WASM_SIZE_COLUMNS.map((c) => quote(o[c] ?? '')).join(',')}\n`;

/** The decoded modules of a generated ldvec.gen.ts: `{ simd, scalar }` as Buffers, checked against the recorded sha256. */
export function readModules(path = GEN) {
  if (!existsSync(path)) throw new Error(`${path} is missing: run npm run build:wasm first`);
  const text = readFileSync(path, 'utf8');
  const out = {};
  for (const [kind, name] of [
    ['simd', 'LDVEC_SIMD'],
    ['scalar', 'LDVEC_SCALAR'],
  ]) {
    const b64 = new RegExp(`export const ${name}_B64 = '([A-Za-z0-9+/=]+)';`).exec(text)?.[1];
    const sha = new RegExp(`export const ${name}_SHA256 = '([0-9a-f]{64})';`).exec(text)?.[1];
    if (b64 === undefined || sha === undefined) throw new Error(`${path} has no ${kind} module`);
    const bytes = Buffer.from(b64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw new Error(`${path}: the ${kind} module does not match its recorded sha256`);
    out[kind] = bytes;
  }
  return out;
}

const git = (...a) =>
  execFileSync('git', ['-C', repoRoot, ...a], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

/** The rows as objects: provenance from this machine and this checkout, sizes from the modules. */
export function measure(modules = readModules()) {
  const commit = git('describe', '--always', '--dirty');
  const cpus = os.cpus();
  const machine = `${cpus[0]?.model ?? 'unknown cpu'}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
  const toolchain = execFileSync('rustc', ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return ['simd', 'scalar'].map((module) => {
    const bytes = modules[module];
    return {
      commit,
      date_utc: date,
      machine,
      os: `${os.platform()} ${os.arch()} ${os.release()}`,
      toolchain,
      command: COMMAND,
      module,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      budget_bytes: BUDGET_BYTES,
      within_budget: bytes.length < BUDGET_BYTES,
    };
  });
}

/** Problems with the committed CSV; `built` is the modules of this checkout, when there are any. */
export function checkCsv(rows, built) {
  const problems = [];
  if (rows.length === 0) problems.push('wasm-size.csv has no rows');
  for (const module of ['simd', 'scalar']) {
    const r = rows.find((x) => x.module === module);
    if (r === undefined) {
      problems.push(`wasm-size.csv has no ${module} row`);
      continue;
    }
    if (Number(r.budget_bytes) !== BUDGET_BYTES)
      problems.push(`${module}: the recorded budget is not ${BUDGET_BYTES}`);
    if (!(Number(r.bytes) < BUDGET_BYTES))
      problems.push(`${module}: the recorded size is over budget`);
    if (r.within_budget !== 'true') problems.push(`${module}: within_budget is not true`);
  }
  if (built !== undefined)
    for (const module of ['simd', 'scalar'])
      if (!(built[module].length < BUDGET_BYTES))
        problems.push(
          `${module}: the built module is ${built[module].length} bytes, over the budget`,
        );
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const rows = parseCsv(readFileSync(WASM_SIZE_CSV, 'utf8'));
    const built = existsSync(GEN) ? readModules() : undefined;
    const problems = checkCsv(rows, built);
    for (const p of problems) console.error(`bench-wasm-size --check: ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(
      `bench-wasm-size --check: ok (${rows.length} rows${built === undefined ? ', no built modules to compare' : ''})`,
    );
  } else {
    const rows = measure();
    const text = wasmSizeHeader() + rows.map(wasmSizeRow).join('');
    if (process.argv.includes('--write')) {
      writeFileSync(WASM_SIZE_CSV, text);
      console.log(`wrote ${WASM_SIZE_CSV}`);
    } else process.stdout.write(text);
  }
}
