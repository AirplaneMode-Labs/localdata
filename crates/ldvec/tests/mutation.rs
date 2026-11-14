//! D4-02: SplitMix64 mutation harness over the golden head and meta (200,000 iterations in total).
//! Properties: no panic; anything accepted is canonical (a head re-serialises to the identical bytes,
//! a meta blob agrees with an independent naive validator); parsing is deterministic.
mod common;

use common::*;
use ldvec::format::*;

const ITERATIONS: u64 = 200_000;

fn fixture(path: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tiny")
        .join(path);
    std::fs::read(&p).unwrap_or_else(|e| {
        panic!("golden fixture {} is missing ({e}); it is written by the TypeScript writer: npm run fixture:tiny", p.display())
    })
}

fn mutate(r: &mut SplitMix64, src: &[u8]) -> Vec<u8> {
    let mut v = src.to_vec();
    let rounds = 1 + r.below(4);
    for _ in 0..rounds {
        match r.below(9) {
            0 => {
                if !v.is_empty() {
                    let i = r.below(v.len() as u64) as usize;
                    v[i] ^= 1 << r.below(8);
                }
            }
            1 => {
                if !v.is_empty() {
                    let i = r.below(v.len() as u64) as usize;
                    v[i] = r.next() as u8;
                }
            }
            2 => {
                let cut = r.below(v.len() as u64 + 1) as usize;
                v.truncate(cut);
            }
            3 => {
                for _ in 0..r.below(70) {
                    v.push(r.next() as u8);
                }
            }
            4 | 5 => {
                if v.len() >= 4 {
                    let i = r.below(v.len() as u64 - 3) as usize;
                    let interesting = [
                        0u32,
                        1,
                        2,
                        3,
                        4,
                        5,
                        8,
                        0x7FFF_FFFF,
                        0x8000_0000,
                        0xFFFF_FFFF,
                        0xFFFF_FFFE,
                        4096,
                        4097,
                        131_072,
                        131_073,
                        4_194_304,
                        4_194_305,
                        v.len() as u32,
                        v.len() as u32 + 1,
                    ];
                    let x = interesting[r.below(interesting.len() as u64) as usize];
                    put_u32(&mut v, i, x);
                }
            }
            6 => {
                if v.len() >= 2 {
                    let a = r.below(v.len() as u64) as usize;
                    let b = r.below(v.len() as u64) as usize;
                    v.swap(a, b);
                }
            }
            7 => {
                if !v.is_empty() {
                    let a = r.below(v.len() as u64) as usize;
                    let n = r.below((v.len() - a) as u64 + 1) as usize;
                    let chunk: Vec<u8> = v[a..a + n].to_vec();
                    let at = r.below(v.len() as u64 + 1) as usize;
                    for (j, b) in chunk.into_iter().enumerate() {
                        v.insert(at + j, b);
                    }
                    if v.len() > 700_000 {
                        v.truncate(700_000);
                    }
                }
            }
            _ => {
                // fix the CRCs after a field edit so the structural validators are reached
                if v.len() >= 68 {
                    refresh_crcs(&mut v);
                }
            }
        }
    }
    v
}

/// An independent re-implementation of the META validator (differential oracle).
fn naive_meta(m: &[u8], rows: u32, kbl: u32, vbl: u32) -> Result<(), Err> {
    let rows64 = rows as u64;
    let expect = rows64 * 4 + (rows64 + 1) * 8 + rows64 * 4 + kbl as u64;
    if m.len() as u64 != expect {
        return Err(Err::Length);
    }
    let r = rows as usize;
    let rd = |o: usize| u32::from_le_bytes(m[o..o + 4].try_into().unwrap());
    let ko = r * 4;
    let vo = ko + (r + 1) * 4;
    let kb = vo + (r + 1) * 4 + r * 4;
    if rd(ko) != 0 || rd(ko + r * 4) != kbl {
        return Err(Err::Offsets);
    }
    for i in 0..r {
        if rd(ko + i * 4) > rd(ko + (i + 1) * 4) {
            return Err(Err::Offsets);
        }
    }
    for i in 0..r {
        let (a, b) = (rd(ko + i * 4) as usize, rd(ko + (i + 1) * 4) as usize);
        if b - a < 1 || b - a > 4096 {
            return Err(Err::KeyLength);
        }
        if std::str::from_utf8(&m[kb + a..kb + b]).is_err() {
            return Err(Err::Utf8);
        }
    }
    if rd(vo) != 0 || rd(vo + r * 4) != vbl {
        return Err(Err::Offsets);
    }
    for i in 0..r {
        let (a, b) = (rd(vo + i * 4), rd(vo + (i + 1) * 4));
        if a > b || b - a > VALUE_MAX {
            return Err(Err::Offsets);
        }
    }
    Ok(())
}

#[test]
fn mutated_heads_never_panic_and_anything_accepted_is_canonical() {
    let (_, built) = sample_head();
    let golden = fixture("head");
    let corpora = [built, golden];
    let mut accepted = 0u64;
    let mut r = SplitMix64(0xD4D4_0001);
    for i in 0..ITERATIONS / 2 {
        let src = &corpora[(i % 2) as usize];
        let m = mutate(&mut r, src);
        let first = parse_head(&m);
        let second = parse_head(&m);
        assert_eq!(first, second, "parse is deterministic");
        if let Ok(h) = first {
            accepted += 1;
            let tomb = &m[h.tomb_off..m.len() - 4];
            let mut canon = h.clone();
            canon.vec_bytes = 0;
            canon.meta_bytes = 0;
            canon.tomb_off = 0;
            assert_eq!(
                head_bytes(&canon, tomb),
                m,
                "an accepted head re-serialises to identical bytes"
            );
            // revalidation: identical fields
            assert_eq!(parse_head(&head_bytes(&canon, tomb)), Ok(h));
        }
    }
    // The unmutated-ish inputs (e.g. no-op mutations) must be accepted sometimes, or the test proves nothing.
    assert!(
        accepted > 0,
        "no mutation was ever accepted; the harness is not reaching the accept path"
    );
}

#[test]
fn mutated_meta_never_panics_and_agrees_with_the_naive_validator() {
    let (built, rows, kbl, vbl) = sample_meta();
    let golden = fixture("meta-0/00000");
    let golden_head = parse_head(&fixture("head")).unwrap();
    let s = &golden_head.segs[0];
    let corpora = [
        (built, rows, kbl, vbl),
        (golden, s.rows, s.key_bytes_len, s.value_bytes_len),
    ];
    let mut accepted = 0u64;
    let mut r = SplitMix64(0xD4D4_0002);
    for i in 0..ITERATIONS / 2 {
        let (src, rows, kbl, vbl) = &corpora[(i % 2) as usize];
        let mut m = mutate(&mut r, src);
        // vary the declared counts too, including lies
        let (mut rr, mut kk, mut vv) = (*rows, *kbl, *vbl);
        match r.below(6) {
            0 => rr = r.next() as u32,
            1 => kk = r.next() as u32,
            2 => vv = r.next() as u32,
            3 => rr = rr.wrapping_add(1),
            _ => {}
        }
        if r.below(10) == 0 {
            m.truncate(r.below(m.len() as u64 + 1) as usize);
        }
        let got = check_meta(&m, rr, kk, vv);
        assert_eq!(
            got,
            naive_meta(&m, rr, kk, vv),
            "differential check (rows {rr}, kbl {kk}, vbl {vv})"
        );
        assert_eq!(got, check_meta(&m, rr, kk, vv));
        if got.is_ok() {
            accepted += 1;
        }
    }
    assert!(accepted > 0, "no mutation was ever accepted");
}
