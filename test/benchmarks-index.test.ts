// Owner decision, 20 Nov 2026: every benchmark figure quoted anywhere has a raw file committed under docs/benchmarks/, the
// folder has an index (docs/benchmarks/README.md), the README Benchmarks section and the Pages demo link to it, and a
// figure with no committed row is "not done". Written before the index existed (the red run is in the commit message
// of this change). The rule itself lives in scripts/bench-figures.mjs; this file runs it on the real repository and,
// because a guard that cannot fail guards nothing, on copies of the repository with one thing broken each time.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GEN,
  checkCsv,
  parseCsv as parseWasmCsv,
  readModules,
  WASM_SIZE_CSV,
} from '../scripts/bench-wasm-size.mjs';
import {
  NOT_KEPT,
  NOT_KEPT_FIGURES,
  STANDING_LINE,
  checkFigures,
  checkIndex,
  figureTokens,
  loadInputs,
  parseIndex,
  prose,
  register,
  type Inputs,
} from '../scripts/bench-figures.mjs';

const root = join(import.meta.dirname, '..');
const real = loadInputs(root);
const text = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
const GITHUB_FOLDER = 'https://github.com/AirplaneMode-Labs/localdata/tree/main/docs/benchmarks';

/** A copy of the inputs that a test may break. */
const copy = (): Inputs => structuredClone(real);

describe('docs/benchmarks/README.md, the index', () => {
  it('lists every file of the folder with a status, date, commit and machine that match the file, and says how to reproduce each', () => {
    expect(checkIndex(real)).toEqual([]);
  });

  it('carries the standing line, says which files are historical baselines, and states the dirty-commit convention', () => {
    const md = text('docs', 'benchmarks', 'README.md');
    const idx = parseIndex(md);
    expect(idx.standing).toBe(true);
    expect(md).toContain(STANDING_LINE);
    expect(md).toContain('not measured on 8 GB');
    const baselines = idx.table
      .filter((r) => r.status === 'historical baseline')
      .map((r) => r.file);
    expect(baselines).toEqual(
      expect.arrayContaining(['ann-s6-format-v1.csv', 'vector-index.csv', 'documents.csv']),
    );
    expect(idx.table.some((r) => r.status === 'current')).toBe(true);
    expect(md).toMatch(/-dirty/u);
    expect(md).toMatch(/git describe --always --dirty/u);
  });

  it('lists a file only once, and every committed file is under 5 MB', () => {
    const files = parseIndex(text('docs', 'benchmarks', 'README.md')).table.map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    for (const [f, size] of Object.entries(real.sizes))
      expect(size, f).toBeLessThan(5 * 1024 * 1024);
  });

  it('fails when a file is in the folder and not in the index', () => {
    const d = copy();
    d.files.push('surprise.csv');
    expect(checkIndex(d).join('\n')).toContain(
      'surprise.csv is in docs/benchmarks/ but not in the index table',
    );
  });

  it('fails when the index names a file the folder does not have', () => {
    const d = copy();
    d.files = d.files.filter((f) => f !== 'delete-cost.csv');
    expect(checkIndex(d).join('\n')).toContain(
      'the index lists delete-cost.csv, which is not in docs/benchmarks/',
    );
  });

  it('fails when the index says another commit, date or machine than the rows do', () => {
    for (const [from, to, needle] of [
      ['`8abd87b-dirty`', '`1111111`', 'the index says commit 1111111'],
      ['2026-11-14', '2026-10-01', 'the index says 2026-10-01'],
      [
        'Apple M5 Pro, 48 GB',
        'Apple M5 Max, 128 GB',
        'the index says machine Apple M5 Max, 128 GB',
      ],
    ] as const) {
      const d = copy();
      d.texts['docs/benchmarks/README.md'] = d.texts['docs/benchmarks/README.md']!.replace(
        from,
        to,
      );
      expect(checkIndex(d).join('\n'), from).toContain(needle);
    }
  });

  it('fails when the standing line, a Reproduce command or a Figures-with-no-raw-data entry is missing', () => {
    const base = real.texts['docs/benchmarks/README.md']!;
    const cases: Array<[string, string, string]> = [
      [STANDING_LINE, 'Something else.', 'the index lacks the standing line'],
      ['npm run bench:ann`', 'npm run bench:nothing`', 'is not a script of package.json'],
      [
        '70 to 90 ms',
        'seventy',
        'the index has no "Figures with no raw data" entry for "70 to 90 ms"',
      ],
    ];
    for (const [from, to, needle] of cases) {
      const d = copy();
      d.texts['docs/benchmarks/README.md'] = base.replaceAll(from, to);
      expect(checkIndex(d).join('\n'), from).toContain(needle);
    }
  });

  it('fails when a document names a benchmark file that does not exist', () => {
    const d = copy();
    d.texts['README.md'] += '\nSee docs/benchmarks/nope.csv.\n';
    expect(checkIndex(d).join('\n')).toContain(
      'README.md names docs/benchmarks/nope.csv, which does not exist',
    );
  });
});

