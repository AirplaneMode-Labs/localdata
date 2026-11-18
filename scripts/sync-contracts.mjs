#!/usr/bin/env node
// Copies the two contracts localdata vendors from the sibling runtime repository (../runtime/spec)
// into src/contracts/, prepending the vendoring header: storage-api.ts @ 0.3.0 and event.ts @ 0.1.4.
// The source of truth is runtime/spec; never edit a vendored copy by hand.
//
// The copy is gated on the spec release's SPEC-LANDED.txt (one `sha256  path` line per spec file):
// every source file must hash to its recorded value, otherwise NOTHING is copied. SPEC-LANDED.txt is
// looked up in this order, the same order dockit uses:
//   1. the SPEC_LANDED environment variable (a path; if set and missing, that is an error);
//   2. the highest-numbered <workspace>/evidence/sprint-<n>/D1/SPEC-LANDED.txt, the committed copy
//      beside this repository (numbers compared as numbers: sprint-10 beats sprint-4).
// With neither, the script exits 1 and copies nothing.
//
//   node scripts/sync-contracts.mjs            copy (when the hashes match)
//   node scripts/sync-contracts.mjs --check    report in-sync or drift, write nothing, exit 1 on drift
//   --spec-dir <dir>        read the contracts from <dir> instead of ../runtime/spec (tests)
//   --evidence-root <dir>   look for sprint-<n>/D1/SPEC-LANDED.txt under <dir> instead of
//                           <workspace>/evidence (tests)
//
// Exits 0 with a notice when ../runtime/spec is absent (a standalone clone has nothing to sync).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

export const DEFAULT_SPEC_DIR = resolve(repo, '..', 'runtime', 'spec');
export const DEFAULT_OUT_DIR = resolve(repo, 'src', 'contracts');

// Each contract carries its own version (spec release 0.5.0): the header names that contract's
// version, not the release's.
export const CONTRACT_VERSIONS = {
  'storage-api.ts': '0.3.0',
  'event.ts': '0.1.4',
};
export const CONTRACT_FILES = Object.keys(CONTRACT_VERSIONS);

export const header = (file) => {
  const version = CONTRACT_VERSIONS[file];
  if (version === undefined) throw new Error(`sync-contracts: no version recorded for ${file}`);
  return `// Vendored from AirplaneMode-Labs/runtime spec/${file} @ ${version}; source of truth is runtime/spec; do not edit here\n`;
};

export const CONTRACTS = CONTRACT_FILES.map((file) => ({
  file,
  source: join(DEFAULT_SPEC_DIR, file),
  target: join(DEFAULT_OUT_DIR, file),
  header: header(file),
}));

export function vendoredBody(text) {
  // Strip the single-line vendoring header so the remainder can be diffed against the source.
  const nl = text.indexOf('\n');
  return text.startsWith('// Vendored from ') && nl !== -1 ? text.slice(nl + 1) : text;
}

/**
 * Parses `shasum -a 256` style lines into Map<listed path, sha256>. The key is the path as listed with a
 * leading `./` and, since spec release 0.5.0, a single leading `spec/` removed (that release lists
 * `spec/<path>`; earlier releases listed `<path>`), so `README.md` and `vectors/README.md` stay distinct
 * and both listings read alike. Lines that are not `<64 hex>  <path>` are ignored.
 */
