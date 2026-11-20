//! ldvec: the flat-index kernel behind @airplanemode/localdata.
//!
//! * [`crc32c`]: CRC-32C (Castagnoli), slicing-by-8, incremental.
//! * [`mod@format`]: validation of the on-disk HEAD record and META blob (docs/vector-index-format.md).
//! * [`scan`]: row checks, inverse norms and the bit-exact scan, SIMD or scalar from one source.
//! * [`hnsw`]: the HNSW graph (build, search, insert, delete marks, serialise, validate), docs/hnsw-format.md.
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
pub mod hnsw;
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

/// A u32 slice of `n` words at `ptr`, or None when misaligned, out of range or too long.
///
/// # Safety
/// As for [`bytes`].
unsafe fn words<'a>(ptr: u32, n: u64) -> Option<&'a [u32]> {
    let nbytes = n.checked_mul(4)?;
    if nbytes > u32::MAX as u64 || !ptr.is_multiple_of(4) || !in_memory(ptr, nbytes) {
        return None;
    }
    if n == 0 {
        return Some(&[]);
    }
    // SAFETY: aligned, in range, finite length.
    Some(unsafe { core::slice::from_raw_parts(ptr as usize as *const u32, n as usize) })
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

// ---- HNSW (docs/hnsw-format.md) ---------------------------------------------------------------------
//
// A graph lives in a per-instance registry and the host holds an integer handle (1..=64), never a
// pointer: a forged or stale handle is an argument error, not undefined behaviour. The graph borrows
// the flat index's vectors for the length of one call through a BLOCK TABLE: `n_blocks` entries of four
// u32 words `[firstRow, rows, vecPtr, normsPtr]` that together cover rows `0..total`. Every pointer in
// the table is range- and alignment-checked before any slice is formed. A failed `insert` frees the
// graph (it may be half updated); the host then treats the graph as stale.

use std::cell::RefCell;

const HANDLES_MAX: usize = 64;
const BLOCKS_MAX: u32 = 1 << 16;
/// u32 words `ldv_hnsw_info` writes.
pub const HNSW_INFO_WORDS: u32 = 14;

thread_local! {
    static GRAPHS: RefCell<Vec<Option<hnsw::Graph>>> = const { RefCell::new(Vec::new()) };
}

fn register(g: hnsw::Graph) -> i32 {
    GRAPHS.with(|c| {
        let Ok(mut v) = c.try_borrow_mut() else {
            return E_ARGS;
        };
        if let Some(i) = v.iter().position(|s| s.is_none()) {
            v[i] = Some(g);
            return (i + 1) as i32;
        }
        if v.len() >= HANDLES_MAX || v.try_reserve(1).is_err() {
            return hnsw::Err::Memory as i32;
        }
        v.push(Some(g));
        v.len() as i32
    })
}

/// Runs `f` on the graph behind `handle`; an unknown handle is E_ARGS. A negative code from `f` is
/// returned as is, and `drop_on_err` frees the graph in that case.
fn with_graph<R>(
    handle: u32,
    drop_on_err: bool,
    f: impl FnOnce(&mut hnsw::Graph) -> Result<R, i32>,
) -> Result<R, i32> {
    GRAPHS.with(|c| {
        let Ok(mut v) = c.try_borrow_mut() else {
            return Err(E_ARGS);
        };
        let Some(slot) = (handle as usize).checked_sub(1).and_then(|i| v.get_mut(i)) else {
            return Err(E_ARGS);
        };
        let Some(g) = slot.as_mut() else {
            return Err(E_ARGS);
        };
        match f(g) {
            Ok(r) => Ok(r),
            Err(code) => {
                if drop_on_err {
                    *slot = None;
                }
                Err(code)
            }
        }
    })
}

/// Reads and checks a block table (see above) into a [`hnsw::Rows`] view.
///
/// # Safety
/// The ranges named by the table must stay readable and unmodified while the view lives; the host is
/// single-threaded and does not call into the module meanwhile.
unsafe fn rows_from_table<'a>(
    table_ptr: u32,
    n_blocks: u32,
    total: u32,
    dim: u32,
) -> Result<hnsw::Rows<'a>, i32> {
    // dim 0 is a namespace without vectors: only the empty table (no blocks, no rows) can describe it.
    if dim > format::DIM_MAX || n_blocks > BLOCKS_MAX || (dim == 0 && (n_blocks != 0 || total != 0))
    {
        return Err(E_ARGS);
    }
    // SAFETY: words() range- and alignment-checks the table.
    let t = unsafe { words(table_ptr, n_blocks as u64 * 4) }.ok_or(E_ARGS)?;
    let mut rows = hnsw::Rows::new(dim as usize);
    for e in t.as_chunks::<4>().0 {
        let (first, n, vp, np) = (e[0], e[1], e[2], e[3]);
        // SAFETY: floats() range- and alignment-checks each view.
        let (Some(v), Some(nm)) = (unsafe { floats(vp, n as u64 * dim as u64) }, unsafe {
            floats(np, n as u64)
        }) else {
            return Err(E_ARGS);
        };
        rows.push_block(first, n, v, nm).map_err(|_| E_ARGS)?;
    }
    if rows.total != total {
        return Err(E_ARGS);
    }
    Ok(rows)
}

