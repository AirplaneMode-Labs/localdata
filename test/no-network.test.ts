// D4-03: localdata makes no network request, ever. A static check over src/ (the browser test
// asserts the same at runtime for every request the page makes).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('no network', () => {
  const src = join(import.meta.dirname, '..', 'src');
  function walk(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (n.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('src contains no fetch(, XMLHttpRequest, WebSocket, sendBeacon or EventSource', () => {
    const files = walk(src);
    expect(files.length).toBeGreaterThan(10);
    const needles = [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'sendBeacon',
      'EventSource',
      'importScripts',
    ];
    const hits: string[] = [];
    for (const f of files) {
      // the generated module is base64 and cannot contain these as identifiers, but skip it for speed
      if (f.endsWith('.gen.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const n of needles) if (text.includes(n)) hits.push(`${f}: ${n}`);
    }
    expect(hits).toEqual([]);
  });
});
