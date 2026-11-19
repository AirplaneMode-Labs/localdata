//! HNSW graph kernel (Malkov and Yashunin, with the diversity heuristic of Algorithm 4), built in-house
//! with zero dependencies (TD-65). Normative description of the bytes: `docs/hnsw-format.md`.
//!
//! * The graph is a **derived** index over rows the flat index owns. It holds no vectors and no keys:
//!   every distance is computed from vectors the caller lends through [`Rows`] (the flat index's resident
//!   blocks), with [`scan::score_one`], the same bit-exact function the flat scan uses. A hit's score is
//!   therefore the flat score for that row, bit for bit.
//! * A graph file is **untrusted input**: [`Graph::load`] validates every byte (lengths in `u64`, before
//!   any allocation sized by a declared count) and refuses what it cannot vouch for.
//! * Deterministic: levels come from an integer-only SplitMix64 rule keyed by `(seed, ordinal, m)`,
//!   candidates are ordered by `(score, node index)` with `f32::total_cmp`, there is no hash map, no
//!   thread and no floating-point transcendental function. The same `(rows, order, metric, m,
//!   efConstruction, seed)` gives the same bytes on every platform.
//! * No panics on any input: failures are [`Err`] values (negative codes at the FFI), and every
//!   allocation sized from a file field or a caller count goes through `try_reserve`, so memory
//!   exhaustion is the code [`Err::Memory`] instead of a WebAssembly trap.
use crate::{crc32c, format, scan};
use core::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;

pub const MAGIC: [u8; 8] = *b"LDHNSW01";
pub const FORMAT_VERSION: u16 = 1;
/// Bytes of the fixed header, before the namespace bytes.
pub const HEADER_LEN: usize = 56;
pub const NS_MAX: usize = 64;
pub const M_MIN: u32 = 4;
pub const M_MAX: u32 = 64;
pub const EF_CONSTRUCTION_MAX: u32 = 1000;
pub const EF_MAX: u32 = 1000;
pub const LEVEL_MAX: u32 = 16;
pub const NODES_MAX: u32 = format::ROWS_MAX;
/// The entry point of an empty graph.
pub const NONE: u32 = u32::MAX;
/// Upper layers in a file may not exceed `2 * nodes + SLACK`: a geometric level distribution stays far
/// below that, and the bound stops a forged file from sizing the fixed-stride upper-layer array.
const UPPER_LAYER_SLACK: u64 = 1024;

/// Error codes (the negative values are the FFI return values; -100 is the host's E_ARGS).
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Err {
    Magic = -20,
    Version = -21,
    Length = -22,
    Dim = -23,
    Namespace = -24,
    Generation = -25,
    Bounds = -26,
    Links = -27,
    Crc = -28,
    /// An allocation failed (the host reports `quota_exceeded`, reason `wasm_memory`).
    Memory = -30,
}

/// Build parameters. `metric` is 0 (cosine) or 1 (dot), as in [`scan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub metric: u32,
    pub m: u32,
    pub ef_construction: u32,
    pub seed: u32,
}

/// What the caller says the graph must match: the namespace's dimension, the flat HEAD's row count and
/// generation, and the namespace bytes.
pub struct Expect<'a> {
    pub dim: u32,
    pub rows: u32,
    pub generation: u32,
    pub ns: &'a [u8],
}

/// One search result: the row ordinal and its flat-scan score.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub ordinal: u32,
    pub score: f32,
}

fn reserve<T>(v: &mut Vec<T>, additional: usize) -> Result<(), Err> {
    v.try_reserve(additional).map_err(|_| Err::Memory)
}

fn vec_with<T>(n: usize) -> Result<Vec<T>, Err> {
    let mut v = Vec::new();
    reserve(&mut v, n)?;
    Ok(v)
}

// ---- the rows the graph indexes (lent by the caller) ----------------------------------------------

/// The flat index's vectors and inverse norms as the caller holds them: a list of blocks that together
/// cover rows `0..total`. Nothing is copied.
pub struct Rows<'a> {
    pub dim: usize,
    pub total: u32,
    first: Vec<u32>,
    cnt: Vec<u32>,
    vecs: Vec<&'a [f32]>,
    norms: Vec<&'a [f32]>,
}

