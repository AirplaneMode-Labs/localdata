#!/usr/bin/env node
// Release rehearsal for @airplanemode/localdata (Sprint 7, D4-04; TD-103, TD-106, TD-118; S1 hardening). Adapted
// from runtime's scripts/release/rehearse.mjs (regenerated from it: the proofs and their helpers are the same).
//
// One script, run locally (npm run release:rehearse) and by the CI job release-rehearsal (<os>) on Linux, macOS and
// Windows. It rehearses a release with the published RFC 8032 TEST 1 key, never a real key, and publishes nothing:
//
//   1. npm ci --ignore-scripts, npm run build:wasm (the Rust kernel, cargo --locked), npm run build, npm pack into
//      dist-release/ (the built artefact, as a release would build it)
//   2. clean-install check (B1): in a fresh directory OUTSIDE the checkout, with npm_config_offline=true, a fresh
//      npm_config_cache and --ignore-scripts, install the tarball (not the source tree), prove the module that runs
//      is the one under that directory's node_modules, and make real asserted calls on the memory backend: set and
//      get, putVectors of 200 seeded rows, buildIndex, an HNSW query answered by the graph and a flat query, and
//      the HNSW top 10 scores equal the flat top 10 scores
//   3. release manifest (id localdata-rehearsal, the rehearsal publisher), SHA256SUMS, sign with TEST 1
//   4. verify with the explicit test-key flags (ok, testKey true), then the refusal proofs (B2): each checks the exact
//      exit code, the exact first stderr line and the JSON reason, and an I/O error, a crash, a signal or a missing
//      tool never counts as a refusal
//   5. dist-release/ holds only the manifest entries, the manifest and SHA256SUMS, and no credential-like file
//   6. on Linux, publish-dry-run.mjs: npm publish --dry-run on the tarball (nothing is published)
//
// The release tool is the verifier vendored from runtime spec/tools (scripts/release/VENDORED.json records its
// sha256, and the rehearsal refuses a copy that differs). The report goes to dist-release-report/ (a sibling of
// dist-release/, never inside it). With the same SOURCE_DATE_EPOCH two runs give byte-identical
// release-manifest.json and SHA256SUMS.
//
//   node scripts/release/rehearse.mjs [--tool <path>] [--out <dir>] [--report <dir>] [--work <dir>]
//   node scripts/release/rehearse.mjs --self-test
//
// --self-test proves the proofs can fail: a missing tool, a tool that accepts everything, a tool that exits 1 with a
// refusal-looking message and a tool killed by a signal each turn the refusal proofs red.
// The script reads no GITHUB_* variable; SOURCE_DATE_EPOCH is read here and passed to the tool.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE = 'localdata';
export const TEST_KEY_SIGN_BANNER =
  'TEST KEY SIGNATURE (RFC 8032 TEST 1, published): rehearsal only, NOT A RELEASE';
export const TEST_KEY_VERIFY_BANNER =
  'VERIFIED WITH THE PUBLISHED RFC 8032 TEST KEY: rehearsal only, not a release';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** A minimal environment for a child that is not npm: nothing from the runner, nothing about a test key. */
function scrubbedEnv(extra = {}) {
  const keep = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'TMPDIR',
    'SystemRoot',
    'ComSpec',
  ];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** The environment for npm: the process environment without runner variables (GITHUB_*, CI, RUNNER_*). */
function npmEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GITHUB_|RUNNER_|CI$|ACTIONS_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, npm_config_update_notifier: 'false', ...extra };
}

