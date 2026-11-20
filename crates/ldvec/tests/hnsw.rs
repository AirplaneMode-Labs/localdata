//! D4-03 (TD-65): the HNSW kernel, native. Written before `src/hnsw.rs`.
//!
//! The recall floor, the generator (`tests/support/synth.rs`) and every parameter below were fixed
//! BEFORE the first measurement and are not changed after seeing a number. The floors are stated in
//! the constants; the measured figures are printed (run with `-- --nocapture`) and logged by the
//! sprint scripts.
//!
//!   * recall@10 against the flat scan on the fixed 10,000 x 384 clustered set (100 centres), M 16,
//!     efConstruction 200, ef 100: floor 0.95
//!   * identical graph bytes for the same seed and insert order, and the sha256 values of
//!     `test/fixtures/hnsw-determinism.json` (2,000 x 64, seed 7), which the TypeScript tests reproduce
//!     through the WebAssembly build
//!   * delete and re-insert, the empty graph, k above the live rows
//!   * every validation failure is a negative code and never a panic: truncation at every offset,
//!     flipped bytes, out-of-range and self links, a dimension mismatch, level 17, an over-large
//!     declared count with a short file, namespace bytes that differ (including two namespaces whose
//!     CRC-32C collides), a graph from the future
//!   * the serialised graph contains no vector and no key
//!   * a seeded fuzz of 10,000 mutations: 0 panics
mod common;
#[path = "support/sha256.rs"]
mod sha256;
#[path = "support/synth.rs"]
mod synth;

use common::{crc32c_bitwise, get_u32, put_u32, SplitMix64};
use ldvec::hnsw::{level_for, Err, Expect, Graph, Hit, Params, Rows};
use ldvec::scan;
use sha256::sha256_hex;

/// Floors fixed before measuring (research/plan-addendum-2026-11-19.md, section 1.3).
const RECALL_FLOOR_10K: f64 = 0.95;
const RECALL_FLOOR_DOT_3K: f64 = 0.90;

const COSINE: u32 = 0;
const DOT: u32 = 1;

fn params(metric: u32, m: u32, efc: u32, seed: u32) -> Params {
    Params {
        metric,
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

/// Ground truth: the flat scan's top-k by (score descending, ordinal ascending), live rows only.
fn flat_topk(
    vec: &[f32],
    norms: &[f32],
    dim: usize,
    q: &[f32],
    metric: u32,
    k: usize,
    tomb: &[u8],
) -> Vec<u32> {
    let rows = vec.len() / dim;
    let mut scores = vec![0.0f32; rows];
    scan::scan(
        vec,
        rows,
        dim,
        norms,
        q,
        scan::inv_norm(q),
        metric,
        &mut scores,
    );
    let mut idx: Vec<u32> = (0..rows as u32)
        .filter(|&r| tomb.is_empty() || tomb[(r >> 3) as usize] & (1 << (r & 7)) == 0)
        .collect();
    idx.sort_by(|&a, &b| {
        scores[b as usize]
            .total_cmp(&scores[a as usize])
            .then(a.cmp(&b))
    });
    idx.truncate(k);
    idx
}

fn top_k_ordinals(hits: &[Hit], k: usize) -> Vec<u32> {
    let mut v: Vec<&Hit> = hits.iter().collect();
    v.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.ordinal.cmp(&b.ordinal)));
    v.iter().take(k).map(|h| h.ordinal).collect()
}

fn build_all(vec: &[f32], dim: usize, p: &Params, ns: &[u8], generation: u32) -> Graph {
    let norms = norms_of(vec, dim);
    let rows = Rows::contiguous(vec, &norms, dim).expect("rows");
    Graph::build(p, ns, generation, &rows, &[]).expect("build")
}

fn mean_recall(
    g: &mut Graph,
    vec: &[f32],
    queries: &[f32],
    dim: usize,
    metric: u32,
    ef: usize,
    tomb: &[u8],
) -> f64 {
    let norms = norms_of(vec, dim);
    let rows = Rows::contiguous(vec, &norms, dim).unwrap();
    let nq = queries.len() / dim;
    let mut total = 0.0;
    let mut hits = Vec::new();
    for i in 0..nq {
        let q = &queries[i * dim..(i + 1) * dim];
        g.search(&rows, q, ef, tomb, &mut hits).expect("search");
        let got = top_k_ordinals(&hits, 10);
        let truth = flat_topk(vec, &norms, dim, q, metric, 10, tomb);
        let found = got.iter().filter(|o| truth.contains(o)).count();
        total += found as f64 / truth.len().max(1) as f64;
    }
    total / nq as f64
}

// ---- recall -----------------------------------------------------------------------------------

#[test]
fn recall_at_10_on_the_fixed_10k_clustered_set_meets_the_floor() {
    let dim = 384;
    let (vec, queries) = synth::clustered(10_000, 100, dim, 10_000, 200);
    let t0 = std::time::Instant::now();
    let mut g = build_all(&vec, dim, &params(COSINE, 16, 200, 1), b"recall10k", 1);
    let build_ms = t0.elapsed().as_millis();
    let recall = mean_recall(&mut g, &vec, &queries, dim, COSINE, 100, &[]);
    eprintln!(
        "HNSW10K recall@10 = {recall:.4} (floor {RECALL_FLOOR_10K}) build {build_ms} ms nodes {}",
        g.node_count()
    );
    assert!(
        recall >= RECALL_FLOOR_10K,
        "recall@10 {recall:.4} is below the floor {RECALL_FLOOR_10K}"
    );
}

