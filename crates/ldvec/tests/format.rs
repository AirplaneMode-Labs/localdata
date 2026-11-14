//! D4-02: CRC-32C and the on-disk format v1 (docs/vector-index-format.md). One test per invariant,
//! each with the exact error code the TypeScript layer reports as details.reason.
mod common;

use common::*;
use ldvec::crc32c;
use ldvec::format::*;

// ---- CRC-32C ------------------------------------------------------------------------------------

#[test]
fn crc32c_check_value() {
    assert_eq!(crc32c::update(0, b"123456789"), 0xE306_9283);
}

#[test]
fn crc32c_empty_is_zero_and_prev_passes_through() {
    assert_eq!(crc32c::update(0, b""), 0);
    assert_eq!(crc32c::update(0xDEAD_BEEF, b""), 0xDEAD_BEEF);
}

#[test]
fn crc32c_rfc3720_vectors() {
    // RFC 3720 appendix B.4 (iSCSI), values as little-endian u32 of the listed bytes.
    assert_eq!(crc32c::update(0, &[0u8; 32]), 0x8A91_36AA);
    assert_eq!(crc32c::update(0, &[0xFFu8; 32]), 0x62A8_AB43);
    let up: Vec<u8> = (0u8..32).collect();
    assert_eq!(crc32c::update(0, &up), 0x46DD_794E);
    let down: Vec<u8> = (0u8..32).rev().collect();
    assert_eq!(crc32c::update(0, &down), 0x113F_DB5C);
}

#[test]
fn crc32c_matches_the_bitwise_reference_on_random_inputs_of_every_small_length() {
    let mut r = SplitMix64(1);
    for len in 0..300usize {
        let data: Vec<u8> = (0..len).map(|_| r.next() as u8).collect();
        assert_eq!(
            crc32c::update(0, &data),
            crc32c_bitwise(0, &data),
            "len {len}"
        );
    }
}

#[test]
fn crc32c_is_incremental_over_any_split() {
    let mut r = SplitMix64(2);
    let data: Vec<u8> = (0..4099).map(|_| r.next() as u8).collect();
    let whole = crc32c::update(0, &data);
    for _ in 0..200 {
        let cut = r.below(data.len() as u64 + 1) as usize;
        let cut2 = cut + r.below((data.len() - cut) as u64 + 1) as usize;
        let c = crc32c::update(
            crc32c::update(crc32c::update(0, &data[..cut]), &data[cut..cut2]),
            &data[cut2..],
        );
        assert_eq!(c, whole);
    }
}

#[test]
fn crc32c_handles_unaligned_starts() {
    let mut r = SplitMix64(3);
    let data: Vec<u8> = (0..1000).map(|_| r.next() as u8).collect();
    for off in 0..17 {
        assert_eq!(
            crc32c::update(0, &data[off..]),
            crc32c_bitwise(0, &data[off..]),
            "offset {off}"
        );
    }
}

// ---- HEAD ---------------------------------------------------------------------------------------

#[test]
fn a_valid_head_parses_to_its_fields() {
    let (h, bytes) = sample_head();
    let p = parse_head(&bytes).unwrap();
    assert_eq!(p.dim, 4);
    assert_eq!(p.seg_count, 2);
    assert_eq!(p.total_rows, 5);
    assert_eq!(p.live_rows, 3);
    assert_eq!(p.next_seg_id, 3);
    assert_eq!(p.generation, 7);
    assert_eq!(p.segs, h.segs);
    assert_eq!(p.tomb_off, 64 + 32 * 2);
    // vec bytes: 5 rows * 4 dim * 4; meta: per segment rows*16 + 8 + key bytes
    assert_eq!(p.vec_bytes, 5 * 4 * 4);
    assert_eq!(p.meta_bytes, (3 * 16 + 8 + 6) + (2 * 16 + 8 + 4));
}