impl<'a> Rows<'a> {
    pub fn new(dim: usize) -> Rows<'a> {
        Rows {
            dim,
            total: 0,
            first: Vec::new(),
            cnt: Vec::new(),
            vecs: Vec::new(),
            norms: Vec::new(),
        }
    }

    /// Appends a block of `rows` rows starting at global row `first_row`, which must equal the rows
    /// covered so far. `vec` holds `rows * dim` floats and `norms` holds `rows` inverse norms.
    pub fn push_block(
        &mut self,
        first_row: u32,
        rows: u32,
        vec: &'a [f32],
        norms: &'a [f32],
    ) -> Result<(), Err> {
        if rows == 0
            || first_row != self.total
            || vec.len() as u64 != rows as u64 * self.dim as u64
            || norms.len() as u64 != rows as u64
        {
            return Err(Err::Bounds);
        }
        let total = self.total.checked_add(rows).ok_or(Err::Bounds)?;
        reserve(&mut self.first, 1)?;
        reserve(&mut self.cnt, 1)?;
        reserve(&mut self.vecs, 1)?;
        reserve(&mut self.norms, 1)?;
        self.first.push(first_row);
        self.cnt.push(rows);
        self.vecs.push(vec);
        self.norms.push(norms);
        self.total = total;
        Ok(())
    }

    /// One block covering every row (`norms.len()` rows of `dim` floats).
    pub fn contiguous(vec: &'a [f32], norms: &'a [f32], dim: usize) -> Result<Rows<'a>, Err> {
        if dim == 0 {
            return Err(Err::Dim);
        }
        let mut r = Rows::new(dim);
        if !norms.is_empty() {
            let n = u32::try_from(norms.len()).map_err(|_| Err::Bounds)?;
            r.push_block(0, n, vec, norms)?;
        }
        Ok(r)
    }

    /// The vector and inverse norm of a row, or None when no block covers it.
    #[inline]
    fn get(&self, row: u32) -> Option<(&'a [f32], f32)> {
        let b = self.first.partition_point(|&f| f <= row).checked_sub(1)?;
        let local = (row - self.first[b]) as usize;
        if local >= self.cnt[b] as usize {
            return None;
        }
        let d = self.dim;
        let v = self.vecs[b].get(local * d..(local + 1) * d)?;
        Some((v, *self.norms[b].get(local)?))
    }
}

// ---- candidates -----------------------------------------------------------------------------------

/// A node and its score against the current query. `Ord`: greater is better (higher score, then the
/// lower node index), a total order, so no two candidates tie.
#[derive(Debug, Clone, Copy)]
struct Cand {
    score: f32,
    id: u32,
}
impl PartialEq for Cand {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for Cand {}
impl PartialOrd for Cand {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Cand {
    fn cmp(&self, o: &Self) -> Ordering {
        self.score
            .total_cmp(&o.score)
            .then_with(|| o.id.cmp(&self.id))
    }
}

/// A query: the rows it is scored against, its vector and its inverse norm.
struct Query<'q, 'a> {
    rows: &'q Rows<'a>,
    q: &'q [f32],
    inv: f32,
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The level of the node for row `ordinal` (docs/hnsw-format.md, "Levels"): integers only, and a
/// function of `(seed, ordinal, m)` alone.
pub fn level_for(seed: u32, ordinal: u32, m: u32) -> u32 {
    let m = m.max(1) as u64;
    let mut st = ((seed as u64) << 32) | ordinal as u64;
    let mut level = 0;
    loop {
        let z = splitmix64(&mut st);
        if level < LEVEL_MAX && z.is_multiple_of(m) {
            level += 1;
        } else {
            return level;
        }
    }
}

fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// `dim` 0 is the dimension of a namespace that has no vectors yet: an empty graph may carry it, and no
/// node can ever be inserted into such a graph (an insert needs rows of at least one component).
fn check_params(p: &Params, dim: u32, ns: &[u8]) -> Result<(), Err> {
    if dim > format::DIM_MAX {
        return Err(Err::Dim);
    }
    if ns.is_empty() || ns.len() > NS_MAX {
        return Err(Err::Namespace);
    }
    if p.metric > scan::METRIC_DOT
        || p.m < M_MIN
        || p.m > M_MAX
        || p.ef_construction < p.m
        || p.ef_construction > EF_CONSTRUCTION_MAX
    {
        return Err(Err::Bounds);
    }
    Ok(())
}

// ---- the graph ------------------------------------------------------------------------------------

pub struct Graph {
    metric: u32,
    m: u32,
    ef_construction: u32,
    seed: u32,
    dim: u32,
    generation: u32,
    ns: Vec<u8>,
    /// Per node: the flat row ordinal (strictly increasing), the level, the flags (bit 0 = deleted).
    ordinal: Vec<u32>,
    level: Vec<u8>,
    flags: Vec<u8>,
    /// Layer 0: `(2m + 1)` words per node, `[count, links...]`.
    l0: Vec<u32>,
    /// Upper layers: `(m + 1)` words per layer; node `i`'s layer `l >= 1` starts at `up_off[i] + (l - 1) * (m + 1)`.
    up_off: Vec<u32>,
    up: Vec<u32>,
    entry: u32,
    max_level: u32,
    live: u32,
    /// Visited stamps (one per node) and the current epoch.
    stamp: Vec<u32>,
    epoch: u32,
}

impl Graph {
    fn empty(p: &Params, ns: &[u8], generation: u32, dim: u32) -> Result<Graph, Err> {
        check_params(p, dim, ns)?;
        if generation > format::GEN_MAX {
            return Err(Err::Bounds);
        }
        let mut n = vec_with::<u8>(ns.len())?;
        n.extend_from_slice(ns);
        Ok(Graph {
            metric: p.metric,
            m: p.m,
            ef_construction: p.ef_construction,
            seed: p.seed,
            dim,
            generation,
            ns: n,
            ordinal: Vec::new(),
            level: Vec::new(),
            flags: Vec::new(),
            l0: Vec::new(),
            up_off: Vec::new(),
            up: Vec::new(),
            entry: NONE,
            max_level: 0,
            live: 0,
            stamp: Vec::new(),
            epoch: 0,
        })
    }

