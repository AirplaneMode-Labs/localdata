//! ldvec: the flat-index kernel behind @airplanemode/localdata.
//!
//! * [`crc32c`]: CRC-32C (Castagnoli), slicing-by-8, incremental.
//! * [`mod@format`]: validation of the on-disk HEAD record and META blob (docs/vector-index-format.md).
//! * [`scan`]: row checks, inverse norms and the bit-exact scan, SIMD or scalar from one source.
//!
//! The WASM module exposes raw `extern "C"` functions (no wasm-bindgen): pointers and lengths are
//! `u32` offsets into linear memory, results are `i32` or `u32`. The TypeScript layer owns the
//! memory: it calls `ldv_alloc`, copies bytes in, calls a kernel function and reads results out.
//! Natively this crate is an ordinary library, which is how the tests exercise it.
//!
//! Every pointer from the host is range-checked against the current memory size before a slice is
//! formed (functions that can fail return a negative code instead of trapping); lengths are
//! multiplied in `u64`; alignment is verified for `f32` and `u32` views. `ldv_crc32c` has no error
//! channel and deliberately does not pre-check: it traps on an out-of-range pointer, and the host
//! treats any trap as "discard this instance".

pub mod crc32c;
pub mod format;
pub mod scan;

use core::alloc::Layout;

/// Argument error returned by the FFI functions (an out-of-range or misaligned pointer, a length that
/// does not fit). Distinct from every `format::Err` code, which occupy -1 to -14.
pub const E_ARGS: i32 = -100;
const ALIGN: usize = 16;

/// True when `[ptr, ptr + len)` lies inside linear memory (always true off wasm, where the FFI is
/// never called).
#[cfg(target_arch = "wasm32")]
fn in_memory(ptr: u32, len: u64) -> bool {
    let size = (core::arch::wasm32::memory_size::<0>() as u64) * 65_536;
    (ptr as u64) + len <= size
}

#[cfg(not(target_arch = "wasm32"))]
fn in_memory(_ptr: u32, _len: u64) -> bool {
    true
}

/// A byte slice at `ptr`, or None when it is out of range.
///
/// # Safety
/// The range must be readable linear memory not mutated while the slice lives (checked by
/// `in_memory` on wasm; the host is single-threaded).
unsafe fn bytes<'a>(ptr: u32, len: u32) -> Option<&'a [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    if !in_memory(ptr, len as u64) {
        return None;
    }
    // SAFETY: range-checked above.
    Some(unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len as usize) })
}

/// An f32 slice of `n` floats at `ptr`, or None when misaligned, out of range or too long.
///
/// # Safety
/// As for [`bytes`].
unsafe fn floats<'a>(ptr: u32, n: u64) -> Option<&'a [f32]> {
    let nbytes = n.checked_mul(4)?;
    if nbytes > u32::MAX as u64 || !ptr.is_multiple_of(4) || !in_memory(ptr, nbytes) {
        return None;
    }
    if n == 0 {
        return Some(&[]);
    }
    // SAFETY: aligned, in range, finite length.
    Some(unsafe { core::slice::from_raw_parts(ptr as usize as *const f32, n as usize) })
}

/// A mutable f32 slice, with the same checks as [`floats`].
///
/// # Safety
/// As for [`bytes`], and the range must not overlap any other live slice.
unsafe fn floats_mut<'a>(ptr: u32, n: u64) -> Option<&'a mut [f32]> {
    let nbytes = n.checked_mul(4)?;
    if nbytes > u32::MAX as u64 || !ptr.is_multiple_of(4) || !in_memory(ptr, nbytes) {
        return None;
    }
    if n == 0 {
        return Some(&mut []);
    }
    // SAFETY: aligned, in range, finite length, exclusive by the caller's contract.
    Some(unsafe { core::slice::from_raw_parts_mut(ptr as usize as *mut f32, n as usize) })
}