#[test]
fn an_empty_index_head_is_valid() {
    let h = Head {
        dim: 3,
        seg_count: 0,
        total_rows: 0,
        live_rows: 0,
        next_seg_id: 0,
        generation: 1,
        segs: vec![],
        vec_bytes: 0,
        meta_bytes: 0,
        tomb_off: 0,
    };
    let b = head_bytes(&h, &[]);
    assert_eq!(b.len(), 68);
    assert_eq!(parse_head(&b).unwrap().total_rows, 0);
}

fn expect(bytes: &[u8], code: Err) {
    assert_eq!(parse_head(bytes).map(|_| ()), Err(code));
}

fn edited(f: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let (_, mut b) = sample_head();
    f(&mut b);
    refresh_crcs(&mut b);
    b
}

#[test]
fn magic_is_checked_first() {
    let (_, mut b) = sample_head();
    b[0] = b'X';
    expect(&b, Err::Magic);
    expect(&[0u8; 100], Err::Magic);
}

#[test]
fn too_short_is_length() {
    expect(&[], Err::Length);
    expect(&b"LDX1"[..], Err::Length);
    let (_, b) = sample_head();
    expect(&b[..67], Err::Length);
}

#[test]
fn oversized_record_is_too_large_before_parsing() {
    // Even though the bytes are not a head at all, size decides first: no parse, no allocation.
    let big = vec![0xABu8; (HEAD_MAX as usize) + 1];
    expect(&big, Err::TooLarge);
    let ok_size = vec![0u8; HEAD_MAX as usize];
    expect(&ok_size, Err::Magic);
}

#[test]
fn a_flipped_header_bit_is_crc_not_a_field_error() {
    let (_, b) = sample_head();
    for byte in [4usize, 6, 8, 12, 16, 20, 24, 28, 40] {
        let mut c = b.clone();
        c[byte] ^= 0x01;
        expect(&c, Err::Crc);
    }
}

#[test]
fn a_flipped_body_bit_is_crc() {
    let (_, b) = sample_head();
    for byte in [64usize, 70, 64 + 32, 64 + 64, b.len() - 5, b.len() - 1] {
        let mut c = b.clone();
        c[byte] ^= 0x80;
        expect(&c, Err::Crc);
    }
}

#[test]
fn a_future_version_with_a_valid_crc_is_version() {
    expect(&edited(|b| b[4] = 2), Err::Version);
    expect(&edited(|b| b[5] = 1), Err::Version);
}

#[test]
fn another_dtype_is_dtype() {
    expect(&edited(|b| b[6] = 2), Err::Dtype);
    expect(&edited(|b| b[6] = 0), Err::Dtype);
}

#[test]
fn dim_outside_1_to_4096_is_dim() {
    expect(&edited(|b| put_u32(b, 8, 0)), Err::Dim);
    expect(&edited(|b| put_u32(b, 8, 4097)), Err::Dim);
    expect(&edited(|b| put_u32(b, 8, u32::MAX)), Err::Dim);
    assert!(parse_head(&edited(|b| put_u32(b, 8, 1))).is_ok());
    assert!(parse_head(&edited(|b| put_u32(b, 8, 4096))).is_ok());
}

#[test]
fn counts_out_of_range_are_count() {
    expect(&edited(|b| put_u32(b, 12, 4097)), Err::Count);
    expect(&edited(|b| put_u32(b, 12, u32::MAX)), Err::Count);
    expect(&edited(|b| put_u32(b, 16, 4_194_305)), Err::Count);
    expect(&edited(|b| put_u32(b, 16, u32::MAX)), Err::Count);
    expect(&edited(|b| put_u32(b, 20, 6)), Err::Count); // liveRows > totalRows
    expect(&edited(|b| put_u32(b, 28, 0)), Err::Count); // generation 0
    expect(&edited(|b| put_u32(b, 28, 0xFFFF_FFFF)), Err::Count);
    assert!(parse_head(&edited(|b| put_u32(b, 28, 0xFFFF_FFFE))).is_ok());
}

