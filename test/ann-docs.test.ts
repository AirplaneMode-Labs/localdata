// Fix round 1 (BUG-T2-S6-02, -03, -04): the README Limitations and docs/vector-index.md say plainly what the
// graph cannot do. Written before the wording. Each statement is pinned to the fact it rests on:
//
//   * identical vectors (-02; Sprint 7: BUG-T2-S6-14, S1-124, TD-109): the kernel prunes exact copies by their
//     bytes; a group of copies larger than 2m makes the graph degenerate and the exact flat scan
//     answers with fallback 'duplicates'; 'short' stays as the safety net; the label "T2 measured" is gone and
//     the committed ann-duplicates.csv is cited
//   * the 64-graph cap (-03; Sprint 7: BUG-T2-S6-15, S1-125, TD-110): a store's kernel holds at most 64 loaded
//     graphs; buildIndex releases the least recently used idle one and throws quota_exceeded with reason
//     'max_graphs' only when every resident graph is busy; dropIndex frees a slot only if the graph was resident
//   * deletes (-04): there is no batched delete; with a current graph every delete rewrites the whole
//     graph record (the figures are the committed docs/benchmarks/delete-cost.csv's: test/readme-delete-cost.test.ts
//     pins them; BUG-T2-S6-13); the bulk-delete workaround is dropIndex, delete, buildIndex
//
// Fix round 2:
//   * BUG-T2-S6-08: only buildIndex is capped at 64 graphs; a query (or a write) that must load a persisted
//     graph into a full table evicts the least recently used idle graph of another namespace and never throws
//     max_graphs; when every resident graph is in use the exact flat scan answers with fallback 'absent'
//   * BUG-T2-S6-11: after most rows are replaced the graph keeps the replaced nodes and recall can fall below a
//     fresh build's (Sprint 7: duplicate-heavy data is handled by the kernel, see above); rebuild when
//     indexInfo(ns).ann.liveNodes / nodes is 0.5 or lower; compaction stays "not yet"; no recall figure
//   * BUG-T2-S6-13: no figure comes from an internal log: the README, the CHANGELOG and docs/*.md name no
//     tester log and no evidence folder as the source of a figure (the needles are built from pieces so this
//     file does not contain them)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const design = readFileSync(join(root, 'docs', 'vector-index.md'), 'utf8');

/** Wordings that would point a reader at an internal log for a figure (BUG-T2-S6-13). */
const INTERNAL = [
  ['t2', 'log'].join(' '),
  ['sprint-6', 'evidence'].join(' '),
  ['ldvec-ts', 'perf'].join('-'),
];

/** The Limitations section of the README, flattened to single spaces. */
function limitations(): string {
  const start = readme.indexOf('\n## Limitations');
  expect(start).toBeGreaterThan(0);
  const rest = readme.slice(start + 1);
  const next = rest.indexOf('\n## ', 5);
  return (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/gu, ' ');
}

/** Section 6 of docs/vector-index.md (HNSW), flattened to single spaces. */
function hnswDesign(): string {
  const start = design.indexOf('\n## 6. HNSW');
  expect(start).toBeGreaterThan(0);
  const rest = design.slice(start + 1);
  const next = rest.indexOf('\n## ', 5);
  return (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/gu, ' ');
}

/** Asserts with a short message: a failing pattern is named, the document text is not dumped. */
function has(t: string, re: RegExp, present = true): void {
  expect(re.test(t), `${present ? 'missing' : 'unexpected'} ${String(re)}`).toBe(present);
}

const docs: Array<[string, () => string]> = [
  ['README Limitations', limitations],
  ['docs/vector-index.md section 6', hnswDesign],
];

