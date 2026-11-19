// BUG-T2-S6-07 (fix round 1) and BUG-T2-S6-12 (fix round 2): the public surface of the built package carries
// no test hook.
//
// A fresh build of src/index.ts is made into a temporary directory (so the committed dist/ is never
// touched and `npm run ci`, which builds last, needs no earlier build) and its typings and bundle are
// searched for the hook names. Test hooks live in src/vec/ann-test-hook.ts, a module that src/index.ts
// does not import, so neither dist/index.d.ts nor dist/index.js can contain it. Nothing in either file may
// carry a name ending in "ForTest" (a method of LocalData, VectorStore or Kernel included), and none of the
// hook module's function names may appear.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The function names of src/vec/ann-test-hook.ts, and the module's own file name. */
const HOOK_NAMES = ['armAnnTrap', 'armVectorTrap', 'annStats', 'ann-test-hook'];
const FOR_TEST = /\b\w*ForTest\b/gu;

let out = '';
let files: Array<{ name: string; text: string }> = [];

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'localdata-dist-surface-'));
  await build({
    config: false,
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    target: 'es2022',
    platform: 'browser',
    sourcemap: false,
    clean: false,
    splitting: false,
    treeshake: true,
    outDir: out,
    silent: true,
  });
  files = readdirSync(out)
    .filter((n) => n.endsWith('.js') || n.endsWith('.d.ts'))
    .map((name) => ({ name, text: readFileSync(join(out, name), 'utf8') }));
}, 180_000);

afterAll(() => {
  if (out !== '') rmSync(out, { recursive: true, force: true });
});

describe('the built package has no test hook on its public surface', () => {
  it('builds both the bundle and the typings', () => {
    expect(files.map((f) => f.name).sort()).toEqual(['index.d.ts', 'index.js']);
  });

  for (const hook of HOOK_NAMES) {
    it(`no emitted typing or bundle mentions ${hook}`, () => {
      for (const f of files)
        expect(f.text.includes(hook), `${f.name} mentions ${hook}`).toBe(false);
    });
  }

  it('no identifier ending in "ForTest" appears anywhere in the typings or the bundle', () => {
    for (const f of files) {
      const found = [...new Set(f.text.match(FOR_TEST) ?? [])];
      expect(found, `${f.name} carries a ForTest name`).toEqual([]);
    }
  });

  it('the exports of the bundle are the documented ones (no hook among them)', () => {
    const js = files.find((f) => f.name === 'index.js')!.text;
    const m = /export\s*\{([^}]*)\}\s*;?\s*$/m.exec(js);
    expect(m, 'the bundle ends with an export list').not.toBeNull();
    const names = m![1]!
      .split(',')
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/u)
          .pop()!,
      )
      .filter((s) => s !== '');
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) {
      expect(/ForTest$/u.test(n), `export ${n}`).toBe(false);
      expect(HOOK_NAMES.includes(n), `export ${n}`).toBe(false);
    }
  });
});