/// Builds a graph over the live rows of the block table `[table_ptr, n_blocks]` (`total` rows of `dim`
/// components); `tomb_ptr`/`tomb_len` is the HEAD tombstone bitset (`tomb_len` 0 for none). `metric` 0 is
/// cosine, 1 is dot. Returns a handle (> 0) or a negative code: -100 for an argument error, -30 when
/// memory ran out, or one of the `hnsw::Err` codes.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ldv_hnsw_build(
    table_ptr: u32,
    n_blocks: u32,
    total: u32,
    dim: u32,
    tomb_ptr: u32,
    tomb_len: u32,
    ns_ptr: u32,
    ns_len: u32,
    metric: u32,
    m: u32,
    ef_construction: u32,
    seed: u32,
    generation: u32,
) -> i32 {
    // SAFETY: the table and every view in it are checked; the bitset and namespace are range-checked.
    let rows = match unsafe { rows_from_table(table_ptr, n_blocks, total, dim) } {
        Ok(r) => r,
        Err(c) => return c,
    };
    let (Some(tomb), Some(ns)) = (unsafe { bytes(tomb_ptr, tomb_len) }, unsafe {
        bytes(ns_ptr, ns_len)
    }) else {
        return E_ARGS;
    };
    let p = hnsw::Params {
        metric,
        m,
        ef_construction,
        seed,
    };
    match hnsw::Graph::build(&p, ns, generation, &rows, tomb) {
        Ok(g) => register(g),
        Err(e) => e as i32,
    }
}

/// Validates and loads a serialised graph at `[ptr, ptr + len)` for a namespace of `dim` components whose
/// flat HEAD has `rows` rows at `head_generation`, named by the UTF-8 bytes at `ns_ptr`, and whose stored
/// params record says `metric`, `m`, `ef_construction` and `seed`. Returns a handle (> 0) or a negative code
/// (-20 to -29 for a refused file, -30 for memory, -100 for arguments).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ldv_hnsw_load(
    ptr: u32,
    len: u32,
    dim: u32,
    rows: u32,
    head_generation: u32,
    ns_ptr: u32,
    ns_len: u32,
    metric: u32,
    m: u32,
    ef_construction: u32,
    seed: u32,
) -> i32 {
    // SAFETY: range-checked views.
    let (Some(b), Some(ns)) = (unsafe { bytes(ptr, len) }, unsafe { bytes(ns_ptr, ns_len) }) else {
        return E_ARGS;
    };
    // The namespace's stored params record, read by the host: the header must say the same (-29 when it does
    // not), and that is checked before anything sized by the header is reserved (S1-123, S1-128).
    let e = hnsw::Expect {
        dim,
        rows,
        generation: head_generation,
        ns,
        params: hnsw::Params {
            metric,
            m,
            ef_construction,
            seed,
        },
    };
    match hnsw::Graph::load(b, &e) {
        Ok(g) => register(g),
        Err(e) => e as i32,
    }
}

