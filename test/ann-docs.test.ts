// Fix round 1 (BUG-T2-S6-02, -03, -04): the README Limitations and docs/vector-index.md say plainly what the
// graph cannot do. Written before the wording. Each statement is pinned to the fact it rests on:
//
//   * identical vectors (-02): the graph can return fewer than k hits; the SDK detects it and answers flat
//     with fallback 'short'; the kernel root cause is Sprint 7
//   * the 64-graph cap (-03): a store's kernel holds at most 64 loaded graphs; the 65th buildIndex throws
//     quota_exceeded with reason 'max_graphs'
//   * deletes (-04): there is no batched delete; with a current graph every delete rewrites the whole
//     graph record (the figures are the committed docs/benchmarks/delete-cost.csv's: test/readme-delete-cost.test.ts
//     pins them; BUG-T2-S6-13); the bulk-delete workaround is dropIndex, delete, buildIndex
//
// Fix round 2:
//   * BUG-T2-S6-08: only buildIndex is capped at 64 graphs; a query (or a write) that must load a persisted
//     graph into a full table evicts the least recently used idle graph of another namespace and never throws
//     max_graphs; when every resident graph is in use the exact flat scan answers with fallback 'absent'
//   * BUG-T2-S6-11: after most rows are replaced, or after building over duplicate-heavy data, the graph
//     keeps the replaced nodes and recall can fall below a fresh build's; rebuild when
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
  it('says identical vectors can make the graph return fewer than k hits, and what the SDK does', () => {
    const t = text();
    has(t, /identical vectors/u);
    has(t, /fewer than `?k`?/u);
    has(t, /fallback:? ?'short'|fallback `short`|fallback 'short'|`fallback: 'short'`/u);
    has(t, /flat/u);
    has(t, /Sprint 7/u);
  });

  it('states the 64-graph cap and the distinct refusal', () => {
    const t = text();
    has(t, /64 graphs?/u);
    has(t, /max_graphs/u);
    has(t, /dropIndex/u);
  });

  it('says deletes do not batch, cites the committed CSV for the cost and gives the bulk-delete workaround', () => {
    const t = text();
    has(t, /batch them/u, false);
    has(t, /no (batched delete|`?deleteMany`?)/u);
    has(t, /Sprint 7/u);
    has(t, /docs\/benchmarks\/delete-cost\.csv/u);
    has(t, /100,000 x 32/u);
    has(t, /not measured on 8 GB/u);
    has(t, /dropIndex[^.]*delete[^.]*buildIndex/u);
    // no figure from an internal log (BUG-T2-S6-13)
    for (const n of INTERNAL) expect(t.toLowerCase().includes(n), `names ${n}`).toBe(false);
  });

  it('says a query no longer throws at the 64-graph cap: only buildIndex is capped, a load evicts the least recently used graph (BUG-T2-S6-08)', () => {
    const t = text();
    has(t, /only `?buildIndex`? is capped|`?buildIndex`? is the only call (that is )?capped/u);
    has(t, /least[- ]recently[- ]used/u);
    has(t, /never throws `?max_graphs`?|does not throw `?max_graphs`?|no longer throws/u);
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
