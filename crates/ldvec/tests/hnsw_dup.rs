//! D4-01 (TD-109; BUG-T2-S6-14 / S1-124): the HNSW kernel over data with many exact duplicate vectors.
//! Written before the kernel fix.
//!
//! Sprint 6 left this open: a fresh build over data with tens of exact copies per vector answered with
//! top-k scores below the flat scan's (T2: 13 of 100 queries equal to flat on 5 groups x 80 copies +
//! 100 distinct rows), with no fallback event. The thresholds below were fixed before the first
//! measurement of the fix and are not changed after seeing a number:
//!
//!   * on every duplicate set, at ef 64, at least 99 of 100 queries have a top-10 whose scores are
//!     (as a multiset, bit for bit) the flat scan's top-10 scores, AND the mean recall@10 by score is at
//!     least 0.99;
//!   * the recall floors of `tests/hnsw.rs` (10,000 x 384 clustered at least 0.95) are not lowered.
//!
//! Recall for tied data is counted by score, not by key: ten identical rows are interchangeable, so a
//! hit counts when its score is at least the flat scan's 10th best score.
//!
//! The generator is the integer-only `tests/support/synth.rs` (the same bytes in Rust and TypeScript).
//! The base vectors and the queries come from its CLUSTERED stream (20 centres), the shape the project's
//! recall floors use and on which a graph over distinct rows meets them; T2's own probe (uniform rows, dim
//! 8) is kept as `t2_uniform_probe`. Uniform rows at dim 384 are the worst case for any graph index (the
//! README's own table: recall 0.08 at ef 64 with no duplicates at all), so no threshold about duplicates is
//! stated on them: a duplicate threshold on data the graph already misses without duplicates would measure
//! the data, not the duplicates.
//! The default sets are sized for `cargo test` on three operating systems; `full_scale_duplicate_matrix`
//! (ignored by default, `cargo test --release -- --ignored`) runs the 1,000 base vectors x {10, 60, 200}
//! copies matrix at dims 32 and 384 and its figures are logged by the sprint scripts.
mod common;
#[path = "support/synth.rs"]
mod synth;

use common::SplitMix64;
use ldvec::hnsw::{Graph, Hit, Params, Rows};
use ldvec::scan;

const COSINE: u32 = 0;
const EF: usize = 64;
/// The `ef` of the k = 50 checks: a graph query with k close to ef misses distinct neighbours by itself (the
/// distinct baseline does too), and what that check looks for is copies, not tuning.
const EF_LARGE: usize = 200;
const K: usize = 10;
/// A second k: with copies of one vector the answer must fill a k above the number of copies a graph walk
/// happens to reach (T2 found 34 hits for k = 50).
const K_LARGE: usize = 50;
const QUERIES: usize = 100;
/// Fixed before measuring.
const MIN_EQUAL_QUERIES: usize = 99;
const MIN_MEAN_RECALL: f64 = 0.99;

fn params(m: u32, efc: u32, seed: u32) -> Params {
    Params {
        metric: COSINE,
        m,
        ef_construction: efc,
        seed,
    }
}

fn norms_of(vec: &[f32], dim: usize) -> Vec<f32> {
    let rows = vec.len() / dim;
    let mut out = vec![0.0f32; rows];
    scan::inv_norms(vec, rows, dim, &mut out);
    out
}

/// The flat scan's best `k` scores (bit patterns), best first.
fn flat_top_scores(vec: &[f32], norms: &[f32], dim: usize, q: &[f32], k: usize) -> Vec<u32> {
    let rows = vec.len() / dim;
    let mut scores = vec![0.0f32; rows];
    scan::scan(
        vec,
        rows,
        dim,
        norms,
        q,
        scan::inv_norm(q),
        COSINE,
        &mut scores,
    );
    scores.sort_by(|a, b| b.total_cmp(a));
    scores.truncate(k);
    scores.iter().map(|s| s.to_bits()).collect()
}

fn graph_top_scores(hits: &[Hit], k: usize) -> Vec<u32> {
    let mut s: Vec<f32> = hits.iter().map(|h| h.score).collect();
    s.sort_by(|a, b| b.total_cmp(a));
    s.truncate(k);
    s.iter().map(|x| x.to_bits()).collect()
}

/// Hits of the graph whose score is at least the flat scan's k-th best score, over k.
fn recall_by_score(hits: &[Hit], flat: &[u32], k: usize) -> f64 {
    let Some(&kth) = flat.last() else {
        return 1.0;
    };
    let kth = f32::from_bits(kth);
    let mut got: Vec<&Hit> = hits.iter().collect();
    got.sort_by(|a, b| b.score.total_cmp(&a.score));
    got.truncate(k);
    let good = got
        .iter()
        .filter(|h| h.score.total_cmp(&kth) != core::cmp::Ordering::Less)
        .count();
    good as f64 / flat.len().max(1) as f64
}

// ---- the data sets ----------------------------------------------------------------------------

struct DataSet {
    name: String,
    dim: usize,
    vec: Vec<f32>,
    /// The queries of the set (QUERIES x dim).
    queries: Vec<f32>,
    /// The duplicate group of every row (`u32::MAX` for a row that has no copy).
    group: Vec<u32>,
    /// The size of the largest group of byte-identical rows, known from how the set is made.
    max_group: u32,
}

const CENTRES: usize = 20;

/// `count` distinct rows and `QUERIES` queries from the clustered stream (same centres).
fn clustered_base(seed: u32, count: usize, dim: usize) -> (Vec<f32>, Vec<f32>) {
    synth::clustered(seed, CENTRES, dim, count.max(1), QUERIES)
}

/// `groups` distinct vectors, `copies` exact copies of each, then `unique` distinct rows.
fn boilerplate(dim: usize, groups: usize, copies: usize, unique: usize, seed: u32) -> DataSet {
    let (pts, queries) = clustered_base(seed, groups + unique, dim);
    let mut vec = Vec::with_capacity((groups * copies + unique) * dim);
    let mut group = Vec::new();
    for g in 0..groups {
        for _ in 0..copies {
            vec.extend_from_slice(&pts[g * dim..(g + 1) * dim]);
            group.push(g as u32);
        }
    }
    vec.extend_from_slice(&pts[groups * dim..(groups + unique) * dim]);
    group.extend(std::iter::repeat_n(u32::MAX, unique));
    DataSet {
        name: format!("{groups} groups x {copies} copies + {unique} distinct, dim {dim}"),
        dim,
        vec,
        queries,
        group,
        max_group: copies.max(1) as u32,
    }
}