describe('every quoted figure has a committed row', () => {
  it('every figure of the README (outside its generated blocks), the CHANGELOG, docs/*.md, the demo and the generators is computed from a committed row, a stated floor or constant, or marked "raw data not kept"', () => {
    expect(checkFigures(real)).toEqual([]);
  });

  it('computes each figure from the CSVs: the register is non-empty and every entry has a source and a document that quotes it', () => {
    const reg = register(real);
    expect(reg.length).toBeGreaterThanOrEqual(15);
    for (const e of reg) {
      expect(e.source, e.id).not.toBe('');
      expect(e.tokens.length, e.id).toBeGreaterThan(0);
      expect(e.docs.length, e.id).toBeGreaterThan(0);
    }
  });

  it('recognises the shapes of a quoted figure and ignores machine labels, versions and dimensions', () => {
    const tokens = (t: string) => figureTokens(t).map((x) => x.token);
    expect(tokens('92, 88 and 78 of 100 queries; (99, 92 and 93 at ef 512)')).toEqual([
      '92, 88 and 78 of 100',
      '99, 92 and 93 at ef 512',
    ]);
    expect(
      tokens(
        '91 to 98 of 100, 200 of 200, 70 to 90 ms, 22.80 ms, 6.3 hours, 50 s, 11.7 MB, 0.9965, 10.2x, 89%',
      ),
    ).toEqual([
      '91 to 98 of 100',
      '200 of 200',
      '70 to 90 ms',
      '22.80 ms',
      '6.3 hours',
      '50 s',
      '11.7 MB',
      '0.9965',
      '10.2x',
      '89%',
    ]);
    expect(
      tokens(
        'Apple M5 Pro, 48 GB; not measured on 8 GB; Rust 1.98; 100,000 x 384; 8 MiB parts; ef 64',
      ),
    ).toEqual([]);
  });

  it('fails on a figure invented in the README, the demo or a doc: 12.3 ms, 4.5 MB, 97 of 100, 0.987 and 3.2x', () => {
    for (const [rel, claim] of [
      ['README.md', 'A query takes 12.3 ms.'],
      ['demo/index.html', '<p>The graph is 4.5 MB.</p>'],
      ['docs/vector-index.md', 'The graph answered 97 of 100.'],
      ['docs/hnsw-format.md', 'Recall was 0.987.'],
      ['CHANGELOG.md', 'It is 3.2x faster.'],
    ] as const) {
      const d = copy();
      d.texts[rel] += `\n${claim}\n`;
      const p = checkFigures(d).join('\n');
      expect(p, rel).toContain(`${rel}: the figure "`);
      expect(p, rel).toContain('is not computed from any committed row');
    }
  });

  it('fails when a committed row no longer bears out a figure in the prose', () => {
    const d = copy();
    const row = d.csv['ann-duplicates.csv']!.find(
      (r) => r['copies_per_vector'] === '30' && r['ef_search'] === '64',
    )!;
    row['build_ms'] = '40010.2';
    row['ann_bytes'] = '9000000';
    const p = checkFigures(d).join('\n');
    expect(p).toContain('is quoted in none of');
    expect(p).toMatch(/the figure "50 s"|the figure "11\.7 MB"/u);
  });

  it('fails when a claim the register leans on is not true of the rows (a 2m boundary that moved)', () => {
    const d = copy();
    for (const r of d.csv['ann-scale-duplicates-native.csv']!)
      if (r['copies_per_vector'] === '60') r['degenerate'] = 'false';
    expect(checkFigures(d).join('\n')).toContain(
      'do not bear out "30 copies are not degenerate and 60 are',
    );
  });

  it('fails when a figure without a raw file loses its "raw data not kept" mark', () => {
    for (const n of NOT_KEPT_FIGURES) {
      for (const rel of n.docs) {
        const d = copy();
        d.texts[rel] = d.texts[rel]!.replaceAll(NOT_KEPT, 'raw data lost');
        const p = checkFigures(d).join('\n');
        expect(p, `${n.id} in ${rel}`).toMatch(/is not marked "raw data not kept"/u);
      }
    }
  });

  it('fails when a figure that was marked "raw data not kept" is gone from the document that the register says quotes it', () => {
    const d = copy();
    d.texts['docs/writeup-0.4.0-alpha.1-draft.md'] = d.texts[
      'docs/writeup-0.4.0-alpha.1-draft.md'
    ]!.replaceAll('89%', 'most');
    expect(checkFigures(d).join('\n')).toContain('"89%" is no longer quoted');
  });

  it('fails when a figure is quoted beside a path that is not in this repository', () => {
    const d = copy();
    d.texts['CHANGELOG.md'] +=
      '\nThe probe read 12 MB (evidence/sprint-9/T1/results/probe.json).\n';
    expect(checkFigures(d).join('\n')).toContain('a path that is not in this repository');
  });

  it('keeps the generated README blocks out of the scan and the hand-written text in it', () => {
    const t =
      'before\n<!-- bench:begin (x) -->\nA 9.9 ms row\n<!-- bench:end -->\nafter 1.5 ms\n```sh\nnpm 7.7 ms\n```\n';
    const p = prose('README.md', t);
    expect(p).toContain('before');
    expect(p).toContain('1.5 ms');
    expect(p).not.toContain('9.9 ms');
    expect(p).not.toContain('7.7 ms');
  });

  it('every "raw data not kept" figure is a figure of the documents today: none was left behind in the register', () => {
    for (const n of NOT_KEPT_FIGURES)
      for (const rel of n.docs)
        for (const t of n.tokens)
          expect(real.texts[rel]!.replace(/\s+/gu, ' '), `${t} in ${rel}`).toContain(t);
  });
});