/// Counts exact and near duplicates among the live rows of the block table `[table_ptr, n_blocks]` (`total` rows
/// of `dim` components) and the HEAD tombstone bitset (`tomb_len` 0 for none): writes three u32 words to `out_ptr`,
/// `[rows whose bytes equal an earlier live row's, size of the largest group of identical live rows, size of the
/// largest group that shares a quantised key]` (TD-126).
/// Returns 0, or a negative code: -100 for arguments, -30 when the 8 bytes per live row it needs could not be
/// reserved.
#[no_mangle]
pub extern "C" fn ldv_hnsw_dup_stats(
    table_ptr: u32,
    n_blocks: u32,
    total: u32,
    dim: u32,
    tomb_ptr: u32,
    tomb_len: u32,
    out_ptr: u32,
) -> i32 {
    // SAFETY: the table and every view in it are checked; the bitset and the output are range-checked.
    let rows = match unsafe { rows_from_table(table_ptr, n_blocks, total, dim) } {
        Ok(r) => r,
        Err(c) => return c,
    };
    let (Some(tomb), Some(out)) = (unsafe { bytes(tomb_ptr, tomb_len) }, unsafe {
        floats_mut(out_ptr, 3)
    }) else {
        return E_ARGS;
    };
    match hnsw::duplicate_stats(&rows, tomb) {
        Ok(st) => {
            // SAFETY: f32 and u32 have the same size and alignment; the words are written as bit patterns.
            let w: &mut [u32] =
                unsafe { core::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u32, out.len()) };
            w[0] = st.rows;
            w[1] = st.max_group;
            w[2] = st.near_max;
            0
        }
        Err(e) => e as i32,
    }
}

/// Records a fresh count (see `ldv_hnsw_dup_stats`) in the graph, which writes it into its header: the largest
/// group of identical live rows and the largest group that shares a quantised key. A graph for which either exceeds
/// 2 * m is degenerate. A near count below the exact count is impossible and returns -26 (bounds), leaving the
/// graph as it was.
#[no_mangle]
pub extern "C" fn ldv_hnsw_set_dup_stats(handle: u32, max_group: u32, near_max: u32) -> i32 {
    match with_graph(handle, false, |g| {
        g.set_dup_stats(max_group, near_max).map_err(|e| e as i32)
    }) {
        Ok(()) => 0,
        Err(c) => c,
    }
}

/// Writes `HNSW_INFO_WORDS` u32 words to `out_ptr`: `[metric, m, efConstruction, seed, dim, nodes, liveNodes,
/// generation, entry (0xFFFFFFFF when empty), maxLevel, serialisedLenLo, serialisedLenHi, dupMax, nearMax]`.
#[no_mangle]
pub extern "C" fn ldv_hnsw_info(handle: u32, out_ptr: u32) -> i32 {
    // SAFETY: range- and alignment-checked view.
    let Some(out) = (unsafe { floats_mut(out_ptr, HNSW_INFO_WORDS as u64) }) else {
        return E_ARGS;
    };
    // SAFETY: f32 and u32 have the same size and alignment; the words are written as bit patterns.
    let w: &mut [u32] =
        unsafe { core::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u32, out.len()) };
    match with_graph(handle, false, |g| {
        let p = g.params();
        let n = g.serialized_len();
        w[0] = p.metric;
        w[1] = p.m;
        w[2] = p.ef_construction;
        w[3] = p.seed;
        w[4] = g.dim();
        w[5] = g.node_count();
        w[6] = g.live_nodes();
        w[7] = g.generation();
        w[8] = g.entry().unwrap_or(hnsw::NONE);
        w[9] = g.max_level();
        w[10] = n as u32;
        w[11] = (n >> 32) as u32;
        w[12] = g.dup_max();
        w[13] = g.near_max();
        Ok(())
    }) {
        Ok(()) => 0,
        Err(c) => c,
    }
}

/// Inserts the nodes of rows `first..first + count` (each above every ordinal already in the graph)
/// against the block table. Returns 0, or a negative code; on a negative code other than -100 the graph has
/// been freed (it may be half updated) and the handle is dead.
#[no_mangle]
pub extern "C" fn ldv_hnsw_insert(
    handle: u32,
    table_ptr: u32,
    n_blocks: u32,
    total: u32,
    first: u32,
    count: u32,
) -> i32 {
    let r = with_graph(handle, true, |g| {
        // SAFETY: the table and every view in it are checked.
        let rows = unsafe { rows_from_table(table_ptr, n_blocks, total, g.dim()) }
            .map_err(|_| hnsw::Err::Bounds as i32)?;
        let end = first.checked_add(count).ok_or(hnsw::Err::Bounds as i32)?;
        for o in first..end {
            g.insert(&rows, o).map_err(|e| e as i32)?;
        }
        Ok(())
    });
    match r {
        Ok(()) => 0,
        Err(c) => c,
    }
}

/// Marks the node of row `ordinal` deleted: 1 when a live node was marked, 0 when there was none.
#[no_mangle]
pub extern "C" fn ldv_hnsw_mark_deleted(handle: u32, ordinal: u32) -> i32 {
    match with_graph(handle, false, |g| Ok(g.mark_deleted(ordinal))) {
        Ok(b) => b as i32,
        Err(c) => c,
    }
}

