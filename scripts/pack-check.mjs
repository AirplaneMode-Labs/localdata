#!/usr/bin/env node
// Packs the SDK, checks the tarball against the packaging rules, installs it offline into a fresh
// empty directory from an empty npm cache, and runs real calls from the installed copy: a key-value round
// trip with its storage.* events, the vector index (three rows written, one query, the keys printed), and the
// documents API (a document put, queried with its chunk text and source pages, deleted, and a per-document
// namespace cleared).
// The two WebAssembly modules embedded in dist/index.js must equal a fresh path-remapped build
// (scripts/build-wasm.mjs --check), and neither the tarball nor the decoded modules may hold a builder
// path. Nothing here publishes anything.
//
//   node scripts/pack-check.mjs [--out <dir>] [--skip-build] [--keep]
//
// --out   where the tarball, the fresh install and pack-check.json go. Default: a new directory under
//         os.tmpdir() (honours TMPDIR), removed on success unless --keep. With --out, the three
//         literal subdirectories pack/, npm-fresh/ and npm-cache-empty/ of that directory are
//         recreated empty on every run; nothing else in it is touched.
// --skip-build  use the dist/ that is already built (otherwise `npm run build` runs first, so a
//         clean checkout works).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
for (const a of argv) {
  if (
    !['--out', '--skip-build', '--keep'].includes(a) &&
    !a.startsWith('--out=') &&
    a.startsWith('-')
  )
    throw new Error(`unknown option ${a}`);
}

const outArg = option('--out');
if (argv.includes('--out') && (outArg === undefined || outArg.startsWith('-')))
  throw new Error('--out needs a directory');
const createdTemp = outArg === undefined;
const scratch = createdTemp ? mkdtempSync(join(tmpdir(), 'localdata-pack-')) : resolve(outArg);
mkdirSync(scratch, { recursive: true });

// npm: through node and npm's own CLI when run by `npm run` (works on every OS with no shell),
// otherwise `npm`, or `npm.cmd` through a shell on Windows (node refuses to spawn .cmd without one).
const NPM_CLI =
  process.env['npm_execpath'] && /npm-cli\.c?js$/.test(process.env['npm_execpath'])
    ? process.env['npm_execpath']
    : undefined;
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const winQuote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function npm(args, cwd) {
  const opts = {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  };
  if (NPM_CLI) return execFileSync(process.execPath, [NPM_CLI, ...args], opts);
  if (process.platform === 'win32')
    return execFileSync(NPM_BIN, args.map(winQuote), { ...opts, shell: true });
  return execFileSync(NPM_BIN, args, opts);
}
const node = (args, cwd) =>
  execFileSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const failures = [];
