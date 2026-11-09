#!/usr/bin/env node
// Tiny static server for the Playwright harness. Binds 127.0.0.1 only, serves test/browser/
// (index.html and dist/harness.js) and rejects foreign Host headers. With --build (or
// --build-only) it first bundles test/browser/harness.ts with tsup into test/browser/dist/.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const port = Number(opt('--port', '4177'));
const root = resolve(here);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function buildHarness() {
  const { build } = await import('tsup');
  await build({
    entry: { harness: join(here, 'harness.ts') },
    outDir: join(here, 'dist'),
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    bundle: true,
    splitting: false,
    sourcemap: true,
    dts: false,
    clean: true,
    silent: true,
    config: false,
  });
  console.log(`[serve] built ${join(here, 'dist', 'harness.js')}`);
}

function hostAllowed(host) {
  if (!host) return false;
  const h = host.replace(/:\d+$/, '');
  return h === '127.0.0.1' || h === 'localhost';
}

function serve() {
  const server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad host');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = normalize(join(root, pathname));
    if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': statSync(file).size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[serve] http://127.0.0.1:${port}/ serving ${root}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (flag('--build') || flag('--build-only')) await buildHarness();
if (!flag('--build-only')) serve();