/// Allocates `len` bytes (16-byte aligned). Returns the offset, or 0 when `len` is 0 or the
/// allocation fails (linear memory could not grow).
#[no_mangle]
pub extern "C" fn ldv_alloc(len: u32) -> u32 {
    if len == 0 {
        return 0;
    }
    let Ok(layout) = Layout::from_size_align(len as usize, ALIGN) else {
        return 0;
    };
    // SAFETY: the layout has a non-zero size.
    let p = unsafe { std::alloc::alloc(layout) };
    p as usize as u32
}

/// Frees a block returned by `ldv_alloc` with the same `len`. A zero pointer or length is ignored.
#[no_mangle]
pub extern "C" fn ldv_free(ptr: u32, len: u32) {
    if ptr == 0 || len == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len as usize, ALIGN) else {
        return;
    };
    // SAFETY: the host passes back a pointer and length that ldv_alloc returned.
    unsafe { std::alloc::dealloc(ptr as usize as *mut u8, layout) }
}

/// Continues a CRC-32C over `[ptr, ptr + len)`; `prev` is 0 to start. Traps on an out-of-range
/// pointer (see the crate comment).
#[no_mangle]
pub extern "C" fn ldv_crc32c(prev: u32, ptr: u32, len: u32) -> u32 {
    if len == 0 {
        return prev;
    }
    // SAFETY: deliberately unchecked; an invalid range traps and the host discards the instance.
    let s = unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len as usize) };
    crc32c::update(prev, s)
}

/// -1 when every row of `rows * dim` floats at `vec_ptr` is finite with a self dot product no
/// greater than 1e30; otherwise the index of the first bad row; -100 for an argument error.
#[no_mangle]
pub extern "C" fn ldv_check_rows(vec_ptr: u32, rows: u32, dim: u32) -> i32 {
    if rows > i32::MAX as u32 || dim == 0 {
        return E_ARGS;
    }
    // SAFETY: floats() range- and alignment-checks the view.
    let Some(v) = (unsafe { floats(vec_ptr, rows as u64 * dim as u64) }) else {
        return E_ARGS;
    };
    scan::check_rows(v, rows as usize, dim as usize)
}

/// Writes 1/||row|| (0 for a zero row) for each of `rows` rows into `out_ptr` (`f32[rows]`).
/// Returns 0, or -100 for an argument error.
#[no_mangle]
pub extern "C" fn ldv_inv_norms(vec_ptr: u32, rows: u32, dim: u32, out_ptr: u32) -> i32 {
    if dim == 0 {
        return E_ARGS;
    }
    // SAFETY: both views are range- and alignment-checked; the host passes disjoint blocks.
    let (Some(v), Some(out)) = (
        unsafe { floats(vec_ptr, rows as u64 * dim as u64) },
        unsafe { floats_mut(out_ptr, rows as u64) },
    ) else {
        return E_ARGS;
    };
    scan::inv_norms(v, rows as usize, dim as usize, out);
    0
}

/// Scores `rows` rows at `vec_ptr` against the query at `q_ptr` (`f32[dim]`) into `out_ptr`
/// (`f32[rows]`). `norms_ptr` is `f32[rows]` (read for cosine only; may be 0 for dot). `metric` 0 is
/// cosine, 1 is dot. Returns 0, or -100 for an argument error.
#[no_mangle]
pub extern "C" fn ldv_scan(
    vec_ptr: u32,
    rows: u32,
    dim: u32,
    norms_ptr: u32,
    q_ptr: u32,
    q_inv_norm: f32,
    metric: u32,
    out_ptr: u32,
) -> i32 {
    if dim == 0 || metric > scan::METRIC_DOT {
        return E_ARGS;
    }
    // SAFETY: every view is range- and alignment-checked; the host passes disjoint blocks.
    let (Some(v), Some(q), Some(out)) = (
        unsafe { floats(vec_ptr, rows as u64 * dim as u64) },
        unsafe { floats(q_ptr, dim as u64) },
        unsafe { floats_mut(out_ptr, rows as u64) },
    ) else {
        return E_ARGS;
    };
    let norms: &[f32] = if metric == scan::METRIC_COSINE {
        // SAFETY: as above.
        match unsafe { floats(norms_ptr, rows as u64) } {
            Some(n) => n,
            None => return E_ARGS,
        }
    } else {
        &[]
    };
    scan::scan(
        v,
        rows as usize,
        dim as usize,
        norms,
        q,
        q_inv_norm,
        metric,
        out,
    );
    0
}