/// One vector repeated `copies` times among `distinct` other rows.
fn one_repeated(dim: usize, copies: usize, distinct: usize, seed: u32) -> DataSet {
    let mut d = boilerplate(dim, 1, copies, distinct, seed);
    d.name = format!("one vector x {copies} + {distinct} distinct, dim {dim}");
    d
}

/// Every row identical.
fn all_identical(dim: usize, n: usize, seed: u32) -> DataSet {
    let mut d = boilerplate(dim, 1, n, 0, seed);
    d.name = format!("all {n} rows identical, dim {dim}");
    d
}

/// Distinct rows only: the ceiling any duplicate result is read against.
fn distinct_only(dim: usize, n: usize, seed: u32) -> DataSet {
    let (vec, queries) = clustered_base(seed, n, dim);
    DataSet {
        name: format!("{n} distinct rows (baseline), dim {dim}"),
        dim,
        group: vec![u32::MAX; n],
        vec,
        queries,
        max_group: 1,
    }
}

/// T2's probe: uniform rows (not clustered), `groups` x `copies` + `unique`, as in Sprint 6's reproduction.
fn uniform_probe(dim: usize, groups: usize, copies: usize, unique: usize, seed: u32) -> DataSet {
    let base = synth::uniform(seed, synth::DATA_STREAM, groups + unique, dim);
    let mut vec = Vec::new();
    let mut group = Vec::new();
    for g in 0..groups {
        for _ in 0..copies {
            vec.extend_from_slice(&base[g * dim..(g + 1) * dim]);
            group.push(g as u32);
        }
    }
    vec.extend_from_slice(&base[groups * dim..]);
    group.extend(std::iter::repeat_n(u32::MAX, unique));
    DataSet {
        name: format!("uniform {groups} groups x {copies} copies + {unique} distinct, dim {dim}"),
        dim,
        vec,
        queries: synth::uniform(seed ^ 0x77, synth::QUERY_STREAM, QUERIES, dim),
        group,
        max_group: copies.max(1) as u32,
    }
}

/// `groups` groups of `per_group` near-duplicates: copy `c` of a group differs from the group's base in
/// two components by exactly one unit in the last place (no copy is a byte-for-byte duplicate).
fn near_duplicates(dim: usize, groups: usize, per_group: usize, seed: u32) -> DataSet {
    let (base, queries) = clustered_base(seed, groups, dim);
    let mut vec = Vec::with_capacity(groups * per_group * dim);
    let mut group = Vec::new();
    for g in 0..groups {
        for c in 0..per_group {
            let mut v = base[g * dim..(g + 1) * dim].to_vec();
            if c > 0 {
                for j in [(c * 7) % dim, (c * 13 + 3) % dim] {
                    v[j] = f32::from_bits(v[j].to_bits() + 1);
                }
            }
            vec.extend_from_slice(&v);
            group.push(g as u32);
        }
    }
    DataSet {
        name: format!("{groups} groups x {per_group} one-ulp near-duplicates, dim {dim}"),
        dim,
        vec,
        queries,
        group,
        max_group: 1,
    }
}

// ---- T2's tight-cluster sets (BUG-T2-S7-02, TD-126) -----------------------------------------------
//
// Written before the near-duplicate rule. T2 (Sprint 7 review) found that groups of hundreds of vectors one to
// three units in the last place apart (never byte-identical, or only partly) at dim 384 are missed by the graph in
// 2 to 9 of 100 queries and no fallback fires: the best group is not reached, the answer is worse than the flat
// scan's. The generators below are T2's (own SplitMix64 stream, own seeds) so its numbers reproduce:
// `dupcheck --neardup-gap` (variants of a base, some exact repeats) and `--neardup-unique` (every row distinct).
// The acceptance is T2's: at ef 64 at least 99 of 100 queries have the flat scan's scores and the mean recall@10
// is at least 0.99, OR the graph is degenerate and the host answers by the exact flat scan.
mod t2sets {
    pub struct Rng(pub u64);
    impl Rng {
        pub fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
        fn unit(&mut self) -> f32 {
            ((self.next() >> 40) as f32) / 16_777_216.0
        }
        fn gauss(&mut self) -> f32 {
            let mut s = 0.0f32;
            for _ in 0..12 {
                s += self.unit();
            }
            s - 6.0
        }
        pub fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn centres_points(
        rng: &mut Rng,
        dim: usize,
        distinct: usize,
        centres: usize,
        sigma: f32,
    ) -> Vec<Vec<f32>> {
        let cs: Vec<Vec<f32>> = (0..centres)
            .map(|_| (0..dim).map(|_| rng.gauss()).collect())
            .collect();
        (0..distinct)
            .map(|_| {
                let c = &cs[rng.below(centres)];
                c.iter().map(|x| x + sigma * rng.gauss()).collect()
            })
            .collect()
    }

    /// 40 exact data points, 40 perturbed data points and 20 points between two data points.
    fn queries_for(rng: &mut Rng, base: &[Vec<f32>]) -> Vec<f32> {
        let mut q: Vec<Vec<f32>> = Vec::new();
        for _ in 0..40 {
            q.push(base[rng.below(base.len())].clone());
        }
        for _ in 0..40 {
            let b = &base[rng.below(base.len())];
            q.push(b.iter().map(|x| x + 0.05 * rng.gauss()).collect());
        }
        for _ in 0..20 {
            let a = &base[rng.below(base.len())];
            let b = &base[rng.below(base.len())];
            q.push(
                a.iter()
                    .zip(b)
                    .map(|(x, y)| 0.5 * (x + y) + 0.02 * rng.gauss())
                    .collect(),
            );
        }
        q.into_iter().flatten().collect()
    }