/// Information, not a floor: the recall curve on the fixed clustered set and on a uniform set (the worst
/// case for any graph index), so the 10k floor above is read with the right amount of salt. The
/// clustered set has about 100 rows per cluster, so ef 100 can cover a whole cluster.
#[test]
fn recall_curve_is_reported_for_clustered_and_uniform_data() {
    let dim = 384;
    let (cvec, cq) = synth::clustered(10_000, 100, dim, 10_000, 100);
    let uvec = synth::uniform(10_000, synth::DATA_STREAM, 10_000, dim);
    let uq = synth::uniform(10_000, synth::QUERY_STREAM, 100, dim);
    let p = params(COSINE, 16, 200, 1);
    let mut gc = build_all(&cvec, dim, &p, b"curve.c", 1);
    let mut gu = build_all(&uvec, dim, &p, b"curve.u", 1);
    let mut last = (0.0, 0.0);
    for ef in [10usize, 20, 50, 100] {
        let rc = mean_recall(&mut gc, &cvec, &cq, dim, COSINE, ef, &[]);
        let ru = mean_recall(&mut gu, &uvec, &uq, dim, COSINE, ef, &[]);
        eprintln!("HNSW-CURVE ef {ef}: clustered {rc:.4} uniform {ru:.4}");
        assert!(
            rc >= last.0 - 0.02 && ru >= last.1 - 0.02,
            "recall fell as ef rose"
        );
        last = (rc, ru);
    }
}

#[test]
fn recall_with_the_dot_metric_meets_its_floor() {
    let dim = 64;
    let (vec, queries) = synth::clustered(31, 30, dim, 3_000, 100);
    let mut g = build_all(&vec, dim, &params(DOT, 16, 200, 1), b"dot3k", 1);
    let recall = mean_recall(&mut g, &vec, &queries, dim, DOT, 100, &[]);
    eprintln!("HNSW-DOT recall@10 = {recall:.4} (floor {RECALL_FLOOR_DOT_3K})");
    assert!(recall >= RECALL_FLOOR_DOT_3K, "recall {recall:.4}");
}

#[test]
fn hit_scores_are_the_flat_scores_bit_for_bit() {
    let dim = 48;
    let (vec, queries) = synth::clustered(5, 12, dim, 1_500, 20);
    let norms = norms_of(&vec, dim);
    let rows = Rows::contiguous(&vec, &norms, dim).unwrap();
    let mut g = Graph::build(&params(COSINE, 12, 100, 3), b"bits", 1, &rows, &[]).unwrap();
    let mut hits = Vec::new();
    for i in 0..20 {
        let q = &queries[i * dim..(i + 1) * dim];
        g.search(&rows, q, 64, &[], &mut hits).unwrap();
        assert!(!hits.is_empty());
        let mut flat = vec![0.0f32; 1_500];
        scan::scan(
            &vec,
            1_500,
            dim,
            &norms,
            q,
            scan::inv_norm(q),
            COSINE,
            &mut flat,
        );
        for h in &hits {
            assert_eq!(h.score.to_bits(), flat[h.ordinal as usize].to_bits());
        }
        // best first, no ties in the order (score desc, ordinal asc)
        for w in hits.windows(2) {
            let ok = w[0].score > w[1].score
                || (w[0].score == w[1].score && w[0].ordinal < w[1].ordinal);
            assert!(ok, "hits are not in (score desc, ordinal asc) order");
        }
    }
}

// ---- determinism ------------------------------------------------------------------------------

#[test]
fn same_seed_and_order_give_identical_bytes_and_a_different_seed_does_not() {
    let dim = 32;
    let (vec, _) = synth::clustered(9, 10, dim, 800, 1);
    let a = build_all(&vec, dim, &params(COSINE, 8, 60, 5), b"det", 4)
        .serialize()
        .unwrap();
    let b = build_all(&vec, dim, &params(COSINE, 8, 60, 5), b"det", 4)
        .serialize()
        .unwrap();
    assert_eq!(a, b);
    let c = build_all(&vec, dim, &params(COSINE, 8, 60, 6), b"det", 4)
        .serialize()
        .unwrap();
    assert_ne!(a, c, "another seed must give another graph");
}

#[test]
fn levels_follow_the_documented_splitmix_rule() {
    // An independent re-implementation of docs/hnsw-format.md, "Levels".
    for &(seed, m) in &[(1u32, 16u32), (7, 4), (0xFFFF_FFFF, 64)] {
        let mut hist = [0u32; 17];
        for ordinal in 0..20_000u32 {
            let mut st = SplitMix64(((seed as u64) << 32) | ordinal as u64);
            let mut level = 0u32;
            loop {
                let z = st.next();
                if level < 16 && z.is_multiple_of(m as u64) {
                    level += 1;
                } else {
                    break;
                }
            }
            assert_eq!(
                level_for(seed, ordinal, m),
                level,
                "seed {seed} ordinal {ordinal}"
            );
            hist[level as usize] += 1;
        }
        // the geometric shape: about 1/m of the nodes reach level 1
        let up = 20_000 - hist[0];
        let expect = 20_000.0 / m as f64;
        assert!(
            (up as f64) > expect * 0.8 && (up as f64) < expect * 1.2,
            "seed {seed} m {m}: {up} nodes above level 0, expected about {expect}"
        );
    }
}

