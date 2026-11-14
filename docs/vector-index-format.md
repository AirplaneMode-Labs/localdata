# Vector index on-disk format, version 1

Status: implemented in `0.2.0-alpha.0` (Sprint 4). This format is **localdata-internal**: Storage API
0.2.0 promises only the behaviour in `runtime/spec/storage-api.md`, never these bytes. It is documented
so the two implementations (the TypeScript writer in `src/vec/writer.ts` and the Rust validator in
`crates/ldvec`) can be checked against each other, and so a corrupt index can be diagnosed. The golden
fixture `crates/ldvec/tests/fixtures/tiny/` is written by the TypeScript writer and parsed by the Rust
crate (`test/tiny-fixture.test.ts`, `crates/ldvec/tests/format.rs`).

All integers are little-endian. All checksums are CRC-32C (Castagnoli, reflected polynomial
`0x82F63B78`, initial value and final xor `0xFFFFFFFF`; `crc32c("123456789") = 0xE3069283`). CRC-32C
detects accidental corruption, truncation and torn writes; it does not detect a deliberate edit by anyone
who can write the browser profile, who can recompute it.

## 1. Records and where they live

One index per namespace `ns`, in the reserved driver namespace `'__ld_vec.' + ns` (the prefix `__ld_` is
rejected for callers). With the OPFS driver each index therefore has its own directory and its own
`keys.json`; with IndexedDB each record is one row of the `kv` store; with the memory driver each is a
map entry. The records are:

| Record                | Contents                                                                                                 | Written                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `head`                | the HEAD record (below): dim, counts, generation, the segment table, the tombstone bitset                | last, in one `put`; the only record ever replaced |
| `vec-<segId>/<part>`  | float32 row-major vectors, `rowsPerPart = max(1, floor(8388608 / (dim * 4)))` rows per part              | before `head`                                     |
| `meta-<segId>/<part>` | the segment's META blob cut into 8 MiB parts                                                             | before `head`                                     |
| `val-<segId>/<part>`  | the segment's values (LD1 envelopes, see `src/codec.ts`) concatenated in row order, cut into 1 MiB parts | before `head`                                     |

`<part>` is five digits (`00000`). A part is `ceil(total / partSize)` records, all full except the last.
A segment with no values has no `val-` records.

Segments are immutable. `segId` comes from the committed HEAD's `nextSegId`, so a new write never
overwrites a record the committed HEAD references; until the new HEAD lands, readers and a crash see
exactly the previous index.

## 2. HEAD

```
offset  size  field
0       4     magic "LDX1"
4       2     formatVersion = 1
6       2     dtype = 1 (f32)
8       4     dim, 1..4096
12      4     segCount, 0..4096
16      4     totalRows, 0..4194304 (rows on disk, including replaced and deleted ones)
20      4     liveRows (= totalRows - popcount(tombstones))
24      4     nextSegId (> every segId in the table)
28      4     generation, 1..0xFFFFFFFE (+1 per commit; 0xFFFFFFFF is never written)
32      28    zero
60      4     headerCrc = crc32c(bytes 0..59)
64      32*segCount   segment entries
..      ceil(totalRows / 8)   tombstone bitset, bit r (LSB first) of byte r/8 = 1 when row r is dead; padding bits zero
end-4   4     bodyCrc = crc32c(bytes 64 .. end-4)
```

Exact length: `64 + 32 * segCount + ceil(totalRows / 8) + 4`. A record longer than
`64 + 32 * 4096 + 524288 + 4` is refused (`too_large`) before it is parsed or copied anywhere.

