# HNSW graph format `LDHNSW02` (localdata-internal)

Status: format version 2, introduced with localdata 0.4.0-alpha.1 (Sprint 7, TD-109, extended by TD-126 with the `nearMax` header word); format version 1
(`LDHNSW01`) shipped in 0.4.0-alpha.0 and is refused, see "Versions". This file is the normative
description of the bytes. The Storage API contract (`runtime/spec/storage-api.md`) promises the behaviour
of `buildIndex`, `dropIndex` and `query({ index: 'hnsw' })`, not this layout; the layout may change in a
later format version, and a graph in an older version is refused and rebuilt.

The graph is a **derived** artefact. The flat index (`docs/vector-index-format.md`) stays the source
of truth for vectors, keys, values and liveness. The graph file holds **no vectors and no keys**: only
row ordinals, levels, a deleted flag and links. A byte-for-byte search of a graph for any stored vector
or key finds nothing (tested). It is **untrusted input**: every byte is validated in `ldvec`
(`crates/ldvec/src/hnsw.rs`) before a search may use it, and a file that fails any check is refused.

All integers are little-endian. All lengths and offsets are computed in `u64` before they size
anything. There are no padding bytes that carry meaning: reserved fields must be zero.

## Where it lives

The graph of namespace `ns` is two records (three after a rebuild) of the SDK-reserved driver namespace `'__ld_ann.' + ns`
(constant `ANN_NS_PREFIX`), beside `'__ld_vec.' + ns`:

| record    | content                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| `graph`   | this format (one record, replaced atomically by one driver `put`)                    |
| `params`  | the build parameters, 28 bytes (below), kept apart so a refused graph can be rebuilt |
| `rebuilt` | optional, 16 bytes: the rebuild marker (below), present only after a rebuild         |

All of them are counted by `usage()` (`annBytes`, included in `bytes`) and by the pre-write quota check, and
both are removed by `clear(ns)` (and by deleting the last live row, and by `dropIndex`).

## Graph record

```
offset  size  field
0       8     magic            'LDHNSW02'
8       2     formatVersion    2
10      1     metric           0 = cosine, 1 = dot
11      1     nsLen            1..64
12      4     dim              1..4096, must equal the namespace dim
16      4     m                4..64
20      4     efConstruction   m..1000
24      4     seed             any u32
28      4     generation       flat HEAD generation the graph is consistent with (0 = built over an empty namespace)
32      4     nodeCount        0..4,194,304 and <= the flat HEAD totalRows
36      4     liveNodes        nodes whose deleted flag is clear
40      4     entry            node index of the entry point, 0xFFFFFFFF when nodeCount = 0
44      4     maxLevel         level of the entry node (0 when empty)
48      4     linkWords        number of u32 words of the link area
52      4     dupMax           size of the largest group of live rows with identical vector bytes at the last
                               count (exact at build, recounted after every put), 0..nodeCount
56      4     nearMax          size of the largest group of live rows that share one quantised key (the low 12
                               mantissa bits of every component cleared, see "Near-duplicates") at the same
                               count, dupMax..nodeCount (identical rows share a key, so it is never below dupMax)
60      nsLen namespace        the caller's namespace as UTF-8 bytes (NOT a checksum of it)
...     8*N   node table       N = nodeCount; per node:
                                 ordinal  u32   row ordinal in the flat index (global, 0-based)
                                 level    u8    0..16
                                 flags    u8    bit 0 = deleted; other bits must be 0
                                 reserved u16   0
...     4*L   link area        L = linkWords; for each node in node-table order, for layer 0..=level:
                                 count u32, then count x u32 links (node indices)
...     4     crc32c           CRC-32C over every preceding byte of the record
```

Total length is exactly `60 + nsLen + 8*nodeCount + 4*linkWords + 4`. It is computed in `u64` and
compared with the record length **before** any array is allocated, so no allocation is ever sized by
a count that the file length does not back. A declared count with a short file is refused with
`length`.

The namespace is bound by its UTF-8 **length and bytes**, not by a CRC: two different namespaces whose
CRC-32 or CRC-32C collide are still told apart (tested with a CRC-32C collision found by search).

## Validation (every check, in order)