const check = (cond, message) => {
  if (!cond) failures.push(message);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${message}`);
};
const finish = () => {
  if (failures.length > 0) {
    console.error(`FAIL ${failures.length} check(s); work directory kept: ${scratch}`);
    process.exit(1);
  }
};

const packDir = join(scratch, 'pack');
const fresh = join(scratch, 'npm-fresh');
const cache = join(scratch, 'npm-cache-empty');
for (const d of [packDir, fresh, cache]) {
  rmSync(d, { recursive: true, force: true }); // the three literal subdirectories only
  mkdirSync(d, { recursive: true });
}

if (!flag('--skip-build')) {
  npm(['run', 'build:wasm'], repo);
  npm(['run', 'build'], repo);
}

// ---- 1. the tarball -----------------------------------------------------------------------------
const packed = JSON.parse(
  npm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], repo),
)[0];
const tgz = join(packDir, packed.filename);
const files = packed.files.map((f) => ({ path: f.path.replace(/\\/g, '/'), size: f.size }));
console.log(
  `tarball ${packed.filename} (${packed.size} bytes packed, ${packed.unpackedSize} unpacked, ${files.length} files)`,
);
for (const f of files) console.log(`  ${String(f.size).padStart(7)}  ${f.path}`);

const names = files.map((f) => f.path);
for (const need of [
  'LICENSE',
  'NOTICE',
  'README.md',
  'package.json',
  'dist/index.js',
  'dist/index.d.ts',
])
  check(names.includes(need), `tarball contains ${need}`);
check(!names.some((n) => n.endsWith('.map')), 'no source map in the tarball');
check(!names.some((n) => n.endsWith('.wasm')), 'no .wasm sidecar (the modules are embedded)');
check(
  !names.some(
    (n) => /(^|\/)(crates|target|bench|scripts|\.github)\//.test(n) || /\.(rs|toml)$/.test(n),
  ),
  'no Rust source, build script or CI file in the tarball',
);
check(!files.some((f) => f.size > 5 * 1024 * 1024), 'no file over 5 MB');
check(packed.size < 5 * 1024 * 1024, `the tarball is under 5 MB (${packed.size} bytes)`);
check(
  !names.some((n) => /(^|\/)(test|demo|docs|src)\//.test(n)),
  'no test, demo, docs or src in the tarball',
);
finish();

// ---- 2. offline install into a fresh empty directory, empty cache -------------------------------
writeFileSync(
  join(fresh, 'package.json'),
  '{"name":"localdata-fresh-install","version":"0.0.0","private":true}\n',
);
npm(
  ['i', tgz, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache],
  fresh,
);
console.log(npm(['ls', '--all'], fresh).trim());
const tree = JSON.parse(npm(['ls', '--all', '--json'], fresh));
const deps = Object.keys(tree.dependencies ?? {});
check(
  deps.length === 1 && deps[0] === '@airplanemode/localdata',
  `node_modules holds exactly one package (${deps.join(', ')})`,
);
const installed = join(fresh, 'node_modules', '@airplanemode', 'localdata');
check(existsSync(join(installed, 'dist', 'index.js')), 'dist/index.js is installed');

// ---- 3. content rules, read from the installed copy (identical to the tarball) ------------------
const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
for (const s of [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepack',
  'postpack',
])
  check(!pkg.scripts?.[s], `no lifecycle script ${s}`);
check(Object.keys(pkg.dependencies ?? {}).length === 0, 'no runtime dependencies');
const js = readFileSync(join(installed, 'dist', 'index.js'), 'utf8');
check(!js.includes('sourceMappingURL'), 'no dangling sourceMappingURL');
// Builder paths must not leak into a published artifact (the patterns are regex sources on purpose).
const LEAK = /\/Users\/|\/home\/[a-z]|\/private\/tmp|[A-Za-z]:\\+Users\\/;
check(!LEAK.test(js), 'no builder or scratch path in dist/index.js');
// Builder paths in the shipped bytes, including the embedded WebAssembly modules decoded from base64.
// (The needles are built from pieces so this file does not match its own portability scan.)
const NEEDLES = [
  ['/Us', 'ers/'].join(''),
  ['/ho', 'me/'].join(''),
  ['C:', '\\'].join(''),
  ['.cargo', '/registry'].join(''),
  ['.rus', 'tup'].join(''),
  homedir(),
  repo,
];
const dts = readFileSync(join(installed, 'dist', 'index.d.ts'), 'utf8');
for (const n of NEEDLES) {
  check(!js.includes(n), `dist/index.js has no ${JSON.stringify(n)}`);
  check(!dts.includes(n), `dist/index.d.ts has no ${JSON.stringify(n)}`);
}
const b64 = [...js.matchAll(/['"]([A-Za-z0-9+/]{20000,}={0,2})['"]/g)].map((m) => m[1]);
check(b64.length === 2, `two embedded WebAssembly modules found in dist/index.js (${b64.length})`);
const embedded = b64.map((x) => Buffer.from(x, 'base64'));
for (const [i, mod] of embedded.entries()) {
  check(
    mod.length > 1000 && mod.length < 100 * 1024,
    `embedded module ${i} is under 100 KB (${mod.length} bytes)`,
  );
  const text = mod.toString('latin1');
  for (const n of NEEDLES)
    check(!text.includes(n), `embedded module ${i} has no ${JSON.stringify(n)}`);
}
const shas = embedded.map((m) => createHash('sha256').update(m).digest('hex')).sort();
const gen = readFileSync(join(repo, 'src', 'wasm', 'ldvec.gen.ts'), 'utf8');
const want = [...gen.matchAll(/LDVEC_(?:SIMD|SCALAR)_SHA256 = '([0-9a-f]{64})'/g)]
  .map((m) => m[1])
  .sort();
check(
  JSON.stringify(shas) === JSON.stringify(want),
  'the embedded modules are the ones src/wasm/ldvec.gen.ts records (sha256)',
);
// ... and those equal a fresh remapped build (cargo is incremental, so this is quick after a build).
try {
  console.log(node(['scripts/build-wasm.mjs', '--check'], repo).trim().split('\n').pop());
  check(true, 'the embedded modules equal a fresh path-remapped build (build-wasm --check)');
} catch (e) {
  check(
    false,
    `build-wasm --check failed: ${String(e.stderr ?? e.message)
      .split('\n')
      .slice(-3)
      .join(' ')}`,
  );
}
const readme = readFileSync(join(installed, 'README.md'), 'utf8');
for (const phrase of ['Not published yet: the npm scope @airplanemode', 'not tagged'])
  check(readme.includes(phrase), `README says "${phrase}"`);
check(!LEAK.test(readme), 'no builder or scratch path in the packaged README');
finish();

// ---- 4. a real call from the installed copy ------------------------------------------------------
const probe = `
import { createStore } from '@airplanemode/localdata';
const events = [];
const s = await createStore({ driver: 'memory', events: { emit: (e) => events.push(e) } });
await s.set('docs', 'probe-key', { n: 1, d: new Date(0) });
const got = await s.get('docs', 'probe-key');
const removed = await s.delete('docs', 'probe-key');
const after = await s.get('docs', 'probe-key');
await s.close();
const v = await createStore({ driver: 'memory' });
await v.putVectors('docs', [
  { key: 'alpha', vector: new Float32Array([1, 0, 0]), value: 'first chunk' },
  { key: 'bravo', vector: new Float32Array([0, 1, 0]) },
  { key: 'charlie', vector: new Float32Array([0.7, 0.7, 0]) },
]);
const hits = await v.query('docs', new Float32Array([1, 0.1, 0]), 3);
const info = await v.indexInfo('docs');
await v.close();
const docEvents = [];
const d = await createStore({ driver: 'memory', events: { emit: (e) => docEvents.push(e) } });
const f = (...x) => new Float32Array(x);
const putResult = await d.putDocument(
  'policies',
  { docId: 'policy-3p', title: 'Policy 3P Title', sha256: 'a'.repeat(64), bytes: 1234, pages: 3 },
  [
    { ordinal: 0, pageStart: 1, pageEnd: 1, text: 'The grace period is 45 days.', vector: f(1, 0, 0, 0) },
    { ordinal: 1, pageStart: 2, pageEnd: 3, text: 'Claims are settled within 30 days.', vector: f(0, 1, 0, 0) },
  ],
);
const found = await d.queryChunks('policies', f(0.9, 0.1, 0, 0), 2);
const docInfo = await d.getDocument('policies', 'policy-3p');
const docUsage = await d.usage('policies');
const docRemoved = await d.deleteDocument('policies', 'policy-3p');
const afterDelete = await d.queryChunks('policies', f(1, 0, 0, 0), 2);
await d.putDocument('dockit.dabc123', { docId: 'abc123', title: 'Per-document', sha256: 'b'.repeat(64), bytes: 1, pages: 1 }, [
  { ordinal: 0, pageStart: 1, pageEnd: 1, text: 'only chunk', vector: f(1, 1, 0, 0) },
]);
await d.clear('dockit.dabc123');
const afterClear = await d.listDocuments('dockit.dabc123');
const afterClearUsage = (await d.usage('dockit.dabc123')).documents ?? null;
await d.close();
const docWire = JSON.stringify(docEvents);
console.log(JSON.stringify({
  driver: s.driver,
  got,
  removed,
  after: after ?? null,
  events: events.map((e) => [e.name, e.attrs.outcome]),
  leaked: JSON.stringify(events).includes('probe-key'),
  keys: hits.map((h) => h.key),
  firstValue: hits[0]?.value ?? null,
  rows: info?.rows,
  kernel: info?.kernel,
  docs: {
    put: putResult,
    found: found.map((h) => [h.docId, h.ordinal, h.pageStart, h.pageEnd, h.text]),
    info: { chunks: docInfo?.chunks, dim: docInfo?.dim, pages: docInfo?.pages },
    usageDocuments: docUsage.documents ?? null,
    removed: docRemoved,
    afterDelete: afterDelete.length,
    afterClear: afterClear.length,
    afterClearUsage,
    events: docEvents
      .filter((e) => e.name.startsWith('storage.doc.'))
      .map((e) => [e.name, e.attrs.outcome, e.attrs.ns]),
    leaked: ['policy-3p', 'Policy 3P Title', 'grace period', 'abc123', 'Per-document', 'only chunk'].filter((x) => docWire.includes(x)),
  },
}));
`;
writeFileSync(join(fresh, 'probe.mjs'), probe);
const out = node(['probe.mjs'], fresh).trim();
console.log(`round trip: ${out}`);
const r = JSON.parse(out);
check(
  r.removed === true && r.after === null && r.got?.n === 1,
  'set, get, delete round trip from the installed copy',
);
check(
  JSON.stringify(r.events) ===
    JSON.stringify([
      ['storage.set', 'ok'],
      ['storage.get', 'hit'],
      ['storage.delete', 'removed'],
      ['storage.get', 'miss'],
    ]),
  'the installed copy emits storage.set, get, delete and get (miss) events',
);
check(r.leaked === false, 'no key appears in an emitted event');
check(
  JSON.stringify(r.keys) === JSON.stringify(['alpha', 'charlie', 'bravo']) &&
    r.firstValue === 'first chunk' &&
    r.rows === 3 &&
    (r.kernel === 'simd' || r.kernel === 'scalar'),
  `putVectors of 3 rows and a query from the installed copy print the keys ${JSON.stringify(r.keys)} (kernel ${r.kernel})`,
);

check(
  JSON.stringify(r.docs.put) ===
    JSON.stringify({ docId: 'policy-3p', chunks: 2, replaced: false, rows: 2 }) &&
    r.docs.info.chunks === 2 &&
    r.docs.info.dim === 4 &&
    r.docs.usageDocuments === 1,
  'putDocument of a 2-chunk document, getDocument and usage().documents from the installed copy',
);
check(
  JSON.stringify(r.docs.found) ===
    JSON.stringify([
      ['policy-3p', 0, 1, 1, 'The grace period is 45 days.'],
      ['policy-3p', 1, 2, 3, 'Claims are settled within 30 days.'],
    ]),
  'queryChunks from the installed copy returns the chunk text and the source pages, nearest first',
);
check(
  r.docs.removed === true &&
    r.docs.afterDelete === 0 &&
    r.docs.afterClear === 0 &&
    r.docs.afterClearUsage === null,
  'deleteDocument hides every chunk; clear(ns) of a per-document namespace leaves no document and no usage',
);
check(
  JSON.stringify(r.docs.events.map((e) => e[0])) ===
    JSON.stringify([
      'storage.doc.put',
      'storage.doc.query',
      'storage.doc.delete',
      'storage.doc.query',
      'storage.doc.put',
    ]) && r.docs.events.at(-1)[2] === 'dockit.d*',
  'the document events are storage.doc.put, query, delete, query, put, and the per-document namespace is redacted as dockit.d*',
);
check(r.docs.leaked.length === 0, 'no docId, title or chunk text appears in an emitted event');

const summary = {
  tarball: packed.filename,
  sha256: createHash('sha256').update(readFileSync(tgz)).digest('hex'),
  packedBytes: packed.size,
  unpackedBytes: packed.unpackedSize,
  files,
  installedPackages: deps,
  queryKeys: r.keys,
  documents: r.docs,
  embeddedModuleSha256: shas,
  checks: failures.length === 0 ? 'all passed' : failures,
};
writeFileSync(join(scratch, 'pack-check.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`OK installed from the tarball and round-tripped (fresh directory ${fresh})`);
finish();

// A temporary scratch is removed only when this run created it; --out directories are left for the
// caller (the three subdirectories above stay for inspection).
if (createdTemp && !flag('--keep')) {
  const underTmp = resolve(dirname(scratch)) === resolve(tmpdir());
  if (underTmp && basename(scratch).startsWith('localdata-pack-'))
    rmSync(scratch, { recursive: true, force: true });
}