    /// An empty graph for a namespace of `dim` components.
    pub fn new_empty(p: &Params, ns: &[u8], generation: u32, dim: u32) -> Result<Graph, Err> {
        Graph::empty(p, ns, generation, dim)
    }

    fn s0(&self) -> usize {
        2 * self.m as usize + 1
    }
    fn su(&self) -> usize {
        self.m as usize + 1
    }
    fn cap(&self, layer: u32) -> usize {
        if layer == 0 {
            2 * self.m as usize
        } else {
            self.m as usize
        }
    }

    /// Where node `id`'s link list of `layer` lives: (in the upper array, start index, count). A node
    /// with no such layer has an empty list.
    #[inline]
    fn link_range(&self, id: u32, layer: u32) -> (bool, usize, usize) {
        let i = id as usize;
        let Some(&lv) = self.level.get(i) else {
            return (false, 0, 0);
        };
        if layer == 0 {
            let start = i * self.s0();
            let n = self.l0.get(start).copied().unwrap_or(0) as usize;
            (false, start, n.min(self.cap(0)))
        } else if layer <= lv as u32 {
            let start = self.up_off[i] as usize + (layer as usize - 1) * self.su();
            let n = self.up.get(start).copied().unwrap_or(0) as usize;
            (true, start, n.min(self.cap(layer)))
        } else {
            (false, 0, 0)
        }
    }

    #[inline]
    fn link_at(&self, upper: bool, start: usize, i: usize) -> u32 {
        let arr = if upper { &self.up } else { &self.l0 };
        arr.get(start + 1 + i).copied().unwrap_or(NONE)
    }

    fn write_links(&mut self, id: u32, layer: u32, ids: &[u32]) {
        let (upper, start, _) = self.link_range(id, layer);
        let cap = self.cap(layer);
        let arr = if upper { &mut self.up } else { &mut self.l0 };
        let n = ids.len().min(cap);
        if let Some(slot) = arr.get_mut(start..start + 1 + n) {
            slot[0] = n as u32;
            slot[1..].copy_from_slice(&ids[..n]);
        }
    }

    fn push_node(&mut self, ordinal: u32, level: u32) -> Result<(), Err> {
        let id = self.ordinal.len();
        if id >= NODES_MAX as usize {
            return Err(Err::Bounds);
        }
        let s0 = self.s0();
        let up_start = self.up.len();
        let up_add = level as usize * self.su();
        match up_start.checked_add(up_add) {
            Some(end) if (end as u64) <= u32::MAX as u64 => {}
            _ => return Err(Err::Memory),
        }
        reserve(&mut self.ordinal, 1)?;
        reserve(&mut self.level, 1)?;
        reserve(&mut self.flags, 1)?;
        reserve(&mut self.up_off, 1)?;
        reserve(&mut self.stamp, 1)?;
        reserve(&mut self.l0, s0)?;
        reserve(&mut self.up, up_add)?;
        self.ordinal.push(ordinal);
        self.level.push(level as u8);
        self.flags.push(0);
        self.up_off
            .push(if level > 0 { up_start as u32 } else { 0 });
        self.stamp.push(0);
        self.l0.resize(self.l0.len() + s0, 0);
        self.up.resize(up_start + up_add, 0);
        Ok(())
    }