The first failing check is the code returned. Codes are negative `i32` values (`-20` to `-26` below);
the TypeScript layer turns them into the `reason` of a `storage.index.open` event.

| code | reason       | check                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| -22  | `length`     | record shorter than the fixed header plus CRC, or not the exact length the header implies                                                                                                                                                                                                                                            |
| -21  | `version`    | the magic is `LDHNSW01` (the first format), or formatVersion is not 2                                                                                                                                                                                                                                                                |
| -20  | `magic`      | magic is neither `LDHNSW02` nor `LDHNSW01`                                                                                                                                                                                                                                                                                           |
| -23  | `dim`        | dim differs from the namespace dim (or is outside 1..4096)                                                                                                                                                                                                                                                                           |
| -24  | `ns`         | nsLen outside 1..64, or the namespace bytes differ from the namespace being opened                                                                                                                                                                                                                                                   |
| -25  | `generation` | generation is newer than the flat HEAD generation (a graph from the future is never trusted)                                                                                                                                                                                                                                         |
| -26  | `bounds`     | metric, m, efConstruction out of range; nodeCount above the flat HEAD totalRows; level above 16; reserved bits set; dupMax or nearMax above nodeCount, or nearMax below dupMax; ordinals not strictly increasing or not below totalRows; entry point not on the top level; liveNodes disagrees with the flags; too many upper layers |
| -29  | `params`     | metric, m, efConstruction or seed in the header differ from the namespace's stored `params` record (S1-123, S1-128)                                                                                                                                                                                                                  |
| -27  | `links`      | a link count above 2m (layer 0) or m (upper layers); a link at or above nodeCount; a self link; a link to a node that is not on that layer                                                                                                                                                                                           |
| -28  | `crc`        | the CRC-32C does not match                                                                                                                                                                                                                                                                                                           |
| -30  | (memory)     | an allocation sized by the (already length-checked) file failed: reported as `quota_exceeded` with reason `wasm_memory`, never a trap                                                                                                                                                                                                |

Order of evaluation: minimum length, magic and version, dim, parameters against their limits (`bounds`),
parameters against the stored `params` record (`params`), namespace, generation, counts against the flat HEAD
(`bounds`), exact length, CRC, then the node table and the link area. Nothing is allocated before the exact
length has been checked, and nothing sized by `m` (the layer-0 stride is `2m + 1` words per node) is
reserved before the header's `m`, `efConstruction`, metric and seed have been compared with the stored
record the host passes in (`ldv_hnsw_load` takes them as arguments): a forged `m = 64` over a namespace built
with `m = 16` and a declared million nodes is refused at that comparison, with no allocation at all
(`crates/ldvec/tests/hnsw_header.rs` runs it under a counting allocator: the largest request is 0 bytes;
Sprint 6 reserved 516 MB for the same file). Accidental corruption is therefore reported as `crc`; a graph
that was crafted with a valid CRC is caught by the structural checks. Cycles are legal and harmless (search
keeps a visited set bounded by nodeCount), and duplicate links inside one list are legal.

## Versions

A file whose magic is `LDHNSW01` is a graph of the first format. It is refused with reason `version` before
any other field is read, and the SDK rebuilds it from the stored vectors with the stored params, under the
writer lock, before the query answers (`storage.index.build`, reason `rebuild`). The rebuild goes through
the same pre-write checks as a fresh `buildIndex` (soft quota, `maxIndexBytes`, WebAssembly memory), and is
read back through the same validation.

At most one rebuild runs per namespace and HEAD generation, in this session and in any later one: before it
starts, the SDK writes the 16-byte `rebuilt` marker (`'LDHNSWR1'`, the generation as a u32, a CRC-32C of the
first 12 bytes) beside the graph. A graph refused again at a generation the marker names is dropped instead
of rebuilt a second time, and queries answer with the exact flat scan (`fallback: 'refused'`) until
`buildIndex` is called. A rebuild that finds every handle in use (`busy`) withdraws the marker, so it does
not count. `clear(ns)` and `dropIndex` remove the marker with the rest.

What a graph that passes every check can still do: miss rows (lower recall). It cannot add a row,
change a score, or reach memory outside the vectors the flat index owns, because (1) every candidate
ordinal is checked below the flat HEAD row count, (2) liveness comes from the flat HEAD tombstone
bitset at query time and never from the graph's deleted flags, and (3) every score is computed by the
kernel from the stored vectors with the same bit-exact function the flat scan uses.