describe('the README Benchmarks section and the Pages demo link to the raw results', () => {
  const readme = text('README.md');
  const section = (() => {
    const start = readme.indexOf('\n## Benchmarks');
    const rest = readme.slice(start + 1);
    return rest.slice(0, rest.indexOf('\n## ', 5));
  })();

  it('the README Benchmarks section links docs/benchmarks/ and its index and says where the figures come from', () => {
    expect(section).toContain('(docs/benchmarks/README.md)');
    expect(section).toContain('(docs/benchmarks/)');
    expect(section).toContain(STANDING_LINE);
    expect(section.toLowerCase()).toContain('raw');
  });

  it('the demo page links the GitHub folder with a plain link (no script, no remote asset) and the status line is untouched', () => {
    const html = text('demo', 'index.html');
    expect(html).toMatch(new RegExp(`<a href="${GITHUB_FOLDER}"\\s*>`, 'u'));
    expect(html.match(new RegExp(GITHUB_FOLDER, 'gu'))).toHaveLength(2); // the header paragraph and the footer
    const status = />(Sprint 7 \(20 Nov 2026\): Working: [^<]+)<\/p>/u.exec(html);
    expect(status, 'the pinned status line is still there').not.toBeNull();
    expect(status![1]).toMatch(/\. Not yet: .+\.$/u);
    expect(status![1]).toContain('in the measured synthetic sets');
  });

  it('the README Develop section names every command that writes or checks the raw files', () => {
    for (const c of [
      'npm run bench:vectors',
      'npm run bench:documents',
      'npm run bench:ann',
      'npm run bench:delete-cost',
      'npm run bench:wasm-size',
      'npm run bench:check',
    ])
      expect(readme, c).toContain(c);
    expect(readme).toContain('scale_duplicate_figures');
    expect(readme).toContain('near_duplicate_figures');
  });

  it('package.json has the bench:wasm-size and bench:check scripts', () => {
    const scripts = JSON.parse(text('package.json')).scripts as Record<string, string>;
    expect(scripts['bench:wasm-size']).toBe('node scripts/bench-wasm-size.mjs --write');
    expect(scripts['bench:check']).toContain('node scripts/bench-figures.mjs');
    expect(scripts['bench:check']).toContain('--check');
  });
});