    fn bump_epoch(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.stamp.iter_mut().for_each(|s| *s = 0);
            self.epoch = 1;
        }
    }

    #[inline]
    fn score_to(&self, q: &Query, id: u32) -> Result<f32, Err> {
        let ord = *self.ordinal.get(id as usize).ok_or(Err::Bounds)?;
        let (v, n) = q.rows.get(ord).ok_or(Err::Bounds)?;
        Ok(scan::score_one(v, n, q.q, q.inv, self.metric))
    }

    /// True when node `id` may be returned: its row is not tombstoned in the HEAD bitset `tomb` (empty
    /// means "no tombstones"). The graph's own deleted flag is never consulted here.
    #[inline]
    fn eligible(&self, id: u32, tomb: &[u8]) -> bool {
        if tomb.is_empty() {
            return true;
        }
        let Some(&ord) = self.ordinal.get(id as usize) else {
            return false;
        };
        match tomb.get((ord >> 3) as usize) {
            Some(b) => b & (1 << (ord & 7)) == 0,
            None => false,
        }
    }

    /// Follows the best-scoring neighbour on `layer` until none improves.
    fn greedy(&self, q: &Query, mut cur: Cand, layer: u32) -> Result<Cand, Err> {
        loop {
            let (upper, start, cnt) = self.link_range(cur.id, layer);
            let mut best = cur;
            for i in 0..cnt {
                let n = self.link_at(upper, start, i);
                if n as usize >= self.ordinal.len() {
                    continue;
                }
                let c = Cand {
                    score: self.score_to(q, n)?,
                    id: n,
                };
                if c > best {
                    best = c;
                }
            }
            if best.id == cur.id {
                return Ok(cur);
            }
            cur = best;
        }
    }

    /// Algorithm 2 on one layer: the `ef` best nodes found from the entry points, best first. With a
    /// tombstone bitset only live rows occupy result slots; the others are still traversed.
    fn search_layer(
        &mut self,
        q: &Query,
        eps: &[Cand],
        ef: usize,
        layer: u32,
        tomb: &[u8],
        out: &mut Vec<Cand>,
    ) -> Result<(), Err> {
        self.bump_epoch();
        let epoch = self.epoch;
        let mut cands: BinaryHeap<Cand> = BinaryHeap::new();
        let mut res: BinaryHeap<Reverse<Cand>> = BinaryHeap::new();
        cands.try_reserve(ef + 1).map_err(|_| Err::Memory)?;
        res.try_reserve(ef + 1).map_err(|_| Err::Memory)?;
        for &e in eps {
            let Some(s) = self.stamp.get_mut(e.id as usize) else {
                continue;
            };
            if *s == epoch {
                continue;
            }
            *s = epoch;
            cands.push(e);
            if self.eligible(e.id, tomb) {
                res.push(Reverse(e));
                if res.len() > ef {
                    res.pop();
                }
            }
        }
        while let Some(c) = cands.pop() {
            if res.len() >= ef {
                if let Some(Reverse(worst)) = res.peek() {
                    if c < *worst {
                        break;
                    }
                }
            }
            let (upper, start, cnt) = self.link_range(c.id, layer);
            for i in 0..cnt {
                let n = self.link_at(upper, start, i);
                let Some(s) = self.stamp.get_mut(n as usize) else {
                    continue;
                };
                if *s == epoch {
                    continue;
                }
                *s = epoch;
                let cn = Cand {
                    score: self.score_to(q, n)?,
                    id: n,
                };
                let admit = res.len() < ef || res.peek().is_none_or(|Reverse(w)| cn > *w);
                if admit {
                    cands.push(cn);
                    if self.eligible(n, tomb) {
                        res.push(Reverse(cn));
                        if res.len() > ef {
                            res.pop();
                        }
                    }
                }
            }
        }
        out.clear();
        reserve(out, res.len())?;
        out.extend(res.into_iter().map(|Reverse(c)| c));
        out.sort_by(|a, b| b.cmp(a));
        Ok(())
    }