#[test]
fn lying_counts_never_cause_a_big_allocation_or_a_panic() {
    // segCount 4097 and rows u32::MAX with a tiny record: refused by range or exact length.
    expect(&edited(|b| put_u32(b, 12, 4097)), Err::Count);
    expect(&edited(|b| put_u32(b, 12, 4096)), Err::Length);
    expect(&edited(|b| put_u32(b, 16, 4_194_304)), Err::Length);
    expect(&edited(|b| put_u32(b, 64 + 4, u32::MAX)), Err::Count);
    expect(&edited(|b| put_u32(b, 64 + 12, u32::MAX - 3)), Err::Count);
    expect(&edited(|b| put_u32(b, 64 + 16, u32::MAX)), Err::Count);
}

#[test]
fn nonzero_reserved_bytes_are_reserved() {
    expect(&edited(|b| b[32] = 1), Err::Reserved);
    expect(&edited(|b| b[59] = 0x80), Err::Reserved);
    expect(&edited(|b| put_u32(b, 64 + 28, 1)), Err::Reserved); // segment flags
}

#[test]
fn exact_length_is_enforced_both_ways() {
    let (_, b) = sample_head();
    let mut longer = b.clone();
    longer.push(0);
    expect(&longer, Err::Length);
    let mut shorter = b.clone();
    shorter.pop();
    expect(&shorter, Err::Length);
    let mut one_less_byte_tomb = b.clone();
    one_less_byte_tomb.remove(64 + 64);
    expect(&one_less_byte_tomb, Err::Length);
}

#[test]
fn segment_rows_must_be_1_to_131072() {
    expect(&edited(|b| put_u32(b, 64 + 4, 0)), Err::Count);
    expect(&edited(|b| put_u32(b, 64 + 4, 131_073)), Err::Count);
}

#[test]
fn segment_ids_strictly_increase_and_stay_below_next_seg_id() {
    expect(&edited(|b| put_u32(b, 64 + 32, 0)), Err::SegmentOrder); // equal to previous
    expect(&edited(|b| put_u32(b, 64, 5)), Err::SegmentOrder); // first id above second
    expect(&edited(|b| put_u32(b, 64 + 32, 3)), Err::SegmentOrder); // == nextSegId
    expect(&edited(|b| put_u32(b, 24, 2)), Err::SegmentOrder); // nextSegId <= last id
}

#[test]
fn first_row_must_equal_the_running_row_count() {
    expect(&edited(|b| put_u32(b, 64 + 8, 1)), Err::SegmentOrder);
    expect(&edited(|b| put_u32(b, 64 + 32 + 8, 2)), Err::SegmentOrder);
}

#[test]
fn segment_rows_must_sum_to_total_rows() {
    // total 5 -> 4 with a matching tombstone length and liveRows would still disagree with sum 5.
    let (mut h, _) = sample_head();
    h.total_rows = 4;
    h.live_rows = 2;
    let b = head_bytes(&h, &[0b0000_0010]);
    expect(&b, Err::Count);
}

#[test]
fn tombstone_padding_bits_must_be_zero() {
    expect(&edited(|b| b[64 + 64] |= 0x20), Err::TombstonePadding); // bit 5 >= totalRows 5
    expect(&edited(|b| b[64 + 64] |= 0x80), Err::TombstonePadding);
}

#[test]
fn live_rows_must_equal_total_minus_tombstones() {
    expect(&edited(|b| put_u32(b, 20, 4)), Err::Count);
    expect(&edited(|b| put_u32(b, 20, 0)), Err::Count);
    expect(&edited(|b| b[64 + 64] = 0b0001_0110), Err::Count); // an extra tombstone, liveRows unchanged
}

