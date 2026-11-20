//! D4-02 (TD-111; S1-123 and S1-128): a graph header is untrusted input, and it is compared with the
//! namespace's stored params record, and with every limit, BEFORE any allocation sized by one of its
//! fields. Written before the fix.
//!
//! The probe is a counting global allocator: while it is armed on the calling thread it records the
//! largest single allocation request and the total requested. The forged files below are built before
//! the probe is armed; only `Graph::load` runs under it.
//!
//! The case that mattered in Sprint 6: a namespace built with m = 16, and a graph file whose header says
//! m = 64 with a declared 1,000,000 rows. The file is well formed in every other respect (valid length
//! equation, valid CRC, valid node table), so the old loader accepted it after reserving and zero-filling
//! 516 MB for layer 0; the stored-params comparison happened afterwards, in TypeScript.
mod common;
#[path = "support/synth.rs"]
mod synth;

use common::{crc32c_bitwise, get_u32, put_u32};
use ldvec::hnsw::{Err, Expect, Graph, Params, Rows};
use ldvec::scan;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

// ---- the allocation probe ---------------------------------------------------------------------

struct Probe;

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static LARGEST: Cell<usize> = const { Cell::new(0) };
    static TOTAL: Cell<usize> = const { Cell::new(0) };
}

fn note(n: usize) {
    let _ = ARMED.try_with(|a| {
        if a.get() {
            let _ = LARGEST.try_with(|l| l.set(l.get().max(n)));
            let _ = TOTAL.try_with(|t| t.set(t.get().saturating_add(n)));
        }
    });
}