    /// Algorithm 4 without keeping pruned connections: from candidates scored against a base node
    /// (best first after the sort), keep at most `max`, each only if it is not more similar to an already
    /// kept neighbour than to the base. Fewer candidates than `max` are all kept.
    fn select(
        &self,
        rows: &Rows,
        cands: &mut [Cand],
        max: usize,
        out: &mut Vec<Cand>,
    ) -> Result<(), Err> {
        cands.sort_by(|a, b| b.cmp(a));
        out.clear();
        reserve(out, cands.len().min(max))?;
        if cands.len() < max {
            out.extend_from_slice(cands);
            return Ok(());
        }
        for &c in cands.iter() {
            if out.len() >= max {
                break;
            }
            let ord = *self.ordinal.get(c.id as usize).ok_or(Err::Bounds)?;
            let (cv, cn) = rows.get(ord).ok_or(Err::Bounds)?;
            let mut good = true;
            for s in out.iter() {
                let so = *self.ordinal.get(s.id as usize).ok_or(Err::Bounds)?;
                let (sv, sn) = rows.get(so).ok_or(Err::Bounds)?;
                let sim = scan::score_one(cv, cn, sv, sn, self.metric);
                if sim.total_cmp(&c.score) == Ordering::Greater {
                    good = false;
                    break;
                }
            }
            if good {
                out.push(c);
            }
        }
        Ok(())
    }

    /// Adds the link `n -> id` on `layer`, shrinking `n`'s list with the heuristic when it is full.
    fn add_reverse(&mut self, rows: &Rows, n: u32, id: u32, layer: u32) -> Result<(), Err> {
        let (upper, start, cnt) = self.link_range(n, layer);
        let cap = self.cap(layer);
        if cnt < cap {
            let arr = if upper { &mut self.up } else { &mut self.l0 };
            if let Some(slot) = arr.get_mut(start..start + 2 + cnt) {
                slot[1 + cnt] = id;
                slot[0] = cnt as u32 + 1;
            }
            return Ok(());
        }
        let no = *self.ordinal.get(n as usize).ok_or(Err::Bounds)?;
        let (nv, nn) = rows.get(no).ok_or(Err::Bounds)?;
        let mut cands = vec_with::<Cand>(cnt + 1)?;
        let mut targets = vec_with::<u32>(cnt + 1)?;
        for i in 0..cnt {
            targets.push(self.link_at(upper, start, i));
        }
        targets.push(id);
        for &x in &targets {
            let xo = *self.ordinal.get(x as usize).ok_or(Err::Bounds)?;
            let (xv, xn) = rows.get(xo).ok_or(Err::Bounds)?;
            cands.push(Cand {
                score: scan::score_one(xv, xn, nv, nn, self.metric),
                id: x,
            });
        }
        let mut kept = Vec::new();
        self.select(rows, &mut cands, cap, &mut kept)?;
        let mut ids = vec_with::<u32>(kept.len())?;
        ids.extend(kept.iter().map(|c| c.id));
        self.write_links(n, layer, &ids);
        Ok(())
    }

    /// Inserts the node of row `ordinal`, which must be above every ordinal already in the graph and
    /// covered by `rows`. On an error the graph may be half updated and must be dropped.
    pub fn insert(&mut self, rows: &Rows, ordinal: u32) -> Result<(), Err> {
        if rows.dim != self.dim as usize {
            return Err(Err::Dim);
        }
        if ordinal >= rows.total || self.ordinal.last().is_some_and(|&l| ordinal <= l) {
            return Err(Err::Bounds);
        }
        let (qv, qn) = rows.get(ordinal).ok_or(Err::Bounds)?;
        let level = level_for(self.seed, ordinal, self.m);
        self.push_node(ordinal, level)?;
        let id = (self.ordinal.len() - 1) as u32;
        self.live += 1;
        if id == 0 {
            self.entry = 0;
            self.max_level = level;
            return Ok(());
        }
        let q = Query {
            rows,
            q: qv,
            inv: qn,
        };
        let top = self.max_level;
        let entry = self.entry;
        let mut cur = Cand {
            score: self.score_to(&q, entry)?,
            id: entry,
        };
        let mut l = top;
        while l > level {
            cur = self.greedy(&q, cur, l)?;
            l -= 1;
        }
        let mut eps = vec_with::<Cand>(1)?;
        eps.push(cur);
        let mut found = Vec::new();
        let mut kept = Vec::new();
        let m = self.m as usize;
        let efc = self.ef_construction as usize;
        for layer in (0..=level.min(top)).rev() {
            self.search_layer(&q, &eps, efc, layer, &[], &mut found)?;
            let mut cands = vec_with::<Cand>(found.len())?;
            cands.extend_from_slice(&found);
            self.select(rows, &mut cands, m, &mut kept)?;
            let mut ids = vec_with::<u32>(kept.len())?;
            ids.extend(kept.iter().map(|c| c.id));
            self.write_links(id, layer, &ids);
            for &n in &ids {
                self.add_reverse(rows, n, id, layer)?;
            }
            if let Some(&best) = found.first() {
                eps.clear();
                eps.push(best);
            }
        }
        if level > top {
            self.entry = id;
            self.max_level = level;
        }
        Ok(())
    }

