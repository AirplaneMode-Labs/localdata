// D4-06 in installed Chrome (channel "chrome"): the public demo, built as pages.yml builds it (node
// demo/build.mjs into demo/dist) and served under the Pages sub-path /localdata/ by a server that answers
// 404 for every other path. Checks: 0 console and page errors, same-origin requests only, the pinned CSP, a
// build id, the Sprint 6 status line and the not-yet box, and the Documents panel end to end on OPFS and,
// with OPFS removed from the page, on IndexedDB: put 3 documents, query (hits show page references and the
// storage.doc.* events appear without a docId), delete one, reload and see it gone, clear the namespace and
// read the browser's own listing.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from 'playwright/test';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const dist = join(repoRoot, 'demo', 'dist');
const PREFIX = '/localdata/';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

let server: Server;
let origin = '';
const notFound: string[] = [];

test.beforeAll(async () => {
  execFileSync(process.execPath, ['demo/build.mjs'], { cwd: repoRoot, stdio: 'pipe' });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(PREFIX)) {
      notFound.push(url.pathname);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(PREFIX.length));
    if (rel === '') rel = 'index.html';
    const file = normalize(join(dist, rel));
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      notFound.push(url.pathname);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Watch {
  errors: string[];
  foreign: string[];
}

function watch(page: Page): Watch {
  const w: Watch = { errors: [], foreign: [] };
  page.on('console', (m) => m.type() === 'error' && w.errors.push(m.text()));
  page.on('pageerror', (e) => w.errors.push(String(e)));
  page.on('request', (r) => {
    if (!r.url().startsWith(`${origin}/`) && !r.url().startsWith('data:')) w.foreign.push(r.url());
  });
  return w;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${origin}${PREFIX}`);
  await page.waitForSelector('body[data-ready="1"]');
}

test('the demo under /localdata/: no errors, same-origin only, the pinned CSP, a build id, the Sprint 6 status line and the not-yet box', async ({
  page,
}) => {
  const w = watch(page);
  await open(page);
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toBe(CSP);
  const status = (await page.locator('#sprint-status').innerText()).replace(/\s+/g, ' ').trim();
  expect(status).toMatch(/^Sprint 6 \(19 Nov 2026\): Working: .+\. Not yet: .+\.$/);
  expect(status).toContain('not measured on 8 GB');
  const build = (await page.locator('#build-sha').innerText()).trim();
  expect(build).toMatch(
    /^(Built from main at [0-9a-f]{12}|Local build ([0-9a-f]{12}(-dirty)?|local))$/,
  );
  const box = (await page.locator('#not-yet').innerText()).toLowerCase();
  for (const phrase of [
    'quantisation',
    'compaction',
    'encryption at rest',
    'hnsw for',
    'querychunks',
    'not measured on 8 gb',
  ])
    expect(box, phrase).toContain(phrase);
  await expect(page.locator('#documents h2')).toHaveText('Documents');
  await expect(page.locator('#ann h2')).toHaveText('Flat or HNSW, on the same seeded data');
  expect(w.errors).toEqual([]);
  expect(w.foreign).toEqual([]);
  expect(notFound.filter((p) => !p.endsWith('favicon.ico'))).toEqual([]);
});

for (const driver of ['opfs', 'indexeddb'] as const) {
  test(`Documents panel on ${driver}: put, query with page references, delete, reload, clear`, async ({
    page,
  }) => {
    const w = watch(page);
    if (driver === 'indexeddb')
      await page.addInitScript(() => {
        Object.defineProperty(navigator.storage, 'getDirectory', {
          value: undefined,
          configurable: true,
        });
      });
    await open(page);
    // a clean start in this browser context
    await page.locator('#doc-clear').click();
    await expect(page.locator('#doc-status')).toContainText('cleared demo-docs');

    await page.locator('#doc-put').click();
    await expect(page.locator('#doc-status')).toContainText('put demo-policy: 4 chunks');
    await expect(page.locator('#doc-status')).toContainText(`on ${driver}`);
    await expect(page.locator('#doc-status')).toContainText('3 document(s)');

    await page.locator('#doc-target').selectOption('0:1');
    await page.locator('#doc-query').click();
    await expect(page.locator('#doc-status')).toContainText('3 hit(s)');
    const hits = await page.locator('#doc-hits li').allInnerTexts();
    expect(hits.length).toBe(3);
    expect(hits[0]).toContain('demo-policy, page 1 (chunk 2)');
    expect(hits[0]).toContain('grace period');
    for (const h of hits) expect(h).toMatch(/pages? \d/);

    await page.locator('#doc-delete-id').selectOption('demo-terms');
    await page.locator('#doc-delete').click();
    await expect(page.locator('#doc-status')).toContainText('deleteDocument demo-terms -> true');
    await expect(page.locator('#doc-status')).toContainText('2 document(s)');

    // the storage.doc.* events are listed, and never carry a docId or text
    const events = await page.locator('#events-list').innerText();
    for (const name of ['storage.doc.put', 'storage.doc.query', 'storage.doc.delete'])
      expect(events, name).toContain(name);
    for (const leak of ['demo-policy', 'demo-terms', 'demo-notes', 'grace period', 'Synthetic'])
      expect(events.includes(leak), `event list leaks ${leak}`).toBe(false);

    await page.reload();
    await page.waitForSelector('body[data-ready="1"]');
    await page.locator('#doc-list').click();
    await expect(page.locator('#doc-status')).toContainText('2 document(s)');
    const listed = await page.locator('#doc-status').innerText();
    expect(listed).toContain('demo-policy');
    expect(listed).toContain('demo-notes');
    expect(listed).not.toContain('demo-terms (');
    await page.locator('#doc-target').selectOption('1:0');
    await page.locator('#doc-query').click();
    await expect(page.locator('#doc-status')).toContainText('hit(s)');
    expect((await page.locator('#doc-hits').innerText()).includes('demo-terms')).toBe(false);

    // after the reload the list holds the events of this page load only (the list lives in the page)
    const after = await page.locator('#events-list').innerText();
    expect(after).toContain('storage.doc.query');
    for (const leak of ['demo-policy', 'demo-terms', 'demo-notes', 'grace period', 'Synthetic'])
      expect(after.includes(leak), `event list leaks ${leak}`).toBe(false);

    await page.locator('#doc-clear').click();
    await expect(page.locator('#doc-status')).toContainText(
      'cleared demo-docs: 0 document(s) left',
    );
    await expect(page.locator('#doc-listing')).toContainText(
      `on ${driver}: 0 file(s) or record(s)`,
    );
    await page.locator('#doc-list').click();
    await expect(page.locator('#doc-status')).toContainText('0 document(s)');
    expect(w.errors).toEqual([]);
    expect(w.foreign).toEqual([]);
  });
}

for (const driver of ['opfs', 'indexeddb'] as const) {
  test(`Flat or HNSW panel on ${driver}: build, flip the switch, corrupt the graph, see the refusal and the rebuild`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const w = watch(page);
    if (driver === 'indexeddb')
      await page.addInitScript(() => {
        Object.defineProperty(navigator.storage, 'getDirectory', {
          value: undefined,
          configurable: true,
        });
      });
    await open(page);
    await page.locator('#ann-delete').click();
    await expect(page.locator('#ann-status')).toContainText('index deleted');

    await page.locator('#ann-build').click();
    await expect(page.locator('#ann-status')).toContainText(`built 20,000 rows on ${driver}`, {
      timeout: 180_000,
    });

    // flat: the exact scan, the page says so
    await page.locator('#ann-kind').selectOption('flat');
    await page.locator('#ann-run').click();
    await expect(page.locator('#ann-status')).toContainText('flat answered 50 queries');
    await expect(page.locator('#ann-which')).toContainText('flat, answered by flat');
    await expect(page.locator('#ann-recall')).toContainText('1.000 by definition');
    await expect(page.locator('#ann-events')).toContainText('none: the graph passed validation');

    // hnsw: the graph answers, the recall is measured against the flat scan in the tab, the graph has bytes
    await page.locator('#ann-kind').selectOption('hnsw');
    await page.locator('#ann-run').click();
    await expect(page.locator('#ann-status')).toContainText('hnsw answered 50 queries');
    await expect(page.locator('#ann-which')).toContainText('hnsw, answered by hnsw');
    const recall = Number(
      /^(\d\.\d{3}) /.exec(await page.locator('#ann-recall').innerText())?.[1] ?? 'NaN',
    );
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeLessThanOrEqual(1);
    const bytes = /\((\d+) bytes\)/.exec(await page.locator('#ann-bytes').innerText());
    expect(Number(bytes?.[1])).toBeGreaterThan(100_000);
    const time = (await page.locator('#ann-time').innerText()).match(/[\d.]+ ms/g);
    expect(time?.length).toBe(2);
    await expect(page.locator('#ann-build-time')).toContainText('this page load');

    // corrupt only the demo's own graph record, then query: refused, rebuilt, still answered by the graph
    await page.locator('#ann-corrupt').click();
    await expect(page.locator('#ann-status')).toContainText(
      'truncated the graph record of demo-ann',
    );
    await page.locator('#ann-run').click();
    await expect(page.locator('#ann-status')).toContainText('hnsw answered 50 queries', {
      timeout: 120_000,
    });
    await expect(page.locator('#ann-events')).toContainText('graph refused (reason length)');
    await expect(page.locator('#ann-events')).toContainText('rebuilt from the stored vectors in');
    await expect(page.locator('#ann-events')).toContainText('(outcome ok)');
    await expect(page.locator('#ann-which')).toContainText('hnsw, answered by hnsw');

    // the rebuilt graph persisted: after a reload the graph passes validation and answers
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]');
    await page.locator('#ann-kind').selectOption('hnsw');
    await page.locator('#ann-run').click();
    await expect(page.locator('#ann-status')).toContainText('hnsw answered 50 queries');
    await expect(page.locator('#ann-events')).toContainText('none: the graph passed validation');
    await expect(page.locator('#ann-build-time')).toContainText('built in an earlier page load');

    // the events of this section are listed, and never carry a key
    const events = await page.locator('#events-list').innerText();
    expect(events).toContain('storage.query');
    expect(events).toMatch(/requested='(flat|hnsw)' index='(flat|hnsw)' fallback=''/);
    for (const leak of ['chunk-0', 'Float32Array']) expect(events.includes(leak)).toBe(false);

    await page.locator('#ann-delete').click();
    await expect(page.locator('#ann-status')).toContainText('index deleted');
    expect(w.errors).toEqual([]);
    expect(w.foreign).toEqual([]);
  });
}