/** True when `child` is `parent` or below it. On Windows, relative() across two drives returns an absolute path. */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** cmd.exe joins arguments without quoting them: quote the ones that need it (only used with shell: true). */
const cmdQuote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, opts.shell ? args.map(cmdQuote) : args, {
    encoding: 'utf8',
    shell: opts.shell ?? false,
    cwd: opts.cwd,
    env: opts.env ?? scrubbedEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

function npm(args, cwd, extraEnv = {}) {
  const r = run(NPM, args, { cwd, env: npmEnv(extraEnv), shell: process.platform === 'win32' });
  if (r.error || r.status !== 0)
    throw new Error(
      `npm ${args.join(' ')} failed (status ${r.status}, signal ${r.signal}): ${r.error?.message ?? ''}\n${r.stderr}`,
    );
  return r.stdout;
}

const fail = (message) => {
  throw new Error(`rehearsal: ${message}`);
};

// ---- refusal proofs (B2) ---------------------------------------------------------------------------------

const firstLine = (s) => (s ?? '').split('\n')[0] ?? '';

/**
 * Checks one run of the release tool against an expected exit code, first stderr line and reason. A crash (a spawn
 * error), a signal, an exit code that is not the expected one, or a first line that differs is a failure: an I/O
 * error (exit 1) or a missing tool can never pass for a refusal.
 */
export function expectOutcome(name, r, { exit, reason, ok }) {
  if (r.error) fail(`${name}: the tool could not be run (${r.error.code ?? r.error.message})`);
  if (r.signal) fail(`${name}: the tool was killed by ${r.signal}`);
  if (r.status !== exit)
    fail(`${name}: exit ${r.status}, expected ${exit} (stderr: ${firstLine(r.stderr)})`);
  const line = firstLine(r.stderr);
  if (exit === 3) {
    if (line !== `refused: ${reason}`)
      fail(`${name}: first stderr line is ${JSON.stringify(line)}, expected "refused: ${reason}"`);
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      fail(`${name}: stdout is not JSON`);
    }
    if (json.verdict !== 'refused' || json.reason !== reason)
      fail(`${name}: stdout JSON is ${r.stdout.trim()}, expected reason ${reason}`);
  } else if (exit === 2) {
    if (!line.startsWith(`usage: ${reason}: `))
      fail(
        `${name}: first stderr line is ${JSON.stringify(line)}, expected "usage: ${reason}: ..."`,
      );
    if (r.stdout !== '') fail(`${name}: a usage error must print nothing on stdout`);
  } else if (exit === 0) {
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      fail(`${name}: stdout is not JSON`);
    }
    for (const [k, v] of Object.entries(ok ?? {}))
      if (json[k] !== v)
        fail(`${name}: ${k} is ${JSON.stringify(json[k])}, expected ${JSON.stringify(v)}`);
  }
  return { name, exit, firstStderrLine: line, reason: reason ?? null };
}

/** Copies the directory (regular files only: the release directory has nothing else). */
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const n of readdirSync(src)) cpSync(join(src, n), join(dst, n));
}

/**
 * Runs the release tool: `node <tool> <args...>`. The tool path is the caller's: a missing path is a spawn that
 * fails or a node exit 1 ("Cannot find module"), never a refusal.
 */
export function runTool(tool, args, sde) {
  return run(process.execPath, [tool, ...args], {
    env: scrubbedEnv(sde !== undefined ? { SOURCE_DATE_EPOCH: String(sde) } : {}),
  });
}

/**
 * The proofs of B2 against a signed rehearsal directory `dir` (manifest id `<PACKAGE>-rehearsal`). `docsKeys` is the
 * repository's docs/release-keys.json. Throws on the first proof that does not hold; otherwise returns the records.
 */
