//! Test-only builders: an independent serialiser for HEAD records and META blobs, a bitwise CRC-32C
//! reference, SplitMix64 and a naive f32 reference for the scan. None of this shares code with the
//! library under test.
#![allow(dead_code)]

use ldvec::format::{Head, Seg};

pub struct SplitMix64(pub u64);
impl SplitMix64 {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Bitwise CRC-32C (Castagnoli, reflected 0x82F63B78), the reference for the table version.
pub fn crc32c_bitwise(prev: u32, data: &[u8]) -> u32 {
    let mut crc = !prev;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0x82F6_3B78
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

pub fn put_u32(v: &mut [u8], off: usize, x: u32) {
    v[off..off + 4].copy_from_slice(&x.to_le_bytes());
}
pub fn get_u32(v: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(v[off..off + 4].try_into().unwrap())
}

/// Serialises a HEAD record from fields and a tombstone bitset (`tomb` has ceil(total_rows/8) bytes).
pub fn head_bytes(h: &Head, tomb: &[u8]) -> Vec<u8> {
    let mut v = vec![0u8; 64 + 32 * h.segs.len() + tomb.len() + 4];
    v[0..4].copy_from_slice(b"LDX1");
    v[4..6].copy_from_slice(&1u16.to_le_bytes());
    v[6..8].copy_from_slice(&1u16.to_le_bytes());
    put_u32(&mut v, 8, h.dim);
    put_u32(&mut v, 12, h.seg_count);
    put_u32(&mut v, 16, h.total_rows);
    put_u32(&mut v, 20, h.live_rows);
    put_u32(&mut v, 24, h.next_seg_id);
    put_u32(&mut v, 28, h.generation);
    let hc = crc32c_bitwise(0, &v[0..60]);
    put_u32(&mut v, 60, hc);
    for (i, s) in h.segs.iter().enumerate() {
        let o = 64 + 32 * i;
        put_u32(&mut v, o, s.seg_id);
        put_u32(&mut v, o + 4, s.rows);
        put_u32(&mut v, o + 8, s.first_row);
        put_u32(&mut v, o + 12, s.key_bytes_len);
        put_u32(&mut v, o + 16, s.value_bytes_len);
        put_u32(&mut v, o + 20, s.vec_crc);
        put_u32(&mut v, o + 24, s.meta_crc);
        put_u32(&mut v, o + 28, s.flags);
    }
    let to = 64 + 32 * h.segs.len();
    v[to..to + tomb.len()].copy_from_slice(tomb);
    let end = v.len() - 4;
    let bc = crc32c_bitwise(0, &v[64..end]);
    put_u32(&mut v, end, bc);
    v
}

/// Recomputes both CRCs of an (edited) HEAD record in place, so a structural lie survives the CRC gate.
pub fn refresh_crcs(v: &mut [u8]) {
    let hc = crc32c_bitwise(0, &v[0..60]);
    put_u32(v, 60, hc);
    let end = v.len() - 4;
    let bc = crc32c_bitwise(0, &v[64..end]);
    put_u32(v, end, bc);
}

pub fn simple_seg(seg_id: u32, rows: u32, first_row: u32, kbl: u32, vbl: u32) -> Seg {
    Seg {
        seg_id,
        rows,
        first_row,
        key_bytes_len: kbl,
        value_bytes_len: vbl,
        vec_crc: 0x1111_1111,
        meta_crc: 0x2222_2222,
        flags: 0,
    }
}

/// A valid head: two segments (3 and 2 rows), row 1 and row 4 tombstoned.
pub fn sample_head() -> (Head, Vec<u8>) {
    let segs = vec![simple_seg(0, 3, 0, 6, 30), simple_seg(2, 2, 3, 4, 0)];
    let tomb = vec![0b0001_0010u8];
    let h = Head {
        dim: 4,
        seg_count: 2,
        total_rows: 5,
        live_rows: 3,
        next_seg_id: 3,
        generation: 7,
        segs,
        vec_bytes: 0,
        meta_bytes: 0,
        tomb_off: 0,
    };
    let bytes = head_bytes(&h, &tomb);
    (h, bytes)
}

pub struct MetaSpec<'a> {
    pub keys: &'a [&'a [u8]],
    pub value_sizes: &'a [u32],
}

/// Serialises a META blob: invNorms f32[rows] | keyOffsets u32[rows+1] | valueOffsets u32[rows+1] |
/// valueCrcs u32[rows] | keyBytes. Returns (blob, key_bytes_len, value_bytes_len).
pub fn meta_bytes(spec: &MetaSpec) -> (Vec<u8>, u32, u32) {
    let rows = spec.keys.len();
    let mut out = Vec::new();
    for i in 0..rows {
        out.extend_from_slice(&(1.0f32 / (i as f32 + 1.0)).to_le_bytes());
    }
    let mut off = 0u32;
    out.extend_from_slice(&0u32.to_le_bytes());
    for k in spec.keys {
        off += k.len() as u32;
        out.extend_from_slice(&off.to_le_bytes());
    }
    let kbl = off;
    let mut voff = 0u32;
    out.extend_from_slice(&0u32.to_le_bytes());
    for s in spec.value_sizes {
        voff += *s;
        out.extend_from_slice(&voff.to_le_bytes());
    }
    for i in 0..rows {
        out.extend_from_slice(&(0xC0DE_0000u32 + i as u32).to_le_bytes());
    }
    for k in spec.keys {
        out.extend_from_slice(k);
    }
    (out, kbl, voff)
}

pub fn sample_meta() -> (Vec<u8>, u32, u32, u32) {
    let keys: [&[u8]; 3] = [b"alpha", "b\u{e9}".as_bytes(), "\u{1F30D}x".as_bytes()];
    let sizes = [8u32, 0, 22];
    let (m, kbl, vbl) = meta_bytes(&MetaSpec {
        keys: &keys,
        value_sizes: &sizes,
    });
    (m, 3, kbl, vbl)
}

/// Naive f32 reference with explicit rounding after every operation (no library code).
pub fn ref_dot4(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0.0f32; 4];
    for i in 0..a.len() {
        let p: f32 = a[i] * b[i];
        let s: f32 = acc[i % 4] + p;
        acc[i % 4] = s;
    }
    let l: f32 = acc[0] + acc[1];
    let r: f32 = acc[2] + acc[3];
    l + r
}

pub fn ref_inv_norm(v: &[f32]) -> f32 {
    let sd = ref_dot4(v, v);
    if sd == 0.0 {
        0.0
    } else {
        1.0f32 / sd.sqrt()
    }
}

pub fn ref_score(row: &[f32], row_inv: f32, q: &[f32], q_inv: f32, metric: u32) -> f32 {
    let d = ref_dot4(row, q);
    let s = if metric == 1 {
        d
    } else {
        (d * row_inv) * q_inv
    };
    if s == 0.0 {
        0.0
    } else {
        s
    }
}

pub fn rand_f32(r: &mut SplitMix64) -> f32 {
    ((r.next() >> 40) as f32 / 16_777_216.0) * 2.0 - 1.0
}