#[test]
fn huge_declared_sizes_are_computed_in_u64_not_wrapped() {
    // 32 segments of 131072 rows each at dim 4096: 4M rows * 4096 * 4 B = 68.7 GB, far above any
    // index the writer would create. parse_head reports the totals; the caller compares to the cap.
    let mut segs = Vec::new();
    for i in 0..32u32 {
        segs.push(simple_seg(i, 131_072, i * 131_072, 131_072 * 8, 0));
    }
    let total = 32 * 131_072u32;
    let h = Head {
        dim: 4096,
        seg_count: 32,
        total_rows: total,
        live_rows: total,
        next_seg_id: 32,
        generation: 1,
        segs,
        vec_bytes: 0,
        meta_bytes: 0,
        tomb_off: 0,
    };
    let tomb = vec![0u8; (total as usize).div_ceil(8)];
    let p = parse_head(&head_bytes(&h, &tomb)).unwrap();
    assert_eq!(p.vec_bytes, total as u64 * 4096 * 4);
    assert!(p.vec_bytes > u32::MAX as u64);
}

// ---- META ---------------------------------------------------------------------------------------

#[test]
fn a_valid_meta_blob_passes() {
    let (m, rows, kbl, vbl) = sample_meta();
    assert_eq!(check_meta(&m, rows, kbl, vbl), Ok(()));
}

#[test]
fn meta_length_must_match_the_formula() {
    let (m, rows, kbl, vbl) = sample_meta();
    assert_eq!(
        check_meta(&m[..m.len() - 1], rows, kbl, vbl),
        Err(Err::Length)
    );
    let mut longer = m.clone();
    longer.push(0);
    assert_eq!(check_meta(&longer, rows, kbl, vbl), Err(Err::Length));
    assert_eq!(check_meta(&m, rows, kbl + 1, vbl), Err(Err::Length));
    assert_eq!(check_meta(&m, rows + 1, kbl, vbl), Err(Err::Length));
    assert_eq!(check_meta(&[], 0, 0, 0), Err(Err::Length));
}

// Offsets of the sections for rows = 3: invNorms 0..12, keyOffsets 12..28, valueOffsets 28..44,
// valueCrcs 44..56, keyBytes 56..
const KEY_OFF: usize = 12;
const VAL_OFF: usize = 28;

#[test]
fn key_offsets_must_start_at_zero_end_at_the_length_and_not_decrease() {
    let (m, rows, kbl, vbl) = sample_meta();
    let mut a = m.clone();
    put_u32(&mut a, KEY_OFF, 1);
    assert_eq!(check_meta(&a, rows, kbl, vbl), Err(Err::Offsets));
    let mut b = m.clone();
    put_u32(&mut b, KEY_OFF + 12, kbl + 1);
    assert_eq!(check_meta(&b, rows, kbl, vbl), Err(Err::Offsets));
    let mut c = m.clone();
    put_u32(&mut c, KEY_OFF + 4, 100); // offsets[1] > offsets[2]
    assert_eq!(check_meta(&c, rows, kbl, vbl), Err(Err::Offsets));
    let mut d = m.clone();
    put_u32(&mut d, KEY_OFF + 4, u32::MAX);
    assert_eq!(check_meta(&d, rows, kbl, vbl), Err(Err::Offsets));
}

#[test]
fn an_empty_key_and_a_key_over_4096_bytes_are_key_length() {
    let (m, rows, kbl, vbl) = sample_meta();
    let mut a = m.clone();
    put_u32(&mut a, KEY_OFF + 4, 0); // key 0 has length 0
    assert_eq!(check_meta(&a, rows, kbl, vbl), Err(Err::KeyLength));
    let long = vec![b'a'; 4097];
    let keys: [&[u8]; 1] = [&long];
    let (m2, k2, v2) = meta_bytes(&MetaSpec {
        keys: &keys,
        value_sizes: &[0],
    });
    assert_eq!(check_meta(&m2, 1, k2, v2), Err(Err::KeyLength));
    let ok = vec![b'a'; 4096];
    let keys: [&[u8]; 1] = [&ok];
    let (m3, k3, v3) = meta_bytes(&MetaSpec {
        keys: &keys,
        value_sizes: &[0],
    });
    assert_eq!(check_meta(&m3, 1, k3, v3), Ok(()));
}