/// Sets the flat HEAD generation the graph will be written with.
#[no_mangle]
pub extern "C" fn ldv_hnsw_set_generation(handle: u32, generation: u32) -> i32 {
    if generation > format::GEN_MAX {
        return hnsw::Err::Bounds as i32;
    }
    match with_graph(handle, false, |g| {
        g.set_generation(generation);
        Ok(())
    }) {
        Ok(()) => 0,
        Err(c) => c,
    }
}

/// Searches for the `ef` best live rows for the query at `q_ptr` (`f32[dim]`, finite, selfDot <= 1e30).
/// `tomb_ptr`/`tomb_len` is the flat HEAD's tombstone bitset (`tomb_len` 0 for none). Writes up to `ef`
/// pairs `[ordinal u32, score f32]` best first to `out_ptr` (room for `out_cap >= ef` pairs) and returns
/// how many. A negative code is an error (-100 arguments, -26 and the like for a graph that does not
/// match the rows).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ldv_hnsw_search(
    handle: u32,
    table_ptr: u32,
    n_blocks: u32,
    total: u32,
    tomb_ptr: u32,
    tomb_len: u32,
    q_ptr: u32,
    ef: u32,
    out_ptr: u32,
    out_cap: u32,
) -> i32 {
    if ef == 0 || ef > hnsw::EF_MAX || out_cap < ef {
        return E_ARGS;
    }
    let r = with_graph(handle, false, |g| {
        let dim = g.dim();
        // SAFETY: the table and every view in it are checked; the other views are range-checked.
        let rows = unsafe { rows_from_table(table_ptr, n_blocks, total, dim) }?;
        let (Some(tomb), Some(q), Some(out)) = (
            unsafe { bytes(tomb_ptr, tomb_len) },
            unsafe { floats(q_ptr, dim as u64) },
            unsafe { floats_mut(out_ptr, out_cap as u64 * 2) },
        ) else {
            return Err(E_ARGS);
        };
        if scan::check_rows(q, 1, dim as usize) != -1 {
            return Err(hnsw::Err::Bounds as i32);
        }
        let mut hits = Vec::new();
        g.search(&rows, q, ef as usize, tomb, &mut hits)
            .map_err(|e| e as i32)?;
        // SAFETY: f32 and u32 have the same size and alignment; the words are written as bit patterns.
        let w: &mut [u32] =
            unsafe { core::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u32, out.len()) };
        for (i, h) in hits.iter().enumerate() {
            w[2 * i] = h.ordinal;
            w[2 * i + 1] = h.score.to_bits();
        }
        Ok(hits.len() as i32)
    });
    match r {
        Ok(n) => n,
        Err(c) => c,
    }
}

/// The exact serialised length of the graph, or a negative code (-30 when it does not fit an i32).
#[no_mangle]
pub extern "C" fn ldv_hnsw_serialize_len(handle: u32) -> i32 {
    match with_graph(handle, false, |g| {
        let n = g.serialized_len();
        if n > i32::MAX as u64 {
            Err(hnsw::Err::Memory as i32)
        } else {
            Ok(n as i32)
        }
    }) {
        Ok(n) => n,
        Err(c) => c,
    }
}

/// Writes the serialised graph into `[out_ptr, out_ptr + out_len)`, which must be exactly the length
/// `ldv_hnsw_serialize_len` returned. Returns 0 or a negative code.
#[no_mangle]
pub extern "C" fn ldv_hnsw_serialize(handle: u32, out_ptr: u32, out_len: u32) -> i32 {
    if !in_memory(out_ptr, out_len as u64) || out_len == 0 {
        return E_ARGS;
    }
    // SAFETY: range-checked above; the buffer is the host's own allocation, disjoint from the graph.
    let out =
        unsafe { core::slice::from_raw_parts_mut(out_ptr as usize as *mut u8, out_len as usize) };
    match with_graph(handle, false, |g| {
        g.serialize_into(out).map_err(|e| e as i32)
    }) {
        Ok(()) => 0,
        Err(c) => c,
    }
}

/// Frees a graph. An unknown handle is ignored.
#[no_mangle]
pub extern "C" fn ldv_hnsw_free(handle: u32) {
    GRAPHS.with(|c| {
        if let Ok(mut v) = c.try_borrow_mut() {
            if let Some(slot) = (handle as usize).checked_sub(1).and_then(|i| v.get_mut(i)) {
                *slot = None;
            }
        }
    });
}
