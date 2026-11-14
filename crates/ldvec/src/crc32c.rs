//! CRC-32C (Castagnoli), reflected polynomial 0x82F63B78, with const slicing-by-8 tables.
//!
//! `update(prev, data)` continues a checksum: `prev` is the value an earlier call returned (0 for
//! the start), so `update(update(0, a), b) == update(0, [a, b].concat())`. `update(0, b"123456789")`
//! is 0xE3069283.

const POLY: u32 = 0x82F6_3B78;

const fn make_tables() -> [[u32; 256]; 8] {
    let mut t = [[0u32; 256]; 8];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ POLY } else { c >> 1 };
            k += 1;
        }
        t[0][i] = c;
        i += 1;
    }
    let mut n = 0;
    while n < 256 {
        let mut c = t[0][n];
        let mut s = 1;
        while s < 8 {
            c = t[0][(c & 0xFF) as usize] ^ (c >> 8);
            t[s][n] = c;
            s += 1;
        }
        n += 1;
    }
    t
}

static TABLES: [[u32; 256]; 8] = make_tables();

/// Continues a CRC-32C over `data`. `prev` is 0 for a fresh checksum.
pub fn update(prev: u32, data: &[u8]) -> u32 {
    let t = &TABLES;
    let mut crc = !prev;
    let (chunks, rest) = data.as_chunks::<8>();
    for c in chunks {
        let lo = u32::from_le_bytes([c[0], c[1], c[2], c[3]]) ^ crc;
        let hi = u32::from_le_bytes([c[4], c[5], c[6], c[7]]);
        crc = t[7][(lo & 0xFF) as usize]
            ^ t[6][((lo >> 8) & 0xFF) as usize]
            ^ t[5][((lo >> 16) & 0xFF) as usize]
            ^ t[4][(lo >> 24) as usize]
            ^ t[3][(hi & 0xFF) as usize]
            ^ t[2][((hi >> 8) & 0xFF) as usize]
            ^ t[1][((hi >> 16) & 0xFF) as usize]
            ^ t[0][(hi >> 24) as usize];
    }
    for &b in rest {
        crc = t[0][((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}
