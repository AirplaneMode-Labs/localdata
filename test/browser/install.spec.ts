// Bundler-free proof: the npm pack tarball is installed offline into a fresh empty directory
// (scripts/pack-check.mjs --out <mkdtemp scratch>), that directory is served as-is, and a plain
// module script imports ./node_modules/@airplanemode/localdata/dist/index.js and round-trips a value
// over real OPFS. The scratch is a mkdtemp under os.tmpdir() (TMPDIR is honoured) and only that
// directory is removed afterwards, so this runs unchanged on a hosted runner, Windows or a laptop.
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'playwright/test';

// Created in beforeAll, not at import: Playwright imports this file once to list tests and again in
// the worker, and only the worker's afterAll runs.
let SCRATCH = '';
let FRESH = '';
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
let server: Server;
let origin = '';

test.beforeAll(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), 'localdata-install-'));
  FRESH = join(SCRATCH, 'npm-fresh');
  execFileSync(process.execPath, ['scripts/pack-check.mjs', '--out', SCRATCH], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  writeFileSync(
    join(FRESH, 'index.html'),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'none'"><title>install</title><body data-state="pending"><script type="module" src="./app.js"></script>\n`,
  );
  writeFileSync(
    join(FRESH, 'app.js'),
    `import { createStore } from './node_modules/@airplanemode/localdata/dist/index.js';
const out = {};
try {
  const s = await createStore({ driver: 'opfs' });
  out.driver = s.driver;
  const ns = 'install-proof';
  await s.set(ns, 'k', { n: 1, bytes: new Uint8Array([1, 2, 3]) });
  const got = await s.get(ns, 'k');
  out.got = { n: got.n, bytes: Array.from(got.bytes) };
  out.removed = await s.delete(ns, 'k');
  out.after = (await s.get(ns, 'k')) ?? null;
  await s.close();
  document.body.dataset.state = 'done';
} catch (e) {
  out.error = String(e);
  document.body.dataset.state = 'error';
}
globalThis.__result = out;
`,
  );
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = normalize(join(FRESH, p));
    const rel = relative(FRESH, file);
    if (
      rel === '' ||
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

test.afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  // Remove only the mkdtemp directory this file created.
  if (
    resolve(dirname(SCRATCH)) === resolve(tmpdir()) &&
    basename(SCRATCH).startsWith('localdata-install-')
  )
    rmSync(SCRATCH, { recursive: true, force: true });
});

test('tarball installed into a fresh directory works over OPFS, 0 console errors, same origin', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${origin}/`);
  await page.waitForSelector('body[data-state="done"], body[data-state="error"]', {
    state: 'attached',
  });
  const result = await page.evaluate(() => (globalThis as { __result?: unknown }).__result);
  expect(result).toEqual({
    driver: 'opfs',
    got: { n: 1, bytes: [1, 2, 3] },
    removed: true,
    after: null,
  });
  expect(errors).toEqual([]);
  expect(requests.every((u) => u.startsWith(origin + '/'))).toBe(true);
  expect(
    requests.some((u) => u.endsWith('/node_modules/@airplanemode/localdata/dist/index.js')),
  ).toBe(true);
});