describe('docs/benchmarks/wasm-size.csv (the figure behind "under 100 KB")', () => {
  const rows = parseWasmCsv(readFileSync(WASM_SIZE_CSV, 'utf8'));

  it('has a row per module, each within the 100 KiB budget the module test asserts', () => {
    expect(checkCsv(rows)).toEqual([]);
    expect(rows.map((r) => r['module']).sort()).toEqual(['scalar', 'simd']);
    for (const r of rows) {
      expect(r['command']).toBe('npm run bench:wasm-size');
      expect(r['sha256']).toMatch(/^[0-9a-f]{64}$/u);
      expect(r['toolchain']).toMatch(/^rustc 1\.98\./u);
    }
  });

  it.skipIf(!existsSync(GEN))(
    'the modules built from this checkout are within the budget too',
    () => {
      const built = readModules();
      expect(checkCsv(rows, built)).toEqual([]);
    },
  );

  it('fails when a recorded size is over the budget or the budget was loosened', () => {
    const over = structuredClone(rows);
    over[0]!['bytes'] = '120000';
    expect(checkCsv(over).join('\n')).toContain('over budget');
    const loose = structuredClone(rows);
    for (const r of loose) r['budget_bytes'] = '204800';
    expect(checkCsv(loose).join('\n')).toContain('the recorded budget is not 102400');
  });
});

describe('the --check mode of the README block generators', () => {
  const run = (script: string, args: string[]) => {
    try {
      const out = execFileSync(process.execPath, [join(root, 'scripts', script), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  const generators: Array<[string, string, string]> = [
    ['bench-readme.mjs', 'bench:begin', '| 100,000 x 384, 256-byte chunks | opfs |'],
    [
      'bench-docs-readme.mjs',
      'docs-bench:begin',
      '| putDocument, one document of 200 chunks | opfs |',
    ],
    ['bench-ann-readme.mjs', 'ann-bench:begin', '| clustered | 100,000 | flat |'],
  ];

  it.each(generators)('%s --check passes on the committed README', (script) => {
    const r = run(script, ['--check']);
    expect(r.out).toContain('is up to date');
    expect(r.code).toBe(0);
  });

  it.each(generators)(
    '%s --check exits 1 and names the block when a figure of the README block was edited by hand',
    (script, marker, rowStart) => {
      const dir = mkdtempSync(join(tmpdir(), 'bench-check-'));
      try {
        const mutated = text('README.md').replace(rowStart, `${rowStart.slice(0, -1)} ~|`);
        expect(mutated, 'the mutation changed the README').not.toBe(text('README.md'));
        const file = join(dir, 'README.md');
        writeFileSync(file, mutated);
        const r = run(script, ['--check', '--readme', file]);
        expect(r.code).toBe(1);
        expect(r.out).toContain(marker.split(':')[0]);
        expect(r.out).toContain('differs from the CSV');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
