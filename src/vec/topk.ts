// Bounded top-k selection with the contract's total order: score descending, then key ascending by
// UTF-8 bytes. The heap root is the WORST kept candidate, so a better candidate replaces it.

/**
 * Compares two well-formed strings by their UTF-8 bytes, which equals code point order. UTF-16
 * code-unit order differs from it only for astral characters against U+E000..U+FFFF, so surrogates
 * (0xD800..0xDFFF) are mapped above 0xFFFF's BMP neighbours before comparing.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800) x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
    if (y >= 0xd800) y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

export class TopK {
  private readonly rows: Int32Array;
  private readonly scores: Float32Array;
  private n = 0;

  /**
   * @param capacity at most this many candidates are kept (the caller passes min(k, candidates)).
   * @param keyOf the key of a row, consulted only to break exact score ties.
   */
  constructor(
    readonly capacity: number,
    private readonly keyOf: (row: number) => string,
  ) {
    this.rows = new Int32Array(capacity);
    this.scores = new Float32Array(capacity);
  }

  /** True when candidate a (score sa, row ra) ranks strictly after candidate b. */
  private worse(sa: number, ra: number, sb: number, rb: number): boolean {
    if (sa !== sb) return sa < sb;
    return compareUtf8(this.keyOf(ra), this.keyOf(rb)) > 0;
  }

  get size(): number {
    return this.n;
  }

  /** Offers one candidate. */
  push(score: number, row: number): void {
    if (this.capacity === 0) return;
    if (this.n < this.capacity) {
      let i = this.n++;
      this.rows[i] = row;
      this.scores[i] = score;
      // sift up: the parent must be worse-or-equal, i.e. the root is the worst
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.worse(this.scores[i]!, this.rows[i]!, this.scores[p]!, this.rows[p]!)) {
          this.swap(i, p);
          i = p;
        } else break;
      }
      return;
    }
    // Full: replace the root only when the candidate ranks strictly before it.
    const rs = this.scores[0]!;
    if (score < rs) return;
    if (score === rs && compareUtf8(this.keyOf(row), this.keyOf(this.rows[0]!)) >= 0) return;
    this.rows[0] = row;
    this.scores[0] = score;
    this.siftDown(0);
  }

  private swap(i: number, j: number): void {
    const r = this.rows[i]!;
    const s = this.scores[i]!;
    this.rows[i] = this.rows[j]!;
    this.scores[i] = this.scores[j]!;
    this.rows[j] = r;
    this.scores[j] = s;
  }

  private siftDown(start: number): void {
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let w = i;
      if (l < this.n && this.worse(this.scores[l]!, this.rows[l]!, this.scores[w]!, this.rows[w]!))
        w = l;
      if (r < this.n && this.worse(this.scores[r]!, this.rows[r]!, this.scores[w]!, this.rows[w]!))
        w = r;
      if (w === i) return;
      this.swap(i, w);
      i = w;
    }
  }

  /** The kept candidates, best first. */
  result(): Array<{ row: number; score: number }> {
    const out: Array<{ row: number; score: number }> = [];
    for (let i = 0; i < this.n; i++) out.push({ row: this.rows[i]!, score: this.scores[i]! });
    out.sort((a, b) =>
      a.score !== b.score
        ? a.score > b.score
          ? -1
          : 1
        : compareUtf8(this.keyOf(a.row), this.keyOf(b.row)),
    );
    return out;
  }
}