#[test]
fn rows_given_as_several_blocks_build_the_same_bytes_as_one_contiguous_slice() {
    let dim = 24;
    let (vec, _) = synth::clustered(2, 6, dim, 700, 1);
    let norms = norms_of(&vec, dim);
    let one = {
        let rows = Rows::contiguous(&vec, &norms, dim).unwrap();
        Graph::build(&params(COSINE, 8, 50, 2), b"blk", 2, &rows, &[])
            .unwrap()
            .serialize()
            .unwrap()
    };
    let mut rows = Rows::new(dim);
    let mut first = 0u32;
    for len in [100u32, 250, 1, 349] {
        let a = first as usize;
        let b = (first + len) as usize;
        rows.push_block(first, len, &vec[a * dim..b * dim], &norms[a..b])
            .unwrap();
        first += len;
    }
    assert_eq!(rows.total, 700);
    let many = Graph::build(&params(COSINE, 8, 50, 2), b"blk", 2, &rows, &[])
        .unwrap()
        .serialize()
        .unwrap();
    assert_eq!(one, many);
    // a block table with a gap or a wrong slice length is refused
    let mut bad = Rows::new(dim);
    assert!(bad
        .push_block(5, 10, &vec[..10 * dim], &norms[..10])
        .is_err());
    assert!(bad
        .push_block(0, 10, &vec[..9 * dim], &norms[..10])
        .is_err());
}

#[test]
fn insert_after_a_cold_reload_equals_one_continuous_build() {
    let dim = 24;
    let (vec, _) = synth::clustered(4, 8, dim, 1_200, 1);
    let norms = norms_of(&vec, dim);
    let p = params(COSINE, 8, 60, 11);
    let full = {
        let rows = Rows::contiguous(&vec, &norms, dim).unwrap();
        Graph::build(&p, b"inc", 3, &rows, &[])
            .unwrap()
            .serialize()
            .unwrap()
    };
    // first 800 rows, serialise, load, then insert rows 800..1200 against the full block table
    let first = {
        let rows = Rows::contiguous(&vec[..800 * dim], &norms[..800], dim).unwrap();
        Graph::build(&p, b"inc", 3, &rows, &[])
            .unwrap()
            .serialize()
            .unwrap()
    };
    let rows = Rows::contiguous(&vec, &norms, dim).unwrap();
    let mut g = Graph::load(
        &first,
        &Expect {
            dim: dim as u32,
            rows: 800,
            generation: 3,
            ns: b"inc",
            params: p,
        },
    )
    .unwrap();
    for o in 800..1_200u32 {
        g.insert(&rows, o).unwrap();
    }
    assert_eq!(g.serialize().unwrap(), full);
}

#[derive(Debug)]
struct Fixture {
    seed: u32,
    n: usize,
    dim: usize,
    centres: usize,
    m: u32,
    ef_construction: u32,
    graph_seed: u32,
    generation: u32,
    ns: &'static str,
}
const FIXTURE: Fixture = Fixture {
    seed: 7,
    n: 2_000,
    dim: 64,
    centres: 20,
    m: 16,
    ef_construction: 200,
    graph_seed: 1,
    generation: 1,
    ns: "fixture",
};

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/hnsw-determinism.json")
}

fn json_string(text: &str, key: &str) -> String {
    let pat = format!("\"{key}\": \"");
    let start = text
        .find(&pat)
        .unwrap_or_else(|| panic!("fixture has no \"{key}\""))
        + pat.len();
    let end = text[start..].find('"').unwrap() + start;
    text[start..end].to_string()
}

#[test]
fn graph_bytes_match_the_committed_determinism_fixture() {
    let f = &FIXTURE;
    let (vec, _) = synth::clustered(f.seed, f.centres, f.dim, f.n, 1);
    let input_sha = sha256_hex(&synth::f32_bytes(&vec));
    let g = build_all(
        &vec,
        f.dim,
        &params(COSINE, f.m, f.ef_construction, f.graph_seed),
        f.ns.as_bytes(),
        f.generation,
    );
    let bytes = g.serialize().unwrap();
    let graph_sha = sha256_hex(&bytes);
    eprintln!(
        "HNSW-FIXTURE input sha256 {input_sha} graph sha256 {graph_sha} graph bytes {}",
        bytes.len()
    );
    let path = fixture_path();
    if std::env::var("LDVEC_WRITE_FIXTURE").as_deref() == Ok("1") {
        let json = format!(
            "{{\n  \"note\": \"Written by the native test (LDVEC_WRITE_FIXTURE=1 cargo test -p ldvec --test hnsw). The input is the integer-only generator of crates/ldvec/tests/support/synth.rs and bench/synth.ts; both languages must reproduce both hashes.\",\n  \"seed\": {},\n  \"rows\": {},\n  \"dim\": {},\n  \"centres\": {},\n  \"m\": {},\n  \"efConstruction\": {},\n  \"graphSeed\": {},\n  \"generation\": {},\n  \"metric\": \"cosine\",\n  \"ns\": \"{}\",\n  \"inputBytes\": {},\n  \"inputSha256\": \"{}\",\n  \"graphBytes\": {},\n  \"graphSha256\": \"{}\"\n}}\n",
            f.seed, f.n, f.dim, f.centres, f.m, f.ef_construction, f.graph_seed, f.generation, f.ns,
            vec.len() * 4, input_sha, bytes.len(), graph_sha
        );
        std::fs::write(&path, json).unwrap();
    }
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "determinism fixture {} is missing ({e}); write it with LDVEC_WRITE_FIXTURE=1",
            path.display()
        )
    });
    assert_eq!(
        json_string(&text, "inputSha256"),
        input_sha,
        "the generator changed"
    );
    assert_eq!(
        json_string(&text, "graphSha256"),
        graph_sha,
        "the graph bytes changed"
    );
}

