//! D4-02: the scalar scan against an independent f32 reference, bit for bit.
mod common;

use common::*;
use ldvec::scan::*;

fn rows(seed: u64, n: usize, dim: usize) -> Vec<f32> {
    let mut r = SplitMix64(seed);
    (0..n * dim).map(|_| rand_f32(&mut r)).collect()
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

#[test]
fn dot4_scalar_equals_the_reference_for_every_dim() {
    let mut r = SplitMix64(11);
    for dim in [1usize, 2, 3, 4, 5, 7, 8, 9, 63, 64, 65, 383, 384, 385, 4096] {
        for _ in 0..20 {
            let a: Vec<f32> = (0..dim).map(|_| rand_f32(&mut r)).collect();
            let b: Vec<f32> = (0..dim).map(|_| rand_f32(&mut r)).collect();
            assert_eq!(
                dot4_scalar(&a, &b).to_bits(),
                ref_dot4(&a, &b).to_bits(),
                "dim {dim}"
            );
            assert_eq!(
                dot4(&a, &b).to_bits(),
                ref_dot4(&a, &b).to_bits(),
                "dim {dim} (selected)"
            );
        }
    }
}

#[test]
fn the_accumulation_order_is_four_lanes_not_a_running_sum() {
    // Find (deterministically) inputs on which a plain running sum and the four-lane order disagree,
    // then pin the lane order on them.
    let mut r = SplitMix64(77);
    let mut distinguished = 0;
    for _ in 0..200 {
        let a: Vec<f32> = (0..64).map(|_| rand_f32(&mut r) * 1000.0).collect();
        let b: Vec<f32> = (0..64).map(|_| rand_f32(&mut r)).collect();
        let lanes = ref_dot4(&a, &b);
        let running: f32 = a.iter().zip(b.iter()).fold(0.0f32, |s, (x, y)| s + x * y);
        assert_eq!(dot4_scalar(&a, &b).to_bits(), lanes.to_bits());
        if lanes.to_bits() != running.to_bits() {
            distinguished += 1;
        }
    }
    assert!(
        distinguished > 20,
        "the data must distinguish the two orders ({distinguished}/200)"
    );
}

#[test]
fn scan_scalar_matches_the_reference_over_1000_seeded_rows_for_both_metrics() {
    for dim in [1usize, 3, 4, 5, 384] {
        let n = 1000usize;
        let data = rows(100 + dim as u64, n, dim);
        let mut norms = vec![0.0f32; n];
        inv_norms(&data, n, dim, &mut norms);
        let ref_norms: Vec<f32> = (0..n)
            .map(|i| ref_inv_norm(&data[i * dim..(i + 1) * dim]))
            .collect();
        assert_eq!(bits(&norms), bits(&ref_norms), "inv_norms dim {dim}");
        let q = rows(999, 1, dim);
        let mut qn = [0.0f32];
        inv_norms(&q, 1, dim, &mut qn);
        assert_eq!(qn[0].to_bits(), ref_inv_norm(&q).to_bits());
        for metric in [0u32, 1] {
            let mut out = vec![f32::NAN; n];
            scan(&data, n, dim, &norms, &q, qn[0], metric, &mut out);
            let want: Vec<f32> = (0..n)
                .map(|i| {
                    ref_score(
                        &data[i * dim..(i + 1) * dim],
                        ref_norms[i],
                        &q,
                        qn[0],
                        metric,
                    )
                })
                .collect();
            assert_eq!(bits(&out), bits(&want), "scan dim {dim} metric {metric}");
        }
    }
}

#[test]
fn negative_zero_scores_become_positive_zero() {
    // dot = -0.0 can arise from (+0 * -x); the contract maps -0 to +0.
    let data = [0.0f32, 1.0, -0.0, 1.0];
    let q = [-1.0f32, 0.0];
    let mut norms = [0.0f32; 2];
    inv_norms(&data, 2, 2, &mut norms);
    for metric in [0u32, 1] {
        let mut out = [f32::NAN; 2];
        scan(&data, 2, 2, &norms, &q, 1.0, metric, &mut out);
        for s in out {
            assert_eq!(s.to_bits(), 0.0f32.to_bits(), "metric {metric}");
        }
    }
}

#[test]
fn a_zero_row_has_inv_norm_zero_and_scores_zero_under_cosine() {
    let data = [0.0f32, 0.0, 3.0, 4.0];
    let mut norms = [9.0f32; 2];
    inv_norms(&data, 2, 2, &mut norms);
    assert_eq!(norms[0], 0.0);
    assert_eq!(norms[1], 1.0 / 5.0);
    let mut out = [f32::NAN; 2];
    scan(&data, 2, 2, &norms, &[1.0, 0.0], 1.0, 0, &mut out);
    assert_eq!(out[0].to_bits(), 0.0f32.to_bits());
    assert!(out[1] > 0.0);
}

#[test]
fn check_rows_reports_the_first_bad_row() {
    let mut d = vec![0.5f32; 4 * 3];
    assert_eq!(check_rows(&d, 4, 3), -1);
    d[3 * 3 + 1] = f32::NAN;
    assert_eq!(check_rows(&d, 4, 3), 3);
    d[2 * 3] = f32::INFINITY;
    assert_eq!(check_rows(&d, 4, 3), 2);
    d[0] = f32::NEG_INFINITY;
    assert_eq!(check_rows(&d, 4, 3), 0);
}

#[test]
fn check_rows_refuses_a_self_dot_above_1e30_but_accepts_it_at_the_limit() {
    // 1e15^2 = 1e30 exactly representable? In f32 1e15*1e15 rounds to ~1.0000000e30 (f32): a value
    // whose selfDot as a double is above 1e30 is refused; component 3e15 gives 9e30 > 1e30.
    let ok = [1e14f32, 0.0, 0.0];
    assert_eq!(check_rows(&ok, 1, 3), -1);
    let bad = [3e15f32, 0.0, 0.0];
    assert_eq!(check_rows(&bad, 1, 3), 0);
    // overflowing selfDot (f32 inf) is also refused, and a huge-but-finite component is not finite math
    let huge = [3e38f32, 3e38, 0.0];
    assert_eq!(check_rows(&huge, 1, 3), 0);
}

#[test]
fn scan_of_zero_rows_is_a_no_op() {
    let mut out: [f32; 0] = [];
    scan(&[], 0, 4, &[], &[1.0, 2.0, 3.0, 4.0], 1.0, 0, &mut out);
}

#[test]
fn ties_are_exact_equal_scores_for_identical_rows() {
    let data = [1.0f32, 2.0, 3.0, 1.0, 2.0, 3.0];
    let mut norms = [0.0f32; 2];
    inv_norms(&data, 2, 3, &mut norms);
    let mut out = [0.0f32; 2];
    scan(&data, 2, 3, &norms, &[3.0, 2.0, 1.0], 0.25, 0, &mut out);
    assert_eq!(out[0].to_bits(), out[1].to_bits());
}
