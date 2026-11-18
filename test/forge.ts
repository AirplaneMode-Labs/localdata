// Test-only helpers for forging a vector index on a driver: a bitwise CRC-32C (independent of the
// kernel), HEAD field editing that recomputes both checksums so a structural lie survives the CRC
// gate, and META editing that recomputes the segment's metaCrc and then the HEAD.
import type { StorageDriver, VectorRow } from '../src/contracts/storage-api';
import { DOC_NS_PREFIX } from '../src/drivers/types';
import { StorageEvents } from '../src/events';
import { VectorStore } from '../src/vec';
import { DEFAULT_MAX_INDEX_BYTES } from '../src/vec/files';

export function crc32c(bytes: Uint8Array, prev = 0): number {
  let crc = ~prev >>> 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return ~crc >>> 0;
}

export const vnsOf = (ns: string): string => `__ld_vec.${ns}`;

export async function readRecord(d: StorageDriver, ns: string, name: string): Promise<Uint8Array> {
  const rec = await d.getBytes(vnsOf(ns), name);
  if (!rec) throw new Error(`forge: no record ${name}`);
  return rec.bytes.slice();
}

export async function writeRecord(
  d: StorageDriver,
  ns: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await d.put(vnsOf(ns), name, bytes, { size: bytes.byteLength });
}

/** Recomputes the header CRC (0..59 at 60) and the body CRC (64..end-4 at end-4) in place. */
export function refreshHeadCrcs(head: Uint8Array): void {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.byteLength >= 68) {
    dv.setUint32(60, crc32c(head.subarray(0, 60)), true);
    dv.setUint32(head.byteLength - 4, crc32c(head.subarray(64, head.byteLength - 4)), true);
  }
}

export const HEAD_FIELD = {
  dim: 8,
  segCount: 12,
  totalRows: 16,
  liveRows: 20,
  nextSegId: 24,
  generation: 28,
} as const;

/** Segment entry field offsets, from the start of the entry (entry i starts at 64 + 32 * i). */
export const SEG_FIELD = {
  segId: 0,
  rows: 4,
  firstRow: 8,
  keyBytesLen: 12,
  valueBytesLen: 16,
  vecCrc: 20,
  metaCrc: 24,
  flags: 28,
} as const;

/** Edits the HEAD record in place with `edit`, recomputes both CRCs and writes it back. */
export async function editHead(
  d: StorageDriver,
  ns: string,
  edit: (head: Uint8Array, dv: DataView) => Uint8Array | void,
): Promise<void> {
  let head = await readRecord(d, ns, 'head');
  const out = edit(head, new DataView(head.buffer, head.byteOffset, head.byteLength));
  if (out instanceof Uint8Array) head = out;
  refreshHeadCrcs(head);
  await writeRecord(d, ns, 'head', head);
}

/**
 * Edits the single META part of segment `segId` with `edit`, then fixes the segment's metaCrc in the
 * HEAD (entry index `entry`) and the HEAD checksums, so only the structural validators can object.
 */
export async function editMeta(
  d: StorageDriver,
  ns: string,
  segId: number,
  entry: number,
  edit: (meta: Uint8Array, dv: DataView) => void,
): Promise<void> {
  const name = `meta-${segId}/00000`;
  const meta = await readRecord(d, ns, name);
  edit(meta, new DataView(meta.buffer, meta.byteOffset, meta.byteLength));
  await writeRecord(d, ns, name, meta);
  await editHead(d, ns, (_h, dv) => {
    dv.setUint32(64 + 32 * entry + SEG_FIELD.metaCrc, crc32c(meta), true);
  });
}

/** Edits the single vec part of segment `segId`, then fixes the segment's vecCrc in the HEAD. */
export async function editVec(
  d: StorageDriver,
  ns: string,
  segId: number,
  entry: number,
  edit: (vec: Uint8Array, dv: DataView) => void,
): Promise<void> {
  const name = `vec-${segId}/00000`;
  const vec = await readRecord(d, ns, name);
  edit(vec, new DataView(vec.buffer, vec.byteOffset, vec.byteLength));
  await writeRecord(d, ns, name, vec);
  await editHead(d, ns, (_h, dv) => {
    dv.setUint32(64 + 32 * entry + SEG_FIELD.vecCrc, crc32c(vec), true);
  });
}

/**
 * Writes `rows` straight into the document index of `ns` ('__ld_doc.' + ns) through the SDK's own writer,
 * bypassing the documents API: the way to put stored bytes there that the API would never write (a
 * forged record, a '__proto__' member, wrong types). The driver is opened here and left open.
 */
export async function forgeDocRows(
  driver: StorageDriver,
  ns: string,
  rows: VectorRow[],
): Promise<void> {
  const store = new VectorStore({
    driver,
    events: new StorageEvents(undefined, driver.name, undefined),
    kernel: 'auto',
    maxIndexBytes: DEFAULT_MAX_INDEX_BYTES,
    checkSoft: () => undefined,
    prefix: DOC_NS_PREFIX,
  });
  try {
    await driver.open();
    await store.putVectors(ns, rows);
  } finally {
    store.close();
  }
}
