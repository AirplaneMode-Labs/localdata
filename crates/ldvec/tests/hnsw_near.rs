//! D4 (BUG-T2-S7-02, TD-126): the near-duplicate rule of the HNSW kernel. Written before the rule.
//!
//! The kernel counts, next to the largest group of byte-identical live rows (`dup_max`), the largest group of live
//! rows that share one QUANTISED key (`near_max`): every component's f32 bits with the low `NEAR_DROP_BITS` (12)
//! mantissa bits cleared, compared by those bytes, never by a hash alone. Identical rows share a key, so
//! `near_max >= dup_max` always. A graph is degenerate when `dup_max > 2m` OR `near_max > 2m`, and the host then
//! answers by the exact flat scan (fallback 'duplicates'). What these tests hold:
//!   * the key drops exactly the low twelve mantissa bits (and nothing else: sign, exponent, the sign of zero);
//!   * the kernel's counts equal an independent oracle (a std HashMap over the same documented key) on small sets,
//!     with and without tombstones;
//!   * the boundary is 2m for near groups as it is for exact ones: a group of 32 distinct one-ulp variants is
//!     answered by the graph at m 16, a group of 33 is degenerate; a group of 20 stays on the graph;
//!   * exact copies and near variants add up inside one key group (17 copies x 2 variants is a group of 34);
//!   * the count is serialised in header word 56 (HEADER_LEN is 60), survives a reload, and a header whose near
//!     count is above the node count or below the exact count is refused.
//!
//! T2's own tight-cluster sets, which the graph alone misses, are in `hnsw_dup.rs` (`t2_*`).
mod common;
#[path = "support/synth.rs"]
mod synth;

use common::{crc32c_bitwise, put_u32};
use ldvec::hnsw::{self, duplicate_stats, Expect, Graph, Params, Rows, NEAR_DROP_BITS};
use ldvec::scan;
use std::collections::HashMap;

const M: u32 = 16;

fn p(m: u32) -> Params {
    Params {
        metric: 0,
        m,
        ef_construction: 64,
        seed: 1,
    }
}

/// The documented key, written here independently of the kernel.
const KEY_MASK: u32 = !((1u32 << 12) - 1);

fn norms_of(vec: &[f32], dim: usize) -> Vec<f32> {
    let rows = vec.len() / dim;
    let mut out = vec![0.0f32; rows];
    scan::inv_norms(vec, rows, dim, &mut out);
    out
}

/// What an independent count over the live rows gives: (rows whose bytes equal an earlier live row's, largest
/// group of identical rows, largest group that shares a quantised key).
fn oracle(vec: &[f32], dim: usize, dead: &[u32]) -> (u32, u32, u32) {
    let mut exact: HashMap<Vec<u32>, u32> = HashMap::new();
    let mut near: HashMap<Vec<u32>, u32> = HashMap::new();
    for (r, v) in vec.chunks(dim).enumerate() {
        if dead.contains(&(r as u32)) {
            continue;
        }
        *exact
            .entry(v.iter().map(|x| x.to_bits()).collect())
            .or_default() += 1;
        *near
            .entry(v.iter().map(|x| x.to_bits() & KEY_MASK).collect())
            .or_default() += 1;
    }
    let rows = exact.values().map(|c| c - 1).sum();
    (
        rows,
        exact.values().copied().max().unwrap_or(0),
        near.values().copied().max().unwrap_or(0),
    )
}

fn tomb_of(total: usize, dead: &[u32]) -> Vec<u8> {
    if dead.is_empty() {
        return Vec::new();
    }
    let mut t = vec![0u8; total.div_ceil(8)];
    for &d in dead {
        t[(d >> 3) as usize] |= 1 << (d & 7);
    }
    t
}

fn stats_of(vec: &[f32], dim: usize, dead: &[u32]) -> hnsw::DupStats {
    let norms = norms_of(vec, dim);
    let rows = Rows::contiguous(vec, &norms, dim).unwrap();
    duplicate_stats(&rows, &tomb_of(vec.len() / dim, dead)).unwrap()
}

/// A base vector whose every component sits in the middle of its quantisation bucket (low twelve bits 0x800), so
/// that a few ulps either way never cross a bucket edge: the tests are about the rule, not about luck.
fn mid_base(seed: u32, dim: usize) -> Vec<f32> {
    let (v, _) = synth::clustered(seed, 3, dim, 1, 1);
    v.iter()
        .map(|x| f32::from_bits((x.to_bits() & KEY_MASK) | (1 << (NEAR_DROP_BITS - 1))))
        .collect()
}

fn plus_ulps(v: &[f32], comp: usize, ulps: u32) -> Vec<f32> {
    let mut w = v.to_vec();
    w[comp] = f32::from_bits(w[comp].to_bits() + ulps);
    w
}