/// Number of u32 words `ldv_parse_head` writes before the segment entries.
pub const HEAD_OUT_WORDS: u32 = 12;
/// Number of u32 words per segment entry in the `ldv_parse_head` output.
pub const SEG_OUT_WORDS: u32 = 8;

/// Parses and validates the HEAD record at `[ptr, ptr + len)`. On success returns 0 and writes u32
/// words to `out_ptr`:
/// `[dim, segCount, totalRows, liveRows, nextSegId, generation, vecBytesLo, vecBytesHi,
/// metaBytesLo, metaBytesHi, tombOff, 0]` followed by `segCount` entries of
/// `[segId, rows, firstRow, keyBytesLen, valueBytesLen, vecCrc, metaCrc, flags]`.
/// `out_ptr` must have room for `HEAD_OUT_WORDS + SEG_OUT_WORDS * 4096` words. Returns a negative
/// error code on failure (see `format::Err`), -100 for an argument error.
#[no_mangle]
pub extern "C" fn ldv_parse_head(ptr: u32, len: u32, out_ptr: u32) -> i32 {
    // SAFETY: range-checked views; out is disjoint from the input by the host's allocation.
    let Some(b) = (unsafe { bytes(ptr, len) }) else {
        return E_ARGS;
    };
    let words = (HEAD_OUT_WORDS + SEG_OUT_WORDS * format::SEG_MAX) as u64;
    let Some(out) = (unsafe { floats_mut(out_ptr, words) }) else {
        return E_ARGS;
    };
    match format::parse_head(b) {
        Err(e) => e as i32,
        Ok(h) => {
            // SAFETY: f32 and u32 have the same size and alignment; the words are written as bit patterns.
            let w: &mut [u32] =
                unsafe { core::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u32, out.len()) };
            w[0] = h.dim;
            w[1] = h.seg_count;
            w[2] = h.total_rows;
            w[3] = h.live_rows;
            w[4] = h.next_seg_id;
            w[5] = h.generation;
            w[6] = h.vec_bytes as u32;
            w[7] = (h.vec_bytes >> 32) as u32;
            w[8] = h.meta_bytes as u32;
            w[9] = (h.meta_bytes >> 32) as u32;
            w[10] = h.tomb_off as u32;
            w[11] = 0;
            for (i, s) in h.segs.iter().enumerate() {
                let o = (HEAD_OUT_WORDS + SEG_OUT_WORDS * i as u32) as usize;
                w[o] = s.seg_id;
                w[o + 1] = s.rows;
                w[o + 2] = s.first_row;
                w[o + 3] = s.key_bytes_len;
                w[o + 4] = s.value_bytes_len;
                w[o + 5] = s.vec_crc;
                w[o + 6] = s.meta_crc;
                w[o + 7] = s.flags;
            }
            0
        }
    }
}

/// Validates one segment's META blob at `[ptr, ptr + len)`. Returns 0 or a negative error code.
#[no_mangle]
pub extern "C" fn ldv_check_meta(
    ptr: u32,
    len: u32,
    rows: u32,
    key_bytes_len: u32,
    value_bytes_len: u32,
) -> i32 {
    // SAFETY: range-checked view.
    let Some(m) = (unsafe { bytes(ptr, len) }) else {
        return E_ARGS;
    };
    match format::check_meta(m, rows, key_bytes_len, value_bytes_len) {
        Ok(()) => 0,
        Err(e) => e as i32,
    }
}

/// 1 when this build uses the SIMD kernel, 0 for the scalar kernel.
#[no_mangle]
pub extern "C" fn ldv_simd() -> i32 {
    scan::simd_enabled() as i32
}