// ---- update rules -----------------------------------------------------------------------------

fn tomb_of(rows: usize, dead: &[u32]) -> Vec<u8> {
    let mut t = vec![0u8; rows.div_ceil(8)];
    for &r in dead {
        t[(r >> 3) as usize] |= 1 << (r & 7);
    }
    t
}

#[test]
fn deleted_rows_are_never_returned_and_a_reinserted_row_is_found() {
    let dim = 32;
    let n = 900usize;
    let (mut vec, queries) = synth::clustered(12, 10, dim, n, 40);
    let norms = norms_of(&vec, dim);
    let p = params(COSINE, 12, 100, 1);
    let rows = Rows::contiguous(&vec, &norms, dim).unwrap();
    let mut g = Graph::build(&p, b"del", 1, &rows, &[]).unwrap();
    let dead: Vec<u32> = (0..n as u32).filter(|r| r % 3 == 0).collect();
    for &r in &dead {
        assert!(g.mark_deleted(r));
        assert!(!g.mark_deleted(r), "marking twice reports false");
    }
    assert!(
        !g.mark_deleted(n as u32 + 5),
        "an unknown ordinal reports false"
    );
    assert_eq!(g.live_nodes(), (n - dead.len()) as u32);
    let tomb = tomb_of(n, &dead);
    let mut hits = Vec::new();
    for i in 0..40 {
        let q = &queries[i * dim..(i + 1) * dim];
        g.search(&rows, q, 100, &tomb, &mut hits).unwrap();
        assert!(!hits.is_empty());
        for h in &hits {
            assert!(
                h.ordinal % 3 != 0,
                "a deleted row {} was returned",
                h.ordinal
            );
        }
    }
    let recall = mean_recall(&mut g, &vec, &queries, dim, COSINE, 100, &tomb);
    assert!(recall >= 0.9, "recall after deletes {recall:.3}");

    // The graph's own flag is not what decides: with the flags cleared in a forged copy and the HEAD
    // tombstones unchanged, a deleted row is still never returned.
    let mut bytes = g.serialize().unwrap();
    let ns_len = bytes[11] as usize;
    let table = 60 + ns_len;
    let count = get_u32(&bytes, 32) as usize;
    for i in 0..count {
        bytes[table + 8 * i + 5] = 0;
    }
    put_u32(&mut bytes, 36, count as u32);
    recrc(&mut bytes);
    let mut forged = Graph::load(
        &bytes,
        &Expect {
            dim: dim as u32,
            rows: n as u32,
            generation: 1,
            ns: b"del",
            params: p,
        },
    )
    .unwrap();
    for i in 0..40 {
        let q = &queries[i * dim..(i + 1) * dim];
        forged.search(&rows, q, 100, &tomb, &mut hits).unwrap();
        assert!(hits.iter().all(|h| h.ordinal % 3 != 0));
    }

    // re-insert one deleted row's vector as a new row at the end: it must be found by its own vector
    let dup = vec[3 * dim..4 * dim].to_vec();
    vec.extend_from_slice(&dup);
    let norms2 = norms_of(&vec, dim);
    let rows2 = Rows::contiguous(&vec, &norms2, dim).unwrap();
    g.insert(&rows2, n as u32).unwrap();
    let tomb2 = tomb_of(n + 1, &dead);
    g.search(&rows2, &dup, 100, &tomb2, &mut hits).unwrap();
    assert_eq!(top_k_ordinals(&hits, 1), vec![n as u32]);
    // inserting an ordinal that is not above the last one, or one the block table does not cover, is refused
    assert_eq!(g.insert(&rows2, 5), Err(Err::Bounds));
    assert_eq!(g.insert(&rows2, n as u32 + 9), Err(Err::Bounds));
}

#[test]
fn the_empty_graph_round_trips_and_takes_its_first_insert() {
    let dim = 8;
    let rows = Rows::new(dim);
    let mut g = Graph::build(&params(COSINE, 4, 20, 1), b"empty", 0, &rows, &[]).unwrap();
    assert_eq!(g.node_count(), 0);
    assert_eq!(g.entry(), None);
    let bytes = g.serialize().unwrap();
    let e = Expect {
        dim: dim as u32,
        rows: 0,
        generation: 0,
        ns: b"empty",
        params: params(COSINE, 4, 20, 1),
    };
    let mut again = Graph::load(&bytes, &e).unwrap();
    assert_eq!(again.serialize().unwrap(), bytes);
    let mut hits = vec![Hit {
        ordinal: 1,
        score: 1.0,
    }];
    again.search(&rows, &[1.0; 8], 10, &[], &mut hits).unwrap();
    assert!(hits.is_empty());
    // first insert into an empty graph
    let vec = vec![0.5f32; dim * 3];
    let norms = norms_of(&vec, dim);
    let rows3 = Rows::contiguous(&vec, &norms, dim).unwrap();
    g.insert(&rows3, 0).unwrap();
    g.insert(&rows3, 1).unwrap();
    g.insert(&rows3, 2).unwrap();
    assert_eq!(g.node_count(), 3);
    assert!(g.entry().is_some());
    g.search(&rows3, &vec[..dim], 10, &[], &mut hits).unwrap();
    assert_eq!(hits.len(), 3);
}