describe.each(docs)('%s', (_name, text) => {
  it('says what exact duplicates do to the graph, the degenerate rule, and cites the committed CSV (TD-109)', () => {
    const t = text();
    has(t, /identical vectors|exact (copies|duplicates)/u);
    has(t, /byte/u);
    has(t, /2 \* m|`2m`|\b2m\b/u);
    has(t, /degenerate/u);
    has(t, /fallback:? ?'duplicates'|fallback `duplicates`|`fallback: 'duplicates'`/u);
    has(t, /fallback:? ?'short'|fallback `short`|`fallback: 'short'`/u);
    has(t, /flat/u);
    has(t, /duplicateRows/u);
    has(t, /docs\/benchmarks\/ann-duplicates\.csv/u);
    has(t, /T2 measured/u, false);
    has(t, /kernel root cause is (Sprint 7|not fixed)|The kernel root cause is not fixed/u, false);
  });

  it('states the 64-graph cap, that buildIndex releases the least recently used idle graph, and when max_graphs is thrown (TD-110)', () => {
    const t = text();
    has(t, /64 graphs?/u);
    has(t, /max_graphs/u);
    has(t, /dropIndex/u);
    has(t, /least[- ]recently[- ]used/u);
    has(t, /idle/u);
    has(t, /every (one of the )?(64 )?resident graphs? (is|are) (busy|in use)/u);
    has(t, /frees a slot only if/u);
    // the old wording is gone
    has(
      t,
      /only `?buildIndex`? is capped|`?buildIndex`? is the only call (that is )?capped/u,
      false,
    );
    has(t, /The 65th `buildIndex` throws/u, false);
  });

  it('says deletes do not batch, cites the committed CSV for the cost and gives the bulk-delete workaround', () => {
    const t = text();
    has(t, /batch them/u, false);
    has(t, /no (batched delete|`?deleteMany`?)/u);
    has(t, /TD-96/u);
    has(t, /docs\/benchmarks\/delete-cost\.csv/u);
    has(t, /100,000 x 32/u);
    has(t, /not measured on 8 GB/u);
    has(t, /dropIndex[^.]*delete[^.]*buildIndex/u);
    // no figure from an internal log (BUG-T2-S6-13)
    for (const n of INTERNAL) expect(t.toLowerCase().includes(n), `names ${n}`).toBe(false);
  });

  it('says a query no longer throws at the 64-graph cap: a load (and, since Sprint 7, a build) evicts the least recently used idle graph (BUG-T2-S6-08, -15)', () => {
    const t = text();
    has(t, /least[- ]recently[- ]used/u);
    has(
      t,
      /never throws `?max_graphs`?|does not throw `?max_graphs`?|no longer throws|never makes a build or a load fail/u,
    );
    // the old wording is gone
    has(t, /would load a 65th graph throws/u, false);
    has(t, /Idle graphs are not unloaded yet/u, false);
    has(t, /Unloading idle graphs is not built/u, false);
  });

  it('names the one case where absent means not loadable right now: every resident graph in use (BUG-T2-S6-08)', () => {
    const t = text();
    has(t, /every resident graph is in use|every resident handle is in use/u);
    has(t, /fallback: 'absent'|fallback 'absent'|`absent`/u);
    has(t, /not loadable in this store right now/u);
    has(t, /exact flat scan|exact flat/u);
  });

  it('tells the caller to rebuild after most rows were replaced, and that compaction is not built (BUG-T2-S6-11)', () => {
    const t = text();
    has(t, /boilerplate/u);
    has(t, /liveNodes/u);
    has(t, /indexInfo\(ns\)\.ann|indexInfo\(`?ns`?\)\.ann/u);
    has(t, /0\.5/u);
    has(t, /buildIndex[^.]*again|again[^.]*buildIndex|rebuild/u);
    has(t, /recall[^.]*(below|lower|drop)|(below|lower|drop)[^.]*recall/u);
    has(t, /compaction/u);
    has(t, /not measured on 8 GB/u);
  });
});