export function proveRefusals({ tool, dir, docsKeys, work, sde }) {
  const id = `${PACKAGE}-rehearsal`;
  const releaseId = `${PACKAGE}-release`;
  const records = [];
  const rec = (r) => records.push(r);
  const verify = (d, ...args) => runTool(tool, ['verify', '--dir', d, ...args], sde);
  const FLAGS = ['--trust-test-key', '--allow-test-key'];

  rec(
    expectOutcome(
      'verify with the explicit test-key flags',
      verify(dir, '--expect-id', id, ...FLAGS),
      { exit: 0, ok: { verdict: 'ok', id, testKey: true } },
    ),
  );
  const okRun = verify(dir, '--expect-id', id, ...FLAGS);
  if (!okRun.stderr.includes(TEST_KEY_VERIFY_BANNER))
    fail('the test-key verification did not print its banner');

  rec(
    expectOutcome(
      'the test key without the flag is refused',
      verify(dir, '--expect-id', id, '--trust-test-key'),
      {
        exit: 3,
        reason: 'test_key_refused',
      },
    ),
  );
  const keys = JSON.parse(readFileSync(docsKeys, 'utf8'));
  rec(
    expectOutcome(
      'docs/release-keys.json does not trust the rehearsal',
      verify(dir, '--expect-id', id, '--trust-file', docsKeys),
      // with keys [] there is nothing to trust; once the owner commits the real key, it did not sign a rehearsal
      {
        exit: 3,
        reason:
          Array.isArray(keys.keys) && keys.keys.length === 0
            ? 'no_trusted_key'
            : 'no_valid_signature',
      },
    ),
  );
  rec(
    expectOutcome(
      'the test-key flag with a release id is a usage error',
      verify(dir, '--expect-id', releaseId, '--trust-test-key'),
      { exit: 2, reason: 'test_key_flag_misuse' },
    ),
  );
  rec(
    expectOutcome('the verifier needs an expected id', verify(dir, ...FLAGS), {
      exit: 2,
      reason: 'expect_id_required',
    }),
  );

  const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8'));
  const artefact = manifest.entries[0].id;

  const t1 = join(work, 'tamper-artefact');
  copyDir(dir, t1);
  const bytes = readFileSync(join(t1, artefact));
  bytes[0] ^= 0x01;
  writeFileSync(join(t1, artefact), bytes);
  rec(
    expectOutcome('a changed artefact is refused', verify(t1, '--expect-id', id, ...FLAGS), {
      exit: 3,
      reason: 'artifact_hash_mismatch',
    }),
  );

  const t2 = join(work, 'tamper-sums');
  copyDir(dir, t2);
  const sums = readFileSync(join(t2, 'SHA256SUMS'), 'latin1');
  writeFileSync(join(t2, 'SHA256SUMS'), (sums[0] === '0' ? '1' : '0') + sums.slice(1), 'latin1');
  rec(
    expectOutcome('a changed SHA256SUMS is refused', verify(t2, '--expect-id', id, ...FLAGS), {
      exit: 3,
      reason: 'sums_mismatch',
    }),
  );

  const t3 = join(work, 'tamper-manifest');
  copyDir(dir, t3);
  const m3 = JSON.parse(readFileSync(join(t3, 'release-manifest.json'), 'utf8'));
  m3.publisher = `${m3.publisher} (edited)`;
  writeFileSync(join(t3, 'release-manifest.json'), `${JSON.stringify(m3, null, 2)}\n`);
  rec(
    expectOutcome('an edited manifest is refused', verify(t3, '--expect-id', id, ...FLAGS), {
      exit: 3,
      reason: 'no_valid_signature',
    }),
  );

  // R1: the test key never signs a release id. A fresh unsigned release manifest of the same artefacts.
  const t4 = join(work, 'release-id');
  mkdirSync(t4, { recursive: true });
  for (const e of manifest.entries) cpSync(join(dir, e.id), join(t4, e.id));
  const made = runTool(
    tool,
    [
      'manifest',
      '--dir',
      t4,
      '--id',
      releaseId,
      '--version',
      manifest.version,
      '--licence',
      manifest.entries[0].licence,
      '--publisher',
      'release',
    ],
    sde,
  );
  expectOutcome('a release manifest can be built', made, { exit: 0 });
  rec(
    expectOutcome(
      'the test key cannot sign a release id (R1)',
      runTool(tool, ['sign', '--dir', t4, '--test-key', 'rfc8032-1'], sde),
      { exit: 2, reason: 'test_key_release_id' },
    ),
  );
  return records;
}