/// A namespace that has no vectors yet has no dimension (0): `buildIndex` on it writes an empty graph of
/// dimension 0, which is valid only while the flat index does not exist and is refused (as another
/// dimension) once it does, so the SDK rebuilds it.
#[test]
fn an_empty_graph_of_a_namespace_without_a_dimension_is_valid_only_for_that_namespace() {
    let rows = Rows::new(0);
    let g = Graph::build(&params(COSINE, 4, 20, 1), b"nodim", 0, &rows, &[]).unwrap();
    assert_eq!(g.node_count(), 0);
    let bytes = g.serialize().unwrap();
    let none = Expect {
        dim: 0,
        rows: 0,
        generation: 0,
        ns: b"nodim",
        params: params(COSINE, 4, 20, 1),
    };
    assert!(Graph::load(&bytes, &none).is_ok());
    let later = Expect {
        dim: 8,
        rows: 20,
        generation: 3,
        ns: b"nodim",
        params: params(COSINE, 4, 20, 1),
    };
    assert_eq!(Graph::load(&bytes, &later).err(), Some(Err::Dim));
    // a dimension above the format maximum is still refused, and nodes cannot be inserted without one
    let mut huge = bytes.clone();
    put_u32(&mut huge, 12, 4_097);
    recrc(&mut huge);
    assert_eq!(Graph::load(&huge, &none).err(), Some(Err::Dim));
    let mut g = Graph::load(&bytes, &none).unwrap();
    let vec = vec![1.0f32; 8];
    let norms = norms_of(&vec, 8);
    let rows8 = Rows::contiguous(&vec, &norms, 8).unwrap();
    assert!(g.insert(&rows8, 0).is_err());
}

#[test]
fn k_above_the_live_rows_returns_every_live_row_and_nothing_else() {
    let dim = 16;
    let (vec, _) = synth::clustered(3, 2, dim, 5, 1);
    let norms = norms_of(&vec, dim);
    let rows = Rows::contiguous(&vec, &norms, dim).unwrap();
    let mut g = Graph::build(&params(COSINE, 4, 20, 1), b"few", 1, &rows, &[]).unwrap();
    let tomb = tomb_of(5, &[1]);
    let mut hits = Vec::new();
    g.search(&rows, &vec[..dim], 64, &tomb, &mut hits).unwrap();
    let mut got: Vec<u32> = hits.iter().map(|h| h.ordinal).collect();
    got.sort_unstable();
    assert_eq!(got, vec![0, 2, 3, 4]);
    // a wrong tombstone length is refused rather than read out of range
    assert!(g
        .search(&rows, &vec[..dim], 64, &[0u8; 3], &mut hits)
        .is_err());
}

// ---- validation -------------------------------------------------------------------------------

const DIM: usize = 8;
const ROWS: usize = 60;
const NS: &[u8] = b"fuzz.ns";
const GEN: u32 = 5;
/// The params `small()` builds with: what the namespace's stored params record would say.
const SMALL_P: Params = Params {
    metric: COSINE,
    m: 4,
    ef_construction: 20,
    seed: 9,
};

fn small() -> (Vec<f32>, Vec<u8>) {
    let (vec, _) = synth::clustered(21, 4, DIM, ROWS, 1);
    let g = build_all(&vec, DIM, &SMALL_P, NS, GEN);
    let bytes = g.serialize().unwrap();
    (vec, bytes)
}

fn expect() -> Expect<'static> {
    Expect {
        dim: DIM as u32,
        rows: ROWS as u32,
        generation: GEN,
        ns: NS,
        params: SMALL_P,
    }
}

fn recrc(b: &mut [u8]) {
    let n = b.len();
    let c = crc32c_bitwise(0, &b[..n - 4]);
    put_u32(b, n - 4, c);
}

fn load(b: &[u8]) -> Result<Graph, Err> {
    Graph::load(b, &expect())
}

fn load_err(b: &[u8]) -> Err {
    match load(b) {
        Ok(_) => panic!("a corrupt graph was accepted"),
        Err(e) => e,
    }
}

/// Offsets inside the node table and link area of the small graph, found from the documented layout.
struct Layout {
    table: usize,
    links: usize,
    nodes: usize,
}
fn layout(b: &[u8]) -> Layout {
    let ns = b[11] as usize;
    let nodes = get_u32(b, 32) as usize;
    let table = 60 + ns;
    Layout {
        table,
        links: table + 8 * nodes,
        nodes,
    }
}

#[test]
fn a_valid_graph_loads_and_serialises_to_the_same_bytes() {
    let (_, bytes) = small();
    let g = load(&bytes).expect("valid");
    assert_eq!(g.serialize().unwrap(), bytes);
    assert_eq!(g.generation(), GEN);
    assert_eq!(g.node_count(), ROWS as u32);
}