    /// Builds a graph over the live rows of `rows` in increasing ordinal order. `tomb` is the HEAD
    /// tombstone bitset (`ceil(total / 8)` bytes, or empty for none).
    pub fn build(
        p: &Params,
        ns: &[u8],
        generation: u32,
        rows: &Rows,
        tomb: &[u8],
    ) -> Result<Graph, Err> {
        let dim = u32::try_from(rows.dim).map_err(|_| Err::Dim)?;
        let mut g = Graph::empty(p, ns, generation, dim)?;
        if !tomb.is_empty() && tomb.len() as u64 != (rows.total as u64).div_ceil(8) {
            return Err(Err::Bounds);
        }
        let dead: u64 = tomb.iter().map(|b| b.count_ones() as u64).sum();
        let live = (rows.total as u64).saturating_sub(dead) as usize;
        reserve(&mut g.ordinal, live)?;
        reserve(&mut g.level, live)?;
        reserve(&mut g.flags, live)?;
        reserve(&mut g.up_off, live)?;
        reserve(&mut g.stamp, live)?;
        let l0_words = live.checked_mul(g.s0()).ok_or(Err::Memory)?;
        reserve(&mut g.l0, l0_words)?;
        for r in 0..rows.total {
            if !tomb.is_empty() && tomb[(r >> 3) as usize] & (1 << (r & 7)) != 0 {
                continue;
            }
            g.insert(rows, r)?;
        }
        Ok(g)
    }

    /// Marks the node of row `ordinal` deleted. True when a live node was marked. The graph's flag is
    /// bookkeeping for the file; queries take liveness from the flat HEAD.
    pub fn mark_deleted(&mut self, ordinal: u32) -> bool {
        match self.ordinal.binary_search(&ordinal) {
            Ok(i) if self.flags[i] & 1 == 0 => {
                self.flags[i] |= 1;
                self.live -= 1;
                true
            }
            _ => false,
        }
    }

    pub fn set_generation(&mut self, g: u32) {
        self.generation = g;
    }
    pub fn generation(&self) -> u32 {
        self.generation
    }
    pub fn params(&self) -> Params {
        Params {
            metric: self.metric,
            m: self.m,
            ef_construction: self.ef_construction,
            seed: self.seed,
        }
    }
    pub fn dim(&self) -> u32 {
        self.dim
    }
    pub fn node_count(&self) -> u32 {
        self.ordinal.len() as u32
    }
    pub fn live_nodes(&self) -> u32 {
        self.live
    }
    pub fn entry(&self) -> Option<u32> {
        (self.entry != NONE).then_some(self.entry)
    }
    pub fn max_level(&self) -> u32 {
        self.max_level
    }

    /// Searches for the `ef` best live rows for `q`, best first (score descending, ordinal ascending).
    /// `tomb` is the flat HEAD's tombstone bitset for `rows.total` rows, or empty for none.
    pub fn search(
        &mut self,
        rows: &Rows,
        q: &[f32],
        ef: usize,
        tomb: &[u8],
        out: &mut Vec<Hit>,
    ) -> Result<(), Err> {
        out.clear();
        if q.len() != self.dim as usize || rows.dim != self.dim as usize {
            return Err(Err::Dim);
        }
        if ef == 0 || ef > EF_MAX as usize {
            return Err(Err::Bounds);
        }
        if !tomb.is_empty() && tomb.len() as u64 != (rows.total as u64).div_ceil(8) {
            return Err(Err::Bounds);
        }
        if self.ordinal.is_empty() {
            return Ok(());
        }
        let query = Query {
            rows,
            q,
            inv: scan::inv_norm(q),
        };
        let entry = self.entry;
        let mut cur = Cand {
            score: self.score_to(&query, entry)?,
            id: entry,
        };
        for layer in (1..=self.max_level).rev() {
            cur = self.greedy(&query, cur, layer)?;
        }
        let mut eps = vec_with::<Cand>(1)?;
        eps.push(cur);
        let mut found = Vec::new();
        self.search_layer(&query, &eps, ef, 0, tomb, &mut found)?;
        reserve(out, found.len())?;
        for c in found {
            out.push(Hit {
                ordinal: self.ordinal[c.id as usize],
                score: c.score,
            });
        }
        Ok(())
    }

    // ---- serialisation ------------------------------------------------------------------------