// ---- the key ----------------------------------------------------------------------------------

#[test]
fn the_near_key_drops_exactly_the_low_twelve_mantissa_bits() {
    assert_eq!(NEAR_DROP_BITS, 12);
    let a = mid_base(5, 16);
    // up to 2047 ulps up or 2048 down stay inside the bucket (the low bits start at 0x800)
    for up in [1u32, 2, 3, 100, 2047] {
        for comp in [0usize, 7, 15] {
            assert!(
                hnsw::near_same(&a, &plus_ulps(&a, comp, up)),
                "{up} ulps up in component {comp}"
            );
        }
    }
    let mut down = a.clone();
    down[3] = f32::from_bits(down[3].to_bits() - 2048);
    assert!(hnsw::near_same(&a, &down), "2048 ulps down");
    // one more in either direction crosses the bucket edge: a different key
    assert!(!hnsw::near_same(&a, &plus_ulps(&a, 3, 2048)), "2048 up");
    let mut below = a.clone();
    below[3] = f32::from_bits(below[3].to_bits() - 2049);
    assert!(!hnsw::near_same(&a, &below), "2049 down");
    // a flipped sign, a doubled value (another exponent), a different length and a different bucket in ANY component
    let mut neg = a.clone();
    neg[0] = -neg[0];
    assert!(!hnsw::near_same(&a, &neg), "the sign");
    let mut twice = a.clone();
    twice[9] *= 2.0;
    assert!(!hnsw::near_same(&a, &twice), "the exponent");
    assert!(!hnsw::near_same(&a, &a[..15]), "the length");
    // identical bytes are always the same key; +0.0 and -0.0 are not (the sign bit is kept)
    assert!(hnsw::near_same(&a, &a.clone()));
    assert!(!hnsw::near_same(&[0.0], &[-0.0]), "the sign of zero");
    assert!(hnsw::near_same(&[-0.0], &[-0.0]));
}

// ---- the counts against an independent oracle ---------------------------------------------------

#[test]
fn the_kernels_counts_equal_an_independent_oracle_on_small_sets() {
    let dim = 24;
    let (distinct, _) = synth::clustered(11, 4, dim, 40, 1);
    let base = mid_base(12, dim);
    let mut sets: Vec<(&str, Vec<f32>, Vec<u32>)> = Vec::new();
    sets.push(("40 distinct clustered rows", distinct.clone(), vec![]));
    sets.push((
        "25 identical rows",
        (0..25).flat_map(|_| base.clone()).collect(),
        vec![],
    ));
    // 3 groups of 7 distinct one-ulp variants each
    let mut variants = Vec::new();
    for g in 0..3u32 {
        let b = mid_base(20 + g, dim);
        for c in 0..7 {
            variants.extend(plus_ulps(&b, c, 1 + c as u32 % 3));
        }
    }
    sets.push(("3 groups x 7 one-ulp variants", variants.clone(), vec![]));
    // exact copies and near variants in one key group: 5 variants x 4 copies
    let mut mixed = Vec::new();
    for c in 0..5 {
        for _ in 0..4 {
            mixed.extend(plus_ulps(&base, c, 1));
        }
    }
    sets.push(("5 variants x 4 copies", mixed.clone(), vec![]));
    // signed zeros split a key group
    let mut zeros = base.clone();
    zeros[2] = 0.0;
    let mut zeros_neg = zeros.clone();
    zeros_neg[2] = -0.0;
    sets.push((
        "+0.0 and -0.0",
        [zeros.clone(), zeros_neg.clone(), zeros.clone()].concat(),
        vec![],
    ));
    // tombstones: dead rows are not counted, in either figure
    sets.push((
        "variants with 5 dead rows",
        variants.clone(),
        vec![0, 3, 8, 15, 20],
    ));
    sets.push((
        "identical rows, 20 of 25 dead",
        (0..25).flat_map(|_| base.clone()).collect(),
        (0..20).collect(),
    ));
    for (name, vec, dead) in sets {
        let st = stats_of(&vec, dim, &dead);
        let (rows, max_group, near_max) = oracle(&vec, dim, &dead);
        assert_eq!(
            (st.rows, st.max_group, st.near_max),
            (rows, max_group, near_max),
            "[{name}] (rows, largest exact group, largest near group)"
        );
        assert!(
            st.near_max >= st.max_group,
            "[{name}] identical rows share a key"
        );
    }
    // no live rows at all
    let all_dead: Vec<u32> = (0..40).collect();
    let st = stats_of(&distinct, dim, &all_dead);
    assert_eq!((st.rows, st.max_group, st.near_max), (0, 0, 0));
}

// ---- a hash only chooses which rows to compare ---------------------------------------------------