#[test]
fn every_truncation_is_refused() {
    let (_, bytes) = small();
    for cut in 0..bytes.len() {
        let e = load_err(&bytes[..cut]);
        assert_eq!(e, Err::Length, "truncated to {cut} bytes gave {e:?}");
    }
    // and with trailing bytes
    let mut longer = bytes.clone();
    longer.push(0);
    assert_eq!(load_err(&longer), Err::Length);
}

#[test]
fn every_flipped_byte_is_refused() {
    let (_, bytes) = small();
    for i in 0..bytes.len() {
        for bit in [0u8, 7] {
            let mut b = bytes.clone();
            b[i] ^= 1 << bit;
            assert!(
                load(&b).is_err(),
                "a flip of bit {bit} at byte {i} was accepted"
            );
        }
    }
}

#[test]
fn the_header_checks_report_their_own_codes() {
    let (_, good) = small();
    let mut b = good.clone();
    b[0] = b'X';
    assert_eq!(load_err(&b), Err::Magic);
    let mut b = good.clone();
    b[8] = 1;
    assert_eq!(
        load_err(&b),
        Err::Version,
        "the first format's version field"
    );
    let mut b = good.clone();
    b[8] = 3;
    assert_eq!(load_err(&b), Err::Version, "a version from the future");
    let mut b = good.clone();
    b[0..8].copy_from_slice(b"LDHNSW01");
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Version, "the first format's magic");
    let mut b = good.clone();
    put_u32(&mut b, 12, DIM as u32 + 1);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Dim, "a graph of another dimension");
    let mut b = good.clone();
    put_u32(&mut b, 12, 0);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Dim);
    let mut b = good.clone();
    put_u32(&mut b, 28, GEN + 1);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Generation, "a graph ahead of HEAD");
    for (off, bad) in [(16usize, 3u32), (16, 65), (20, 3), (20, 1001), (10, 2)] {
        let mut b = good.clone();
        if off == 10 {
            b[10] = bad as u8;
        } else {
            put_u32(&mut b, off, bad);
        }
        recrc(&mut b);
        assert_eq!(load_err(&b), Err::Bounds, "param at {off} = {bad}");
    }
    let mut b = good.clone();
    put_u32(&mut b, 52, ROWS as u32 + 1);
    recrc(&mut b);
    assert_eq!(
        load_err(&b),
        Err::Bounds,
        "a largest duplicate group above the node count"
    );
    let mut b = good.clone();
    put_u32(&mut b, 52, ROWS as u32);
    put_u32(&mut b, 56, ROWS as u32);
    recrc(&mut b);
    assert!(
        load(&b).is_ok(),
        "a group as large as the graph is a (forged or real) degenerate flag, not an error"
    );
    // the near-duplicate group (header word 56): above the node count, or below the exact group, is `bounds`
    let mut b = good.clone();
    put_u32(&mut b, 56, ROWS as u32 + 1);
    recrc(&mut b);
    assert_eq!(
        load_err(&b),
        Err::Bounds,
        "a largest near-duplicate group above the node count"
    );
    let mut b = good.clone();
    put_u32(&mut b, 52, 2);
    put_u32(&mut b, 56, 1);
    recrc(&mut b);
    assert_eq!(
        load_err(&b),
        Err::Bounds,
        "a near-duplicate group smaller than the exact group is impossible (identical rows share one key)"
    );
    // a graph that is older than HEAD is valid (the caller calls it stale)
    let older = Graph::load(
        &good,
        &Expect {
            dim: DIM as u32,
            rows: ROWS as u32 + 10,
            generation: GEN + 3,
            ns: NS,
            params: SMALL_P,
        },
    );
    assert!(older.is_ok());
}

#[test]
fn structural_checks_catch_a_graph_with_a_valid_crc() {
    let (_, good) = small();
    let l = layout(&good);
    // level 17
    let mut b = good.clone();
    b[l.table + 4] = 17;
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "level 17");
    // a flag bit other than deleted
    let mut b = good.clone();
    b[l.table + 5] = 2;
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "reserved flag bit");
    // a node reserved field
    let mut b = good.clone();
    b[l.table + 6] = 1;
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "node reserved");
    // an ordinal at or above the flat row count
    let mut b = good.clone();
    put_u32(&mut b, l.table + 8 * (l.nodes - 1), ROWS as u32);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "ordinal out of range");
    // ordinals not strictly increasing
    let mut b = good.clone();
    let o1 = get_u32(&good, l.table + 8);
    put_u32(&mut b, l.table, o1);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "ordinals not increasing");
    // live count disagrees with the flags
    let mut b = good.clone();
    put_u32(&mut b, 36, ROWS as u32 - 1);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "liveNodes");
    // entry point not on the top level
    let mut b = good.clone();
    let entry = get_u32(&good, 40) as usize;
    let other = (0..l.nodes)
        .find(|&i| i != entry && good[l.table + 8 * i + 4] < good[l.table + 8 * entry + 4])
        .expect("a node below the top level");
    put_u32(&mut b, 40, other as u32);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "entry not on the top level");
    let mut b = good.clone();
    put_u32(&mut b, 40, l.nodes as u32);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds, "entry out of range");
    // first link of node 0 on layer 0: out of range, then a self link
    let count0 = get_u32(&good, l.links) as usize;
    assert!(count0 > 0, "node 0 has links");
    let mut b = good.clone();
    put_u32(&mut b, l.links + 4, l.nodes as u32);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Links, "link out of range");
    let mut b = good.clone();
    put_u32(&mut b, l.links + 4, 0);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Links, "self link");
    // a link count above 2m on layer 0
    let mut b = good.clone();
    put_u32(&mut b, l.links, 2 * 4 + 1);
    recrc(&mut b);
    let e = load_err(&b);
    assert!(
        e == Err::Links || e == Err::Length,
        "count above 2m gave {e:?}"
    );
}