    fn link_words(&self) -> u64 {
        let mut words = 0u64;
        for id in 0..self.ordinal.len() as u32 {
            for layer in 0..=self.level[id as usize] as u32 {
                words += 1 + self.link_range(id, layer).2 as u64;
            }
        }
        words
    }

    /// The exact length of the serialised record.
    pub fn serialized_len(&self) -> u64 {
        HEADER_LEN as u64
            + self.ns.len() as u64
            + 8 * self.ordinal.len() as u64
            + 4 * self.link_words()
            + 4
    }

    /// Writes the record into `out`, which must be exactly [`Graph::serialized_len`] bytes.
    pub fn serialize_into(&self, out: &mut [u8]) -> Result<(), Err> {
        let words = self.link_words();
        let total = self.serialized_len();
        if out.len() as u64 != total || words > u32::MAX as u64 {
            return Err(Err::Length);
        }
        let put32 = |out: &mut [u8], off: usize, x: u32| {
            out[off..off + 4].copy_from_slice(&x.to_le_bytes());
        };
        out[..HEADER_LEN].fill(0);
        out[0..8].copy_from_slice(&MAGIC);
        out[8..10].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
        out[10] = self.metric as u8;
        out[11] = self.ns.len() as u8;
        put32(out, 12, self.dim);
        put32(out, 16, self.m);
        put32(out, 20, self.ef_construction);
        put32(out, 24, self.seed);
        put32(out, 28, self.generation);
        put32(out, 32, self.ordinal.len() as u32);
        put32(out, 36, self.live);
        put32(out, 40, self.entry);
        put32(out, 44, self.max_level);
        put32(out, 48, words as u32);
        let mut w = HEADER_LEN;
        out[w..w + self.ns.len()].copy_from_slice(&self.ns);
        w += self.ns.len();
        for i in 0..self.ordinal.len() {
            put32(out, w, self.ordinal[i]);
            out[w + 4] = self.level[i];
            out[w + 5] = self.flags[i];
            out[w + 6] = 0;
            out[w + 7] = 0;
            w += 8;
        }
        for id in 0..self.ordinal.len() as u32 {
            for layer in 0..=self.level[id as usize] as u32 {
                let (upper, start, cnt) = self.link_range(id, layer);
                put32(out, w, cnt as u32);
                w += 4;
                for i in 0..cnt {
                    put32(out, w, self.link_at(upper, start, i));
                    w += 4;
                }
            }
        }
        let crc = crc32c::update(0, &out[..w]);
        put32(out, w, crc);
        Ok(())
    }

    /// The serialised record in a new `Vec`.
    pub fn serialize(&self) -> Result<Vec<u8>, Err> {
        let total = self.serialized_len();
        if total > i32::MAX as u64 {
            return Err(Err::Memory);
        }
        let mut v = Vec::new();
        v.try_reserve_exact(total as usize)
            .map_err(|_| Err::Memory)?;
        v.resize(total as usize, 0);
        self.serialize_into(&mut v)?;
        Ok(v)
    }

    // ---- validation ---------------------------------------------------------------------------