// SAFETY: every method forwards to the system allocator unchanged; the counters are thread-local cells
// with const initialisers (no allocation, no destructor).
unsafe impl GlobalAlloc for Probe {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        note(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        note(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        note(new);
        unsafe { System.realloc(p, l, new) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static PROBE: Probe = Probe;

/// Runs `f` with the probe armed: (its result, largest single request, total requested).
fn probed<R>(f: impl FnOnce() -> R) -> (R, usize, usize) {
    LARGEST.with(|l| l.set(0));
    TOTAL.with(|t| t.set(0));
    ARMED.with(|a| a.set(true));
    let r = f();
    ARMED.with(|a| a.set(false));
    (r, LARGEST.with(|l| l.get()), TOTAL.with(|t| t.get()))
}

/// What a refused header may allocate: the namespace copy (at most 64 bytes) and nothing else. No
/// field of a header sizes anything before the check that refuses it.
const REFUSAL_BUDGET: usize = 1024;

// ---- the graphs -------------------------------------------------------------------------------

const DIM: usize = 16;
const ROWS: usize = 60;
const NS: &[u8] = b"forge.ns";
const GEN: u32 = 5;
const COSINE: u32 = 0;
/// The params the namespace's stored record says.
const STORED: Params = Params {
    metric: COSINE,
    m: 16,
    ef_construction: 40,
    seed: 9,
};

/// TD-111: the kernel is told the stored params (the TypeScript side reads them from the namespace's
/// params record) and compares the header with them before it allocates anything.
fn expect_with<'a>(
    ns: &'a [u8],
    dim: u32,
    rows: u32,
    generation: u32,
    stored: &Params,
) -> Expect<'a> {
    Expect {
        dim,
        rows,
        generation,
        ns,
        params: *stored,
    }
}

fn small() -> Vec<u8> {
    let (vec, _) = synth::clustered(21, 4, DIM, ROWS, 1);
    let mut norms = vec![0.0f32; ROWS];
    scan::inv_norms(&vec, ROWS, DIM, &mut norms);
    let rows = Rows::contiguous(&vec, &norms, DIM).unwrap();
    Graph::build(&STORED, NS, GEN, &rows, &[])
        .unwrap()
        .serialize()
        .unwrap()
}

fn recrc(b: &mut [u8]) {
    let n = b.len();
    let c = crc32c_bitwise(0, &b[..n - 4]);
    put_u32(b, n - 4, c);
}

/// A well-formed graph file of `count` isolated nodes (level 0, no links, ordinals 0..count) whose header
/// carries the given params. Valid length equation, valid CRC, valid node table.
fn forged_big(count: u32, p: &Params, dim: u32, generation: u32) -> Vec<u8> {
    let ns_len = NS.len();
    let words = count as usize; // one empty layer-0 list per node
    let len = 60 + ns_len + 8 * count as usize + 4 * words + 4;
    let mut b = vec![0u8; len];
    b[0..8].copy_from_slice(b"LDHNSW02");
    b[8..10].copy_from_slice(&2u16.to_le_bytes());
    b[10] = p.metric as u8;
    b[11] = ns_len as u8;
    put_u32(&mut b, 12, dim);
    put_u32(&mut b, 16, p.m);
    put_u32(&mut b, 20, p.ef_construction);
    put_u32(&mut b, 24, p.seed);
    put_u32(&mut b, 28, generation);
    put_u32(&mut b, 32, count);
    put_u32(&mut b, 36, count);
    put_u32(&mut b, 40, 0);
    put_u32(&mut b, 44, 0);
    put_u32(&mut b, 48, words as u32);
    b[60..60 + ns_len].copy_from_slice(NS);
    let table = 60 + ns_len;
    for i in 0..count as usize {
        put_u32(&mut b, table + 8 * i, i as u32);
    }
    recrc(&mut b);
    b
}

fn load_probed(b: &[u8], rows: u32, stored: &Params) -> (Result<Graph, Err>, usize, usize) {
    let e = expect_with(NS, DIM as u32, rows, GEN, stored);
    probed(|| Graph::load(b, &e))
}

// ---- the tests --------------------------------------------------------------------------------

#[test]
fn a_valid_graph_still_loads_with_its_own_params() {
    let b = small();
    let (r, _, _) = load_probed(&b, ROWS as u32, &STORED);
    let g = r.expect("a valid graph with matching params loads");
    assert_eq!(g.serialize().unwrap(), b);
}

/// The S1-123 case: header m = 64 over a stored m = 16, a declared one million rows.
#[test]
fn forged_m_64_over_stored_m_16_with_a_million_declared_rows_reserves_nothing() {
    let count = 1_000_000u32;
    let forged = Params {
        m: 64,
        ef_construction: 64,
        ..STORED
    };
    let b = forged_big(count, &forged, DIM as u32, GEN);
    assert!(
        b.len() > 12_000_000,
        "the forged file really is a million nodes long"
    );
    let (r, largest, total) = load_probed(&b, count, &STORED);
    eprintln!("S1-123 forged m=64 load: largest request {largest} bytes, total {total} bytes, result {:?}", r.as_ref().map(|_| "accepted"));
    assert!(
        r.is_err(),
        "a graph whose header says m=64 was accepted for a namespace stored with m=16"
    );
    assert!(
        largest <= REFUSAL_BUDGET && total <= 4 * REFUSAL_BUDGET,
        "the refusal allocated {largest} bytes at once ({total} in all): a header field sized an allocation"
    );
}

/// The same forged million-node file for every stored param it can differ in.
#[test]
fn every_header_param_that_differs_from_the_stored_record_is_refused_before_any_reservation() {
    let count = 1_000_000u32;
    let base = Params {
        m: 64,
        ef_construction: 64,
        ..STORED
    };
    let cases: [(&str, Params, Params); 6] = [
        (
            "m",
            Params {
                m: 64,
                ef_construction: 64,
                ..STORED
            },
            STORED,
        ),
        (
            "m at the limit, efc at the limit",
            Params {
                m: 64,
                ef_construction: 1000,
                ..STORED
            },
            STORED,
        ),
        (
            "metric",
            Params { metric: 1, ..base },
            Params {
                m: 64,
                ef_construction: 64,
                ..STORED
            },
        ),
        (
            "seed",
            Params { seed: 1234, ..base },
            Params {
                m: 64,
                ef_construction: 64,
                ..STORED
            },
        ),
        (
            "efConstruction",
            Params {
                ef_construction: 65,
                ..base
            },
            Params {
                m: 64,
                ef_construction: 64,
                ..STORED
            },
        ),
        (
            "m below the stored one",
            Params {
                m: 4,
                ef_construction: 40,
                ..STORED
            },
            STORED,
        ),
    ];
    for (name, header, stored) in cases {
        let b = forged_big(count, &header, DIM as u32, GEN);
        let (r, largest, total) = load_probed(&b, count, &stored);
        eprintln!(
            "S1-123 [{name}]: largest request {largest} bytes, total {total}, result {:?}",
            r.as_ref().map(|_| "accepted")
        );
        assert!(
            r.is_err(),
            "[{name}] a header that differs from the stored params was accepted"
        );
        assert!(
            largest <= REFUSAL_BUDGET && total <= 4 * REFUSAL_BUDGET,
            "[{name}] the refusal allocated {largest} bytes at once ({total} in all)"
        );
    }
}

/// Every header field forged at its limit and past it, on a small valid file (re-CRC'd, so only the
/// field is wrong). Whatever the refusal is, it allocates nothing sized by the field.
#[test]
fn every_header_field_at_and_past_its_limit_is_refused_without_a_header_sized_allocation() {
    let good = small();
    let ns = good[11] as usize;
    let table = 60 + ns;
    let count = get_u32(&good, 32);
    type Forge = Box<dyn Fn(&mut Vec<u8>)>;
    let word =
        |off: usize, v: u32| -> Forge { Box::new(move |b: &mut Vec<u8>| put_u32(b, off, v)) };
    let cases: Vec<(&str, Forge)> = vec![
        ("m 3", word(16, 3)),
        ("m 4", word(16, 4)),
        ("m 63", word(16, 63)),
        ("m 64", word(16, 64)),
        ("m 65", word(16, 65)),
        ("m u32::MAX", word(16, u32::MAX)),
        ("efConstruction 1000", word(20, 1000)),
        ("efConstruction 1001", word(20, 1001)),
        ("efConstruction u32::MAX", word(20, u32::MAX)),
        ("metric 1", Box::new(|b: &mut Vec<u8>| b[10] = 1)),
        ("metric 2", Box::new(|b: &mut Vec<u8>| b[10] = 2)),
        ("metric 255", Box::new(|b: &mut Vec<u8>| b[10] = 255)),
        ("seed", word(24, 77)),
        ("dim 4096", word(12, 4096)),
        ("dim 4097", word(12, 4097)),
        ("dim 0", word(12, 0)),
        ("generation GEN_MAX", word(28, 0xFFFF_FFFE)),
        ("generation u32::MAX", word(28, u32::MAX)),
        ("count rows+1", word(32, ROWS as u32 + 1)),
        ("count NODES_MAX", word(32, 4_194_304)),
        ("count NODES_MAX+1", word(32, 4_194_305)),
        ("count u32::MAX", word(32, u32::MAX)),
        ("live count+1", word(36, count + 1)),
        ("live u32::MAX", word(36, u32::MAX)),
        ("max_level 16", word(44, 16)),
        ("max_level 17", word(44, 17)),
        ("max_level u32::MAX", word(44, u32::MAX)),
        ("words u32::MAX", word(48, u32::MAX)),
        ("words 0", word(48, 0)),
        ("entry u32::MAX", word(40, u32::MAX)),
        ("entry count", word(40, count)),
        (
            "largest duplicate group above the node count",
            word(52, ROWS as u32 + 1),
        ),
        ("largest duplicate group u32::MAX", word(52, u32::MAX)),
        (
            "largest near-duplicate group above the node count",
            word(56, ROWS as u32 + 1),
        ),
        ("largest near-duplicate group u32::MAX", word(56, u32::MAX)),
        (
            "largest near-duplicate group below the exact group",
            word(56, 0),
        ),
        ("ns length 0", Box::new(|b: &mut Vec<u8>| b[11] = 0)),
        ("ns length 65", Box::new(|b: &mut Vec<u8>| b[11] = 65)),
        (
            "node level 17",
            Box::new(move |b: &mut Vec<u8>| b[table + 4] = 17),
        ),
        (
            "node level 255",
            Box::new(move |b: &mut Vec<u8>| b[table + 4] = 255),
        ),
    ];
    for (name, forge) in cases {
        let mut b = good.clone();
        forge(&mut b);
        recrc(&mut b);
        let (r, largest, total) = load_probed(&b, ROWS as u32, &STORED);
        assert!(r.is_err(), "[{name}] a forged header was accepted");
        assert!(
            largest <= REFUSAL_BUDGET && total <= 4 * REFUSAL_BUDGET,
            "[{name}] the refusal allocated {largest} bytes at once ({total} in all): a header field sized an allocation"
        );
    }
}

#[test]
fn a_truncated_or_extended_forged_million_node_file_allocates_nothing_either() {
    let count = 1_000_000u32;
    let forged = Params {
        m: 64,
        ef_construction: 64,
        ..STORED
    };
    let b = forged_big(count, &forged, DIM as u32, GEN);
    for cut in [0usize, 10, 56, 60, 100, b.len() / 2, b.len() - 1] {
        let (r, largest, _) = load_probed(&b[..cut], count, &STORED);
        assert!(r.is_err());
        assert!(
            largest <= REFUSAL_BUDGET,
            "cut at {cut}: {largest} bytes at once"
        );
    }
}

/// A file with the first format's magic is an older format: refused with `Version` (the host rebuilds the
/// graph from the stored vectors), whatever else it says, and without allocating.
#[test]
fn a_file_with_the_first_formats_magic_is_refused_as_an_older_version_without_allocating() {
    let mut b = small();
    b[0..8].copy_from_slice(b"LDHNSW01");
    b[8..10].copy_from_slice(&1u16.to_le_bytes());
    recrc(&mut b);
    let (r, largest, _) = load_probed(&b, ROWS as u32, &STORED);
    assert_eq!(r.err(), Some(Err::Version));
    assert!(largest <= REFUSAL_BUDGET);
    // the magic alone decides, even with a version field that claims the current one
    let mut c = small();
    c[0..8].copy_from_slice(b"LDHNSW01");
    recrc(&mut c);
    assert_eq!(
        load_probed(&c, ROWS as u32, &STORED).0.err(),
        Some(Err::Version)
    );
    // a magic that is neither is `Magic`
    let mut d = small();
    d[0] = b'X';
    recrc(&mut d);
    assert_eq!(
        load_probed(&d, ROWS as u32, &STORED).0.err(),
        Some(Err::Magic)
    );
}