#[test]
fn a_link_to_a_node_that_is_not_on_that_layer_is_refused() {
    let (_, good) = small();
    let l = layout(&good);
    // find a node with level >= 1; write a layer-1 link of it to a level-0 node
    let hi = (0..l.nodes)
        .find(|&i| good[l.table + 8 * i + 4] >= 1)
        .expect("a node above level 0");
    let lo = (0..l.nodes)
        .find(|&i| good[l.table + 8 * i + 4] == 0)
        .expect("a level-0 node");
    // walk the link area to the first layer-1 list of `hi`
    let mut w = l.links;
    for i in 0..hi {
        let lv = good[l.table + 8 * i + 4] as usize;
        for _ in 0..=lv {
            w += 4 + 4 * get_u32(&good, w) as usize;
        }
    }
    w += 4 + 4 * get_u32(&good, w) as usize; // past layer 0
    let n1 = get_u32(&good, w);
    assert!(n1 > 0, "the chosen node has a layer-1 link");
    let mut b = good.clone();
    put_u32(&mut b, w + 4, lo as u32);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Links);
}

#[test]
fn an_over_large_declared_count_with_a_short_file_is_a_negative_code_without_allocating() {
    let (_, good) = small();
    // nodeCount far above anything the flat index could hold
    let mut b = good.clone();
    put_u32(&mut b, 32, 0xFFFF_FFFF);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Bounds);
    // nodeCount at the format maximum and HEAD agreeing, but the file is tiny: length decides first
    let mut b = good.clone();
    put_u32(&mut b, 32, 4_194_304);
    recrc(&mut b);
    let e = Graph::load(
        &b,
        &Expect {
            dim: DIM as u32,
            rows: 4_194_304,
            generation: GEN,
            ns: NS,
            params: SMALL_P,
        },
    );
    assert_eq!(e.err(), Some(Err::Length));
    // linkWords of 2^32 - 1 words against a short file
    let mut b = good.clone();
    put_u32(&mut b, 48, 0xFFFF_FFFF);
    recrc(&mut b);
    assert_eq!(load_err(&b), Err::Length);
    // a maximal HEAD row count does not widen what a short file may claim
    let e = Graph::load(
        &good,
        &Expect {
            dim: DIM as u32,
            rows: u32::MAX,
            generation: GEN,
            ns: NS,
            params: SMALL_P,
        },
    );
    assert!(e.is_ok(), "the honest file still loads");
}

fn colliding_namespaces() -> (Vec<u8>, Vec<u8>) {
    let mut seen = std::collections::HashMap::new();
    for i in 0u32.. {
        let name = format!("n{i}").into_bytes();
        let crc = ldvec::crc32c::update(0, &name);
        if let Some(prev) = seen.insert(crc, name.clone()) {
            return (prev, name);
        }
    }
    unreachable!()
}

#[test]
fn the_namespace_is_bound_by_its_bytes_not_by_a_checksum() {
    let (a, b) = colliding_namespaces();
    assert_ne!(a, b);
    assert_eq!(ldvec::crc32c::update(0, &a), ldvec::crc32c::update(0, &b));
    let (vec, _) = synth::clustered(21, 4, DIM, ROWS, 1);
    let bytes = build_all(&vec, DIM, &params(COSINE, 4, 20, 9), &a, GEN)
        .serialize()
        .unwrap();
    // the namespace bytes are stored verbatim
    assert_eq!(&bytes[60..60 + a.len()], &a[..]);
    let e = |ns: &[u8]| {
        Graph::load(
            &bytes,
            &Expect {
                dim: DIM as u32,
                rows: ROWS as u32,
                generation: GEN,
                ns,
                params: params(COSINE, 4, 20, 9),
            },
        )
        .err()
    };
    assert_eq!(e(&a), None, "its own namespace");
    assert_eq!(
        e(&b),
        Some(Err::Namespace),
        "a namespace with the same CRC-32C"
    );
    assert_eq!(e(b"other"), Some(Err::Namespace));
    assert_eq!(
        e(&[a.clone(), b"x".to_vec()].concat()),
        Some(Err::Namespace)
    );
    assert_eq!(e(&a[..a.len() - 1]), Some(Err::Namespace));
    // an empty or over-long namespace cannot be built or loaded
    let norms = norms_of(&vec, DIM);
    let rows = Rows::contiguous(&vec, &norms, DIM).unwrap();
    assert!(Graph::build(&params(COSINE, 4, 20, 9), b"", 1, &rows, &[]).is_err());
    assert!(Graph::build(&params(COSINE, 4, 20, 9), &[b'a'; 65], 1, &rows, &[]).is_err());
}