export function parseLanded(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/u.exec(line.trim());
    if (m) map.set(m[2].replace(/^\.\//u, '').replace(/^spec\//u, ''), m[1]);
  }
  return map;
}

/** The default folder that holds the committed per-sprint evidence, beside this repository. */
export const DEFAULT_EVIDENCE_ROOT = resolve(repo, '..', 'evidence');

const SPRINT_DIR = /^sprint-(\d+)$/u;

/**
 * Where SPEC-LANDED.txt is read from (see the header comment for the order). Returns
 * `{ path, source: 'env' | 'evidence' }`; `{ ..., missing: true }` when SPEC_LANDED names
 * a file that does not exist (never a silent fall-through); undefined when none exists. A sprint
 * folder without a D1/SPEC-LANDED.txt is skipped.
 * @param {{ env?: Record<string, string | undefined>, repo?: string, evidenceRoot?: string, exists?: (p: string) => boolean, list?: (dir: string) => string[] }} [opts]
 */
export function findSpecLanded({
  env = process.env,
  repo: repoRoot = repo,
  evidenceRoot = resolve(repoRoot, '..', 'evidence'),
  exists = existsSync,
  list = (dir) => (existsSync(dir) ? readdirSync(dir) : []),
} = {}) {
  const fromEnv = env['SPEC_LANDED'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const path = resolve(fromEnv);
    return exists(path) ? { path, source: 'env' } : { path, source: 'env', missing: true };
  }
  const sprints = list(evidenceRoot)
    .map((name) => ({ name, m: SPRINT_DIR.exec(name) }))
    .filter((x) => x.m !== null)
    .map((x) => ({ name: x.name, n: Number(x.m[1]) }))
    .sort((a, b) => b.n - a.n);
  for (const { name } of sprints) {
    const path = join(evidenceRoot, name, 'D1', 'SPEC-LANDED.txt');
    if (exists(path)) return { path, source: 'evidence' };
  }
  return undefined;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Compare (and optionally rewrite) every vendored contract against runtime/spec. Returns one
 * `{ file, target, status }` per contract with status 'in-sync' | 'drift' | 'updated' |
 * 'source-missing' | 'sha-mismatch' | 'sha-missing' | 'blocked'. Nothing is written when `write` is
 * false. When `landed` (from parseLanded) is given, every source file's sha256 must equal its entry:
 * any mismatch, absent entry or missing source fails the whole sync, nothing is written, and the
 * files that checked out are reported as 'blocked'.
 * @param {{ specDir?: string, outDir?: string, write?: boolean, landed?: Map<string, string> }} [opts]
 */
export function sync({
  specDir = DEFAULT_SPEC_DIR,
  outDir = DEFAULT_OUT_DIR,
  write = true,
  landed = undefined,
} = {}) {
  if (landed !== undefined) {
    const checks = CONTRACT_FILES.map((file) => {
      const source = join(specDir, file);
      const target = join(outDir, file);
      if (!existsSync(source)) return { file, target, status: 'source-missing' };
      const want = landed.get(file);
      if (want === undefined) return { file, target, status: 'sha-missing' };
      const got = sha256(readFileSync(source));
      return { file, target, status: want === got ? 'ok' : 'sha-mismatch' };
    });
    if (checks.some((r) => r.status !== 'ok'))
      return checks.map((r) => (r.status === 'ok' ? { ...r, status: 'blocked' } : r));
  }
  const results = [];
  for (const file of CONTRACT_FILES) {
    const source = join(specDir, file);
    const target = join(outDir, file);
    if (!existsSync(source)) {
      results.push({ file, target, status: 'source-missing' });
      continue;
    }
    const src = readFileSync(source, 'utf8');
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const inSync = vendoredBody(current) === src;
    if (!inSync && write) writeFileSync(target, header(file) + src);
    results.push({ file, target, status: inSync ? 'in-sync' : write ? 'updated' : 'drift' });
  }
  return results;
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? resolve(process.argv[i + 1]) : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specDir = argValue('--spec-dir') ?? DEFAULT_SPEC_DIR;
  const evidenceRoot = argValue('--evidence-root') ?? DEFAULT_EVIDENCE_ROOT;
  if (!existsSync(specDir)) {
    console.log(`sync-contracts: ${specDir} not found; nothing to do`);
    process.exit(0);
  }
  const located = findSpecLanded({ evidenceRoot });
  if (located === undefined || located.missing) {
    const where = located
      ? `SPEC_LANDED=${located.path}`
      : join(evidenceRoot, 'sprint-<n>', 'D1', 'SPEC-LANDED.txt');
    console.error(
      `sync-contracts: SPEC-LANDED.txt not found (${where}): set SPEC_LANDED or copy it to the evidence folder; nothing synced`,
    );
    process.exit(1);
  }
  console.log(`sync-contracts: SPEC-LANDED.txt from ${located.source}: ${located.path}`);
  const landed = parseLanded(readFileSync(located.path, 'utf8'));
  const check = process.argv.includes('--check');
  const results = sync({ specDir, write: !check, landed });
  for (const r of results) console.log(`${r.status}\t${r.target}`);
  const bad = new Set(['drift', 'sha-mismatch', 'sha-missing', 'source-missing', 'blocked']);
  if (results.some((r) => bad.has(r.status))) process.exit(1);
}
