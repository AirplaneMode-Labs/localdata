# localdata 0.4.0-alpha.1: an approximate index with an exact fallback for repeated text

**Status: draft, not published.** Prepared in Sprint 7 (20 Nov 2026) by the localdata developer. Nothing in it has been posted
or announced, and finishing it waits for the 8 GB laptop figure, which is the owner's. Every figure below is read from a file
committed in this repository (the file is named beside it); every laptop figure reads "not measured on 8 GB". All timings
are from an Apple M5 Pro with 48 GB.

## What this is

`@airplanemode/localdata` is a browser storage SDK: key-value over OPFS with an IndexedDB fallback, a flat vector index and an
optional HNSW graph, in a Rust crate compiled to WebAssembly with no third-party dependency. Nothing here is on a registry yet.

## What was tried

Documents repeat themselves: a page header, a licence paragraph, a table caption. Their chunks embed to byte-identical
vectors. In 0.4.0-alpha.0 an HNSW graph built over such data could return a full list of hits whose scores sat below what an
exact scan returns, with nothing in the query event to say so. The tester reproduced it (13 of 100 queries equal to the flat
scan on five groups of 80 copies; `docs/vector-index.md` states it), and `crates/ldvec/tests/hnsw_dup.rs` reproduces it again
on the Sprint 6 kernel (13 of 100 on five groups of 50 copies plus 100 distinct rows). The reason was in the kernel: copies of one
vector tie, the neighbour-selection rule accepted every tie, so once the copies outnumbered the list size they filled every
list of their group and the group became an island (the walk from the entry point reached 33 of 350 nodes).

The kernel now (format `LDHNSW02`, `docs/hnsw-format.md`) prunes a candidate whose bytes equal a kept neighbour's even on a
tie (comparing the bytes, never a hash), refills free slots from the pruned candidates, prefers the newest copy on a score
tie, and runs a search once more, wider, when a full result list repeats a score. A graph is also marked degenerate when its
largest group of identical rows, or of rows that are the same vector up to float noise (the low 12 mantissa bits of every
component), is larger than 2m (32 at the default m), and then the exact flat scan answers, with the fallback `duplicates` in
the event. The second rule exists because the tester showed that clusters of 500 and 1,000 rows one to three ulps apart, which are
not byte-identical, were still answered below the flat scan with no fallback; every set of the tester's harness is now answered by
the flat scan. A graph file of the old format is refused with the reason `version` and rebuilt once per
generation. A forged header that disagrees with the namespace's stored parameters is refused before anything is reserved: the
file that used to make the kernel reserve and zero-fill 516 MB is now refused with no allocation at all
(`crates/ldvec/tests/hnsw_header.rs`, a counting allocator). At 64 resident graphs a build now releases the in-memory copy of
the least recently used idle graph instead of failing.

## What held up

- At 100,000 x 384 with every vector stored 30 times (96,666 duplicate rows), the graph answers: 200 of 200 queries have the
  flat scan's ten scores at `ef` 64 and 128 and 199 of 200 at `ef` 32; the build took 50.0 s and the graph is 11.7 MB
  (`docs/benchmarks/ann-duplicates.csv`).
- On distinct clustered data the new format is a little larger and slower to build and a little more accurate. At 100,000 x
  384 the graph went from 10.6 MB to 11.9 MB and the build from 41.5 s to 55.4 s (medians of three runs), recall@10 at `ef` 32
  from 0.9965 to 0.998; at 1,000,000 x 384 the graph went from 107.5 MB to 118.7 MB, the build from 800 s to 932 s and
  recall@10 at `ef` 32 and 64 from 0.9035 and 0.98 to 0.949 and 0.995 (`docs/benchmarks/ann.csv` against
  `docs/benchmarks/ann-s6-format-v1.csv`; both under the load caveat below, one run at 1,000,000).
- Queries cost what they did: 0.1 ms at `ef` 64 on 100,000 rows against 3.6 ms for the flat scan (same files).

## What did not hold up

- The first design (prune copies by their bytes and refill from the pruned) missed the floors stated before measuring on
  several sets, a single widening pass fixed `k` = 10 on most, and a larger `k` showed that a group of copies larger than the
  lists was only partly reachable. Newest-first tie breaking and widening at construction fixed reachability, and the
  measured 100,000 x 384 set then showed what none of that fixes: with 60 copies of every vector the graph missed the best group
  in 2 of 100 queries at every `ef` (`scale_duplicates_100k` in `crates/ldvec/tests/hnsw_dup.rs` reproduces it natively), with 30
  copies it missed none at `ef` 64 and 128. So the graph is not trusted above 2m copies of one vector and the flat scan answers there: at 60 copies
  every query was answered by the flat scan, 200 of 200 equal, at 3.7 ms a query (`docs/benchmarks/ann-duplicates.csv`). The
  boundary is measured, not derived, and the reason (the widening is capped at 1,000 results) is likely but not shown.
- A namespace that repeats boilerplate more than 32 times therefore loses the graph's speed until the copies are removed. That is
  the price of never answering wrongly; collapsing copies into one node is the better design and is not built.
- The near-duplicate rule is a proxy, measured on synthetic sets only. It does not detect wider tight clusters: on 30 synthetic
  clusters of 500 rows at dim 384 with a relative spread of 1e-4, 1e-3 and 1e-2 per component the graph alone answered 92, 88 and
  78 of 100 queries with the flat scan's top-10 scores at `ef` 64 (99, 92 and 93 at `ef` 512), some queries returning top-10 scores below the flat scan's, and the rule
  did not fire (`docs/benchmarks/ann-near-duplicates.csv`). Detection depends on the data and the dimension. On a synthetic dim-384 set (30 groups of 500 rows) all-component float noise from about 1e-5 relative (about 256 ulp) upward was not detected: with +-256 ulp, +-1024 ulp, 1e-5 relative and 1e-4 relative noise in every component the graph alone answered 99, 95, 96 and 92 of 100 queries with the flat scan's top-10 scores at `ef` 64 (92 to 99 of 100) and the rule did not fire (`near_max` 1 to 3; the `noise` rows of `docs/benchmarks/ann-near-duplicates.csv`). At dim 32 the same noise at 256 ulp, 1024 ulp and 1e-5 relative was detected (the flat scan answered; 96, 93 and 98 of 100 for the graph alone) and 1e-4 relative was not (90 of 100). The flat scan is the way to get complete answers. Use the flat scan when a completeness decision depends on the answer. The duplicate
  statistics sit in the graph header and are not recounted at load, so a forged or lowered count can suppress the fallback
  (recall only; the same trust boundary as the stored vectors).
- The host-load columns added to the benchmark CSVs read from 2.36 to 886 during the run while one `top` sample showed the CPU
  89% idle, so the operating system's counter is not a reliable load figure here; the README labels the rows by the rule
  anyway (almost all of them "measured under load"). One real disturbance is visible: one run wrote its flat index in 5.5 s where
  the other two took about 1 s.
- Not measured on 8 GB: no figure above is an 8 GB figure, and the 1,000,000-row graph needs about 1.8 GB of WebAssembly memory
  on this machine (`docs/benchmarks/ann.csv`), which an 8 GB laptop has not been shown to survive.

## What is not done

Quantisation, compaction, encryption at rest, HNSW for the documents API and a batched delete (every delete rewrites the graph).
Reserving the npm name, the signing key and the publish are the owner's: `docs/RELEASING.md` lists the steps.