## Near-duplicates (TD-126, BUG-T2-S7-02)

Exact-duplicate pruning is not enough for a tight cluster of hundreds of rows that differ by a few units in the last
place (91 to 98 of 100 queries equal to flat on synthetic groups of 500 and 1,000 at dim 384, the best group missed, no
fallback). The kernel therefore counts a second statistic with the same machinery. The **quantised key** of a row is
every component's f32 bit pattern with the low 12 mantissa bits cleared (`NEAR_DROP_BITS`, the mask `0xFFFFF000`; the
sign, the exponent and the top 11 mantissa bits stay, so `+0.0` and `-0.0` are different keys). Rows are grouped by a
32-bit FNV-1a hash of the masked words and then compared BY THE MASKED BYTES, never by the hash alone (a run of equal
hashes whose rows are all equal to its first row is one group; otherwise it is sorted and counted by bytes). Identical
rows share a key, so `nearMax >= dupMax` always. The rule `degenerate = dupMax > 2m or nearMax > 2m` sends such a
build to the flat scan; it does not change a single graph byte beyond the 4-byte `nearMax` word. The rule is a PROXY
for "the graph may miss the best group": it catches vectors that agree to about 11 bits in every component (a few ulps
of float noise, the same vector embedded twice), not clusters whose members differ by more than that. Twelve bits is a
measured choice on the synthetic `t2_*` sets of `crates/ldvec/tests/hnsw_dup.rs`, not a derived one; it was not tuned afterwards. What it does not catch is in
README, "Exact duplicates". Detection depends on the data and the dimension. On a synthetic dim-384 set (30 groups of 500 rows) all-component float noise from about 1e-5 relative (about 256 ulp) upward was not detected: with +-256 ulp, +-1024 ulp, 1e-5 relative and 1e-4 relative noise in every component the graph alone answered 99, 95, 96 and 92 of 100 queries with the flat scan's top-10 scores at `ef` 64 (92 to 99 of 100) and the rule did not fire (`near_max` 1 to 3; the `noise` rows of `docs/benchmarks/ann-near-duplicates.csv`). At dim 32 the same noise at 256 ulp, 1024 ulp and 1e-5 relative was detected (the flat scan answered; 96, 93 and 98 of 100 for the graph alone) and 1e-4 relative was not (90 of 100). The flat scan is the way to get complete answers.

## Levels (deterministic, integer only)

The level of a node depends only on `(seed, ordinal, m)`, so inserting after a cold reload gives the
same graph as inserting without one:

```
state = (seed << 32) | ordinal            (u64)
level = 0
loop:  z = splitmix64(state)              (state += 0x9E3779B97F4A7C15, then the two xor-multiply rounds)
       if level < 16 and z % m == 0: level += 1  else: stop
```

This is the geometric distribution of the HNSW paper with p = 1/m, from integers only (no `ln`, whose
last bit differs between libm implementations).

## Build and update rules

- Insert order is the flat row order: `buildIndex` inserts the live rows in increasing ordinal order;
  `putVectors` appends the new rows' nodes in order; a replaced row's old node is marked deleted.