    fn shuffle<T>(rng: &mut Rng, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = rng.below(i + 1);
            v.swap(i, j);
        }
    }

    /// (rows, queries): `groups` groups of `per_group` variants of a base, each variant one to three ulps off in ONE
    /// random component (so the same variant repeats, and exact copies exist inside a group).
    pub fn near_dup(
        seed: u64,
        dim: usize,
        groups: usize,
        per_group: usize,
    ) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Rng(seed);
        let base = centres_points(&mut rng, dim, groups, 5, 0.3);
        let mut rows: Vec<Vec<f32>> = Vec::new();
        for b in &base {
            for _ in 0..per_group {
                let mut v = b.clone();
                let j = rng.below(dim);
                let ulps = 1 + rng.below(3) as u32;
                v[j] = f32::from_bits(v[j].to_bits().wrapping_add(ulps));
                rows.push(v);
            }
        }
        shuffle(&mut rng, &mut rows);
        let queries = queries_for(&mut rng, &base);
        (rows.into_iter().flatten().collect(), queries)
    }

    /// (rows, queries): `groups` groups of `per_group` rows, each the group's base plus `sigma * gauss` in EVERY
    /// component (a relative spread of about `sigma`; magnitudes are about 0.3 to 3). D4's characterisation of what the
    /// near-duplicate key does not catch, built on T2's generator.
    pub fn jitter(
        seed: u64,
        dim: usize,
        groups: usize,
        per_group: usize,
        sigma: f32,
    ) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Rng(seed);
        let base = centres_points(&mut rng, dim, groups, 5, 0.3);
        let mut rows: Vec<Vec<f32>> = Vec::new();
        for b in &base {
            for _ in 0..per_group {
                rows.push(b.iter().map(|x| x + sigma * rng.gauss()).collect());
            }
        }
        shuffle(&mut rng, &mut rows);
        let queries = queries_for(&mut rng, &base);
        (rows.into_iter().flatten().collect(), queries)
    }

    /// How the all-component noise of `noise` is drawn (BUG-T2-S7-07).
    #[derive(Clone, Copy)]
    pub enum Noise {
        /// every component moved by a uniform integer in `[-n, n]` ulps (the bit pattern plus that integer)
        Ulps(u32),
        /// every component multiplied by `1 + sigma * gauss`
        Relative(f32),
    }

    /// (rows, queries): `groups` groups of `per_group` rows, each the group's base with float noise in EVERY
    /// component (the all-component shapes of the noise rows of `ann-near-duplicates.csv`).
    pub fn noise(
        seed: u64,
        dim: usize,
        groups: usize,
        per_group: usize,
        kind: Noise,
    ) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Rng(seed);
        let base = centres_points(&mut rng, dim, groups, 5, 0.3);
        let mut rows: Vec<Vec<f32>> = Vec::new();
        for b in &base {
            for _ in 0..per_group {
                rows.push(
                    b.iter()
                        .map(|&x| match kind {
                            Noise::Ulps(n) => {
                                let d = rng.below(2 * n as usize + 1) as i64 - n as i64;
                                f32::from_bits((x.to_bits() as i64 + d) as u32)
                            }
                            Noise::Relative(sigma) => x * (1.0 + sigma * rng.gauss()),
                        })
                        .collect(),
                );
            }
        }
        shuffle(&mut rng, &mut rows);
        let queries = queries_for(&mut rng, &base);
        (rows.into_iter().flatten().collect(), queries)
    }

    /// (rows, queries): every row DISTINCT (no byte-identical pair), variants of a base in one or two components.
    pub fn near_unique(
        seed: u64,
        dim: usize,
        groups: usize,
        per_group: usize,
    ) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Rng(seed);
        let base = centres_points(&mut rng, dim, groups, 5, 0.3);
        let mut rows: Vec<Vec<f32>> = Vec::new();
        for b in &base {
            for c in 0..per_group {
                let mut v = b.clone();
                let j1 = c % dim;
                let j2 = (c / dim + 7 * c + 1) % dim;
                let u1 = 1 + (c % 3) as u32;
                let u2 = 1 + ((c / 3) % 3) as u32;
                v[j1] = f32::from_bits(v[j1].to_bits().wrapping_add(u1));
                if j2 != j1 {
                    v[j2] = f32::from_bits(
                        v[j2]
                            .to_bits()
                            .wrapping_add(u2 * (c as u32 / dim as u32 + 1)),
                    );
                }
                rows.push(v);
            }
        }
        shuffle(&mut rng, &mut rows);
        let queries = queries_for(&mut rng, &base);
        (rows.into_iter().flatten().collect(), queries)
    }
}

/// T2's gap set (`dupcheck --neardup-gap` seeds: 9,000,000 + seed * 101 + per_group), dim `dim`, 30 groups.
fn t2_gap_set(dim: usize, per_group: usize, seed: u64) -> DataSet {
    let (vec, queries) = t2sets::near_dup(
        9_000_000 + seed * 101 + per_group as u64,
        dim,
        30,
        per_group,
    );
    let n = vec.len() / dim;
    DataSet {
        name: format!("T2 near-dup gap 30 x {per_group}, dim {dim}, seed {seed}"),
        dim,
        vec,
        queries,
        group: vec![u32::MAX; n],
        max_group: 0, // not known from how the set is made: only the floors are asserted by `check_floors`
    }
}

/// T2's all-distinct tight-cluster set (`dupcheck --neardup-unique` seeds: 12,000,000 + seed).
fn t2_unique_set(dim: usize, per_group: usize, seed: u64) -> DataSet {
    let (vec, queries) = t2sets::near_unique(12_000_000 + seed, dim, 30, per_group);
    let n = vec.len() / dim;
    DataSet {
        name: format!("T2 all-distinct tight clusters 30 x {per_group}, dim {dim}, seed {seed}"),
        dim,
        vec,
        queries,
        group: vec![u32::MAX; n],
        max_group: 1,
    }
}

// ---- measuring --------------------------------------------------------------------------------

