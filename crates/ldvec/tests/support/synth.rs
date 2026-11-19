//! Shared test data for the HNSW tests: one integer-only generator, implemented identically in Rust
//! (this file) and in TypeScript (`bench/synth.ts`). Both must give the same bytes; the sha256 values
//! in `test/fixtures/hnsw-determinism.json` pin that.
//!
//! The rules are integers only: SplitMix64 draws give integer centre coordinates and integer noise (an
//! Irwin-Hall sum of four 16-bit integer terms) as `i32`, and each component is `i32 / 2^16`, which is
//! exact in binary32 because every `|i32|` is below 2^24. There is no `ln`, `cos`, `sqrt` or float
//! random draw anywhere (the last bit of those differs between libm implementations).
//!
//!   centres   state = seed (as u64); for c in 0..C, j in 0..dim: z = next(); centre[c][j] = (z >> 43) - 2^20
//!   points    state = seed ^ STREAM; per point: z = next(); c = (z >> 32) % C; then for each j: z = next();
//!             noise = ((z & 0xFFFF) + ((z >> 16) & 0xFFFF) + ((z >> 32) & 0xFFFF) + (z >> 48) - 131070) * 8;
//!             component = (centre[c][j] + noise) / 65536
//!   streams   DATA_STREAM for the stored rows, QUERY_STREAM for the queries (separate draws, same centres)
//!
//! The noise standard deviation is half the centre spread, the same shape as a Gaussian mixture with
//! `x = c + 0.5 g` per component, drawn from integers.
#![allow(dead_code)]

pub const DATA_STREAM: u64 = 0xD1B5_4A32_D192_ED03;
pub const QUERY_STREAM: u64 = 0x8CB9_2BA7_2F3D_8DD7;
const CENTRE_BIAS: i32 = 1 << 20;
const NOISE_BIAS: i64 = 131_070;
const NOISE_SCALE: i32 = 8;

pub fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// `n` centres of `dim` integer coordinates each, row-major.
pub fn centres(seed: u32, n: usize, dim: usize) -> Vec<i32> {
    let mut st = seed as u64;
    (0..n * dim)
        .map(|_| ((splitmix64(&mut st) >> 43) as i32) - CENTRE_BIAS)
        .collect()
}

/// `count` points of the stream, row-major `count * dim` binary32 values.
pub fn points(centres: &[i32], dim: usize, seed: u32, stream: u64, count: usize) -> Vec<f32> {
    let n_c = centres.len() / dim;
    let mut st = (seed as u64) ^ stream;
    let mut out = Vec::with_capacity(count * dim);
    for _ in 0..count {
        let c = ((splitmix64(&mut st) >> 32) as usize) % n_c;
        for j in 0..dim {
            let z = splitmix64(&mut st);
            let s = (z & 0xFFFF) + ((z >> 16) & 0xFFFF) + ((z >> 32) & 0xFFFF) + (z >> 48);
            let noise = ((s as i64 - NOISE_BIAS) as i32) * NOISE_SCALE;
            out.push((centres[c * dim + j] + noise) as f32 / 65536.0);
        }
    }
    out
}

/// The clustered rows and queries of one fixture: `(rows, queries)`.
pub fn clustered(
    seed: u32,
    n_centres: usize,
    dim: usize,
    rows: usize,
    queries: usize,
) -> (Vec<f32>, Vec<f32>) {
    let c = centres(seed, n_centres, dim);
    (
        points(&c, dim, seed, DATA_STREAM, rows),
        points(&c, dim, seed, QUERY_STREAM, queries),
    )
}

/// Uniform rows in [-1, 1) as `(z >> 44) - 2^19` over 2^19 (exact in binary32): the worst case for any
/// graph index. Same stream rules, one draw per component.
pub fn uniform(seed: u32, stream: u64, count: usize, dim: usize) -> Vec<f32> {
    let mut st = (seed as u64) ^ stream;
    (0..count * dim)
        .map(|_| (((splitmix64(&mut st) >> 44) as i32) - (1 << 19)) as f32 / 524_288.0)
        .collect()
}

/// The bytes of a binary32 slice, little-endian (what `Float32Array` holds in memory).
pub fn f32_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}