Segment entry (32 bytes): `segId` (strictly increasing, below `nextSegId`), `rows` (1..131072),
`firstRow` (the running total of the rows before it), `keyBytesLen`, `valueBytesLen`, `vecCrc` (crc32c of
the segment's vector parts in order), `metaCrc` (crc32c of the META blob), `flags` (0).

Invariants checked by `ldv_parse_head`, in this order (the first failure is the reason reported):
size cap, minimum length, magic, header CRC, version, dtype, dim, counts (`segCount`, `totalRows`,
`liveRows <= totalRows`, generation), reserved bytes, exact length, body CRC, then per segment (flags,
rows range, id order, `firstRow`, `keyBytesLen <= rows * 4096`, `valueBytesLen <= rows * 1 MiB`), the sum of
rows equals `totalRows`, tombstone padding bits are zero, and `liveRows` equals `totalRows` minus the
popcount. All arithmetic is checked `u64` (`usize` is 32 bits on wasm32).

## 3. META blob (per segment)

`invNorms f32[rows] | keyOffsets u32[rows+1] | valueOffsets u32[rows+1] | valueCrcs u32[rows] | keyBytes`,
length exactly `rows * 4 + (rows + 1) * 8 + rows * 4 + keyBytesLen`. Every section starts on a 4-byte
boundary.

- `invNorms[i]` is `1 / sqrt(selfDot(row i))` in f32, 0 for a zero row (Storage API 0.2.0, Scoring).
- `keyOffsets` starts at 0, never decreases and ends at `keyBytesLen`; each key is 1..4096 bytes of valid UTF-8.
- `valueOffsets` starts at 0, never decreases and ends at `valueBytesLen`; each value is at most 1 MiB; equal
  consecutive offsets mean the row has no value.
- `valueCrcs[i]` is the crc32c of row i's value bytes (0 when there is none).

`ldv_check_meta` checks exactly these, with reasons `length`, `offsets`, `key_length`, `utf8`.

## 4. Error reasons

`StorageError` code `corrupt` carries `details { ns, file, reason }`; `file` is a record name (never a
key). For a segment checksum failure (`crc`) it is `vec-<segId>` or `meta-<segId>`, because the CRC covers every part of the segment; for the HEAD checksum it is `head`; value failures name the `val-<segId>/<part>` record. Reasons from the kernel: `magic`, `version`, `dtype`, `dim`, `length`, `crc`, `reserved`, `count`,
`segment_order`, `tombstone_padding`, `offsets`, `utf8`, `key_length`, `too_large`. From the TypeScript
layer: `missing_part`, `length` (a part with the wrong size), `crc` (a segment's vector or META checksum),
`duplicate_key` (two live rows with one key), `bad_vector` (a vector part whose checksum is right but
which holds a non-finite or oversize row), `value_crc`, `value_decode`, `wasm_trap`.

## 5. The writer

1. Take the Web Lock `airplanemode-localdata:vec:<ns>` (a no-op without `navigator.locks`) and hold it from
   before the HEAD re-read to after the HEAD put; drop the driver's cached `keys.json` for the index
   namespace (OPFS `refreshIndex`).
2. Re-read HEAD; reload the resident index if its bytes changed; refuse at generation `0xFFFFFFFF`.
3. Delete leftover records whose `segId >= nextSegId` (a write that never committed).
4. Stream rows: validate each (key rules, dim, duplicate keys within the call); copy vectors into one
   WebAssembly block of at most 8 MiB; when it is full run `ldv_check_rows`, `ldv_inv_norms`, update the
   segment's running vector CRC, check the soft quota and `maxIndexBytes`, `put` the part.
5. Encode values with LD1 and cut the value stream into 1 MiB parts; cut a new segment at 131,072 rows (or
   before the value stream would pass 2^31 - 1 bytes).
6. Write each segment's META parts, then the new HEAD last, after `ldv_parse_head` has accepted it.
7. On any error delete this call's parts (best effort); the previous HEAD was never touched.

Peak memory while writing is the caller's rows, plus the resident index, plus one part. A 100,000-row
index is never held twice.

## 6. The reader (cold open)

1. `get` HEAD; absent means no index; an oversized HEAD is `too_large`; `ldv_parse_head`.
2. Check `sum(rows * dim * 4) + sum(metaLen)` against `maxIndexBytes` BEFORE any block is allocated.
3. For each segment read the META parts (each part's actual length must equal the length the HEAD implies
   before WebAssembly memory grows), verify the META CRC and run `ldv_check_meta`, decode the keys, and
   build the live-key map (a duplicate live key is `duplicate_key`).
4. For each segment read the vector parts into WebAssembly memory (one block per part, the next part
   prefetched while the current one is checksummed), verify the vector CRC, then `ldv_check_rows` on every
   block.
5. Values are read lazily, per hit, through a 16-part LRU, and checked against `valueCrcs`.

A corrupt result is sticky for that HEAD: every vector call on the namespace keeps rejecting until
`clear(ns)` or a new HEAD is seen. A trap in the kernel discards the WebAssembly instance and everything
that pointed into it; the next call starts fresh.

## 7. Limits

| Limit                                                                            | Value                                                 | Reason when exceeded                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| dim                                                                              | 4096                                                  | `invalid_value`                                                          |
| rows per namespace (including replaced and deleted rows; no compaction)          | 4,194,304                                             | `quota_exceeded` `max_rows`                                              |
| segments per namespace (each `putVectors` call adds at least one; no compaction) | 4,096                                                 | `quota_exceeded` `max_segments`                                          |
| vector, META and key bytes per index                                             | `maxIndexBytes`, default 1,073,741,824                | `quota_exceeded` `max_index_bytes` (write), `corrupt` `too_large` (read) |
| key                                                                              | 4,096 UTF-8 bytes (and the 1,024 UTF-16 unit KV rule) | `invalid_key`                                                            |
| value                                                                            | 1 MiB encoded                                         | `invalid_value` `value_size`                                             |
| generation                                                                       | 0xFFFFFFFE                                            | `invalid_value` `generation`                                             |
