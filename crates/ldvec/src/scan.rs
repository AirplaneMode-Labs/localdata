//! Bit-exact flat scan (Storage API 0.2.0, "Scoring").
//!
//! IEEE-754 binary32, round-to-nearest-even, no FMA, no relaxed-simd. `dot4` keeps four
//! accumulators that start at +0: element `i` is added into accumulator `i mod 4` in index order, each
//! multiply and each add rounded to f32, and the result is `(acc0 + acc1) + (acc2 + acc3)`. The SIMD
//! path puts accumulator `j` in lane `j` of one f32x4 and handles the tail in lane `i mod 4`, so the
//! two paths are bit-identical. `cfg(target_feature = "simd128")` selects between them from this one
//! source.

/// Rows (and queries) whose self dot product exceeds this are refused: it keeps every partial sum of a
/// later dot product finite (Cauchy-Schwarz) and so keeps scores free of infinities and NaN.
pub const SELF_DOT_MAX: f64 = 1e30;

pub const METRIC_COSINE: u32 = 0;
pub const METRIC_DOT: u32 = 1;

/// The scalar kernel: four explicit accumulators.
pub fn dot4_scalar(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut acc = [0.0f32; 4];
    let mut i = 0;
    while i + 4 <= n {
        acc[0] += a[i] * b[i];
        acc[1] += a[i + 1] * b[i + 1];
        acc[2] += a[i + 2] * b[i + 2];
        acc[3] += a[i + 3] * b[i + 3];
        i += 4;
    }
    while i < n {
        acc[i & 3] += a[i] * b[i];
        i += 1;
    }
    (acc[0] + acc[1]) + (acc[2] + acc[3])
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn dot4_simd(a: &[f32], b: &[f32]) -> f32 {
    use core::arch::wasm32::{
        f32x4_add, f32x4_extract_lane, f32x4_mul, f32x4_splat, v128, v128_load,
    };
    let n = a.len().min(b.len());
    let n4 = n & !3;
    let mut acc = f32x4_splat(0.0);
    let mut i = 0;
    while i < n4 {
        // SAFETY: i + 4 <= n4 <= a.len() and b.len(); v128_load has no alignment requirement.
        let (va, vb) = unsafe {
            (
                v128_load(a.as_ptr().add(i) as *const v128),
                v128_load(b.as_ptr().add(i) as *const v128),
            )
        };
        acc = f32x4_add(acc, f32x4_mul(va, vb));
        i += 4;
    }
    let mut l = [
        f32x4_extract_lane::<0>(acc),
        f32x4_extract_lane::<1>(acc),
        f32x4_extract_lane::<2>(acc),
        f32x4_extract_lane::<3>(acc),
    ];
    while i < n {
        l[i & 3] += a[i] * b[i];
        i += 1;
    }
    (l[0] + l[1]) + (l[2] + l[3])
}

/// The kernel this build uses: SIMD when compiled with simd128, otherwise scalar.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
pub fn dot4(a: &[f32], b: &[f32]) -> f32 {
    dot4_simd(a, b)
}

/// The kernel this build uses: SIMD when compiled with simd128, otherwise scalar.
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
pub fn dot4(a: &[f32], b: &[f32]) -> f32 {
    dot4_scalar(a, b)
}

/// True when this build uses the SIMD kernel.
pub const fn simd_enabled() -> bool {
    cfg!(all(target_arch = "wasm32", target_feature = "simd128"))
}

/// 1 / sqrt(selfDot) in f32, or 0 for a zero vector.
pub fn inv_norm(v: &[f32]) -> f32 {
    let sd = dot4(v, v);
    if sd == 0.0 {
        0.0
    } else {
        1.0f32 / sd.sqrt()
    }
}

/// The first row index whose components are not all finite or whose self dot exceeds
/// [`SELF_DOT_MAX`], or -1 when every row is fine. `vec` holds `rows * dim` floats.
pub fn check_rows(vec: &[f32], rows: usize, dim: usize) -> i32 {
    for r in 0..rows {
        let row = &vec[r * dim..(r + 1) * dim];
        if row.iter().any(|x| !x.is_finite()) {
            return r as i32;
        }
        let sd = dot4(row, row);
        if !sd.is_finite() || (sd as f64) > SELF_DOT_MAX {
            return r as i32;
        }
    }
    -1
}

/// Writes 1/||row|| (0 for a zero row) into `out[0..rows]`.
pub fn inv_norms(vec: &[f32], rows: usize, dim: usize, out: &mut [f32]) {
    for r in 0..rows {
        out[r] = inv_norm(&vec[r * dim..(r + 1) * dim]);
    }
}

/// Scores `rows` rows against `q` into `out[0..rows]`. `metric` is [`METRIC_COSINE`] (0) or
/// [`METRIC_DOT`] (1); `norms` (the rows' inverse norms) is read only for cosine. -0 becomes +0.
#[allow(clippy::too_many_arguments)]
pub fn scan(
    vec: &[f32],
    rows: usize,
    dim: usize,
    norms: &[f32],
    q: &[f32],
    q_inv_norm: f32,
    metric: u32,
    out: &mut [f32],
) {
    for r in 0..rows {
        let d = dot4(&vec[r * dim..(r + 1) * dim], q);
        let s = if metric == METRIC_DOT {
            d
        } else {
            (d * norms[r]) * q_inv_norm
        };
        out[r] = if s == 0.0 { 0.0 } else { s };
    }
}