/** Content of the release directory: only what the manifest lists, the manifest and SHA256SUMS, no credentials. */
export function assertReleaseDirectoryClean(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8'));
  const want = new Set([
    ...manifest.entries.map((e) => e.id),
    'release-manifest.json',
    'SHA256SUMS',
  ]);
  const names = readdirSync(dir);
  for (const n of names) {
    if (!lstatSync(join(dir, n)).isFile())
      fail(`${n} in the release directory is not a regular file`);
    if (!want.has(n)) fail(`${n} is in the release directory and not in the manifest`);
    if (/(^|[\\/])\.npmrc$|\.pypirc$|\.pem$|\.key$|\.der$|\.pkcs8$|seed/i.test(n))
      fail(`${n} looks like a credential and must never be in the release directory`);
  }
  for (const w of want) if (!names.includes(w)) fail(`${w} is missing from the release directory`);
  const sums = readFileSync(join(dir, 'SHA256SUMS'));
  if (sums.includes(0x0d)) fail('SHA256SUMS has a CR');
  const lines = sums.toString('latin1').split('\n');
  if (lines.pop() !== '') fail('SHA256SUMS has no final line feed');
  if (lines.length !== manifest.entries.length)
    fail('SHA256SUMS does not have one line per artefact');
  return names.sort();
}

// ---- the self-test ----------------------------------------------------------------------------------------

/**
 * Proves the refusal proofs can fail. `makeDir` returns a fresh signed rehearsal directory (a copy of the vectors
 * is enough: the proofs only need a directory the REAL tool accepts).
 */
export function selfTest({ realTool, makeDir, docsKeys, work }) {
  const results = [];
  const expectRed = (label, tool) => {
    let red = false;
    try {
      proveRefusals({
        tool,
        dir: makeDir(),
        docsKeys,
        work: mkdtempSync(join(work, 'st-')),
        sde: undefined,
      });
    } catch {
      red = true;
    }
    if (!red) fail(`self-test: the proofs stayed green for ${label}`);
    results.push(`${label}: red, as it must be`);
  };
  expectRed('a missing tool', join(work, 'no-such-tool.mjs'));
  const fakes = {
    'a tool that accepts everything':
      'process.stdout.write(\'{"verdict":"ok","testKey":true}\\n\'); process.exitCode = 0;',
    'a tool that fails with an I/O error that looks like a refusal':
      'process.stderr.write("refused: test_key_refused\\n"); process.stdout.write(\'{"verdict":"refused","reason":"test_key_refused"}\\n\'); process.exitCode = 1;',
    'a tool that is killed by a signal': 'process.kill(process.pid, "SIGKILL");',
    'a tool that exits 3 with the wrong first line':
      'process.stderr.write("something else\\n"); process.stdout.write(\'{"verdict":"refused","reason":"x"}\\n\'); process.exitCode = 3;',
  };
  for (const [label, body] of Object.entries(fakes)) {
    const p = join(work, `fake-${results.length}.mjs`);
    writeFileSync(p, body);
    if (process.platform === 'win32' && label.includes('signal')) {
      // Windows has no SIGKILL for a child's own pid in the same sense; process.kill terminates it with exit 1
      // and no signal, which the proofs also refuse (exit 1 is never a refusal).
    }
    expectRed(label, p);
  }
  // and the real tool is green, so the red above is the fakes' doing
  proveRefusals({
    tool: realTool,
    dir: makeDir(),
    docsKeys,
    work: mkdtempSync(join(work, 'st-')),
    sde: undefined,
  });
  results.push('the real tool: green');
  return results;
}

// ---- the clean-install check (B1) --------------------------------------------------------------------------

