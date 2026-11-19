# HNSW graph format `LDHNSW01` (localdata-internal)

Status: format version 1, introduced with Storage API 0.4.0 (localdata 0.4.0-alpha.0). This file is
the normative description of the bytes. The Storage API contract (`runtime/spec/storage-api.md`)
promises the behaviour of `buildIndex`, `dropIndex` and `query({ index: 'hnsw' })`, not this layout;
the layout may change in a later format version, and a graph in an older version is refused and rebuilt.

The graph is a **derived** artefact. The flat index (`docs/vector-index-format.md`) stays the source
of truth for vectors, keys, values and liveness. The graph file holds **no vectors and no keys**: only
row ordinals, levels, a deleted flag and links. A byte-for-byte search of a graph for any stored vector
or key finds nothing (tested). It is **untrusted input**: every byte is validated in `ldvec`
(`crates/ldvec/src/hnsw.rs`) before a search may use it, and a file that fails any check is refused.

All integers are little-endian. All lengths and offsets are computed in `u64` before they size
anything. There are no padding bytes that carry meaning: reserved fields must be zero.

## Where it lives

The graph of namespace `ns` is two records of the SDK-reserved driver namespace `'__ld_ann.' + ns`
(constant `ANN_NS_PREFIX`), beside `'__ld_vec.' + ns`:

| record   | content                                                                              |
| -------- | ------------------------------------------------------------------------------------ |
| `graph`  | this format (one record, replaced atomically by one driver `put`)                    |
| `params` | the build parameters, 28 bytes (below), kept apart so a refused graph can be rebuilt |

Both are counted by `usage()` (`annBytes`, included in `bytes`) and by the pre-write quota check, and
both are removed by `clear(ns)` (and by deleting the last live row, and by `dropIndex`).

## Graph record

```
offset  size  field
0       8     magic            'LDHNSW01'
8       2     formatVersion    1
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
52      4     reserved         0
56      nsLen namespace        the caller's namespace as UTF-8 bytes (NOT a checksum of it)
...     8*N   node table       N = nodeCount; per node:
                                 ordinal  u32   row ordinal in the flat index (global, 0-based)
                                 level    u8    0..16
                                 flags    u8    bit 0 = deleted; other bits must be 0
                                 reserved u16   0
...     4*L   link area        L = linkWords; for each node in node-table order, for layer 0..=level:
                                 count u32, then count x u32 links (node indices)
...     4     crc32c           CRC-32C over every preceding byte of the record
```

Total length is exactly `56 + nsLen + 8*nodeCount + 4*linkWords + 4`. It is computed in `u64` and
compared with the record length **before** any array is allocated, so no allocation is ever sized by
a count that the file length does not back. A declared count with a short file is refused with
`length`.

The namespace is bound by its UTF-8 **length and bytes**, not by a CRC: two different namespaces whose
CRC-32 or CRC-32C collide are still told apart (tested with a CRC-32C collision found by search).

## Validation (every check, in order)

The first failing check is the code returned. Codes are negative `i32` values (`-20` to `-26` below);
the TypeScript layer turns them into the `reason` of a `storage.index.open` event.

| code | reason       | check                                                                                                                                                                                                                                                                    |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| -22  | `length`     | record shorter than the fixed header plus CRC, or not the exact length the header implies                                                                                                                                                                                |
| -20  | `magic`      | magic is not `LDHNSW01`                                                                                                                                                                                                                                                  |
| -21  | `version`    | formatVersion is not 1                                                                                                                                                                                                                                                   |
| -23  | `dim`        | dim differs from the namespace dim (or is outside 1..4096)                                                                                                                                                                                                               |
| -24  | `ns`         | nsLen outside 1..64, or the namespace bytes differ from the namespace being opened                                                                                                                                                                                       |
| -25  | `generation` | generation is newer than the flat HEAD generation (a graph from the future is never trusted)                                                                                                                                                                             |
| -26  | `bounds`     | metric, m, efConstruction out of range; nodeCount above the flat HEAD totalRows; level above 16; reserved bits set; ordinals not strictly increasing or not below totalRows; entry point not on the top level; liveNodes disagrees with the flags; too many upper layers |
| -27  | `links`      | a link count above 2m (layer 0) or m (upper layers); a link at or above nodeCount; a self link; a link to a node that is not on that layer                                                                                                                               |
| -28  | `crc`        | the CRC-32C does not match                                                                                                                                                                                                                                               |
| -30  | (memory)     | an allocation sized by the (already length-checked) file failed: reported as `quota_exceeded` with reason `wasm_memory`, never a trap                                                                                                                                    |

Order of evaluation: length, magic, version, dim, parameters (`bounds`), namespace, generation,
counts against the flat HEAD (`bounds`), exact length, CRC, then the node table and the link area.
Accidental corruption is therefore reported as `crc`; a graph that was crafted with a valid CRC is
caught by the structural checks. Cycles are legal and harmless (search keeps a visited set bounded by
nodeCount), and duplicate links inside one list are legal.

What a graph that passes every check can still do: miss rows (lower recall). It cannot add a row,
change a score, or reach memory outside the vectors the flat index owns, because (1) every candidate
ordinal is checked below the flat HEAD row count, (2) liveness comes from the flat HEAD tombstone
bitset at query time and never from the graph's deleted flags, and (3) every score is computed by the
kernel from the stored vectors with the same bit-exact function the flat scan uses.

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
- Neighbour selection is Algorithm 4 of the paper (the diversity heuristic) without keeping pruned
  connections: select `m` links for a new node, cap lists at `2m` on layer 0 and `m` above, shrink an
  over-full list with the same heuristic. Candidates are ordered by score descending then node index
  ascending (`f32::total_cmp`), so there are no ties.
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

A `params` record that is missing, mis-sized, has a wrong CRC, has a field out of range, or disagrees
with the graph header is **refused**: the index is dropped (both records removed) and queries answer
with the flat scan (`fallback: 'refused'`) until the caller builds again.

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
transient search scratch (`ef` entries). At 100,000 nodes with m = 16 that is about 14 MB on top of 153.6 MB of
vectors; the serialised graph is smaller than the resident one because unused link slots are not
written. Measured figures are in `docs/benchmarks/ann.csv`; nothing here is an 8 GB measurement.