- Neighbour selection is Algorithm 4 of the paper (the diversity heuristic) with two changes made in
  Sprint 7 for data with exact duplicates (TD-109, BUG-T2-S6-14): a candidate whose vector BYTES equal an
  already kept neighbour's is pruned even on a tie (the comparison is on the stored bytes, never on a hash:
  `+0.0` and `-0.0` are different rows), and free slots are then filled from the pruned candidates in score
  order (the paper's keepPrunedConnections). It selects `m` links for a new node, caps lists at `2m` on layer
  0 and `m` above, and shrinks an over-full list with the same rule. Candidates are ordered by score
  descending, then node index DESCENDING (`f32::total_cmp`), so there are no ties and, among exact copies,
  the newest comes first: every new copy links to the copies just before it, instead of every copy linking to
  the same first few.
- The candidate list is widened when copies fill it: if a full result list (the `efConstruction` candidates
  of an insertion, or the `ef` results of a query) repeats a score in at least half of its entries, the
  search runs once more with `ef` multiplied by the repetition factor, at most 1000. A group of copies larger
  than the list would otherwise show a node no other neighbourhood. Nothing changes for data without copies.
- A graph is **degenerate** when its largest group of identical live rows (`dupMax`), or its largest group of live rows
  that share one quantised key (`nearMax`, see "Near-duplicates"), is larger than `2 * m`, the capacity of a layer-0
  neighbour list. The kernel does not then promise that a query finds the nearest group, so the SDK answers by the
  exact flat scan with `fallback: 'duplicates'` (index `flat`) until the copies are removed and `buildIndex` is called
  again. The exact boundary was measured, not derived (README, "Exact duplicates"). Both counts are exact at build and
  recounted after every `putVectors` (while a graph is resident, every `putVectors` recounts all live rows, so the cost grows linearly with the row count; two hashing passes over the live rows sharing one buffer of eight bytes per
  row, a sort of that buffer, and a comparison by bytes inside each group of equal hashes); a delete never lowers
  them, so a graph stays degenerate until a rebuild. The counts are NOT recounted when a graph is loaded (a recount
  at a million rows is an unmeasured full pass). A forged or edited statistic in the CRC-checked header is therefore
  trusted: a RAISED count can only force the exact flat path, but a LOWERED count (kept consistent: `nearMax` at
  least `dupMax`, both at most `nodeCount`, which the loader checks) CAN suppress the `'duplicates'` fallback. That
  costs recall only, never a wrong score (every score is the flat scan's score for that row), and it sits behind the
  same trust boundary as the stored vectors: whoever can write the graph record to the origin's storage can already
  replace the vectors themselves (BUG-T2-S7-03, S1-134, TD-127). Use the flat scan when a completeness decision
  depends on the answer.
- Scores are the flat scan's scores (`scan::score_one`, the four-accumulator `dot4`, no FMA); the SIMD
  and scalar kernels agree bit for bit, and so do native and WebAssembly builds.
- No hash map, no thread, no `f64` transcendental function appears in the build or the search; the
  graph bytes for a fixed `(rows, order, metric, m, efConstruction, seed)` are identical on every
  platform (`test/fixtures/hnsw-determinism.json` pins the sha256 values; Rust and TypeScript must both
  reproduce them).
- A deleted node stays in the graph and is traversed; it is never returned. There is no compaction in
  this version: deleted and replaced nodes accumulate until `buildIndex` replaces the graph.

## `params` record (28 bytes)

```
0   8  magic      'LDHNSWP1'
8   2  version    1
10  1  metric     0 or 1
11  1  reserved   0
12  4  m
16  4  efConstruction
20  4  seed
24  4  crc32c     over bytes 0..24
```

A `params` record that is missing, mis-sized, has a wrong CRC or has a field out of range is **refused**:
the index is dropped (all records removed) and queries answer with the flat scan (`fallback: 'refused'`)
until the caller builds again. A graph header that disagrees with a valid `params` record is refused with
reason `params` and rebuilt like any refused graph.

## Search

`search(q, k, ef)` is the paper's Algorithm 2 with a result list of size `ef` that holds only live rows
(deleted nodes are traversed so the graph stays connected, but they do not occupy result slots). The
kernel returns every live result it found (up to `ef`), the TypeScript layer keeps the best `k` ordered
as the flat scan orders them (score descending, then key ascending by UTF-8 bytes). The effective `ef`
is `max(ef ?? max(64, k), k)`, at most 1000.

## Memory

The vectors are already resident in WebAssembly memory for the flat scan; the graph adds
`nodes * (2m + 1) * 4` bytes for layer 0 (fixed stride), a few percent for the upper layers, and
`nodes * 14` bytes of per-node tables (ordinal, level, flags, upper-layer offset and a visited stamp), plus
transient search scratch (`ef` entries, up to 1000 when a query is widened). keepPrunedConnections fills
more link slots than the first format did, so the serialised graph is larger than it was (the figures are in
`docs/benchmarks/ann.csv`, the 0.4.0-alpha.0 ones in `docs/benchmarks/ann-s6-format-v1.csv` when present).
Building a graph also counts duplicates, which takes eight transient bytes per live row. Nothing here is an
8 GB measurement.