const CHECK_SOURCE = `
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createStore } from '@airplanemode/localdata';
const resolved = fileURLToPath(import.meta.resolve('@airplanemode/localdata'));
const pkg = JSON.parse(readFileSync(new URL('./node_modules/@airplanemode/localdata/package.json', import.meta.url), 'utf8'));
const events = [];
const store = await createStore({ driver: 'memory', events: { emit: (e) => events.push(e) } });
await store.set('check', 'greeting', 'hello');
const got = await store.get('check', 'greeting');
let x = 12345;
const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const rows = Array.from({ length: 200 }, (_, i) => ({ key: 'k' + String(i).padStart(3, '0'), vector: Float32Array.from({ length: 16 }, rnd) }));
await store.putVectors('vec', rows);
const built = await store.buildIndex('vec', { kind: 'hnsw', m: 8, efConstruction: 40, seed: 1 });
const q = Float32Array.from({ length: 16 }, rnd);
const flat = await store.query('vec', q, 10, { values: false });
events.length = 0;
const ann = await store.query('vec', q, 10, { values: false, index: 'hnsw', ef: 64 });
const answered = events.filter((e) => e.name === 'storage.query').at(-1)?.attrs ?? {};
const bits = (hits) => hits.map((h) => new Uint32Array(new Float32Array([h.score]).buffer)[0]);
const info = await store.indexInfo('vec');
await store.close();
console.log(JSON.stringify({
  resolved,
  version: pkg.version,
  got,
  built: { kind: built.kind, rows: built.rows, liveRows: built.liveRows },
  flatHits: flat.length,
  annHits: ann.length,
  equal: JSON.stringify(bits(ann)) === JSON.stringify(bits(flat)),
  sameKeys: JSON.stringify(ann.map((h) => h.key)) === JSON.stringify(flat.map((h) => h.key)),
  index: answered.index,
  fallback: answered.fallback,
  annNodes: info?.ann?.nodes,
}));
`;

