//! On-disk format v1 validation (normative description: docs/vector-index-format.md).
//!
//! Everything that arrives from storage is untrusted. Lengths and offsets are computed in `u64`
//! with checked arithmetic (usize is 32 bits on wasm32), counts are range-checked before they size
//! anything, and the exact record length is verified before the segment table is read, so no value
//! in a corrupt record can drive an allocation or an out-of-range read.

use crate::crc32c;

pub const MAGIC: [u8; 4] = *b"LDX1";
pub const FORMAT_VERSION: u16 = 1;
pub const DTYPE_F32: u16 = 1;
pub const HEAD_FIXED: usize = 64;
pub const SEG_ENTRY: usize = 32;
pub const DIM_MAX: u32 = 4096;
pub const SEG_MAX: u32 = 4096;
pub const ROWS_MAX: u32 = 4_194_304;
pub const SEG_ROWS_MAX: u32 = 131_072;
pub const KEY_MAX: u32 = 4096;
pub const VALUE_MAX: u32 = 1 << 20;
pub const GEN_MAX: u32 = 0xFFFF_FFFE;
/// A HEAD record longer than this is refused before any parsing.
pub const HEAD_MAX: u64 = 64 + 32 * 4096 + 524_288 + 4;

/// Error codes shared with the TypeScript layer (the negative values are the FFI return values).
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Err {
    Magic = -1,
    Version = -2,
    Dtype = -3,
    Dim = -4,
    Length = -5,
    Crc = -6,
    Reserved = -7,
    Count = -8,
    SegmentOrder = -9,
    TombstonePadding = -10,
    Offsets = -11,
    Utf8 = -12,
    KeyLength = -13,
    TooLarge = -14,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seg {
    pub seg_id: u32,
    pub rows: u32,
    pub first_row: u32,
    pub key_bytes_len: u32,
    pub value_bytes_len: u32,
    pub vec_crc: u32,
    pub meta_crc: u32,
    pub flags: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub dim: u32,
    pub seg_count: u32,
    pub total_rows: u32,
    pub live_rows: u32,
    pub next_seg_id: u32,
    pub generation: u32,
    pub segs: Vec<Seg>,
    /// Sum of rows * dim * 4 over the segments.
    pub vec_bytes: u64,
    /// Sum of rows * 16 + 8 + keyBytesLen over the segments (the META blob lengths).
    pub meta_bytes: u64,
    /// Byte offset of the tombstone bitset inside the record.
    pub tomb_off: usize,
}

fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

fn u16_at(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

/// Parses and fully validates a HEAD record.
///
/// Order of checks (the first failure is the reported code): size cap, minimum length, magic,
/// header CRC, version, dtype, dim, counts, reserved bytes, exact length, body CRC, then the segment
/// table and the tombstone bitset.
pub fn parse_head(b: &[u8]) -> Result<Head, Err> {
    let len = b.len() as u64;
    if len > HEAD_MAX {
        return Err(Err::TooLarge);
    }
    if len < (HEAD_FIXED + 4) as u64 {
        return Err(Err::Length);
    }
    if b[0..4] != MAGIC {
        return Err(Err::Magic);
    }
    if u32_at(b, 60) != crc32c::update(0, &b[0..60]) {
        return Err(Err::Crc);
    }
    if u16_at(b, 4) != FORMAT_VERSION {
        return Err(Err::Version);
    }
    if u16_at(b, 6) != DTYPE_F32 {
        return Err(Err::Dtype);
    }
    let dim = u32_at(b, 8);
    if dim == 0 || dim > DIM_MAX {
        return Err(Err::Dim);
    }
    let seg_count = u32_at(b, 12);
    let total_rows = u32_at(b, 16);
    let live_rows = u32_at(b, 20);
    let next_seg_id = u32_at(b, 24);
    let generation = u32_at(b, 28);
    if seg_count > SEG_MAX
        || total_rows > ROWS_MAX
        || live_rows > total_rows
        || generation == 0
        || generation > GEN_MAX
    {
        return Err(Err::Count);
    }
    if b[32..60].iter().any(|&x| x != 0) {
        return Err(Err::Reserved);
    }
    let tomb_len = (total_rows as u64).div_ceil(8);
    let expected = HEAD_FIXED as u64 + SEG_ENTRY as u64 * seg_count as u64 + tomb_len + 4;
    if expected != len {
        return Err(Err::Length);
    }
    let end = b.len() - 4;
    if u32_at(b, end) != crc32c::update(0, &b[HEAD_FIXED..end]) {
        return Err(Err::Crc);
    }

    let mut segs = Vec::with_capacity(seg_count as usize);
    let mut running_rows: u64 = 0;
    let mut vec_bytes: u64 = 0;
    let mut meta_bytes: u64 = 0;
    let mut prev_id: Option<u32> = None;
    for i in 0..seg_count as usize {
        let o = HEAD_FIXED + SEG_ENTRY * i;
        let s = Seg {
            seg_id: u32_at(b, o),
            rows: u32_at(b, o + 4),
            first_row: u32_at(b, o + 8),
            key_bytes_len: u32_at(b, o + 12),
            value_bytes_len: u32_at(b, o + 16),
            vec_crc: u32_at(b, o + 20),
            meta_crc: u32_at(b, o + 24),
            flags: u32_at(b, o + 28),
        };
        if s.flags != 0 {
            return Err(Err::Reserved);
        }
        if s.rows == 0 || s.rows > SEG_ROWS_MAX {
            return Err(Err::Count);
        }
        if let Some(p) = prev_id {
            if s.seg_id <= p {
                return Err(Err::SegmentOrder);
            }
        }
        if s.seg_id >= next_seg_id {
            return Err(Err::SegmentOrder);
        }
        if s.first_row as u64 != running_rows {
            return Err(Err::SegmentOrder);
        }
        if s.key_bytes_len as u64 > s.rows as u64 * KEY_MAX as u64
            || s.value_bytes_len as u64 > s.rows as u64 * VALUE_MAX as u64
        {
            return Err(Err::Count);
        }
        prev_id = Some(s.seg_id);
        running_rows += s.rows as u64;
        vec_bytes += s.rows as u64 * dim as u64 * 4;
        meta_bytes += s.rows as u64 * 16 + 8 + s.key_bytes_len as u64;
        segs.push(s);
    }
    if running_rows != total_rows as u64 {
        return Err(Err::Count);
    }

    let tomb_off = HEAD_FIXED + SEG_ENTRY * seg_count as usize;
    let tomb = &b[tomb_off..tomb_off + tomb_len as usize];
    let rem = total_rows % 8;
    if rem != 0 {
        let last = tomb[tomb.len() - 1];
        if last >> rem != 0 {
            return Err(Err::TombstonePadding);
        }
    }
    let popcount: u64 = tomb.iter().map(|x| x.count_ones() as u64).sum();
    if live_rows as u64 != total_rows as u64 - popcount {
        return Err(Err::Count);
    }

    Ok(Head {
        dim,
        seg_count,
        total_rows,
        live_rows,
        next_seg_id,
        generation,
        segs,
        vec_bytes,
        meta_bytes,
        tomb_off,
    })
}

/// Validates one segment's META blob:
/// `invNorms f32[rows] | keyOffsets u32[rows+1] | valueOffsets u32[rows+1] | valueCrcs u32[rows] | keyBytes`.
///
/// The checksum is the caller's job (it is compared with the HEAD entry before this runs); this
/// checks the structure that the checksum cannot vouch for when a writer is buggy or hostile:
/// exact length, offset tables, key lengths, UTF-8 and the value size cap.
pub fn check_meta(
    m: &[u8],
    rows: u32,
    key_bytes_len: u32,
    value_bytes_len: u32,
) -> Result<(), Err> {
    let rows64 = rows as u64;
    let expect = rows64 * 4 + (rows64 + 1) * 8 + rows64 * 4 + key_bytes_len as u64;
    if m.len() as u64 != expect {
        return Err(Err::Length);
    }
    // The blob length is known to equal `expect`, so every offset below is in range.
    let r = rows as usize;
    let ko = r * 4;
    let vo = ko + (r + 1) * 4;
    let kb = vo + (r + 1) * 4 + r * 4;
    if u32_at(m, ko) != 0 || u32_at(m, ko + r * 4) != key_bytes_len {
        return Err(Err::Offsets);
    }
    let mut prev = 0u32;
    for i in 1..=r {
        let o = u32_at(m, ko + i * 4);
        if o < prev {
            return Err(Err::Offsets);
        }
        prev = o;
    }
    let mut a = 0usize;
    for i in 1..=r {
        let b = u32_at(m, ko + i * 4) as usize;
        let n = b - a;
        if n == 0 || n > KEY_MAX as usize {
            return Err(Err::KeyLength);
        }
        if core::str::from_utf8(&m[kb + a..kb + b]).is_err() {
            return Err(Err::Utf8);
        }
        a = b;
    }
    if u32_at(m, vo) != 0 || u32_at(m, vo + r * 4) != value_bytes_len {
        return Err(Err::Offsets);
    }
    let mut prev = 0u32;
    for i in 1..=r {
        let o = u32_at(m, vo + i * 4);
        if o < prev || o - prev > VALUE_MAX {
            return Err(Err::Offsets);
        }
        prev = o;
    }
    Ok(())
}