/// FNV-1a over u32 words, as the kernel hashes a row (written here independently of it).
fn fnv(words: &[u32]) -> u32 {
    words
        .iter()
        .fold(0x811C_9DC5u32, |h, w| (h ^ w).wrapping_mul(0x0100_0193))
}

/// Two different dim-2 vectors, both with the low twelve bits of each word clear (so their exact and quantised keys
/// are the same words), that have the same 32-bit hash: found by search over 2048 x 2048 pairs.
fn colliding_pair() -> ([u32; 2], [u32; 2]) {
    let word = |k: u32| 0x3F80_0000 | (k << NEAR_DROP_BITS);
    let mut seen: HashMap<u32, [u32; 2]> = HashMap::new();
    for a in 0..2048u32 {
        for b in 0..2048u32 {
            let v = [word(a), word(b)];
            if let Some(&other) = seen.get(&fnv(&v)) {
                return (other, v);
            }
            seen.insert(fnv(&v), v);
        }
    }
    unreachable!("4 million pairs over a 32-bit hash collide")
}

#[test]
fn rows_whose_hashes_collide_are_still_told_apart_by_their_bytes() {
    let (v1, v2) = colliding_pair();
    assert_ne!(v1, v2);
    assert_eq!(fnv(&v1), fnv(&v2), "the hashes collide");
    let ulps = |v: [u32; 2], comp: usize, n: u32| {
        let mut w = v;
        w[comp] += n;
        w
    };
    let v1p = ulps(v1, 0, 1);
    let v2p = ulps(v2, 1, 2);
    // v1 x 3, v1p x 2, v2 x 4, v2p x 1
    let table: Vec<[u32; 2]> = [(v1, 3), (v1p, 2), (v2, 4), (v2p, 1)]
        .into_iter()
        .flat_map(|(v, n)| std::iter::repeat_n(v, n))
        .collect();
    let vec: Vec<f32> = table
        .iter()
        .flat_map(|v| v.iter().map(|&w| f32::from_bits(w)))
        .collect();
    let st = stats_of(&vec, 2, &[]);
    let (rows, max_group, near_max) = oracle(&vec, 2, &[]);
    assert_eq!(
        (rows, max_group, near_max),
        (6, 4, 5),
        "the oracle's own figures"
    );
    assert_eq!(
        (st.rows, st.max_group, st.near_max),
        (6, 4, 5),
        "exact: v1 x 3 and v2 x 4 share a hash and are two groups; near: {{v1, v1p}} x 5 and {{v2, v2p}} x 5 share a hash and are two groups"
    );
}

// ---- the boundary: 2m for near groups, as for exact ones -----------------------------------------

/// One base plus `variants` distinct one-ulp variants (component j + 1 ulp, j = 0..variants) among 120 other rows
/// (dim 64, so at most 64 distinct variants): the group has `variants + 1` members and every row of it is distinct.
fn group_set(variants: usize) -> (Vec<f32>, usize) {
    let dim = 64;
    let base = mid_base(31, dim);
    let (others, _) = synth::clustered(32, 6, dim, 120, 1);
    let mut vec = Vec::new();
    vec.extend_from_slice(&base);
    for j in 0..variants {
        vec.extend(plus_ulps(&base, j, 1));
    }
    vec.extend_from_slice(&others);
    (vec, dim)
}

fn build(vec: &[f32], dim: usize, m: u32) -> Graph {
    let norms = norms_of(vec, dim);
    let rows = Rows::contiguous(vec, &norms, dim).unwrap();
    Graph::build(&p(m), b"near", 1, &rows, &[]).unwrap()
}

#[test]
fn a_group_of_32_distinct_one_ulp_variants_is_answered_by_the_graph_and_33_is_not() {
    // m 16: 2m = 32. variants 31 -> group of 32 (base + 31); variants 32 -> group of 33.
    let (v32, dim) = group_set(31);
    let g32 = build(&v32, dim, M);
    assert_eq!(
        g32.dup_max(),
        1,
        "every row is distinct: no byte duplicates"
    );
    assert_eq!(g32.near_max(), 32);
    assert!(!g32.degenerate(), "32 = 2m is within the neighbour list");
    let (v33, dim) = group_set(32);
    let g33 = build(&v33, dim, M);
    assert_eq!(g33.dup_max(), 1);
    assert_eq!(g33.near_max(), 33);
    assert!(
        g33.degenerate(),
        "33 near-identical rows are more than a layer-0 list holds: the flat scan answers"
    );
}

#[test]
fn a_one_ulp_group_of_20_stays_on_the_graph() {
    let (v, dim) = group_set(19);
    let g = build(&v, dim, M);
    assert_eq!(g.near_max(), 20);
    assert!(!g.degenerate());
}