#[test]
fn the_build_refuses_parameters_out_of_range() {
    let dim = 8;
    let (vec, _) = synth::clustered(1, 2, dim, 10, 1);
    let norms = norms_of(&vec, dim);
    let rows = Rows::contiguous(&vec, &norms, dim).unwrap();
    for p in [
        params(COSINE, 3, 20, 1),
        params(COSINE, 65, 100, 1),
        params(COSINE, 8, 7, 1),
        params(COSINE, 8, 1001, 1),
        params(2, 8, 20, 1),
    ] {
        assert!(Graph::build(&p, b"ns", 1, &rows, &[]).is_err(), "{p:?}");
    }
    assert!(Graph::build(&params(COSINE, 8, 8, 0), b"ns", 1, &rows, &[]).is_ok());
}

#[test]
fn a_serialised_graph_holds_no_vector_and_no_key() {
    let dim = 64;
    let (vec, _) = synth::clustered(7, 8, dim, 400, 1);
    let g = build_all(&vec, dim, &params(COSINE, 8, 40, 1), b"private.ns", 1);
    let bytes = g.serialize().unwrap();
    let contains = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).any(|w| w == needle);
    for row in [0usize, 1, 17, 199, 399] {
        let v = synth::f32_bytes(&vec[row * dim..(row + 1) * dim]);
        // the whole vector, and any 16-byte run of it (four components)
        assert!(!contains(&bytes, &v), "row {row} is in the graph");
        for off in (0..v.len() - 16).step_by(16) {
            assert!(
                !contains(&bytes, &v[off..off + 16]),
                "row {row} bytes at {off}"
            );
        }
    }
    for key in ["chunk-000017", "SENTINEL-KEY-7f3a", "doc-17"] {
        assert!(!contains(&bytes, key.as_bytes()));
    }
}

// ---- fuzz -------------------------------------------------------------------------------------

fn mutate(r: &mut SplitMix64, src: &[u8]) -> Vec<u8> {
    let mut v = src.to_vec();
    for _ in 0..1 + r.below(3) {
        match r.below(7) {
            0 | 1 if v.is_empty() => {
                // nothing left to flip or overwrite (an earlier step cut the file to nothing)
            }
            0 => {
                let i = r.below(v.len() as u64) as usize;
                v[i] ^= 1 << r.below(8);
            }
            1 => {
                let i = r.below(v.len() as u64) as usize;
                v[i] = r.next() as u8;
            }
            2 => {
                let cut = r.below(v.len() as u64 + 1) as usize;
                v.truncate(cut);
            }
            3 => {
                for _ in 0..r.below(40) {
                    v.push(r.next() as u8);
                }
            }
            4 | 5 => {
                if v.len() >= 8 {
                    let i = r.below(v.len() as u64 - 3) as usize;
                    let interesting = [
                        0u32,
                        1,
                        2,
                        16,
                        17,
                        ROWS as u32 - 1,
                        ROWS as u32,
                        ROWS as u32 + 1,
                        u32::MAX,
                        0x8000_0000,
                        r.next() as u32,
                    ];
                    put_u32(
                        &mut v,
                        i,
                        interesting[r.below(interesting.len() as u64) as usize],
                    );
                }
            }
            _ => {
                if v.len() >= 12 {
                    // swap two aligned words
                    let a = r.below(v.len() as u64 / 4) as usize * 4;
                    let b = r.below(v.len() as u64 / 4) as usize * 4;
                    for k in 0..4 {
                        v.swap(a + k, b + k);
                    }
                }
            }
        }
    }
    v
}

#[test]
fn ten_thousand_seeded_mutations_cause_no_panic_and_accepted_graphs_are_safe_to_search() {
    let (vec, good) = small();
    let norms = norms_of(&vec, DIM);
    let q: Vec<f32> = vec[..DIM].to_vec();
    let mut r = SplitMix64(0x1D4_0003);
    let (mut panics, mut accepted, mut refused) = (0u32, 0u32, 0u32);
    for _ in 0..10_000 {
        let mut m = mutate(&mut r, &good);
        if m.len() >= 4 && r.below(2) == 0 {
            recrc(&mut m); // reach the structural checks, not only the CRC
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match Graph::load(&m, &expect()) {
                Err(e) => {
                    assert!((e as i32) < 0);
                    false
                }
                Ok(mut g) => {
                    let rows = Rows::contiguous(&vec, &norms, DIM).unwrap();
                    let mut hits = Vec::new();
                    g.search(&rows, &q, 30, &[], &mut hits).unwrap();
                    assert!(hits.iter().all(|h| (h.ordinal as usize) < ROWS));
                    // an accepted graph re-serialises (no hidden state) and can take an insert check
                    let _ = g.serialize().unwrap();
                    true
                }
            }
        }));
        match outcome {
            Ok(true) => accepted += 1,
            Ok(false) => refused += 1,
            Err(_) => panics += 1,
        }
    }
    eprintln!("HNSW-FUZZ mutations 10000 panics {panics} accepted {accepted} refused {refused}");
    assert_eq!(panics, 0);
    assert!(
        refused > 5_000,
        "most mutations must be refused ({refused})"
    );
    assert!(
        accepted > 0,
        "the structural path must be exercised ({accepted})"
    );
}