describe('no figure in the documents comes from an internal log (BUG-T2-S6-13)', () => {
  const files = [
    'README.md',
    'CHANGELOG.md',
    ...readdirSync(join(root, 'docs'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => join('docs', n)),
  ];
  it.each(files)('%s names no tester log and no evidence folder for a figure', (f) => {
    const t = readFileSync(join(root, f), 'utf8').toLowerCase();
    for (const n of INTERNAL) expect(t.includes(n), `${f} names ${n}`).toBe(false);
  });
});

describe('the README never advises batching deletes', () => {
  it('has no "batch them" and no "so batch writes" without the put/delete distinction', () => {
    has(readme, /batch them/u, false);
    const hits = [...readme.matchAll(/so batch writes/gu)];
    expect(hits).toEqual([]);
  });
});

// ---- near-duplicates (fix round 1: BUG-T2-S7-02, TD-126; BUG-T2-S7-03, TD-127) ---------------------------------------
// The wording is pinned to the files it rests on: the committed figures (docs/benchmarks/ann-near-duplicates.csv) and the
// kernel's own constants (crates/ldvec/src/hnsw.rs).
describe('the near-duplicate rule is documented as it is (TD-126, TD-127)', () => {
  const hnswSrc = readFileSync(join(root, 'crates', 'ldvec', 'src', 'hnsw.rs'), 'utf8');
  const format = readFileSync(join(root, 'docs', 'hnsw-format.md'), 'utf8');
  const csv = readFileSync(join(root, 'docs', 'benchmarks', 'ann-near-duplicates.csv'), 'utf8')
    .trim()
    .split('\n');
  const HEADER =
    'commit,date_utc,machine,command,family,rows,dim,groups,per_group,seed_or_sigma,m,ef_construction,ef,k,queries,dup_max,near_max,degenerate,graph_alone_equal_to_flat,graph_alone_recall_at_10_by_score,answered_by,answer_equal_to_flat,eight_gb';
  const rows = csv.slice(1).map((l) => {
    const cells = l.match(/"[^"]*"|[^,]+/gu)!.map((c) => c.replace(/^"|"$/gu, ''));
    return Object.fromEntries(HEADER.split(',').map((h, i) => [h, cells[i]!]));
  });

  it('the CSV has the documented header, no 8 GB figure, and every T2 set is degenerate and answered by the flat scan', () => {
    expect(csv[0]).toBe(HEADER);
    expect(rows.length).toBe(33);
    for (const r of rows) expect(r['eight_gb']).toBe('not measured on 8 GB');
    const t2 = rows.filter((r) => r['family'] === 't2-gap' || r['family'] === 't2-unique');
    expect(t2).toHaveLength(10);
    for (const r of t2) {
      expect(r['degenerate'], `${r['family']} ${r['seed_or_sigma']}`).toBe('true');
      expect(r['answered_by']).toBe('flat');
      expect(r['answer_equal_to_flat']).toBe('100/100');
      expect(Number(r['near_max'])).toBeGreaterThan(32);
    }
  });

  it('the CSV holds the eight all-component noise rows (BUG-T2-S7-07): +-256 and +-1024 ulp, relative Gaussian 1e-5 and 1e-4, dims 32 and 384, 30 x 500, ef 64', () => {
    const noise = rows.filter((r) => r['family'] === 'noise');
    expect(noise).toHaveLength(8);
    const tags = new Set(noise.map((r) => `${r['dim']}:${r['seed_or_sigma']}`));
    for (const dim of ['32', '384'])
      for (const tag of ['ulp256', 'ulp1024', 'rel1e-5', 'rel1e-4'])
        expect(tags.has(`${dim}:${tag}`), `${dim} ${tag}`).toBe(true);
    for (const r of noise) {
      expect(r['groups']).toBe('30');
      expect(r['per_group']).toBe('500');
      expect(r['ef']).toBe('64');
    }
  });

  it('the README and docs/vector-index.md quote the jitter figures of the CSV (what the rule does not catch) and say the rule is a proxy on synthetic sets', () => {
    const jitter = (sigma: string, ef: string) =>
      rows.find((r) => r['family'] === 'jitter' && r['seed_or_sigma'] === sigma && r['ef'] === ef)!;
    const eq = (sigma: string, ef: string) =>
      jitter(sigma, ef)['graph_alone_equal_to_flat']!.split('/')[0];
    for (const sigma of ['1e-4', '1e-3', '1e-2'])
      expect(jitter(sigma, '64')['degenerate']).toBe('false');
    const at64 = `${eq('1e-4', '64')}, ${eq('1e-3', '64')} and ${eq('1e-2', '64')} of 100`;
    const at512 = `${eq('1e-4', '512')}, ${eq('1e-3', '512')} and ${eq('1e-2', '512')} at \`ef\` 512`;
    for (const [name, t] of [
      ['README', limitations()],
      ['vector-index', hnswDesign()],
    ] as const) {
      expect(t, `${name}: the jitter figures at ef 64`).toContain(at64);
      expect(t, `${name}: the jitter figures at ef 512`).toContain(at512);
      expect(t, `${name} cites the CSV`).toContain('ann-near-duplicates.csv');
      has(t, /synthetic/u);
      has(t, /proxy/u);
      has(t, /flat scan/u);
    }
  });

  it('the README no longer lists one-ulp near-duplicates among the sets that meet the floors on the graph', () => {
    const t = limitations();
    has(
      t,
      /Near-duplicates that differ in the last bit of a component are not byte duplicates; they never make a graph degenerate/u,
      false,
    );
    has(hnswDesign(), /they never make a graph degenerate/u, false);
    has(t, /quantised key/u);
    has(t, /wider tight clusters/iu);
  });

  it("the constants in the documents are the kernel's: HEADER_LEN, the nearMax word at offset 56, and the 12 low mantissa bits", () => {
    expect(/pub const HEADER_LEN: usize = (\d+);/u.exec(hnswSrc)![1]).toBe('60');
    expect(/pub const NEAR_DROP_BITS: u32 = (\d+);/u.exec(hnswSrc)![1]).toBe('12');
    expect(format).toMatch(/^56 +4 +nearMax /mu);
    expect(format).toMatch(/^60 +nsLen +namespace /mu);
    expect(format).toContain('`60 + nsLen + 8*nodeCount + 4*linkWords + 4`');
    expect(format).not.toContain('`56 + nsLen');
    for (const t of [limitations(), hnswDesign(), format.replace(/\s+/gu, ' ')])
      expect(t, 'names the 12 low mantissa bits').toMatch(
        /low 12 mantissa bits|low twelve mantissa bits/u,
      );
  });

  it('every document says that the counts are not recounted at load and that a lowered count suppresses the fallback (recall only)', () => {
    for (const [name, t] of [
      ['README', limitations()],
      ['vector-index', hnswDesign()],
      ['hnsw-format', format.replace(/\s+/gu, ' ')],
    ] as const) {
      expect(
        /not recounted (when a graph is loaded|at load)/iu.test(t),
        `${name}: not recounted at load`,
      ).toBe(true);
      expect(
        /(lowered|forged)[^.]*suppress/iu.test(t),
        `${name}: a lowered or forged count can suppress the fallback`,
      ).toBe(true);
      expect(/recall only/u.test(t), `${name}: recall only`).toBe(true);
      // the old claim, that a forged flag can only force the flat path, is never made without its other half
      for (const m of t.matchAll(/can only force/gu)) {
        const around = t.slice(Math.max(0, m.index! - 160), m.index! + 320);
        expect(
          /lowered/iu.test(around),
          `${name}: "can only force" appears without the lowered half`,
        ).toBe(true);
      }
    }
  });
});

// ---- fix round 2 (BUG-T2-S7-07, -08, -09) --------------------------------------------------------------------------
describe('what the near-duplicate rule detects depends on the data and the dimension (BUG-T2-S7-07)', () => {
  const format = readFileSync(join(root, 'docs', 'hnsw-format.md'), 'utf8').replace(/\s+/gu, ' ');
  const writeup = readFileSync(
    join(root, 'docs', 'writeup-0.4.0-alpha.1-draft.md'),
    'utf8',
  ).replace(/\s+/gu, ' ');
  const demo = readFileSync(join(root, 'demo', 'index.html'), 'utf8').replace(/\s+/gu, ' ');
  const csv = readFileSync(join(root, 'docs', 'benchmarks', 'ann-near-duplicates.csv'), 'utf8')
    .trim()
    .split('\n');
  const head = csv[0]!.split(',');
  const noise = csv
    .slice(1)
    .map((l) => l.match(/"[^"]*"|[^,]+/gu)!.map((c) => c.replace(/^"|"$/gu, '')))
    .map((c) => Object.fromEntries(head.map((h, i) => [h, c[i]!])))
    .filter((r) => r['family'] === 'noise');

  /** The graph-alone equal-to-flat counts of the dim-384 noise rows at about 1e-5 relative (+-256 ulp and 1e-5). */
  const at384 = (tag: string) =>
    noise.find((r) => r['dim'] === '384' && r['seed_or_sigma'] === tag)!;
  const equal = (r: Record<string, string>) =>
    Number(r['graph_alone_equal_to_flat']!.split('/')[0]);

  it("no dim-384 noise row was detected and each answered below flat on some queries; the range is the CSV's; dim 32 differs", () => {
    const tags = ['ulp256', 'ulp1024', 'rel1e-5', 'rel1e-4'];
    for (const tag of tags) {
      const r = at384(tag);
      expect(r['degenerate'], tag).toBe('false');
      expect(r['answered_by'], tag).toBe('graph');
      expect(equal(r), tag).toBeLessThan(100);
    }
    const eqs = tags.map((t) => equal(at384(t)));
    const lo = Math.min(...eqs);
    const hi = Math.max(...eqs);
    // the contrast the wording states: at dim 32 the first three shapes are detected, relative 1e-4 is not
    for (const r of noise.filter((x) => x['dim'] === '32'))
      expect(r['degenerate'], `dim 32 ${r['seed_or_sigma']}`).toBe(
        r['seed_or_sigma'] === 'rel1e-4' ? 'false' : 'true',
      );
    for (const [name, t] of [
      ['README', limitations()],
      ['vector-index', hnswDesign()],
      ['hnsw-format', format],
      ['write-up', writeup],
    ] as const) {
      expect(t, `${name}: the CSV range`).toContain(`${lo} to ${hi} of 100`);
      expect(t, `${name}: all-component noise`).toMatch(/all[- ]component (float )?noise/u);
      expect(t, `${name}: about 1e-5 relative, 256 ulp`).toMatch(/1e-5 relative/u);
      expect(t, `${name}: 256 ulp`).toMatch(/256 ulp/u);
      expect(t, `${name}: dim 32 contrast`).toMatch(/at dim 32/iu);
      expect(t, `${name}: depends on the data and the dimension`).toMatch(
        /depends on the data and (on )?the dimension/u,
      );
      expect(t, `${name}: flat scan for complete answers`).toMatch(/flat scan/u);
      expect(t, `${name}: cites the CSV`).toContain('ann-near-duplicates.csv');
      // the optimistic wording is gone: no claim that small spreads are safe or detected in general
      expect(t, `${name}: safe`).not.toMatch(/\b(is|are|stays?) safe\b|\bsafely\b/u);
      expect(t, `${name}: detected in general`).not.toMatch(/detected in general|always detected/u);
      // the one-set figure is scoped
      for (const m of t.matchAll(/1e-5 and 1e-6 gave 100 of 100/gu)) {
        const around = t.slice(m.index!, m.index! + 260);
        expect(/on that one (synthetic )?set/u.test(around), `${name}: unscoped 100 of 100`).toBe(
          true,
        );
      }
    }
  });

  it('the demo not-yet box and README line 15 do not claim detection of small spreads', () => {
    expect(demo).toMatch(/not detected/u);
    expect(demo).not.toMatch(/\bsafe\b/u);
    expect(readme.split('\n').slice(0, 30).join(' ')).not.toMatch(/\bsafe\b/u);
  });
});

describe('the per-put recount cost is stated (BUG-T2-S7-09)', () => {
  const format = readFileSync(join(root, 'docs', 'hnsw-format.md'), 'utf8').replace(/\s+/gu, ' ');
  it.each([
    ['README Limitations', limitations],
    ['docs/vector-index.md section 6', hnswDesign],
  ] as Array<[string, () => string]>)('%s', (_n, text) => {
    const t = text();
    has(t, /while a graph is resident,? every `putVectors` (call )?recounts all live rows/u);
    has(t, /two hashing passes and a sort/u);
    has(t, /grows linearly with the row count/u);
    // no figure that is not in a committed CSV, and no unmeasured 1,000,000-row figure
    has(t, /1,000,000[^.]*recount|recount[^.]*1,000,000/u, false);
    has(t, /no figure is quoted for it|extrapolated, not measured/u);
  });
  it('hnsw-format says the same', () => {
    expect(format).toMatch(/every `putVectors` recounts all live rows/u);
  });
});

describe('public prose names no tester role as the subject of a claim (BUG-T1-S7-12, BUG-T2-S7-08)', () => {
  const files = [
    'README.md',
    'CHANGELOG.md',
    ...readdirSync(join(root, 'docs'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => join('docs', n)),
  ];
  it.each(files)(
    "%s has no T1, T2 or T3 as a subject ('T2 showed', \"T2's tight-cluster sets\")",
    (f) => {
      const t = readFileSync(join(root, f), 'utf8');
      const hits = [
        ...t.matchAll(
          /\bT[123](?:'s)?\b (?:showed|measured|found|confirmed|tight|then|ran|runs|reproduction|uniform|synthetic)/gu,
        ),
      ].map((m) => m[0]);
      expect(hits).toEqual([]);
      expect([...t.matchAll(/\bT[123]'s\b/gu)].map((m) => m[0])).toEqual([]);
    },
  );
});

describe('the README says the Sprint 7 latency bench was not run on a quiet machine (D4 evidence correction)', () => {
  it('names the not-quiet slot, the fallback label, and that recall is the quiet-independent claim', () => {
    const t = readme.replace(/\s+/gu, ' ');
    expect(t).toMatch(/was not quiet/u);
    expect(t).toMatch(/885\.87/u);
    expect(t).toMatch(/every latency cell is labelled "\(measured under load\)"/u);
    expect(t).toMatch(/recall figures are the claim that does not depend on a quiet machine/u);
  });
});