#[test]
fn exact_copies_and_near_variants_add_up_inside_one_key_group() {
    // 17 exact copies of each of 2 variants: the largest exact group is 17 (within 2m = 32), the key group is 34.
    let dim = 32;
    let base = mid_base(41, dim);
    let (others, _) = synth::clustered(42, 6, dim, 100, 1);
    let mut vec = Vec::new();
    for c in 0..2 {
        for _ in 0..17 {
            vec.extend(plus_ulps(&base, c, 1));
        }
    }
    vec.extend_from_slice(&others);
    let g = build(&vec, dim, M);
    assert_eq!(g.dup_max(), 17);
    assert_eq!(g.near_max(), 34);
    assert!(g.degenerate());
    // and at m 32 (2m = 64) the same data is not degenerate
    let g32 = build(&vec, dim, 32);
    assert!(!g32.degenerate(), "the rule is 2m of the graph's own m");
}

#[test]
fn the_rule_is_either_count_above_2m() {
    let dim = 32;
    let base = mid_base(51, dim);
    let (others, _) = synth::clustered(52, 6, dim, 60, 1);
    // exact copies only: 33 identical rows -> both counts are 33
    let mut vec = Vec::new();
    for _ in 0..33 {
        vec.extend_from_slice(&base);
    }
    vec.extend_from_slice(&others);
    let g = build(&vec, dim, M);
    assert_eq!((g.dup_max(), g.near_max()), (33, 33));
    assert!(g.degenerate());
    // set_dup_stats writes both: lowering them makes the graph answer again, raising only the near count degenerates it
    let mut h = build(&vec, dim, M);
    h.set_dup_stats(1, 1).unwrap();
    assert!(!h.degenerate());
    h.set_dup_stats(1, 33).unwrap();
    assert!(h.degenerate(), "near count alone");
    h.set_dup_stats(33, 33).unwrap();
    assert!(h.degenerate(), "exact count alone");
    // a near count below the exact count cannot be true and is refused, leaving the counts as they were
    assert_eq!(h.set_dup_stats(5, 4), Err(hnsw::Err::Bounds));
    assert_eq!((h.dup_max(), h.near_max()), (33, 33));
}

// ---- serialisation --------------------------------------------------------------------------------

#[test]
fn the_near_count_is_header_word_56_and_survives_a_reload() {
    assert_eq!(hnsw::HEADER_LEN, 60);
    let (v, dim) = group_set(40);
    let g = build(&v, dim, M);
    let near = g.near_max();
    assert!(
        near > 2 * M,
        "this set is degenerate by its near count alone"
    );
    let bytes = g.serialize().unwrap();
    assert_eq!(
        u32::from_le_bytes(bytes[56..60].try_into().unwrap()),
        near,
        "word 56"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[52..56].try_into().unwrap()),
        g.dup_max(),
        "word 52"
    );
    assert_eq!(
        &bytes[60..60 + 4],
        b"near",
        "the namespace starts at byte 60"
    );
    assert_eq!(bytes.len() as u64, g.serialized_len());
    assert!(bytes.len() as u64 >= 60 + 4 + 8 * g.node_count() as u64 + 4);
    let rows = (v.len() / dim) as u32;
    let load = |b: &[u8]| {
        Graph::load(
            b,
            &Expect {
                dim: dim as u32,
                rows,
                generation: 1,
                ns: b"near",
                params: p(M),
            },
        )
    };
    let back = load(&bytes).expect("a valid graph loads");
    assert_eq!((back.dup_max(), back.near_max()), (g.dup_max(), near));
    assert!(
        back.degenerate(),
        "degenerate after a reload, from the header alone"
    );
    assert_eq!(back.serialize().unwrap(), bytes);
}

/// The forged-LOWERED count (BUG-T2-S7-03, TD-127): a header whose near count was lowered to a value that is still
/// consistent (at least the exact count) is accepted and suppresses the fallback. It is recall only, behind the
/// same trust boundary as the stored vectors (whoever can write the graph can rewrite the vectors); the count is not
/// recounted at load. This test pins the behaviour so the documentation cannot drift from it.
#[test]
fn a_consistently_lowered_count_is_accepted_and_suppresses_the_fallback() {
    let (v, dim) = group_set(40);
    let g = build(&v, dim, M);
    assert!(g.degenerate());
    let mut bytes = g.serialize().unwrap();
    put_u32(&mut bytes, 56, g.dup_max()); // as low as a consistent header can go
    let n = bytes.len();
    let c = crc32c_bitwise(0, &bytes[..n - 4]);
    put_u32(&mut bytes, n - 4, c);
    let back = Graph::load(
        &bytes,
        &Expect {
            dim: dim as u32,
            rows: (v.len() / dim) as u32,
            generation: 1,
            ns: b"near",
            params: p(M),
        },
    )
    .expect("a consistent header loads");
    assert!(
        !back.degenerate(),
        "a lowered statistic can suppress the 'duplicates' fallback (recall only, never a wrong score)"
    );
}