    /// Parses and fully validates a graph record (docs/hnsw-format.md, "Validation"). Nothing sized by
    /// a header field is allocated before the exact record length has been checked against it.
    pub fn load(b: &[u8], e: &Expect) -> Result<Graph, Err> {
        let len = b.len() as u64;
        if len < (HEADER_LEN + 1 + 4) as u64 {
            return Err(Err::Length);
        }
        if b[0..8] != MAGIC {
            return Err(Err::Magic);
        }
        if u16::from_le_bytes([b[8], b[9]]) != FORMAT_VERSION {
            return Err(Err::Version);
        }
        let dim = u32_at(b, 12);
        if dim > format::DIM_MAX || dim != e.dim {
            return Err(Err::Dim);
        }
        let p = Params {
            metric: b[10] as u32,
            m: u32_at(b, 16),
            ef_construction: u32_at(b, 20),
            seed: u32_at(b, 24),
        };
        // Parameters before the namespace: a header whose parameters are out of range is `bounds`.
        if p.metric > scan::METRIC_DOT
            || p.m < M_MIN
            || p.m > M_MAX
            || p.ef_construction < p.m
            || p.ef_construction > EF_CONSTRUCTION_MAX
        {
            return Err(Err::Bounds);
        }
        let ns_len = b[11] as usize;
        if ns_len == 0 || ns_len > NS_MAX {
            return Err(Err::Namespace);
        }
        if (HEADER_LEN + ns_len + 4) as u64 > len {
            return Err(Err::Length);
        }
        if b[HEADER_LEN..HEADER_LEN + ns_len] != *e.ns {
            return Err(Err::Namespace);
        }
        let generation = u32_at(b, 28);
        if generation > e.generation {
            return Err(Err::Generation);
        }
        let count = u32_at(b, 32);
        let live = u32_at(b, 36);
        let entry = u32_at(b, 40);
        let max_level = u32_at(b, 44);
        let words = u32_at(b, 48);
        if u32_at(b, 52) != 0
            || count > NODES_MAX
            || count > e.rows
            || live > count
            || max_level > LEVEL_MAX
        {
            return Err(Err::Bounds);
        }
        let expected = HEADER_LEN as u64 + ns_len as u64 + 8 * count as u64 + 4 * words as u64 + 4;
        if expected != len {
            return Err(Err::Length);
        }
        let end = b.len() - 4;
        if u32_at(b, end) != crc32c::update(0, &b[..end]) {
            return Err(Err::Crc);
        }

        // From here every size is backed by the file length (count <= len / 8, words <= len / 4).
        let n = count as usize;
        let mut g = Graph::empty(&p, e.ns, generation, dim)?;
        let table = HEADER_LEN + ns_len;
        reserve(&mut g.ordinal, n)?;
        reserve(&mut g.level, n)?;
        reserve(&mut g.flags, n)?;
        reserve(&mut g.up_off, n)?;
        let mut prev: Option<u32> = None;
        let mut live_seen = 0u32;
        let mut max_seen = 0u32;
        let mut upper_layers = 0u64;
        for i in 0..n {
            let o = table + 8 * i;
            let ord = u32_at(b, o);
            let lvl = b[o + 4] as u32;
            let fl = b[o + 5];
            if lvl > LEVEL_MAX
                || fl & !1 != 0
                || b[o + 6] != 0
                || b[o + 7] != 0
                || ord >= e.rows
                || prev.is_some_and(|p| ord <= p)
            {
                return Err(Err::Bounds);
            }
            prev = Some(ord);
            upper_layers += lvl as u64;
            if fl & 1 == 0 {
                live_seen += 1;
            }
            max_seen = max_seen.max(lvl);
            g.ordinal.push(ord);
            g.level.push(lvl as u8);
            g.flags.push(fl);
        }
        if live_seen != live || upper_layers > 2 * n as u64 + UPPER_LAYER_SLACK {
            return Err(Err::Bounds);
        }
        if n == 0 {
            if entry != NONE || max_level != 0 {
                return Err(Err::Bounds);
            }
        } else if entry as usize >= n
            || g.level[entry as usize] as u32 != max_level
            || max_seen != max_level
        {
            return Err(Err::Bounds);
        }
        g.entry = entry;
        g.max_level = max_level;
        g.live = live;

        let s0 = g.s0();
        let su = g.su();
        let l0_words = n.checked_mul(s0).ok_or(Err::Memory)?;
        let up_words = (upper_layers as usize)
            .checked_mul(su)
            .filter(|&w| w as u64 <= u32::MAX as u64)
            .ok_or(Err::Memory)?;
        reserve(&mut g.l0, l0_words)?;
        reserve(&mut g.up, up_words)?;
        reserve(&mut g.stamp, n)?;
        g.l0.resize(l0_words, 0);
        g.up.resize(up_words, 0);
        g.stamp.resize(n, 0);
        let mut up_next = 0usize;
        for i in 0..n {
            g.up_off
                .push(if g.level[i] > 0 { up_next as u32 } else { 0 });
            up_next += g.level[i] as usize * su;
        }

        let mut w = table + 8 * n;
        for id in 0..n {
            for layer in 0..=g.level[id] as u32 {
                if (w + 4) as u64 > end as u64 {
                    return Err(Err::Length);
                }
                let cnt = u32_at(b, w) as usize;
                w += 4;
                if cnt > g.cap(layer) {
                    return Err(Err::Links);
                }
                if (w + 4 * cnt) as u64 > end as u64 {
                    return Err(Err::Length);
                }
                let (upper, start, _) = g.link_range(id as u32, layer);
                let arr = if upper { &mut g.up } else { &mut g.l0 };
                arr[start] = cnt as u32;
                for j in 0..cnt {
                    let link = u32_at(b, w + 4 * j);
                    if link as usize >= n
                        || link as usize == id
                        || (g.level[link as usize] as u32) < layer
                    {
                        return Err(Err::Links);
                    }
                    arr[start + 1 + j] = link;
                }
                w += 4 * cnt;
            }
        }
        if w != end {
            return Err(Err::Length);
        }
        Ok(g)
    }
}