struct Measure {
    equal: usize,
    mean_recall: f64,
    short: usize,
}

fn build(d: &DataSet, p: &Params) -> Graph {
    let norms = norms_of(&d.vec, d.dim);
    let rows = Rows::contiguous(&d.vec, &norms, d.dim).expect("rows");
    Graph::build(p, b"dup", 1, &rows, &[]).expect("build")
}

fn measure(g: &mut Graph, d: &DataSet, k: usize, ef: usize) -> Measure {
    measure_with(g, d, k, ef, None)
}

/// As `measure`; with `reach` (per group: reachable rows, rows) a missed query also prints the reach of the group of the
/// flat scan's best row (HNSWDUP_DEBUG).
fn measure_with(
    g: &mut Graph,
    d: &DataSet,
    k: usize,
    ef: usize,
    reach: Option<&[(usize, usize)]>,
) -> Measure {
    let norms = norms_of(&d.vec, d.dim);
    let rows = Rows::contiguous(&d.vec, &norms, d.dim).unwrap();
    let queries = &d.queries;
    let mut equal = 0;
    let mut total = 0.0;
    let mut short = 0;
    let mut hits = Vec::new();
    for i in 0..QUERIES {
        let q = &queries[i * d.dim..(i + 1) * d.dim];
        g.search(&rows, q, ef, &[], &mut hits).expect("search");
        let flat = flat_top_scores(&d.vec, &norms, d.dim, q, k);
        let got = graph_top_scores(&hits, k);
        if got.len() < flat.len() {
            short += 1;
        }
        if got == flat {
            equal += 1;
        } else if std::env::var("HNSWDUP_DEBUG").is_ok() {
            let show = |v: &[u32]| {
                let mut groups: Vec<(u32, usize)> = Vec::new();
                for &b in v {
                    match groups.last_mut() {
                        Some((x, n)) if *x == b => *n += 1,
                        _ => groups.push((b, 1)),
                    }
                }
                groups
                    .iter()
                    .map(|(b, n)| format!("{:.6}x{n}", f32::from_bits(*b)))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let best_group = {
                let mut sc = vec![0.0f32; d.vec.len() / d.dim];
                scan::scan(
                    &d.vec,
                    d.vec.len() / d.dim,
                    d.dim,
                    &norms,
                    q,
                    scan::inv_norm(q),
                    COSINE,
                    &mut sc,
                );
                let best = (0..sc.len())
                    .max_by(|&a, &b| sc[a].total_cmp(&sc[b]).then(b.cmp(&a)))
                    .unwrap();
                d.group[best]
            };
            let rch = match (reach, best_group) {
                (Some(r), bg) if bg != u32::MAX => format!(
                    "best group {bg}: {} of {} rows reachable",
                    r[bg as usize].0, r[bg as usize].1
                ),
                _ => String::new(),
            };
            eprintln!(
                "  MISS q{i}: flat [{}] got [{}] {rch}",
                show(&flat),
                show(&got)
            );
        }
        total += recall_by_score(&hits, &flat, k);
    }
    Measure {
        equal,
        mean_recall: total / QUERIES as f64,
        short,
    }
}

/// Layer-0 structure of a serialised graph (docs/hnsw-format.md): how reachable is each group?
struct Diag {
    nodes: usize,
    reachable: usize,
    /// Rows of duplicate groups that no walk from the entry node reaches.
    unreachable_group_rows: usize,
    /// Links from a node of a group to a node outside the group (distinct rows included).
    group_out_links: usize,
    /// Links from outside a group into it.
    group_in_links: usize,
    /// Per group: (rows reachable from the entry node at layer 0, rows in the group).
    group_reach: Vec<(usize, usize)>,
}

fn diagnose(bytes: &[u8], group: &[u32]) -> Diag {
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let ns = bytes[11] as usize;
    let n = u32_at(32) as usize;
    let entry = u32_at(40) as usize;
    let table = 60 + ns;
    let mut level = vec![0usize; n];
    let mut ordinal = vec![0usize; n];
    for i in 0..n {
        ordinal[i] = u32_at(table + 8 * i) as usize;
        level[i] = bytes[table + 8 * i + 4] as usize;
    }
    let mut w = table + 8 * n;
    let mut l0: Vec<Vec<usize>> = Vec::with_capacity(n);
    for &lv in &level {
        for layer in 0..=lv {
            let cnt = u32_at(w) as usize;
            w += 4;
            if layer == 0 {
                l0.push((0..cnt).map(|j| u32_at(w + 4 * j) as usize).collect());
            }
            w += 4 * cnt;
        }
    }
    let mut seen = vec![false; n];
    let mut stack = vec![entry];
    seen[entry] = true;
    while let Some(x) = stack.pop() {
        for &y in &l0[x] {
            if !seen[y] {
                seen[y] = true;
                stack.push(y);
            }
        }
    }
    let grp = |node: usize| group[ordinal[node]];
    let n_groups = group
        .iter()
        .filter(|&&g| g != u32::MAX)
        .map(|&g| g as usize + 1)
        .max()
        .unwrap_or(0);
    let mut group_reach = vec![(0usize, 0usize); n_groups];
    for (x, &was_seen) in seen.iter().enumerate() {
        let gx = grp(x);
        if gx != u32::MAX {
            group_reach[gx as usize].1 += 1;
            if was_seen {
                group_reach[gx as usize].0 += 1;
            }
        }
    }
    let mut out = 0;
    let mut inn = 0;
    let mut unreachable = 0;
    for x in 0..n {
        let gx = grp(x);
        if gx != u32::MAX && !seen[x] {
            unreachable += 1;
        }
        for &y in &l0[x] {
            let gy = grp(y);
            if gx != u32::MAX && gx != gy {
                out += 1;
            }
            if gy != u32::MAX && gx != gy {
                inn += 1;
            }
        }
    }
    Diag {
        nodes: n,
        reachable: seen.iter().filter(|&&s| s).count(),
        unreachable_group_rows: unreachable,
        group_out_links: out,
        group_in_links: inn,
        group_reach,
    }
}

/// The largest group of rows that share one quantised key (every component's bits with the low twelve cleared),
/// counted with a std HashMap: an oracle that shares no code with the kernel.
fn oracle_near_max(vec: &[f32], dim: usize) -> u32 {
    let mut groups: std::collections::HashMap<Vec<u32>, u32> = std::collections::HashMap::new();
    for v in vec.chunks(dim) {
        *groups
            .entry(v.iter().map(|x| x.to_bits() & !0xFFFu32).collect())
            .or_default() += 1;
    }
    groups.values().copied().max().unwrap_or(0)
}

/// Builds the graph over `d` and holds it to the floors the way the SDK uses it: a graph whose largest group
/// of byte-identical rows exceeds `2 * m` is degenerate (`Graph::degenerate`) and the host answers
/// by the exact flat scan (fallback 'duplicates'), so no floor is asserted on it; every other graph answers
/// and must meet the floors. The kernel's count of the largest group is checked against how the set is made,
/// so the rule cannot hide a failure behind a wrong count.
fn check(d: &DataSet, p: &Params) {
    let t0 = std::time::Instant::now();
    let mut g = build(d, p);
    let build_ms = t0.elapsed().as_millis();
    let diag = diagnose(&g.serialize().unwrap(), &d.group);
    assert_eq!(
        g.dup_max(),
        d.max_group,
        "[{}] the kernel's largest group is not the set's",
        d.name
    );
    let degenerate = g.degenerate();
    // the near-duplicate count (TD-126) is checked against an independent count over the same documented key
    let near = oracle_near_max(&d.vec, d.dim);
    assert_eq!(
        g.near_max(),
        near,
        "[{}] the kernel's largest quantised-key group is not the oracle's",
        d.name
    );
    assert_eq!(
        degenerate,
        d.max_group > 2 * p.m || near > 2 * p.m,
        "[{}] degenerate means an exact or a quantised-key group larger than 2m, nothing else",
        d.name
    );
    for (k, ef) in [(K, EF), (K_LARGE, EF_LARGE)] {
        let m = measure(&mut g, d, k, ef);
        eprintln!(
            "HNSWDUP [{}] m {} efc {} ef {ef} k {k}: equal {}/{QUERIES} mean-recall {:.4} short {} | max group {} degenerate {degenerate} | layer-0 reach {}/{} unreachable group rows {} group out-links {} in-links {} | build {build_ms} ms",
            d.name,
            p.m,
            p.ef_construction,
            m.equal,
            m.mean_recall,
            m.short,
            d.max_group,
            diag.reachable,
            diag.nodes,
            diag.unreachable_group_rows,
            diag.group_out_links,
            diag.group_in_links,
        );
        if degenerate {
            continue;
        }
        assert!(
            m.equal >= MIN_EQUAL_QUERIES,
            "[{}] only {} of {QUERIES} queries have the flat top-{k} scores (floor {MIN_EQUAL_QUERIES})",
            d.name,
            m.equal
        );
        assert!(
            m.mean_recall >= MIN_MEAN_RECALL,
            "[{}] mean recall@{k} by score is {:.4} (floor {MIN_MEAN_RECALL})",
            d.name,
            m.mean_recall
        );
    }
}

/// T2's acceptance, for a set whose groups are not known from how it is made: the graph meets the floors at ef 64, or
/// it is degenerate (the host then answers by the exact flat scan, fallback 'duplicates'). Returns degenerate.
fn check_floors(d: &DataSet, p: &Params) -> bool {
    let t0 = std::time::Instant::now();
    let mut g = build(d, p);
    let build_ms = t0.elapsed().as_millis();
    let degenerate = g.degenerate();
    let m = measure(&mut g, d, K, EF);
    eprintln!(
        "HNSWNEAR [{}] m {} efc {}: equal {}/{QUERIES} mean-recall {:.4} short {} | degenerate {degenerate} | build {build_ms} ms",
        d.name, p.m, p.ef_construction, m.equal, m.mean_recall, m.short
    );
    if !degenerate {
        assert!(
            m.equal >= MIN_EQUAL_QUERIES,
            "[{}] not degenerate, and only {} of {QUERIES} queries have the flat top-{K} scores (floor {MIN_EQUAL_QUERIES}): the graph is silently worse than the flat scan",
            d.name,
            m.equal
        );
        assert!(
            m.mean_recall >= MIN_MEAN_RECALL,
            "[{}] not degenerate, and mean recall@{K} by score is {:.4} (floor {MIN_MEAN_RECALL})",
            d.name,
            m.mean_recall
        );
    }
    degenerate
}

// ---- the default matrix (runs in `cargo test`) -------------------------------------------------

/// T2's reproduction as Sprint 6 ran it (uniform rows, dim 8, m 8, efConstruction 60), at 10, 50 and 500
/// copies, and the same shape at dim 32.
#[test]
fn t2_uniform_probe() {
    for (i, copies) in [10usize, 50, 500].into_iter().enumerate() {
        for dim in [8usize, 32] {
            let d = uniform_probe(dim, 5, copies, 100, 100 + i as u32);
            check(&d, &params(8, 60, 1));
            check(&d, &params(16, 200, 1));
        }
    }
}

#[test]
fn clustered_boilerplate_sets_at_10_30_50_and_500_copies_dims_32_and_384() {
    // 10 and 30 copies are within 2m = 32 (the graph answers and is held to the floors); 50 and 500 are degenerate
    // (the host answers by the flat scan) and are measured and printed all the same.
    for (i, copies) in [10usize, 30, 50, 500].into_iter().enumerate() {
        for dim in [32usize, 384] {
            let d = boilerplate(dim, 5, copies, 100, 200 + i as u32);
            check(&d, &params(16, 200, 1));
        }
    }
}

/// The baseline the duplicate sets are read against: distinct rows only, same generator, same parameters.
#[test]
fn the_distinct_baseline_meets_the_same_floors() {
    for dim in [32usize, 384] {
        check(
            &distinct_only(dim, 1000, 250 + dim as u32),
            &params(16, 200, 1),
        );
    }
}

#[test]
fn many_base_vectors_with_10_copies_each() {
    for dim in [32usize, 384] {
        let d = boilerplate(dim, 1000, 10, 0, 300 + dim as u32);
        check(&d, &params(16, 200, 1));
    }
}

#[test]
fn one_vector_repeated_a_thousand_times_among_distinct_rows() {
    for dim in [32usize, 384] {
        let d = one_repeated(dim, 1000, 1000, 400 + dim as u32);
        check(&d, &params(16, 200, 1));
    }
}

#[test]
fn every_row_identical() {
    for dim in [32usize, 384] {
        let d = all_identical(dim, 1000, 500 + dim as u32);
        check(&d, &params(16, 200, 1));
    }
}

#[test]
fn one_ulp_near_duplicates() {
    for dim in [32usize, 384] {
        let d = near_duplicates(dim, 50, 20, 600 + dim as u32);
        check(&d, &params(16, 200, 1));
    }
}

/// BUG-T2-S7-02: T2's clusters of 500 near-identical vectors at dim 384 (seeds 13 and 14 were 98 and 96 of 100 before
/// the near-duplicate rule): the graph meets the floors or the build is degenerate and answers flat.
#[test]
fn t2_near_duplicate_clusters_of_500_at_dim_384_meet_the_floors_or_answer_flat() {
    for seed in [13u64, 14] {
        check_floors(&t2_gap_set(384, 500, seed), &params(16, 200, 1));
    }
}

/// BUG-T2-S7-02: every row distinct (so the exact-duplicate count is 1), clusters of 500 variants, dim 384 (98 of
/// 100 and 98 of 100 before the rule).
#[test]
fn t2_all_distinct_tight_clusters_of_500_at_dim_384_meet_the_floors_or_answer_flat() {
    for seed in [3u64, 4] {
        check_floors(&t2_unique_set(384, 500, seed), &params(16, 200, 1));
    }
}

/// The same shapes at dim 32 pass on the graph alone (T2 measured 100 of 100): no regression, and a dim-32 build is
/// quick enough for every CI run.
#[test]
fn t2_near_duplicate_clusters_at_dim_32_still_meet_the_floors() {
    check_floors(&t2_gap_set(32, 500, 13), &params(16, 200, 1));
    check_floors(&t2_unique_set(32, 500, 5), &params(16, 200, 1));
}

/// T2's heavier sets: groups of 1000 (95, 95, 91 and 96 of 100 before the rule). Run once per sprint:
/// `cargo test --release -p ldvec --test hnsw_dup t2_near_duplicate_clusters_of_1000 -- --ignored --nocapture`.
#[test]
#[ignore = "30,000 x 384; run with --release -- --ignored and log the figures"]
fn t2_near_duplicate_clusters_of_1000_at_dim_384_meet_the_floors_or_answer_flat() {
    for seed in [11u64, 12] {
        check_floors(&t2_gap_set(384, 1000, seed), &params(16, 200, 1));
    }
    for seed in [1u64, 2] {
        check_floors(&t2_unique_set(384, 1000, seed), &params(16, 200, 1));
    }
}

/// The matrix of the task text: 1,000 base vectors x {10, 60, 200} exact copies at dims 32 and 384.
/// Heavy (up to 200,000 rows): run once per sprint and logged, not on every CI run.
#[test]
#[ignore = "full scale; run with --release -- --ignored and log the figures"]
fn full_scale_duplicate_matrix() {
    for dim in [32usize, 384] {
        for copies in [10usize, 60, 200] {
            if dim == 384 && copies == 200 {
                // 200,000 x 384 floats is 307 MB: logged separately when the host has the memory.
                continue;
            }
            let d = boilerplate(dim, 1000, copies, 0, 700 + copies as u32);
            check(&d, &params(16, 200, 1));
        }
    }
}

// ---- determinism and the byte comparison -------------------------------------------------------

#[test]
fn a_build_over_duplicate_data_is_deterministic() {
    let d = boilerplate(32, 5, 80, 100, 9);
    let a = build(&d, &params(8, 60, 3)).serialize().unwrap();
    let b = build(&d, &params(8, 60, 3)).serialize().unwrap();
    assert_eq!(a, b);
}

/// Exact-duplicate pruning compares the stored bytes. +0.0 and -0.0 are equal as floats and differ in
/// their bytes: they must not be treated as copies (the comparison is on the bytes, never on a digest
/// alone). Everything still answers like the flat scan.
#[test]
fn rows_that_differ_only_in_the_sign_of_zero_are_not_byte_duplicates() {
    let dim = 32;
    let mut r = SplitMix64(41);
    let mut vec = Vec::new();
    let mut base: Vec<f32> = (0..dim)
        .map(|_| ((r.next() >> 44) as i32 - (1 << 19)) as f32 / 524_288.0)
        .collect();
    base[3] = 0.0;
    for c in 0..40 {
        let mut v = base.clone();
        v[3] = if c % 2 == 0 { 0.0 } else { -0.0 };
        vec.extend_from_slice(&v);
    }
    let (rest, queries) = clustered_base(8, 60, dim);
    vec.extend_from_slice(&rest);
    let d = DataSet {
        name: "signed zeros".into(),
        dim,
        group: vec![u32::MAX; vec.len() / dim],
        vec,
        queries,
        max_group: 20,
    };
    check(&d, &params(8, 60, 1));
    let a: Vec<u32> = base.iter().map(|x| x.to_bits()).collect();
    let mut b = base.clone();
    b[3] = -0.0;
    let b: Vec<u32> = b.iter().map(|x| x.to_bits()).collect();
    assert_ne!(a, b, "the two vectors differ in their bytes");
}

/// A native duplicate set of the shape of the browser bench's (docs/benchmarks/ann-duplicates.csv): 100,000 x 384, every
/// vector stored `copies` times in a row, 17 centres, seed 100,007, 200 queries. It is NOT byte-identical to the browser
/// bench's sets: that bench seeds with rows + copies and takes one centre per hundred base vectors (33 at 30 copies, 17
/// at 60), through the same generator.
fn scale_dataset(copies: usize) -> DataSet {
    let dim = 384;
    let rows = 100_000usize;
    let base = rows.div_ceil(copies);
    let (pts, q) = synth::clustered(100_007, 17, dim, base, 200);
    let mut vec = Vec::with_capacity(rows * dim);
    let mut group = Vec::with_capacity(rows);
    for i in 0..rows {
        let g = i / copies;
        vec.extend_from_slice(&pts[g * dim..(g + 1) * dim]);
        group.push(g as u32);
    }
    let mut queries = q;
    queries.truncate(200 * dim);
    DataSet {
        name: format!("bench set: 100,000 x 384, {copies} copies"),
        dim,
        vec,
        queries,
        group,
        max_group: copies as u32,
    }
}

/// The native duplicate set (see `scale_dataset`): 100,000 x 384, every vector stored 60 times in a row (the last
/// one 40 times) unless `HNSWDUP_COPIES` says otherwise, m 16, efConstruction 200. The generator is the one
/// `bench/ann-bench.spec.ts` uses (the same bytes in Rust and TypeScript). Heavy: run once with
/// `cargo test --release -p ldvec --test hnsw_dup scale_duplicates_100k -- --ignored --nocapture`.
#[test]
#[ignore = "100,000 x 384; run with --release -- --ignored"]
fn scale_duplicates_100k() {
    let copies: usize = std::env::var("HNSWDUP_COPIES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let d = scale_dataset(copies);
    let mut g = build(&d, &params(16, 200, 1));
    let diag = diagnose(&g.serialize().unwrap(), &d.group);
    eprintln!(
        "HNSWSCALE layer-0 reach {}/{} unreachable group rows {} degenerate {}",
        diag.reachable,
        diag.nodes,
        diag.unreachable_group_rows,
        g.degenerate()
    );
    for ef in [32usize, 64, 128] {
        let m = measure_with(&mut g, &d, K, ef, Some(&diag.group_reach));
        eprintln!(
            "HNSWSCALE ef {ef}: equal {}/{QUERIES} recall {:.4}",
            m.equal, m.mean_recall
        );
    }
    let reach_hist = {
        let mut h = [0usize; 4];
        for &(r, t) in &diag.group_reach {
            let i = if r == t {
                3
            } else if r * 2 >= t {
                2
            } else if r > 0 {
                1
            } else {
                0
            };
            h[i] += 1;
        }
        h
    };
    eprintln!(
        "HNSWSCALE groups by reach: none {} / under half {} / at least half {} / all {}",
        reach_hist[0], reach_hist[1], reach_hist[2], reach_hist[3]
    );
}

/// The columns of `docs/benchmarks/ann-scale-duplicates-native.csv`. Recall only: no latency is measured here (a
/// native run of a graph over synthetic data, not a browser, not an 8 GB figure).
const SCALE_CSV_HEADER: &str = "commit,date_utc,machine,command,rows,dim,copies_per_vector,m,ef_construction,ef,k,queries,dup_max,near_max,degenerate,layer0_reachable,nodes,unreachable_group_rows,graph_alone_equal_to_flat,graph_alone_recall_at_10_by_score,eight_gb";

/// The figures the README, the write-up and docs/vector-index.md quote for the 100,000 x 384 duplicate sets
/// natively (the 2m boundary: "with 60 copies of every vector the graph missed the best group in 2 of 100
/// queries at every ef, with 30 copies it missed none at ef 64 and 128"): the bench's set at 30 and at 60 copies,
/// the graph alone (a degenerate graph is answered by the flat scan in the SDK; this measures what it would
/// have answered), at ef 32, 64 and 128. With `LDVEC_WRITE_SCALE_CSV=1` it rewrites
/// `docs/benchmarks/ann-scale-duplicates-native.csv` (`LDVEC_COMMIT` and `LDVEC_MACHINE` name the commit and the
/// machine). Heavy (a few minutes): run once per change of the graph or the rule:
/// `LDVEC_WRITE_SCALE_CSV=1 LDVEC_COMMIT="$(git describe --always --dirty)" LDVEC_MACHINE="<model>, <RAM> GB" cargo test --release -p ldvec --test hnsw_dup scale_duplicate_figures -- --ignored --nocapture`.
#[test]
#[ignore = "two graphs over 100,000 x 384; run with --release -- --ignored"]
fn scale_duplicate_figures() {
    let p = params(16, 200, 1);
    let date = utc_now();
    let commit = std::env::var("LDVEC_COMMIT").unwrap_or_else(|_| "not recorded".into());
    let machine = std::env::var("LDVEC_MACHINE").unwrap_or_else(|_| "not recorded".into());
    let command =
        "cargo test --release -p ldvec --test hnsw_dup scale_duplicate_figures -- --ignored";
    let mut rows_out: Vec<String> = Vec::new();
    for copies in [30usize, 60] {
        let d = scale_dataset(copies);
        let mut g = build(&d, &p);
        let diag = diagnose(&g.serialize().unwrap(), &d.group);
        let degenerate = g.degenerate();
        for ef in [32usize, 64, 128] {
            let m = measure_with(&mut g, &d, K, ef, Some(&diag.group_reach));
            rows_out.push(format!(
                "{commit},{date},\"{machine}\",{command},{},{},{copies},{},{},{ef},{K},{QUERIES},{},{},{degenerate},{},{},{},{}/{QUERIES},{:.4},not measured on 8 GB",
                d.vec.len() / d.dim,
                d.dim,
                p.m,
                p.ef_construction,
                g.dup_max(),
                g.near_max(),
                diag.reachable,
                diag.nodes,
                diag.unreachable_group_rows,
                m.equal,
                m.mean_recall,
            ));
            eprintln!("SCALECSV {}", rows_out.last().unwrap());
        }
    }
    if std::env::var("LDVEC_WRITE_SCALE_CSV").as_deref() == Ok("1") {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/benchmarks/ann-scale-duplicates-native.csv");
        let mut text = String::from(SCALE_CSV_HEADER);
        text.push('\n');
        for r in &rows_out {
            text.push_str(r);
            text.push('\n');
        }
        std::fs::write(&path, text).unwrap();
    }
}

/// The current UTC time as `YYYY-MM-DDTHH:MM:SSZ` (no clock crate: the kernel and its tests have no dependency).
fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // civil date from days since 1970 (Howard Hinnant's algorithm), UTC
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

// ---- the committed figures (docs/benchmarks/ann-near-duplicates.csv) ----------------------------------------------

/// The columns of `docs/benchmarks/ann-near-duplicates.csv`. Recall only: no latency is measured here (a native run
/// of a graph over synthetic data, not a browser, not an 8 GB figure).
const NEAR_CSV_HEADER: &str = "commit,date_utc,machine,command,family,rows,dim,groups,per_group,seed_or_sigma,m,ef_construction,ef,k,queries,dup_max,near_max,degenerate,graph_alone_equal_to_flat,graph_alone_recall_at_10_by_score,answered_by,answer_equal_to_flat,eight_gb";

/// Builds T2's tight-cluster sets (dims 384 and 32; groups of 500 and 1,000) and D4's jittered clusters, and prints
/// one CSV row per (set, ef): what the graph alone would answer, whether the build is degenerate (the host then
/// answers by the exact flat scan, which is equal to flat by construction), and the counts. With
/// `LDVEC_WRITE_NEAR_CSV=1` it rewrites `docs/benchmarks/ann-near-duplicates.csv` (`LDVEC_COMMIT` and `LDVEC_MACHINE`
/// name the commit and the machine). Heavy (several minutes): run once per change of the rule:
/// `LDVEC_WRITE_NEAR_CSV=1 cargo test --release -p ldvec --test hnsw_dup near_duplicate_figures -- --ignored --nocapture`.
#[test]
#[ignore = "builds about 20 graphs of up to 30,000 x 384; run with --release -- --ignored"]
fn near_duplicate_figures() {
    let p = params(16, 200, 1);
    let mut rows_out: Vec<String> = Vec::new();
    let date = utc_now();
    let commit = std::env::var("LDVEC_COMMIT").unwrap_or_else(|_| "not recorded".into());
    let machine = std::env::var("LDVEC_MACHINE").unwrap_or_else(|_| "not recorded".into());
    let command =
        "cargo test --release -p ldvec --test hnsw_dup near_duplicate_figures -- --ignored";
    let mut run = |family: &str,
                   d: &DataSet,
                   groups: usize,
                   per: usize,
                   tag: String,
                   efs: &[usize]| {
        let mut g = build(d, &p);
        let degenerate = g.degenerate();
        for &ef in efs {
            let m = measure(&mut g, d, K, ef);
            let answered_by = if degenerate { "flat" } else { "graph" };
            let answer_equal = if degenerate { QUERIES } else { m.equal };
            rows_out.push(format!(
                "{commit},{date},\"{machine}\",{command},{family},{},{},{groups},{per},{tag},{},{},{ef},{K},{QUERIES},{},{},{degenerate},{}/{QUERIES},{:.4},{answered_by},{answer_equal}/{QUERIES},not measured on 8 GB",
                d.vec.len() / d.dim,
                d.dim,
                p.m,
                p.ef_construction,
                g.dup_max(),
                g.near_max(),
                m.equal,
                m.mean_recall,
            ));
            eprintln!("NEARCSV {}", rows_out.last().unwrap());
        }
    };
    for (dim, per, seed) in [
        (384usize, 500usize, 13u64),
        (384, 500, 14),
        (384, 1000, 11),
        (384, 1000, 12),
        (32, 500, 13),
    ] {
        run(
            "t2-gap",
            &t2_gap_set(dim, per, seed),
            30,
            per,
            seed.to_string(),
            &[EF],
        );
    }
    for (dim, per, seed) in [
        (384usize, 500usize, 3u64),
        (384, 500, 4),
        (384, 1000, 1),
        (384, 1000, 2),
        (32, 500, 5),
    ] {
        run(
            "t2-unique",
            &t2_unique_set(dim, per, seed),
            30,
            per,
            seed.to_string(),
            &[EF],
        );
    }
    for sigma in [1e-7f32, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2] {
        let (vec, queries) = t2sets::jitter(31_000_000 + (sigma * 1e9) as u64, 384, 30, 500, sigma);
        let n = vec.len() / 384;
        let d = DataSet {
            name: format!("jitter {sigma:e}"),
            dim: 384,
            vec,
            queries,
            group: vec![u32::MAX; n],
            max_group: 0,
        };
        let efs: &[usize] = if sigma >= 1e-4 {
            &[64, 128, 256, 512]
        } else {
            &[EF]
        };
        run("jitter", &d, 30, 500, format!("{sigma:e}"), efs);
    }
    // all-component float noise (BUG-T2-S7-07): +-256 and +-1024 ulp, relative Gaussian 1e-5 and 1e-4, dims 32 and 384
    for dim in [32usize, 384] {
        for (tag, kind) in [
            ("ulp256", t2sets::Noise::Ulps(256)),
            ("ulp1024", t2sets::Noise::Ulps(1024)),
            ("rel1e-5", t2sets::Noise::Relative(1e-5)),
            ("rel1e-4", t2sets::Noise::Relative(1e-4)),
        ] {
            let seed = 41_000_000
                + dim as u64 * 1_000
                + tag.len() as u64 * 7
                + tag.bytes().map(u64::from).sum::<u64>();
            let (vec, queries) = t2sets::noise(seed, dim, 30, 500, kind);
            let n = vec.len() / dim;
            let d = DataSet {
                name: format!("noise {tag} dim {dim}"),
                dim,
                vec,
                queries,
                group: vec![u32::MAX; n],
                max_group: 0,
            };
            run("noise", &d, 30, 500, tag.to_string(), &[EF]);
        }
    }
    if std::env::var("LDVEC_WRITE_NEAR_CSV").as_deref() == Ok("1") {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/benchmarks/ann-near-duplicates.csv");
        let mut text = String::from(NEAR_CSV_HEADER);
        text.push('\n');
        for r in &rows_out {
            text.push_str(r);
            text.push('\n');
        }
        std::fs::write(&path, text).unwrap();
    }
}