function cleanInstallCheck({ tgz, work }) {
  const fresh = mkdtempSync(join(work, 'install-'));
  const cache = mkdtempSync(join(work, 'npm-cache-'));
  // the install directory is outside the checkout: nothing above it is a repository of ours
  if (isInside(repoRoot, fresh)) fail('the install directory is inside the checkout');
  npm(['init', '-y'], fresh);
  npm(
    ['i', tgz, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache],
    fresh,
    { npm_config_offline: 'true', npm_config_cache: cache },
  );
  writeFileSync(join(fresh, 'check.mjs'), CHECK_SOURCE);
  const r = run(process.execPath, ['check.mjs'], { cwd: fresh });
  if (r.error || r.status !== 0) fail(`the install check call failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const nodeModules = realpathSync(join(fresh, 'node_modules')) + sep;
  const resolved = realpathSync(out.resolved);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!norm(resolved).startsWith(norm(nodeModules)))
    fail(`@airplanemode/localdata resolved outside the fresh node_modules: ${resolved}`);
  if (!existsSync(join(fresh, 'node_modules/@airplanemode/localdata/package.json')))
    fail('the package is not installed');
  if (out.got !== 'hello')
    fail(`set then get returned ${JSON.stringify(out.got)}, expected "hello"`);
  if (out.built.kind !== 'hnsw' || out.built.rows !== 200 || out.built.liveRows !== 200)
    fail(`buildIndex returned ${JSON.stringify(out.built)}, expected an hnsw graph over 200 rows`);
  if (out.flatHits !== 10 || out.annHits !== 10)
    fail(`flat returned ${out.flatHits} hits and hnsw ${out.annHits}, expected 10 and 10`);
  if (out.index !== 'hnsw' || out.fallback !== '')
    fail(
      `the hnsw query was answered by ${out.index} (fallback ${JSON.stringify(out.fallback)}), expected the graph`,
    );
  if (out.equal !== true) fail('the HNSW top 10 scores differ from the flat top 10 scores');
  if (out.annNodes !== 200) fail(`the graph holds ${out.annNodes} nodes, expected 200`);
  if (out.version !== JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version)
    fail(`the installed package is version ${out.version}`);
  const installed = readdirSync(join(fresh, 'node_modules')).filter((n) => !n.startsWith('.'));
  if (installed.length !== 1 || installed[0] !== '@airplanemode')
    fail(`node_modules holds ${installed.join(', ')}`);
  return {
    version: out.version,
    memoryBackend:
      'set and get, putVectors of 200 seeded rows, buildIndex, an hnsw query answered by the graph',
    top10: 'the hnsw top 10 scores equal the flat top 10 scores',
    installedUnder: 'fresh node_modules (outside the checkout)',
  };
}

/**
 * The tool must be the one vendored from runtime spec/tools: its sha256 equals scripts/release/VENDORED.json. A tool
 * passed with --tool (the self-test of a fake) is not the vendored one and is not checked.
 */
export function assertVendored(tool) {
  const vendored = join(repoRoot, 'scripts/release/release-tool.mjs');
  if (resolve(tool) !== resolve(vendored)) return;
  const record = JSON.parse(readFileSync(join(repoRoot, 'scripts/release/VENDORED.json'), 'utf8'));
  const actual = sha256(readFileSync(vendored));
  if (actual !== record.sha256)
    fail(`scripts/release/release-tool.mjs is ${actual}, but VENDORED.json says ${record.sha256}`);
  if (record.specRelease !== '0.6.1') fail(`VENDORED.json says spec release ${record.specRelease}`);
}

// ---- main ------------------------------------------------------------------------------------------------

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function sourceDateEpoch() {
  const fromEnv = process.env['SOURCE_DATE_EPOCH'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const r = run('git', ['log', '-1', '--pretty=%ct'], { cwd: repoRoot });
  if (r.status === 0 && /^\d+$/.test(r.stdout.trim())) return r.stdout.trim();
  return String(Math.floor(Date.now() / 1000)); // no checkout and no variable: the clock (not reproducible)
}

export async function main(argv) {
  const tool = resolve(arg(argv, '--tool') ?? join(repoRoot, 'scripts/release/release-tool.mjs'));
  assertVendored(tool);
  const docsKeys = join(repoRoot, 'docs/release-keys.json');
  const workParent = resolve(arg(argv, '--work') ?? tmpdir());
  // checked before anything is created, so a refused --work leaves nothing behind
  if (isInside(repoRoot, workParent)) fail('--work must be outside the checkout');
  const work = mkdtempSync(join(workParent, 'airplanemode-localdata-rehearsal-'));
  const steps = [];
  const step = (name, detail) => {
    steps.push({ name, ...detail });
    console.log(`ok   ${name}`);
  };

  if (argv.includes('--self-test')) {
    const base = join(repoRoot, 'spec/vectors/release/base');
    const makeDir = () => {
      const d = mkdtempSync(join(work, 'vec-'));
      copyDir(base, d);
      return d;
    };
    // the vectors were built for the id example-rehearsal; the proofs need localdata-rehearsal, so build one
    const sde = '1795132800';
    const mkRehearsal = () => {
      const d = mkdtempSync(join(work, 'self-'));
      writeFileSync(
        join(d, 'self-test-artefact.bin'),
        'synthetic artefact for the rehearsal self-test\n',
      );
      for (const args of [
        [
          'manifest',
          '--dir',
          d,
          '--id',
          `${PACKAGE}-rehearsal`,
          '--version',
          '1.0.0',
          '--licence',
          'Apache-2.0',
          '--publisher',
          'rehearsal',
        ],
        ['sums', '--dir', d],
        ['sign', '--dir', d, '--test-key', 'rfc8032-1'],
      ]) {
        const r = runTool(tool, args, sde);
        if (r.status !== 0)
          fail(
            `self-test: could not build a rehearsal directory with the real tool (${args[0]}: ${firstLine(r.stderr)})`,
          );
      }
      return d;
    };
    void makeDir;
    const results = selfTest({ realTool: tool, makeDir: mkRehearsal, docsKeys, work });
    for (const r of results) console.log(`ok   self-test: ${r}`);
    rmSync(work, { recursive: true, force: true });
    return 0;
  }

  if (!existsSync(tool))
    fail(
      `the release tool is missing: ${basename(tool)} (it is vendored from runtime spec/tools, see scripts/release/VENDORED.json)`,
    );
  const sde = sourceDateEpoch();
  const out = resolve(arg(argv, '--out') ?? join(repoRoot, 'dist-release'));
  const report = resolve(arg(argv, '--report') ?? join(repoRoot, 'dist-release-report'));
  if (isInside(out, report)) fail('the report directory must not be inside the release directory');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const id = `${PACKAGE}-rehearsal`;

  // 1. build and pack, exactly as a release would
  for (const d of [out, report]) {
    if (
      basename(d) !== 'dist-release' &&
      basename(d) !== 'dist-release-report' &&
      !d.startsWith(work)
    )
      fail(`refusing to clear ${d}`);
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], repoRoot);
  npm(['run', 'build:wasm'], repoRoot);
  npm(['run', 'build'], repoRoot);
  const packed = JSON.parse(
    npm(['pack', '--ignore-scripts', '--json', '--pack-destination', out], repoRoot),
  )[0];
  const tgz = join(out, packed.filename);
  step('npm ci --ignore-scripts, build:wasm, build and npm pack', {
    tarball: packed.filename,
    bytes: statSync(tgz).size,
  });

  // 2. the clean-install check on the packed tarball
  const install = cleanInstallCheck({ tgz, work });
  step(
    'clean install of the tarball into a fresh directory outside the checkout, one asserted call',
    install,
  );

  // 3. manifest, sums, sign (the test key, rehearsal id only)
  const toolRun = (args, expect = 0) => {
    const r = runTool(tool, args, sde);
    if (r.error || r.signal || r.status !== expect)
      fail(`${args[0]} failed (status ${r.status}): ${firstLine(r.stderr)}`);
    return r;
  };
  toolRun([
    'manifest',
    '--dir',
    out,
    '--id',
    id,
    '--version',
    pkg.version,
    '--licence',
    pkg.license,
    '--publisher',
    'rehearsal',
  ]);
  toolRun(['sums', '--dir', out]);
  const signed = toolRun(['sign', '--dir', out, '--test-key', 'rfc8032-1']);
  if (firstLine(signed.stderr) !== TEST_KEY_SIGN_BANNER) fail('the signing banner is missing');
  step('release manifest, SHA256SUMS and the test-key signature', { id, sourceDateEpoch: sde });

  // 4. verify and the refusal proofs
  const proofs = proveRefusals({ tool, dir: out, docsKeys, work, sde });
  step('verify with the explicit test-key flag, then the refusal proofs', {
    proofs: proofs.length,
  });
  for (const p of proofs)
    console.log(
      `ok   proof: ${p.name}: exit ${p.exit}, first stderr line ${JSON.stringify(p.firstStderrLine)}`,
    );

  // 5. the release directory
  const names = assertReleaseDirectoryClean(out);
  const manifestBytes = readFileSync(join(out, 'release-manifest.json'));
  step('release directory: only the manifest entries, the manifest and SHA256SUMS', {
    files: names.length,
  });

  // 6. the publish dry run, on Linux only
  let dryRun = 'skipped (runs on Linux only)';
  if (process.platform === 'linux') {
    const { publishDryRun } = await import('./publish-dry-run.mjs');
    dryRun = publishDryRun({ tarball: tgz, repoRoot });
    step('npm publish --dry-run on the tarball', { dryRun });
  }

  mkdirSync(report, { recursive: true });
  writeFileSync(
    join(report, 'rehearsal.json'),
    `${JSON.stringify(
      {
        package: PACKAGE,
        version: pkg.version,
        id,
        keyedWith: 'RFC 8032 TEST 1 (published); a rehearsal, not a release',
        sourceDateEpoch: sde,
        node: process.version,
        platform: process.platform,
        tool: { file: 'scripts/release/release-tool.mjs', sha256: sha256(readFileSync(tool)) },
        tarball: {
          file: packed.filename,
          sha256: sha256(readFileSync(tgz)),
          bytes: statSync(tgz).size,
        },
        manifestSha256: sha256(manifestBytes),
        sumsSha256: sha256(readFileSync(join(out, 'SHA256SUMS'))),
        steps,
        refusalProofs: proofs,
        publishDryRun: dryRun,
      },
      null,
      2,
    )}\n`,
  );
  rmSync(work, { recursive: true, force: true });
  console.log(
    `\nrehearsal passed: ${packed.filename}; ${proofs.length} refusal proofs; report in ${basename(report)}/`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
}