#[test]
fn invalid_utf8_keys_are_utf8() {
    for bad in [
        &[0xFFu8][..],
        &[0xC0, 0x80],
        &[0xE2, 0x82],
        &[0xED, 0xA0, 0x80],
        &[0xF4, 0x90, 0x80, 0x80],
    ] {
        let keys: [&[u8]; 1] = [bad];
        let (m, k, v) = meta_bytes(&MetaSpec {
            keys: &keys,
            value_sizes: &[0],
        });
        assert_eq!(check_meta(&m, 1, k, v), Err(Err::Utf8), "{bad:?}");
    }
}

#[test]
fn value_offsets_must_start_at_zero_end_at_the_length_not_decrease_and_stay_under_1_mib() {
    let (m, rows, kbl, vbl) = sample_meta();
    let mut a = m.clone();
    put_u32(&mut a, VAL_OFF, 1);
    assert_eq!(check_meta(&a, rows, kbl, vbl), Err(Err::Offsets));
    let mut b = m.clone();
    put_u32(&mut b, VAL_OFF + 12, vbl + 1);
    assert_eq!(check_meta(&b, rows, kbl, vbl), Err(Err::Offsets));
    let mut c = m.clone();
    put_u32(&mut c, VAL_OFF + 4, 100); // offsets[1] 100 > offsets[2] 8
    assert_eq!(check_meta(&c, rows, kbl, vbl), Err(Err::Offsets));
    let sizes = [VALUE_MAX + 1];
    let keys: [&[u8]; 1] = [b"k"];
    let (m2, k2, v2) = meta_bytes(&MetaSpec {
        keys: &keys,
        value_sizes: &sizes,
    });
    assert_eq!(check_meta(&m2, 1, k2, v2), Err(Err::Offsets));
    let sizes = [VALUE_MAX];
    let (m3, k3, v3) = meta_bytes(&MetaSpec {
        keys: &keys,
        value_sizes: &sizes,
    });
    assert_eq!(check_meta(&m3, 1, k3, v3), Ok(()));
}

#[test]
fn lying_meta_counts_do_not_wrap_or_allocate() {
    let (m, _, kbl, vbl) = sample_meta();
    assert_eq!(check_meta(&m, u32::MAX, kbl, vbl), Err(Err::Length));
    assert_eq!(check_meta(&m, 3, u32::MAX - 1, vbl), Err(Err::Length));
    assert_eq!(check_meta(&m, 3, kbl, u32::MAX), Err(Err::Offsets));
}

// ---- golden fixture written by the TypeScript writer (D4-03) ---------------------------------------

fn fixture(path: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tiny")
        .join(path);
    std::fs::read(&p).unwrap_or_else(|e| {
        panic!("golden fixture {} is missing ({e}); it is written by the TypeScript writer: npm run fixture:tiny", p.display())
    })
}

#[test]
fn the_golden_tiny_fixture_parses() {
    let head = fixture("head");
    let p = parse_head(&head).expect("golden head");
    assert_eq!(p.dim, 4);
    assert_eq!(p.total_rows, 3);
    assert_eq!(p.live_rows, 3);
    assert_eq!(p.seg_count, 1);
    assert_eq!(p.generation, 1);
    let s = &p.segs[0];
    let vec = fixture("vec-0/00000");
    assert_eq!(vec.len() as u64, 3 * 4 * 4);
    assert_eq!(crc32c::update(0, &vec), s.vec_crc);
    let meta = fixture("meta-0/00000");
    assert_eq!(crc32c::update(0, &meta), s.meta_crc);
    assert_eq!(
        check_meta(&meta, s.rows, s.key_bytes_len, s.value_bytes_len),
        Ok(())
    );
    let val = fixture("val-0/00000");
    assert_eq!(val.len() as u32, s.value_bytes_len);
}
